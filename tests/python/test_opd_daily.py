import datetime
import unittest
from unittest.mock import MagicMock, patch
import sys
import os

# Add project root to path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))
import sync_powerbi_relational as bridge


class FakeResponse:
    def __init__(self, status_code=200, json_data=None, content=b"", text=""):
        self.status_code = status_code
        self._json = json_data if json_data is not None else []
        self.content = content
        self.text = text

    def json(self):
        return self._json

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class TestOPDDailyBridge(unittest.TestCase):
    def setUp(self):
        bridge._last_opd_sync_ts = 0.0
        bridge._last_opd_hash = ""
        bridge._last_opd_target_date = ""
        bridge._last_opd_2200_done_date = ""
        bridge._last_opd_2200_attempt_ts = 0.0
        bridge._opd_2200_retry_needed = False
        bridge.last_cairo_seen_date = "2026-11-18"
        bridge._is_paused = False

    def test_get_opd_target_date_before_and_after_2200(self):
        t_1400 = datetime.datetime(2026, 11, 18, 14, 0, tzinfo=bridge.CAIRO_TZ)
        t_2159 = datetime.datetime(2026, 11, 18, 21, 59, tzinfo=bridge.CAIRO_TZ)
        t_2200 = datetime.datetime(2026, 11, 18, 22, 0, tzinfo=bridge.CAIRO_TZ)
        t_2220 = datetime.datetime(2026, 11, 18, 22, 20, tzinfo=bridge.CAIRO_TZ)
        t_2330 = datetime.datetime(2026, 11, 18, 23, 30, tzinfo=bridge.CAIRO_TZ)

        self.assertEqual(bridge.get_opd_target_date(t_1400), datetime.date(2026, 11, 18))
        self.assertEqual(bridge.get_opd_target_date(t_2159), datetime.date(2026, 11, 18))
        self.assertEqual(bridge.get_opd_target_date(t_2200), datetime.date(2026, 11, 19))
        self.assertEqual(bridge.get_opd_target_date(t_2220), datetime.date(2026, 11, 19))
        self.assertEqual(bridge.get_opd_target_date(t_2330), datetime.date(2026, 11, 19))

    @patch.object(bridge, "publish_standalone_heartbeat")
    @patch.object(bridge, "fortinet_reconnect")
    @patch.object(bridge, "fetch_powerbi_opd_and_sync")
    @patch.object(bridge, "get_cairo_now")
    def test_2159_does_not_purge_or_fetch(self, mock_now, mock_fetch, _mock_vpn, _mock_hb):
        mock_now.return_value = datetime.datetime(2026, 11, 18, 21, 59, tzinfo=bridge.CAIRO_TZ)
        bridge.check_cairo_day_rollover()
        mock_fetch.assert_not_called()

    @patch.object(bridge, "publish_standalone_heartbeat")
    @patch.object(bridge, "fortinet_reconnect")
    @patch.object(bridge, "fetch_powerbi_opd_and_sync", return_value=True)
    @patch.object(bridge, "get_cairo_now")
    def test_2200_purges_and_fetches_tomorrow_once(self, mock_now, mock_fetch, _mock_vpn, _mock_hb):
        mock_now.return_value = datetime.datetime(2026, 11, 18, 22, 0, tzinfo=bridge.CAIRO_TZ)
        bridge.check_cairo_day_rollover()
        mock_fetch.assert_called_once_with(
            target_date=datetime.date(2026, 11, 19),
            force=True,
            purge_before_fetch=True,
        )

        # Second call at 22:01 same day must be guarded (no duplicate trigger)
        mock_fetch.reset_mock()
        mock_now.return_value = datetime.datetime(2026, 11, 18, 22, 1, tzinfo=bridge.CAIRO_TZ)
        bridge.check_cairo_day_rollover()
        mock_fetch.assert_not_called()

        # 23:30 must NOT trigger a second tomorrow fetch
        mock_now.return_value = datetime.datetime(2026, 11, 18, 23, 30, tzinfo=bridge.CAIRO_TZ)
        bridge.check_cairo_day_rollover()
        mock_fetch.assert_not_called()

    @patch.object(bridge, "publish_standalone_heartbeat")
    @patch.object(bridge, "fortinet_reconnect")
    @patch.object(bridge, "fetch_powerbi_opd_and_sync")
    @patch.object(bridge, "get_cairo_now")
    @patch("time.time")
    def test_2200_failed_fetch_retries_every_5_min_until_2230(
        self, mock_time, mock_now, mock_fetch, _mock_vpn, _mock_hb
    ):
        # First attempt at 22:00 fails
        mock_fetch.return_value = False
        mock_time.return_value = 1000.0
        mock_now.return_value = datetime.datetime(2026, 11, 18, 22, 0, tzinfo=bridge.CAIRO_TZ)
        bridge.check_cairo_day_rollover()
        self.assertEqual(mock_fetch.call_count, 1)
        self.assertTrue(bridge._opd_2200_retry_needed)

        # 2 minutes later -> too soon, no retry
        mock_time.return_value = 1120.0
        mock_now.return_value = datetime.datetime(2026, 11, 18, 22, 2, tzinfo=bridge.CAIRO_TZ)
        bridge.check_cairo_day_rollover()
        self.assertEqual(mock_fetch.call_count, 1)

        # 5 minutes later (22:05) -> retries and succeeds
        mock_fetch.return_value = True
        mock_time.return_value = 1301.0
        mock_now.return_value = datetime.datetime(2026, 11, 18, 22, 5, tzinfo=bridge.CAIRO_TZ)
        bridge.check_cairo_day_rollover()
        self.assertEqual(mock_fetch.call_count, 2)
        self.assertFalse(bridge._opd_2200_retry_needed)

    @patch.object(bridge, "SUPABASE_KEY", "test-key")
    @patch.object(bridge, "get_supabase_session")
    @patch.object(bridge, "get_opd_powerbi_model_id", return_value="12345")
    @patch.object(bridge, "parse_powerbi_opd_excel")
    @patch("requests.post")
    def test_fetch_writes_only_state_opd_list_and_never_history(
        self, mock_req_post, mock_parse, _mock_model, mock_sb_session
    ):
        mock_req_post.return_value = FakeResponse(status_code=200, content=b"xlsx-bytes")
        mock_parse.return_value = [{"serial": "1", "physicianAr": "ولاء الامير", "opdDate": "2026-11-19"}]

        sb = MagicMock()
        sb.get.return_value = FakeResponse(status_code=200, json_data=[])
        sb.post.return_value = FakeResponse(status_code=201)
        mock_sb_session.return_value = sb

        ok = bridge.fetch_powerbi_opd_and_sync(
            target_date=datetime.date(2026, 11, 19), force=True, purge_before_fetch=True
        )
        self.assertTrue(ok)

        # Verify every Supabase POST only touches state/opd_list (ZERO history/opd/* writes)
        self.assertGreaterEqual(sb.post.call_count, 2)  # purge write + commit write
        for call in sb.post.call_args_list:
            nodes = call.kwargs.get("json") or call.args[1]
            paths = [n["path"] for n in nodes]
            self.assertEqual(paths, ["state/opd_list"])
            for p in paths:
                self.assertFalse(p.startswith("history/opd/"))

        # First write was purge (empty items), last write was fetched sessions
        first_nodes = sb.post.call_args_list[0].kwargs["json"]
        self.assertEqual(first_nodes[0]["data"]["items"], [])
        self.assertEqual(first_nodes[0]["data"]["opdDate"], "2026-11-19")

        last_nodes = sb.post.call_args_list[-1].kwargs["json"]
        self.assertEqual(len(last_nodes[0]["data"]["items"]), 1)
        self.assertEqual(last_nodes[0]["data"]["opdDate"], "2026-11-19")

    @patch.object(bridge, "SUPABASE_KEY", "test-key")
    @patch.object(bridge, "get_supabase_session")
    @patch.object(bridge, "get_opd_powerbi_model_id", side_effect=RuntimeError("VPN down"))
    def test_failed_fetch_with_purge_leaves_empty_list_with_error_flag(
        self, _mock_model, mock_sb_session
    ):
        sb = MagicMock()
        sb.post.return_value = FakeResponse(status_code=201)
        mock_sb_session.return_value = sb

        ok = bridge.fetch_powerbi_opd_and_sync(
            target_date=datetime.date(2026, 11, 19), force=True, purge_before_fetch=True
        )
        self.assertFalse(ok)
        # Last write must leave state/opd_list empty with error flag
        last_nodes = sb.post.call_args_list[-1].kwargs["json"]
        self.assertEqual(last_nodes[0]["path"], "state/opd_list")
        self.assertEqual(last_nodes[0]["data"]["items"], [])
        self.assertEqual(last_nodes[0]["data"]["opdDate"], "2026-11-19")
        self.assertIn("VPN down", last_nodes[0]["data"]["error"])

    @patch.object(bridge, "SUPABASE_KEY", "test-key")
    @patch.object(bridge, "get_supabase_session")
    @patch.object(bridge, "get_opd_powerbi_model_id", return_value="12345")
    @patch.object(bridge, "parse_powerbi_opd_excel")
    @patch("requests.post")
    def test_unchanged_hash_skips_supabase_write(
        self, mock_req_post, mock_parse, _mock_model, mock_sb_session
    ):
        mock_req_post.return_value = FakeResponse(status_code=200, content=b"xlsx-bytes")
        mock_parse.return_value = [{"serial": "1", "physicianAr": "ولاء الامير", "opdDate": "2026-11-18"}]

        sb = MagicMock()
        sb.get.return_value = FakeResponse(status_code=200, json_data=[])
        sb.post.return_value = FakeResponse(status_code=201)
        mock_sb_session.return_value = sb

        # First call commits
        self.assertTrue(bridge.fetch_powerbi_opd_and_sync(target_date=datetime.date(2026, 11, 18), force=False))
        self.assertEqual(sb.post.call_count, 1)

        # Second call with same data & date skips write
        self.assertTrue(bridge.fetch_powerbi_opd_and_sync(target_date=datetime.date(2026, 11, 18), force=False))
        self.assertEqual(sb.post.call_count, 1)


if __name__ == "__main__":
    unittest.main()
