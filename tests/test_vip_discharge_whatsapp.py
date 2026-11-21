import hashlib
import hmac
import json
import os
import sys
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import sync_powerbi_relational as spr


class TestVipSyncEventsDispatcher(unittest.TestCase):
    def test_empty_events_makes_zero_http_calls(self):
        post_fn = MagicMock()
        ok = spr.dispatch_vip_sync_events_to_vercel([], [], post_fn=post_fn)
        self.assertTrue(ok)
        post_fn.assert_not_called()

    def test_get_vip_sync_events_url_defaults_to_elite_occu(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("VIP_SYNC_EVENTS_URL", None)
            os.environ.pop("APP_URL", None)
            self.assertEqual(
                spr.get_vip_sync_events_url(),
                "https://elite-occu.vercel.app/api/whatsapp/vip-sync-events",
            )

    def test_dispatch_signs_payload_with_hmac_and_posts_to_vercel(self):
        mock_res = MagicMock(status_code=200)
        mock_res.json.return_value = {"success": True, "sentDischarges": 1, "sentAdmissions": 1}
        post_fn = MagicMock(return_value=mock_res)

        discharges = [
            {"name": "سهير ابراهيم مصطفى صيام", "room": "405 A", "mrn": "1001", "contractor": "AXA", "dischargeType": "auto"}
        ]
        admissions = [
            {"name": "محمد عيد نجا نجا", "room": "409", "mrn": "1003", "physician": "أحمد علي", "contractor": "MetLife"}
        ]

        with patch.dict(os.environ, {"SUPABASE_SERVICE_ROLE_KEY": "my-secret-key"}, clear=False):
            ok = spr.dispatch_vip_sync_events_to_vercel(discharges, admissions, post_fn=post_fn)

        self.assertTrue(ok)
        post_fn.assert_called_once()
        url = post_fn.call_args[0][0]
        kwargs = post_fn.call_args[1]
        self.assertEqual(url, "https://elite-occu.vercel.app/api/whatsapp/vip-sync-events")

        raw_body = kwargs["data"].decode("utf-8")
        headers = kwargs["headers"]
        ts = headers["X-VIP-Alert-Timestamp"]
        sig = headers["X-VIP-Alert-Signature"]
        expected_sig = hmac.new(
            b"my-secret-key",
            f"{ts}.{raw_body}".encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        self.assertEqual(sig, expected_sig)
        parsed = json.loads(raw_body)
        self.assertEqual(len(parsed["discharges"]), 1)
        self.assertEqual(len(parsed["admissions"]), 1)

    def test_dispatch_non_fatal_when_vercel_unreachable(self):
        post_fn = MagicMock(side_effect=RuntimeError("Network timeout"))
        with patch.dict(os.environ, {"SUPABASE_SERVICE_ROLE_KEY": "my-secret-key"}, clear=False):
            ok = spr.dispatch_vip_sync_events_to_vercel(
                [{"name": "سهير ابراهيم", "room": "405 A", "mrn": "1001"}],
                [],
                post_fn=post_fn,
            )
        self.assertFalse(ok)

    def test_hmis_graduation_checks_raw_records_not_deduplicated_records(self):
        discharged_list = [
            {
                "name": "سهير ابراهيم مصطفى صيام",
                "room": "405 A",
                "mrn": "1001",
                "contractor": "AXA",
                "dischargeType": "manual",
                "source": "hmis_pending_discharge",
            },
            {
                "name": "محمد عيد نجا نجا",
                "room": "409",
                "mrn": "1003",
                "contractor": "MetLife",
                "dischargeType": "manual",
                "source": "hmis_pending_discharge",
            },
        ]
        raw_rec_suhair = MagicMock()
        raw_rec_suhair.clean_mrn = "1001"
        raw_rec_suhair.name = "سهير ابراهيم مصطفى صيام"

        graduated = spr.collect_hmis_graduated_vip_candidates(discharged_list, raw_records=[raw_rec_suhair])
        self.assertEqual(len(graduated), 1)
        self.assertEqual(graduated[0]["mrn"], "1003")

    def test_option_a_hmis_candidates_fire_immediately_on_new_hmis_pending_and_updates_meta_ts(self):
        pre_hmis_disc = [
            {"name": "مريض قديم", "mrn": "111", "source": "hmis_pending_discharge"},
        ]
        post_hmis_disc = [
            {"name": "مريض قديم", "mrn": "111", "source": "hmis_pending_discharge"},
            {"name": "عمر مصطفى مجدى مصطفى", "mrn": "271442", "room": "Bed 403 B", "source": "hmis_pending_discharge"},
        ]
        # Both are still in raw Power BI records, but 271442 was JUST added to HMIS pending this cycle
        raw_rec_old = MagicMock(clean_mrn="111", name="مريض قديم")
        raw_rec_omar = MagicMock(clean_mrn="271442", name="عمر مصطفى مجدى مصطفى")

        cands = spr.collect_hmis_option_a_vip_candidates(
            post_hmis_disc,
            pre_hmis_disc=pre_hmis_disc,
            raw_records=[raw_rec_old, raw_rec_omar],
        )
        self.assertEqual([c["mrn"] for c in cands], ["271442"])

        mock_res = MagicMock(status_code=200)
        mock_res.json.return_value = {
            "success": True,
            "paused": False,
            "sentDischarges": 1,
            "sentAdmissions": 0,
            "suppressedDischarges": 0,
            "suppressedAdmissions": 0,
            "metadataUpdatedAt": "2026-11-21T21:15:00.000Z",
        }
        post_fn = MagicMock(return_value=mock_res)
        with patch.dict(os.environ, {"SUPABASE_SERVICE_ROLE_KEY": "my-secret-key"}, clear=False):
            ok = spr.dispatch_vip_sync_events_to_vercel(cands, [], post_fn=post_fn)
        self.assertTrue(ok)
        self.assertEqual(spr._last_synced_meta_updated_at, "2026-11-21T21:15:00.000Z")


if __name__ == "__main__":
    unittest.main()
