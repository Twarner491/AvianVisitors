#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bundle_review_assets as assets


class FakeResponse:
    status = 204

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


class BundleReviewAssetsTests(unittest.TestCase):
    attempt = "A" * 32

    def test_invalid_submission_is_rejected_before_network(self):
        with self.assertRaisesRegex(RuntimeError, "submission identifier"):
            assets.upload_assets(Path("x"), Path("x"), "../bad", "secret", self.attempt)

    def test_invalid_attempt_is_rejected_before_network(self):
        with self.assertRaisesRegex(RuntimeError, "attempt token"):
            assets.upload_assets(
                Path("x"), Path("x"), "submission_1234567890", "secret", "browser-value"
            )

    @mock.patch("bundle_review_assets.bundle_http.urlopen", return_value=FakeResponse())
    def test_uploads_only_descriptor_bound_fixed_jpegs(self, urlopen):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            preview = root / "preview"
            preview.mkdir()
            flag_data = b"flag jpeg"
            contact_data = b"contact jpeg"
            (preview / "flag-0.jpg").write_bytes(flag_data)
            (preview / "contact-0.jpg").write_bytes(contact_data)
            result_path = root / "review.json"
            result_path.write_text(json.dumps({
                "ok": True,
                "flags": [{"preview": {
                    "sha256": hashlib.sha256(flag_data).hexdigest(), "bytes": len(flag_data),
                }}],
                "contact_sheet": {
                    "sha256": hashlib.sha256(contact_data).hexdigest(), "bytes": len(contact_data), "sampled": 1,
                },
            }))
            result = assets.upload_assets(
                result_path, preview, "submission_1234567890", "secret", self.attempt,
                "https://example.test",
            )
        self.assertEqual(result["uploaded"], 2)
        self.assertEqual(urlopen.call_count, 2)
        first = urlopen.call_args_list[0].args[0]
        self.assertTrue(first.full_url.endswith("/review-assets/flag/0"))
        self.assertEqual(first.get_header("Content-type"), "image/jpeg")
        self.assertEqual(first.get_header("X-content-sha256"), hashlib.sha256(flag_data).hexdigest())
        self.assertEqual(first.get_header("X-bundle-validation-attempt"), self.attempt)

    @mock.patch("bundle_review_assets.bundle_http.urlopen")
    def test_advisory_failure_has_no_asset_upload(self, urlopen):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            review = root / "review.json"
            review.write_text('{"ok":false}')
            result = assets.upload_assets(
                review, root, "submission_1234567890", "secret", self.attempt,
                "https://example.test",
            )
        self.assertTrue(result["skipped"])
        urlopen.assert_not_called()

    def test_descriptor_mismatch_fails_closed(self):
        with self.assertRaisesRegex(RuntimeError, "does not match"):
            assets.validate_descriptor({"sha256": "0" * 64, "bytes": 4}, b"jpeg")


if __name__ == "__main__":
    unittest.main()
