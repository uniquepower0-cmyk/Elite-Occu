import datetime
import json
import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import sync_powerbi_relational as bridge


class TestOPDSync(unittest.TestCase):
    def test_build_opd_powerbi_payload_has_12_cols_and_target_date(self):
        payload = bridge.build_opd_powerbi_payload("235524464", datetime.date(2026, 11, 18))
        q = payload["executeSemanticQueryRequest"]["queries"][0]["Query"]["Commands"][0]["SemanticQueryDataShapeCommand"]["Query"]
        self.assertEqual(len(q["Select"]), 12)
        where_json = json.dumps(q["Where"])
        self.assertIn("2026L", where_json)
        self.assertIn("11L", where_json)
        self.assertIn("18L", where_json)
        self.assertNotIn("Mohamed   nafaa", where_json)

    def test_parse_downloaded_tomorrow_sheet_if_present(self):
        sample_path = "/Users/mohanad/Downloads/Elite/data - 2026-11-17T184341.056.xlsx"
        if not os.path.exists(sample_path):
            self.skipTest("Sample downloaded sheet not present")
        with open(sample_path, "rb") as f:
            sessions = bridge.parse_powerbi_opd_excel(f.read(), "2026-11-18")
        self.assertEqual(len(sessions), 98)
        self.assertEqual(sessions[0]["opdDate"], "2026-11-18")
        self.assertTrue(sessions[0]["physicianEn"])
        self.assertTrue(sessions[0]["specialty"])

    def test_2330_cairo_trigger_fetches_tomorrow_opd(self):
        fake_now = datetime.datetime(2026, 11, 17, 23, 30, tzinfo=bridge.CAIRO_TZ)
        with patch.object(bridge, "last_cairo_seen_date", "2026-11-17"), \
             patch.object(bridge, "_last_opd_2330_done_date", ""), \
             patch.object(bridge, "_is_paused", False), \
             patch.object(bridge, "get_cairo_now", return_value=fake_now), \
             patch.object(bridge, "fortinet_reconnect"), \
             patch.object(bridge, "publish_standalone_heartbeat"), \
             patch.object(bridge, "fetch_powerbi_opd_and_sync") as mock_opd:
            bridge.check_cairo_day_rollover()
            mock_opd.assert_called_once_with(target_date=datetime.date(2026, 11, 18), force=True)


if __name__ == "__main__":
    unittest.main()
