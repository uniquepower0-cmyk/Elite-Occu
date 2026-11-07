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
import hashlib
import signal
import logging
import datetime
import zoneinfo
import platform
import socket
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
    try:
        _record_standalone_log(level, msg)
    except Exception:
        pass


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
POWERBI_TIMEOUT: Final[int] = int(os.getenv("POWERBI_TIMEOUT", "90"))

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
# Matches "ER" as a standalone word in a bed name (e.g. "ER V-BED"), not inside words like "intermediate".
RE_ER_ROOM: Final = re.compile(r"\bER\b", re.IGNORECASE)

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


def _parse_unified_date_components(d_val: Any) -> Optional[tuple[int, int, int, int, int]]:
    """
    Parses any date representation into (year, month, day, hour, minute) using the Unified Date Policy:
    - ISO / YYYY-MM-DD: year=p1, month=p2, day=p3
    - Slash dates (M/D/Y from Excel/PowerBI when both p1, p2 <= 12): month=p1, day=p2
    - Dash/Dot dates (DD-MM-YYYY): day=p1, month=p2
    - Sanitizes 5-digit year typos (e.g. 20265 -> 2026).
    """
    if d_val is None or pd.isna(d_val):
        return None
    if isinstance(d_val, (datetime.datetime, pd.Timestamp)):
        yr = 2026 if (d_val.year > 9999 and str(d_val.year).startswith("2026")) else d_val.year
        return (yr, d_val.month, d_val.day, d_val.hour, d_val.minute)
    if isinstance(d_val, datetime.date):
        yr = 2026 if (d_val.year > 9999 and str(d_val.year).startswith("2026")) else d_val.year
        return (yr, d_val.month, d_val.day, 0, 0)

    s = str(d_val).strip()
    if not s or s.lower() in ("nan", "none", "null", "nat", "undefined", "no filters applied", "admissiondate", "admission date"):
        return None

    # Sanitize 5-digit year typos such as 20265-09-26 -> 2026-09-26
    s = re.sub(r"\b(202\d)\d\b", r"\1", s)
    s = s.translate(ARABIC_DIGITS_TRANS)
    s = re.sub(r"(?:صباحا|صباحاً|ص)", "AM", s)
    s = re.sub(r"(?:مساء|مساءً|م)", "PM", s)
    s = re.sub(r"\s+", " ", s).strip()

    # Check ISO with timezone first
    if "t" in s.lower() and ("z" in s.lower() or "+" in s):
        try:
            clean = s.replace("Z", "+00:00").replace("z", "+00:00")
            dt = datetime.datetime.fromisoformat(clean).astimezone(CAIRO_TZ)
            return (dt.year, dt.month, dt.day, dt.hour, dt.minute)
        except Exception:
            pass

    m = re.match(
        r"^(\d{1,4})([-\/.])(\d{1,2})[-\/.](\d{1,4})(?:[\sT]+(\d{1,2}):(\d{1,2})(?::\d{1,2})?(?:\.\d+)?\s*(AM|PM|am|pm)?)?",
        s
    )
    if m:
        p1, sep, p2, p3 = int(m.group(1)), m.group(2), int(m.group(3)), int(m.group(4))
        hh = int(m.group(5)) if m.group(5) is not None else 0
        mm = int(m.group(6)) if m.group(6) is not None else 0
        ampm = (m.group(7) or "").upper()
        if ampm == "PM" and hh < 12:
            hh += 12
        elif ampm == "AM" and hh == 12:
            hh = 0

        if p1 > 1000:
            year = 2026 if (p1 > 9999 and str(p1).startswith("2026")) else p1
            month, day = p2, p3
            if month > 12 and day <= 12:
                month, day = day, month
        else:
            year = p3
            if year < 100:
                year += 2000 if year < 70 else 1900
            elif year > 9999 and str(year).startswith("2026"):
                year = 2026

            if p1 > 12:
                day, month = p1, p2
            elif p2 > 12:
                month, day = p1, p2
            elif sep == "/":
                # Slash dates with both parts <= 12 are US M/D/Y from Excel/PowerBI
                month, day = p1, p2
            else:
                # Dash or dot dates are DD-MM-YYYY
                day, month = p1, p2

        if 1 <= month <= 12 and 1 <= day <= 31:
            return (year, month, day, hh, mm)

    return None


def is_date_today_cairo(d_val: Any, today_cairo_str: Optional[str] = None) -> bool:
    """Validates whether an arbitrary date representation belongs to today in Cairo using strict date policy."""
    if not d_val:
        return False
    if not today_cairo_str:
        today_cairo_str = get_cairo_now().strftime("%Y-%m-%d")

    try:
        parts = today_cairo_str.split("-")
        c_yr, c_mo, c_dy = int(parts[0]), int(parts[1]), int(parts[2])
    except (ValueError, IndexError):
        return False

    parsed = _parse_unified_date_components(d_val)
    if parsed:
        yr, mo, dy, _, _ = parsed
        return (yr == c_yr and mo == c_mo and dy == c_dy)

    return False


def calculate_los_from_admission(adm_date_val: Any) -> str:
    """Calculates Length of Stay (LOS) in whole days from admission date to current Cairo date."""
    if not adm_date_val:
        return "0"
    try:
        parsed = _parse_unified_date_components(adm_date_val)
        if parsed:
            y, m, d, _, _ = parsed
            adm_dt = datetime.date(y, m, d)
            cairo_today = get_cairo_now().date()
            diff = (cairo_today - adm_dt).days
            return str(max(0, diff))
    except Exception:
        pass
    return "0"


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
    """Sanitizes date expressions into canonical DD-MM-YYYY HH:MM strings."""
    if val is None or pd.isna(val):
        return None
    parsed = _parse_unified_date_components(val)
    if parsed:
        yr, mo, dy, hh, mm = parsed
        return f"{dy:02d}-{mo:02d}-{yr:04d} {hh:02d}:{mm:02d}"
    s = str(val).strip()
    if not s or s.lower() in ("none", "nan", "null", "nat", "no filters applied", "admissiondate", "admission date"):
        return None
    return s


def clean_expected_discharge_date(val: Any) -> str:
    """Sanitizes expected discharge dates (including 5-digit year typos like 20265-09-26) into DD-MM-YYYY HH:MM."""
    if val is None or pd.isna(val):
        return ""
    s = str(val).strip()
    if not s or s.lower() in ("none", "nan", "null", "nat", "-", "0"):
        return ""
    cleaned = clean_date(s)
    return cleaned if cleaned else s


def clean_room_str(room: Any) -> str:
    """Normalizes room labels to match server.ts cleanRoomStr."""
    if not room:
        return ""
    s = str(room).strip()
    low = s.lower()
    if "307" in low and "intermediate" in low:
        return "Room 307"
    s = re.sub(r"\b(401)\s*[ab]\b", r"\1", s, flags=re.IGNORECASE)
    return s


def normalize_room(room: Any) -> str:
    """Canonical lowercase room identifier for transfer comparison (matches server.ts normalizeRoom)."""
    if not room:
        return ""
    r = clean_room_str(room).lower()
    r = re.sub(r"^(room|غرفة|غرفه|سرير|bed)\s*", "", r, flags=re.IGNORECASE).strip()
    r = re.sub(r"\s+", " ", r)
    return r


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
    handover: str
    visit_type: str
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
        f"state/metadata,state/discharged,state/dialysis,state/transfers,state/occupancy,state/entries,state/registry,history/occupancy_index"
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
    if raw_dial and not is_system_reset and not is_new_day:
        for p in raw_dial:
            if isinstance(p, dict) and "323" not in str(p.get("room", "")):
                p_date = p.get("date") or p.get("rawDate")
                if p_date:
                    if is_date_today_cairo(p_date, cairo_date_str):
                        existing_dial.append(p)
                elif is_today_cairo(dial_updated, cairo_date_str):
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

    reg_node = state_map.get("state/registry") or {}
    raw_registry = (
        reg_node.get("patientRoomRegistry")
        if isinstance(reg_node, dict) and "patientRoomRegistry" in reg_node
        else (reg_node if isinstance(reg_node, dict) else {})
    )

    dataset = state_map.get("state/dataset") or {}

    return {
        "previous": occ.get("previous") or dataset.get("current"),
        "occupancy_current": occ_current,
        "discharged": clean_disc_patients,
        "entries": existing_entries,
        "transfers": existing_trans,
        "orList": (state_map.get("state/or_list") or {}).get("items", []),
        "dialysis": existing_dial,
        "registry": raw_registry if isinstance(raw_registry, dict) else {},
        "manually_discharged_names": list(manual_names_set),
        "manually_discharged_mrns": list(manual_mrns_set),
        "occupancy_index": state_map.get("history/occupancy_index") or [],
        "existing_metadata": meta,
        "is_new_day": is_new_day,
        "is_system_reset": is_system_reset,
    }


# --- HMIS (CYBERNETICS) PENDING DISCHARGE INTEGRATION ---

HMIS_BASE_URL: Final[str] = os.getenv("HMIS_BASE_URL", "http://10.12.0.10").rstrip("/")
HMIS_USER: Final[str] = os.getenv("ELITE_USER", "")
HMIS_PASS: Final[str] = os.getenv("ELITE_PASS", "")
HMIS_MEDICAL_ENTITY: Final[str] = os.getenv("HMIS_MEDICAL_ENTITY", "c1ed304b-5d45-43a8-be05-b0ccafe43391")
# Nurse Portal "Pending Discharge" tile == occupied beds whose AdmissionStatus is FinancialDischarge.
HMIS_PENDING_STATUS: Final[str] = "FinancialDischarge"
# Dry-run by default: only logs what would be discharged. Set HMIS_PENDING_DRY_RUN=0 to write.
HMIS_PENDING_DRY_RUN: Final[bool] = os.getenv("HMIS_PENDING_DRY_RUN", "1").lower() not in ("0", "false", "no")
HMIS_PENDING_ENABLED: Final[bool] = os.getenv("HMIS_PENDING_ENABLED", "1").lower() not in ("0", "false", "no")


def fetch_hmis_pending_discharges() -> list[dict[str, str]]:
    """Reads the Nurse Portal 'Pending Discharge' list from the HMIS (read-only). Never raises."""
    if not HMIS_USER or not HMIS_PASS:
        log("[HMIS Pending] ELITE_USER/ELITE_PASS not set; skipping pending-discharge import.")
        return []
    try:
        tok = requests.post(
            f"{HMIS_BASE_URL}/Elite/api/Token",
            data={"grant_type": "password", "username": HMIS_USER, "password": HMIS_PASS},
            timeout=20,
        )
        tok.raise_for_status()
        tok_json = tok.json()
        res = requests.get(
            f"{HMIS_BASE_URL}/NursingModule/api/Inpatient/GetHospitalStructure_Nurse_Modified",
            params={
                "patientSearch": "",
                "roomSearch": "",
                "empGUID": tok_json.get("UID", ""),
                "MedicalEntity": HMIS_MEDICAL_ENTITY,
            },
            headers={"Authorization": f"Bearer {tok_json['access_token']}"},
            timeout=60,
        )
        res.raise_for_status()
        beds = res.json()
    except Exception as e:
        log(f"[HMIS Pending] Failed to fetch pending discharges (continuing without): {e}", level="warning")
        return []

    out: list[dict[str, str]] = []
    for b in beds if isinstance(beds, list) else []:
        if not isinstance(b, dict) or b.get("AdmissionStatus") != HMIS_PENDING_STATUS:
            continue
        out.append({
            "mrn": clean_mrn_str(b.get("PatientBarcode") or b.get("PatientID") or ""),
            # NOTE: the HMIS stores the Arabic name in "EnglishFullName" and the English one in "ArabicFullName".
            "name": str(b.get("EnglishFullName") or b.get("ArabicFullName") or "").strip(),
            "name_en": str(b.get("ArabicFullName") or "").strip(),
            "bed": str(b.get("BedName_EN") or "").strip(),
            # Portal label is "<bed> - <structure>", e.g. "Observation 1 - ER"; the ER part lives in the structure name.
            "structure": str(b.get("FloorStructureName_EN") or "").strip(),
        })
    log(f"[HMIS Pending] {len(out)} case(s) currently in Nurse Portal 'Pending Discharge'.")
    return out


# --- CLASSIFICATION HELPERS ---

def is_doctor_case_or_physician_payment(
    fin_status: str,
    contractor: str,
    payment_by: str,
    notes: str = "",
    name: str = "",
    physician: str = "",
    visit_type: str = ""
) -> bool:
    """
    Evaluates whether an admission should be excluded from patient debts.
    Business Rule:
    - When a patient is a DoctorCase AND contractor is Cash AND PaymentBy is Patient (or empty, i.e. not Physician),
      they MUST BE INCLUDED in Cash Debts (returns False).
    - When PaymentBy is Physician (or contractor/financial status is Physician), they are EXCLUDED (returns True).
    """
    f_low = (fin_status or "").lower().strip()
    m_low = (contractor or "").lower().strip()
    l_low = (payment_by or "").lower().strip()
    n_low = (notes or "").lower().strip()
    d_low = (name or "").lower().strip()
    phys_low = (physician or "").lower().strip()
    v_low = (visit_type or "").lower().strip()

    has_patient_payment = l_low in ("patient", "مريض", "cash", "نقدي", "نقدى", "self", "")
    has_cash_kw = any(kw in m_low or kw in f_low for kw in ("cash", "كاش", "نقدي", "نقدى"))
    is_cash_contractor = has_cash_kw or (
        m_low in ("", "elite", "بدون جهة", "بدون جهه", "عميل", "افراد", "أفراد", "self", "private", "personal")
        and not any(kw in f_low for kw in ("insured", "تأمين", "تامين", "تعاقد"))
    )

    physician_payment_kws = ("physician", "طبيب", "فيزيشن", "doctor", "دكتور", "other ex")
    if any(kw in l_low for kw in physician_payment_kws):
        return True

    if (
        m_low in ("طبيب", "physician", "doctor", "دكتور")
        or m_low.startswith(("د/", "د.", "dr.", "dr "))
        or f_low in ("طبيب", "physician", "doctor", "دكتور")
    ):
        return True

    if l_low and not has_patient_payment:
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
    combined = f" {v_low} {l_low} {f_low} {m_low} {n_low} "
    is_doctor_case = any(
        kw in v_low or kw in l_low or kw in f_low or kw in m_low or kw in n_low or kw in d_low
        for kw in dc_keywords
    ) or bool(RE_DC_KW.search(combined))

    if is_doctor_case:
        if is_cash_contractor and has_patient_payment:
            return False
        return True

    return False


GLOBAL_EXCLUSION_KWS: Final[tuple[str, ...]] = (
    "homecare", "home care",
    "wellbaby", "well baby",
    "endoscopy operation theatre", "operation room", "cath lab operation theatre",
    "day case", "daycase",
    "dialysis", "diyalsis room", "diyalsis"
)


def is_operating_room_bed(bed_str: str) -> bool:
    if not bed_str:
        return False
    b_low = bed_str.strip().lower()
    return (
        b_low in ("or", "o.r", "or1", "or2", "or3", "or4", "or5", "or6", "عمليات", "غرفة عمليات")
        or b_low.startswith(("or-", "or ", "or -"))
    )


def is_excluded_from_inpatient_census(
    bed: str,
    floor: str = "",
    contractor: str = "",
    financial_status: str = "",
    name: str = ""
) -> bool:
    """Matches server.ts KEYWORDS_TO_EXCLUDE + isOperatingRoom for 100% census & subsheet parity."""
    if is_operating_room_bed(bed):
        return True
    combined = f"{bed} {floor} {contractor} {financial_status} {name}".lower()
    return any(kw in combined for kw in GLOBAL_EXCLUSION_KWS)


def is_clinical_progress_note_str(s: str) -> bool:
    """Detects SBAR / clinical progress notes so they never pollute the Refined Companion Table."""
    if not s:
        return False
    low = s.strip().lower()
    if len(low) > 120:
        return True
    clinical_kws = (
        "sbar", "vital signs", "temp:", "bp:", "hr:", "rr:", "spo2",
        "gcs", "consciousness", "patient admitted", "assessment:"
    )
    return any(kw in low for kw in clinical_kws)


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

ORDERED_POWERBI_COLUMNS: Final[list[str]] = [
    "Admission Date",          # 0  -> 'No filters applied'
    "Bed#",                    # 1  -> 'Unnamed: 1'
    "MRN",                     # 2  -> 'Unnamed: 2'
    "Patient Name",            # 3  -> 'Unnamed: 3'
    "Mobile",                  # 4  -> 'Unnamed: 4'
    "FinancialStatus",         # 5  -> 'Unnamed: 5'
    "Age",                     # 6  -> 'Unnamed: 6'
    "Floor Name",              # 7  -> 'Unnamed: 7'
    "AllNotes",                # 8  -> 'Unnamed: 8'
    "VisitType",               # 9  -> 'Unnamed: 9'
    "Payment By",              # 10 -> 'Unnamed: 10'
    "FloorStructureName_EN",   # 11 -> 'Unnamed: 11'
    "Contractor Name",         # 12 -> 'Unnamed: 12'
    "DRG",                     # 13 -> 'Unnamed: 13'
    "Created By DIG",          # 14 -> 'Unnamed: 14'
    "DRG Diagnosis",           # 15 -> 'Unnamed: 15'
    "LOS",                     # 16 -> 'Unnamed: 16'
    "GLOS",                    # 17 -> 'Unnamed: 17'
    "Date Of Patients",        # 18 -> 'Unnamed: 18'
    "ALOS",                    # 19 -> 'Unnamed: 19'
    "ICD-10",                  # 20 -> 'Unnamed: 20'
    "Payments",                # 21 -> 'Unnamed: 21'
    "TreatingPhysicianName",    # 22 -> 'Unnamed: 22'
    "Specialty",               # 23 -> 'Unnamed: 23'
    "Weight",                  # 24 -> 'Unnamed: 24'
    "Invoice Total",           # 25 -> 'Unnamed: 25'
    "SSO",                     # 26 -> 'Unnamed: 26'
    "Difference",              # 27 -> 'Unnamed: 27'
    "LTC Weight",              # 28 -> 'Unnamed: 28'
    "LTC GLOS",                # 29 -> 'Unnamed: 29'
    "PrograssNotes",           # 30 -> 'Unnamed: 30'
    # NOTE: "Discharge Expected Date" (Legacy slot 31) is intentionally omitted from DirectQuery select
    # because the underlying SQL view column hangs indefinitely (>90s timeout). Slot 31 is preserved in legacy reconstruction.
    "HandOver Creation Date",  # 31 -> Legacy 'Unnamed: 32'
    "HandOver",                # 32 -> Legacy 'Unnamed: 33'
    "OR Notes",                # 33 -> Legacy 'Unnamed: 34'
    "Operations",              # 34 -> Legacy 'Unnamed: 35'
    "Elite ALOS",              # 35 -> Legacy 'Unnamed: 36'
    "Elite Weight",            # 36 -> Legacy 'Unnamed: 37'
    "Medication Names",        # 37 -> Legacy 'Unnamed: 38'
    "Intial Assessment",       # 38 -> Legacy 'Unnamed: 39'
    "VTE Summary"              # 39 -> Legacy 'Unnamed: 40'
]


def get_powerbi_model_info(auth: Optional[Any] = None) -> tuple[str, Optional[dict[str, Any]]]:
    """Dynamically retrieves the active report modelId and exploration metadata from modelsAndExploration."""
    fallback_id = "1874049876"
    try:
        report_base = POWERBI_EXPORT_URL.rsplit("/export/", 1)[0]
        meta_url = f"{report_base}/modelsAndExploration"
        resp = requests.get(meta_url, auth=auth, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            models = data.get("models", [])
            model_id = str(models[0]["id"]) if (models and "id" in models[0]) else fallback_id
            return model_id, data
    except Exception as e:
        log(f"Notice: Dynamic modelId discovery fallback to {fallback_id}: {e}", level="warning")
    return fallback_id, None


def get_powerbi_model_id(auth: Optional[Any] = None) -> str:
    """Dynamically retrieves the active report modelId from modelsAndExploration, falling back to 1874049876."""
    model_id, _ = get_powerbi_model_info(auth=auth)
    return model_id


def build_powerbi_payload(model_id: str = "1874049876", columns: Optional[list[str]] = None) -> dict[str, Any]:
    """Constructs the executeSemanticQueryRequest payload matching the active Power BI report schema."""
    active_cols = columns if columns is not None else ORDERED_POWERBI_COLUMNS
    select_objs = [
        {
            "Column": {
                "Expression": {"SourceRef": {"Source": "b"}},
                "Property": col
            },
            "Name": f"BedOccupancyMedicalDirector_soussi.{col}"
        }
        for col in active_cols
    ]
    export_cols = [
        {
            "QueryName": f"BedOccupancyMedicalDirector_soussi.{col}",
            "Name": col
        }
        for col in active_cols
    ]
    return {
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
                                        "Select": select_objs,
                                        "OrderBy": []
                                    },
                                    "Binding": {
                                        "Primary": {"Groupings": [{"Projections": list(range(len(active_cols))), "Subtotal": 0}]},
                                        "DataReduction": {"Primary": {"Top": {"Count": 1000000}}, "Secondary": {"Top": {"Count": 100}}},
                                        "Version": 1
                                    }
                                }
                            },
                            {
                                "ExportDataCommand": {
                                    "Columns": export_cols,
                                    "Ordering": list(range(len(active_cols))),
                                    "FiltersDescription": "No filters applied"
                                }
                            }
                        ]
                    }
                }
            ],
            "cancelQueries": [],
            "modelId": model_id,
            "userPreferredLocale": "en-US"
        }
    }


def build_fallback_visual_payload(model_id: str, exploration_data: Optional[dict[str, Any]]) -> Optional[dict[str, Any]]:
    """Extracts the largest tableEx visual prototypeQuery from modelsAndExploration as a resilient fallback."""
    if not exploration_data:
        return None
    try:
        best_selects: list[dict[str, Any]] = []
        best_from: list[dict[str, Any]] = []
        for sec in exploration_data.get("exploration", {}).get("sections", []):
            for vc in sec.get("visualContainers", []):
                cfg = json.loads(vc.get("config", "{}"))
                sv = cfg.get("singleVisual", {})
                if sv.get("visualType") == "tableEx":
                    pq = sv.get("prototypeQuery", {})
                    sels = pq.get("Select", [])
                    if len(sels) > len(best_selects):
                        best_selects = sels
                        best_from = pq.get("From", [{"Name": "b", "Entity": "BedOccupancyMedicalDirector_soussi", "Type": 0}])
        if len(best_selects) < 10:
            return None
        clean_selects = []
        export_cols = []
        for s_item in best_selects:
            q_name = s_item.get("Name", "")
            disp_name = s_item.get("NativeReferenceName") or (
                s_item.get("Column", {}).get("Property")
                or s_item.get("Aggregation", {}).get("Expression", {}).get("Column", {}).get("Property")
                or q_name.split(".")[-1]
            )
            s_copy = {k: v for k, v in s_item.items() if k != "NativeReferenceName"}
            clean_selects.append(s_copy)
            export_cols.append({"QueryName": q_name, "Name": disp_name})
        return {
            "exportDataType": 0,
            "executeSemanticQueryRequest": {
                "version": "1.0.0",
                "queries": [{
                    "Query": {
                        "Commands": [
                            {
                                "SemanticQueryDataShapeCommand": {
                                    "Query": {
                                        "Version": 2,
                                        "From": best_from,
                                        "Select": clean_selects,
                                        "OrderBy": []
                                    },
                                    "Binding": {
                                        "Primary": {"Groupings": [{"Projections": list(range(len(clean_selects))), "Subtotal": 0}]},
                                        "DataReduction": {"Primary": {"Top": {"Count": 1000000}}, "Secondary": {"Top": {"Count": 100}}},
                                        "Version": 1
                                    }
                                }
                            },
                            {
                                "ExportDataCommand": {
                                    "Columns": export_cols,
                                    "Ordering": list(range(len(clean_selects))),
                                    "FiltersDescription": "No filters applied"
                                }
                            }
                        ]
                    }
                }],
                "cancelQueries": [],
                "modelId": model_id,
                "userPreferredLocale": "en-US"
            }
        }
    except Exception:
        return None


POWERBI_PAYLOAD_DICT: Final[dict[str, Any]] = build_powerbi_payload("1874049876")

# Track last synced dataset hash & timestamp for same-day deduplication (P1 Egress Optimization)
_last_synced_df_hash: str = ""
_last_synced_cairo_date: str = ""
_last_synced_meta_updated_at: str = ""


def fetch_powerbi_and_sync(max_attempts: int = 4) -> bool:
    """Executes single-pass live synchronization between Power BI, Relational Postgres, and RTDB."""
    global _last_synced_df_hash, _last_synced_cairo_date, _last_synced_meta_updated_at
    attempt = 0
    while attempt < max_attempts:
        try:
            # FIX: Initialize current UTC timestamp at the start of every sync run to prevent UnboundLocalError
            now_dt = datetime.datetime.now(datetime.timezone.utc)
            now_iso = now_dt.isoformat()

            cairo_now = get_cairo_now()
            cairo_date_str = cairo_now.strftime("%Y-%m-%d")
            cairo_time_str = cairo_now.strftime("%d-%m-%Y %H:%M")
            is_1159_pm = (cairo_now.hour == 23 and cairo_now.minute >= 58)

            log("Fetching live dataset from Power BI...")
            auth = HttpNtlmAuth(POWERBI_USER, POWERBI_PASS) if POWERBI_USER else None
            active_model_id, exploration_data = get_powerbi_model_info(auth=auth)
            current_payload = build_powerbi_payload(active_model_id)
            try:
                response = requests.post(
                    POWERBI_EXPORT_URL,
                    json=current_payload,
                    auth=auth,
                    timeout=(10, min(35, POWERBI_TIMEOUT))
                )
                response.raise_for_status()
            except Exception as primary_err:
                fallback_payload = build_fallback_visual_payload(active_model_id, exploration_data)
                if fallback_payload:
                    log(f"Primary 40-col export failed ({primary_err}); falling back to live report visual query...", level="warning")
                    response = requests.post(
                        POWERBI_EXPORT_URL,
                        json=fallback_payload,
                        auth=auth,
                        timeout=(10, min(35, POWERBI_TIMEOUT))
                    )
                    response.raise_for_status()
                else:
                    raise

            df = pd.read_excel(io.BytesIO(response.content))
            if df.empty:
                log("Power BI returned empty dataset. Skipping cycle.", level="warning")
                return True

            is_30_col = len(df.columns) < 35

            # Dynamic column mapping: scan first 10 rows for >= 2 recognized occupancy header keywords
            # Ignore long narrative cells (>35 chars), multiline strings, or actual room values (e.g. "Bed 417")
            header_row_idx = 0
            for r_idx in range(min(10, len(df))):
                row_strs = [
                    str(x).lower().strip()
                    for x in df.iloc[r_idx].values
                    if pd.notna(x)
                    and 0 < len(str(x).strip()) <= 35
                    and "\n" not in str(x)
                    and not re.match(r"^(bed|room|غرفة|سرير)\s*\d+", str(x).strip(), re.IGNORECASE)
                ]
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
                    if not h_str or len(h_str) > 40 or "\n" in h_str:
                        continue
                    col_map[h_str] = col_key
                    col_map[h_str.lower()] = col_key
                    clean_h = re.sub(r'[^a-z0-9\u0600-\u06FF]', '', h_str.lower())
                    if clean_h:
                        col_map[clean_h] = col_key

            def get_val(row: dict[str, Any], possible_names: list[str]) -> Any:
                # Pass 1: Check if any named header in possible_names exists in col_map.
                # When the sheet has a header row (col_map is non-empty), only match named headers
                # so absent columns cleanly return "" instead of reading shifted "Unnamed: X" indices.
                for name in possible_names:
                    if name.lower().startswith("unnamed:"):
                        continue
                    key = col_map.get(name) or col_map.get(name.lower())
                    if not key:
                        clean_n = re.sub(r'[^a-z0-9\u0600-\u06FF]', '', name.lower())
                        key = col_map.get(clean_n)
                    if key is not None:
                        return row.get(key) if pd.notna(row.get(key)) else ""
                    if name in row:
                        return row.get(name) if pd.notna(row.get(name)) else ""
                if col_map:
                    return ""

                # Pass 2: Fallback to positional "Unnamed: X" keys only when no header row was found
                for name in possible_names:
                    if not name.lower().startswith("unnamed:"):
                        continue
                    if is_30_col and name not in ("Unnamed: 0", "Unnamed: 1"):
                        continue
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

            # Same-day content hash deduplication (P1 Egress Optimization):
            # If Power BI exported the exact same records on the same Cairo date, and no external dashboard edit
            # occurred in Supabase since our last commit, skip downloading ~550KB state and skip re-upserting.
            current_df_hash = hashlib.sha256(
                json.dumps([[str(clean_val(v)) for v in r.values()] for r in raw_records], ensure_ascii=False).encode("utf-8")
            ).hexdigest()
            is_forced_now = os.getenv("FORCE_SYNC_NOW", "").strip() == "1" or "--force" in sys.argv
            if (
                not is_forced_now
                and not is_1159_pm
                and current_df_hash == _last_synced_df_hash
                and cairo_date_str == _last_synced_cairo_date
            ):
                try:
                    session = get_supabase_session()
                    meta_chk = session.get(
                        f"{SUPABASE_REST_URL}?path=eq.state/metadata&select=updated_at",
                        timeout=10,
                        verify=SUPABASE_SSL_VERIFY,
                    )
                    if meta_chk.status_code == 200 and meta_chk.json():
                        db_meta_ts = str(meta_chk.json()[0].get("updated_at") or "")
                        if db_meta_ts and db_meta_ts == _last_synced_meta_updated_at:
                            log("[Sync Dedup] Power BI dataset unchanged since last sync; skipping redundant state download & upsert.")
                            return True
                except Exception:
                    pass

            # 1. Fetch pre-existing state and active manual discharges guard
            existing = fetch_existing_supabase_state(cairo_date_str)
            manual_names = existing.get("manually_discharged_names", [])
            manual_mrns = set(existing.get("manually_discharged_mrns", []))
            if manual_names or manual_mrns:
                log(f"[Sync Guard] Active manual discharges recognized: {len(manual_names)} names, {len(manual_mrns)} MRNs.")

            # 2. Unified Single-Pass Parsing & Domain Classification
            records: list[NormalizedPatientRecord] = []
            for row in raw_records:
                raw_bed = str(get_val(row, ["Bed#", "BedName_EN", "Bed", "Room", "Bed No", "الغرفة", "غرفة", "السرير", "سرير", "Unnamed: 1"])).strip()
                bed_str = clean_room_str(raw_bed)
                # Skip header row or empty beds
                if not bed_str or bed_str.lower() in ("bed#", "bed", "room", "الغرفة", "غرفة", "السرير", "سرير", "unnamed: 1") or "no filters" in bed_str.lower():
                    continue

                raw_mrn = str(get_val(row, ["MRN", "PatientBarcode", "Patient ID", "ID", "Patient MRN", "رقم المريض", "الملف", "رقم الملف"])).strip()
                # Guard against MRN matching full names or non-digits when column is absent or shifted
                if raw_mrn and (any("\u0600" <= ch <= "\u06FF" for ch in raw_mrn) or not any(ch.isdigit() for ch in raw_mrn)):
                    raw_mrn = ""
                clean_m = clean_mrn_str(raw_mrn) if raw_mrn else ""
                p_name = str(get_val(row, ["Patient Name", "Patient", "EnglishFullName", "Name", "المريض", "اسم المريض", "الاسم", "اسم الحالة", "Unnamed: 3"]) or "").strip()
                if (not p_name or p_name.isdigit() or is_clinical_progress_note_str(p_name)) and is_30_col and pd.notna(row.get("Unnamed: 2")):
                    p_name = str(row.get("Unnamed: 2")).strip()

                if not p_name or p_name.isdigit() or is_clinical_progress_note_str(p_name) or p_name.lower() in ("patient", "المريض", "name", "unknown", "englishfullname", "patient name"):
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

                mob_val = clean_phone(get_val(row, ["Mobile", "DefaultMobile", "Phone", "الجوال", "الهاتف", "Unnamed: 4"]))
                if not mob_val and not is_30_col:
                    m4 = clean_phone(row.get("Unnamed: 4"))
                    mob_val = m4 if len(m4) >= 7 else ""
                if len(mob_val) < 7:
                    mob_val = ""

                t_inv = float(clean_num(get_val(row, ["Invoice Total", "Sum of FTotal", "FTotal", "Total Invoice", "Total Amount", "Total", "إجمالي الفاتورة", "الاجمالي", "Unnamed: 25"])))
                r_deb = float(clean_num(get_val(row, ["Difference", "Remaining", "Sum of Difference", "Remaining Amount", "Balance", "المتبقي", "الباقي", "Unnamed: 27"])))

                # Deterministic surrogate MRN hashes normalized patient name ONLY (excluding bed) so transfers never alter ID
                det_seed = normalize_arabic_name(p_name) or normalize_room(bed_str) or "patient"
                det_hash = uuid.uuid5(uuid.NAMESPACE_OID, det_seed).hex[:8].upper()
                raw_los = str(get_val(row, ["LOS", "Sum(LOS)", "Unnamed: 16"])).strip()
                clean_los = re.sub(r"[^0-9.]", "", raw_los)
                if (not clean_los or float(clean_los) <= 0) and ad_val:
                    calc_los = calculate_los_from_admission(ad_val)
                    if float(calc_los) > 0:
                        clean_los = calc_los
                los_val = clean_los or raw_los or "0"

                raw_alos = str(get_val(row, ["Elite ALOS", "EliteALOS", "ALOS", "LOS AL", "Target ALOS", "Unnamed: 36"])).strip()

                raw_companion_notes = str(get_val(row, ["AllNotes", "Notes", "Remarks", "ملاحظات", "Unnamed: 8"])).strip()
                if is_clinical_progress_note_str(raw_companion_notes):
                    raw_companion_notes = ""

                raw_handover = str(get_val(row, ["HandOver", "Handover", "PrograssNotes", "Prograssnotes", "Medical Plan AH", "الخطة الطبية", "Unnamed: 33", "Unnamed: 30"])).strip()
                raw_visit_type = str(get_val(row, ["VisitType", "Visit", "VisitTypeGUID", "Visit Type", "نوع الزيارة", "Unnamed: 10"])).strip()

                rec = NormalizedPatientRecord(
                    mrn=clean_m or raw_mrn or f"UNKNOWN-{det_hash}",
                    clean_mrn=clean_m,
                    name=p_name,
                    bed=bed_str,
                    floor=str(get_val(row, ["Floor Name", "FloorName_EN", "FloorStructureName_EN", "Floor", "الطابق", "الدور", "Unnamed: 7"])).strip(),
                    physician=str(get_val(row, ["TreatingPhysicianName", "ConsultantName_EN", "Physician", "Doctor", "الطبيب", "الطبيب المعالج", "Unnamed: 22"])).strip(),
                    admission_date=str(ad_val) if ad_val else None,
                    contractor=str(get_val(row, ["Contractor Name", "ContractorName", "Contractor", "جهة التعاقد", "اسم الجهة", "الجهة والتعاقد", "الجهة", "الشركة", "جهة الدفع", "Unnamed: 12"])).strip(),
                    financial_status=str(get_val(row, ["FinancialStatus", "Financial Status", "Financial Class", "Class", "Type", "الفئة", "نوع", "Unnamed: 5"])).strip(),
                    total_invoice=t_inv,
                    remaining_debt=r_deb,
                    specialty=normalize_specialty(get_val(row, ["Specialty", "Speciality", "Medical Plan X", "التخصص", "Unnamed: 23"])),
                    diagnosis=str(get_val(row, ["ICD-10", "ICD-10 Diagnosis", "DRG Diagnosis", "Diagnosis", "Name", "التشخيص", "Unnamed: 20", "Unnamed: 15"])).strip(),
                    mobile=mob_val,
                    los=los_val,
                    alos=raw_alos or "0",
                    expected_discharge=clean_expected_discharge_date(get_val(row, ["Discharge Expected Date", "DischargeExpectedDate", "Expected Discharge", "Unnamed: 31"])),
                    medications=str(get_val(row, ["Medication Names", "Medications", "Medication", "الأدوية", "Unnamed: 38"])).strip(),
                    initial_assessment=str(get_val(row, ["Intial Assessment", "IntialAssessment", "Initial Assessment", "التقييم الأولي", "Unnamed: 39"])).strip(),
                    vte_summary=str(get_val(row, ["VTE Summary", "VTE", "جلطات", "Unnamed: 40"])).strip(),
                    notes=raw_companion_notes,
                    handover=raw_handover,
                    visit_type=raw_visit_type,
                    payment_by=str(get_val(row, ["Payment By", "PaymentBy", "طريقة الدفع", "الدفع بواسطة", "الدفع", "Unnamed: 11"])).strip(),
                    raw_row=row
                )
                records.append(rec)

            # 2b. Add HMIS Nurse Portal "Pending Discharge" cases to the cumulative discharged list
            if HMIS_PENDING_ENABLED:
                pending_cases = fetch_hmis_pending_discharges()
                already_disc = existing.get("discharged", [])
                new_count = 0
                for pc in pending_cases:
                    label = f"{pc['name'] or pc['name_en']} (MRN {pc['mrn']}, {pc['bed']})"
                    if is_dialysis_room(pc["bed"]):
                        log(f"[HMIS Pending] Skipped dialysis case: {label}")
                        continue
                    if RE_ER_ROOM.search(f"{pc['bed']} - {pc.get('structure', '')}"):
                        log(f"[HMIS Pending] Skipped ER case: {label}")
                        continue
                    if is_patient_manually_discharged(pc["name"], pc["mrn"], manual_names, manual_mrns):
                        log(f"[HMIS Pending] Already discharged, skipping: {label}")
                        continue
                    match_rec = next((r for r in records if pc["mrn"] and r.clean_mrn == pc["mrn"]), None)
                    p_name = (match_rec.name if match_rec else pc["name"]) or pc["name_en"]
                    if any(
                        isinstance(dp, dict) and (
                            (pc["mrn"] and clean_mrn_str(dp.get("mrn") or "") == pc["mrn"])
                            or is_name_match(dp.get("name"), p_name)
                        )
                        for dp in already_disc
                    ):
                        log(f"[HMIS Pending] Already in cumulative discharged, skipping: {label}")
                        continue
                    new_count += 1
                    if HMIS_PENDING_DRY_RUN:
                        log(f"[HMIS Pending][DRY-RUN] Would add to cumulative discharged: {label}")
                        continue
                    already_disc.append({
                        "room": clean_room_str(match_rec.bed if match_rec else pc["bed"]),
                        "mrn": (match_rec.clean_mrn if match_rec else pc["mrn"]) or pc["mrn"],
                        "name": p_name,
                        "physician": match_rec.physician if match_rec else "",
                        "contractor": match_rec.contractor if match_rec else "",
                        "date": (match_rec.admission_date if match_rec else "") or "",
                        "dischargeDate": cairo_time_str,
                        "dischargeType": "manual",
                        "source": "hmis_pending_discharge",
                        "rawRow": None,
                    })
                    manual_names.append(p_name)
                    if pc["mrn"]:
                        manual_mrns.add(pc["mrn"])
                    log(f"[HMIS Pending] Added to cumulative discharged: {label}")
                if new_count:
                    log(f"[HMIS Pending] {new_count} new case(s) {'detected (dry-run, nothing written)' if HMIS_PENDING_DRY_RUN else 'added'}.")

            # 3. Partition Data Streams (Admissions, Debts, Dialysis, Entries, Medical Plans, Companion, LOS)
            rpc_payload: list[dict[str, Any]] = []
            active_records: list[NormalizedPatientRecord] = []
            deduplicated_patient_map: dict[str, NormalizedPatientRecord] = {}
            cash_debts: list[dict[str, Any]] = []
            insured_debts: list[dict[str, Any]] = []
            dialysis_cases: list[dict[str, Any]] = []
            today_entries: list[dict[str, Any]] = []
            medical_plans_list: list[dict[str, Any]] = []
            companion_status_list: list[dict[str, Any]] = []
            los_data_list: list[dict[str, Any]] = []

            for rec in records:
                # Guard against manually discharged patients
                if is_patient_manually_discharged(rec.name, rec.clean_mrn, manual_names, manual_mrns):
                    continue

                active_records.append(rec)

                # Deduplicate patients preferring inpatient rooms over procedure rooms (matches server.ts extractRawPatientsFromRows)
                p_key = f"mrn:{rec.clean_mrn}" if rec.clean_mrn else f"name:{normalize_arabic_name(rec.name)}"
                if p_key in deduplicated_patient_map:
                    ex_rec = deduplicated_patient_map[p_key]
                    if is_procedure_or_temporary_room(ex_rec.bed) and not is_procedure_or_temporary_room(rec.bed):
                        deduplicated_patient_map[p_key] = rec
                else:
                    deduplicated_patient_map[p_key] = rec

                b_low = rec.bed.lower()
                is_or_room = is_operating_room_bed(rec.bed)
                is_proc_room = is_procedure_or_temporary_room(rec.bed)
                is_excluded_census = is_excluded_from_inpatient_census(rec.bed, rec.floor, rec.contractor, rec.financial_status, rec.name)

                # A. Relational RPC Payload (active inpatient rooms only, matching server.ts syncOccupancyToRelationalSchema)
                if not is_or_room and not is_proc_room and not is_excluded_census:
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

                # B. Debts, Companion, Medical Plans & LOS Classification (Matching server.ts extractSubsheetsFromHospitalData)
                is_nicu = "nicu" in b_low or "حضانه" in b_low or "حضانة" in b_low
                is_er = bool(RE_ER_ROOM.search(rec.bed)) or b_low.startswith("er") or "طوارئ" in b_low

                if not is_or_room and not is_proc_room and not is_excluded_census:
                    f_low = rec.financial_status.lower()
                    m_low = rec.contractor.lower()

                    has_cash = any(kw in txt for txt in (m_low, f_low) for kw in ("cash", "كاش", "نقدي", "نقدى"))
                    if has_cash:
                        is_cash = True
                    elif m_low in ("", "elite", "بدون جهة", "بدون جهه", "عميل", "افراد", "أفراد", "self", "private", "personal"):
                        is_cash = not any(kw in f_low for kw in ("insured", "تأمين", "تامين", "تعاقد"))
                    else:
                        is_cash = False

                    # 1. Debts (Cash & Insured) - Exclude NICU & ER and apply DoctorCase + Cash + PaymentBy=Patient rule
                    if not is_nicu and not is_er:
                        is_doc_excluded = is_doctor_case_or_physician_payment(
                            rec.financial_status,
                            rec.contractor,
                            rec.payment_by,
                            rec.notes,
                            rec.name,
                            rec.physician,
                            rec.visit_type
                        )
                        if not is_doc_excluded:
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
                                "visitType": rec.visit_type,
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
                            if is_cash:
                                if rec.remaining_debt != 0 or rec.total_invoice > 0:
                                    cash_debts.append(debt_item)
                            elif rec.remaining_debt > 0 or rec.total_invoice > 0:
                                insured_debts.append(debt_item)

                    # 2. Refined Companion Table (exclude NICU & ER, include all inpatient beds with colA..colW + descriptive keys)
                    if not is_nicu and not is_er:
                        safe_comp_note = "" if (not rec.notes or rec.notes in ("-", "0", "nan", "None") or is_clinical_progress_note_str(rec.notes)) else rec.notes
                        companion_status_list.append({
                            "colA": rec.admission_date or "",
                            "colB": rec.bed,
                            "colD": rec.name,
                            "colI": safe_comp_note,
                            "colM": rec.contractor,
                            "colW": rec.physician,
                            "room": rec.bed,
                            "mrn": rec.mrn,
                            "patientName": rec.name,
                            "financialStatus": rec.financial_status,
                            "contractor": rec.contractor,
                            "companionsCount": "1" if safe_comp_note else "0",
                            "notes": safe_comp_note
                        })

                    # 3. Medical Plans & Expected Discharge (exclude ER, include colA..colX + descriptive keys)
                    if not is_er:
                        raw_progress = str(get_val(rec.raw_row, ["PrograssNotes", "Prograssnotes", "Unnamed: 34", "Unnamed: 21"])).strip()
                        sbar_text = rec.handover or raw_progress or "خطة علاجية تحت المتابعة السريرية"
                        creation_dt = clean_expected_discharge_date(get_val(rec.raw_row, ["HandOver Creation Date", "PrograssNotes Creation Date", "Creation Date", "Unnamed: 32", "Unnamed: 19"]))
                        medical_plans_list.append({
                            "colA": rec.admission_date or "",
                            "colB": rec.bed,
                            "mrn": rec.mrn,
                            "colD": rec.name,
                            "colM": rec.contractor,
                            "colW": rec.physician,
                            "colAG": creation_dt or rec.admission_date or "-",
                            "colAH": sbar_text,
                            "colAI": raw_progress,
                            "planText": sbar_text,
                            "notes": raw_progress,
                            "colX": rec.specialty,
                            "admissionDate": rec.admission_date or "",
                            "room": rec.bed,
                            "patientName": rec.name,
                            "age": str(get_val(rec.raw_row, ["Age", "PatientAgeDBComputed", "Unnamed: 6"])).strip(),
                            "diagnosis": rec.diagnosis,
                            "physician": rec.physician,
                            "specialty": rec.specialty,
                            "creationDate": creation_dt,
                            "handOver": rec.handover,
                            "expectedDischargeDate": rec.expected_discharge,
                            "medications": rec.medications,
                            "initialAssessment": rec.initial_assessment,
                            "vteSummary": rec.vte_summary,
                            "orNotes": str(get_val(rec.raw_row, ["OR Notes", "Unnamed: 35", "Unnamed: 23"])).strip(),
                            "contractor": rec.contractor,
                            "paymentType": "Cash" if is_cash else "Insured"
                        })

                    # 4. Length of Stay (LOS) (exclude ER, include colA..colAL + relational DB keys)
                    if not is_er:
                        try:
                            los_num = float(rec.los) if rec.los else 0.0
                        except ValueError:
                            los_num = 0.0
                        try:
                            alos_num = float(rec.alos) if rec.alos else 0.0
                        except ValueError:
                            alos_num = 0.0
                        if los_num > 0 or alos_num > 0 or rec.admission_date:
                            los_data_list.append({
                                "colA": rec.admission_date or "",
                                "colB": rec.bed,
                                "colC": rec.mrn,
                                "colD": rec.name,
                                "colM": rec.contractor,
                                "colO": rec.diagnosis,
                                "colS": str(los_num),
                                "colU": rec.expected_discharge,
                                "colW": rec.physician,
                                "colX": rec.specialty,
                                "colAL": str(alos_num),
                                "date": rec.admission_date or "",
                                "room": rec.bed,
                                "mrn": rec.mrn,
                                "name": rec.name,
                                "patientName": rec.name,
                                "admissionDate": rec.admission_date or "",
                                "contractor": rec.contractor,
                                "diagnosis": rec.diagnosis,
                                "los": los_num,
                                "alos": alos_num,
                                "physician": rec.physician,
                                "specialty": rec.specialty,
                                "expectedDischarge": rec.expected_discharge,
                                "variance": round(los_num - alos_num, 2) if alos_num > 0 else 0
                            })

                # C. Dialysis Classification
                if not is_or_room and "323" not in b_low:
                    fl_low = rec.floor.lower()
                    spec_low = rec.specialty.lower()
                    fin_low = rec.financial_status.lower()
                    vis_low = rec.visit_type.lower()
                    is_inpatient = bool(RE_INPATIENT_ROOM.search(b_low)) or "suite" in b_low or "سويت" in b_low or "icu" in b_low or "ccu" in b_low

                    is_dial_case = False
                    if is_dialysis_room(rec.bed):
                        is_dial_case = True
                    elif not is_inpatient:
                        if any(kw in fl_low for kw in ("dialysis", "diyalsis", "hemodialysis", "haemodialysis", "غسيل كلوي", "غسيل كلى", "استصفاء", "ديلزة", "وحدة الغسيل", "قسم الغسيل")):
                            is_dial_case = True
                        elif any(kw in spec_low for kw in ("dialysis", "غسيل", "nephrology", "كلى", "أمراض كلى")) and any(kw in b_low or kw in fl_low for kw in ("dc", "daycase", "day case", "chair", "station")):
                            is_dial_case = True
                        elif any(kw in vis_low or kw in fin_low for kw in ("dialysis", "hemodialysis", "غسيل", "جلسة غسيل", "جلسات غسيل", "جلسه غسيل", "dialysis session")) and any(kw in b_low or kw in fl_low for kw in ("dc", "daycase", "chair", "station", "dial")):
                            is_dial_case = True

                    if is_dial_case:
                        # Strictly only grab dialysis cases if the date is today
                        if rec.admission_date and is_date_today_cairo(rec.admission_date, cairo_date_str):
                            dialysis_cases.append({
                                "room": rec.bed if rec.bed else "Dialysis",
                                "name": rec.name,
                                "physician": rec.physician,
                                "contractor": rec.contractor,
                                "date": rec.admission_date,
                                "mrn": rec.mrn,
                                "mobile": rec.mobile,
                                "floor": rec.floor,
                                "diagnosis": rec.diagnosis,
                                "specialty": rec.specialty
                            })

            # D. Deduplicated Inpatient Census & Today Entries (100% Parity with Dashboard filterPatientData & newRows)
            deduplicated_records = list(deduplicated_patient_map.values())
            inpatient_census_records = [
                r for r in deduplicated_records
                if not is_operating_room_bed(r.bed)
                and not is_excluded_from_inpatient_census(r.bed, r.floor, r.contractor, r.financial_status, r.name)
            ]

            # Count unique occupied beds using the exact same room/Zone C (330/331) deduplication as src/logic/occupancy.ts
            seen_census_beds: set[str] = set()
            for r in inpatient_census_records:
                b_up = r.bed.upper().strip()
                m_zc = re.match(r"^(330|331)\s*[-/]?\s*[AB]$", b_up, re.IGNORECASE)
                bed_key = m_zc.group(1) if m_zc else b_up
                seen_census_beds.add(bed_key)
            occupied_beds_count = len(seen_census_beds)

            for rec in inpatient_census_records:
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

            # Cumulative entries resolution (with self-healing guard against any previously polluted SBAR/numeric names)
            cumulative_entries = [
                p for p in (existing.get("entries") or [])
                if is_date_today_cairo(p.get("date") or p.get("rawDate"), cairo_date_str)
                and str(p.get("name", "")).strip()
                and not str(p.get("name", "")).strip().isdigit()
                and not is_clinical_progress_note_str(str(p.get("name", "")).strip())
            ]
            for p in today_entries:
                p_name = p.get("name", "").strip()
                p_mrn = clean_mrn_str(p.get("mrn", ""))
                if not any(
                    is_name_match(ex.get("name"), p_name)
                    or (p_mrn and not p_mrn.startswith("UNKNOWN-") and clean_mrn_str(ex.get("mrn")) == p_mrn)
                    for ex in cumulative_entries
                ):
                    cumulative_entries.append(p)

            # 4. Extract Previous Active Patients from occupancy_current for Auto-Discharges & Transfer Detection
            prev_rooms: dict[str, dict[str, Any]] = {}
            for r in (existing.get("occupancy_current") or []):
                b, m, n = "", "", ""
                physician, contractor, adm_date = "", "", ""
                if isinstance(r, dict):
                    adm_date = clean_date(r.get("No filters applied") or r.get("Unnamed: 0")) or ""
                    b = clean_room_str(r.get("Unnamed: 1") or "")
                    cell2 = str(r.get("Unnamed: 2") or "").strip()
                    cell3 = str(r.get("Unnamed: 3") or "").strip()
                    if any("\u0600" <= ch <= "\u06FF" for ch in cell2) or (cell3.isdigit() and not cell2.isdigit()):
                        n, m = cell2, ""
                    else:
                        m, n = clean_mrn_str(cell2), cell3
                    physician = str(r.get("Unnamed: 22") or r.get("Unnamed: 14") or "").strip()
                    contractor = str(r.get("Unnamed: 12") or r.get("Unnamed: 6") or "").strip()
                elif isinstance(r, (list, tuple)) and len(r) >= 4:
                    adm_date = clean_date(r[0]) or ""
                    b = clean_room_str(r[1] or "")
                    cell2 = str(r[2] or "").strip()
                    cell3 = str(r[3] or "").strip()
                    if len(r) < 35 or any("\u0600" <= ch <= "\u06FF" for ch in cell2):
                        n, m = cell2, ""
                        physician = str(r[14] if len(r) > 14 else "") or ""
                        contractor = str(r[6] if len(r) > 6 else "") or ""
                    else:
                        m, n = clean_mrn_str(cell2), cell3
                        physician = str(r[22] if len(r) > 22 else "") or ""
                        contractor = str(r[12] if len(r) > 12 else "") or ""

                if m and (m.startswith("UNKNOWN-") or not any(ch.isdigit() for ch in m)):
                    m = ""
                if (
                    b and n
                    and not n.isdigit()
                    and b.lower() not in ("bed", "bed#", "room", "الغرفة", "غرفة", "unnamed: 1")
                    and n.lower() not in ("patient", "patient name", "المريض", "name")
                ):
                    norm_n = normalize_arabic_name(n)
                    key = f"mrn:{m}" if m else f"name:{norm_n}"
                    is_proc_b = is_procedure_or_temporary_room(b)
                    if key in prev_rooms:
                        if is_procedure_or_temporary_room(prev_rooms[key]["room"]) and not is_proc_b:
                            prev_rooms[key] = {
                                "room": b, "mrn": m, "name": n,
                                "physician": physician, "contractor": contractor, "date": adm_date
                            }
                    else:
                        prev_rooms[key] = {
                            "room": b, "mrn": m, "name": n,
                            "physician": physician, "contractor": contractor, "date": adm_date
                        }

            # 4a. Auto-Discharge Detection & Cleanup (100% Parity with server.ts handleUnifiedUpload)
            discharged_list: list[dict[str, Any]] = list(existing.get("discharged") or [])
            if deduplicated_records:
                # Remove auto-discharged patients who are still present in the current sheet (never drop manual discharges)
                discharged_list = [
                    dp for dp in discharged_list
                    if (dp.get("dischargeType") == "manual" or is_patient_manually_discharged(dp.get("name", ""), dp.get("mrn", ""), manual_names, manual_mrns))
                    or not any(
                        (clean_mrn_str(dp.get("mrn")) and r.clean_mrn and clean_mrn_str(dp.get("mrn")) == r.clean_mrn)
                        or is_name_match(dp.get("name"), r.name)
                        for r in deduplicated_records
                    )
                ]
                # Identify newly discharged patients (in prev_rooms inpatient bed, but no longer in deduplicated_records)
                if not existing.get("is_new_day") and not existing.get("is_system_reset"):
                    for pv in prev_rooms.values():
                        prev_r = pv["room"]
                        if is_procedure_or_temporary_room(prev_r) or is_excluded_from_inpatient_census(prev_r, "", pv.get("contractor", ""), "", pv.get("name", "")):
                            continue
                        still_present = any(
                            (pv.get("mrn") and r.clean_mrn and pv["mrn"] == r.clean_mrn)
                            or is_name_match(pv.get("name"), r.name)
                            for r in deduplicated_records
                        )
                        if not still_present:
                            already_in_disc = any(
                                (pv.get("mrn") and clean_mrn_str(dp.get("mrn")) == pv["mrn"])
                                or is_name_match(dp.get("name"), pv.get("name"))
                                for dp in discharged_list
                            )
                            if not already_in_disc:
                                is_man = is_patient_manually_discharged(pv.get("name", ""), pv.get("mrn", ""), manual_names, manual_mrns)
                                discharged_list.append({
                                    "room": prev_r,
                                    "mrn": pv.get("mrn") or "",
                                    "name": pv.get("name") or "",
                                    "physician": pv.get("physician") or "",
                                    "contractor": pv.get("contractor") or "",
                                    "date": pv.get("date") or "",
                                    "dischargeDate": cairo_time_str,
                                    "dischargeType": "manual" if is_man else "auto",
                                })

            # 4b. Dialysis & Transfers with 11:59 PM Cairo Rollover
            updated_registry: dict[str, Any] = dict(existing.get("registry") or {})
            if is_1159_pm or existing.get("is_system_reset"):
                log(f"[Sync Rollover] Fresh daily counters active for {cairo_date_str}. Zeroing daily dialysis & transfers.")
                cumulative_dialysis: list[dict[str, Any]] = []
                cumulative_transfers: list[dict[str, Any]] = []
            else:
                cumulative_dialysis = [
                    p for p in (existing.get("dialysis") or [])
                    if "323" not in str(p.get("room", "")) and is_date_today_cairo(p.get("date") or p.get("rawDate"), cairo_date_str)
                ]
                for p in dialysis_cases:
                    p_name = p.get("name", "").strip()
                    if p_name and not any(is_name_match(ex.get("name"), p_name) for ex in cumulative_dialysis if ex.get("name")):
                        cumulative_dialysis.append(p)

                # Merge prev_rooms into updated_registry if not already tracked
                for pk, pv in prev_rooms.items():
                    if not is_procedure_or_temporary_room(pv["room"]) and not is_excluded_from_inpatient_census(pv["room"]):
                        found_reg_key = None
                        for rk, rv in updated_registry.items():
                            if not isinstance(rv, dict):
                                continue
                            rv_mrn = clean_mrn_str(rv.get("mrn"))
                            if pv.get("mrn") and rv_mrn and not rv_mrn.startswith("UNKNOWN-") and pv["mrn"] == rv_mrn:
                                found_reg_key = rk
                                break
                            if is_name_match(rv.get("name") or rk, pv.get("name")):
                                found_reg_key = rk
                                break
                        if not found_reg_key:
                            reg_k = f"mrn:{pv['mrn']}" if pv.get("mrn") else pv["name"]
                            updated_registry[reg_k] = {
                                "name": pv["name"],
                                "mrn": pv.get("mrn") or "",
                                "lastRoom": pv["room"],
                                "physician": pv.get("physician") or "",
                                "contractor": pv.get("contractor") or "",
                                "date": pv.get("date") or ""
                            }

                cumulative_transfers = list(existing.get("transfers") or [])
                for rec in deduplicated_records:
                    norm_rec_name = normalize_arabic_name(rec.name)
                    key = f"mrn:{rec.clean_mrn}" if rec.clean_mrn else f"name:{norm_rec_name}"
                    matched_prev = prev_rooms.get(key)
                    if not matched_prev and norm_rec_name:
                        for pk, pv in prev_rooms.items():
                            pv_mrn = pv.get("mrn") or ""
                            if rec.clean_mrn and pv_mrn and rec.clean_mrn != pv_mrn:
                                continue
                            if is_name_match(pv.get("name"), rec.name):
                                matched_prev = pv
                                break

                    # Also check updated_registry if not found in prev_rooms
                    matched_reg_key: Optional[str] = None
                    for rk, rv in updated_registry.items():
                        if not isinstance(rv, dict):
                            continue
                        rv_mrn = clean_mrn_str(rv.get("mrn"))
                        if rec.clean_mrn and rv_mrn and not rv_mrn.startswith("UNKNOWN-"):
                            if rec.clean_mrn == rv_mrn:
                                matched_reg_key = rk
                                break
                            continue
                        if is_name_match(rv.get("name") or rk, rec.name):
                            matched_reg_key = rk
                            break

                    if not matched_prev and matched_reg_key:
                        rv = updated_registry[matched_reg_key]
                        matched_prev = {
                            "room": clean_room_str(rv.get("lastRoom") or ""),
                            "mrn": clean_mrn_str(rv.get("mrn") or ""),
                            "name": rv.get("name") or rec.name,
                            "physician": rv.get("physician") or "",
                            "contractor": rv.get("contractor") or "",
                        }

                    curr_r = clean_room_str(rec.bed)
                    norm_curr = normalize_room(curr_r)
                    is_curr_proc = is_procedure_or_temporary_room(curr_r) or is_excluded_from_inpatient_census(curr_r)

                    if matched_prev:
                        prev = matched_prev
                        prev_r = clean_room_str(prev["room"])
                        norm_prev = normalize_room(prev_r)
                        is_prev_proc = is_procedure_or_temporary_room(prev_r) or is_excluded_from_inpatient_census(prev_r)
                        if (
                            norm_prev and norm_curr
                            and norm_prev != norm_curr
                            and not is_prev_proc
                            and not is_curr_proc
                        ):
                            # Locate existing transfer journey record
                            existing_rec: Optional[dict[str, Any]] = None
                            for t in cumulative_transfers:
                                t_mrn = clean_mrn_str(t.get("mrn", ""))
                                if t_mrn.startswith("UNKNOWN-"):
                                    t_mrn = ""
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
                                if normalize_room(last_room) != norm_curr and normalize_room(existing_rec.get("currentRoom", "")) != norm_curr:
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

                    # Update patientRoomRegistry with current inpatient room
                    if not is_curr_proc:
                        reg_target_key = matched_reg_key or (f"mrn:{rec.clean_mrn}" if rec.clean_mrn else rec.name)
                        updated_registry[reg_target_key] = {
                            "name": rec.name,
                            "mrn": rec.clean_mrn or rec.mrn,
                            "lastRoom": curr_r,
                            "physician": rec.physician,
                            "contractor": rec.contractor,
                            "date": rec.admission_date or cairo_time_str
                        }

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
                "Unnamed: 9": "VisitType",
                "Unnamed: 10": "PaymentBy",
                "Unnamed: 11": "FloorStructureName_EN",
                "Unnamed: 12": "ContractorName",
                "Unnamed: 13": "DRG",
                "Unnamed: 14": "Created By DIG",
                "Unnamed: 15": "DRG Diagnosis",
                "Unnamed: 16": "LOS",
                "Unnamed: 17": "GLOS",
                "Unnamed: 18": "Date Of Patients",
                "Unnamed: 19": "ALOS",
                "Unnamed: 20": "ICD-10",
                "Unnamed: 21": "Payments",
                "Unnamed: 22": "TreatingPhysicianName",
                "Unnamed: 23": "Speciality",
                "Unnamed: 24": "Weight",
                "Unnamed: 25": "Total Invoice",
                "Unnamed: 26": "SSO",
                "Unnamed: 27": "Remaining Amount",
                "Unnamed: 28": "LTC Weight",
                "Unnamed: 29": "LTC GLOS",
                "Unnamed: 30": "PrograssNotes",
                "Unnamed: 31": "Discharge Expected Date",
                "Unnamed: 32": "HandOver Creation Date",
                "Unnamed: 33": "HandOver",
                "Unnamed: 34": "OR Notes",
                "Unnamed: 35": "Operations",
                "Unnamed: 36": "Elite ALOS",
                "Unnamed: 37": "Elite Weight",
                "Unnamed: 38": "Medication Names",
                "Unnamed: 39": "Intial Assessment",
                "Unnamed: 40": "VTE Summary"
            }
            legacy_occupancy_rows: list[dict[str, Any]] = [fake_header]

            known_mappings = {
                0: ["Admission Date", "AdmissionDate", "Date", "تاريخ الدخول", "التاريخ", "No filters applied", "Unnamed: 0"],
                1: ["Bed#", "BedName_EN", "Bed", "Room", "Bed No", "الغرفة", "غرفة", "السرير", "سرير", "Unnamed: 1"],
                2: ["MRN", "PatientBarcode", "Patient ID", "ID", "Patient MRN", "رقم المريض", "الملف", "رقم الملف", "Unnamed: 2"],
                3: ["Patient Name", "Patient", "EnglishFullName", "Name", "المريض", "اسم المريض", "الاسم", "اسم الحالة", "Unnamed: 3"],
                4: ["Mobile", "DefaultMobile", "Phone", "الجوال", "الهاتف", "Unnamed: 4"],
                5: ["FinancialStatus", "Financial Status", "Financial Class", "Class", "Type", "الفئة", "نوع", "Unnamed: 5"],
                6: ["Age", "PatientAgeDBComputed", "Unnamed: 6"],
                7: ["Floor Name", "FloorName_EN", "Floor", "الطابق", "الدور", "Unnamed: 7"],
                8: ["AllNotes", "Notes", "Remarks", "ملاحظات", "Unnamed: 8"],
                9: ["VisitType", "Visit", "VisitTypeGUID", "Visit Type", "نوع الزيارة", "Companions #", "Unnamed: 9"],
                10: ["Payment By", "PaymentBy", "طريقة الدفع", "الدفع بواسطة", "الدفع", "Unnamed: 10"],
                11: ["FloorStructureName_EN", "Unnamed: 11"],
                12: ["Contractor Name", "ContractorName", "Contractor", "جهة التعاقد", "اسم الجهة", "الجهة والتعاقد", "الجهة", "الشركة", "جهة الدفع", "Unnamed: 12"],
                13: ["DRG", "Unnamed: 13"],
                14: ["Created By DIG", "Created by DIG", "Unnamed: 14"],
                15: ["DRG Diagnosis", "Unnamed: 15"],
                16: ["LOS", "Sum(LOS)", "Unnamed: 16"],
                17: ["GLOS", "GeometricMeanLOS", "Unnamed: 17"],
                18: ["Date Of Patients", "Unnamed: 18"],
                19: ["ALOS", "Unnamed: 19"],
                20: ["ICD-10", "ICD-10 Diagnosis", "Diagnosis", "Name", "التشخيص", "Unnamed: 20"],
                21: ["Payments", "Sum of Payments", "Unnamed: 21"],
                22: ["TreatingPhysicianName", "ConsultantName_EN", "Physician", "Doctor", "الطبيب", "الطبيب المعالج", "Unnamed: 22"],
                23: ["Specialty", "Speciality", "Medical Plan X", "التخصص", "Unnamed: 23"],
                24: ["Weight", "Transfer History", "Unnamed: 24"],
                25: ["Invoice Total", "Sum of FTotal", "FTotal", "Total Invoice", "Total Amount", "Total", "إجمالي الفاتورة", "الاجمالي", "Unnamed: 25"],
                26: ["SSO", "Unnamed: 26"],
                27: ["Difference", "Remaining", "Sum of Difference", "Remaining Amount", "Balance", "المتبقي", "الباقي", "Unnamed: 27"],
                28: ["LTC Weight", "Unnamed: 28"],
                29: ["LTC GLOS", "Unnamed: 29"],
                30: ["PrograssNotes", "Prograssnotes", "Unnamed: 30"],
                31: ["Discharge Expected Date", "DischargeExpectedDate", "Expected Discharge", "Unnamed: 31"],
                32: ["HandOver Creation Date", "PrograssNotes Creation Date", "Creation Date", "Medical Plan AG", "تاريخ الخطة", "Unnamed: 32"],
                33: ["HandOver", "Handover", "PrograssNotes", "Medical Plan AH", "الخطة الطبية", "Unnamed: 33"],
                34: ["OR Notes", "PrograssNotes", "Prograssnotes", "Hand Over", "Notes", "Medical Plan AI", "Unnamed: 34"],
                35: ["Operations", "Unnamed: 35"],
                36: ["Elite ALOS", "EliteALOS", "ALOS", "Target ALOS", "Unnamed: 36"],
                37: ["Elite Weight", "EliteWeight", "Weight", "Unnamed: 37"],
                38: ["Medication Names", "Unnamed: 38"],
                39: ["Intial Assessment", "IntialAssessment", "Initial Assessment", "التقييم الأولي", "Unnamed: 39"],
                40: ["VTE Summary", "VTE", "جلطات", "Unnamed: 40"]
            }

            total_cols = max(41, len(header_row))
            for rec in active_records:
                legacy_row: dict[str, Any] = {}
                for i in range(total_cols):
                    col_key = "No filters applied" if i == 0 else f"Unnamed: {i}"
                    if i in known_mappings:
                        val = clean_val(get_val(rec.raw_row, known_mappings[i]))
                        if i == 0 and rec.admission_date:
                            val = rec.admission_date
                        elif i == 1 and rec.bed:
                            val = rec.bed
                        elif i == 2:
                            # MRN guard: If extracted val is a patient name (multi-word letters), use rec.clean_mrn or rec.mrn
                            if not val or (len(str(val).split()) >= 2 and not any(ch.isdigit() for ch in str(val))):
                                val = rec.clean_mrn or rec.mrn
                        elif i == 3 and rec.name:
                            val = rec.name
                        elif i == 8:
                            val = rec.notes
                        elif i == 9 and rec.visit_type:
                            val = rec.visit_type
                        elif i == 10 and rec.payment_by:
                            val = rec.payment_by
                        elif i == 12 and rec.contractor:
                            val = rec.contractor
                        elif i == 16:
                            # LOS guard: Ensure non-empty numeric value
                            if (val is None or str(val).strip() in ("", "nan", "None")) and rec.los:
                                val = rec.los
                        elif i == 22 and rec.physician:
                            val = rec.physician
                        elif i == 23 and rec.specialty:
                            val = rec.specialty
                        elif i == 25:
                            val = f"{rec.total_invoice:.2f}"
                        elif i == 27:
                            val = f"{rec.remaining_debt:.2f}"
                        elif i == 31:
                            val = rec.expected_discharge
                        elif i == 33 and rec.handover:
                            val = rec.handover
                        elif i == 36:
                            # Elite ALOS guard: Ensure non-empty numeric value
                            if (val is None or str(val).strip() in ("", "nan", "None")) and rec.alos:
                                val = rec.alos
                        legacy_row[col_key] = val
                    else:
                        legacy_row[col_key] = clean_val(get_val(rec.raw_row, [f"Unnamed: {i}"]))
                legacy_occupancy_rows.append(legacy_row)

            # 7. Assemble Granular RTDB State & Historical Parity Snapshot
            previous_occupancy = (
                existing.get("occupancy_current")
                if (existing.get("occupancy_current") and len(existing.get("occupancy_current") or []) > 1)
                else existing.get("previous")
            )
            auto_discharges_count = len([p for p in discharged_list if isinstance(p, dict) and p.get("dischargeType") != "manual"])
            manual_discharges_count = len([p for p in discharged_list if isinstance(p, dict) and p.get("dischargeType") == "manual"])

            summary_info = {
                "totalOccupancy": occupied_beds_count,
                "entriesCount": len(cumulative_entries),
                "dischargesCount": len(discharged_list),
                "autoDischargesCount": auto_discharges_count,
                "manualDischargesCount": manual_discharges_count,
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
                {"path": "state/occupancy", "data": {"current": legacy_occupancy_rows, "previous": previous_occupancy}, "updated_at": now_iso},
                {"path": "state/debts", "data": {"items": cash_debts}, "updated_at": now_iso},
                {"path": "state/insured_debts", "data": {"items": insured_debts}, "updated_at": now_iso},
                {"path": "state/medical_plans", "data": {"items": medical_plans_list}, "updated_at": now_iso},
                {"path": "state/companion_status", "data": {"items": companion_status_list}, "updated_at": now_iso},
                {"path": "state/los_data", "data": {"items": los_data_list}, "updated_at": now_iso},
                {"path": "state/dialysis", "data": {"items": cumulative_dialysis}, "updated_at": now_iso},
                {"path": "state/transfers", "data": {"items": cumulative_transfers}, "updated_at": now_iso},
                {"path": "state/entries", "data": {"items": cumulative_entries}, "updated_at": now_iso},
                {"path": "state/discharged", "data": {"patients": discharged_list}, "updated_at": now_iso},
                {"path": "state/registry", "data": {"patientRoomRegistry": updated_registry}, "updated_at": now_iso},
                {
                    "path": "state/metadata",
                    "data": {
                        **(existing.get("existing_metadata") or {}),
                        "uploadedAt": now_iso,
                        "lastDatabaseUpdatedAt": now_iso,
                        "lastActiveDate": cairo_date_str,
                        "manuallyDischargedNames": manual_names,
                        "counts": {
                            "occupiedBeds": occupied_beds_count,
                            "debts": len(cash_debts),
                            "insuredDebts": len(insured_debts),
                            "medicalPlans": len(medical_plans_list),
                            "companionStatus": len(companion_status_list),
                            "los": len(los_data_list),
                            "dialysis": len(cumulative_dialysis),
                            "transfers": len(cumulative_transfers),
                            "entries": len(cumulative_entries),
                            "discharged": len(discharged_list),
                            "orList": len(existing.get("orList") or [])
                        }
                    },
                    "updated_at": now_iso
                },
                {"path": f"history/occupancy/{cairo_date_str}/summary", "data": summary_info, "updated_at": now_iso},
                {"path": f"history/occupancy/{cairo_date_str}/hospital_data", "data": legacy_occupancy_rows, "updated_at": now_iso},
                {"path": f"history/occupancy/{cairo_date_str}/discharged", "data": discharged_list, "updated_at": now_iso},
                {"path": f"history/occupancy/{cairo_date_str}/transfers", "data": cumulative_transfers, "updated_at": now_iso},
                {"path": f"history/occupancy/{cairo_date_str}/entries", "data": cumulative_entries, "updated_at": now_iso},
                {"path": f"history/occupancy/{cairo_date_str}/dialysis", "data": cumulative_dialysis, "updated_at": now_iso},
                {"path": f"history/occupancy/{cairo_date_str}/debts", "data": cash_debts, "updated_at": now_iso},
                {"path": f"history/occupancy/{cairo_date_str}/insured_debts", "data": insured_debts, "updated_at": now_iso},
                {"path": "history/occupancy_index", "data": updated_hist_index, "updated_at": now_iso}
            ]

            sb_response = session.post(SUPABASE_REST_URL, json=granular_nodes, timeout=30, verify=SUPABASE_SSL_VERIFY)
            if sb_response.status_code in (200, 201, 204):
                _last_synced_df_hash = current_df_hash
                _last_synced_cairo_date = cairo_date_str
                try:
                    meta_chk = session.get(
                        f"{SUPABASE_REST_URL}?path=eq.state/metadata&select=updated_at",
                        timeout=8,
                        verify=SUPABASE_SSL_VERIFY,
                    )
                    if meta_chk.status_code == 200 and meta_chk.json():
                        _last_synced_meta_updated_at = str(meta_chk.json()[0].get("updated_at") or now_iso)
                except Exception:
                    _last_synced_meta_updated_at = now_iso

                log(
                    f"Supabase state + Today's Snapshot ({cairo_date_str}) successfully committed: "
                    f"{occupied_beds_count} occupied beds, {len(cumulative_entries)} entries, "
                    f"{len(discharged_list)} discharged ({auto_discharges_count} auto / {manual_discharges_count} manual), "
                    f"{len(cash_debts)} cash debts, {len(insured_debts)} insured debts, "
                    f"{len(companion_status_list)} companions, {len(medical_plans_list)} medical plans, "
                    f"{len(cumulative_dialysis)} dialysis, {len(cumulative_transfers)} transfers."
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


def is_recent_sync_fresh(min_interval_sec: int = 180) -> bool:
    """Checks if state/metadata was updated very recently to avoid duplicate sync collisions across runners."""
    if os.getenv("FORCE_SYNC_NOW", "").strip() == "1":
        return False
    try:
        session = get_supabase_session()
        res = session.get(
            f"{SUPABASE_REST_URL}?path=eq.state/metadata&select=updated_at",
            timeout=10,
            verify=SUPABASE_SSL_VERIFY,
        )
        if res.status_code == 200 and res.json():
            updated_at = res.json()[0].get("updated_at")
            if updated_at:
                dt = datetime.datetime.fromisoformat(str(updated_at).replace("Z", "+00:00"))
                age_sec = (datetime.datetime.now(datetime.timezone.utc) - dt).total_seconds()
                if 0 <= age_sec < min_interval_sec:
                    log(f"[Sync Dedup] Another runner synced {int(age_sec)}s ago (<{min_interval_sec}s). Skipping duplicate cycle.")
                    return True
    except Exception:
        pass
    return False


# --- STANDALONE RUNNER TELEMETRY & REMOTE CONTROL (NO NODE.JS REQUIRED) ---

_sys_plat = platform.system().lower()
RUNNER_PLATFORM: Final[str] = "mac" if _sys_plat == "darwin" else ("windows" if _sys_plat.startswith("win") else "linux")
RUNNER_HOSTNAME: Final[str] = socket.gethostname() or "host"
RUNNER_ID: Final[str] = f"{RUNNER_PLATFORM}-{RUNNER_HOSTNAME}"
RUNNER_STARTED_AT: Final[str] = datetime.datetime.now(datetime.timezone.utc).isoformat()

_runner_log_seq: int = 1
_last_published_log_seq: int = 0
_last_runners_fetch_ts: float = 0.0
_cached_other_runners: list[dict[str, Any]] = []
_cached_other_logs: list[dict[str, Any]] = []
_runner_logs: list[dict[str, Any]] = []
_runner_state: dict[str, Any] = {
    "runnerId": RUNNER_ID,
    "hostname": RUNNER_HOSTNAME,
    "platform": RUNNER_PLATFORM,
    "osLabel": f"{platform.system()} ({platform.release()})",
    "pid": os.getpid(),
    "startedAt": RUNNER_STARTED_AT,
    "lastHeartbeatAt": RUNNER_STARTED_AT,
    "onPremReachable": True,
    "status": "running",
    "childPid": os.getpid(),
    "restartCount": 0,
    "lastCycleStartedAt": None,
    "lastSuccessAt": None,
    "lastError": None,
    "nextRunEta": None,
    "pendingDischarge": {
        "lastCheckedAt": None,
        "totalDetected": 0,
        "addedCount": 0,
        "skippedDialysisCount": 0,
        "skippedErCount": 0,
        "skippedAlreadyDischargedCount": 0,
        "recentCases": [],
    },
}
_last_seen_run_now_id: int = 0
_last_seen_restart_id: int = 0
_is_paused: bool = False


def _record_standalone_log(level: str, msg: str) -> None:
    global _runner_log_seq
    clean = str(msg).strip()
    if not clean or "Next sync in:" in clean:
        return
    for sec in (HMIS_PASS, POWERBI_PASS, FORTINET_PASS, SUPABASE_KEY):
        if sec and len(sec) > 3:
            clean = clean.replace(sec, "***")

    now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
    _runner_logs.append({
        "id": _runner_log_seq,
        "timestamp": now_iso,
        "level": level if level in ("info", "warning", "error") else "info",
        "message": clean,
        "runnerId": RUNNER_ID,
        "platform": RUNNER_PLATFORM,
    })
    _runner_log_seq += 1
    if len(_runner_logs) > 250:
        del _runner_logs[:-250]

    pd_stats = _runner_state["pendingDischarge"]
    if "=== STARTING SYNC JOB CYCLE ===" in clean:
        _runner_state["status"] = "syncing"
        _runner_state["lastCycleStartedAt"] = now_iso
        _runner_state["pendingDischarge"] = {
            "lastCheckedAt": now_iso,
            "totalDetected": 0,
            "addedCount": 0,
            "skippedDialysisCount": 0,
            "skippedErCount": 0,
            "skippedAlreadyDischargedCount": 0,
            "recentCases": [],
        }
    elif "successfully committed:" in clean or "[Sync Dedup]" in clean:
        _runner_state["status"] = "running"
        if "successfully committed:" in clean:
            _runner_state["lastSuccessAt"] = now_iso
            _runner_state["lastError"] = None
        _runner_state["nextRunEta"] = (
            datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=30)
        ).isoformat()
    elif "Sync error encountered:" in clean or "Max retry attempts" in clean:
        _runner_state["lastError"] = clean
        _runner_state["status"] = "error"
    elif "[HMIS Pending]" in clean:
        pd_stats["lastCheckedAt"] = now_iso
        m = re.search(r"\[HMIS Pending\]\s+(\d+)\s+case\(s\)\s+currently", clean)
        if m:
            pd_stats["totalDetected"] = int(m.group(1))
        elif "Skipped dialysis case:" in clean:
            pd_stats["skippedDialysisCount"] += 1
        elif "Skipped ER case:" in clean:
            pd_stats["skippedErCount"] += 1
        elif "Already discharged" in clean or "Already in cumulative discharged" in clean:
            pd_stats["skippedAlreadyDischargedCount"] += 1
        elif "Added to cumulative discharged:" in clean or "Would add to cumulative discharged:" in clean:
            pd_stats["addedCount"] += 1


def _check_on_prem_socket() -> bool:
    for host in ("10.12.0.10", "10.12.0.11"):
        try:
            with socket.create_connection((host, 80), timeout=2.5):
                return True
        except Exception:
            pass
    return False


def publish_standalone_heartbeat() -> None:
    """Publishes runner status & logs directly to Supabase so the cloud Maintenance tab works without Node.js."""
    global _last_published_log_seq, _last_runners_fetch_ts, _cached_other_runners, _cached_other_logs
    if not SUPABASE_KEY:
        return
    try:
        session = get_supabase_session()
        now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
        now_ts = datetime.datetime.now(datetime.timezone.utc).timestamp()
        _runner_state["lastHeartbeatAt"] = now_iso
        _runner_state["onPremReachable"] = _check_on_prem_socket()
        if _is_paused:
            _runner_state["status"] = "paused"
        elif not _runner_state["onPremReachable"]:
            _runner_state["status"] = "idle-off-prem"

        has_new_logs = (_runner_log_seq != _last_published_log_seq)
        # Only GET settings/sync_runners when new log entries exist or every 5 minutes (P1 Egress Optimization)
        if has_new_logs or (now_ts - _last_runners_fetch_ts > 300):
            res = session.get(
                f"{SUPABASE_REST_URL}?path=eq.settings/sync_runners&select=data",
                timeout=10,
                verify=SUPABASE_SSL_VERIFY,
            )
            _last_runners_fetch_ts = now_ts
            existing_runners: list[dict[str, Any]] = []
            existing_logs: list[dict[str, Any]] = []
            if res.status_code == 200 and res.json():
                d = res.json()[0].get("data") or {}
                if isinstance(d.get("runners"), list):
                    existing_runners = d["runners"]
                if isinstance(d.get("logs"), list):
                    existing_logs = d["logs"]

            fresh_others = []
            for r in existing_runners:
                if not isinstance(r, dict) or r.get("runnerId") == RUNNER_ID or r.get("platform") == RUNNER_PLATFORM:
                    continue
                try:
                    hb = datetime.datetime.fromisoformat(str(r.get("lastHeartbeatAt", "")).replace("Z", "+00:00")).timestamp()
                    if now_ts - hb < 150:
                        fresh_others.append(r)
                except Exception:
                    pass
            _cached_other_runners = fresh_others
            _cached_other_logs = [l for l in existing_logs if isinstance(l, dict) and l.get("runnerId") != RUNNER_ID]
        else:
            fresh_others = []
            for r in _cached_other_runners:
                try:
                    hb = datetime.datetime.fromisoformat(str(r.get("lastHeartbeatAt", "")).replace("Z", "+00:00")).timestamp()
                    if now_ts - hb < 150:
                        fresh_others.append(r)
                except Exception:
                    pass
            _cached_other_runners = fresh_others

        merged_runners = [_runner_state] + _cached_other_runners[:1]
        merged_logs = (_cached_other_logs + _runner_logs)[-150:]

        session.post(
            SUPABASE_REST_URL,
            json=[{
                "path": "settings/sync_runners",
                "data": {"runners": merged_runners, "logs": merged_logs, "updatedAt": now_iso},
                "updated_at": now_iso,
            }],
            timeout=10,
            verify=SUPABASE_SSL_VERIFY,
        )
        _last_published_log_seq = _runner_log_seq
    except Exception:
        pass


def poll_standalone_control(init_only: bool = False) -> None:
    """Polls settings/sync_control in Supabase for Pause / Resume / Run Now / Restart commands."""
    global _last_seen_run_now_id, _last_seen_restart_id, _is_paused
    if not SUPABASE_KEY:
        return
    try:
        session = get_supabase_session()
        res = session.get(
            f"{SUPABASE_REST_URL}?path=eq.settings/sync_control&select=data",
            timeout=10,
            verify=SUPABASE_SSL_VERIFY,
        )
        if res.status_code != 200 or not res.json():
            return
        ctrl = res.json()[0].get("data") or {}
        run_now_id = int(ctrl.get("runNowRequestId") or 0)
        restart_id = int(ctrl.get("restartRequestId") or 0)
        paused_flag = bool(ctrl.get("paused"))

        if init_only:
            _last_seen_run_now_id = run_now_id
            _last_seen_restart_id = restart_id
            _is_paused = paused_flag
            return

        if paused_flag != _is_paused:
            _is_paused = paused_flag
            log(f"[Control] Sync state changed to {'PAUSED' if _is_paused else 'RESUMED'} by admin.")
            publish_standalone_heartbeat()

        if restart_id > _last_seen_restart_id:
            _last_seen_restart_id = restart_id
            _runner_state["restartCount"] = int(_runner_state.get("restartCount") or 0) + 1
            log("[Control] Remote Restart requested from Maintenance tab. Running fresh cycle...")
            if not _is_paused:
                run_sync_job(force=True)

        if run_now_id > _last_seen_run_now_id:
            _last_seen_run_now_id = run_now_id
            log("[Control] Remote Run-Now requested from Maintenance tab. Executing immediate sync...")
            _is_paused = False
            run_sync_job(force=True)
    except Exception:
        pass


def run_sync_job(force: bool = False) -> None:
    """Executes a complete sync job sequence."""
    if _is_paused and not force:
        log("[Sync Paused] Skipping scheduled sync cycle while paused.")
        publish_standalone_heartbeat()
        return
    if not force and is_recent_sync_fresh(180):
        publish_standalone_heartbeat()
        return
    log("=== STARTING SYNC JOB CYCLE ===")
    publish_standalone_heartbeat()
    fortinet_reconnect()
    fetch_powerbi_and_sync()
    publish_standalone_heartbeat()


def handle_shutdown(signum: int, frame: Any) -> None:
    """Graceful termination handler."""
    log(f"Received exit signal ({signum}). Shutting down sync service cleanly.")
    sys.exit(0)


if __name__ == "__main__":
    signal.signal(signal.SIGINT, handle_shutdown)
    signal.signal(signal.SIGTERM, handle_shutdown)

    force_now = "--force" in sys.argv or os.getenv("FORCE_SYNC_NOW", "").strip() == "1"
    run_once = "--once" in sys.argv

    poll_standalone_control(init_only=True)
    log(f"Hospital Occupancy Sync Service Online ({RUNNER_ID}). Initializing first run...")
    publish_standalone_heartbeat()
    run_sync_job(force=force_now)

    if run_once:
        log("Single sync cycle (--once) completed. Exiting.")
        sys.exit(0)

    schedule.every(30).minutes.do(run_sync_job)

    _last_hb_ts = time.time()
    _last_ctrl_ts = time.time()

    while True:
        check_cairo_day_rollover()
        if not _is_paused:
            schedule.run_pending()

        now_ts = time.time()
        if now_ts - _last_ctrl_ts >= 20.0:
            _last_ctrl_ts = now_ts
            poll_standalone_control(init_only=False)
        if now_ts - _last_hb_ts >= 60.0:
            _last_hb_ts = now_ts
            publish_standalone_heartbeat()

        next_run = schedule.next_run()
        if next_run:
            now = datetime.datetime.now()
            time_remaining = (next_run - now).total_seconds()
            if time_remaining > 0 and sys.stdout.isatty():
                mins, secs = divmod(int(time_remaining), 60)
                state_tag = "PAUSED" if _is_paused else "ACTIVE"
                sys.stdout.write(f"\r[{now.strftime('%Y-%m-%d %H:%M:%S')}] [{state_tag}] Next sync in: {mins:02d}:{secs:02d}   ")
                sys.stdout.flush()
        time.sleep(1)
