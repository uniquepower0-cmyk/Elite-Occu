import io
import json
import unittest
from unittest.mock import MagicMock, patch

import pandas as pd

import sync_powerbi_relational as sync_mod


def _df_to_xlsx_bytes(rows: list[list[object]]) -> bytes:
    buf = io.BytesIO()
    df = pd.DataFrame(rows)
    with pd.ExcelWriter(buf, engine="openpyxl") as writer:
        df.to_excel(writer, index=False, header=False)
    return buf.getvalue()


class TestNewPowerBIFeeds(unittest.TestCase):
    def test_parse_approvals_classifies_severity_and_summaries(self):
        xlsx = _df_to_xlsx_bytes([
            ["Applied filters: none"],
            [
                "ContractorName", "DefaultMobile", "EnglishFullName", "ClosedRequests",
                "FloorStructureName_EN", "PatientBarcode", "Physician Name", "TotalRequests",
                "PendingRequests", "LOS", "ApprovalCount", "Agent Name", "Status",
                "InvoiceComment", "RejectedRequests", "InProgressRequests", "AdmissionDate",
            ],
            [
                "Next Care", "01000000001", "Patient One", 1,
                "Room 312", "0012345", "Dr. Ahmed", 4,
                0, 5, 2, "Agent A", "ApprovalsForEverything",
                "Need CT approval", 2, 1, "2026-11-20",
            ],
            [
                "GlobeMed", "01000000002", "Patient Two", 0,
                "Room 405", "67890", "Dr. Mona", 2,
                2, 2, 1, "Agent B", "NeedUpdateAfteraddmission",
                "", 0, 0, "2026-11-22",
            ],
            [
                "Home Care - Cash", "01000000003", "Patient Three", 1,
                "HomeCare 1", "99999", "Dr. Karim", 1,
                0, 1, 1, "", "NoNeedForApprovalinPricelist",
                "", 0, 0, "2026-11-23",
            ],
        ])

        result = sync_mod.parse_powerbi_approvals_excel(xlsx)
        self.assertEqual(len(result["items"]), 3)
        summary = result["summary"]
        self.assertEqual(summary["totalPatients"], 3)
        self.assertEqual(summary["patientsWithBottlenecks"], 2)
        self.assertEqual(summary["totalRejected"], 2)
        self.assertEqual(summary["totalPending"], 2)
        self.assertEqual(summary["totalInProgress"], 1)
        self.assertEqual(summary["needUpdateCount"], 1)

        by_mrn = {it["mrn"]: it for it in result["items"]}
        self.assertEqual(by_mrn["12345"]["severity"], "critical")
        self.assertEqual(by_mrn["67890"]["severity"], "critical")
        self.assertEqual(by_mrn["99999"]["severity"], "ok")
        self.assertTrue(len(summary["byContractor"]) >= 2)
        self.assertTrue(len(summary["byAgent"]) >= 2)

    def test_parse_approvals_raises_on_corrupt_header(self):
        bad_xlsx = _df_to_xlsx_bytes([["Junk1", "Junk2"], ["a", "b"]])
        with self.assertRaises(ValueError):
            sync_mod.parse_powerbi_approvals_excel(bad_xlsx)

    def test_parse_opd_live_aggregates_without_pii_phones(self):
        live_xlsx = _df_to_xlsx_bytes([
            ["ENName", "FLSpecialtyName", "Sporting", "MobilePhone", "EmployeeEnglishFullName", "PatientName", "MaxStatusGUID", "CreationDateTime", "VisitDatetime"],
            ["Cash", "Orthopedic Surgery", "ELite", "01011111111", "Dr. Tarek", "P1", "ArrivedConfirmed", "2024-01-01", "2026-11-24 09:00"],
            ["Cash", "Orthopedic Surgery", "ELite", "01022222222", "Dr. Tarek", "P2", "EndVisit", "2024-01-01", "2026-11-24 09:10"],
            ["Cash", "Orthopedic Surgery", "ELite", "01033333333", "Dr. Tarek", "P3", "Reserved", "2024-01-01", "2026-11-24 09:20"],
            ["Cash", "ENT Clinic", "ELite", "01044444444", "Dr. Salma", "P4", "StartVisit", "2024-01-01", "2026-11-24 09:30"],
            ["Cash", "ENT Clinic", "ELite", "01055555555", "Dr. Salma", "P5", "Cancel", "2024-01-01", "2026-11-24 09:40"],
        ])
        queue_xlsx = _df_to_xlsx_bytes([
            ["ENName", "EmployeeArabicFullName", "FLSpecialtyName", "MobilePhone", "PatientName", "MaxStatusGUID", "DateOfConfirmation", "TicketNo", "ID", "RequestNumberStatus"],
            ["Cash", "د. طارق", "Orthopedic Surgery", "01011111111", "P1", "ArrivedConfirmed", "2026-11-24", 1, 1, "Requested"],
            ["Cash", "د. طارق", "Orthopedic Surgery", "01022222222", "P2", "EndVisit", "2026-11-24", 2, 1, ""],
            ["Cash", "د. سلمى", "ENT Clinic", "01044444444", "P4", "StartVisit", "2026-11-24", 3, 1, ""],
        ])

        result = sync_mod.parse_powerbi_opd_live_excels(live_xlsx, queue_xlsx, "2026-11-24")
        s = result["summary"]
        self.assertEqual(s["totalBookings"], 5)
        self.assertEqual(s["arrivedWaiting"], 1)
        self.assertEqual(s["inClinic"], 1)
        self.assertEqual(s["completed"], 1)
        self.assertEqual(s["reserved"], 1)
        self.assertEqual(s["cancelled"], 1)
        self.assertEqual(s["pendingTicketRequests"], 1)
        self.assertEqual(s["confirmedQueueWaiting"], 1)
        self.assertEqual(s["showUpRatePct"], 75.0)

        # Ensure zero raw phone numbers leak into persisted payload
        serialized = json.dumps(result, ensure_ascii=False)
        self.assertNotIn("01011111111", serialized)
        self.assertNotIn("01022222222", serialized)

    def test_parse_procedures_splits_today_upcoming_recent_and_handles_empty(self):
        cath_xlsx = _df_to_xlsx_bytes([
            [
                "EnglishFullName", "FLClassName", "PreparationInstructions", "Room Name",
                "ContractorName", "PaidBy", "Start Time", "End Time", "PostRoomCategoryGUID",
                "OperativeComment", "Expr1", "Expr2", "FinancialStatusGUID", "MRN", "VT",
                "Actual Patient Name", "Cathlab Dose", "EndDateTime", "StartDateTime", "Status",
            ],
            [
                "Dr. Hany", "Premium", "NPO", "Cath Lab Theatre",
                "Next Care", "Insurance", "10:00", "11:30", "CCU",
                "PCI", "Coronary Angio", "قسطرة قلب", "Open", "00555", "Inpatient",
                "Ali Hassan", "420 mGy", "2026-11-24 11:30:00", "2026-11-24 10:00:00", "Scheduled",
            ],
            [
                "Dr. Hany", "Premium", "", "Cath Lab Theatre",
                "Cash", "Cash", "12:00", "13:00", "Ward",
                "", "Diagnostic Cath", "قسطرة تشخيصية", "Open", "00666", "Inpatient",
                "Mona Adel", "310 mGy", "2026-11-26 13:00:00", "2026-11-26 12:00:00", "Scheduled",
            ],
            [
                "Dr. Hany", "Premium", "", "Cath Lab Theatre",
                "Cash", "Cash", "09:00", "10:00", "CCU",
                "", "Stent", "دعامة", "Closed", "00777", "Inpatient",
                "Sami Nour", "290 mGy", "2026-11-22 10:00:00", "2026-11-22 09:00:00", "Completed",
            ],
        ])

        res = sync_mod.parse_powerbi_procedure_excel(cath_xlsx, unit="cathlab", reference_date_str="2026-11-24")
        self.assertEqual(res["summary"]["todayCount"], 1)
        self.assertEqual(res["summary"]["upcomingCount"], 1)
        self.assertEqual(res["summary"]["recentCount"], 1)
        self.assertEqual(res["items"][0]["cathlabDose"], "290 mGy")

        # Valid empty export (headers present, 0 data rows) should NOT raise
        empty_valid_xlsx = _df_to_xlsx_bytes([
            ["EnglishFullName", "Room Name", "MRN", "Actual Patient Name", "StartDateTime", "Status"]
        ])
        empty_res = sync_mod.parse_powerbi_procedure_excel(empty_valid_xlsx, unit="cathlab", reference_date_str="2026-11-24")
        self.assertEqual(empty_res["items"], [])
        self.assertEqual(empty_res["summary"]["todayCount"], 0)

    def test_upsert_feed_node_two_tier_dedup_and_dry_run(self):
        sync_mod._last_feed_hashes.clear()
        payload_body = {"summary": {"total": 2}, "items": [{"mrn": "1"}, {"mrn": "2"}]}

        fake_sess = MagicMock()
        # Tier 2 cloud check returns matching hash -> should NOT call POST
        h = sync_mod.compute_feed_hash(payload_body)
        get_resp = MagicMock(status_code=200)
        get_resp.json.return_value = [{"hash": h}]
        fake_sess.get.return_value = get_resp

        with patch.object(sync_mod, "get_supabase_session", return_value=fake_sess):
            wrote = sync_mod.upsert_feed_node_if_changed("feeds/test_node", payload_body, force=False, dry_run=False)
            self.assertFalse(wrote)
            fake_sess.get.assert_called_once()
            fake_sess.post.assert_not_called()

            # Tier 1 in-memory cache hit -> 0 GETs and 0 POSTs!
            fake_sess.reset_mock()
            wrote2 = sync_mod.upsert_feed_node_if_changed("feeds/test_node", payload_body, force=False, dry_run=False)
            self.assertFalse(wrote2)
            fake_sess.get.assert_not_called()
            fake_sess.post.assert_not_called()

            # Modified data -> cloud hash differs -> POST called once
            payload_body2 = {"summary": {"total": 3}, "items": [{"mrn": "1"}, {"mrn": "2"}, {"mrn": "3"}]}
            get_resp2 = MagicMock(status_code=200)
            get_resp2.json.return_value = [{"hash": h}]
            post_resp = MagicMock(status_code=201)
            fake_sess.get.return_value = get_resp2
            fake_sess.post.return_value = post_resp

            wrote3 = sync_mod.upsert_feed_node_if_changed("feeds/test_node", payload_body2, force=False, dry_run=False)
            self.assertTrue(wrote3)
            fake_sess.post.assert_called_once()

            # Dry run -> never POSTs even with force=True
            fake_sess.reset_mock()
            wrote4 = sync_mod.upsert_feed_node_if_changed("feeds/test_node", payload_body2, force=True, dry_run=True)
            self.assertFalse(wrote4)
            fake_sess.post.assert_not_called()


if __name__ == "__main__":
    unittest.main()
