#!/usr/bin/env python3
from __future__ import annotations

import contextlib
import io
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bundle_http


class QuietHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args) -> None:
        pass


class RedirectHandler(QuietHandler):
    def do_GET(self) -> None:
        self.server.seen.append(dict(self.headers))
        self.send_response(302)
        self.send_header("Location", self.server.redirect_url)
        self.end_headers()


class AttackerHandler(QuietHandler):
    def do_GET(self) -> None:
        self.server.seen.append(dict(self.headers))
        self.send_response(204)
        self.end_headers()


class BundleHttpTests(unittest.TestCase):
    def test_redirect_receiver_never_gets_validation_publish_or_openai_credentials(self):
        attacker = ThreadingHTTPServer(("127.0.0.1", 0), AttackerHandler)
        attacker.seen = []
        redirect = ThreadingHTTPServer(("127.0.0.1", 0), RedirectHandler)
        redirect.seen = []
        redirect.redirect_url = f"http://127.0.0.1:{attacker.server_port}/receiver"
        threads = [
            threading.Thread(target=server.serve_forever, daemon=True)
            for server in (attacker, redirect)
        ]
        for thread in threads:
            thread.start()
        try:
            credential_sets = (
                {
                    "X-Bundle-Validation-Key": "validation-sentinel",
                    "X-Bundle-Validation-Attempt": "V" * 32,
                },
                {
                    "X-Bundle-Publish-Key": "publish-sentinel",
                    "X-Bundle-Publication-Attempt": "P" * 32,
                },
                {"Authorization": "Bearer openai-sentinel"},
            )
            stdout = io.StringIO()
            stderr = io.StringIO()
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                for headers in credential_sets:
                    request = urllib.request.Request(
                        f"http://127.0.0.1:{redirect.server_port}/exact", headers=headers
                    )
                    with self.assertRaises(urllib.error.HTTPError) as failure:
                        bundle_http.urlopen(request, timeout=2)
                    self.assertEqual(failure.exception.code, 302)
                    self.assertNotIn("sentinel", str(failure.exception))
                    failure.exception.close()
            self.assertEqual(len(redirect.seen), len(credential_sets))
            self.assertEqual(attacker.seen, [])
            captured = stdout.getvalue() + stderr.getvalue()
            self.assertNotIn("validation-sentinel", captured)
            self.assertNotIn("publish-sentinel", captured)
            self.assertNotIn("openai-sentinel", captured)
        finally:
            for server in (redirect, attacker):
                server.shutdown()
                server.server_close()
            for thread in threads:
                thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
