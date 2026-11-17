import datetime
import io
import json
import os
import sys
import unittest
from unittest.mock import MagicMock, patch

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import sync_powerbi_relational as bridge


def _make_or_excel_bytes(rows: list[list[str]], include_start_dt: bool = True) -> bytes:
    header = [
        "Start Time", "End Time", "Patient Name", "MRN", "FLOperationName",
        "SLOperationName", "Surgeon Name", "PreparationInstructions", "OR Room",
        "ContractorName", "PaidBy", "VT", "Post C", "OperativeComment",
        "i/o", "FLClassName", "OverWeight"
    ]
    if include_start_dt:
        header = ["StartDateTime"] + header
    sheet_rows = [["Applied filters: test"], [""], header] + rows
    df = pd.DataFrame(sheet_rows)
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as writer:
        df.to_excel(writer, index=False, header=False)
    return buf.getvalue()


class TestORWeeklySync(unittest.TestCase):
    def test_week_windows_month_and_year_rollover(self):
        wins = bridge.week_windows(datetime.date(2026, 12, 28), 2)
        self.assertEqual(
            wins,
            [
                (datetime.date(2026, 12, 29), datetime.date(2027, 1, 4)),
                (datetime.date(2027, 1, 5), datetime.date(2027, 1, 11)),
            ],
        )

    def test_build_or_powerbi_payload_today_vs_range(self):
        # 00:10 AM Cairo on Nov 18 (still Nov 17 22:10 UTC) must query 2026-11-18 explicitly, never UTC DateSpan(Now)
        now = datetime.datetime(2026, 11, 18, 0, 10, tzinfo=bridge.CAIRO_TZ)
        today_payload = bridge.build_or_powerbi_payload("1135690937", now)
        q_today = today_payload["executeSemanticQueryRequest"]["queries"][0]["Query"]["Commands"][0]["SemanticQueryDataShapeCommand"]["Query"]
        self.assertEqual(len(q_today["Select"]), 17)
        where_today = json.dumps(q_today["Where"])
        self.assertNotIn("DateSpan", where_today)
        self.assertIn("datetime'2026-11-18T00:00:00'", where_today)
        self.assertIn("datetime'2026-11-18T23:59:59'", where_today)

        range_payload = bridge.build_or_powerbi_payload(
            "1135690937", now, datetime.date(2026, 11, 18), datetime.date(2026, 11, 24)
        )
        q_range = range_payload["executeSemanticQueryRequest"]["queries"][0]["Query"]["Commands"][0]["SemanticQueryDataShapeCommand"]["Query"]
        self.assertEqual(len(q_range["Select"]), 18)
        self.assertIn("datetime'2026-11-18T00:00:00'", json.dumps(q_range["Where"]))
        self.assertIn("datetime'2026-11-24T23:59:59'", json.dumps(q_range["Where"]))

    def test_parse_powerbi_or_excel_by_date_buckets_and_missing_header(self):
        row1 = ["2026-11-19 08:00:00", "08:00:00", "09:00:00", "أحمد علي", "1001", "Lap Chole", "", "د. حسن", "", "OR - 1", "Bupa", "", "IN", "", "", "Scheduled", ""]
        row2 = ["2026-11-20 10:00:00", "10:00:00", "11:00:00", "منى محمد", "1002", "Hernia", "", "د. عمر", "", "OR - 2", "Cash", "", "OUT", "", "", "DayCase", ""]
        xlsx = _make_or_excel_bytes([row1, row2], include_start_dt=True)

        by_date, found = bridge.parse_powerbi_or_excel_by_date(xlsx, "2026-11-18", {})
        self.assertTrue(found)
        self.assertEqual(len(by_date["2026-11-19"]), 1)
        self.assertEqual(by_date["2026-11-19"][0]["orListDate"], "2026-11-19")
        self.assertEqual(len(by_date["2026-11-20"]), 1)
        self.assertEqual(by_date["2026-11-20"][0]["orListDate"], "2026-11-20")

        # Missing header returns ( {}, False )
        bad_df = pd.DataFrame([["Error page"], ["Timeout"]])
        bad_buf = io.BytesIO()
        with pd.ExcelWriter(bad_buf, engine="openpyxl") as writer:
            bad_df.to_excel(writer, index=False, header=False)
        by_date_bad, found_bad = bridge.parse_powerbi_or_excel_by_date(bad_buf.getvalue(), "2026-11-18", {})
        self.assertFalse(found_bad)
        self.assertEqual(by_date_bad, {})

    def test_reconcile_or_date_diff_empty_guard_and_past_refusal(self):
        empty_counts: dict[str, int] = {}
        # Past / today refused
        self.assertTrue(bridge.reconcile_or_date("2026-11-17", "2026-11-17", [], None, None, empty_counts)["skip"])
        self.assertTrue(bridge.reconcile_or_date("2026-11-16", "2026-11-17", [], None, None, empty_counts)["skip"])

        c1 = {"mrn": "101", "patientName": "Ali", "startTime": "08:00 AM", "orRoom": "OR - 1", "engOperationName": "Op1"}
        c2 = {"mrn": "102", "patientName": "Sara", "startTime": "09:00 AM", "orRoom": "OR - 2", "engOperationName": "Op2"}
        c1_mod = {**c1, "engOperationName": "Op1 Revised"}

        # Hash match skips
        h1 = bridge.compute_or_cases_hash([c1])
        r_same = bridge.reconcile_or_date("2026-11-19", "2026-11-17", [c1], [c1], h1, empty_counts)
        self.assertTrue(r_same["skip"])
        self.assertEqual(r_same["reason"], "hash_match")

        # Add 1, remove 0, change 1
        r_diff = bridge.reconcile_or_date("2026-11-19", "2026-11-17", [c1_mod, c2], [c1], h1, empty_counts)
        self.assertFalse(r_diff["skip"])
        self.assertEqual(r_diff["diff"], {"added": 1, "removed": 0, "changed": 1})

        # Empty guard: 1st empty skipped, 2nd consecutive empty allowed
        r_emp1 = bridge.reconcile_or_date("2026-11-19", "2026-11-17", [], [c1], h1, empty_counts)
        self.assertTrue(r_emp1["skip"])
        self.assertEqual(r_emp1["reason"], "empty_guard")
        r_emp2 = bridge.reconcile_or_date("2026-11-19", "2026-11-17", [], [c1], h1, empty_counts)
        self.assertFalse(r_emp2["skip"])
        self.assertEqual(r_emp2["diff"], {"added": 0, "removed": 1, "changed": 0})

    def test_future_sync_hash_first_skips_reads_and_writes_when_unchanged(self):
        row = ["2026-11-18 08:00:00", "08:00:00", "09:00:00", "أحمد علي", "1001", "Lap Chole", "", "د. حسن", "", "OR - 1", "Bupa", "", "IN", "", "", "Scheduled", ""]
        xlsx = _make_or_excel_bytes([row], include_start_dt=True)
        parsed_by_date, _ = bridge.parse_powerbi_or_excel_by_date(xlsx, "2026-11-18", {})

        # Precompute hashes for all 7 days of week 1 (2026-11-18 .. 2026-11-24)
        summary_rows = []
        for offset in range(1, 8):
            d_str = (datetime.date(2026, 11, 17) + datetime.timedelta(days=offset)).isoformat()
            h = bridge.compute_or_cases_hash(parsed_by_date.get(d_str, []))
            summary_rows.append({"path": f"history/or/{d_str}/summary", "data": {"hash": h}})

        mock_sb = MagicMock()
        mock_sb.get.return_value = MagicMock(status_code=200, json=lambda: summary_rows)

        mock_pbi_resp = MagicMock(status_code=200, content=xlsx)
        mock_pbi_resp.raise_for_status = MagicMock()

        with patch.object(bridge, "OR_FUTURE_WEEKS", 1), \
             patch.object(bridge, "OR_FUTURE_SYNC_ENABLED", True), \
             patch.object(bridge, "_last_known_mrns_by_name", {"احمد علي": "1001"}), \
             patch.object(bridge, "SUPABASE_KEY", "test-key"), \
             patch.object(bridge, "get_cairo_now", return_value=datetime.datetime(2026, 11, 17, 12, 0, tzinfo=bridge.CAIRO_TZ)), \
             patch.object(bridge, "get_or_powerbi_model_id", return_value="1135690937"), \
             patch.object(bridge, "get_supabase_session", return_value=mock_sb), \
             patch.object(bridge.requests, "post", return_value=mock_pbi_resp):
            ok = bridge.fetch_powerbi_or_future_and_sync(force=False, dry_run=False)

        self.assertTrue(ok)
        # Only 1 GET (for summaries), 0 GETs for cases, 0 POSTs to Supabase!
        self.assertEqual(mock_sb.get.call_count, 1)
        self.assertIn("/summary", mock_sb.get.call_args[0][0])
        self.assertEqual(mock_sb.post.call_count, 0)

    def test_today_sync_reuses_persisted_summary_hash_after_restart(self):
        row = ["08:00:00", "09:00:00", "أحمد علي", "1001", "Lap Chole", "", "د. حسن", "", "OR - 1", "Bupa", "", "IN", "", "", "Scheduled", ""]
        xlsx = _make_or_excel_bytes([row], include_start_dt=False)
        parsed = bridge.parse_powerbi_or_excel(xlsx, "2026-11-17", {})
        expected_hash = bridge.compute_or_cases_hash(parsed)

        mock_sb = MagicMock()
        mock_sb.get.return_value = MagicMock(status_code=200, json=lambda: [{"data": {"hash": expected_hash}}])
        mock_pbi_resp = MagicMock(status_code=200, content=xlsx)
        mock_pbi_resp.raise_for_status = MagicMock()

        with patch.object(bridge, "_last_synced_or_hash", ""), \
             patch.object(bridge, "_last_synced_or_cairo_date", ""), \
             patch.object(bridge, "_last_known_mrns_by_name", {"احمد علي": "1001"}), \
             patch.object(bridge, "SUPABASE_KEY", "test-key"), \
             patch.object(bridge, "get_cairo_now", return_value=datetime.datetime(2026, 11, 17, 12, 0, tzinfo=bridge.CAIRO_TZ)), \
             patch.object(bridge, "get_or_powerbi_model_id", return_value="1135690937"), \
             patch.object(bridge, "get_supabase_session", return_value=mock_sb), \
             patch.object(bridge.requests, "post", return_value=mock_pbi_resp):
            ok = bridge.fetch_powerbi_or_and_sync(force=False)

        self.assertTrue(ok)
        self.assertEqual(mock_sb.post.call_count, 0)


if __name__ == "__main__":
    unittest.main()
