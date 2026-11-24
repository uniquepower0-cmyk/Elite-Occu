import unittest
from unittest.mock import MagicMock, patch

import requests

import sync_powerbi_relational as bridge


SAMPLE_LOGIN_HTML = """<!DOCTYPE html>
<html><head><title> Firewall Authentication </title></head><body>
<form action="/" method="post">
  <input type="hidden" name="4Tredir" value="https://10.0.17.4:1003/login?0">
  <input type="hidden" name="magic" value="038f2dec71a1e5b0">
  <input name="username" id="ft_un" type="text">
  <input name="password" id="ft_pd" type="password">
</form></body></html>"""

SAMPLE_LOGOUT_HTML = "<HTML><HEAD><TITLE>Firewall Authentication Logout</TITLE></HEAD><BODY><H3>You have successfully logged out</H3></BODY></HTML>"

SAMPLE_POST_SUCCESS_HTML = (
    '<html><body><script language="JavaScript">'
    'window.location="https://10.0.17.4:1003/keepalive?0b0d0f070b010e00";'
    "</script></body></html>"
)

SAMPLE_KEEPALIVE_HTML = (
    "<html><head><title> Firewall Authentication Keepalive Window </title></head>"
    '<body><p> Authentication refresh in <b id="countdown"> 16000 </b> seconds ... </p></body></html>'
)

SAMPLE_POST_CONCURRENT_LIMIT_HTML = (
    "<html><head><title> Firewall Authentication </title></head><body>"
    "<h1> Authentication Failed </h1>"
    "<form action=\"/\" method=\"post\">"
    "<p> Sorry, user&apos;s concurrent authentication is over limit </p>"
    '<input name="password" type="password">'
    "</form></body></html>"
)


def _make_response(status_code: int = 200, text: str = "", url: str = "https://10.0.17.4:1003/login?0", headers=None):
    resp = MagicMock(spec=requests.Response)
    resp.status_code = status_code
    resp.text = text
    resp.url = url
    resp.headers = headers or {}
    return resp


class TestFortinetAuth(unittest.TestCase):
    def setUp(self):
        bridge._fortinet_keepalive_url = None

    def tearDown(self):
        bridge._fortinet_keepalive_url = None

    def test_parse_fortinet_login_form(self):
        post_url, magic, redir = bridge._parse_fortinet_login_form(
            SAMPLE_LOGIN_HTML, "https://10.0.17.4:1003/login?0"
        )
        self.assertEqual(post_url, "https://10.0.17.4:1003/")
        self.assertEqual(magic, "038f2dec71a1e5b0")
        self.assertEqual(redir, "https://10.0.17.4:1003/login?0")

    def test_parse_fortinet_login_form_reversed_attrs(self):
        html = '<form method="post" action="/auth"><input value="abc123" name="magic" type="hidden"><input value="https://x/y" name="4Tredir"></form>'
        post_url, magic, redir = bridge._parse_fortinet_login_form(html, "https://10.0.17.4:1003/login?0")
        self.assertEqual(post_url, "https://10.0.17.4:1003/auth")
        self.assertEqual(magic, "abc123")
        self.assertEqual(redir, "https://x/y")

    def test_extract_failure_reason(self):
        reason = bridge._extract_fortinet_failure_reason(SAMPLE_POST_CONCURRENT_LIMIT_HTML)
        self.assertIn("Authentication Failed", reason)
        self.assertIn("concurrent authentication is over limit", reason)

    def test_unreachable_gateway_skips_without_logout(self):
        with patch.object(bridge, "FORTINET_USER", "u"), \
             patch.object(bridge, "FORTINET_PASS", "p"), \
             patch.object(bridge, "_is_fortinet_gateway_reachable", return_value=False), \
             patch("sync_powerbi_relational.requests.Session") as mock_session_cls:
            ok = bridge.fortinet_reconnect(max_retries=2, logout_wait_seconds=0)
            self.assertTrue(ok)
            mock_session_cls.assert_not_called()

    def test_full_logout_login_and_keepalive_first_reuse(self):
        mock_session = MagicMock()
        mock_session.__enter__.return_value = mock_session
        mock_session.__exit__.return_value = False

        mock_session.get.side_effect = [
            _make_response(200, SAMPLE_LOGOUT_HTML, "https://10.0.17.4:1003/logout?0"),
            _make_response(200, SAMPLE_LOGIN_HTML, "https://10.0.17.4:1003/login?0"),
            _make_response(200, SAMPLE_KEEPALIVE_HTML, "https://10.0.17.4:1003/keepalive?0b0d0f070b010e00"),
            # Second call (keepalive-first fast path)
            _make_response(200, SAMPLE_KEEPALIVE_HTML, "https://10.0.17.4:1003/keepalive?0b0d0f070b010e00"),
        ]
        mock_session.post.return_value = _make_response(200, SAMPLE_POST_SUCCESS_HTML, "https://10.0.17.4:1003/")

        with patch.object(bridge, "FORTINET_URL", "https://10.0.17.4:1003"), \
             patch.object(bridge, "FORTINET_USER", "testuser"), \
             patch.object(bridge, "FORTINET_PASS", "testpass"), \
             patch.object(bridge, "_is_fortinet_gateway_reachable", return_value=True), \
             patch("sync_powerbi_relational.requests.Session", return_value=mock_session):
            # First call: full logout -> login -> keepalive confirm
            self.assertTrue(bridge.fortinet_reconnect(max_retries=2, logout_wait_seconds=0))
            self.assertEqual(bridge._fortinet_keepalive_url, "https://10.0.17.4:1003/keepalive?0b0d0f070b010e00")

            # Verify POST payload and target
            post_args, post_kwargs = mock_session.post.call_args
            self.assertEqual(post_args[0], "https://10.0.17.4:1003/")
            self.assertEqual(
                post_kwargs["data"],
                {
                    "username": "testuser",
                    "password": "testpass",
                    "magic": "038f2dec71a1e5b0",
                    "4Tredir": "https://10.0.17.4:1003/login?0",
                },
            )

            # Second call: keepalive-first (should NOT call post again!)
            self.assertTrue(bridge.fortinet_reconnect(max_retries=2, logout_wait_seconds=0))
            self.assertEqual(mock_session.post.call_count, 1)

    def test_expired_keepalive_falls_back_to_relogin(self):
        bridge._fortinet_keepalive_url = "https://10.0.17.4:1003/keepalive?expiredtoken"
        mock_session = MagicMock()
        mock_session.__enter__.return_value = mock_session
        mock_session.__exit__.return_value = False

        mock_session.get.side_effect = [
            requests.exceptions.ConnectionError("RemoteDisconnected"),  # keepalive fails
            _make_response(200, SAMPLE_LOGOUT_HTML, "https://10.0.17.4:1003/logout?0"),
            _make_response(200, SAMPLE_LOGIN_HTML, "https://10.0.17.4:1003/login?0"),
            _make_response(200, SAMPLE_KEEPALIVE_HTML, "https://10.0.17.4:1003/keepalive?0b0d0f070b010e00"),
        ]
        mock_session.post.return_value = _make_response(200, SAMPLE_POST_SUCCESS_HTML, "https://10.0.17.4:1003/")

        with patch.object(bridge, "FORTINET_URL", "https://10.0.17.4:1003"), \
             patch.object(bridge, "FORTINET_USER", "testuser"), \
             patch.object(bridge, "FORTINET_PASS", "testpass"), \
             patch.object(bridge, "_is_fortinet_gateway_reachable", return_value=True), \
             patch("sync_powerbi_relational.requests.Session", return_value=mock_session):
            self.assertTrue(bridge.fortinet_reconnect(max_retries=2, logout_wait_seconds=0))
            self.assertEqual(bridge._fortinet_keepalive_url, "https://10.0.17.4:1003/keepalive?0b0d0f070b010e00")

    def test_http_200_auth_failed_is_not_false_positive(self):
        mock_session = MagicMock()
        mock_session.__enter__.return_value = mock_session
        mock_session.__exit__.return_value = False
        mock_session.get.side_effect = [
            _make_response(200, SAMPLE_LOGOUT_HTML),
            _make_response(200, SAMPLE_LOGIN_HTML),
        ]
        mock_session.post.return_value = _make_response(200, SAMPLE_POST_CONCURRENT_LIMIT_HTML)

        with patch.object(bridge, "FORTINET_URL", "https://10.0.17.4:1003"), \
             patch.object(bridge, "FORTINET_USER", "testuser"), \
             patch.object(bridge, "FORTINET_PASS", "testpass"), \
             patch.object(bridge, "_is_fortinet_gateway_reachable", return_value=True), \
             patch.object(bridge, "failure_countdown"), \
             patch("sync_powerbi_relational.requests.Session", return_value=mock_session):
            self.assertFalse(bridge.fortinet_reconnect(max_retries=1, logout_wait_seconds=0))

    def test_midflow_connection_error_is_not_swallowed_as_success(self):
        mock_session = MagicMock()
        mock_session.__enter__.return_value = mock_session
        mock_session.__exit__.return_value = False
        mock_session.get.side_effect = [
            _make_response(200, SAMPLE_LOGOUT_HTML),
            requests.exceptions.ConnectionError("RemoteDisconnected"),
        ]

        with patch.object(bridge, "FORTINET_URL", "https://10.0.17.4:1003"), \
             patch.object(bridge, "FORTINET_USER", "testuser"), \
             patch.object(bridge, "FORTINET_PASS", "testpass"), \
             patch.object(bridge, "_is_fortinet_gateway_reachable", return_value=True), \
             patch.object(bridge, "failure_countdown"), \
             patch("sync_powerbi_relational.requests.Session", return_value=mock_session):
            self.assertFalse(bridge.fortinet_reconnect(max_retries=1, logout_wait_seconds=0))


if __name__ == "__main__":
    unittest.main()
