"""
Power BI Relational Synchronization Bridge (Python 3.12+ Modernized Architecture)
Hospital Occupancy Manager - High-Performance Ingestion & Dual Parity Engine

Features:
- Single-pass high-throughput DataFrame parsing and typed domain extraction.
- Strongly-typed Dataclass models with slots=True for minimal memory overhead.
- Pre-compiled regex normalizers for bilingual Arabic/English patient names & specialties.
- Dual-target synchronization:
    1. Supabase PostgreSQL Relational Schema via PostgREST RPC (sync_powerbi_admissions).
    2. Supabase RTDB Nodes Key-Value cache (state/* and history/*).
- Resilient network handling with exponential backoff, bounded retries, and connection pooling.
- Africa/Cairo timezone-aware calendar rollover and daily history snapshots.
"""

from __future__ import annotations

import os
import io
import re
import sys
import time
import uuid
import json
import signal
import logging
import datetime
import zoneinfo
from dataclasses import dataclass, field
from typing import Any, Final, Optional
from urllib.parse import urlparse, parse_qs

import urllib3
import requests
from requests.adapters import HTTPAdapter
from requests_ntlm import HttpNtlmAuth
from urllib3.util.retry import Retry
import pandas as pd
import schedule

# --- TIMEZONE CONFIGURATION ---
CAIRO_TZ: Final = zoneinfo.ZoneInfo("Africa/Cairo")


def get_cairo_now() -> datetime.datetime:
    """Returns the current datetime in Africa/Cairo timezone."""
    return datetime.datetime.now(CAIRO_TZ)


# --- LOGGING SETUP ---
logger = logging.getLogger("sync_bridge")
logger.setLevel(logging.INFO)

if not logger.handlers:
    _log_handler = logging.StreamHandler(sys.stdout)
    _log_formatter = logging.Formatter(
        "[%(asctime)s] [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S"
    )
    _log_handler.setFormatter(_log_formatter)
    logger.addHandler(_log_handler)


def log(msg: str, level: str = "info") -> None:
    """Convenience logger maintaining existing signature."""
    if level == "error":
        logger.error(msg)
    elif level == "warning":
        logger.warning(msg)
    else:
        logger.info(msg)


def failure_countdown(seconds: int, task_name: str) -> None:
    """Displays a clean countdown timer in interactive terminals, logs cleanly in non-interactive mode."""
    if sys.stdout.isatty():
        for i in range(seconds, 0, -1):
            ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            sys.stdout.write(f"\r[{ts}] [WARN] {task_name} failed. Retrying in {i}s... ")
            sys.stdout.flush()
            time.sleep(1)
        sys.stdout.write("\r" + " " * 90 + "\r")
        sys.stdout.flush()
    else:
        log(f"{task_name} failed. Waiting {seconds}s before retry...", level="warning")
        time.sleep(seconds)


# --- CONFIGURATION & CREDENTIALS ---
_env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
if os.path.exists(_env_path):
    with open(_env_path, "r", encoding="utf-8") as _ef:
        for _line in _ef:
            _line = _line.strip()
            if _line and not _line.startswith("#") and "=" in _line:
                _k, _v = _line.split("=", 1)
                os.environ.setdefault(_k.strip(), _v.strip().strip("'\""))

SUPABASE_URL: Final[str] = os.getenv("SUPABASE_URL", "https://uuvomcxbgldgtmuqtymk.supabase.co").rstrip("/")
SUPABASE_KEY: Final[str] = os.getenv("SUPABASE_KEY") or os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")

FORTINET_URL: Final[str] = os.getenv("FORTINET_URL", "http://10.0.17.4:1000")
FORTINET_USER: Final[str] = os.getenv("FORTINET_USER", "")
FORTINET_PASS: Final[str] = os.getenv("FORTINET_PASS", "")

POWERBI_EXPORT_URL: Final[str] = os.getenv(
    "POWERBI_EXPORT_URL",
    "http://10.12.0.11/powerbi/api/explore/reports/9a59efe5-2722-460f-a720-a720d8d1c298/export/xlsx"
)
POWERBI_USER: Final[str] = os.getenv("POWERBI_USER", "")
POWERBI_PASS: Final[str] = os.getenv("POWERBI_PASS", "")

# SSL Verification configuration (defaults to True; set SUPABASE_SSL_VERIFY=0 only if internal proxy intercepts SSL)
SUPABASE_SSL_VERIFY: Final[bool] = os.getenv("SUPABASE_SSL_VERIFY", "1").lower() not in ("0", "false", "no")

if not SUPABASE_SSL_VERIFY:
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

SUPABASE_REST_URL: Final[str] = f"{SUPABASE_URL}/rest/v1/rtdb_nodes"
SUPABASE_RPC_URL: Final[str] = f"{SUPABASE_URL}/rest/v1/rpc/sync_powerbi_admissions"

SUPABASE_HEADERS: Final[dict[str, str]] = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "resolution=merge-duplicates,return=minimal"
}

_sb_session: Optional[requests.Session] = None


def get_supabase_session() -> requests.Session:
    """Returns a pooled, resilient HTTP session targeting Supabase."""
    global _sb_session
    if _sb_session is None:
        _sb_session = requests.Session()
        retries = Retry(total=3, backoff_factor=0.5, status_forcelist=[500, 502, 503, 504], raise_on_status=False)
        adapter = HTTPAdapter(pool_connections=10, pool_maxsize=20, max_retries=retries)
        _sb_session.mount("https://", adapter)
        _sb_session.mount("http://", adapter)
        _sb_session.headers.update(SUPABASE_HEADERS)
    return _sb_session


# --- PRECOMPILED REGEX PATTERNS & NORMALIZATION ---
RE_ARABIC_TITLES: Final = re.compile(
    r"^(د/|د\.|دكتور/|دكتور|استاذ/|أستاذ/|السيد/|السيد|السيدة/|السيدة|م/|مهندس/|"
    r"baby\s+of|baby|طفل|طفلة|ابن|ابنة|مولود|مولودة|twin\s*\d*)\s+",
    re.IGNORECASE
)
RE_DIACRITICS: Final = re.compile(r"[\u064B-\u065F\u0670]")
RE_ALEF_VARIATIONS: Final = re.compile(r"[أإآٱ]")
RE_COMPOUND_ABD: Final = re.compile(r"\bعبد\s+")
RE_COMPOUND_ABU: Final = re.compile(r"\bابو\s+")
RE_COMPOUND_OM: Final = re.compile(r"\bام\s+")
RE_ALIF_LAM_PREFIX: Final = re.compile(r"\bال([^\s]{3,})")
RE_NON_ALPHANUM: Final = re.compile(r"[^a-z0-9\u0600-\u06FF\s]")
RE_WHITESPACE: Final = re.compile(r"\s+")
RE_NON_DIGITS: Final = re.compile(r"[^\d]")
RE_INPATIENT_ROOM: Final = re.compile(r"^(room\s*)?(10[1-8]|3[0-3][0-9]|4[0-2][0-9])(\s*[-/]?\s*[ab])?$", re.IGNORECASE)
RE_HD_CHAIR: Final = re.compile(r"\b(hd|hemo|dial)\s*[-#_]?\s*\d*\b", re.IGNORECASE)
RE_DATE_SEP: Final = re.compile(r"^(\d{1,4})[-/](\d{1,2})[-/](\d{1,4})$")
RE_DC_KW: Final = re.compile(r"\b(dc|d\.c\.|d\.c)\b")

ARABIC_DIGITS_TRANS: Final = str.maketrans("٠١٢٣٤٥٦٧٨٩", "0123456789")

SPECIALTY_CANONICAL_MAP: Final[dict[str, str]] = {
    "internal medicine": "Internal Medicine",
    "internal medicine clinic": "Internal Medicine",
    "internal medicine (im)": "Internal Medicine",
    "internal": "Internal Medicine",
    "im": "Internal Medicine",
    "pulmonology": "Internal Medicine",
    "hematology": "Internal Medicine",
    "haematology": "Internal Medicine",
    "endocrinology": "Internal Medicine",
    "rheumatology": "Internal Medicine",
    "باطنة": "Internal Medicine",
    "الباطنة": "Internal Medicine",
    "general surgery": "General Surgery",
    "general surgery (gs)": "General Surgery",
    "git surgery": "General Surgery",
    "bariatric surgery": "General Surgery",
    "pediatric surgery": "General Surgery",
    "surgical": "General Surgery",
    "gs": "General Surgery",
    "cardiology": "Cardiology",
    "pediatric cardiology": "Pediatric Cardiology",
    "pediatrics": "Pediatrics",
    "pediatric": "Pediatrics",
    "vascular surgery": "Vascular Surgery",
    "vascular": "Vascular Surgery",
    "cardiothoracic surgery": "Cardiothoracic Surgery",
    "cardiothoracic": "Cardiothoracic Surgery",
    "urology": "Urology",
    "orthopedic surgery": "Orthopedic Surgery",
    "orthopedics": "Orthopedic Surgery",
    "orthopaedics": "Orthopedic Surgery",
    "ortho": "Orthopedic Surgery",
    "neurosurgery": "Neurosurgery",
    "oncology": "Oncology",
    "neurology": "Neurology",
    "ent": "ENT",
    "obstetrics and gynecology": "Obstetrics and gynecology",
    "ob/gyn": "Obstetrics and gynecology",
    "icu": "ICU",
    "icu.": "ICU",
    "critical care": "ICU",
    "anesthesia and pain therapy": "Anesthesia and pain therapy",
    "physiotherapy": "Physiotherapy",
    "physiotherpy": "Physiotherapy",
    "interventional radiology": "Interventional Radiology",
    "intervential radiology": "Interventional Radiology",
    "dental": "Dental",
    "maxillofacial": "Maxillofacial"
}


# --- DATE & TIME HELPERS ---

def is_today_cairo(iso_str: Any, today_cairo_str: str) -> bool:
    """Checks whether an ISO timestamp string belongs to today in Cairo time."""
    if not iso_str:
        return False
    try:
        clean = str(iso_str).replace("Z", "+00:00")
        dt = datetime.datetime.fromisoformat(clean)
        dt_cairo = dt.astimezone(CAIRO_TZ)
        return dt_cairo.strftime("%Y-%m-%d") == today_cairo_str
    except (ValueError, TypeError):
        return False


def is_date_today_cairo(d_val: Any, today_cairo_str: Optional[str] = None) -> bool:
    """Validates whether an arbitrary date representation belongs to today in Cairo."""
    if not d_val:
        return False
    if not today_cairo_str:
        today_cairo_str = get_cairo_now().strftime("%Y-%m-%d")

    try:
        parts = today_cairo_str.split("-")
        c_yr, c_mo, c_dy = int(parts[0]), int(parts[1]), int(parts[2])
    except (ValueError, IndexError):
        return False

    s = str(d_val).strip()
    if not s or s.lower() in ("nan", "none", "null", "nat", "undefined"):
        return False

    # ISO Format with timezone
    if "t" in s.lower() or "z" in s.lower() or "+" in s:
        try:
            clean = s.replace("Z", "+00:00")
            dt = datetime.datetime.fromisoformat(clean)
            dt_cairo = dt.astimezone(CAIRO_TZ)
            return dt_cairo.strftime("%Y-%m-%d") == today_cairo_str
        except (ValueError, TypeError):
            pass

    date_part = re.split(r"[\sT]", s)[0]
    m = RE_DATE_SEP.match(date_part)
    if m:
        p1, p2, p3 = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if p1 > 1000:
            return (p1 == c_yr and p2 == c_mo and p3 == c_dy)
        yr = p3 if p3 > 1000 else (2000 + p3 if p3 < 100 else p3)
        if yr != c_yr:
            return False
        return (p1 == c_dy and p2 == c_mo) or (p1 == c_mo and p2 == c_dy)

    for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%m/%d/%Y", "%Y/%m/%d", "%d-%m-%y", "%d/%m/%y"):
        try:
            parsed = datetime.datetime.strptime(date_part, fmt)
            if parsed.year == c_yr and parsed.month == c_mo and parsed.day == c_dy:
                return True
        except ValueError:
            continue

    return False


# --- TEXT & IDENTIFIER NORMALIZATION ---

def normalize_arabic_name(name: Any) -> str:
    """Normalizes Arabic characters, honorifics, and whitespace."""
    if not name:
        return ""
    n = str(name).strip().lower()
    n = RE_ARABIC_TITLES.sub("", n)
    n = RE_DIACRITICS.sub("", n)
    n = RE_ALEF_VARIATIONS.sub("ا", n)
    n = n.replace("ة", "ه").replace("ى", "ي")
    n = RE_COMPOUND_ABD.sub("عبد", n)
    n = RE_COMPOUND_ABU.sub("ابو", n)
    n = RE_COMPOUND_OM.sub("ام", n)
    n = RE_ALIF_LAM_PREFIX.sub(r"\1", n)
    n = RE_NON_ALPHANUM.sub(" ", n)
    return RE_WHITESPACE.sub(" ", n).strip()


def is_name_match(name1: Any, name2: Any) -> bool:
    """Evaluates whether two Arabic patient names represent the same person."""
    if not name1 or not name2:
        return False
    n1 = normalize_arabic_name(name1)
    n2 = normalize_arabic_name(name2)
    if not n1 or not n2:
        return False
    if n1 == n2:
        return True

    w1 = [w for w in n1.split() if len(w) > 1]
    w2 = [w for w in n2.split() if len(w) > 1]
    if not w1 or not w2:
        return False

    s1, s2 = set(w1), set(w2)
    common = s1 & s2
    if len(common) >= 2 and (common == s1 or common == s2):
        return True
    return len(common) >= 3


def clean_mrn_str(mrn: Any) -> str:
    """Normalizes medical record numbers, stripping decimal artifacts and leading zeroes."""
    if mrn is None:
        return ""
    s = str(mrn).strip()
    if s.endswith(".0"):
        s = s[:-2]
    return s.lstrip("0")


def clean_phone(val: Any) -> str:
    """Normalizes phone numbers, converting Arabic numerals and ensuring valid length."""
    if val is None or pd.isna(val):
        return ""
    s = str(val).strip()
    if s.endswith(".0"):
        s = s[:-2]
    if s.lower() in ("none", "nan", "null", "undefined", ""):
        return ""
    s = s.translate(ARABIC_DIGITS_TRANS)
    has_plus = s.startswith("+")
    s = RE_NON_DIGITS.sub("", s)
    if not s or len(s) < 5:
        return ""
    return f"+{s}" if has_plus else s


def clean_num(val: Any) -> str:
    """Sanitizes monetary / numeric strings to 2 decimal places."""
    if val is None or pd.isna(val):
        return "0.00"
    s = str(val).strip().replace(",", "")
    try:
        f = float(s)
        return f"{f:.2f}"
    except (ValueError, TypeError):
        return "0.00"


def clean_date(val: Any) -> Optional[str]:
    """Sanitizes date expressions into DD-MM-YYYY HH:MM strings."""
    if val is None or pd.isna(val):
        return None
    if isinstance(val, (datetime.date, datetime.datetime, pd.Timestamp)):
        return val.strftime("%d-%m-%Y %H:%M")
    s = str(val).strip()
    if not s or s.lower() in ("none", "nan", "null", "nat", "no filters applied", "admissiondate", "admission date"):
        return None
    try:
        dt = pd.to_datetime(s, dayfirst=True)
        if pd.notna(dt):
            return dt.strftime("%d-%m-%Y %H:%M")
    except Exception:
        pass
    return s


def normalize_specialty(raw: Any) -> str:
    """Maps specialty strings to hospital standard canonical naming."""
    if not raw:
        return "Other / غير محدد"
    clean = str(raw).strip()
    if not clean or clean in ("0", "-", "nan", "None", "null", "undefined"):
        return "Other / غير محدد"
    stripped = clean.rstrip(".").strip()
    lower = stripped.lower()
    if lower in ("speciality", "specialty", "external laboratory", "physician", "doctor", "other"):
        return "Other / غير محدد"
    return SPECIALTY_CANONICAL_MAP.get(lower, stripped)


def is_patient_manually_discharged(
    name: str,
    mrn: str,
    manual_names: list[str],
    manual_mrns: set[str]
) -> bool:
    """Checks if a patient was manually discharged by hospital staff today."""
    c_mrn = clean_mrn_str(mrn)
    if c_mrn and c_mrn in manual_mrns:
        return True
    if name and manual_names:
        for m_name in manual_names:
            if is_name_match(name, m_name):
                return True
    return False


# --- DOMAIN MODELS (Python 3.12+ Slots) ---

@dataclass(slots=True)
class NormalizedPatientRecord:
    mrn: str
    clean_mrn: str
    name: str
    bed: str
    floor: str
    physician: str
    admission_date: Optional[str]
    contractor: str
    financial_status: str
    total_invoice: float
    remaining_debt: float
    specialty: str
    diagnosis: str
    mobile: str
    los: str
    alos: str
    expected_discharge: str
    medications: str
    initial_assessment: str
    vte_summary: str
    notes: str
    payment_by: str
    raw_row: dict[str, Any] = field(repr=False)


# --- FORTINET AUTHENTICATION ---

def fortinet_reconnect(max_retries: int = 5) -> bool:
    """Authenticates with the Fortinet gateway with exponential backoff and bounded retries."""
    if not FORTINET_USER or not FORTINET_PASS:
        log("No Fortinet credentials provided in environment; skipping firewall auth.")
        return True

    login_url = f"{FORTINET_URL}/login"
    logout_url = f"{FORTINET_URL}/logout"
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}

    for attempt in range(1, max_retries + 1):
        with requests.Session() as session:
            session.headers.update(headers)
            log(f"Fortinet session authentication attempt {attempt}/{max_retries}...")
            try:
                try:
                    session.get(logout_url, timeout=6)
                except Exception:
                    pass
                time.sleep(2)

                credentials = {"username": FORTINET_USER, "password": FORTINET_PASS}
                login_page = session.get(login_url, timeout=8)
                parsed_url = urlparse(login_page.url)
                magic_token = parse_qs(parsed_url.query).get("magic", [None])[0]
                if magic_token:
                    credentials["magic"] = magic_token

                response = session.post(login_page.url, data=credentials, timeout=12)
                if response.status_code in (200, 302, 303):
                    log("Successfully authenticated with Fortinet Firewall.")
                    return True
            except requests.exceptions.ConnectionError:
                log("Fortinet endpoint directly reachable or not intercepting; proceeding.")
                return True
            except Exception as e:
                log(f"Fortinet auth attempt {attempt} encountered error: {e}", level="warning")

        backoff = min(2 ** attempt, 15)
        failure_countdown(backoff, "Fortinet Authentication")

    log("Exceeded maximum Fortinet authentication attempts; proceeding with sync attempt.", level="warning")
    return False


# --- SUPABASE STATE FETCHING ---

def fetch_existing_supabase_state(cairo_date_str: Optional[str] = None) -> dict[str, Any]:
    """Fetches and partitions existing state nodes from Supabase."""
    if not cairo_date_str:
        cairo_date_str = get_cairo_now().strftime("%Y-%m-%d")

    get_url = (
        f"{SUPABASE_REST_URL}?path=in.("
        f"state/metadata,state/discharged,state/dialysis,state/transfers,state/occupancy,state/entries,history/occupancy_index"
        f")&select=path,data,updated_at"
    )
    state_map: dict[str, Any] = {}
    time_map: dict[str, Any] = {}

    try:
        session = get_supabase_session()
        res = session.get(get_url, timeout=15, verify=SUPABASE_SSL_VERIFY)
        if res.status_code == 200:
            for record in res.json():
                p = record.get("path")
                if p:
                    state_map[p] = record.get("data")
                    time_map[p] = record.get("updated_at")
    except Exception as e:
        log(f"Notice: Failed to fetch existing state from Supabase: {e}", level="warning")

    meta = state_map.get("state/metadata") or {}
    last_active = str(meta.get("lastActiveDate") or "").strip()
    is_new_day = bool(last_active and last_active < cairo_date_str)

    occ = state_map.get("state/occupancy") or {}
    occ_current = occ.get("current") or []
    is_system_reset = len(occ_current) <= 1

    raw_manual_names = meta.get("manuallyDischargedNames") or []
    if not isinstance(raw_manual_names, list):
        raw_manual_names = []

    disc_node = state_map.get("state/discharged") or {}
    raw_disc_patients = (
        disc_node.get("patients")
        if isinstance(disc_node, dict)
        else (disc_node if isinstance(disc_node, list) else [])
    )

    clean_disc_patients: list[dict[str, Any]] = []
    if not is_new_day and not is_system_reset and isinstance(raw_disc_patients, list):
        for dp in raw_disc_patients:
            if isinstance(dp, dict):
                d_date = dp.get("dischargeDate") or dp.get("date") or dp.get("updatedAt")
                if d_date:
                    if is_date_today_cairo(d_date, cairo_date_str):
                        clean_disc_patients.append(dp)
                else:
                    disc_updated = time_map.get("state/discharged")
                    if is_today_cairo(disc_updated, cairo_date_str):
                        clean_disc_patients.append(dp)

    manual_names_set: set[str] = set()
    manual_mrns_set: set[str] = set()
    if not is_new_day and not is_system_reset:
        for dp in clean_disc_patients:
            if isinstance(dp, dict):
                p_name = dp.get("name") or dp.get("colD")
                p_mrn = clean_mrn_str(dp.get("mrn") or dp.get("colC") or dp.get("PatientBarcode") or "")
                is_manual = (dp.get("dischargeType") == "manual") or (
                    p_name and any(is_name_match(p_name, mn) for mn in raw_manual_names)
                )
                if is_manual:
                    if p_name:
                        manual_names_set.add(str(p_name).strip())
                    if p_mrn:
                        manual_mrns_set.add(p_mrn)

    dial = state_map.get("state/dialysis") or {}
    raw_dial = dial.get("items", []) if isinstance(dial, dict) else (dial if isinstance(dial, list) else [])
    dial_updated = time_map.get("state/dialysis")
    existing_dial: list[dict[str, Any]] = []
    if raw_dial and not is_new_day and not is_system_reset:
        for p in raw_dial:
            if isinstance(p, dict):
                p_date = p.get("date") or p.get("admissionDate")
                if p_date:
                    if is_date_today_cairo(p_date, cairo_date_str):
                        existing_dial.append(p)
                else:
                    if is_today_cairo(dial_updated, cairo_date_str):
                        existing_dial.append(p)

    trans = state_map.get("state/transfers") or {}
    raw_trans = trans.get("items", []) if isinstance(trans, dict) else (trans if isinstance(trans, list) else [])
    trans_updated = time_map.get("state/transfers")
    existing_trans = (
        raw_trans
        if (raw_trans and is_today_cairo(trans_updated, cairo_date_str) and not is_new_day and not is_system_reset)
        else []
    )

    ent_node = state_map.get("state/entries") or {}
    raw_ent = ent_node.get("items", []) if isinstance(ent_node, dict) else (ent_node if isinstance(ent_node, list) else [])
    existing_entries: list[dict[str, Any]] = []
    if raw_ent and not is_new_day and not is_system_reset:
        for p in raw_ent:
            if isinstance(p, dict):
                e_date = p.get("date") or p.get("rawDate") or p.get("admissionDate")
                if is_date_today_cairo(e_date, cairo_date_str):
                    existing_entries.append(p)

    dataset = state_map.get("state/dataset") or {}

    return {
        "previous": occ.get("previous") or dataset.get("current"),
        "occupancy_current": occ_current,
        "discharged": clean_disc_patients,
        "entries": existing_entries,
        "transfers": existing_trans,
        "orList": (state_map.get("state/or_list") or {}).get("items", []),
        "dialysis": existing_dial,
        "manually_discharged_names": list(manual_names_set),
        "manually_discharged_mrns": list(manual_mrns_set),
        "occupancy_index": state_map.get("history/occupancy_index") or [],
        "existing_metadata": meta,
        "is_new_day": is_new_day,
        "is_system_reset": is_system_reset,
    }


# --- CLASSIFICATION HELPERS ---

def is_doctor_case_or_physician_payment(
    fin_status: str,
    contractor: str,
    payment_by: str,
    notes: str = "",
    name: str = "",
    physician: str = ""
) -> bool:
    """Evaluates whether an admission should be excluded from patient debts."""
    f_low = (fin_status or "").lower().strip()
    m_low = (contractor or "").lower().strip()
    l_low = (payment_by or "").lower().strip()
    n_low = (notes or "").lower().strip()
    d_low = (name or "").lower().strip()
    phys_low = (physician or "").lower().strip()

    physician_payment_kws = ("physician", "طبيب", "فيزيشن", "doctor", "دكتور", "other ex")
    if any(kw in l_low for kw in physician_payment_kws):
        return True

    if (
        m_low in ("طبيب", "physician", "doctor", "دكتور")
        or m_low.startswith(("د/", "د.", "dr.", "dr "))
        or f_low in ("طبيب", "physician", "doctor", "دكتور")
    ):
        return True

    if l_low and l_low not in ("patient", "مريض", "cash", "نقدي", "نقدى", "self"):
        if phys_low and l_low == phys_low:
            return True
        if l_low != d_low:
            return True

    notes_phys_kws = (
        "حساب الطبيب", "حساب الدكتور", "دفع بواسطة الطبيب",
        "على حساب الطبيب", "payment by physician", "paid by doctor", "physician payment"
    )
    if any(kw in n_low for kw in notes_phys_kws):
        return True

    dc_keywords = (
        "doctor case", "doctor_case", "doctorcase", "doctor-case",
        "حالة طبيب", "حاله طبيب", "حالة دكتور", "حاله دكتور",
        "cash doctor", "كاش طبيب", "كاش دكتور", "doctor case surgery",
        "طرف دكتور", "طرف د.", "تبع دكتور", "تبع د.",
        "توصية دكتور", "توصيه دكتور", "مجاملة دكتور", "مجامله دكتور",
        "خصم دكتور", "خصم طبيب"
    )
    for kw in dc_keywords:
        if kw in l_low or kw in f_low or kw in m_low or kw in n_low or kw in d_low:
            return True

    combined = f" {l_low} {f_low} {m_low} {n_low} "
    return bool(RE_DC_KW.search(combined))


def is_dialysis_room(room_str: str) -> bool:
    """Detects whether a bed string identifies a dialysis station."""
    if not room_str:
        return False
    r = str(room_str).strip().lower()
    room_kws = (
        "dialysis", "diyalsis", "dialys", "hemodialysis", "haemodialysis",
        "hemo dialysis", "haemo dialysis", "غسيل", "استصفاء", "ديلزة"
    )
    if any(kw in r for kw in room_kws):
        return True
    return bool(RE_HD_CHAIR.search(r)) and "icu" not in r and "ccu" not in r


def is_procedure_or_temporary_room(room_str: str) -> bool:
    """Checks whether a room represents a non-inpatient procedural room."""
    if not room_str:
        return True
    r = str(room_str).strip().lower()
    if r in ("or", "o.r", "or1", "or2", "or3", "or4", "or5", "or6", "عمليات", "غرفة عمليات"):
        return True
    if r.startswith(("or-", "or ", "or -")):
        return True
    proc_keywords = ("theatre", "cath lab", "dialysis", "diyalsis", "endoscopy", "recovery", "pacu", "holding")
    return any(kw in r for kw in proc_keywords)


# --- MAIN PIPELINE: FETCH & SYNC ---

POWERBI_PAYLOAD_DICT: Final[dict[str, Any]] = {
    "exportDataType": 0,
    "executeSemanticQueryRequest": {
        "version": "1.0.0",
        "queries": [
            {
                "Query": {
                    "Commands": [
                        {
                            "SemanticQueryDataShapeCommand": {
                                "Query": {
                                    "Version": 2,
                                    "From": [{"Name": "b", "Entity": "BedOccupancyMedicalDirector_soussi", "Type": 0}],
                                    "Select": [
                                        {"Column": {"Expression": {"SourceRef": {"Source": "b"}}, "Property": "AdmissionDate"}, "Name": "BedoCCupancy_Soussi.AdmissionDate"},
                                        {"Column": {"Expression": {"SourceRef": {"Source": "b"}}, "Property": "Bed#"}, "Name": "BedoCCupancy_Soussi.BedName_EN"},
                                        {"Column": {"Expression": {"SourceRef": {"Source": "b"}}, "Property": "Patient"}, "Name": "BedoCCupancy_Soussi.EnglishFullName"},
                                        {"Column": {"Expression": {"SourceRef": {"Source": "b"}}, "Property": "Financial Status"}, "Name": "BedoCCupancy_Soussi.FinancialStatusGUID"},
                                        {"Column": {"Expression": {"SourceRef": {"Source": "b"}}, "Property": "Floor Name"}, "Name": "BedoCCupancy_Soussi.FloorName_EN"},
                                        {"Column": {"Expression": {"SourceRef": {"Source": "b"}}, "Property": "Notes"}, "Name": "BedoCCupancy_Soussi.Notes"},
                                        {"Column": {"Expression": {"SourceRef": {"Source": "b"}}, "Property": "Age"}, "Name": "Sum(BedoCCupancy_Soussi.PatientAgeDBComputed)"},
                                        {"Column": {"Expression": {"SourceRef": {"Source": "b"}}, "Property": "MRN"}, "Name": "BedoCCupancy_Soussi.PatientBarcode"},
                                        {"Measure": {"Expression": {"SourceRef": {"Source": "b"}}, "Property": "Companions #"}, "Name": "BedoCCupancy_Soussi.Count of Companions"},
                                        {"Column": {"Expression": {"SourceRef": {"Source": "b"}}, "Property": "PaymentBy"}, "Name": "BedoCCupancy_Soussi.PaymentBy"},
                                        {"Column": {"Expression": {"SourceRef": {"Source": "b"}}, "Property": "Visit"}, "Name": "BedoCCupancy_Soussi.VisitTypeGUID"},
                                        {"Column": {"Expression": {"SourceRef": {"Source": "b"}}, "Property": "ContractorName"}, "Name": "BedoCCupancy_Soussi.ContractorName"},
                                        {"Column": {"Expression": {"SourceRef": {"Source": "b"}}, "Property": "FloorStructureName_EN"}, "Name": "BedoCCupancy_Soussi.FloorStructureName_EN"},
                                        {"Column": {"Expression": {"SourceRef": {"Source": "b"}}, "Property": "DRG"}, "Name": "BedoCCupancy_Soussi.DRG"},
                                        {"Column": {"Expression": {"SourceRef": {"Source": "b"}}, "Property": "Created by DIG"}, "Name": "BedoCCupancy_Soussi.Expr1"},
                                        {"Column": {"Expression": {"SourceRef": {"Source": "b"}}, "Property": "DRG Diagnosis"}, "Name": "BedoCCupancy_Soussi.Expr3"},
                                        {"Column": {"Expression": {"SourceRef": {"Source": "b"}}, "Property": "LOS"}, "Name": "Sum(BedoCCupancy_Soussi.LOS)"},
                                        {"Column": {"Expression": {"SourceRef": {"Source": "b"}}, "Property": "GeometricMeanLOS"}, "Name": "BedoCCupancy_Soussi.GeometricMeanLOS"},
                                        {"Column": {"Expression": {"SourceRef": {"Source": "b"}}, "Property": "Speciality"}, "Name": "BedoCCupancy_Soussi.Speciality"},
                                        {"Column": {"Expression": {"SourceRef": {"Source": "b"}}, "Property": "Date Of Patients"}, "Name": "BedoCCupancy_Soussi.NewPatients"},
                                        {"Column": {"Expression": {"SourceRef": {"Source": "b"}}, "Property": "ALOS"}, "Name": "BedoCCupancy_Soussi.ALOS"},
                                        {"Column": {"Expression": {"SourceRef": {"Source": "b"}}, "Property": "ICD-10 Diagnosis"}, "Name": "BedoCCupancy_Soussi.Name"},
                                        {"Aggregation": {"Expression": {"Column": {"Expression": {"SourceRef": {"Source": "b"}}, "Property": "Payments"}}, "Function": 0}, "Name": "Sum(BedoCCupancy_Soussi.Payments)"},
                                        {"Column": {"Expression": {"SourceRef": {"Source": "b"}}, "Property": "Weight"}, "Name": "BedoCCupancy_Soussi.Weight"},
                                        {"Aggregation": {"Expression": {"Column": {"Expression": {"SourceRef": {"Source": "b"}}, "Property": "Difference"}}, "Function": 0}, "Name": "Sum(BedoCCupancy_Soussi.Difference)"},
                                        {"Aggregation": {"Expression": {"Column": {"Expression": {"SourceRef": {"Source": "b"}}, "Property": "FTotal"}}, "Function": 0}, "Name": "Sum(BedoCCupancy_Soussi.FTotal)"},
                                        {"Column": {"Expression": {"SourceRef": {"Source": "b"}}, "Property": "SSO"}, "Name": "BedoCCupancy_Soussi.1"},
                                        {"Column": {"Expression": {"SourceRef": {"Source": "b"}}, "Property": "LTC Weight"}, "Name": "BedoCCupancy_Soussi.2"},
                                        {"Column": {"Expression": {"SourceRef": {"Source": "b"}}, "Property": "LTC GLOS"}, "Name": "BedoCCupancy_Soussi.3"},
                                        {"Column": {"Expression": {"SourceRef": {"Source": "b"}}, "Property": "PrograssNotes"}, "Name": "BedoCCupancy_Soussi.PrograssNotes"},
                                        {"Column": {"Expression": {"SourceRef": {"Source": "b"}}, "Property": "OR Notes"}, "Name": "BedoCCupancy_Soussi.OR Notes"},
                                        {"Column": {"Expression": {"SourceRef": {"Source": "b"}}, "Property": "Operations"}, "Name": "BedoCCupancy_Soussi.Operations"},
                                        {"Column": {"Expression": {"SourceRef": {"Source": "b"}}, "Property": "DefaultMobile"}, "Name": "BedoCCupancy_Soussi.DefaultMobile"},
                                        {"Column": {"Expression": {"SourceRef": {"Source": "b"}}, "Property": "TreatingPhysicianName"}, "Name": "BedoCCupancy_Soussi.TreatingPhysicianName"},
                                        {"Column": {"Expression": {"SourceRef": {"Source": "b"}}, "Property": "PrograssNotes Creation Date"}, "Name": "BedoCCupancy_Soussi.PrograssNotes Creation Date"},
                                        {"Column": {"Expression": {"SourceRef": {"Source": "b"}}, "Property": "DischargeExpectedDate"}, "Name": "BedoCCupancy_Soussi.DischargeExpectedDate", "NativeReferenceName": "DischargeExpectedDate"},
                                        {"Column": {"Expression": {"SourceRef": {"Source": "b"}}, "Property": "Hand Over"}, "Name": "BedoCCupancy_Soussi.Hand Over", "NativeReferenceName": "Prograssnotes"},
                                        {"Column": {"Expression": {"SourceRef": {"Source": "b"}}, "Property": "EliteALOS"}, "Name": "BedoCCupancy_Soussi.EliteALOS", "NativeReferenceName": "EliteALOS"},
                                        {"Column": {"Expression": {"SourceRef": {"Source": "b"}}, "Property": "EliteWeight"}, "Name": "BedoCCupancy_Soussi.EliteWeight", "NativeReferenceName": "EliteWeight"},
                                        {"Column": {"Expression": {"SourceRef": {"Source": "b"}}, "Property": "Medication Names"}, "Name": "BedOccupancyMedicalDirector_soussi.Medication Names", "NativeReferenceName": "Medication Names"},
                                        {"Column": {"Expression": {"SourceRef": {"Source": "b"}}, "Property": "IntialAssessment"}, "Name": "BedOccupancyMedicalDirector_soussi.IntialAssessment", "NativeReferenceName": "IntialAssessment"},
                                        {"Column": {"Expression": {"SourceRef": {"Source": "b"}}, "Property": "VTE Summary"}, "Name": "BedOccupancyMedicalDirector_soussi.VTE Summary", "NativeReferenceName": "VTE Summary"}
                                    ],
                                    "OrderBy": [{"Direction": 2, "Expression": {"Column": {"Expression": {"SourceRef": {"Source": "b"}}, "Property": "DischargeExpectedDate"}}}]
                                },
                                "Binding": {
                                    "Primary": {"Groupings": [{"Projections": list(range(42)), "Subtotal": 0}]},
                                    "DataReduction": {"Primary": {"Top": {"Count": 1000000}}, "Secondary": {"Top": {"Count": 100}}},
                                    "Version": 1
                                }
                            }
                        },
                        {
                            "ExportDataCommand": {
                                "Columns": [
                                    {"QueryName": "BedoCCupancy_Soussi.AdmissionDate", "Name": "AdmissionDate"},
                                    {"QueryName": "BedoCCupancy_Soussi.BedName_EN", "Name": "Bed#"},
                                    {"QueryName": "BedoCCupancy_Soussi.EnglishFullName", "Name": "Patient"},
                                    {"QueryName": "BedoCCupancy_Soussi.FinancialStatusGUID", "Name": "Financial Status"},
                                    {"QueryName": "BedoCCupancy_Soussi.FloorName_EN", "Name": "Floor Name"},
                                    {"QueryName": "BedoCCupancy_Soussi.Notes", "Name": "Notes"},
                                    {"QueryName": "Sum(BedoCCupancy_Soussi.PatientAgeDBComputed)", "Name": "Age"},
                                    {"QueryName": "BedoCCupancy_Soussi.PatientBarcode", "Name": "MRN"},
                                    {"QueryName": "BedoCCupancy_Soussi.Count of Companions", "Name": "Companions #"},
                                    {"QueryName": "BedoCCupancy_Soussi.PaymentBy", "Name": "PaymentBy"},
                                    {"QueryName": "BedoCCupancy_Soussi.VisitTypeGUID", "Name": "Visit"},
                                    {"QueryName": "BedoCCupancy_Soussi.ContractorName", "Name": "ContractorName"},
                                    {"QueryName": "BedoCCupancy_Soussi.FloorStructureName_EN", "Name": "FloorStructureName_EN"},
                                    {"QueryName": "BedoCCupancy_Soussi.DRG", "Name": "DRG"},
                                    {"QueryName": "BedoCCupancy_Soussi.Expr1", "Name": "Created by DIG"},
                                    {"QueryName": "BedoCCupancy_Soussi.Expr3", "Name": "DRG Diagnosis"},
                                    {"QueryName": "Sum(BedoCCupancy_Soussi.LOS)", "Name": "LOS"},
                                    {"QueryName": "BedoCCupancy_Soussi.GeometricMeanLOS", "Name": "GLOS"},
                                    {"QueryName": "BedoCCupancy_Soussi.Speciality", "Name": "Speciality"},
                                    {"QueryName": "BedoCCupancy_Soussi.NewPatients", "Name": "Date Of Patients"},
                                    {"QueryName": "BedoCCupancy_Soussi.ALOS", "Name": "ALOS"},
                                    {"QueryName": "BedoCCupancy_Soussi.Name", "Name": "ICD-10 Diagnosis"},
                                    {"QueryName": "Sum(BedoCCupancy_Soussi.Payments)", "Name": "Sum of Payments"},
                                    {"QueryName": "BedoCCupancy_Soussi.Weight", "Name": "Weight"},
                                    {"QueryName": "Sum(BedoCCupancy_Soussi.Difference)", "Name": "Remaining"},
                                    {"QueryName": "Sum(BedoCCupancy_Soussi.FTotal)", "Name": "Sum of FTotal"},
                                    {"QueryName": "BedoCCupancy_Soussi.1", "Name": "SSO"},
                                    {"QueryName": "BedoCCupancy_Soussi.2", "Name": "LTC Weight"},
                                    {"QueryName": "BedoCCupancy_Soussi.3", "Name": "LTC GLOS"},
                                    {"QueryName": "BedoCCupancy_Soussi.PrograssNotes", "Name": "Handover"},
                                    {"QueryName": "BedoCCupancy_Soussi.OR Notes", "Name": "OR Notes"},
                                    {"QueryName": "BedoCCupancy_Soussi.Operations", "Name": "Operations"},
                                    {"QueryName": "BedoCCupancy_Soussi.DefaultMobile", "Name": "DefaultMobile"},
                                    {"QueryName": "BedoCCupancy_Soussi.TreatingPhysicianName", "Name": "TreatingPhysicianName"},
                                    {"QueryName": "BedoCCupancy_Soussi.PrograssNotes Creation Date", "Name": "PrograssNotes Creation Date"},
                                    {"QueryName": "BedoCCupancy_Soussi.DischargeExpectedDate", "Name": "DischargeExpectedDate"},
                                    {"QueryName": "BedoCCupancy_Soussi.Hand Over", "Name": "Prograssnotes"},
                                    {"QueryName": "BedoCCupancy_Soussi.EliteALOS", "Name": "EliteALOS"},
                                    {"QueryName": "BedoCCupancy_Soussi.EliteWeight", "Name": "EliteWeight"},
                                    {"QueryName": "BedOccupancyMedicalDirector_soussi.Medication Names", "Name": "Medication Names"},
                                    {"QueryName": "BedOccupancyMedicalDirector_soussi.IntialAssessment", "Name": "IntialAssessment"},
                                    {"QueryName": "BedOccupancyMedicalDirector_soussi.VTE Summary", "Name": "VTE Summary"}
                                ],
                                "Ordering": [
                                    0, 1, 7, 2, 32, 3, 6, 4, 5, 8, 10, 9, 11, 12, 21, 13, 14, 15, 16, 17, 20, 23, 33, 18, 19, 25, 22, 24, 26, 27, 28, 35, 34, 29, 36, 30, 31, 37, 38, 39, 40, 41
                                ],
                                "FiltersDescription": "No filters applied"
                            }
                        }
                    ]
                }
            }
        ],
        "cancelQueries": [],
        "modelId": "282542116",
        "userPreferredLocale": "en-US"
    }
}


def fetch_powerbi_and_sync(max_attempts: int = 4) -> bool:
    """Executes single-pass live synchronization between Power BI, Relational Postgres, and RTDB."""
    attempt = 0
    while attempt < max_attempts:
        try:
            # FIX: Initialize current UTC timestamp at the start of every sync run to prevent UnboundLocalError
            now_dt = datetime.datetime.now(datetime.timezone.utc)
            now_iso = now_dt.isoformat()

            cairo_now = get_cairo_now()
            cairo_date_str = cairo_now.strftime("%Y-%m-%d")
            cairo_time_str = cairo_now.strftime("%m/%d/%y %H:%M")
            is_1159_pm = (cairo_now.hour == 23 and cairo_now.minute >= 58)

            log("Fetching live dataset from Power BI...")
            auth = HttpNtlmAuth(POWERBI_USER, POWERBI_PASS) if POWERBI_USER else None
            response = requests.post(
                POWERBI_EXPORT_URL,
                json=POWERBI_PAYLOAD_DICT,
                auth=auth,
                timeout=25
            )
            try:
                response.raise_for_status()
            except requests.exceptions.HTTPError as http_err:
                server_detail = response.text.strip()
                if server_detail:
                    log(f"Power BI API response body: {server_detail[:500]}", level="error")
                raise

            df = pd.read_excel(io.BytesIO(response.content))
            if df.empty:
                log("Power BI returned empty dataset. Skipping cycle.", level="warning")
                return True

            # Dynamic column mapping: scan first 10 rows for >= 2 recognized occupancy header keywords
            header_row_idx = 0
            for r_idx in range(min(10, len(df))):
                row_strs = [str(x).lower().strip() for x in df.iloc[r_idx].values if pd.notna(x)]
                match_cnt = sum(1 for s in row_strs if any(k in s for k in [
                    'bed', 'room', 'patient', 'name', 'mrn', 'admission', 'invoice', 'remaining', 'handover', 'los'
                ]))
                if match_cnt >= 2:
                    header_row_idx = r_idx
                    break

            header_row: dict[Any, Any] = df.iloc[header_row_idx].to_dict()
            col_map: dict[str, str] = {}
            for col_key, header_val in header_row.items():
                if pd.notna(header_val):
                    h_str = str(header_val).strip()
                    col_map[h_str] = col_key
                    col_map[h_str.lower()] = col_key
                    clean_h = re.sub(r'[^a-z0-9\u0600-\u06FF]', '', h_str.lower())
                    if clean_h:
                        col_map[clean_h] = col_key

            def get_val(row: dict[str, Any], possible_names: list[str]) -> Any:
                for name in possible_names:
                    # 1. Exact or lowercase match in col_map
                    key = col_map.get(name) or col_map.get(name.lower())
                    if not key:
                        clean_n = re.sub(r'[^a-z0-9\u0600-\u06FF]', '', name.lower())
                        key = col_map.get(clean_n)
                    if key and pd.notna(row.get(key)):
                        return row.get(key)
                    if pd.notna(row.get(name)):
                        return row.get(name)
                return ""

            def clean_val(val: Any) -> Any:
                if pd.isna(val):
                    return None
                if isinstance(val, (datetime.date, datetime.datetime, pd.Timestamp)):
                    return val.isoformat()
                return val

            raw_records = df.iloc[header_row_idx + 1:].to_dict(orient="records")

            # 1. Fetch pre-existing state and active manual discharges guard
            existing = fetch_existing_supabase_state(cairo_date_str)
            manual_names = existing.get("manually_discharged_names", [])
            manual_mrns = set(existing.get("manually_discharged_mrns", []))
            if manual_names or manual_mrns:
                log(f"[Sync Guard] Active manual discharges recognized: {len(manual_names)} names, {len(manual_mrns)} MRNs.")

            # 2. Unified Single-Pass Parsing & Domain Classification
            records: list[NormalizedPatientRecord] = []
            for row in raw_records:
                bed_str = str(get_val(row, ["Bed#", "BedName_EN", "Bed", "Room", "Bed No", "الغرفة", "غرفة", "السرير", "سرير", "Unnamed: 1"])).strip()
                # Skip header row or empty beds
                if not bed_str or bed_str.lower() in ("bed#", "bed", "room", "الغرفة", "غرفة", "السرير", "سرير", "unnamed: 1") or "no filters" in bed_str.lower():
                    continue

                raw_mrn = str(get_val(row, ["MRN", "PatientBarcode", "Patient ID", "ID", "Patient MRN", "رقم المريض", "الملف", "رقم الملف"])).strip()
                # Guard against MRN matching full names when column is absent or shifted
                if raw_mrn and len(raw_mrn.split()) >= 2 and not any(ch.isdigit() for ch in raw_mrn):
                    raw_mrn = ""
                clean_m = raw_mrn.lstrip("0") if raw_mrn else ""
                p_name = str(get_val(row, ["Patient Name", "Patient", "EnglishFullName", "Name", "المريض", "اسم المريض", "الاسم", "اسم الحالة", "Unnamed: 3"]) or "Unknown Patient").strip()

                if not p_name or p_name.lower() in ("patient", "المريض", "name", "unknown", "englishfullname", "patient name"):
                    continue

                ad_val = clean_date(get_val(row, [
                    "Admission Date", "AdmissionDate", "Date", "تاريخ الدخول", "التاريخ",
                    "BedoCCupancy_Soussi.AdmissionDate", "No filters applied", "Unnamed: 0"
                ]))
                if not ad_val:
                    first_col_key = list(row.keys())[0] if len(row) > 0 else None
                    if first_col_key and pd.notna(row.get(first_col_key)):
                        candidate = clean_date(row.get(first_col_key))
                        if candidate and str(candidate).lower() not in ("admissiondate", "admission date"):
                            ad_val = candidate

                mob_val = clean_phone(get_val(row, ["DefaultMobile", "Mobile", "Phone", "الجوال", "الهاتف", "Unnamed: 4", "Unnamed: 32"]))
                if not mob_val:
                    m4 = clean_phone(row.get("Unnamed: 4"))
                    mob_val = m4 if len(m4) >= 7 else clean_phone(row.get("Unnamed: 32"))

                t_inv = float(clean_num(get_val(row, ["Invoice Total", "Sum of FTotal", "FTotal", "Total Invoice", "Total Amount", "Total", "إجمالي الفاتورة", "الاجمالي", "Unnamed: 25"])))
                r_deb = float(clean_num(get_val(row, ["Remaining", "Sum of Difference", "Remaining Amount", "Difference", "Balance", "المتبقي", "الباقي", "Unnamed: 27"])))

                det_seed = normalize_arabic_name(p_name) or bed_str or "patient"
                det_hash = uuid.uuid5(uuid.NAMESPACE_OID, det_seed).hex[:8].upper()
                rec = NormalizedPatientRecord(
                    mrn=clean_m or raw_mrn or f"UNKNOWN-{det_hash}",
                    clean_mrn=clean_m,
                    name=p_name,
                    bed=bed_str,
                    floor=str(get_val(row, ["Floor Name", "FloorName_EN", "FloorStructureName_EN", "Floor", "الطابق", "الدور", "Unnamed: 7", "Unnamed: 4", "Unnamed: 5"])).strip(),
                    physician=str(get_val(row, ["TreatingPhysicianName", "ConsultantName_EN", "Physician", "Doctor", "الطبيب", "الطبيب المعالج", "Unnamed: 22"])).strip(),
                    admission_date=str(ad_val) if ad_val else None,
                    contractor=str(get_val(row, ["Contractor Name", "ContractorName", "Contractor", "جهة التعاقد", "اسم الجهة", "الجهة والتعاقد", "الجهة", "الشركة", "جهة الدفع", "Unnamed: 12"])).strip(),
                    financial_status=str(get_val(row, ["Financial Status", "Financial Class", "Class", "Type", "الفئة", "نوع", "Unnamed: 5"])).strip(),
                    total_invoice=t_inv,
                    remaining_debt=r_deb,
                    specialty=normalize_specialty(get_val(row, ["Specialty", "Speciality", "Medical Plan X", "التخصص", "Unnamed: 23"])),
                    diagnosis=str(get_val(row, ["ICD-10", "ICD-10 Diagnosis", "DRG Diagnosis", "Diagnosis", "Name", "التشخيص", "Unnamed: 14"])).strip(),
                    mobile=mob_val,
                    los=str(get_val(row, ["LOS", "Sum(LOS)", "Unnamed: 18"])).strip(),
                    alos=str(get_val(row, ["Elite ALOS", "EliteALOS", "ALOS", "LOS AL", "Target ALOS", "Unnamed: 37"])).strip(),
                    expected_discharge=str(get_val(row, ["DischargeExpectedDate", "Discharge Expected Date", "Expected Discharge", "Unnamed: 31", "Unnamed: 20"])).strip(),
                    medications=str(get_val(row, ["Medication Names", "Medications", "Medication", "الأدوية", "Unnamed: 39"])).strip(),
                    initial_assessment=str(get_val(row, ["IntialAssessment", "Initial Assessment", "التقييم الأولي", "Unnamed: 40"])).strip(),
                    vte_summary=str(get_val(row, ["VTE Summary", "VTE", "جلطات", "Unnamed: 41"])).strip(),
                    notes=str(get_val(row, ["PrograssNotes", "HandOver", "Handover", "Prograssnotes", "Notes", "Remarks", "ملاحظات", "Unnamed: 8"])).strip(),
                    payment_by=str(get_val(row, ["PaymentBy", "Payment By", "طريقة الدفع", "الدفع بواسطة", "الدفع", "Unnamed: 11"])).strip(),
                    raw_row=row
                )
                records.append(rec)

            # 3. Partition Data Streams (Admissions, Debts, Dialysis, Entries)
            rpc_payload: list[dict[str, Any]] = []
            active_records: list[NormalizedPatientRecord] = []
            cash_debts: list[dict[str, Any]] = []
            insured_debts: list[dict[str, Any]] = []
            dialysis_cases: list[dict[str, Any]] = []
            today_entries: list[dict[str, Any]] = []

            for rec in records:
                # Guard against manually discharged patients
                if is_patient_manually_discharged(rec.name, rec.clean_mrn, manual_names, manual_mrns):
                    continue

                active_records.append(rec)

                # A. Relational RPC Payload
                rpc_payload.append({
                    "MRN": rec.mrn,
                    "Patient": rec.name,
                    "Bed#": rec.bed,
                    "Floor Name": rec.floor,
                    "TreatingPhysicianName": rec.physician,
                    "AdmissionDate": rec.admission_date,
                    "ContractorName": rec.contractor,
                    "Financial Status": rec.financial_status,
                    "Total Invoice": f"{rec.total_invoice:.2f}",
                    "Remaining Amount": f"{rec.remaining_debt:.2f}",
                    "Specialty": rec.specialty,
                    "Diagnosis": rec.diagnosis,
                    "Mobile": rec.mobile,
                    "LOS": rec.los,
                    "EliteALOS": rec.alos,
                    "ExpectedDischarge": rec.expected_discharge,
                    "Medication Names": rec.medications,
                    "IntialAssessment": rec.initial_assessment,
                    "VTE Summary": rec.vte_summary,
                    "Source": "powerbi"
                })

                b_low = rec.bed.lower()
                is_or_room = (
                    b_low in ("or", "o.r", "or1", "or2", "or3", "or4", "or5", "or6", "عمليات", "غرفة عمليات")
                    or b_low.startswith(("or-", "or ", "or -"))
                )

                # B. Debts Classification (Ignore procedural rooms and doctor cases)
                if not is_or_room:
                    f_low = rec.financial_status.lower()
                    m_low = rec.contractor.lower()
                    is_homecare = ("home care" in m_low or "homecare" in m_low or "home care" in f_low or "homecare" in f_low)
                    is_doc_case = is_doctor_case_or_physician_payment(rec.financial_status, rec.contractor, rec.payment_by, rec.notes, rec.name, rec.physician)

                    if not is_homecare and not is_doc_case:
                        debt_item = {
                            "colA": rec.admission_date or "",
                            "date": rec.admission_date or "",
                            "admissionDate": rec.admission_date or "",
                            "room": rec.bed,
                            "mrn": rec.mrn,
                            "colD": rec.name,
                            "colF": rec.financial_status,
                            "financialStatus": rec.financial_status,
                            "colM": rec.contractor,
                            "contractor": rec.contractor,
                            "colL": rec.payment_by,
                            "paymentBy": rec.payment_by,
                            "notes": rec.notes,
                            "physician": rec.physician,
                            "colZ": str(rec.total_invoice),
                            "colAB": str(rec.remaining_debt),
                            "valZ": rec.total_invoice,
                            "valAB": rec.remaining_debt,
                            "totalInvoice": rec.total_invoice,
                            "remainingAmount": rec.remaining_debt,
                            "mobile": rec.mobile,
                            "phone": rec.mobile
                        }

                        has_cash = any(kw in txt for txt in (m_low, f_low) for kw in ("cash", "كاش", "نقدي", "نقدى"))
                        if has_cash:
                            is_cash = True
                        elif m_low in ("", "elite", "بدون جهة", "بدون جهه", "عميل", "افراد", "أفراد", "self", "private", "personal"):
                            is_cash = not any(kw in f_low for kw in ("insured", "تأمين", "تامين", "تعاقد"))
                        else:
                            is_cash = False

                        if is_cash:
                            if rec.remaining_debt != 0 or rec.total_invoice > 0:
                                cash_debts.append(debt_item)
                        elif rec.remaining_debt > 0 or rec.total_invoice > 0:
                            insured_debts.append(debt_item)

                # C. Dialysis Classification
                if not is_or_room and "323" not in b_low:
                    fl_low = rec.floor.lower()
                    spec_low = rec.specialty.lower()
                    is_inpatient = bool(RE_INPATIENT_ROOM.search(b_low)) or "suite" in b_low or "سويت" in b_low or "icu" in b_low or "ccu" in b_low

                    is_dial_case = False
                    if not is_inpatient:
                        if is_dialysis_room(rec.bed):
                            is_dial_case = True
                        elif any(kw in fl_low for kw in ("dialysis", "diyalsis", "hemodialysis", "haemodialysis", "غسيل كلوي", "غسيل كلى", "استصفاء", "ديلزة")):
                            is_dial_case = True
                        elif any(kw in spec_low for kw in ("dialysis", "غسيل", "nephrology", "كلى")) and any(kw in b_low or kw in fl_low for kw in ("dc", "daycase", "chair", "station")):
                            is_dial_case = True

                    if is_dial_case:
                        if rec.admission_date and is_date_today_cairo(rec.admission_date, cairo_date_str):
                            dialysis_cases.append({
                                "room": rec.bed if rec.bed else "Dialysis",
                                "name": rec.name,
                                "physician": rec.physician,
                                "contractor": rec.contractor,
                                "date": rec.admission_date or "",
                                "mrn": rec.mrn,
                                "mobile": rec.mobile,
                                "floor": rec.floor,
                                "diagnosis": rec.diagnosis,
                                "specialty": rec.specialty
                            })

                # D. Today Admissions / Entries Classification
                if not is_or_room:
                    if rec.admission_date and is_date_today_cairo(rec.admission_date, cairo_date_str):
                        today_entries.append({
                            "room": rec.bed,
                            "name": rec.name,
                            "date": rec.admission_date,
                            "rawDate": rec.admission_date,
                            "mrn": rec.mrn,
                            "mobile": rec.mobile,
                            "physician": rec.physician,
                            "contractor": rec.contractor,
                            "floor": rec.floor,
                            "diagnosis": rec.diagnosis,
                            "financialStatus": rec.financial_status,
                        })

            # Cumulative entries resolution
            cumulative_entries = [
                p for p in (existing.get("entries") or [])
                if is_date_today_cairo(p.get("date") or p.get("rawDate"), cairo_date_str)
            ]
            for p in today_entries:
                p_name = p.get("name", "").strip()
                p_mrn = p.get("mrn", "").strip()
                if not any(is_name_match(ex.get("name"), p_name) or (p_mrn and ex.get("mrn") == p_mrn) for ex in cumulative_entries):
                    cumulative_entries.append(p)

            # 4. Dialysis & Transfers with 11:59 PM Cairo Rollover
            if is_1159_pm or existing.get("is_new_day") or existing.get("is_system_reset"):
                log(f"[Sync Rollover] Fresh daily counters active for {cairo_date_str}. Zeroing daily dialysis & transfers.")
                cumulative_dialysis: list[dict[str, Any]] = []
                cumulative_transfers: list[dict[str, Any]] = []
            else:
                cumulative_dialysis = [
                    p for p in (existing.get("dialysis") or [])
                    if "323" not in str(p.get("room", "")) and (not p.get("date") or is_date_today_cairo(p.get("date"), cairo_date_str))
                ]
                for p in dialysis_cases:
                    p_name = p.get("name", "").strip().lower()
                    if p_name and not any(ex.get("name", "").strip().lower() == p_name for ex in cumulative_dialysis if ex.get("name")):
                        cumulative_dialysis.append(p)

                # Patient Transfer Detection
                prev_rooms: dict[str, dict[str, Any]] = {}
                for r in (existing.get("occupancy_current") or []):
                    b, m, n = "", "", ""
                    physician, contractor = "", ""
                    if isinstance(r, dict):
                        b = str(r.get("Unnamed: 1") or "").strip()
                        cell2 = str(r.get("Unnamed: 2") or "").strip()
                        cell3 = str(r.get("Unnamed: 3") or "").strip()
                        if any("\u0600" <= ch <= "\u06FF" for ch in cell2):
                            n, m = cell2, cell3.lstrip("0")
                        else:
                            m, n = cell2.lstrip("0"), cell3
                        physician = str(r.get("Unnamed: 22") or "").strip()
                        contractor = str(r.get("Unnamed: 12") or "").strip()
                    elif isinstance(r, (list, tuple)) and len(r) >= 4:
                        b = str(r[1] or "").strip()
                        cell2 = str(r[2] or "").strip()
                        cell3 = str(r[3] or "").strip()
                        if any("\u0600" <= ch <= "\u06FF" for ch in cell2):
                            n, m = cell2, cell3.lstrip("0")
                        else:
                            m, n = cell2.lstrip("0"), cell3
                        physician = str(r[22] if len(r) > 22 else "") or ""
                        contractor = str(r[12] if len(r) > 12 else "") or ""

                    if b and n and b.lower() not in ("bed", "bed#", "room", "الغرفة", "غرفة", "unnamed: 1"):
                        norm_n = normalize_arabic_name(n)
                        key = m if m else norm_n
                        prev_rooms[key] = {
                            "room": b,
                            "mrn": m,
                            "name": n,
                            "physician": physician,
                            "contractor": contractor
                        }

                cumulative_transfers = list(existing.get("transfers") or [])
                for rec in active_records:
                    norm_rec_name = normalize_arabic_name(rec.name)
                    key = rec.clean_mrn if rec.clean_mrn else norm_rec_name
                    matched_prev = prev_rooms.get(key)
                    if not matched_prev and norm_rec_name:
                        for pk, pv in prev_rooms.items():
                            if is_name_match(pv.get("name"), rec.name):
                                matched_prev = pv
                                break

                    if matched_prev:
                        prev = matched_prev
                        prev_r = prev["room"].strip()
                        curr_r = rec.bed.strip()
                        if (
                            prev_r and curr_r
                            and prev_r.lower() != curr_r.lower()
                            and not is_procedure_or_temporary_room(prev_r)
                            and not is_procedure_or_temporary_room(curr_r)
                        ):
                            # Locate existing transfer journey record
                            existing_rec: Optional[dict[str, Any]] = None
                            for t in cumulative_transfers:
                                t_mrn = str(t.get("mrn", "")).strip().lstrip("0")
                                t_name = str(t.get("name", "")).strip()
                                if (rec.clean_mrn and t_mrn and rec.clean_mrn == t_mrn) or is_name_match(rec.name, t_name):
                                    existing_rec = t
                                    break

                            if not existing_rec:
                                new_transfer = {
                                    "id": f"transfer-{int(time.time()*1000)}-{uuid.uuid4().hex[:6]}",
                                    "name": rec.name,
                                    "mrn": rec.mrn,
                                    "initialRoom": prev_r,
                                    "currentRoom": curr_r,
                                    "journey": [prev_r, curr_r],
                                    "history": [{
                                        "fromRoom": prev_r,
                                        "toRoom": curr_r,
                                        "date": cairo_time_str,
                                        "physician": rec.physician or prev.get("physician", ""),
                                        "contractor": rec.contractor or prev.get("contractor", "")
                                    }],
                                    "lastTransferDate": cairo_time_str,
                                    "physician": rec.physician or prev.get("physician", ""),
                                    "contractor": rec.contractor or prev.get("contractor", ""),
                                    "notes": f"Transferred from {prev_r} to {curr_r}"
                                }
                                cumulative_transfers.insert(0, new_transfer)
                                log(f"[Patient Transfer] \"{rec.name}\" moved from \"{prev_r}\" to \"{curr_r}\"")
                            else:
                                journey = existing_rec.get("journey") or [existing_rec.get("initialRoom", prev_r)]
                                history = existing_rec.get("history") or []
                                last_room = journey[-1] if journey else ""
                                if last_room.lower() != curr_r.lower() and existing_rec.get("currentRoom", "").lower() != curr_r.lower():
                                    journey.append(curr_r)
                                    history.append({
                                        "fromRoom": prev_r,
                                        "toRoom": curr_r,
                                        "date": cairo_time_str,
                                        "physician": rec.physician or prev.get("physician", ""),
                                        "contractor": rec.contractor or prev.get("contractor", "")
                                    })
                                    existing_rec["journey"] = journey
                                    existing_rec["history"] = history
                                    existing_rec["currentRoom"] = curr_r
                                    existing_rec["lastTransferDate"] = cairo_time_str
                                    log(f"[Patient Transfer Journey Extended] \"{rec.name}\" moved to \"{curr_r}\"")

            # 5. Execute Relational Sync via PostgREST RPC
            log(f"Syncing {len(rpc_payload)} active admissions to PostgREST RPC...")
            session = get_supabase_session()
            rpc_res = session.post(
                SUPABASE_RPC_URL,
                headers={"Prefer": "return=minimal"},
                json={"payload": rpc_payload},
                timeout=25,
                verify=SUPABASE_SSL_VERIFY
            )

            if rpc_res.status_code not in (200, 204):
                log(f"RPC Relational Sync returned status {rpc_res.status_code}: {rpc_res.text}", level="warning")
                # Direct fallback upsert to public.patients table
                try:
                    pts_to_upsert: list[dict[str, Any]] = []
                    seen_mrns: set[str] = set()
                    for item in rpc_payload:
                        m = item.get("MRN")
                        if not m or m.startswith("UNKNOWN-") or m in seen_mrns:
                            continue
                        seen_mrns.add(m)
                        p_entry = {"mrn": m, "name": item.get("Patient") or "Unknown Patient", "updated_at": now_iso}
                        if item.get("Mobile"):
                            p_entry["phone"] = item["Mobile"]
                        pts_to_upsert.append(p_entry)

                    if pts_to_upsert:
                        session.post(
                            f"{SUPABASE_URL}/rest/v1/patients?on_conflict=mrn",
                            headers={"Prefer": "resolution=merge-duplicates"},
                            json=pts_to_upsert,
                            timeout=20,
                            verify=SUPABASE_SSL_VERIFY
                        )
                except Exception as pt_err:
                    log(f"Notice: Patient fallback upsert failed: {pt_err}", level="warning")
            else:
                log("Relational database admissions successfully synchronized via RPC!")

            # 6. Reconstruct Rigid Legacy Matrix for Backward Compatibility
            fake_header = {
                "No filters applied": "AdmissionDate",
                "Unnamed: 1": "Bed",
                "Unnamed: 2": "MRN",
                "Unnamed: 3": "Patient",
                "Unnamed: 4": "DefaultMobile",
                "Unnamed: 5": "Financial Status",
                "Unnamed: 6": "Age",
                "Unnamed: 7": "Floor Name",
                "Unnamed: 8": "Notes",
                "Unnamed: 9": "Companions #",
                "Unnamed: 10": "Visit",
                "Unnamed: 11": "PaymentBy",
                "Unnamed: 12": "ContractorName",
                "Unnamed: 13": "FloorStructureName_EN",
                "Unnamed: 14": "Diagnosis",
                "Unnamed: 18": "LOS Status",
                "Unnamed: 20": "Expected Discharge",
                "Unnamed: 22": "TreatingPhysicianName",
                "Unnamed: 23": "Speciality",
                "Unnamed: 24": "Transfer History",
                "Unnamed: 25": "Total Invoice",
                "Unnamed: 27": "Remaining Amount",
                "Unnamed: 32": "Creation Date",
                "Unnamed: 33": "Medical Plan AH",
                "Unnamed: 34": "Medical Plan AI",
                "Unnamed: 37": "EliteALOS",
                "Unnamed: 38": "EliteWeight",
                "Unnamed: 39": "Medication Names",
                "Unnamed: 40": "IntialAssessment",
                "Unnamed: 41": "VTE Summary"
            }
            legacy_occupancy_rows: list[dict[str, Any]] = [fake_header]

            known_mappings = {
                0: ["Admission Date", "AdmissionDate", "Date", "تاريخ الدخول", "التاريخ", "No filters applied", "Unnamed: 0"],
                1: ["Bed#", "BedName_EN", "Bed", "Room", "Bed No", "الغرفة", "غرفة", "السرير", "سرير", "Unnamed: 1"],
                2: ["MRN", "PatientBarcode", "Patient ID", "ID", "Patient MRN", "رقم المريض", "الملف", "رقم الملف"],
                3: ["Patient Name", "Patient", "EnglishFullName", "Name", "المريض", "اسم المريض", "الاسم", "اسم الحالة", "Unnamed: 3"],
                4: ["DefaultMobile", "Mobile", "Phone", "الجوال", "الهاتف", "Unnamed: 4"],
                5: ["Financial Status", "Financial Class", "Class", "Type", "الفئة", "نوع", "Unnamed: 5"],
                6: ["Age", "PatientAgeDBComputed", "Unnamed: 6"],
                7: ["Floor Name", "FloorName_EN", "Floor", "الطابق", "الدور", "Unnamed: 7"],
                8: ["Notes", "Remarks", "ملاحظات", "Unnamed: 8"],
                9: ["Companions #", "Count of Companions", "Companion", "مرافق", "Unnamed: 9"],
                10: ["Visit", "VisitTypeGUID", "Visit Type", "VisitType", "نوع الزيارة", "Unnamed: 10"],
                11: ["PaymentBy", "Payment By", "طريقة الدفع", "الدفع بواسطة", "الدفع", "Unnamed: 11"],
                12: ["Contractor Name", "ContractorName", "Contractor", "جهة التعاقد", "اسم الجهة", "الجهة والتعاقد", "الجهة", "الشركة", "جهة الدفع", "Unnamed: 12"],
                14: ["ICD-10", "ICD-10 Diagnosis", "DRG Diagnosis", "Diagnosis", "Name", "التشخيص", "Unnamed: 14"],
                18: ["LOS", "Sum(LOS)", "LOS Status", "Unnamed: 18"],
                20: ["DischargeExpectedDate", "Expected Discharge", "ALOS", "Unnamed: 20"],
                22: ["TreatingPhysicianName", "ConsultantName_EN", "Physician", "Doctor", "الطبيب", "الطبيب المعالج", "Unnamed: 22"],
                23: ["Specialty", "Speciality", "Medical Plan X", "التخصص", "Unnamed: 23"],
                24: ["Transfer History", "Unnamed: 24"],
                25: ["Invoice Total", "Sum of FTotal", "FTotal", "Total Invoice", "Total Amount", "Total", "إجمالي الفاتورة", "الاجمالي", "Unnamed: 25"],
                26: ["Payments", "Sum of Payments", "Unnamed: 26"],
                27: ["Remaining", "Sum of Difference", "Remaining Amount", "Difference", "Balance", "المتبقي", "الباقي", "Unnamed: 27"],
                28: ["SSO", "Unnamed: 28"],
                29: ["LTC Weight", "Unnamed: 29"],
                30: ["LTC GLOS", "Unnamed: 30"],
                31: ["DischargeExpectedDate", "Expected Discharge", "Unnamed: 31"],
                32: ["HandOver Creation Date", "PrograssNotes Creation Date", "Creation Date", "Medical Plan AG", "تاريخ الخطة", "DefaultMobile", "Unnamed: 32"],
                33: ["HandOver", "Handover", "PrograssNotes", "Medical Plan AH", "الخطة الطبية", "Operations", "Unnamed: 33"],
                34: ["PrograssNotes", "Prograssnotes", "Hand Over", "Notes", "Medical Plan AI", "Unnamed: 34"],
                35: ["OR Notes", "Unnamed: 35"],
                36: ["Operations", "Unnamed: 36"],
                37: ["Elite ALOS", "EliteALOS", "ALOS", "LOS AL", "Target ALOS", "Unnamed: 37"],
                38: ["Elite Weight", "EliteWeight", "Weight", "Unnamed: 38"],
                39: ["Medication Names", "Medications", "Medication", "الأدوية", "Unnamed: 39"],
                40: ["IntialAssessment", "Initial Assessment", "التقييم الأولي", "Unnamed: 40"],
                41: ["VTE Summary", "VTE", "جلطات", "Unnamed: 41"]
            }

            total_cols = max(42, len(header_row))
            for rec in active_records:
                legacy_row: dict[str, Any] = {}
                for i in range(total_cols):
                    col_key = "No filters applied" if i == 0 else f"Unnamed: {i}"
                    if i in known_mappings:
                        val = clean_val(get_val(rec.raw_row, known_mappings[i]))
                        if i == 2:
                            # MRN guard: If extracted val is a patient name (multi-word letters), use rec.clean_mrn or rec.mrn
                            if not val or (len(str(val).split()) >= 2 and not any(ch.isdigit() for ch in str(val))):
                                val = rec.clean_mrn or rec.mrn
                        legacy_row[col_key] = val
                    else:
                        legacy_row[col_key] = clean_val(get_val(rec.raw_row, [f"Unnamed: {i}"]))
                legacy_occupancy_rows.append(legacy_row)

            # 7. Assemble Granular RTDB State & Historical Parity Snapshot
            summary_info = {
                "totalOccupancy": max(0, len(legacy_occupancy_rows) - 1),
                "entriesCount": len(cumulative_entries),
                "dischargesCount": len(existing.get("discharged", [])),
                "autoDischargesCount": len([p for p in existing.get("discharged", []) if isinstance(p, dict) and p.get("dischargeType") != "manual"]),
                "manualDischargesCount": len([p for p in existing.get("discharged", []) if isinstance(p, dict) and p.get("dischargeType") == "manual"]),
                "dialysisCount": len(cumulative_dialysis),
                "debtsCount": len(cash_debts),
                "insuredDebtsCount": len(insured_debts),
                "transfersCount": len(cumulative_transfers)
            }

            raw_hist_index = existing.get("occupancy_index") or []
            existing_index_entries = [e for e in raw_hist_index if isinstance(e, dict) and str(e.get("date", "")).strip() != cairo_date_str]
            today_index_entry = {
                "date": cairo_date_str,
                "timestamp": int(time.time() * 1000),
                "cairoTime": cairo_now.strftime("%Y-%m-%d %H:%M:%S"),
                "summary": summary_info
            }
            updated_hist_index = [today_index_entry] + existing_index_entries
            try:
                updated_hist_index.sort(key=lambda x: str(x.get("date", "")), reverse=True)
            except Exception:
                pass

            granular_nodes = [
                {"path": "state/occupancy", "data": {"current": legacy_occupancy_rows, "previous": existing.get("previous")}, "updated_at": now_iso},
                {"path": "state/debts", "data": {"items": cash_debts}, "updated_at": now_iso},
                {"path": "state/insured_debts", "data": {"items": insured_debts}, "updated_at": now_iso},
                {"path": "state/dialysis", "data": {"items": cumulative_dialysis}, "updated_at": now_iso},
                {"path": "state/transfers", "data": {"items": cumulative_transfers}, "updated_at": now_iso},
                {"path": "state/entries", "data": {"items": cumulative_entries}, "updated_at": now_iso},
                {"path": "state/discharged", "data": {"patients": existing.get("discharged", [])}, "updated_at": now_iso},
                {
                    "path": "state/metadata",
                    "data": {
                        **(existing.get("existing_metadata") or {}),
                        "uploadedAt": now_iso,
                        "lastDatabaseUpdatedAt": now_iso,
                        "lastActiveDate": cairo_date_str,
                        "manuallyDischargedNames": existing.get("manually_discharged_names", []),
                        "counts": {
                            "occupiedBeds": max(0, len(legacy_occupancy_rows) - 1),
                            "debts": len(cash_debts),
                            "insuredDebts": len(insured_debts),
                            "dialysis": len(cumulative_dialysis),
                            "transfers": len(cumulative_transfers),
                            "entries": len(cumulative_entries),
                            "discharged": len(existing.get("discharged", []))
                        }
                    },
                    "updated_at": now_iso
                },
                {"path": f"history/occupancy/{cairo_date_str}/summary", "data": summary_info, "updated_at": now_iso},
                {"path": f"history/occupancy/{cairo_date_str}/hospital_data", "data": legacy_occupancy_rows, "updated_at": now_iso},
                {"path": f"history/occupancy/{cairo_date_str}/discharged", "data": existing.get("discharged", []), "updated_at": now_iso},
                {"path": f"history/occupancy/{cairo_date_str}/transfers", "data": cumulative_transfers, "updated_at": now_iso},
                {"path": f"history/occupancy/{cairo_date_str}/entries", "data": cumulative_entries, "updated_at": now_iso},
                {"path": f"history/occupancy/{cairo_date_str}/dialysis", "data": cumulative_dialysis, "updated_at": now_iso},
                {"path": f"history/occupancy/{cairo_date_str}/debts", "data": cash_debts, "updated_at": now_iso},
                {"path": f"history/occupancy/{cairo_date_str}/insured_debts", "data": insured_debts, "updated_at": now_iso},
                {"path": "history/occupancy_index", "data": updated_hist_index, "updated_at": now_iso}
            ]

            sb_response = session.post(SUPABASE_REST_URL, json=granular_nodes, timeout=30, verify=SUPABASE_SSL_VERIFY)
            if sb_response.status_code in (200, 201, 204):
                log(
                    f"Supabase state + Today's Snapshot ({cairo_date_str}) successfully committed: "
                    f"{len(cash_debts)} cash debts, {len(insured_debts)} insured debts, "
                    f"{len(cumulative_dialysis)} dialysis, {len(cumulative_transfers)} transfers, "
                    f"{len(cumulative_entries)} entries, {len(active_records)} occupied beds."
                )
                return True
            else:
                log(f"Supabase RTDB upsert failed with status {sb_response.status_code}: {sb_response.text}", level="warning")

        except Exception as e:
            log(f"Sync error encountered: {e}", level="error")

        attempt += 1
        if attempt >= max_attempts:
            log(f"Max retry attempts ({max_attempts}) reached for this cycle. Deferring until next scheduled run.", level="error")
            return False
        backoff_sec = min(120, 15 * (2 ** (attempt - 1)))
        failure_countdown(backoff_sec, f"Data Fetch & Sync (Attempt {attempt}/{max_attempts})")
    return False


# --- SCHEDULING & TIMEZONE ROLLOVER ORCHESTRATION ---

last_cairo_seen_date: str = ""


def check_cairo_day_rollover() -> None:
    """Detects midnight and 23:59 EOD rollovers in Cairo timezone."""
    global last_cairo_seen_date
    now_cairo = get_cairo_now()
    today_str = now_cairo.strftime("%Y-%m-%d")

    if not last_cairo_seen_date:
        last_cairo_seen_date = today_str
        return

    clean_last_seen = last_cairo_seen_date.replace("_1159_done", "")
    if today_str != clean_last_seen:
        log(f"[Calendar Rollover] Date transitioned from {clean_last_seen} to {today_str}. Triggering midnight sync...")
        last_cairo_seen_date = today_str
        run_sync_job()
    elif now_cairo.hour == 23 and now_cairo.minute >= 58:
        if last_cairo_seen_date == today_str:
            last_cairo_seen_date = f"{today_str}_1159_done"
            log(f"[EOD Reset] 23:59 Cairo reached ({today_str} {now_cairo.strftime('%H:%M')}). Triggering closing snapshot...")
            run_sync_job()


def run_sync_job() -> None:
    """Executes a complete sync job sequence."""
    log("=== STARTING SYNC JOB CYCLE ===")
    fortinet_reconnect()
    fetch_powerbi_and_sync()


def handle_shutdown(signum: int, frame: Any) -> None:
    """Graceful termination handler."""
    log(f"Received exit signal ({signum}). Shutting down sync service cleanly.")
    sys.exit(0)


if __name__ == "__main__":
    signal.signal(signal.SIGINT, handle_shutdown)
    signal.signal(signal.SIGTERM, handle_shutdown)

    log("Hospital Occupancy Sync Service Online (Python 3.12+ Architecture). Initializing first run...")
    run_sync_job()
    schedule.every(30).minutes.do(run_sync_job)

    while True:
        check_cairo_day_rollover()
        schedule.run_pending()
        next_run = schedule.next_run()
        if next_run:
            now = datetime.datetime.now()
            time_remaining = (next_run - now).total_seconds()
            if time_remaining > 0 and sys.stdout.isatty():
                mins, secs = divmod(int(time_remaining), 60)
                sys.stdout.write(f"\r[{now.strftime('%Y-%m-%d %H:%M:%S')}] Next sync in: {mins:02d}:{secs:02d}   ")
                sys.stdout.flush()
        time.sleep(1)
