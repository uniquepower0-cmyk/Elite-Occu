import os
import sys
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import sync_powerbi_relational as spr


class TestVipDischargeWhatsapp(unittest.TestCase):
    def test_extract_vip_names_and_matching(self):
        vip_text = """
        *VIP CASES*
        [7:18 PM, 6/3/2026] Mohanad: سهير ابراهيم مصطفى صيام...عنايه
        1- د/ محمد عيد نجا نجا ... 409
        2. عايده عبدالعاطي عبدالله ابوكليله.....عنايه
        """
        names = spr.extract_vip_names(vip_text)
        self.assertTrue(any("سهير" in n for n in names))
        self.assertTrue(any("محمد عيد" in n for n in names))
        self.assertTrue(spr.is_patient_vip("سهير ابراهيم مصطفى صيام", vip_text))
        self.assertTrue(spr.is_patient_vip("محمد عيد نجا نجا", vip_text))
        self.assertTrue(spr.is_patient_vip("عايده عبدالعاطى عبد الله ابو كليلة", vip_text))
        self.assertFalse(spr.is_patient_vip("مريض عادي غير مدرج", vip_text))

    def test_format_vip_discharge_message_with_contractor(self):
        msg = spr.format_vip_discharge_message(
            patient_name="سهير ابراهيم مصطفى صيام",
            room_number="405 A",
            contractor="001 - شركة AXA",
            cairo_time="2026-11-21 15:45",
        )
        self.assertEqual(
            msg,
            "\n".join([
                "👑 *VIP Patient Discharged*",
                "━━━━━━━━━━━━━━━━━━━━",
                "• *Name:* سهير ابراهيم مصطفى صيام",
                "• *Room:* 405 A",
                "• *Contractor:* AXA",
                "• *Status:* Discharged ✅",
                "• *Time:* 2026-11-21 15:45",
                "━━━━━━━━━━━━━━━━━━━━",
                "_Elite Hospital Occupancy Manager_",
            ]),
        )
        self.assertEqual(spr.clean_contractor_for_display_vip(""), "Cash / Self-Pay")
        self.assertEqual(spr.clean_contractor_for_display_vip("002 - main"), "Cash / Self-Pay")

    def test_zero_discharges_makes_zero_extra_supabase_calls(self):
        session = MagicMock()
        sent = []

        res = spr.notify_powerbi_vip_discharges(
            candidates=[],
            notified_keys=[],
            paused=False,
            session=session,
            dry_run=False,
            send_fn=lambda msg, groups: sent.append((msg, groups)),
        )

        session.get.assert_not_called()
        self.assertEqual(sent, [])
        self.assertEqual(res["notified_keys"], [])
        self.assertEqual(res["sent_count"], 0)

    def test_cached_vip_text_uses_index_check_and_refreshes_on_change(self):
        spr._VIP_TEXT_CACHE["text"] = "سهير ابراهيم مصطفى صيام"
        spr._VIP_TEXT_CACHE["updated_at"] = "2026-11-21T10:00:00Z"

        session = MagicMock()
        resp_hit = MagicMock(status_code=200)
        resp_hit.json.return_value = [{"updated_at": "2026-11-21T10:00:00Z"}]
        session.get.return_value = resp_hit

        text1 = spr.get_cached_vip_text(session)
        self.assertEqual(text1, "سهير ابراهيم مصطفى صيام")
        self.assertEqual(session.get.call_count, 1)
        self.assertIn("select=updated_at", session.get.call_args[0][0])

        session.get.reset_mock()
        resp_ts = MagicMock(status_code=200)
        resp_ts.json.return_value = [{"updated_at": "2026-11-21T12:00:00Z"}]
        resp_data = MagicMock(status_code=200)
        resp_data.json.return_value = [{"data": {"text": "محمد عيد نجا نجا"}, "updated_at": "2026-11-21T12:00:00Z"}]
        session.get.side_effect = [resp_ts, resp_data]

        text2 = spr.get_cached_vip_text(session)
        self.assertEqual(text2, "محمد عيد نجا نجا")
        self.assertEqual(session.get.call_count, 2)

    def test_hmis_graduation_companion_skip_paused_and_idempotency(self):
        spr._VIP_TEXT_CACHE["text"] = "سهير ابراهيم مصطفى صيام\nمحمد عيد نجا نجا"
        spr._VIP_TEXT_CACHE["updated_at"] = "2026-11-21T10:00:00Z"

        session = MagicMock()
        resp_hit = MagicMock(status_code=200)
        resp_hit.json.return_value = [{"updated_at": "2026-11-21T10:00:00Z"}]
        session.get.return_value = resp_hit

        sent = []
        candidates = [
            {"name": "سهير ابراهيم مصطفى صيام", "room": "405 A", "mrn": "1001", "contractor": "AXA", "dischargeType": "auto"},
            {"name": "مرافق سهير", "room": "405 C", "mrn": "1002", "contractor": "AXA", "dischargeType": "auto"},
            {"name": "محمد عيد نجا نجا", "room": "409", "mrn": "1003", "contractor": "005 - MetLife", "dischargeType": "manual", "source": "hmis_pending_discharge"},
        ]

        with patch.dict(os.environ, {"GREEN_API_GROUP_IDS": "1203630@g.us"}, clear=False):
            os.environ.pop("GREEN_API_VIP_DISCHARGE_GROUP_IDS", None)

            res_paused = spr.notify_powerbi_vip_discharges(
                candidates=candidates,
                notified_keys=[],
                paused=True,
                session=session,
                cairo_time="2026-11-21 15:45",
                send_fn=lambda msg, groups: sent.append((msg, groups)),
            )
            self.assertEqual(sent, [])
            self.assertEqual(res_paused["suppressed_count"], 2)
            self.assertEqual(set(res_paused["notified_keys"]), {"mrn:1001", "mrn:1003"})

            res_resumed = spr.notify_powerbi_vip_discharges(
                candidates=candidates + [
                    {"name": "سهير ابراهيم مصطفى صيام", "room": "405 A", "mrn": "1009", "contractor": "Bupa", "dischargeType": "auto"},
                ],
                notified_keys=res_paused["notified_keys"],
                paused=False,
                session=session,
                cairo_time="2026-11-21 16:00",
                send_fn=lambda msg, groups: sent.append((msg, groups)),
            )
            self.assertEqual(len(sent), 1)
            self.assertIn("• *Contractor:* Bupa", sent[0][0])
            self.assertEqual(res_resumed["sent_count"], 1)
            self.assertIn("mrn:1009", res_resumed["notified_keys"])


if __name__ == "__main__":
    unittest.main()
