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
import hmac
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
POWERBI_OR_EXPORT_URL: Final[str] = os.getenv(
    "POWERBI_OR_EXPORT_URL",
    "http://10.12.0.11/powerbi/api/explore/reports/c1b018c2-bc1c-4209-9b7d-9d56e0949110/export/xlsx"
)
POWERBI_OPD_EXPORT_URL: Final[str] = os.getenv(
    "POWERBI_OPD_EXPORT_URL",
    "http://10.12.0.11/powerbi/api/explore/reports/2f80fbba-95b8-4c55-aff1-5be0147ca894/export/xlsx"
)
POWERBI_APPROVALS_EXPORT_URL: Final[str] = os.getenv(
    "POWERBI_APPROVALS_EXPORT_URL",
    "http://10.12.0.11/powerbi/api/explore/reports/91b0dd5b-59f8-414a-bd65-fcd084a65350/export/xlsx"
)
POWERBI_LIVE_OPD_EXPORT_URL: Final[str] = os.getenv(
    "POWERBI_LIVE_OPD_EXPORT_URL",
    "http://10.12.0.11/powerbi/api/explore/reports/4194e59e-364f-426d-b0e9-90014bdfadca/export/xlsx"
)
POWERBI_OPD_QUEUE_EXPORT_URL: Final[str] = os.getenv(
    "POWERBI_OPD_QUEUE_EXPORT_URL",
    "http://10.12.0.11/powerbi/api/explore/reports/8cb1a46c-8603-45ea-9246-ac029a1f6ab7/export/xlsx"
)
POWERBI_CATHLAB_EXPORT_URL: Final[str] = os.getenv(
    "POWERBI_CATHLAB_EXPORT_URL",
    "http://10.12.0.11/powerbi/api/explore/reports/07aaac17-fca9-449d-bd2f-515b1bc78e4a/export/xlsx"
)
POWERBI_ENDO_EXPORT_URL: Final[str] = os.getenv(
    "POWERBI_ENDO_EXPORT_URL",
    "http://10.12.0.11/powerbi/api/explore/reports/422ed23d-d03d-438f-86ba-ade901504e6e/export/xlsx"
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
SUPABASE_OR_RPC_URL: Final[str] = f"{SUPABASE_URL}/rest/v1/rpc/sync_or_cases"
SUPABASE_OR_FOR_DATE_RPC_URL: Final[str] = f"{SUPABASE_URL}/rest/v1/rpc/sync_or_cases_for_date"

OR_FUTURE_WEEKS: Final[int] = max(0, int(os.getenv("OR_FUTURE_WEEKS", "2")))
OR_FUTURE_SYNC_ENABLED: Final[bool] = os.getenv("OR_FUTURE_SYNC_ENABLED", "1").lower() not in ("0", "false", "no")

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
# Matches all Cybernetics HMIS companion bed labels (e.g. "Bed 405 C", "Bed 405 D", "Bed 421 B", "Bed 408 C I", "Bed 320c", "Bed 402A - C", "Companion", "مرافق").
RE_COMPANION_BED: Final = re.compile(
    r"(?:companion|مرافق)"
    r"|(?:^(?:bed|room|الغرفة|غرفة)?\s*\d{3}\s*[ab]?\s*(?:-\s*[12]\s*|-\s*)?c(?:\s*(?:\d+|i{1,3}))?$)"
    r"|(?:^(?:bed|room|الغرفة|غرفة)?\s*(?:405\s*d|421\s*b)$)",
    re.IGNORECASE,
)


def is_companion_bed(bed_str: Any) -> bool:
    """Returns True when a bed/room label identifies a companion bed (never an inpatient bed)."""
    if not bed_str:
        return False
    s = str(bed_str).strip()
    return bool(s and RE_COMPANION_BED.search(s))


# --- VERCEL VIP SYNC EVENT DISPATCHER (100% VERCEL VIP ENGINE) ---
DEFAULT_APP_URL: Final[str] = "https://elite-occu.vercel.app"


def get_vip_sync_events_url() -> str:
    explicit = os.getenv("VIP_SYNC_EVENTS_URL", "").strip()
    if explicit:
        return explicit
    base = (os.getenv("APP_URL", "") or DEFAULT_APP_URL).strip().rstrip("/")
    return f"{base}/api/whatsapp/vip-sync-events"


def sign_vip_sync_events_payload(raw_body: str, timestamp_sec: int, secret: str) -> str:
    return hmac.new(
        secret.encode("utf-8"),
        f"{timestamp_sec}.{raw_body}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def collect_hmis_graduated_vip_candidates(
    discharged_list: list[dict[str, Any]],
    raw_records: list[Any],
) -> list[dict[str, Any]]:
    """Returns hmis_pending_discharge entries that have now dropped out of raw Power BI records."""
    if not raw_records:
        return []
    graduated: list[dict[str, Any]] = []
    for dp in discharged_list:
        if not isinstance(dp, dict) or dp.get("source") != "hmis_pending_discharge":
            continue
        dp_mrn = clean_mrn_str(dp.get("mrn"))
        still_in_powerbi = any(
            (dp_mrn and getattr(r, "clean_mrn", None) and dp_mrn == r.clean_mrn)
            or is_name_match(dp.get("name"), getattr(r, "name", ""))
            for r in raw_records
        )
        if not still_in_powerbi:
            graduated.append(dp)
    return graduated


def collect_hmis_option_a_vip_candidates(
    discharged_list: list[dict[str, Any]],
    pre_hmis_disc: list[dict[str, Any]],
    raw_records: list[Any],
) -> list[dict[str, Any]]:
    """Option A: returns newly added hmis_pending_discharge entries immediately OR any that dropped from raw Power BI."""
    pre_mrns = {
        clean_mrn_str(dp.get("mrn") or "")
        for dp in (pre_hmis_disc or [])
        if isinstance(dp, dict) and clean_mrn_str(dp.get("mrn") or "")
    }
    pre_names = [
        str(dp.get("name") or "").strip()
        for dp in (pre_hmis_disc or [])
        if isinstance(dp, dict) and str(dp.get("name") or "").strip()
    ]
    graduated_ids = {
        id(dp) for dp in collect_hmis_graduated_vip_candidates(discharged_list, raw_records)
    }

    selected: list[dict[str, Any]] = []
    for dp in discharged_list:
        if not isinstance(dp, dict) or dp.get("source") != "hmis_pending_discharge":
            continue
        dp_mrn = clean_mrn_str(dp.get("mrn") or "")
        dp_name = str(dp.get("name") or "").strip()
        existed_before = (
            (dp_mrn and dp_mrn in pre_mrns)
            or (dp_name and any(is_name_match(dp_name, pn) for pn in pre_names))
        )
        if (not existed_before) or (id(dp) in graduated_ids):
            selected.append(dp)
    return selected


def dispatch_vip_sync_events_to_vercel(
    discharges: list[dict[str, Any]],
    admissions: list[dict[str, Any]],
    post_fn: Optional[Any] = None,
) -> bool:
    """Sends newly detected Power BI/HMIS discharges & admissions to Vercel for 100%-Vercel VIP matching & WhatsApp alerting."""
    global _last_synced_meta_updated_at
    if not discharges and not admissions:
        return True
    secret = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_KEY") or SUPABASE_KEY or "").strip()
    if not secret:
        log("[VIP Sync] Missing SUPABASE_KEY/SUPABASE_SERVICE_ROLE_KEY; skipping Vercel VIP event dispatch.", level="warning")
        return False

    url = get_vip_sync_events_url()
    payload = {
        "discharges": [
            {
                "name": str(d.get("name") or ""),
                "room": str(d.get("room") or ""),
                "mrn": str(d.get("mrn") or ""),
                "contractor": str(d.get("contractor") or ""),
                "dischargeType": str(d.get("dischargeType") or "auto"),
                "source": d.get("source"),
            }
            for d in (discharges or [])
            if isinstance(d, dict) and d.get("name")
        ],
        "admissions": [
            {
                "name": str(a.get("name") or ""),
                "room": str(a.get("room") or ""),
                "mrn": str(a.get("mrn") or ""),
                "physician": str(a.get("physician") or ""),
                "contractor": str(a.get("contractor") or ""),
            }
            for a in (admissions or [])
            if isinstance(a, dict) and a.get("name")
        ],
    }
    if not payload["discharges"] and not payload["admissions"]:
        return True

    raw_body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    ts_sec = int(time.time())
    signature = sign_vip_sync_events_payload(raw_body, ts_sec, secret)
    headers = {
        "Content-Type": "application/json",
        "X-VIP-Alert-Timestamp": str(ts_sec),
        "X-VIP-Alert-Signature": signature,
    }

    try:
        sender = post_fn or requests.post
        res = sender(url, data=raw_body.encode("utf-8"), headers=headers, timeout=15)
        if getattr(res, "status_code", 0) == 200:
            body = res.json() if hasattr(res, "json") else {}
            if isinstance(body, dict):
                sent_d = int(body.get("sentDischarges", 0))
                sent_a = int(body.get("sentAdmissions", 0))
                sup_d = int(body.get("suppressedDischarges", 0))
                sup_a = int(body.get("suppressedAdmissions", 0))
                paused = bool(body.get("paused", False))
                meta_ts = str(body.get("metadataUpdatedAt") or "").strip()
                if meta_ts:
                    _last_synced_meta_updated_at = meta_ts
                log(
                    f"[VIP Sync] Dispatched {len(payload['admissions'])} admission(s) & {len(payload['discharges'])} discharge(s) to Vercel "
                    f"-> sent={sent_a}/{sent_d}, suppressed={sup_a}/{sup_d}, paused={paused}"
                )
            return True
        log(f"[VIP Sync] Vercel relay HTTP {getattr(res, 'status_code', '?')}: {str(getattr(res, 'text', ''))[:200]}", level="warning")
        return False
    except Exception as exc:
        log(f"[VIP Sync] Non-fatal error dispatching VIP events to Vercel: {exc}", level="warning")
        return False

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
    """Normalizes medical record numbers, stripping decimal artifacts, leading zeroes, and dummy OR placeholder 65765."""
    if mrn is None:
        return ""
    s = str(mrn).strip()
    if s.endswith(".0"):
        s = s[:-2]
    s = s.lstrip("0")
    if s in ("65765", "null", "nan", "none", "-"):
        return ""
    return s


def parse_to_pg_time(raw: Any) -> Optional[str]:
    """Parses arbitrary time strings, datetime.time objects, or Excel fractional times to 24-hour HH:MM:SS for Postgres."""
    if raw is None or pd.isna(raw):
        return None
    if isinstance(raw, datetime.time):
        return f"{raw.hour:02d}:{raw.minute:02d}:{raw.second:02d}"
    if isinstance(raw, (datetime.datetime, pd.Timestamp)):
        return f"{raw.hour:02d}:{raw.minute:02d}:{raw.second:02d}"
    s = str(raw).strip()
    if not s or s == "-" or s.lower() in ("nan", "null", "none"):
        return None
    try:
        num = float(s)
        if 0.0 <= num < 1.0 and "." in s:
            total_sec = int(round(num * 86400))
            hh = (total_sec // 3600) % 24
            mm = (total_sec % 3600) // 60
            ss = total_sec % 60
            return f"{hh:02d}:{mm:02d}:{ss:02d}"
    except ValueError:
        pass

    is_pm = bool(re.search(r"م|مساء|pm", s, re.IGNORECASE))
    is_am = bool(re.search(r"ص|صباح|am", s, re.IGNORECASE))
    m = re.search(r"(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?", s)
    if not m:
        return None
    hh = int(m.group(1))
    mm = int(m.group(2))
    ss = int(m.group(3)) if m.group(3) else 0
    if mm < 0 or mm > 59:
        return None
    if is_pm and hh < 12:
        hh += 12
    elif is_am and hh == 12:
        hh = 0
    if hh < 0 or hh > 23:
        return None
    return f"{hh:02d}:{mm:02d}:{ss:02d}"


def format_time_12h(val: Any) -> str:
    """Formats any time value into 12-hour format (e.g. '05:05 AM', '01:20 PM', '11:30 PM')."""
    if val is None or pd.isna(val):
        return ""
    raw = str(val).strip()
    if not raw or raw.lower() in ("nan", "null", "none"):
        return ""
    pg_time = parse_to_pg_time(val)
    if not pg_time:
        return raw
    parts = pg_time.split(":")
    try:
        h24 = int(parts[0])
        mins = parts[1] if len(parts) > 1 else "00"
        period = "PM" if h24 >= 12 else "AM"
        h12 = 12 if (h24 % 12 == 0) else (h24 % 12)
        return f"{h12:02d}:{mins} {period}"
    except Exception:
        return raw


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


def is_readmission_after_discharge(admission_date: Optional[str], discharge_date: Optional[str]) -> bool:
    """Returns True when an active admission timestamp is strictly newer than a manual discharge timestamp."""
    if not admission_date or not discharge_date:
        return False
    adm_comp = _parse_unified_date_components(admission_date)
    disc_comp = _parse_unified_date_components(discharge_date)
    if not adm_comp or not disc_comp:
        return False
    if (disc_comp[3], disc_comp[4]) != (0, 0):
        return adm_comp > disc_comp
    return adm_comp[:3] > disc_comp[:3]


def is_patient_manually_discharged(
    name: str,
    mrn: str,
    manual_names: list[str],
    manual_mrns: set[str],
    admission_date: Optional[str] = None,
    manual_discharges: Optional[list[dict[str, str]]] = None,
) -> bool:
    """Checks if a patient was manually discharged today and has NOT been re-admitted afterward."""
    c_mrn = clean_mrn_str(mrn)
    matched = bool(c_mrn and c_mrn in manual_mrns) or (
        bool(name and manual_names) and any(is_name_match(name, m_name) for m_name in manual_names)
    )
    if not matched:
        return False

    if admission_date and manual_discharges:
        matching_discharges = [
            d for d in manual_discharges
            if (c_mrn and d.get("mrn") and d["mrn"] == c_mrn)
            or (name and d.get("name") and is_name_match(name, d["name"]))
        ]
        if matching_discharges:
            latest_disc_comp: Optional[tuple[int, int, int, int, int]] = None
            latest_disc_raw: Optional[str] = None
            for d in matching_discharges:
                dc = _parse_unified_date_components(d.get("discharge_date"))
                if dc and (latest_disc_comp is None or dc > latest_disc_comp):
                    latest_disc_comp = dc
                    latest_disc_raw = d.get("discharge_date")
            if latest_disc_raw and is_readmission_after_discharge(admission_date, latest_disc_raw):
                return False

    return True


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
    manual_discharges: list[dict[str, str]] = []
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
                    manual_discharges.append({
                        "name": str(p_name or "").strip(),
                        "mrn": p_mrn,
                        "discharge_date": str(dp.get("dischargeDate") or dp.get("date") or "").strip(),
                        "room": str(dp.get("room") or "").strip(),
                    })

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

    existing_counts = meta.get("counts") if isinstance(meta.get("counts"), dict) else {}
    existing_or_count = (
        int(existing_counts.get("orList") or 0)
        if (not is_new_day and not is_system_reset)
        else 0
    )

    raw_restored_overrides = meta.get("restoredHmisOverrides") or []
    if not isinstance(raw_restored_overrides, list) or is_new_day or is_system_reset:
        raw_restored_overrides = []
    restored_hmis_overrides = [ov for ov in raw_restored_overrides if isinstance(ov, dict)]

    raw_vip_notified = meta.get("vipDischargeNotified") or []
    if not isinstance(raw_vip_notified, list) or is_new_day or is_system_reset:
        raw_vip_notified = []
    vip_discharge_notified = [str(k) for k in raw_vip_notified if k]
    raw_vip_adm_notified = meta.get("vipAdmissionNotified") or []
    if not isinstance(raw_vip_adm_notified, list) or is_new_day or is_system_reset:
        raw_vip_adm_notified = []
    vip_admission_notified = [str(k) for k in raw_vip_adm_notified if k]
    vip_discharge_automation_paused = bool(meta.get("vipDischargeAutomationPaused", False))

    return {
        "previous": occ.get("previous") or dataset.get("current"),
        "occupancy_current": occ_current,
        "discharged": clean_disc_patients,
        "entries": existing_entries,
        "transfers": existing_trans,
        "orList": (state_map.get("state/or_list") or {}).get("items", []),
        "orListCount": existing_or_count,
        "dialysis": existing_dial,
        "registry": raw_registry if isinstance(raw_registry, dict) else {},
        "manually_discharged_names": list(manual_names_set),
        "manually_discharged_mrns": list(manual_mrns_set),
        "manual_discharges": manual_discharges,
        "restored_hmis_overrides": restored_hmis_overrides,
        "vip_discharge_notified": vip_discharge_notified,
        "vip_admission_notified": vip_admission_notified,
        "vip_discharge_automation_paused": vip_discharge_automation_paused,
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
        bed_name = str(b.get("BedName_EN") or "").strip()
        p_name_ar = str(b.get("EnglishFullName") or b.get("ArabicFullName") or "").strip()
        p_mrn = clean_mrn_str(b.get("PatientBarcode") or b.get("PatientID") or "")
        if b.get("IsForCompanion") is True or b.get("CompanionGUID") or is_companion_bed(bed_name):
            log(f"[HMIS Pending] Skipped companion bed: {p_name_ar or bed_name} ({bed_name})")
            continue
        out.append({
            "mrn": p_mrn,
            # NOTE: the HMIS stores the Arabic name in "EnglishFullName" and the English one in "ArabicFullName".
            "name": p_name_ar,
            "name_en": str(b.get("ArabicFullName") or "").strip(),
            "bed": bed_name,
            # Portal label is "<bed> - <structure>", e.g. "Observation 1 - ER"; the ER part lives in the structure name.
            "structure": str(b.get("FloorStructureName_EN") or "").strip(),
            "admission_date": str(b.get("AdmissionDate") or "").strip(),
        })
    log(f"[HMIS Pending] {len(out)} case(s) currently in Nurse Portal 'Pending Discharge'.")
    return out


def build_raw_row_from_record(rec: Optional[NormalizedPatientRecord]) -> Optional[list[Any]]:
    """Builds a 41-column legacy array from a NormalizedPatientRecord so manual restore preserves all clinical/financial fields."""
    if not rec:
        return None
    row: list[Any] = [""] * 41
    row[0] = rec.admission_date or ""
    row[1] = rec.bed or ""
    row[2] = rec.mrn or rec.clean_mrn or ""
    row[3] = rec.name or ""
    row[4] = rec.mobile or ""
    row[5] = rec.financial_status or ""
    row[7] = rec.floor or ""
    row[8] = rec.notes or ""
    row[9] = rec.visit_type or ""
    row[10] = rec.payment_by or ""
    row[12] = rec.contractor or ""
    row[16] = rec.los or ""
    row[20] = rec.diagnosis or ""
    row[22] = rec.physician or ""
    row[23] = rec.specialty or ""
    row[25] = f"{rec.total_invoice:.2f}"
    row[27] = f"{rec.remaining_debt:.2f}"
    row[31] = rec.expected_discharge or ""
    row[33] = rec.handover or ""
    row[36] = rec.alos or ""
    row[38] = rec.medications or ""
    row[39] = rec.initial_assessment or ""
    row[40] = rec.vte_summary or ""
    return row


def compute_sync_content_hash(
    raw_records: list[dict[str, Any]],
    pending_cases: Optional[list[dict[str, Any]]] = None,
) -> str:
    """Hashes Power BI raw rows together with the sorted HMIS pending-discharge signature."""
    def _norm(v: Any) -> str:
        if v is None:
            return "None"
        try:
            if pd.isna(v):
                return "None"
        except Exception:
            pass
        if isinstance(v, (datetime.date, datetime.datetime, pd.Timestamp)):
            return v.isoformat()
        return str(v)

    pbi_sig = [[_norm(v) for v in r.values()] for r in (raw_records or [])]
    hmis_sig = sorted(
        (
            str(pc.get("mrn") or ""),
            str(pc.get("bed") or ""),
            str(pc.get("name") or ""),
        )
        for pc in (pending_cases or [])
        if isinstance(pc, dict)
    )
    payload = json.dumps({"pbi": pbi_sig, "hmis": hmis_sig}, ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _matches_restored_override(
    name: str,
    mrn: str,
    admission_date: Optional[str],
    restored_overrides: list[dict[str, Any]],
) -> bool:
    c_mrn = clean_mrn_str(mrn)
    for ov in restored_overrides or []:
        if not isinstance(ov, dict):
            continue
        ov_mrn = clean_mrn_str(ov.get("mrn") or "")
        ov_name = str(ov.get("name") or "").strip()
        if (c_mrn and ov_mrn and c_mrn == ov_mrn) or (name and ov_name and is_name_match(name, ov_name)):
            ov_adm = ov.get("admissionDate") or ov.get("date")
            if admission_date and ov_adm:
                if is_readmission_after_discharge(admission_date, str(ov_adm)):
                    # Newer admission than the overridden one; do not suppress future discharge checks
                    continue
            return True
    return False


def reconcile_hmis_pending_discharges(
    pending_cases: list[dict[str, str]],
    records: list[NormalizedPatientRecord],
    already_disc: list[dict[str, Any]],
    manual_names: list[str],
    manual_mrns: set[str],
    manual_discharges: list[dict[str, str]],
    restored_overrides: list[dict[str, Any]],
    cairo_time_str: str,
    dry_run: bool = False,
) -> int:
    """
    Reconciles HMIS Nurse Portal 'Pending Discharge' (FinancialDischarge) cases in-place:
    1. Scrubs any companion beds that previously leaked into discharged/manual lists.
    2. Auto-reverses stale `hmis_pending_discharge` entries when HMIS no longer marks them
       FinancialDischarge and the patient is still active in Power BI (never touches staff manual discharges).
    3. Adds active non-companion, non-ER, non-dialysis, non-overridden pending cases with full rawRow.
    Returns count of newly added (or would-add in dry_run) cases.
    """
    # Step A: Scrub any companion bed entries from discharged & manual lists
    scrubbed_names: list[str] = []
    scrubbed_mrns: set[str] = set()
    kept_disc: list[dict[str, Any]] = []
    for dp in already_disc:
        if isinstance(dp, dict) and (dp.get("isCompanion") or is_companion_bed(dp.get("room") or "")):
            nm = str(dp.get("name") or "").strip()
            m = clean_mrn_str(dp.get("mrn") or "")
            if nm:
                scrubbed_names.append(nm)
            if m:
                scrubbed_mrns.add(m)
            log(f"[HMIS Pending] Scrubbed companion bed from discharged list: {nm} ({dp.get('room')})")
            continue
        kept_disc.append(dp)
    already_disc[:] = kept_disc

    # Step B: Auto-reverse hmis_pending_discharge entries when HMIS cleared FinancialDischarge and patient is active in Power BI
    def _is_still_pending(dp_name: str, dp_mrn: str) -> bool:
        for pc in pending_cases:
            pc_m = clean_mrn_str(pc.get("mrn") or "")
            if (dp_mrn and pc_m and dp_mrn == pc_m) or (dp_name and is_name_match(dp_name, pc.get("name") or pc.get("name_en") or "")):
                return True
        return False

    reversed_disc: list[dict[str, Any]] = []
    for dp in already_disc:
        if isinstance(dp, dict) and dp.get("source") == "hmis_pending_discharge":
            dp_name = str(dp.get("name") or "").strip()
            dp_mrn = clean_mrn_str(dp.get("mrn") or "")
            still_in_pbi = any(
                (dp_mrn and r.clean_mrn and dp_mrn == r.clean_mrn) or (dp_name and is_name_match(dp_name, r.name))
                for r in records
            )
            if still_in_pbi and not _is_still_pending(dp_name, dp_mrn):
                if dp_name:
                    scrubbed_names.append(dp_name)
                if dp_mrn:
                    scrubbed_mrns.add(dp_mrn)
                log(f"[HMIS Pending] Auto-reversed cleared FinancialDischarge back to active: {dp_name} (MRN {dp_mrn})")
                continue
        reversed_disc.append(dp)
    already_disc[:] = reversed_disc

    if scrubbed_names or scrubbed_mrns:
        manual_names[:] = [
            mn for mn in manual_names
            if not any(is_name_match(mn, sn) for sn in scrubbed_names)
        ]
        for sm in scrubbed_mrns:
            manual_mrns.discard(sm)
        manual_discharges[:] = [
            md for md in manual_discharges
            if not (
                (md.get("mrn") and clean_mrn_str(md.get("mrn")) in scrubbed_mrns)
                or (md.get("name") and any(is_name_match(md.get("name"), sn) for sn in scrubbed_names))
                or is_companion_bed(md.get("room") or "")
            )
        ]

    # Step C: Process current HMIS FinancialDischarge cases
    new_count = 0
    for pc in pending_cases:
        label = f"{pc['name'] or pc['name_en']} (MRN {pc['mrn']}, {pc['bed']})"
        if is_companion_bed(pc["bed"]):
            log(f"[HMIS Pending] Skipped companion bed: {label}")
            continue
        if is_dialysis_room(pc["bed"]):
            log(f"[HMIS Pending] Skipped dialysis case: {label}")
            continue
        if RE_ER_ROOM.search(f"{pc['bed']} - {pc.get('structure', '')}"):
            log(f"[HMIS Pending] Skipped ER case: {label}")
            continue
        match_rec = next((r for r in records if pc["mrn"] and r.clean_mrn == pc["mrn"]), None)
        if not match_rec and pc.get("name"):
            match_rec = next((r for r in records if is_name_match(r.name, pc["name"])), None)
        p_name = (match_rec.name if match_rec else pc["name"]) or pc["name_en"]
        eff_mrn = (match_rec.clean_mrn if match_rec else pc["mrn"]) or pc["mrn"]
        eff_adm = match_rec.admission_date if match_rec else pc.get("admission_date")

        if _matches_restored_override(p_name, eff_mrn, eff_adm, restored_overrides):
            log(f"[HMIS Pending] Skipped user-restored override: {label}")
            continue

        if is_patient_manually_discharged(
            pc["name"], pc["mrn"], manual_names, manual_mrns,
            admission_date=(match_rec.admission_date if match_rec else None),
            manual_discharges=manual_discharges,
        ):
            log(f"[HMIS Pending] Already discharged, skipping: {label}")
            continue
        if any(
            isinstance(dp, dict) and (
                (pc["mrn"] and clean_mrn_str(dp.get("mrn") or "") == pc["mrn"])
                or is_name_match(dp.get("name"), p_name)
            ) and not (
                match_rec and is_readmission_after_discharge(
                    match_rec.admission_date, dp.get("dischargeDate") or dp.get("date")
                )
            )
            for dp in already_disc
        ):
            log(f"[HMIS Pending] Already in cumulative discharged, skipping: {label}")
            continue
        new_count += 1
        if dry_run:
            log(f"[HMIS Pending][DRY-RUN] Would add to cumulative discharged: {label}")
            continue
        disc_room = clean_room_str(match_rec.bed if match_rec else pc["bed"])
        disc_mrn = eff_mrn
        already_disc.append({
            "room": disc_room,
            "mrn": disc_mrn,
            "name": p_name,
            "physician": match_rec.physician if match_rec else "",
            "contractor": match_rec.contractor if match_rec else "",
            "date": (match_rec.admission_date if match_rec else "") or "",
            "dischargeDate": cairo_time_str,
            "dischargeType": "manual",
            "source": "hmis_pending_discharge",
            "rawRow": build_raw_row_from_record(match_rec),
        })
        manual_names.append(p_name)
        if disc_mrn:
            manual_mrns.add(disc_mrn)
        manual_discharges.append({
            "name": p_name,
            "mrn": disc_mrn,
            "discharge_date": cairo_time_str,
            "room": disc_room,
        })
        log(f"[HMIS Pending] Added to cumulative discharged: {label}")
    if new_count:
        log(f"[HMIS Pending] {new_count} new case(s) {'detected (dry-run, nothing written)' if dry_run else 'added'}.")
    return new_count


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
    """Matches server.ts KEYWORDS_TO_EXCLUDE + isOperatingRoom + isCompanionBed for 100% census & subsheet parity."""
    if is_operating_room_bed(bed) or is_companion_bed(bed):
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
        has_mrn_col = False
        source_alias = best_from[0].get("Name", "b") if best_from else "b"
        entity_name = best_from[0].get("Entity", "BedOccupancyMedicalDirector_soussi") if best_from else "BedOccupancyMedicalDirector_soussi"
        for s_item in best_selects:
            q_name = s_item.get("Name", "")
            disp_name = s_item.get("NativeReferenceName") or (
                s_item.get("Column", {}).get("Property")
                or s_item.get("Aggregation", {}).get("Expression", {}).get("Column", {}).get("Property")
                or q_name.split(".")[-1]
            )
            if str(disp_name).strip().lower() == "mrn":
                has_mrn_col = True
            s_copy = {k: v for k, v in s_item.items() if k != "NativeReferenceName"}
            clean_selects.append(s_copy)
            export_cols.append({"QueryName": q_name, "Name": disp_name})
        if not has_mrn_col:
            mrn_qname = f"{entity_name}.MRN"
            clean_selects.append({
                "Column": {
                    "Expression": {"SourceRef": {"Source": source_alias}},
                    "Property": "MRN"
                },
                "Name": mrn_qname
            })
            export_cols.append({"QueryName": mrn_qname, "Name": "MRN"})
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
_last_known_mrns_by_name: dict[str, str] = {}
_in_memory_or_count: int = 0
_last_synced_or_hash: str = ""
_last_synced_or_cairo_date: str = ""
_last_or_sync_ts: float = 0.0


def fetch_powerbi_and_sync(max_attempts: int = 4) -> bool:
    """Executes single-pass live synchronization between Power BI, Relational Postgres, and RTDB."""
    global _last_synced_df_hash, _last_synced_cairo_date, _last_synced_meta_updated_at, _last_known_mrns_by_name
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
            pending_cases = fetch_hmis_pending_discharges() if HMIS_PENDING_ENABLED else []

            # Same-day content hash deduplication (P1 Egress Optimization):
            # If Power BI AND HMIS Pending Discharge exported the exact same records on the same Cairo date,
            # and no external dashboard edit occurred in Supabase since our last commit, skip redundant upsert.
            current_df_hash = compute_sync_content_hash(raw_records, pending_cases)
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
            manual_discharges = existing.get("manual_discharges", [])
            if manual_names or manual_mrns:
                log(f"[Sync Guard] Active manual discharges recognized: {len(manual_names)} names, {len(manual_mrns)} MRNs.")

            # Build phonebook lookup from existing registry & occupancy so fallback visual queries retain known MRNs
            known_mrns_by_name: dict[str, str] = {}
            for rk, rv in (existing.get("registry") or {}).items():
                if isinstance(rv, dict):
                    r_name = str(rv.get("name") or rk or "").strip()
                    r_mrn = clean_mrn_str(rv.get("mrn"))
                    if r_name and r_mrn and not r_mrn.startswith("UNKNOWN-") and any(c.isdigit() for c in r_mrn):
                        norm_rn = normalize_arabic_name(r_name)
                        if norm_rn:
                            known_mrns_by_name[norm_rn] = r_mrn
            for occ_r in (existing.get("occupancy_current") or []):
                if isinstance(occ_r, (list, tuple)) and len(occ_r) >= 4:
                    c2 = clean_mrn_str(occ_r[2])
                    c3 = str(occ_r[3] or "").strip()
                    if c2 and c3 and not c2.startswith("UNKNOWN-") and any(c.isdigit() for c in c2) and not any("\u0600" <= ch <= "\u06FF" for ch in c2):
                        norm_rn = normalize_arabic_name(c3)
                        if norm_rn:
                            known_mrns_by_name[norm_rn] = c2

            # 2. Unified Single-Pass Parsing & Domain Classification
            records: list[NormalizedPatientRecord] = []
            for row in raw_records:
                raw_bed = str(get_val(row, ["Bed#", "BedName_EN", "Bed", "Room", "Bed No", "الغرفة", "غرفة", "السرير", "سرير", "Unnamed: 1"])).strip()
                bed_str = clean_room_str(raw_bed)
                # Skip header row, empty beds, or companion beds
                if not bed_str or bed_str.lower() in ("bed#", "bed", "room", "الغرفة", "غرفة", "السرير", "سرير", "unnamed: 1") or "no filters" in bed_str.lower() or is_companion_bed(bed_str):
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

                if not clean_m:
                    norm_pn = normalize_arabic_name(p_name)
                    if norm_pn and norm_pn in known_mrns_by_name:
                        clean_m = known_mrns_by_name[norm_pn]

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
                if rec.clean_mrn and rec.name:
                    norm_rn = normalize_arabic_name(rec.name)
                    if norm_rn:
                        known_mrns_by_name[norm_rn] = rec.clean_mrn

            _last_known_mrns_by_name = dict(known_mrns_by_name)

            # 2b. Reconcile HMIS Nurse Portal "Pending Discharge" cases (with companion scrub, override respect & auto-reversal)
            restored_hmis_overrides = existing.get("restored_hmis_overrides") or []
            pre_hmis_discharged = [dict(dp) for dp in (existing.get("discharged") or []) if isinstance(dp, dict)]
            if HMIS_PENDING_ENABLED:
                reconcile_hmis_pending_discharges(
                    pending_cases=pending_cases,
                    records=records,
                    already_disc=existing.get("discharged", []),
                    manual_names=manual_names,
                    manual_mrns=manual_mrns,
                    manual_discharges=manual_discharges,
                    restored_overrides=restored_hmis_overrides,
                    cairo_time_str=cairo_time_str,
                    dry_run=HMIS_PENDING_DRY_RUN,
                )

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
                # Guard against manually discharged patients (skip only if NOT re-admitted after discharge)
                if is_patient_manually_discharged(
                    rec.name, rec.clean_mrn, manual_names, manual_mrns,
                    admission_date=rec.admission_date, manual_discharges=manual_discharges
                ):
                    continue
                if (rec.clean_mrn and rec.clean_mrn in manual_mrns) or any(is_name_match(rec.name, mn) for mn in manual_names):
                    log(f"[Sync Guard] Re-admission detected after manual discharge: {rec.name} (MRN {rec.clean_mrn or rec.mrn}, {rec.bed}, adm {rec.admission_date}) — keeping active.")
                    manual_names = [mn for mn in manual_names if not is_name_match(rec.name, mn)]
                    if rec.clean_mrn:
                        manual_mrns.discard(rec.clean_mrn)

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
            powerbi_vip_admission_candidates: list[dict[str, Any]] = []
            for p in today_entries:
                p_name = p.get("name", "").strip()
                p_mrn = clean_mrn_str(p.get("mrn", ""))
                if not any(
                    is_name_match(ex.get("name"), p_name)
                    or (p_mrn and not p_mrn.startswith("UNKNOWN-") and clean_mrn_str(ex.get("mrn")) == p_mrn)
                    for ex in cumulative_entries
                ):
                    cumulative_entries.append(p)
                    powerbi_vip_admission_candidates.append(p)

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
            discharged_list: list[dict[str, Any]] = [
                dp for dp in (existing.get("discharged") or [])
                if not (isinstance(dp, dict) and (dp.get("isCompanion") or is_companion_bed(dp.get("room") or "")))
            ]
            powerbi_vip_discharge_candidates: list[dict[str, Any]] = []
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
                                disc_entry = {
                                    "room": prev_r,
                                    "mrn": pv.get("mrn") or "",
                                    "name": pv.get("name") or "",
                                    "physician": pv.get("physician") or "",
                                    "contractor": pv.get("contractor") or "",
                                    "date": pv.get("date") or "",
                                    "dischargeDate": cairo_time_str,
                                    "dischargeType": "manual" if is_man else "auto",
                                }
                                discharged_list.append(disc_entry)
                                if not is_man:
                                    powerbi_vip_discharge_candidates.append(disc_entry)

                    # Option A: Alert immediately on new HMIS FinancialDischarge OR once raw Power BI drops them
                    powerbi_vip_discharge_candidates.extend(
                        collect_hmis_option_a_vip_candidates(discharged_list, pre_hmis_discharged, records)
                    )

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
                # Reconcile stale manual-upload admissions superseded by this live Power BI batch
                if len(rpc_payload) > 0:
                    try:
                        stale_res = session.get(
                            f"{SUPABASE_URL}/rest/v1/admissions?status=eq.Admitted&source=eq.manual&select=id,admission_date",
                            timeout=15,
                            verify=SUPABASE_SSL_VERIFY,
                        )
                        if stale_res.status_code == 200:
                            stale_rows = stale_res.json() or []
                            if stale_rows:
                                stale_ids = [r["id"] for r in stale_rows if isinstance(r, dict) and r.get("id")]
                                if stale_ids:
                                    id_filter = ",".join(stale_ids)
                                    session.patch(
                                        f"{SUPABASE_URL}/rest/v1/admissions?id=in.({id_filter})",
                                        headers={"Prefer": "return=minimal"},
                                        json={"status": "Discharged", "discharge_date": now_iso, "updated_at": now_iso},
                                        timeout=15,
                                        verify=SUPABASE_SSL_VERIFY,
                                    )
                                    log(f"[Relational Parity] Reconciled {len(stale_ids)} stale manual-upload admission(s) superseded by Power BI.")
                    except Exception as parity_err:
                        log(f"[Relational Parity] Notice: stale manual reconciliation skipped: {parity_err}", level="warning")

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
                        "restoredHmisOverrides": [] if (is_1159_pm or existing.get("is_new_day") or existing.get("is_system_reset")) else restored_hmis_overrides,
                        "vipDischargeNotified": [] if (is_1159_pm or existing.get("is_new_day") or existing.get("is_system_reset")) else (existing.get("vip_discharge_notified") or []),
                        "vipAdmissionNotified": [] if (is_1159_pm or existing.get("is_new_day") or existing.get("is_system_reset")) else (existing.get("vip_admission_notified") or []),
                        "vipDischargeAutomationPaused": bool(existing.get("vip_discharge_automation_paused", False)),
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
                            "orList": max(
                                int(existing.get("orListCount") or len(existing.get("orList") or [])),
                                _in_memory_or_count if _last_synced_or_cairo_date == cairo_date_str else 0
                            )
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
                if (
                    deduplicated_records
                    and (powerbi_vip_discharge_candidates or powerbi_vip_admission_candidates)
                    and not is_1159_pm
                    and not existing.get("is_new_day")
                    and not existing.get("is_system_reset")
                ):
                    dispatch_vip_sync_events_to_vercel(
                        discharges=powerbi_vip_discharge_candidates,
                        admissions=powerbi_vip_admission_candidates,
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


# --- OPERATING ROOM (OR) SHEET POWER BI AUTO-SYNC (EVERY 2 HOURS) ---

def get_or_powerbi_model_id(auth: Optional[Any] = None) -> str:
    """Dynamically retrieves the active OR report modelId from modelsAndExploration, falling back to 1135690937."""
    fallback_id = "1135690937"
    try:
        report_base = POWERBI_OR_EXPORT_URL.rsplit("/export/", 1)[0]
        meta_url = f"{report_base}/modelsAndExploration"
        resp = requests.get(meta_url, auth=auth, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            models = data.get("models", [])
            if models and "id" in models[0]:
                return str(models[0]["id"])
    except Exception as e:
        log(f"Notice: OR dynamic modelId discovery fallback to {fallback_id}: {e}", level="warning")
    return fallback_id


def build_or_powerbi_payload(
    model_id: str,
    cairo_now: datetime.datetime,
    start_date: Optional[datetime.date] = None,
    end_date: Optional[datetime.date] = None,
) -> dict[str, Any]:
    """Constructs the executeSemanticQueryRequest payload for the Power BI OR schedule report.
    Always filters StartDateTime using explicit Cairo dates (never Power BI UTC Now(), which
    returns yesterday's list between 00:00 and 01:59 Cairo time).
    When start_date & end_date are provided, also includes StartDateTime in the exported columns."""
    is_range = start_date is not None and end_date is not None
    eff_start = start_date if start_date is not None else cairo_now.date()
    eff_end = end_date if end_date is not None else cairo_now.date()
    start_lit = f"datetime'{eff_start.isoformat()}T00:00:00'"
    end_lit = f"datetime'{eff_end.isoformat()}T23:59:59'"
    date_filter_condition: dict[str, Any] = {
        "Condition": {
            "And": {
                "Left": {
                    "Comparison": {
                        "ComparisonKind": 2,
                        "Left": {"Column": {"Expression": {"SourceRef": {"Source": "o"}}, "Property": "StartDateTime"}},
                        "Right": {"Literal": {"Value": start_lit}},
                    }
                },
                "Right": {
                    "Comparison": {
                        "ComparisonKind": 3,
                        "Left": {"Column": {"Expression": {"SourceRef": {"Source": "o"}}, "Property": "StartDateTime"}},
                        "Right": {"Literal": {"Value": end_lit}},
                    }
                },
            }
        }
    }
    date_label = f"{eff_start.month}/{eff_start.day}/{eff_start.year} - {eff_end.month}/{eff_end.day}/{eff_end.year}"

    select_cols: list[dict[str, Any]] = [
        {"Column": {"Expression": {"SourceRef": {"Source": "o"}}, "Property": "Surgeon Name"}, "Name": "OperationReservation_soussi.EnglishFullName"},
        {"Column": {"Expression": {"SourceRef": {"Source": "o"}}, "Property": "FLClassName"}, "Name": "OperationReservation_soussi.FLClassName"},
        {"Column": {"Expression": {"SourceRef": {"Source": "o"}}, "Property": "FLOperationName"}, "Name": "OperationReservation_soussi.FLOperationName"},
        {"Column": {"Expression": {"SourceRef": {"Source": "o"}}, "Property": "PreparationInstructions"}, "Name": "OperationReservation_soussi.PreparationInstructions"},
        {"Column": {"Expression": {"SourceRef": {"Source": "o"}}, "Property": "OR Room"}, "Name": "OperationReservation_soussi.Room Name"},
        {"Column": {"Expression": {"SourceRef": {"Source": "o"}}, "Property": "ContractorName"}, "Name": "OperationReservation_soussi.ContractorName"},
        {"Column": {"Expression": {"SourceRef": {"Source": "o"}}, "Property": "PaidBy"}, "Name": "OperationReservation_soussi.PaidBy"},
        {"Column": {"Expression": {"SourceRef": {"Source": "o"}}, "Property": "SLOperationName"}, "Name": "OperationReservation_soussi.SLOperationName"},
        {"Column": {"Expression": {"SourceRef": {"Source": "o"}}, "Property": "VT"}, "Name": "OperationReservation_soussi.Visit Type"},
        {"Column": {"Expression": {"SourceRef": {"Source": "o"}}, "Property": "Start Time"}, "Name": "OperationReservation_soussi.Start Time"},
        {"Column": {"Expression": {"SourceRef": {"Source": "o"}}, "Property": "End Time"}, "Name": "OperationReservation_soussi.End Time"},
        {"Column": {"Expression": {"SourceRef": {"Source": "o"}}, "Property": "Post C"}, "Name": "OperationReservation_soussi.PostRoomCategoryGUID"},
        {"Column": {"Expression": {"SourceRef": {"Source": "o"}}, "Property": "OperativeComment"}, "Name": "OperationReservation_soussi.OperativeComment"},
        {"Column": {"Expression": {"SourceRef": {"Source": "o"}}, "Property": "i/o"}, "Name": "OperationReservation_soussi.InOutReservationType"},
        {"Column": {"Expression": {"SourceRef": {"Source": "o"}}, "Property": "MRN"}, "Name": "OperationReservation_soussi.MRN"},
        {"Column": {"Expression": {"SourceRef": {"Source": "o"}}, "Property": "Patient Name"}, "Name": "OperationReservation_soussi.Patient Name"},
        {"Column": {"Expression": {"SourceRef": {"Source": "o"}}, "Property": "OverWeight"}, "Name": "oPERAT.OverWeight", "NativeReferenceName": "OverWeight"},
    ]

    export_cols: list[dict[str, Any]] = [
        {"QueryName": "OperationReservation_soussi.EnglishFullName", "Name": "Surgeon Name"},
        {"QueryName": "OperationReservation_soussi.FLClassName", "Name": "FLClassName"},
        {"QueryName": "OperationReservation_soussi.FLOperationName", "Name": "FLOperationName"},
        {"QueryName": "OperationReservation_soussi.PreparationInstructions", "Name": "PreparationInstructions"},
        {"QueryName": "OperationReservation_soussi.Room Name", "Name": "OR Room"},
        {"QueryName": "OperationReservation_soussi.ContractorName", "Name": "ContractorName"},
        {"QueryName": "OperationReservation_soussi.PaidBy", "Name": "PaidBy"},
        {"QueryName": "OperationReservation_soussi.SLOperationName", "Name": "SLOperationName"},
        {"QueryName": "OperationReservation_soussi.Visit Type", "Name": "VT"},
        {"QueryName": "OperationReservation_soussi.Start Time", "Name": "Start Time"},
        {"QueryName": "OperationReservation_soussi.End Time", "Name": "End Time"},
        {"QueryName": "OperationReservation_soussi.PostRoomCategoryGUID", "Name": "Post C"},
        {"QueryName": "OperationReservation_soussi.OperativeComment", "Name": "OperativeComment"},
        {"QueryName": "OperationReservation_soussi.InOutReservationType", "Name": "i/o"},
        {"QueryName": "OperationReservation_soussi.MRN", "Name": "MRN"},
        {"QueryName": "OperationReservation_soussi.Patient Name", "Name": "Patient Name"},
        {"QueryName": "oPERAT.OverWeight", "Name": "OverWeight"},
    ]

    projections = list(range(17))
    ordering = [9, 10, 15, 14, 2, 7, 0, 3, 4, 5, 6, 8, 11, 12, 13, 1, 16]
    order_by: list[dict[str, Any]] = [
        {"Direction": 1, "Expression": {"Column": {"Expression": {"SourceRef": {"Source": "o"}}, "Property": "Start Time"}}}
    ]

    if is_range:
        select_cols.append(
            {"Column": {"Expression": {"SourceRef": {"Source": "o"}}, "Property": "StartDateTime"}, "Name": "OperationReservation_soussi.StartDateTime"}
        )
        export_cols.append(
            {"QueryName": "OperationReservation_soussi.StartDateTime", "Name": "StartDateTime"}
        )
        projections.append(17)
        ordering = [17] + ordering
        order_by.insert(
            0,
            {"Direction": 1, "Expression": {"Column": {"Expression": {"SourceRef": {"Source": "o"}}, "Property": "StartDateTime"}}},
        )

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
                                        "From": [{"Name": "o", "Entity": "oPERAT", "Type": 0}],
                                        "Select": select_cols,
                                        "Where": [
                                            {
                                                "Condition": {
                                                    "In": {
                                                        "Expressions": [{"Column": {"Expression": {"SourceRef": {"Source": "o"}}, "Property": "Status"}}],
                                                        "Values": [[{"Literal": {"Value": "'Completed'"}}], [{"Literal": {"Value": "'Scheduled'"}}], [{"Literal": {"Value": "'InOR'"}}]],
                                                    }
                                                }
                                            },
                                            {
                                                "Condition": {
                                                    "Not": {
                                                        "Expression": {
                                                            "In": {
                                                                "Expressions": [{"Column": {"Expression": {"SourceRef": {"Source": "o"}}, "Property": "ORStatus"}}],
                                                                "Values": [[{"Literal": {"Value": "'Cancel'"}}]],
                                                            }
                                                        }
                                                    }
                                                }
                                            },
                                            {
                                                "Condition": {
                                                    "Not": {
                                                        "Expression": {
                                                            "In": {
                                                                "Expressions": [{"Column": {"Expression": {"SourceRef": {"Source": "o"}}, "Property": "FLOperationName"}}],
                                                                "Values": [[{"Literal": {"Value": "null"}}]],
                                                            }
                                                        }
                                                    }
                                                }
                                            },
                                            date_filter_condition,
                                            {
                                                "Condition": {
                                                    "Not": {
                                                        "Expression": {
                                                            "In": {
                                                                "Expressions": [{"Column": {"Expression": {"SourceRef": {"Source": "o"}}, "Property": "OR Room"}}],
                                                                "Values": [
                                                                    [{"Literal": {"Value": "'Cath Lab Theatre'"}}],
                                                                    [{"Literal": {"Value": "'CathLab Operation Theatre 2'"}}],
                                                                    [{"Literal": {"Value": "'Endoscopy Operation Theatre'"}}],
                                                                ],
                                                            }
                                                        }
                                                    }
                                                }
                                            },
                                        ],
                                        "OrderBy": order_by,
                                    },
                                    "Binding": {
                                        "Primary": {"Groupings": [{"Projections": projections, "Subtotal": 0}]},
                                        "DataReduction": {"Primary": {"Top": {"Count": 1000000}}, "Secondary": {"Top": {"Count": 100}}},
                                        "Version": 1,
                                    },
                                }
                            },
                            {
                                "ExportDataCommand": {
                                    "Columns": export_cols,
                                    "Ordering": ordering,
                                    "FiltersDescription": (
                                        "Applied filters:\nStatus is Completed, Scheduled, or InOR\n"
                                        "ORStatus is not Cancel\nFLOperationName is not (Blank)\n"
                                        f"StartDateTime {date_label}\n"
                                        "OR Room is not Cath Lab Theatre, CathLab Operation Theatre 2, or Endoscopy Operation Theatre"
                                    ),
                                }
                            },
                        ]
                    }
                }
            ],
            "cancelQueries": [],
            "modelId": model_id,
            "userPreferredLocale": "en-US",
        },
    }


def _parse_powerbi_or_excel_internal(
    excel_bytes: bytes,
    cairo_date_str: str,
    known_mrns_by_name: dict[str, str],
    group_by_date: bool = False,
) -> tuple[dict[str, list[dict[str, Any]]], bool]:
    """Internal parser returning (cases_by_date, header_found)."""
    df = pd.read_excel(io.BytesIO(excel_bytes), header=None)
    if df.empty:
        return {}, False

    header_row_idx = -1
    for r_idx in range(min(10, len(df))):
        row_strs = [
            str(x).lower().strip()
            for x in df.iloc[r_idx].values
            if pd.notna(x) and "\n" not in str(x) and "applied filters" not in str(x).lower()
        ]
        if len(row_strs) >= 3 and any("start time" in s or "patient name" in s or "floperationname" in s for s in row_strs):
            header_row_idx = r_idx
            break

    if header_row_idx < 0:
        return {}, False

    headers = [str(x).strip().lower() if pd.notna(x) else "" for x in df.iloc[header_row_idx].values]

    def find_col_idx(possible_names: list[str], fallback: int = -1) -> int:
        for name in possible_names:
            nl = name.lower()
            for idx, h in enumerate(headers):
                if h == nl:
                    return idx
        for name in possible_names:
            nl = name.lower()
            if len(nl) <= 3:
                continue
            for idx, h in enumerate(headers):
                if nl in h:
                    return idx
        return fallback

    idx_start_dt = find_col_idx(["startdatetime", "start date", "scheduled date"], -1)
    idx_serial = find_col_idx(["serial", "column 1", "م", "#"], -1)
    idx_start = find_col_idx(["start time", "starttime", "وقت البدء"], 0)
    idx_end = find_col_idx(["end time", "endtime", "وقت الانتهاء"], 1)
    idx_patient = find_col_idx(["patient name", "patient", "اسم المريض"], 2)
    idx_mrn = find_col_idx(["mrn", "رقم الملف", "ملف"], 3)
    idx_eng_op = find_col_idx(["floperationname", "eng. operation name", "operation name", "العملية"], 4)
    idx_ar_op = find_col_idx(["sloperationname", "ar. operation name", "اسم العملية عربي"], 5)
    idx_surgeon = find_col_idx(["surgeon name", "surgeon", "الجراح"], 6)
    idx_col2 = find_col_idx(["preparationinstructions", "preparation instructions", "column2"], 7)
    idx_or_room = find_col_idx(["or room", "room name", "غرفة العمليات"], 8)
    idx_contractor = find_col_idx(["contractorname", "contractor name", "contractor", "الجهة"], 9)
    idx_paid_by = find_col_idx(["paidby", "paid by", "الدفع"], 10)
    idx_vt = find_col_idx(["vt", "visit type", "نوع الزيارة"], 11)
    idx_post_c = find_col_idx(["post c", "postroomcategoryguid", "post"], 12)
    idx_comment = find_col_idx(["operativecomment", "operative comment", "ملاحظات"], 13)
    idx_col3 = find_col_idx(["i/o", "inoutreservationtype", "column3"], 14)
    idx_class = find_col_idx(["flclassname", "class"], 15)
    idx_fin = find_col_idx(["overweight", "financial status", "الحالة المالية"], 16)

    def cell_str(row_vals: Any, idx: int) -> str:
        if idx < 0 or idx >= len(row_vals):
            return ""
        v = row_vals[idx]
        if v is None or pd.isna(v):
            return ""
        s = re.sub(r"\s+", " ", str(v).replace("\xa0", " ")).strip()
        if s.lower() in ("nan", "null", "none"):
            return ""
        return s

    grouped_cases: dict[str, dict[str, Any]] = {}
    ordered_keys: list[str] = []

    for r_idx in range(header_row_idx + 1, len(df)):
        row_vals = df.iloc[r_idx].values
        patient_name = cell_str(row_vals, idx_patient)
        or_room = cell_str(row_vals, idx_or_room)
        raw_mrn = cell_str(row_vals, idx_mrn)
        surgeon = cell_str(row_vals, idx_surgeon)

        if not patient_name and not or_room and not surgeon:
            continue
        if patient_name.lower() in ("patient name", "total", "applied filters:"):
            continue

        row_date_str = cairo_date_str
        if group_by_date and idx_start_dt >= 0 and idx_start_dt < len(row_vals):
            parsed_comps = _parse_unified_date_components(row_vals[idx_start_dt])
            if parsed_comps:
                yr, mo, dy, _, _ = parsed_comps
                row_date_str = f"{yr:04d}-{mo:02d}-{dy:02d}"
            else:
                continue

        clean_m = clean_mrn_str(raw_mrn)
        if not clean_m and patient_name:
            norm_pn = normalize_arabic_name(patient_name)
            if norm_pn and norm_pn in known_mrns_by_name:
                clean_m = known_mrns_by_name[norm_pn]
            else:
                for k_norm, k_mrn in known_mrns_by_name.items():
                    if is_name_match(k_norm, norm_pn):
                        clean_m = k_mrn
                        break

        raw_start = row_vals[idx_start] if (0 <= idx_start < len(row_vals)) else ""
        raw_end = row_vals[idx_end] if (0 <= idx_end < len(row_vals)) else ""
        start_12h = format_time_12h(raw_start)
        end_12h = format_time_12h(raw_end)

        eng_op = cell_str(row_vals, idx_eng_op)
        ar_op = cell_str(row_vals, idx_ar_op)
        col2_val = cell_str(row_vals, idx_col2)
        col3_val = cell_str(row_vals, idx_col3)
        contractor_val = cell_str(row_vals, idx_contractor)
        paid_by_val = cell_str(row_vals, idx_paid_by)
        post_c_val = cell_str(row_vals, idx_post_c)
        vt_val = cell_str(row_vals, idx_vt)
        comment_val = cell_str(row_vals, idx_comment)
        class_val = cell_str(row_vals, idx_class)
        fin_val = cell_str(row_vals, idx_fin)

        norm_key_name = normalize_arabic_name(patient_name) or patient_name.lower()
        group_key = f"{row_date_str}|{clean_m or norm_key_name}|{start_12h}|{or_room.lower()}"

        if group_key not in grouped_cases:
            ordered_keys.append(group_key)
            grouped_cases[group_key] = {
                "serial": str(len(ordered_keys)),
                "startTime": start_12h,
                "endTime": end_12h,
                "patientName": patient_name,
                "mrn": clean_m,
                "engOperationName": eng_op,
                "arOperationName": ar_op,
                "surgeonName": surgeon,
                "column2": col2_val,
                "orRoom": or_room,
                "column3": col3_val,
                "contractorName": contractor_val,
                "paidBy": paid_by_val,
                "postC": post_c_val,
                "vt": vt_val,
                "operativeComment": comment_val,
                "flClassName": class_val,
                "financialStatus": fin_val,
                "orListDate": row_date_str,
            }
        else:
            existing_case = grouped_cases[group_key]
            for field_name, new_val in (
                ("engOperationName", eng_op),
                ("arOperationName", ar_op),
                ("surgeonName", surgeon),
                ("column2", col2_val),
                ("operativeComment", comment_val),
            ):
                if new_val:
                    curr_parts = [p.strip() for p in existing_case[field_name].split(" / ") if p.strip()]
                    if new_val not in curr_parts:
                        curr_parts.append(new_val)
                        existing_case[field_name] = " / ".join(curr_parts)
            if not existing_case["mrn"] and clean_m:
                existing_case["mrn"] = clean_m
            if not existing_case["contractorName"] and contractor_val:
                existing_case["contractorName"] = contractor_val
            if not existing_case["paidBy"] and paid_by_val:
                existing_case["paidBy"] = paid_by_val
            if not existing_case["postC"] and post_c_val:
                existing_case["postC"] = post_c_val
            if not existing_case["vt"] and vt_val:
                existing_case["vt"] = vt_val
            if not existing_case["flClassName"] and class_val:
                existing_case["flClassName"] = class_val

    cases_by_date: dict[str, list[dict[str, Any]]] = {}
    for k in ordered_keys:
        c = grouped_cases[k]
        d = c["orListDate"]
        bucket = cases_by_date.setdefault(d, [])
        c["serial"] = str(len(bucket) + 1)
        bucket.append(c)
    return cases_by_date, True


def parse_powerbi_or_excel(
    excel_bytes: bytes,
    cairo_date_str: str,
    known_mrns_by_name: dict[str, str],
) -> list[dict[str, Any]]:
    """Parses Power BI OR Schedule Excel bytes into the exact 19-field OR case schema with 12-hour Start/End times
    and merges multi-procedure rows for the same patient/session into a single OR case row."""
    by_date, _ = _parse_powerbi_or_excel_internal(excel_bytes, cairo_date_str, known_mrns_by_name, group_by_date=False)
    return by_date.get(cairo_date_str, [])


def parse_powerbi_or_excel_by_date(
    excel_bytes: bytes,
    default_date_str: str,
    known_mrns_by_name: dict[str, str],
) -> tuple[dict[str, list[dict[str, Any]]], bool]:
    """Parses a multi-day Power BI OR Schedule Excel export into {YYYY-MM-DD: [cases]} plus header_found."""
    return _parse_powerbi_or_excel_internal(excel_bytes, default_date_str, known_mrns_by_name, group_by_date=True)


def week_windows(today: datetime.date, weeks: int) -> list[tuple[datetime.date, datetime.date]]:
    """Returns sequential 7-day future windows starting at today+1: [(D+1, D+7), (D+8, D+14), ...]."""
    windows: list[tuple[datetime.date, datetime.date]] = []
    for w in range(max(0, weeks)):
        w_start = today + datetime.timedelta(days=1 + w * 7)
        w_end = today + datetime.timedelta(days=7 + w * 7)
        windows.append((w_start, w_end))
    return windows


def compute_or_cases_hash(cases: list[dict[str, Any]]) -> str:
    """Computes a deterministic SHA-256 hash for a list of OR case dicts."""
    return hashlib.sha256(
        json.dumps(cases, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()


def or_case_reconcile_key(case: dict[str, Any]) -> str:
    """Builds the stable identity key for diffing OR cases within a single date."""
    mrn = str(case.get("mrn") or "").strip()
    if mrn:
        return f"mrn:{mrn}"
    norm_name = normalize_arabic_name(case.get("patientName") or "") or str(case.get("patientName") or "").lower().strip()
    start = str(case.get("startTime") or "").strip()
    room = str(case.get("orRoom") or "").lower().strip()
    return f"name:{norm_name}|{start}|{room}"


def reconcile_or_date(
    date_str: str,
    today_str: str,
    new_cases: list[dict[str, Any]],
    stored_cases: Optional[list[dict[str, Any]]],
    stored_hash: Optional[str],
    consecutive_empty_counts: dict[str, int],
) -> dict[str, Any]:
    """Computes per-date reconciliation result (added/removed/changed, hash, skip reason, empty-guard)."""
    if date_str <= today_str:
        return {
            "date": date_str,
            "skip": True,
            "reason": "not_future",
            "hash": "",
            "diff": {"added": 0, "removed": 0, "changed": 0},
        }

    new_hash = compute_or_cases_hash(new_cases)
    if stored_hash is not None and new_hash == stored_hash:
        consecutive_empty_counts[date_str] = 0
        return {
            "date": date_str,
            "skip": True,
            "reason": "hash_match",
            "hash": new_hash,
            "diff": {"added": 0, "removed": 0, "changed": 0},
        }

    had_previous_cases = bool(stored_cases) or (
        stored_hash is not None and stored_hash != compute_or_cases_hash([])
    )
    if len(new_cases) == 0 and had_previous_cases:
        consecutive_empty_counts[date_str] = consecutive_empty_counts.get(date_str, 0) + 1
        if consecutive_empty_counts[date_str] < 2:
            return {
                "date": date_str,
                "skip": True,
                "reason": "empty_guard",
                "hash": new_hash,
                "diff": {"added": 0, "removed": 0, "changed": 0},
            }
    consecutive_empty_counts[date_str] = 0

    old_map = {or_case_reconcile_key(c): c for c in (stored_cases or [])}
    new_map = {or_case_reconcile_key(c): c for c in new_cases}

    added = sum(1 for k in new_map if k not in old_map)
    removed = sum(1 for k in old_map if k not in new_map)
    changed = sum(
        1 for k, nc in new_map.items()
        if k in old_map and {fk: fv for fk, fv in nc.items() if fk != "serial"} != {fk: fv for fk, fv in old_map[k].items() if fk != "serial"}
    )

    return {
        "date": date_str,
        "skip": False,
        "reason": "changed",
        "hash": new_hash,
        "diff": {"added": added, "removed": removed, "changed": changed},
    }


_last_future_or_sync_ts: float = 0.0
_consecutive_empty_or_dates: dict[str, int] = {}


def _load_known_mrns_cache(session: requests.Session) -> None:
    """Populates _last_known_mrns_by_name from state/registry once if empty."""
    global _last_known_mrns_by_name
    if _last_known_mrns_by_name or not SUPABASE_KEY:
        return
    try:
        reg_res = session.get(
            f"{SUPABASE_REST_URL}?path=eq.state/registry&select=data",
            timeout=10,
            verify=SUPABASE_SSL_VERIFY,
        )
        if reg_res.status_code == 200 and reg_res.json():
            reg_data = (reg_res.json()[0].get("data") or {}).get("patientRoomRegistry") or {}
            for rk, rv in reg_data.items():
                if isinstance(rv, dict):
                    r_name = str(rv.get("name") or rk or "").strip()
                    r_mrn = clean_mrn_str(rv.get("mrn"))
                    if r_name and r_mrn and not r_mrn.startswith("UNKNOWN-") and any(c.isdigit() for c in r_mrn):
                        norm_rn = normalize_arabic_name(r_name)
                        if norm_rn:
                            _last_known_mrns_by_name[norm_rn] = r_mrn
    except Exception:
        pass


def _sync_or_cases_relational(
    cases: list[dict[str, Any]],
    target_date_str: str,
    session: requests.Session,
    use_replace_rpc: bool = False,
) -> None:
    """Syncs OR cases for target_date_str to PostgreSQL via sync_or_cases_for_date (or sync_or_cases fallback)."""
    rpc_cases = []
    for c in cases:
        s_pg = parse_to_pg_time(c.get("startTime"))
        e_pg = parse_to_pg_time(c.get("endTime"))
        if s_pg and e_pg and e_pg < s_pg:
            e_pg = None
        rpc_cases.append({
            **c,
            "startTime": s_pg,
            "endTime": e_pg,
            "orListDate": target_date_str,
        })

    if use_replace_rpc:
        try:
            r = session.post(
                SUPABASE_OR_FOR_DATE_RPC_URL,
                json={"p_date": target_date_str, "payload": rpc_cases},
                timeout=20,
                verify=SUPABASE_SSL_VERIFY,
            )
            if r.status_code < 400:
                return
            if r.status_code != 404:
                log(f"[OR Sync] sync_or_cases_for_date({target_date_str}) returned {r.status_code}: {r.text}", level="warning")
                return
        except Exception as rpc_err:
            log(f"[OR Sync] sync_or_cases_for_date notice: {rpc_err}", level="warning")

    if rpc_cases:
        try:
            session.post(
                SUPABASE_OR_RPC_URL,
                json={"payload": rpc_cases},
                timeout=20,
                verify=SUPABASE_SSL_VERIFY,
            )
        except Exception as rpc_err:
            log(f"[OR Sync] Relational RPC notice (non-fatal): {rpc_err}", level="warning")


def count_or_inpatients(
    or_cases: list[dict[str, Any]],
    active_mrns: Optional[set[str]] = None,
) -> int:
    """Counts OR cases that are actually inpatients (matched to active occupancy MRNs or explicitly column3=IN)."""
    count = 0
    mrn_set = active_mrns or set()
    for c in or_cases or []:
        if not isinstance(c, dict):
            continue
        c_mrn = clean_mrn_str(c.get("mrn"))
        col3 = str(c.get("column3") or "").strip().upper()
        if (c_mrn and c_mrn in mrn_set) or col3 in ("IN", "INPATIENT"):
            count += 1
    return count


def fetch_powerbi_or_and_sync(force: bool = False) -> bool:
    """Fetches same-day OR schedule from Power BI, formats times in 12-hour format, and syncs to Supabase."""
    global _last_synced_or_hash, _last_synced_or_cairo_date, _last_or_sync_ts, _in_memory_or_count, _last_known_mrns_by_name
    try:
        now_dt = datetime.datetime.now(datetime.timezone.utc)
        now_iso = now_dt.isoformat()
        cairo_now = get_cairo_now()
        cairo_date_str = cairo_now.strftime("%Y-%m-%d")

        log("[OR Sync] Fetching live same-day OR schedule from Power BI...")
        auth = HttpNtlmAuth(POWERBI_USER, POWERBI_PASS) if POWERBI_USER else None
        or_model_id = get_or_powerbi_model_id(auth=auth)
        or_payload = build_or_powerbi_payload(or_model_id, cairo_now)

        resp = requests.post(
            POWERBI_OR_EXPORT_URL,
            json=or_payload,
            auth=auth,
            timeout=(10, min(35, POWERBI_TIMEOUT))
        )
        resp.raise_for_status()

        session = get_supabase_session()
        _load_known_mrns_cache(session)

        or_cases = parse_powerbi_or_excel(resp.content, cairo_date_str, _last_known_mrns_by_name)
        _last_or_sync_ts = time.time()
        _in_memory_or_count = len(or_cases)

        current_or_hash = compute_or_cases_hash(or_cases)

        if (
            not force
            and current_or_hash == _last_synced_or_hash
            and cairo_date_str == _last_synced_or_cairo_date
        ):
            # Self-heal if state/or_list in Supabase was cleared (e.g., by a rollover) while cases exist
            should_skip = True
            if SUPABASE_KEY and len(or_cases) > 0:
                try:
                    cur_or_res = session.get(
                        f"{SUPABASE_REST_URL}?path=eq.state/or_list&select=data",
                        timeout=8,
                        verify=SUPABASE_SSL_VERIFY,
                    )
                    if cur_or_res.status_code == 200 and cur_or_res.json():
                        cur_items = (cur_or_res.json()[0].get("data") or {}).get("items") or []
                        if len(cur_items) == 0:
                            should_skip = False
                            log("[OR Sync Self-Heal] state/or_list in Supabase is empty; restoring today's OR list.")
                except Exception:
                    pass
            if should_skip:
                log(f"[OR Sync Dedup] OR schedule ({len(or_cases)} cases) unchanged since last sync; skipping redundant upsert.")
                return True

        if not SUPABASE_KEY:
            log(f"[OR Sync] Parsed {len(or_cases)} OR cases (12-hour format). SUPABASE_KEY not set; skipping DB write.", level="warning")
            return True

        # Check persisted hash in history/or/{today}/summary so restarts & peer runners skip unchanged writes
        if not force:
            try:
                sum_res = session.get(
                    f"{SUPABASE_REST_URL}?path=eq.history/or/{cairo_date_str}/summary&select=data",
                    timeout=10,
                    verify=SUPABASE_SSL_VERIFY,
                )
                if sum_res.status_code == 200 and sum_res.json():
                    sum_data = sum_res.json()[0].get("data") or {}
                    if isinstance(sum_data, dict) and sum_data.get("hash") == current_or_hash:
                        _last_synced_or_hash = current_or_hash
                        _last_synced_or_cairo_date = cairo_date_str
                        log(f"[OR Sync Dedup] OR schedule ({len(or_cases)} cases) matches persisted Supabase hash; skipping redundant upsert.")
                        return True
            except Exception:
                pass

        # 1. Fetch lightweight state/metadata and history/or_index for atomic update
        existing_meta: dict[str, Any] = {}
        existing_or_index: list[dict[str, Any]] = []
        try:
            meta_res = session.get(
                f"{SUPABASE_REST_URL}?path=in.(state/metadata,history/or_index)&select=path,data",
                timeout=12,
                verify=SUPABASE_SSL_VERIFY
            )
            if meta_res.status_code == 200:
                for row in meta_res.json():
                    p = row.get("path")
                    d = row.get("data")
                    if p == "state/metadata" and isinstance(d, dict):
                        existing_meta = d
                    elif p == "history/or_index" and isinstance(d, list):
                        existing_or_index = d
        except Exception as e:
            log(f"[OR Sync] Notice reading metadata/or_index: {e}", level="warning")

        existing_counts = dict(existing_meta.get("counts") or {}) if isinstance(existing_meta.get("counts"), dict) else {}
        existing_counts["orList"] = len(or_cases)

        updated_meta = {
            **existing_meta,
            "uploadedAt": now_iso,
            "lastDatabaseUpdatedAt": now_iso,
            "lastActiveDate": cairo_date_str,
            "counts": existing_counts
        }

        matched_inpatients = count_or_inpatients(or_cases)
        outpatients_cnt = max(0, len(or_cases) - matched_inpatients)
        or_summary = {
            "totalCases": len(or_cases),
            "matched": matched_inpatients,
            "outpatients": outpatients_cnt,
            "hash": current_or_hash,
            "timestamp": int(time.time() * 1000),
            "cairoTime": cairo_now.strftime("%Y-%m-%d %H:%M:%S")
        }

        other_or_index = [
            e for e in existing_or_index
            if isinstance(e, dict) and str(e.get("date", "")).strip() != cairo_date_str
        ]
        today_or_index_entry = {
            "date": cairo_date_str,
            "timestamp": or_summary["timestamp"],
            "cairoTime": or_summary["cairoTime"],
            "summary": {
                "totalCases": len(or_cases),
                "matched": matched_inpatients,
                "outpatients": outpatients_cnt
            }
        }
        updated_or_index = [today_or_index_entry] + other_or_index
        try:
            updated_or_index.sort(key=lambda x: str(x.get("date", "")), reverse=True)
        except Exception:
            pass

        or_nodes = [
            {"path": "state/or_list", "data": {"items": or_cases}, "updated_at": now_iso},
            {"path": "state/metadata", "data": updated_meta, "updated_at": now_iso},
            {"path": f"history/or/{cairo_date_str}/summary", "data": or_summary, "updated_at": now_iso},
            {"path": f"history/or/{cairo_date_str}/cases", "data": or_cases, "updated_at": now_iso},
            {"path": "history/or_index", "data": updated_or_index, "updated_at": now_iso}
        ]

        sb_resp = session.post(SUPABASE_REST_URL, json=or_nodes, timeout=20, verify=SUPABASE_SSL_VERIFY)
        if sb_resp.status_code not in (200, 201, 204):
            log(f"[OR Sync] Supabase RTDB upsert returned {sb_resp.status_code}: {sb_resp.text}", level="warning")
            return False

        # 2. Relational sync via sync_or_cases_for_date (with fallback to sync_or_cases)
        _sync_or_cases_relational(or_cases, cairo_date_str, session, use_replace_rpc=True)

        _last_synced_or_hash = current_or_hash
        _last_synced_or_cairo_date = cairo_date_str
        log(
            f"[OR Sync] Successfully committed {len(or_cases)} OR cases for {cairo_date_str} "
            f"({matched_inpatients} with inpatient MRN, {outpatients_cnt} day-case/unregistered, 12-hour times)."
        )
        return True
    except Exception as e:
        log(f"[OR Sync] Error fetching/syncing OR schedule: {e}", level="error")
        return False


def fetch_powerbi_or_future_and_sync(force: bool = False, dry_run: bool = False) -> bool:
    """Fetches future weeks of OR schedules week-by-week from Power BI, reconciles each future date
    against history/or/{d}/* (hash-first), and saves only changed dates into history + relational or_cases.
    Never touches state/or_list or state/metadata."""
    global _last_future_or_sync_ts
    if not OR_FUTURE_SYNC_ENABLED or OR_FUTURE_WEEKS <= 0:
        return True

    try:
        now_dt = datetime.datetime.now(datetime.timezone.utc)
        now_iso = now_dt.isoformat()
        cairo_now = get_cairo_now()
        today_str = cairo_now.strftime("%Y-%m-%d")
        windows = week_windows(cairo_now.date(), OR_FUTURE_WEEKS)
        if not windows:
            return True

        auth = HttpNtlmAuth(POWERBI_USER, POWERBI_PASS) if POWERBI_USER else None
        or_model_id = get_or_powerbi_model_id(auth=auth)
        session = get_supabase_session()
        if SUPABASE_KEY:
            _load_known_mrns_cache(session)

        changed_index_entries: dict[str, dict[str, Any]] = {}
        total_dates_updated = 0

        for w_idx, (w_start, w_end) in enumerate(windows, start=1):
            log(f"[OR Future] Fetching week {w_idx}/{len(windows)} ({w_start.isoformat()} .. {w_end.isoformat()})...")
            payload = build_or_powerbi_payload(or_model_id, cairo_now, start_date=w_start, end_date=w_end)
            resp = requests.post(
                POWERBI_OR_EXPORT_URL,
                json=payload,
                auth=auth,
                timeout=(10, min(45, POWERBI_TIMEOUT)),
            )
            resp.raise_for_status()

            cases_by_date, header_found = parse_powerbi_or_excel_by_date(
                resp.content, w_start.isoformat(), _last_known_mrns_by_name
            )
            if not header_found:
                log(f"[OR Future] Week {w_idx} header missing/unparseable; skipping window without overwriting history.", level="warning")
                continue

            window_dates: list[str] = []
            cur_d = w_start
            while cur_d <= w_end:
                window_dates.append(cur_d.isoformat())
                cur_d += datetime.timedelta(days=1)

            # Hash-first read: fetch only small summary rows for this 7-day window
            stored_summaries: dict[str, dict[str, Any]] = {}
            if SUPABASE_KEY:
                sum_paths = ",".join(f"history/or/{d}/summary" for d in window_dates)
                try:
                    sum_res = session.get(
                        f"{SUPABASE_REST_URL}?path=in.({sum_paths})&select=path,data",
                        timeout=12,
                        verify=SUPABASE_SSL_VERIFY,
                    )
                    if sum_res.status_code == 200:
                        for row in sum_res.json():
                            p = str(row.get("path") or "")
                            parts = p.split("/")
                            if len(parts) >= 3 and isinstance(row.get("data"), dict):
                                stored_summaries[parts[2]] = row["data"]
                except Exception as e:
                    log(f"[OR Future] Notice reading summaries for week {w_idx}: {e}", level="warning")

            # Identify dates whose hash differs from stored summary hash (or force=True)
            dirty_dates: list[str] = []
            for d_str in window_dates:
                new_cases = cases_by_date.get(d_str, [])
                new_hash = compute_or_cases_hash(new_cases)
                stored_hash = stored_summaries.get(d_str, {}).get("hash") if d_str in stored_summaries else None
                if force or stored_hash is None or new_hash != stored_hash:
                    dirty_dates.append(d_str)

            if not dirty_dates:
                log(f"[OR Future] Week {w_idx} ({w_start}..{w_end}): all 7 dates unchanged (hash match).")
                continue

            # Fetch full stored cases ONLY for dirty dates
            stored_cases_map: dict[str, list[dict[str, Any]]] = {}
            if SUPABASE_KEY and dirty_dates:
                case_paths = ",".join(f"history/or/{d}/cases" for d in dirty_dates)
                try:
                    c_res = session.get(
                        f"{SUPABASE_REST_URL}?path=in.({case_paths})&select=path,data",
                        timeout=15,
                        verify=SUPABASE_SSL_VERIFY,
                    )
                    if c_res.status_code == 200:
                        for row in c_res.json():
                            p = str(row.get("path") or "")
                            parts = p.split("/")
                            if len(parts) >= 3 and isinstance(row.get("data"), list):
                                stored_cases_map[parts[2]] = row["data"]
                except Exception as e:
                    log(f"[OR Future] Notice reading stored cases for week {w_idx}: {e}", level="warning")

            window_nodes: list[dict[str, Any]] = []
            dirty_rpc_batches: list[tuple[str, list[dict[str, Any]]]] = []

            for d_str in dirty_dates:
                new_cases = cases_by_date.get(d_str, [])
                stored_hash = stored_summaries.get(d_str, {}).get("hash") if d_str in stored_summaries else None
                rec = reconcile_or_date(
                    date_str=d_str,
                    today_str=today_str,
                    new_cases=new_cases,
                    stored_cases=stored_cases_map.get(d_str),
                    stored_hash=None if force else stored_hash,
                    consecutive_empty_counts=_consecutive_empty_or_dates,
                )
                if rec["skip"]:
                    if rec["reason"] == "empty_guard":
                        log(f"[OR Future] {d_str}: empty result guarded (1/2 consecutive); keeping stored list.", level="warning")
                    continue

                diff = rec["diff"]
                if dry_run:
                    log(
                        f"[OR Future Dry-Run] {d_str}: {len(new_cases)} cases "
                        f"(+{diff['added']} / -{diff['removed']} / ~{diff['changed']})"
                    )
                    continue

                matched_in = count_or_inpatients(new_cases)
                out_cnt = max(0, len(new_cases) - matched_in)
                ts_ms = int(time.time() * 1000)
                cairo_time_str = cairo_now.strftime("%Y-%m-%d %H:%M:%S")
                summary_obj = {
                    "totalCases": len(new_cases),
                    "matched": matched_in,
                    "outpatients": out_cnt,
                    "kind": "scheduled",
                    "hash": rec["hash"],
                    "diff": diff,
                    "lastRefreshedAt": now_iso,
                    "timestamp": ts_ms,
                    "cairoTime": cairo_time_str,
                }
                window_nodes.append({"path": f"history/or/{d_str}/summary", "data": summary_obj, "updated_at": now_iso})
                window_nodes.append({"path": f"history/or/{d_str}/cases", "data": new_cases, "updated_at": now_iso})
                changed_index_entries[d_str] = {
                    "date": d_str,
                    "isFuture": True,
                    "timestamp": ts_ms,
                    "cairoTime": cairo_time_str,
                    "summary": {
                        "totalCases": len(new_cases),
                        "matched": matched_in,
                        "outpatients": out_cnt,
                        "kind": "scheduled",
                        "diff": diff,
                    },
                }
                dirty_rpc_batches.append((d_str, new_cases))
                total_dates_updated += 1
                log(
                    f"[OR Future] {d_str}: {len(new_cases)} cases "
                    f"(+{diff['added']} / -{diff['removed']} / ~{diff['changed']})"
                )

            if not dry_run and SUPABASE_KEY and window_nodes:
                sb_resp = session.post(SUPABASE_REST_URL, json=window_nodes, timeout=20, verify=SUPABASE_SSL_VERIFY)
                if sb_resp.status_code not in (200, 201, 204):
                    log(f"[OR Future] Supabase RTDB upsert returned {sb_resp.status_code}: {sb_resp.text}", level="warning")
                    continue
                for d_str, d_cases in dirty_rpc_batches:
                    _sync_or_cases_relational(d_cases, d_str, session, use_replace_rpc=True)

        # Single batched read-modify-write of history/or_index if any future date changed
        if not dry_run and SUPABASE_KEY and changed_index_entries:
            try:
                idx_res = session.get(
                    f"{SUPABASE_REST_URL}?path=eq.history/or_index&select=data",
                    timeout=12,
                    verify=SUPABASE_SSL_VERIFY,
                )
                existing_idx: list[dict[str, Any]] = []
                if idx_res.status_code == 200 and idx_res.json():
                    raw_idx = idx_res.json()[0].get("data")
                    if isinstance(raw_idx, list):
                        existing_idx = raw_idx

                kept_existing = [
                    e for e in existing_idx
                    if isinstance(e, dict) and str(e.get("date", "")).strip() not in changed_index_entries
                ]
                merged_idx = list(changed_index_entries.values()) + kept_existing
                merged_idx.sort(key=lambda x: str(x.get("date", "")), reverse=True)

                session.post(
                    SUPABASE_REST_URL,
                    json=[{"path": "history/or_index", "data": merged_idx, "updated_at": now_iso}],
                    timeout=15,
                    verify=SUPABASE_SSL_VERIFY,
                )
            except Exception as idx_err:
                log(f"[OR Future] Notice updating history/or_index: {idx_err}", level="warning")

        _last_future_or_sync_ts = time.time()
        log(f"[OR Future] Cycle complete ({total_dates_updated} future date(s) updated).")
        return True
    except Exception as e:
        log(f"[OR Future] Error fetching/syncing future OR schedules: {e}", level="error")
        return False


def run_or_full_cycle(force: bool = False, force_future: Optional[bool] = None) -> bool:
    """Runs today's live OR sync first, then future weekly OR history reconciliation (non-fatal),
    and Cath Lab / Endoscopy schedules into isolated feeds/* nodes (non-fatal)."""
    today_ok = fetch_powerbi_or_and_sync(force=force)
    try:
        ff = force if force_future is None else force_future
        fetch_powerbi_or_future_and_sync(force=ff)
    except Exception as e:
        log(f"[OR Future] Non-fatal cycle error: {e}", level="warning")
    try:
        fetch_powerbi_procedures_and_sync(force=force)
    except Exception as e:
        log(f"[Procedures Sync] Non-fatal cycle error: {e}", level="warning")
    return today_ok


def run_or_sync_job(force: bool = False) -> None:
    """Executes the scheduled 2-hour OR schedule sync job."""
    if _is_paused and not force:
        log("[OR Sync Paused] Skipping scheduled OR sync cycle while paused.")
        return
    fortinet_reconnect()
    run_or_full_cycle(force=force)
    publish_standalone_heartbeat()


# --- OPD DOCTORS SCHEDULE POWER BI SYNC (STARTUP + DAILY 22:00 CAIRO PURGE & NEXT-DAY FETCH) ---

OPD_EXCLUDED_PHYSICIANS: Final[list[str]] = [
    "'Hydrotherapy   Session Room'",
    "'Abokir for Petroleum Checkup'",
    "'Check up   Brimton'",
    "'Female Checkup  Program'",
    "'Female Checkup Program 50+'",
    "'GIG Egypt Check up'",
    "'Male Checkup  Program'",
    "'Male Checkup Program 40+'",
    "'Lab   Reservation'",
    "'Male Checkup Program 50+'",
    "'Online   Consultation'",
    "'GCC   CLINIC'",
    "'Home   Care'",
    "'Mother''s day offer'",
    "'Physiotherapy   Session Room 1'",
    "'فحص   عجيبه'",
    "'Free  Mummy  Club'",
]

_last_opd_sync_ts: float = 0.0
_last_opd_hash: str = ""
_last_opd_target_date: str = ""
_last_opd_2200_done_date: str = ""
_last_opd_2200_attempt_ts: float = 0.0
_opd_2200_retry_needed: bool = False


def get_opd_target_date(now_cairo: Optional[datetime.datetime] = None) -> datetime.date:
    """Returns Cairo today before 22:00, and Cairo tomorrow at/after 22:00."""
    dt = now_cairo or get_cairo_now()
    if dt.hour >= 22:
        return dt.date() + datetime.timedelta(days=1)
    return dt.date()


def get_opd_powerbi_model_id(auth: Optional[Any] = None) -> str:
    """Dynamically retrieves the active OPD report modelId from modelsAndExploration, falling back to 235524464."""
    fallback_id = "235524464"
    try:
        report_base = POWERBI_OPD_EXPORT_URL.rsplit("/export/", 1)[0]
        meta_url = f"{report_base}/modelsAndExploration"
        resp = requests.get(meta_url, auth=auth, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            models = data.get("models", [])
            if models and "id" in models[0]:
                return str(models[0]["id"])
    except Exception as e:
        log(f"Notice: OPD dynamic modelId discovery fallback to {fallback_id}: {e}", level="warning")
    return fallback_id


def build_opd_powerbi_payload(model_id: str, target_date: datetime.date) -> dict[str, Any]:
    """Constructs the 12-column tableEx SemanticQuery payload for the OPD Doctors Sheet for target_date."""
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
                                        "From": [
                                            {"Name": "r", "Entity": "ResourceSchedule_Soussi", "Type": 0},
                                            {"Name": "f1", "Entity": "FloorName_Marwan", "Type": 0},
                                        ],
                                        "Select": [
                                            {"Column": {"Expression": {"SourceRef": {"Source": "r"}}, "Property": "End time"}, "Name": "ResourceSchedule_Soussi.End time"},
                                            {"Column": {"Expression": {"SourceRef": {"Source": "r"}}, "Property": "Physicians"}, "Name": "ResourceSchedule_Soussi.EnglishFullName"},
                                            {"Column": {"Expression": {"SourceRef": {"Source": "r"}}, "Property": "Specialty"}, "Name": "ResourceSchedule_Soussi.Specialty"},
                                            {"Column": {"Expression": {"SourceRef": {"Source": "r"}}, "Property": "Specialities"}, "Name": "ResourceSchedule_Soussi.Specialities"},
                                            {"Column": {"Expression": {"SourceRef": {"Source": "r"}}, "Property": "Physician NAme"}, "Name": "ResourceSchedule_Soussi.Physician NAme"},
                                            {"Aggregation": {"Expression": {"Column": {"Expression": {"SourceRef": {"Source": "r"}}, "Property": "MaxOccupancy"}}, "Function": 0}, "Name": "Sum(ResourceSchedule_Soussi.MaxOccupancy)"},
                                            {"Column": {"Expression": {"SourceRef": {"Source": "r"}}, "Property": "FLSupervisoryLevelName"}, "Name": "ResourceSchedule_Soussi.FLSupervisoryLevelName"},
                                            {"Column": {"Expression": {"SourceRef": {"Source": "r"}}, "Property": "Start time"}, "Name": "ResourceSchedule_Soussi.Start time"},
                                            {"Column": {"Expression": {"SourceRef": {"Source": "r"}}, "Property": "WeekName"}, "Name": "ResourceSchedule_Soussi.WeekName"},
                                            {"Column": {"Expression": {"SourceRef": {"Source": "r"}}, "Property": "day"}, "Name": "Sum(ResourceSchedule_Soussi.day)"},
                                            {"Measure": {"Expression": {"SourceRef": {"Source": "r"}}, "Property": "Schedules"}, "Name": "ResourceSchedule_Soussi.Schedules"},
                                            {"Column": {"Expression": {"SourceRef": {"Source": "f1"}}, "Property": "Floor name"}, "Name": "FloorName_Marwan.Floor name"},
                                        ],
                                        "Where": [
                                            {
                                                "Condition": {
                                                    "In": {
                                                        "Expressions": [
                                                            {"Column": {"Expression": {"SourceRef": {"Source": "r"}}, "Property": "Year"}},
                                                            {"Column": {"Expression": {"SourceRef": {"Source": "r"}}, "Property": "month"}},
                                                            {"Column": {"Expression": {"SourceRef": {"Source": "r"}}, "Property": "day"}},
                                                        ],
                                                        "Values": [[
                                                            {"Literal": {"Value": f"{target_date.year}L"}},
                                                            {"Literal": {"Value": f"{target_date.month}L"}},
                                                            {"Literal": {"Value": f"{target_date.day}L"}},
                                                        ]],
                                                    }
                                                }
                                            },
                                            {
                                                "Condition": {
                                                    "Not": {
                                                        "Expression": {
                                                            "In": {
                                                                "Expressions": [{"Column": {"Expression": {"SourceRef": {"Source": "r"}}, "Property": "Physicians"}}],
                                                                "Values": [[{"Literal": {"Value": v}}] for v in OPD_EXCLUDED_PHYSICIANS],
                                                            }
                                                        }
                                                    }
                                                }
                                            },
                                        ],
                                        "OrderBy": [
                                            {"Direction": 1, "Expression": {"Column": {"Expression": {"SourceRef": {"Source": "r"}}, "Property": "End time"}}}
                                        ],
                                    },
                                    "Binding": {
                                        "Primary": {"Groupings": [{"Projections": list(range(12)), "Subtotal": 0}]},
                                        "DataReduction": {"Primary": {"Top": {"Count": 1000000}}, "Secondary": {"Top": {"Count": 100}}},
                                        "Version": 1,
                                    },
                                }
                            },
                            {
                                "ExportDataCommand": {
                                    "Columns": [
                                        {"QueryName": "Sum(ResourceSchedule_Soussi.day)", "Name": "day"},
                                        {"QueryName": "ResourceSchedule_Soussi.WeekName", "Name": "WeekName"},
                                        {"QueryName": "ResourceSchedule_Soussi.Start time", "Name": "Start time"},
                                        {"QueryName": "ResourceSchedule_Soussi.Specialty", "Name": "Specialty"},
                                        {"QueryName": "ResourceSchedule_Soussi.EnglishFullName", "Name": "Physicians"},
                                        {"QueryName": "FloorName_Marwan.Floor name", "Name": "Floor name"},
                                        {"QueryName": "ResourceSchedule_Soussi.FLSupervisoryLevelName", "Name": "FLSupervisoryLevelName"},
                                        {"QueryName": "Sum(ResourceSchedule_Soussi.MaxOccupancy)", "Name": "Sum of MaxOccupancy"},
                                        {"QueryName": "ResourceSchedule_Soussi.Physician NAme", "Name": "Physician NAme"},
                                        {"QueryName": "ResourceSchedule_Soussi.Specialities", "Name": "Specialities"},
                                        {"QueryName": "ResourceSchedule_Soussi.End time", "Name": "End time"},
                                        {"QueryName": "ResourceSchedule_Soussi.Schedules", "Name": "Schedules"},
                                    ],
                                    "Ordering": [9, 8, 7, 2, 1, 11, 6, 5, 4, 3, 0, 10],
                                    "FiltersDescription": f"Included (1) {target_date.year} (Year) + {target_date.month} (month) + {target_date.day} (day)",
                                }
                            },
                        ]
                    }
                }
            ],
            "cancelQueries": [],
            "modelId": model_id,
            "userPreferredLocale": "en-US",
        },
    }


def parse_powerbi_opd_excel(excel_bytes: bytes, target_date_str: str) -> list[dict[str, Any]]:
    """Parses the 12-column Power BI OPD Doctors Sheet Excel export into normalized clinic session dicts."""
    df = pd.read_excel(io.BytesIO(excel_bytes), header=None)
    if df.empty:
        return []

    header_row_idx = -1
    for r_idx in range(min(10, len(df))):
        row_strs = [
            str(x).lower().strip()
            for x in df.iloc[r_idx].values
            if pd.notna(x) and "\n" not in str(x) and "applied filters" not in str(x).lower()
        ]
        if len(row_strs) >= 4 and any("physicians" in s or "specialty" in s or "start time" in s for s in row_strs):
            header_row_idx = r_idx
            break

    if header_row_idx < 0:
        return []

    headers = [str(x).strip().lower() if pd.notna(x) else "" for x in df.iloc[header_row_idx].values]

    def find_col(names: list[str], fallback: int = -1) -> int:
        for n in names:
            nl = n.lower()
            for idx, h in enumerate(headers):
                if h == nl:
                    return idx
        for n in names:
            nl = n.lower()
            if len(nl) <= 3:
                continue
            for idx, h in enumerate(headers):
                if nl in h:
                    return idx
        return fallback

    idx_day = find_col(["day"], 0)
    idx_week = find_col(["weekname", "week name"], 1)
    idx_start = find_col(["start time", "starttime"], 2)
    idx_specialty = find_col(["specialty"], 3)
    idx_phys_en = find_col(["physicians", "englishfullname", "physician en"], 4)
    idx_floor = find_col(["floor name", "floor"], 5)
    idx_level = find_col(["flsupervisorylevelname", "supervisory level", "level"], 6)
    idx_max_occ = find_col(["sum of maxoccupancy", "maxoccupancy", "max occupancy"], 7)
    idx_phys_ar = find_col(["physician name", "physician_name"], 8)
    idx_specialities = find_col(["specialities", "parent specialty"], 9)
    idx_end = find_col(["end time", "endtime"], 10)
    idx_schedules = find_col(["schedules"], 11)

    # Disambiguate "Physician NAme" (Arabic) vs "Physicians" (English)
    for idx, h in enumerate(headers):
        if h == "physician name":
            idx_phys_ar = idx
        elif h == "physicians":
            idx_phys_en = idx
        elif h == "specialty":
            idx_specialty = idx
        elif h == "specialities":
            idx_specialities = idx

    def cell_str(row_vals: Any, idx: int) -> str:
        if idx < 0 or idx >= len(row_vals):
            return ""
        v = row_vals[idx]
        if v is None or pd.isna(v):
            return ""
        s = re.sub(r"\s+", " ", str(v).replace("\xa0", " ")).strip()
        if s.lower() in ("nan", "null", "none"):
            return ""
        return s

    def cell_int(row_vals: Any, idx: int, default: int = 0) -> int:
        if idx < 0 or idx >= len(row_vals):
            return default
        v = row_vals[idx]
        if v is None or pd.isna(v):
            return default
        try:
            return int(float(v))
        except (ValueError, TypeError):
            return default

    sessions: list[dict[str, Any]] = []
    for r_idx in range(header_row_idx + 1, len(df)):
        row_vals = df.iloc[r_idx].values
        phys_en = cell_str(row_vals, idx_phys_en)
        phys_ar = cell_str(row_vals, idx_phys_ar)
        specialty = cell_str(row_vals, idx_specialty)
        specialities = cell_str(row_vals, idx_specialities)
        if not phys_en and not phys_ar and not specialty:
            continue
        if phys_en.lower() in ("physicians", "total", "applied filters:"):
            continue

        start_raw = row_vals[idx_start] if 0 <= idx_start < len(row_vals) else ""
        end_raw = row_vals[idx_end] if 0 <= idx_end < len(row_vals) else ""

        sessions.append({
            "serial": str(len(sessions) + 1),
            "day": cell_int(row_vals, idx_day, 0),
            "weekName": cell_str(row_vals, idx_week),
            "startTime": format_time_12h(start_raw) or cell_str(row_vals, idx_start),
            "endTime": format_time_12h(end_raw) or cell_str(row_vals, idx_end),
            "specialty": specialty or specialities,
            "specialities": specialities or specialty,
            "physicianEn": phys_en,
            "physicianAr": phys_ar,
            "floorName": cell_str(row_vals, idx_floor),
            "supervisoryLevel": cell_str(row_vals, idx_level),
            "maxOccupancy": cell_int(row_vals, idx_max_occ, 0),
            "schedules": cell_int(row_vals, idx_schedules, 1),
            "opdDate": target_date_str,
        })
    return sessions


def purge_opd_state(target_date_str: str, error_msg: Optional[str] = None) -> bool:
    """Clears state/opd_list for a new target date (never writes history/opd/*)."""
    global _last_opd_hash, _last_opd_target_date
    if not SUPABASE_KEY:
        return True
    try:
        now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
        payload: dict[str, Any] = {
            "items": [],
            "opdDate": target_date_str,
            "hash": "",
            "source": "powerbi",
            "updatedAt": now_iso,
        }
        if error_msg:
            payload["error"] = error_msg
        session = get_supabase_session()
        sb_resp = session.post(
            SUPABASE_REST_URL,
            json=[{"path": "state/opd_list", "data": payload, "updated_at": now_iso}],
            timeout=20,
            verify=SUPABASE_SSL_VERIFY,
        )
        if sb_resp.status_code not in (200, 201, 204):
            log(f"[OPD Purge] Supabase clear returned {sb_resp.status_code}: {sb_resp.text}", level="warning")
            return False
        _last_opd_hash = ""
        _last_opd_target_date = target_date_str
        return True
    except Exception as e:
        log(f"[OPD Purge] Error clearing state/opd_list: {e}", level="error")
        return False


def fetch_powerbi_opd_and_sync(
    target_date: Optional[datetime.date] = None,
    force: bool = False,
    dry_run: bool = False,
    purge_before_fetch: bool = False,
) -> bool:
    """Fetches OPD Doctors Sheet for target_date (defaults to Cairo target date) and syncs ONLY to Supabase state/opd_list (no OPD history)."""
    global _last_opd_sync_ts, _last_opd_hash, _last_opd_target_date
    cairo_now = get_cairo_now()
    t_date = target_date or get_opd_target_date(cairo_now)
    target_date_str = t_date.isoformat()
    try:
        now_dt = datetime.datetime.now(datetime.timezone.utc)
        now_iso = now_dt.isoformat()

        if purge_before_fetch and not dry_run:
            log(f"[OPD Rollover] Purging previous OPD list before fetching {target_date_str}...")
            purge_opd_state(target_date_str)

        log(f"[OPD Sync] Fetching OPD Doctors Sheet from Power BI for {target_date_str}...")
        auth = HttpNtlmAuth(POWERBI_USER, POWERBI_PASS) if POWERBI_USER else None
        opd_model_id = get_opd_powerbi_model_id(auth=auth)
        opd_payload = build_opd_powerbi_payload(opd_model_id, t_date)

        resp = requests.post(
            POWERBI_OPD_EXPORT_URL,
            json=opd_payload,
            auth=auth,
            timeout=(10, min(45, POWERBI_TIMEOUT)),
        )
        resp.raise_for_status()

        opd_sessions = parse_powerbi_opd_excel(resp.content, target_date_str)
        _last_opd_sync_ts = time.time()
        current_hash = hashlib.sha256(
            json.dumps(opd_sessions, ensure_ascii=False, sort_keys=True).encode("utf-8")
        ).hexdigest()

        if dry_run:
            log(f"[OPD Dry-Run] Parsed {len(opd_sessions)} clinic sessions for {target_date_str}.")
            return True

        if not force and current_hash == _last_opd_hash and target_date_str == _last_opd_target_date:
            log(f"[OPD Sync Dedup] OPD schedule ({len(opd_sessions)} clinics) unchanged; skipping write.")
            return True

        if not SUPABASE_KEY:
            log(f"[OPD Sync] Parsed {len(opd_sessions)} OPD clinics. SUPABASE_KEY not set; skipping DB write.", level="warning")
            return True

        session = get_supabase_session()
        if not force:
            try:
                cur_res = session.get(
                    f"{SUPABASE_REST_URL}?path=eq.state/opd_list&select=data",
                    timeout=10,
                    verify=SUPABASE_SSL_VERIFY,
                )
                if cur_res.status_code == 200 and cur_res.json():
                    cur_data = cur_res.json()[0].get("data") or {}
                    if isinstance(cur_data, dict) and cur_data.get("hash") == current_hash and cur_data.get("opdDate") == target_date_str:
                        _last_opd_hash = current_hash
                        _last_opd_target_date = target_date_str
                        log(f"[OPD Sync Dedup] OPD schedule ({len(opd_sessions)} clinics) matches persisted hash; skipping write.")
                        return True
            except Exception:
                pass

        opd_payload_node = {
            "items": opd_sessions,
            "opdDate": target_date_str,
            "hash": current_hash,
            "source": "powerbi",
            "updatedAt": now_iso,
        }
        # Only live state/opd_list is persisted (no OPD history)
        opd_nodes = [
            {"path": "state/opd_list", "data": opd_payload_node, "updated_at": now_iso},
        ]
        sb_resp = session.post(SUPABASE_REST_URL, json=opd_nodes, timeout=20, verify=SUPABASE_SSL_VERIFY)
        if sb_resp.status_code not in (200, 201, 204):
            log(f"[OPD Sync] Supabase upsert returned {sb_resp.status_code}: {sb_resp.text}", level="warning")
            return False

        _last_opd_hash = current_hash
        _last_opd_target_date = target_date_str
        log(f"[OPD Sync] Successfully committed {len(opd_sessions)} OPD clinic sessions for {target_date_str}.")
        return True
    except Exception as e:
        log(f"[OPD Sync] Error fetching/syncing OPD Doctors Sheet: {e}", level="error")
        if purge_before_fetch and not dry_run:
            purge_opd_state(target_date_str, error_msg=str(e))
        return False


# --- ISOLATED OPERATIONAL FEEDS (feeds/*): INSURANCE APPROVALS, LIVE OPD, CATH LAB & ENDOSCOPY ---

_last_feed_hashes: dict[str, str] = {}


def compute_feed_hash(payload_body: dict[str, Any]) -> str:
    """Computes a deterministic SHA-256 hash of a feed payload, excluding volatile updatedAt/hash fields."""
    canonical = {k: v for k, v in payload_body.items() if k not in ("updatedAt", "hash")}
    raw = json.dumps(canonical, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def upsert_feed_node_if_changed(
    path: str,
    payload_body: dict[str, Any],
    force: bool = False,
    dry_run: bool = False,
) -> bool:
    """Two-tier hash-deduplicated upsert into rtdb_nodes (feeds/*):
    Tier 1: In-memory hash check (0 bytes, 0 Supabase calls).
    Tier 2: Persisted cloud hash check via select=hash:data->>hash (~150 bytes).
    Writes ONLY when data actually changed (or force=True) and never writes on dry_run.
    Returns True if an upsert was executed, False if skipped."""
    new_hash = compute_feed_hash(payload_body)

    if dry_run:
        log(f"[Feed Dry-Run] {path}: hash={new_hash[:12]} (skipped Supabase write)")
        return False

    # Tier 1: In-memory cache hit
    if not force and _last_feed_hashes.get(path) == new_hash:
        log(f"[Feed Dedup] {path} unchanged (in-memory hash {new_hash[:10]}); skipping write.")
        return False

    sb_sess = get_supabase_session()
    # Tier 2: Lightweight persisted hash check (~150 bytes) to survive runner restarts
    if not force:
        try:
            chk = sb_sess.get(
                f"{SUPABASE_REST_URL}?path=eq.{requests.utils.quote(path, safe='')}&select=hash:data->>hash",
                headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"},
                timeout=12,
                verify=SUPABASE_SSL_VERIFY,
            )
            if chk.status_code == 200:
                rows = chk.json()
                if isinstance(rows, list) and rows and rows[0].get("hash") == new_hash:
                    _last_feed_hashes[path] = new_hash
                    log(f"[Feed Dedup] {path} unchanged (cloud hash {new_hash[:10]}); skipping write.")
                    return False
        except Exception as chk_err:
            log(f"[Feed Dedup] Non-fatal cloud hash check notice for {path}: {chk_err}", level="warning")

    now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
    full_payload = dict(payload_body)
    full_payload["hash"] = new_hash
    full_payload["updatedAt"] = now_iso

    resp = sb_sess.post(
        SUPABASE_REST_URL,
        headers=SUPABASE_HEADERS,
        json=[{"path": path, "data": full_payload, "updated_at": now_iso}],
        timeout=30,
        verify=SUPABASE_SSL_VERIFY,
    )
    if resp.status_code not in (200, 201, 204):
        log(f"[Feed Sync] Supabase upsert for {path} returned {resp.status_code}: {resp.text[:250]}", level="warning")
        return False

    _last_feed_hashes[path] = new_hash
    return True


def _fetch_powerbi_table_export(
    export_url: str,
    fallback_model_id: int,
    section_index: int = 0,
    where_override: Optional[list[dict[str, Any]]] = None,
    extra_select_props: Optional[list[tuple[str, str]]] = None,
    auth: Optional[Any] = None,
    timeout: tuple[int, int] = (10, 45),
) -> bytes:
    """Dynamically fetches modelsAndExploration for a Power BI report, locates its tableEx visual,
    applies optional Where filters and extra Select columns, and returns raw XLSX export bytes."""
    report_base = export_url.rsplit("/export/", 1)[0]
    meta_resp = requests.get(f"{report_base}/modelsAndExploration", auth=auth, timeout=(10, 20))
    meta_resp.raise_for_status()
    meta = meta_resp.json()
    models = meta.get("models") or []
    model_id = models[0].get("id", fallback_model_id) if models else fallback_model_id
    sections = (meta.get("exploration") or {}).get("sections") or []
    if not sections:
        raise ValueError(f"No sections in modelsAndExploration for {report_base}")
    sec = sections[min(section_index, len(sections) - 1)]

    pq: Optional[dict[str, Any]] = None
    for vc in sec.get("visualContainers") or []:
        cfg_raw = vc.get("config", "{}")
        cfg = json.loads(cfg_raw) if isinstance(cfg_raw, str) else (cfg_raw or {})
        sv = cfg.get("singleVisual") or {}
        if sv.get("visualType") == "tableEx" and sv.get("prototypeQuery"):
            pq = json.loads(json.dumps(sv["prototypeQuery"]))
            break
    if not pq or not pq.get("Select"):
        raise ValueError(f"No tableEx prototypeQuery found in section {section_index} of {report_base}")

    if extra_select_props:
        existing_names = {str(s.get("Name", "")).lower() for s in pq["Select"]}
        src_alias = (pq.get("From") or [{}])[0].get("Name", "o")
        ent_name = (pq.get("From") or [{}])[0].get("Entity", "OperationReservation_soussi")
        for prop, label in extra_select_props:
            full_name = f"{ent_name}.{label}"
            if full_name.lower() not in existing_names:
                pq["Select"].append({
                    "Column": {"Expression": {"SourceRef": {"Source": src_alias}}, "Property": prop},
                    "Name": full_name,
                })
                existing_names.add(full_name.lower())

    if where_override is not None:
        pq["Where"] = where_override

    n_cols = len(pq["Select"])
    export_cols = [
        {"QueryName": s["Name"], "Name": str(s["Name"]).split(".")[-1].rstrip(")")}
        for s in pq["Select"]
    ]
    payload = {
        "exportDataType": 0,
        "executeSemanticQueryRequest": {
            "version": "1.0.0",
            "queries": [{
                "Query": {
                    "Commands": [
                        {
                            "SemanticQueryDataShapeCommand": {
                                "Query": pq,
                                "Binding": {
                                    "Primary": {"Groupings": [{"Projections": list(range(n_cols)), "Subtotal": 0}]},
                                    "DataReduction": {"Primary": {"Top": {"Count": 100000}}, "Secondary": {"Top": {"Count": 100}}},
                                    "Version": 1,
                                },
                            }
                        },
                        {
                            "ExportDataCommand": {
                                "Columns": export_cols,
                                "Ordering": list(range(n_cols)),
                                "FiltersDescription": "",
                            }
                        },
                    ]
                }
            }],
            "cancelQueries": [],
            "modelId": model_id,
            "userPreferredLocale": "en-US",
        },
    }
    resp = requests.post(export_url, json=payload, auth=auth, timeout=timeout)
    resp.raise_for_status()
    return resp.content


def _extract_excel_table(excel_bytes: bytes, required_keywords: list[str]) -> pd.DataFrame:
    """Reads a Power BI XLSX export into a DataFrame with detected headers.
    Raises ValueError if the expected header row is missing (no-clobber guard)."""
    df = pd.read_excel(io.BytesIO(excel_bytes), header=None)
    if df.empty:
        raise ValueError("Empty Excel workbook returned from Power BI")

    header_idx = -1
    for r_idx in range(min(10, len(df))):
        row_strs = [
            str(x).lower().strip()
            for x in df.iloc[r_idx].values
            if pd.notna(x) and "\n" not in str(x) and "applied filters" not in str(x).lower()
        ]
        if len(row_strs) >= 3 and any(any(kw in s for s in row_strs) for kw in required_keywords):
            header_idx = r_idx
            break

    if header_idx < 0:
        raise ValueError(f"Could not locate expected header row (keywords={required_keywords})")

    headers = [str(x).strip() if pd.notna(x) else f"col_{i}" for i, x in enumerate(df.iloc[header_idx].values)]
    data = df.iloc[header_idx + 1:].copy()
    data.columns = headers
    return data.dropna(how="all")


def _safe_int(val: Any) -> int:
    try:
        if pd.isna(val):
            return 0
        return int(round(float(str(val).replace(",", "").strip())))
    except Exception:
        return 0


def _safe_str(val: Any) -> str:
    if val is None:
        return ""
    try:
        if pd.isna(val):
            return ""
    except Exception:
        pass
    s = str(val).strip()
    return "" if s.lower() in ("nan", "none", "nat") else s


def _find_df_col(columns: list[str], candidates: list[str]) -> Optional[str]:
    lower_map = {c.lower().strip(): c for c in columns}
    for cand in candidates:
        cl = cand.lower().strip()
        if cl in lower_map:
            return lower_map[cl]
    for cand in candidates:
        cl = cand.lower().strip()
        for k, orig in lower_map.items():
            if cl in k:
                return orig
    return None


def parse_powerbi_approvals_excel(excel_bytes: bytes) -> dict[str, Any]:
    """Parses /BIAPPROVALBedOccupancy into normalized approval bottleneck items and summaries."""
    df = _extract_excel_table(excel_bytes, ["patientbarcode", "contractorname", "rejectedrequests", "totalrequests"])
    cols = list(df.columns)

    c_mrn = _find_df_col(cols, ["PatientBarcode", "MRN"])
    c_name = _find_df_col(cols, ["EnglishFullName", "Patient Name"])
    c_room = _find_df_col(cols, ["FloorStructureName_EN", "Room"])
    c_contractor = _find_df_col(cols, ["ContractorName"])
    c_physician = _find_df_col(cols, ["Physician Name"])
    c_agent = _find_df_col(cols, ["Agent Name"])
    c_adm = _find_df_col(cols, ["AdmissionDate"])
    c_los = _find_df_col(cols, ["LOS"])
    c_status = _find_df_col(cols, ["Status"])
    c_total = _find_df_col(cols, ["TotalRequests"])
    c_pending = _find_df_col(cols, ["PendingRequests"])
    c_inprog = _find_df_col(cols, ["InProgressRequests"])
    c_rejected = _find_df_col(cols, ["RejectedRequests"])
    c_closed = _find_df_col(cols, ["ClosedRequests"])
    c_uploaded = _find_df_col(cols, ["ApprovalCount", "Uploaded Approvals"])
    c_comment = _find_df_col(cols, ["InvoiceComment"])

    items: list[dict[str, Any]] = []
    by_contractor: dict[str, dict[str, Any]] = {}
    by_agent: dict[str, dict[str, Any]] = {}

    total_pending = 0
    total_inprog = 0
    total_rejected = 0
    total_closed = 0
    total_requests = 0
    need_update_count = 0
    bottleneck_patients = 0

    for _, row in df.iterrows():
        mrn = clean_mrn_str(row[c_mrn]) if c_mrn else ""
        patient_name = _safe_str(row[c_name]) if c_name else ""
        if not mrn and not patient_name:
            continue
        room = _safe_str(row[c_room]) if c_room else ""
        contractor = _safe_str(row[c_contractor]) if c_contractor else "Unassigned"
        physician = _safe_str(row[c_physician]) if c_physician else ""
        agent = _safe_str(row[c_agent]) if c_agent else ""
        adm_date = _safe_str(row[c_adm])[:10] if c_adm else ""
        los = _safe_int(row[c_los]) if c_los else 0
        status = _safe_str(row[c_status]) if c_status else ""
        t_req = _safe_int(row[c_total]) if c_total else 0
        p_req = _safe_int(row[c_pending]) if c_pending else 0
        ip_req = _safe_int(row[c_inprog]) if c_inprog else 0
        rej_req = _safe_int(row[c_rejected]) if c_rejected else 0
        cl_req = _safe_int(row[c_closed]) if c_closed else 0
        up_cnt = _safe_int(row[c_uploaded]) if c_uploaded else 0
        comment = _safe_str(row[c_comment]) if c_comment else ""

        is_need_update = "needupdate" in status.lower().replace(" ", "")
        if rej_req > 0 or is_need_update:
            severity = "critical"
        elif p_req > 0 or ip_req > 0:
            severity = "warning"
        else:
            severity = "ok"

        if severity != "ok":
            bottleneck_patients += 1
        if is_need_update:
            need_update_count += 1

        total_pending += p_req
        total_inprog += ip_req
        total_rejected += rej_req
        total_closed += cl_req
        total_requests += t_req

        items.append({
            "mrn": mrn,
            "patientName": patient_name,
            "room": room,
            "contractor": contractor,
            "physician": physician,
            "agentName": agent,
            "admissionDate": adm_date,
            "los": los,
            "status": status,
            "totalRequests": t_req,
            "pendingRequests": p_req,
            "inProgressRequests": ip_req,
            "rejectedRequests": rej_req,
            "closedRequests": cl_req,
            "uploadedApprovals": up_cnt,
            "invoiceComment": comment,
            "severity": severity,
        })

        c_bucket = by_contractor.setdefault(contractor, {
            "contractor": contractor, "patients": 0, "bottlenecks": 0,
            "pending": 0, "inProgress": 0, "rejected": 0, "closed": 0, "total": 0,
        })
        c_bucket["patients"] += 1
        if severity != "ok":
            c_bucket["bottlenecks"] += 1
        c_bucket["pending"] += p_req
        c_bucket["inProgress"] += ip_req
        c_bucket["rejected"] += rej_req
        c_bucket["closed"] += cl_req
        c_bucket["total"] += t_req

        if agent:
            a_bucket = by_agent.setdefault(agent, {
                "agent": agent, "patients": 0, "bottlenecks": 0,
                "pending": 0, "inProgress": 0, "rejected": 0, "closed": 0, "total": 0,
            })
            a_bucket["patients"] += 1
            if severity != "ok":
                a_bucket["bottlenecks"] += 1
            a_bucket["pending"] += p_req
            a_bucket["inProgress"] += ip_req
            a_bucket["rejected"] += rej_req
            a_bucket["closed"] += cl_req
            a_bucket["total"] += t_req

    sev_rank = {"critical": 0, "warning": 1, "ok": 2}
    items.sort(key=lambda x: (sev_rank.get(x["severity"], 9), -x["rejectedRequests"], -(x["pendingRequests"] + x["inProgressRequests"]), x["room"]))

    contractors_sorted = sorted(by_contractor.values(), key=lambda x: (-x["rejected"], -(x["pending"] + x["inProgress"]), -x["patients"]))
    agents_sorted = sorted(by_agent.values(), key=lambda x: (-x["rejected"], -(x["pending"] + x["inProgress"]), -x["patients"]))

    return {
        "source": "powerbi_onprem",
        "summary": {
            "totalPatients": len(items),
            "patientsWithBottlenecks": bottleneck_patients,
            "totalPending": total_pending,
            "totalInProgress": total_inprog,
            "totalRejected": total_rejected,
            "totalClosed": total_closed,
            "totalRequests": total_requests,
            "needUpdateCount": need_update_count,
            "byContractor": contractors_sorted[:20],
            "byAgent": agents_sorted[:20],
        },
        "items": items,
    }


def fetch_powerbi_approvals_and_sync(force: bool = False, dry_run: bool = False) -> bool:
    """Fetches /BIAPPROVALBedOccupancy and upserts into feeds/insurance_approvals if changed."""
    try:
        auth = HttpNtlmAuth(POWERBI_USER, POWERBI_PASS) if POWERBI_USER else None
        xlsx_bytes = _fetch_powerbi_table_export(
            POWERBI_APPROVALS_EXPORT_URL,
            fallback_model_id=941746990,
            section_index=0,
            where_override=None,
            auth=auth,
        )
        parsed = parse_powerbi_approvals_excel(xlsx_bytes)
        wrote = upsert_feed_node_if_changed("feeds/insurance_approvals", parsed, force=force, dry_run=dry_run)
        s = parsed["summary"]
        log(
            f"[Approvals Sync] Parsed {s['totalPatients']} inpatients "
            f"(bottlenecks={s['patientsWithBottlenecks']}, rejected={s['totalRejected']}, "
            f"pending={s['totalPending']}, inProgress={s['totalInProgress']}, wrote={wrote})."
        )
        return True
    except Exception as e:
        log(f"[Approvals Sync] Non-fatal error: {e}", level="warning")
        return False


def parse_powerbi_opd_live_excels(
    live_bytes: bytes,
    queue_bytes: Optional[bytes],
    opd_date_str: str,
) -> dict[str, Any]:
    """Aggregates /BILiveOPD + /ConfirmedPatientsQueue into privacy-safe volume & queue metrics.
    Never persists raw outpatient phone numbers."""
    live_df = _extract_excel_table(live_bytes, ["maxstatusguid", "flspecialtyname", "employeeenglishfullname"])
    l_cols = list(live_df.columns)
    c_spec = _find_df_col(l_cols, ["FLSpecialtyName", "SpecialtyName"])
    c_doc_en = _find_df_col(l_cols, ["EmployeeEnglishFullName", "Physician Name"])
    c_status = _find_df_col(l_cols, ["MaxStatusGUID", "MaxStatus"])

    counts = {"Reserved": 0, "ArrivedConfirmed": 0, "StartVisit": 0, "EndVisit": 0, "Cancel": 0}
    spec_map: dict[str, dict[str, Any]] = {}
    doc_map: dict[str, dict[str, Any]] = {}

    for _, row in live_df.iterrows():
        st = _safe_str(row[c_status]) if c_status else ""
        spec = _safe_str(row[c_spec]) if c_spec else "General"
        doc_en = _safe_str(row[c_doc_en]) if c_doc_en else ""
        if not st and not spec and not doc_en:
            continue

        if st in counts:
            counts[st] += 1

        sb = spec_map.setdefault(spec, {
            "specialty": spec, "total": 0, "reserved": 0, "waiting": 0,
            "inClinic": 0, "completed": 0, "cancelled": 0,
            "confirmedQueueWaiting": 0, "pendingTicketRequests": 0,
        })
        sb["total"] += 1
        if st == "Reserved":
            sb["reserved"] += 1
        elif st == "ArrivedConfirmed":
            sb["waiting"] += 1
        elif st == "StartVisit":
            sb["inClinic"] += 1
        elif st == "EndVisit":
            sb["completed"] += 1
        elif st == "Cancel":
            sb["cancelled"] += 1

        if doc_en:
            dkey = f"{doc_en.lower()}||{spec.lower()}"
            db = doc_map.setdefault(dkey, {
                "physicianEn": doc_en, "physicianAr": "", "specialty": spec,
                "total": 0, "reserved": 0, "waiting": 0, "inClinic": 0,
                "completed": 0, "cancelled": 0,
                "confirmedQueueWaiting": 0, "confirmedQueueInClinic": 0,
                "confirmedQueueCompleted": 0, "pendingTicketRequests": 0,
            })
            db["total"] += 1
            if st == "Reserved":
                db["reserved"] += 1
            elif st == "ArrivedConfirmed":
                db["waiting"] += 1
            elif st == "StartVisit":
                db["inClinic"] += 1
            elif st == "EndVisit":
                db["completed"] += 1
            elif st == "Cancel":
                db["cancelled"] += 1

    q_waiting = 0
    q_in_clinic = 0
    q_completed = 0
    q_ticket_req = 0
    q_doc_map: dict[str, dict[str, Any]] = {}

    if queue_bytes:
        try:
            q_df = _extract_excel_table(queue_bytes, ["maxstatusguid", "flspecialtyname", "employeearabicfullname"])
            q_cols = list(q_df.columns)
            qc_spec = _find_df_col(q_cols, ["FLSpecialtyName"])
            qc_doc_ar = _find_df_col(q_cols, ["EmployeeArabicFullName"])
            qc_st = _find_df_col(q_cols, ["MaxStatusGUID"])
            qc_req = _find_df_col(q_cols, ["RequestNumberStatus"])

            for _, row in q_df.iterrows():
                qst = _safe_str(row[qc_st]) if qc_st else ""
                qspec = _safe_str(row[qc_spec]) if qc_spec else "General"
                qdoc_ar = _safe_str(row[qc_doc_ar]) if qc_doc_ar else ""
                qreq = _safe_str(row[qc_req]) if qc_req else ""

                is_req = qreq.lower() == "requested"
                if is_req:
                    q_ticket_req += 1
                if qst == "ArrivedConfirmed":
                    q_waiting += 1
                elif qst == "StartVisit":
                    q_in_clinic += 1
                elif qst == "EndVisit":
                    q_completed += 1

                if qspec in spec_map:
                    if qst == "ArrivedConfirmed":
                        spec_map[qspec]["confirmedQueueWaiting"] += 1
                    if is_req:
                        spec_map[qspec]["pendingTicketRequests"] += 1

                if qdoc_ar:
                    qk = f"{qdoc_ar.lower()}||{qspec.lower()}"
                    qb = q_doc_map.setdefault(qk, {
                        "physicianAr": qdoc_ar, "specialty": qspec,
                        "waiting": 0, "inClinic": 0, "completed": 0, "pendingTicketRequests": 0,
                    })
                    if qst == "ArrivedConfirmed":
                        qb["waiting"] += 1
                    elif qst == "StartVisit":
                        qb["inClinic"] += 1
                    elif qst == "EndVisit":
                        qb["completed"] += 1
                    if is_req:
                        qb["pendingTicketRequests"] += 1
        except Exception as qe:
            log(f"[OPD Live] Non-fatal queue parse notice: {qe}", level="warning")

    total_bookings = sum(counts.values())
    active_non_cancel = max(0, total_bookings - counts["Cancel"])
    showed_up = counts["ArrivedConfirmed"] + counts["StartVisit"] + counts["EndVisit"]
    show_up_rate = round((showed_up / active_non_cancel) * 100.0, 1) if active_non_cancel > 0 else 0.0

    by_specialty = sorted(spec_map.values(), key=lambda x: (-x["waiting"], -x["total"]))
    by_physician = sorted(doc_map.values(), key=lambda x: (-x["waiting"], -x["total"]))
    queue_by_physician_ar = sorted(q_doc_map.values(), key=lambda x: (-x["waiting"], -x["pendingTicketRequests"]))

    return {
        "opdDate": opd_date_str,
        "source": "powerbi_onprem",
        "summary": {
            "totalBookings": total_bookings,
            "reserved": counts["Reserved"],
            "arrivedWaiting": counts["ArrivedConfirmed"],
            "inClinic": counts["StartVisit"],
            "completed": counts["EndVisit"],
            "cancelled": counts["Cancel"],
            "showUpRatePct": show_up_rate,
            "confirmedQueueWaiting": q_waiting,
            "confirmedQueueInClinic": q_in_clinic,
            "confirmedQueueCompleted": q_completed,
            "pendingTicketRequests": q_ticket_req,
        },
        "bySpecialty": by_specialty,
        "byPhysician": by_physician,
        "queueByPhysicianAr": queue_by_physician_ar,
    }


def fetch_powerbi_opd_live_and_sync(force: bool = False, dry_run: bool = False) -> bool:
    """Fetches /BILiveOPD + /ConfirmedPatientsQueue and upserts into feeds/opd_live if changed.
    Skips overnight closed-clinic hours (23:00-07:29 Cairo) unless force=True or dry_run=True."""
    try:
        cairo_now = get_cairo_now()
        if not force and not dry_run and (cairo_now.hour >= 23 or cairo_now.hour < 7 or (cairo_now.hour == 7 and cairo_now.minute < 30)):
            return True

        auth = HttpNtlmAuth(POWERBI_USER, POWERBI_PASS) if POWERBI_USER else None
        live_where = [
            {"Condition": {"Not": {"Expression": {"In": {"Expressions": [{"Column": {"Expression": {"SourceRef": {"Source": "v"}}, "Property": "ReasonGUID"}}], "Values": [[{"Literal": {"Value": "'WrongData'"}}]]}}}}},
            {"Condition": {"Not": {"Expression": {"In": {"Expressions": [{"Column": {"Expression": {"SourceRef": {"Source": "v"}}, "Property": "SpecialtyName"}}], "Values": [[{"Literal": {"Value": f"'{x}'"}}] for x in ["CT", "MRI", "X Ray", "U/S"]]}}}}},
        ]
        queue_where = [
            {"Condition": {"Not": {"Expression": {"In": {"Expressions": [{"Column": {"Expression": {"SourceRef": {"Source": "v"}}, "Property": "Physician Name"}}], "Values": [[{"Literal": {"Value": f"'{x}'"}}] for x in ["موعد اشعه  CT", "موعد اشعه  MRI", "موعد اشعه  XRay", "موعد اشعه اشعه US", "Lab   Reservation"]]}}}}},
        ]

        live_bytes = _fetch_powerbi_table_export(
            POWERBI_LIVE_OPD_EXPORT_URL,
            fallback_model_id=1752932899,
            section_index=0,
            where_override=live_where,
            auth=auth,
        )
        queue_bytes: Optional[bytes] = None
        try:
            queue_bytes = _fetch_powerbi_table_export(
                POWERBI_OPD_QUEUE_EXPORT_URL,
                fallback_model_id=914096509,
                section_index=0,
                where_override=queue_where,
                auth=auth,
            )
        except Exception as q_err:
            log(f"[OPD Live] ConfirmedPatientsQueue fetch notice (continuing with BILiveOPD): {q_err}", level="warning")

        parsed = parse_powerbi_opd_live_excels(live_bytes, queue_bytes, cairo_now.date().isoformat())
        wrote = upsert_feed_node_if_changed("feeds/opd_live", parsed, force=force, dry_run=dry_run)
        s = parsed["summary"]
        log(
            f"[OPD Live Sync] {s['totalBookings']} bookings "
            f"(waiting={s['arrivedWaiting']}, inClinic={s['inClinic']}, completed={s['completed']}, "
            f"queueWaiting={s['confirmedQueueWaiting']}, wrote={wrote})."
        )
        return True
    except Exception as e:
        log(f"[OPD Live Sync] Non-fatal error: {e}", level="warning")
        return False


def _clean_procedure_op_text(raw: str) -> str:
    """Strips Cybernetics internal severity/nature suffixes like '//s-Major', '//s-Moderate', '//s-SpecialNature//'
    and deduplicates repeated slash-separated procedure names like 'OpA/OpA' -> 'OpA'."""
    if not raw:
        return ""
    cleaned = re.sub(r"\s*//\s*s-[^\s/]+/*\s*", "", raw, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s*//+\s*$", "", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if "/" in cleaned:
        parts = [p.strip() for p in cleaned.split("/") if p.strip()]
        seen: set[str] = set()
        unique_parts: list[str] = []
        for p in parts:
            key = p.lower()
            if key not in seen:
                seen.add(key)
                unique_parts.append(p)
        cleaned = " / ".join(unique_parts)
    return cleaned


def _normalize_procedure_time_12h(raw_val: Any, unit: str) -> tuple[str, str, bool]:
    """Formats a procedure time into 12-hour AM/PM.
    For Endoscopy only, bookings in the pre-dawn window 01:00..07:59 AM are auto-normalized by +12h
    to PM (fixing Cybernetics default-AM entry bug), while preserving raw_12h and setting normalized=True.
    Cath Lab is never shifted (supports 24/7 emergency PCI)."""
    raw_12h = format_time_12h(_safe_str(raw_val))
    if not raw_12h or unit != "endoscopy":
        return raw_12h, raw_12h, False
    mins = _parse_time_12h_minutes(raw_12h)
    if 60 <= mins < 480:  # 01:00 AM .. 07:59 AM
        h24 = (mins // 60) + 12
        mm = mins % 60
        h12 = 12 if (h24 % 12 == 0) else (h24 % 12)
        return f"{h12:02d}:{mm:02d} PM", raw_12h, True
    return raw_12h, raw_12h, False


def _format_actual_dt_to_12h(raw_dt_str: str) -> str:
    """Extracts HH:MM from a datetime string like '2026-11-24 13:01:21.940000' and formats to '01:01 PM'."""
    if not raw_dt_str:
        return ""
    m = re.search(r"(\d{1,2}:\d{2}(?::\d{2})?)", raw_dt_str)
    if not m:
        return ""
    return format_time_12h(m.group(1))


def _parse_time_12h_minutes(time_str: str) -> int:
    """Converts '10:00 AM' / '07:55 PM' / '19:55' into minutes since midnight for chronological sorting."""
    if not time_str:
        return 9999
    s = time_str.strip().lower()
    m = re.search(r"(\d{1,2}):(\d{2})", s)
    if not m:
        return 9999
    h = int(m.group(1))
    mins = int(m.group(2))
    is_pm = "pm" in s or "م" in s
    is_am = "am" in s or "ص" in s
    if is_pm and h < 12:
        h += 12
    elif is_am and h == 12:
        h = 0
    return h * 60 + mins


def parse_powerbi_procedure_excel(
    excel_bytes: bytes,
    unit: str,
    reference_date_str: str,
) -> dict[str, Any]:
    """Parses /BICathlabReservation or /BIEndoReservation Excel export into deduplicated procedure records.
    Deduplicates SQL join fan-out (e.g. Cathlab Dose Cartesian product) by composite slot key
    (procedureDate|mrn_or_name|startTime|room) and merges distinct multi-procedures cleanly."""
    df = _extract_excel_table(excel_bytes, ["room name", "mrn", "englishfullname", "startdatetime"])
    cols = list(df.columns)

    c_surgeon = _find_df_col(cols, ["EnglishFullName", "Surgeon Name"])
    c_class = _find_df_col(cols, ["FLClassName"])
    c_prep = _find_df_col(cols, ["PreparationInstructions"])
    c_room = _find_df_col(cols, ["Room Name", "OR Room"])
    c_contractor = _find_df_col(cols, ["ContractorName"])
    c_paidby = _find_df_col(cols, ["PaidBy"])
    c_start = _find_df_col(cols, ["Start Time"])
    c_end = _find_df_col(cols, ["End Time"])
    c_postc = _find_df_col(cols, ["PostRoomCategoryGUID", "Post C"])
    c_comment = _find_df_col(cols, ["OperativeComment"])
    c_op_en = _find_df_col(cols, ["FLOperationName", "Eng Operation Name", "Expr1"])
    c_op_ar = _find_df_col(cols, ["SLOperationName", "Ar Operation Naem", "Expr2"])
    c_mrn = _find_df_col(cols, ["MRN"])
    c_vt = _find_df_col(cols, ["VT", "Visit Type"])
    c_patient = _find_df_col(cols, ["Actual Patient Name", "Patient Name"])
    c_dose = _find_df_col(cols, ["Cathlab Dose"])
    c_start_dt = _find_df_col(cols, ["StartDateTime"])
    c_status = _find_df_col(cols, ["Status"])
    c_act_start = _find_df_col(cols, ["Actual Start"])
    c_act_end = _find_df_col(cols, ["Actual End"])

    grouped: dict[str, dict[str, Any]] = {}
    ordered_keys: list[str] = []

    def _merge_distinct(existing_val: str, new_val: str, sep: str = " / ") -> str:
        if not new_val:
            return existing_val
        parts = [p.strip() for p in existing_val.split(sep.strip()) if p.strip()] if existing_val else []
        if new_val not in parts:
            parts.append(new_val)
        return sep.join(parts)

    for _, row in df.iterrows():
        patient_name = _safe_str(row[c_patient]) if c_patient else ""
        mrn = clean_mrn_str(row[c_mrn]) if c_mrn else ""
        room = _safe_str(row[c_room]) if c_room else ""
        if not patient_name and not mrn and not room:
            continue

        raw_dt = _safe_str(row[c_start_dt]) if c_start_dt else ""
        proc_date = raw_dt[:10] if len(raw_dt) >= 10 else reference_date_str
        start_12h, raw_start_12h, start_norm = _normalize_procedure_time_12h(row[c_start], unit) if c_start else ("", "", False)
        end_12h, raw_end_12h, end_norm = _normalize_procedure_time_12h(row[c_end], unit) if c_end else ("", "", False)
        time_normalized = bool(start_norm or end_norm)
        act_start = _safe_str(row[c_act_start]) if c_act_start else ""
        act_end = _safe_str(row[c_act_end]) if c_act_end else ""
        act_start_12h = _format_actual_dt_to_12h(act_start)
        act_end_12h = _format_actual_dt_to_12h(act_end)

        raw_status = _safe_str(row[c_status]) if c_status else ""
        if not raw_status:
            if act_end:
                status = "Completed"
            elif act_start:
                status = "InOR"
            else:
                status = "Scheduled"
        else:
            status = raw_status

        op_en = _clean_procedure_op_text(_safe_str(row[c_op_en])) if c_op_en else ""
        op_ar = _clean_procedure_op_text(_safe_str(row[c_op_ar])) if c_op_ar else ""
        surgeon = re.sub(r"\s+", " ", _safe_str(row[c_surgeon])).strip() if c_surgeon else ""
        contractor = _safe_str(row[c_contractor]) if c_contractor else ""
        paid_by = _safe_str(row[c_paidby]) if c_paidby else ""
        fl_class = _safe_str(row[c_class]) if c_class else ""
        vt = _safe_str(row[c_vt]) if c_vt else ""
        post_c = _safe_str(row[c_postc]) if c_postc else ""
        prep = _safe_str(row[c_prep]) if c_prep else ""
        comment = _safe_str(row[c_comment]) if c_comment else ""
        dose = _safe_str(row[c_dose]) if c_dose else ""

        norm_name = normalize_arabic_name(patient_name) or patient_name.lower()
        group_key = f"{proc_date}|{mrn or norm_name}|{start_12h}|{room.lower()}"

        if group_key not in grouped:
            ordered_keys.append(group_key)
            grouped[group_key] = {
                "serial": str(len(ordered_keys)),
                "procedureDate": proc_date,
                "room": room,
                "startTime": start_12h,
                "endTime": end_12h,
                "rawStartTime": raw_start_12h,
                "rawEndTime": raw_end_12h,
                "timeNormalized": time_normalized,
                "actualStart": act_start,
                "actualEnd": act_end,
                "actualStartTime": act_start_12h,
                "actualEndTime": act_end_12h,
                "status": status,
                "mrn": mrn,
                "patientName": patient_name,
                "surgeonName": surgeon,
                "engOperationName": op_en,
                "arOperationName": op_ar,
                "contractorName": contractor,
                "paidBy": paid_by,
                "flClassName": fl_class,
                "vt": vt,
                "postC": post_c,
                "preparationInstructions": prep,
                "operativeComment": comment,
                "cathlabDose": dose,
            }
        else:
            ex = grouped[group_key]
            ex["engOperationName"] = _merge_distinct(ex["engOperationName"], op_en)
            ex["arOperationName"] = _merge_distinct(ex["arOperationName"], op_ar)
            ex["surgeonName"] = _merge_distinct(ex["surgeonName"], surgeon)
            ex["operativeComment"] = _merge_distinct(ex["operativeComment"], comment)
            ex["preparationInstructions"] = _merge_distinct(ex["preparationInstructions"], prep)
            ex["cathlabDose"] = _merge_distinct(ex["cathlabDose"], dose, sep=" | ")
            if not ex["endTime"] and end_12h:
                ex["endTime"] = end_12h
            if not ex["actualStart"] and act_start:
                ex["actualStart"] = act_start
                ex["actualStartTime"] = act_start_12h
            if not ex["actualEnd"] and act_end:
                ex["actualEnd"] = act_end
                ex["actualEndTime"] = act_end_12h
            if ex["status"].lower() != "completed" and status.lower() == "completed":
                ex["status"] = status
            if not ex["contractorName"] and contractor:
                ex["contractorName"] = contractor
            if not ex["paidBy"] and paid_by:
                ex["paidBy"] = paid_by
            if not ex["vt"] and vt:
                ex["vt"] = vt
            if not ex["postC"] and post_c:
                ex["postC"] = post_c

    items = [grouped[k] for k in ordered_keys]
    items.sort(key=lambda x: (x["procedureDate"], _parse_time_12h_minutes(x["startTime"]), x["room"]))

    today_cnt = 0
    upcoming_cnt = 0
    recent_cnt = 0
    in_progress_cnt = 0
    completed_today_cnt = 0
    scheduled_today_cnt = 0

    for i, item in enumerate(items, 1):
        item["serial"] = str(i)
        pd_str = item["procedureDate"]
        st_low = item["status"].lower()
        if pd_str == reference_date_str:
            today_cnt += 1
            if st_low == "inor":
                in_progress_cnt += 1
            elif st_low == "completed":
                completed_today_cnt += 1
            else:
                scheduled_today_cnt += 1
        elif pd_str > reference_date_str:
            upcoming_cnt += 1
        else:
            recent_cnt += 1

    return {
        "unit": unit,
        "referenceDate": reference_date_str,
        "source": "powerbi_onprem",
        "summary": {
            "todayCount": today_cnt,
            "upcomingCount": upcoming_cnt,
            "recentCount": recent_cnt,
            "inProgressCount": in_progress_cnt,
            "completedTodayCount": completed_today_cnt,
            "scheduledTodayCount": scheduled_today_cnt,
        },
        "items": items,
    }


def fetch_powerbi_procedures_and_sync(force: bool = False, dry_run: bool = False) -> bool:
    """Fetches Cath Lab & Endoscopy rolling 14-day schedules (-7d .. +7d) into feeds/cathlab_list & feeds/endoscopy_list."""
    cairo_today = get_cairo_now().date()
    win_start = cairo_today - datetime.timedelta(days=7)
    win_end = cairo_today + datetime.timedelta(days=7)
    ref_str = cairo_today.isoformat()
    auth = HttpNtlmAuth(POWERBI_USER, POWERBI_PASS) if POWERBI_USER else None

    def _build_where(rooms: list[str]) -> list[dict[str, Any]]:
        return [
            {"Condition": {"In": {"Expressions": [{"Column": {"Expression": {"SourceRef": {"Source": "o"}}, "Property": "OR Room"}}], "Values": [[{"Literal": {"Value": f"'{rm}'"}}] for rm in rooms]}}},
            {"Condition": {"In": {"Expressions": [{"Column": {"Expression": {"SourceRef": {"Source": "o"}}, "Property": "Status"}}], "Values": [[{"Literal": {"Value": "'Completed'"}}], [{"Literal": {"Value": "'Scheduled'"}}], [{"Literal": {"Value": "'InOR'"}}]]}}},
            {"Condition": {"Not": {"Expression": {"In": {"Expressions": [{"Column": {"Expression": {"SourceRef": {"Source": "o"}}, "Property": "ORStatus"}}], "Values": [[{"Literal": {"Value": "'Cancel'"}}]]}}}}},
            {"Condition": {"Not": {"Expression": {"In": {"Expressions": [{"Column": {"Expression": {"SourceRef": {"Source": "o"}}, "Property": "FLOperationName"}}], "Values": [[{"Literal": {"Value": "null"}}]]}}}}},
            {"Condition": {"And": {
                "Left": {"Comparison": {"ComparisonKind": 2, "Left": {"Column": {"Expression": {"SourceRef": {"Source": "o"}}, "Property": "StartDateTime"}}, "Right": {"Literal": {"Value": f"datetime'{win_start.isoformat()}T00:00:00'"}}}},
                "Right": {"Comparison": {"ComparisonKind": 3, "Left": {"Column": {"Expression": {"SourceRef": {"Source": "o"}}, "Property": "StartDateTime"}}, "Right": {"Literal": {"Value": f"datetime'{win_end.isoformat()}T23:59:59'"}}}},
            }}},
        ]

    specs = [
        ("cathlab", "feeds/cathlab_list", POWERBI_CATHLAB_EXPORT_URL, 141890993, 1, ["Cath Lab Theatre", "CathLab Operation Theatre 2"], [("Actual Start", "Actual Start"), ("Actual End", "Actual End")]),
        ("endoscopy", "feeds/endoscopy_list", POWERBI_ENDO_EXPORT_URL, 1497662051, 2, ["Endoscopy Operation Theatre"], [("Status", "Status"), ("VT", "VT")]),
    ]
    all_ok = True
    for unit, path, url, fallback_mid, sec_idx, rooms, extra_props in specs:
        try:
            xlsx = _fetch_powerbi_table_export(
                url,
                fallback_model_id=fallback_mid,
                section_index=sec_idx,
                where_override=_build_where(rooms),
                extra_select_props=extra_props,
                auth=auth,
            )
            parsed = parse_powerbi_procedure_excel(xlsx, unit=unit, reference_date_str=ref_str)
            parsed["windowStart"] = win_start.isoformat()
            parsed["windowEnd"] = win_end.isoformat()
            wrote = upsert_feed_node_if_changed(path, parsed, force=force, dry_run=dry_run)
            s = parsed["summary"]
            log(
                f"[Procedures Sync:{unit}] {len(parsed['items'])} cases in 14d window "
                f"(today={s['todayCount']}, upcoming={s['upcomingCount']}, recent={s['recentCount']}, wrote={wrote})."
            )
        except Exception as e:
            all_ok = False
            log(f"[Procedures Sync:{unit}] Non-fatal error: {e}", level="warning")
    return all_ok


# --- SCHEDULING & TIMEZONE ROLLOVER ORCHESTRATION ---

last_cairo_seen_date: str = ""


def check_cairo_day_rollover() -> None:
    """Detects midnight, 22:00 OPD purge+tomorrow-fetch, and 23:59 EOD rollovers in Cairo timezone."""
    global last_cairo_seen_date, _last_opd_2200_done_date, _last_opd_2200_attempt_ts, _opd_2200_retry_needed
    now_cairo = get_cairo_now()
    today_str = now_cairo.strftime("%Y-%m-%d")

    if not last_cairo_seen_date:
        last_cairo_seen_date = today_str
        return

    # Daily 10:00 PM (22:00) Cairo trigger: purge current OPD list and fetch tomorrow's OPD Doctors Sheet
    # Retries every 5 minutes until 22:30 if the initial 22:00 fetch failed.
    if now_cairo.hour == 22:
        tomorrow_date = now_cairo.date() + datetime.timedelta(days=1)
        should_initial = _last_opd_2200_done_date != today_str
        should_retry = (
            _opd_2200_retry_needed
            and now_cairo.minute <= 30
            and (time.time() - _last_opd_2200_attempt_ts) >= 300.0
        )
        if should_initial or should_retry:
            _last_opd_2200_done_date = today_str
            _last_opd_2200_attempt_ts = time.time()
            action_label = "Retry" if should_retry and not should_initial else "Trigger"
            log(
                f"[OPD 22:00 {action_label}] 22:00 Cairo reached ({today_str} {now_cairo.strftime('%H:%M')}). "
                f"Purging current OPD list and fetching tomorrow's OPD Doctors Sheet ({tomorrow_date.isoformat()})..."
            )
            if not _is_paused:
                fortinet_reconnect()
                ok = fetch_powerbi_opd_and_sync(
                    target_date=tomorrow_date,
                    force=True,
                    purge_before_fetch=True,
                )
                _opd_2200_retry_needed = not ok
                publish_standalone_heartbeat()

    clean_last_seen = last_cairo_seen_date.replace("_1159_done", "")
    if today_str != clean_last_seen:
        log(f"[Calendar Rollover] Date transitioned from {clean_last_seen} to {today_str}. Triggering midnight sync & OR refresh...")
        last_cairo_seen_date = today_str
        run_sync_job(force=True, force_future_or=False)
    elif now_cairo.hour == 23 and now_cairo.minute >= 58:
        if last_cairo_seen_date == today_str:
            last_cairo_seen_date = f"{today_str}_1159_done"
            log(f"[EOD Reset] 23:59 Cairo reached ({today_str} {now_cairo.strftime('%H:%M')}). Triggering closing snapshot...")
            run_sync_job(force=True)


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


def run_sync_job(force: bool = False, force_future_or: Optional[bool] = None) -> None:
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
    try:
        fetch_powerbi_approvals_and_sync(force=force)
    except Exception as e:
        log(f"[Approvals Sync] Non-fatal cycle error: {e}", level="warning")
    try:
        fetch_powerbi_opd_live_and_sync(force=force)
    except Exception as e:
        log(f"[OPD Live Sync] Non-fatal cycle error: {e}", level="warning")
    if force or _last_or_sync_ts == 0.0 or (time.time() - _last_or_sync_ts) >= 7200.0:
        run_or_full_cycle(force=force, force_future=force_future_or)
    if _last_opd_sync_ts == 0.0 or force:
        cairo_now = get_cairo_now()
        opd_target = get_opd_target_date(cairo_now)
        fetch_powerbi_opd_and_sync(target_date=opd_target, force=force)
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
    or_weekly_dry_run = "--or-weekly-dry-run" in sys.argv
    opd_dry_run = "--opd-dry-run" in sys.argv
    opd_sync_only = "--opd-sync-only" in sys.argv
    approvals_dry_run = "--approvals-dry-run" in sys.argv
    opd_live_dry_run = "--opd-live-dry-run" in sys.argv
    procedures_dry_run = "--procedures-dry-run" in sys.argv
    sync_new_feeds_only = "--sync-new-feeds-only" in sys.argv

    if approvals_dry_run or opd_live_dry_run or procedures_dry_run or sync_new_feeds_only:
        fortinet_reconnect()
        if approvals_dry_run or sync_new_feeds_only:
            fetch_powerbi_approvals_and_sync(force=force_now, dry_run=approvals_dry_run)
        if opd_live_dry_run or sync_new_feeds_only:
            fetch_powerbi_opd_live_and_sync(force=True, dry_run=opd_live_dry_run)
        if procedures_dry_run or sync_new_feeds_only:
            fetch_powerbi_procedures_and_sync(force=force_now, dry_run=procedures_dry_run)
        sys.exit(0)

    if opd_dry_run or opd_sync_only:
        cairo_now = get_cairo_now()
        opd_target = cairo_now.date() + datetime.timedelta(days=1) if (cairo_now.hour == 23 and cairo_now.minute >= 30) else cairo_now.date()
        fortinet_reconnect()
        fetch_powerbi_opd_and_sync(target_date=opd_target, force=True, dry_run=opd_dry_run)
        sys.exit(0)

    if or_weekly_dry_run:
        log("[OR Future Dry-Run] Running read-only future OR weekly reconciliation check...")
        fortinet_reconnect()
        fetch_powerbi_or_future_and_sync(force=True, dry_run=True)
        sys.exit(0)

    poll_standalone_control(init_only=True)
    log(f"Hospital Occupancy Sync Service Online ({RUNNER_ID}). Initializing first run...")
    publish_standalone_heartbeat()
    run_sync_job(force=force_now)

    if run_once:
        log("Single sync cycle (--once) completed. Exiting.")
        sys.exit(0)

    schedule.every(30).minutes.do(run_sync_job)
    schedule.every(2).hours.do(run_or_sync_job)

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
