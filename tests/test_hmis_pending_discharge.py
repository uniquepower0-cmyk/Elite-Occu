import os
import sys
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import sync_powerbi_relational as bridge


def _make_record(bed: str, mrn: str, name: str, adm: str = "18-11-2026 18:02", physician: str = "Dr. Test", contractor: str = "Cash"):
    clean_m = bridge.clean_mrn_str(mrn)
    raw = {
        "Admission Date": adm,
        "Bed#": bed,
        "MRN": mrn,
        "Patient Name": name,
        "Mobile": "01000000000",
        "FinancialStatus": "Cash",
        "Floor Name": "Elite 4th Floor",
        "Contractor Name": contractor,
        "TreatingPhysicianName": physician,
        "Specialty": "General Surgery",
        "ICD-10": "Test Diagnosis",
        "Invoice Total": "1000",
        "Difference": "200",
    }
    return bridge.NormalizedPatientRecord(
        mrn=clean_m or mrn,
        clean_mrn=clean_m,
        name=name,
        bed=bed,
        floor="Elite 4th Floor",
        physician=physician,
        admission_date=adm,
        contractor=contractor,
        financial_status="Cash",
        total_invoice=1000.0,
        remaining_debt=200.0,
        specialty="General Surgery",
        diagnosis="Test Diagnosis",
        mobile="01000000000",
        los="1",
        alos="2.0",
        expected_discharge="",
        medications="",
        initial_assessment="",
        vte_summary="",
        notes="",
        handover="",
        visit_type="HospitalCase",
        payment_by="Patient",
        raw_row=raw,
    )


class TestCompanionBedDetection(unittest.TestCase):
    def test_companion_beds_detected(self):
        companion_samples = [
            "Bed 405 C",
            "405 C",
            "Bed 405 D",
            "Bed 421 B",
            "Bed 306 C",
            "Bed 320c",
            "Bed 402A - C ",
            "Bed 408 C I",
            "Bed 408 C II",
            "Bed 308 - 1 c",
            "Bed 102 - C1",
            "Bed 102 - C 2",
            "304 C 2",
            "319 C",
            "Bed 407 c",
            "Bed 407 C2",
            "Bed 409 C",
            "Companion 1",
            "مرافق 405",
        ]
        for bed in companion_samples:
            with self.subTest(bed=bed):
                self.assertTrue(bridge.is_companion_bed(bed), f"Expected companion bed: {bed!r}")
                self.assertTrue(bridge.is_excluded_from_inpatient_census(bed), f"Expected excluded from census: {bed!r}")

    def test_real_inpatient_beds_not_flagged(self):
        patient_samples = [
            "Bed 405 A",
            "Bed 405 B",
            "405 A",
            "Bed 407",
            "Bed 409",
            "Bed 421",
            "Bed 421 A",
            "Bed 307 intermediate care",
            "Home Care 32",
            "VIP CCU",
            "CCU Bed 2",
            "ICU Bed 7",
            "Bed 103 - 1",
            "Bed 330 A",
            "Bed 331 B",
        ]
        for bed in patient_samples:
            with self.subTest(bed=bed):
                self.assertFalse(bridge.is_companion_bed(bed), f"False positive companion bed: {bed!r}")


class TestHmisPendingFetch(unittest.TestCase):
    def test_fetch_hmis_skips_companion_beds(self):
        hmis_payload = [
            {
                "BedName_EN": "Bed 405 A",
                "FloorStructureName_EN": "Room 405 ",
                "PatientBarcode": "0000004447",
                "EnglishFullName": "سهير ابراهيم مصطفى صيام",
                "ArabicFullName": "Sohaer Ebrahim Moustafa seam",
                "AdmissionStatus": "FinancialDischarge",
                "IsForCompanion": False,
                "CompanionGUID": None,
                "AdmissionDate": "2026-11-17T05:59:16.663",
            },
            {
                "BedName_EN": "Bed 405 C",
                "FloorStructureName_EN": "Room 405 ",
                "PatientBarcode": None,
                "EnglishFullName": "باهر محمد منصور مصطفى",
                "ArabicFullName": "باهر محمد منصور مصطفى",
                "AdmissionStatus": "FinancialDischarge",
                "IsForCompanion": True,
                "CompanionGUID": "73f6b405-f131-40dc-ac4d-da6e3ef5a888",
                "AdmissionDate": "2026-11-17T05:59:16.663",
            },
            {
                "BedName_EN": "Bed 421 B",
                "FloorStructureName_EN": "Room 421",
                "PatientBarcode": None,
                "EnglishFullName": "مرافق اختبار",
                "ArabicFullName": "Test Companion",
                "AdmissionStatus": "FinancialDischarge",
                "IsForCompanion": False,
                "CompanionGUID": None,
            },
            {
                "BedName_EN": "Bed 409",
                "FloorStructureName_EN": "Room 409",
                "PatientBarcode": "0000076914",
                "EnglishFullName": "محمد عيد نجا نجا",
                "ArabicFullName": "Mohamed Eaid naga naga",
                "AdmissionStatus": "FinancialDischarge",
                "IsForCompanion": False,
                "CompanionGUID": None,
                "AdmissionDate": "2026-11-18T18:02:26.687",
            },
        ]
        mock_tok = MagicMock()
        mock_tok.json.return_value = {"access_token": "tok", "UID": "uid"}
        mock_res = MagicMock()
        mock_res.json.return_value = hmis_payload

        with patch.object(bridge, "HMIS_USER", "u"), \
             patch.object(bridge, "HMIS_PASS", "p"), \
             patch.object(bridge.requests, "post", return_value=mock_tok), \
             patch.object(bridge.requests, "get", return_value=mock_res):
            cases = bridge.fetch_hmis_pending_discharges()

        self.assertEqual(len(cases), 2)
        beds = [c["bed"] for c in cases]
        self.assertIn("Bed 405 A", beds)
        self.assertIn("Bed 409", beds)
        self.assertNotIn("Bed 405 C", beds)
        self.assertNotIn("Bed 421 B", beds)


class TestReconcileHmisPending(unittest.TestCase):
    def test_evicts_financial_discharge_with_full_raw_row(self):
        rec_409 = _make_record("Bed 409", "0000076914", "محمد عيد نجا نجا", adm="18-11-2026 18:02")
        pending = [{"mrn": "76914", "name": "محمد عيد نجا نجا", "name_en": "Mohamed", "bed": "Bed 409", "structure": "Room 409"}]
        discharged: list = []
        manual_names: list = []
        manual_mrns: set = set()
        manual_discharges: list = []

        bridge.reconcile_hmis_pending_discharges(
            pending_cases=pending,
            records=[rec_409],
            already_disc=discharged,
            manual_names=manual_names,
            manual_mrns=manual_mrns,
            manual_discharges=manual_discharges,
            restored_overrides=[],
            cairo_time_str="19-11-2026 11:40",
            dry_run=False,
        )

        self.assertEqual(len(discharged), 1)
        entry = discharged[0]
        self.assertEqual(entry["source"], "hmis_pending_discharge")
        self.assertEqual(entry["mrn"], "76914")
        self.assertIsInstance(entry["rawRow"], list)
        self.assertGreaterEqual(len(entry["rawRow"]), 40)
        self.assertEqual(entry["rawRow"][3], "محمد عيد نجا نجا")
        self.assertIn("76914", manual_mrns)

    def test_skips_user_restored_override(self):
        rec_409 = _make_record("Bed 409", "0000076914", "محمد عيد نجا نجا", adm="18-11-2026 18:02")
        pending = [{"mrn": "76914", "name": "محمد عيد نجا نجا", "name_en": "Mohamed", "bed": "Bed 409", "structure": "Room 409"}]
        overrides = [{"name": "محمد عيد نجا نجا", "mrn": "76914", "room": "Bed 409", "admissionDate": "18-11-2026 18:02"}]
        discharged: list = []
        manual_names: list = []
        manual_mrns: set = set()
        manual_discharges: list = []

        bridge.reconcile_hmis_pending_discharges(
            pending_cases=pending,
            records=[rec_409],
            already_disc=discharged,
            manual_names=manual_names,
            manual_mrns=manual_mrns,
            manual_discharges=manual_discharges,
            restored_overrides=overrides,
            cairo_time_str="19-11-2026 11:40",
            dry_run=False,
        )

        self.assertEqual(len(discharged), 0)
        self.assertEqual(len(manual_names), 0)
        self.assertEqual(len(manual_mrns), 0)

    def test_auto_reverses_when_hmis_clears_financial_discharge_but_keeps_staff_manual(self):
        rec_409 = _make_record("Bed 409", "0000076914", "محمد عيد نجا نجا", adm="18-11-2026 18:02")
        rec_301 = _make_record("Bed 301", "0000111111", "مريض خروج يدوي", adm="18-11-2026 10:00")
        discharged = [
            {
                "room": "Bed 409", "mrn": "76914", "name": "محمد عيد نجا نجا",
                "date": "18-11-2026 18:02", "dischargeDate": "19-11-2026 10:15",
                "dischargeType": "manual", "source": "hmis_pending_discharge",
            },
            {
                "room": "Bed 301", "mrn": "111111", "name": "مريض خروج يدوي",
                "date": "18-11-2026 10:00", "dischargeDate": "19-11-2026 10:15",
                "dischargeType": "manual", "source": "staff_manual",
            },
            {
                "room": "Bed 405 C", "mrn": "", "name": "باهر محمد منصور مصطفى",
                "date": "", "dischargeDate": "19-11-2026 10:15",
                "dischargeType": "manual", "source": "hmis_pending_discharge",
            },
        ]
        manual_names = ["محمد عيد نجا نجا", "مريض خروج يدوي", "باهر محمد منصور مصطفى"]
        manual_mrns = {"76914", "111111"}
        manual_discharges = [
            {"name": "محمد عيد نجا نجا", "mrn": "76914", "discharge_date": "19-11-2026 10:15", "room": "Bed 409"},
            {"name": "مريض خروج يدوي", "mrn": "111111", "discharge_date": "19-11-2026 10:15", "room": "Bed 301"},
            {"name": "باهر محمد منصور مصطفى", "mrn": "", "discharge_date": "19-11-2026 10:15", "room": "Bed 405 C"},
        ]

        # HMIS now returns empty pending list (Bed 409 reverted to StartEpisode)
        bridge.reconcile_hmis_pending_discharges(
            pending_cases=[],
            records=[rec_409, rec_301],
            already_disc=discharged,
            manual_names=manual_names,
            manual_mrns=manual_mrns,
            manual_discharges=manual_discharges,
            restored_overrides=[],
            cairo_time_str="19-11-2026 11:45",
            dry_run=False,
        )

        # Bed 409 reversed, Bed 405 C companion scrubbed, Bed 301 staff manual preserved
        self.assertEqual([d["name"] for d in discharged], ["مريض خروج يدوي"])
        self.assertEqual(manual_names, ["مريض خروج يدوي"])
        self.assertEqual(manual_mrns, {"111111"})

    def test_sync_content_hash_changes_when_hmis_pending_changes(self):
        raw = [{"a": "1", "b": "2"}]
        h1 = bridge.compute_sync_content_hash(raw, [{"mrn": "76914", "bed": "Bed 409", "name": "محمد عيد نجا نجا"}])
        h2 = bridge.compute_sync_content_hash(raw, [])
        self.assertNotEqual(h1, h2)


if __name__ == "__main__":
    unittest.main()
