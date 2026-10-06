#!/usr/bin/env python3
from __future__ import annotations

import sys
import tempfile
import unittest
import urllib.error
import zipfile
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bundle_moderate as moderate


class FakeResponse:
    def __init__(self, value):
        self.value = value

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self, *_):
        return __import__("json").dumps(self.value).encode("utf-8")


def category_map(**overrides):
    result = {name: False for name in moderate.REQUIRED_CATEGORIES}
    result.update(overrides)
    return result


class BundleModerationTests(unittest.TestCase):
    @mock.patch("bundle_moderate.bundle_http.urlopen")
    def test_clean_image_passes_without_categories(self, urlopen):
        urlopen.return_value = FakeResponse({
            "results": [{"flagged": False, "categories": category_map()}],
        })
        result = moderate.request_moderation(b"png", "secret")
        self.assertFalse(result["flagged"])
        self.assertEqual(result["categories"], [])

    @mock.patch("bundle_moderate.bundle_http.urlopen")
    def test_reads_flagged_categories(self, urlopen):
        urlopen.return_value = FakeResponse({
            "results": [{"flagged": True, "categories": category_map(violence=True)}],
        })
        result = moderate.request_moderation(b"png", "secret")
        self.assertTrue(result["flagged"])
        self.assertEqual(result["categories"], ["violence"])
        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, "https://api.openai.com/v1/moderations")
        self.assertEqual(request.get_header("Authorization"), "Bearer secret")

    @mock.patch("bundle_moderate.bundle_http.urlopen")
    def test_true_category_cannot_be_cleared_by_false_aggregate(self, urlopen):
        urlopen.return_value = FakeResponse({
            "results": [{"flagged": False, "categories": {
                **category_map(), "violence": True,
            }}],
        })
        result = moderate.request_moderation(b"png", "secret")
        self.assertTrue(result["flagged"])
        self.assertEqual(result["categories"], ["violence"])

    @mock.patch("time.sleep")
    @mock.patch("bundle_moderate.bundle_http.urlopen")
    def test_empty_category_map_fails_closed(self, urlopen, _sleep):
        urlopen.return_value = FakeResponse({
            "results": [{"flagged": False, "categories": {}}],
        })
        with self.assertRaisesRegex(RuntimeError, "moderation request failed"):
            moderate.request_moderation(b"png", "secret")

    @mock.patch("time.sleep")
    @mock.patch("bundle_moderate.bundle_http.urlopen")
    def test_non_boolean_category_fails_closed(self, urlopen, _sleep):
        urlopen.return_value = FakeResponse({
            "results": [{"flagged": False, "categories": {
                **category_map(), "violence": 0,
            }}],
        })
        with self.assertRaisesRegex(RuntimeError, "moderation request failed"):
            moderate.request_moderation(b"png", "secret")

    @mock.patch("time.sleep")
    @mock.patch("bundle_moderate.bundle_http.urlopen")
    def test_missing_required_category_fails_closed(self, urlopen, _sleep):
        partial = category_map()
        del partial["sexual/minors"]
        urlopen.return_value = FakeResponse({
            "results": [{"flagged": False, "categories": partial}],
        })
        with self.assertRaisesRegex(RuntimeError, "moderation request failed"):
            moderate.request_moderation(b"png", "secret")

    @mock.patch("bundle_moderate.bundle_http.urlopen")
    def test_text_metadata_uses_same_safety_endpoint(self, urlopen):
        urlopen.return_value = FakeResponse({
            "results": [{"flagged": False, "categories": category_map()}],
        })
        result = moderate.request_text_moderation("bundle metadata", "secret")
        self.assertFalse(result["flagged"])
        body = __import__("json").loads(urlopen.call_args.args[0].data)
        self.assertEqual(body["input"], [{"type": "text", "text": "bundle metadata"}])

    def test_missing_key_fails_closed(self):
        result = moderate.moderate_archive(Path("missing.zip"), "")
        self.assertFalse(result["ok"])

    @mock.patch("time.sleep")
    @mock.patch("bundle_moderate.bundle_http.urlopen")
    def test_rate_limit_retries_then_succeeds(self, urlopen, sleep):
        limited = urllib.error.HTTPError(moderate.ENDPOINT, 429, "limited", {}, None)
        urlopen.side_effect = [limited, FakeResponse({
            "results": [{"flagged": False, "categories": category_map()}],
        })]
        result = moderate.request_moderation(b"png", "secret")
        self.assertFalse(result["flagged"])
        self.assertEqual(urlopen.call_count, 2)
        sleep.assert_called_once_with(1)

    @mock.patch("time.sleep")
    @mock.patch("bundle_moderate.bundle_http.urlopen")
    def test_nonretryable_api_error_fails_closed(self, urlopen, sleep):
        urlopen.side_effect = urllib.error.HTTPError(moderate.ENDPOINT, 400, "bad request", {}, None)
        with self.assertRaisesRegex(RuntimeError, "moderation request failed"):
            moderate.request_moderation(b"png", "secret")
        self.assertEqual(urlopen.call_count, 1)
        sleep.assert_not_called()

    @mock.patch.object(moderate.bundle_validate, "validate_archive")
    @mock.patch.object(moderate, "request_moderation")
    @mock.patch.object(moderate, "request_text_moderation", return_value={"flagged": False, "categories": []})
    def test_archive_holds_flagged_artwork_for_review(
        self, _, request_moderation, validate_archive,
    ):
        with tempfile.TemporaryDirectory() as temp_name:
            archive_path = Path(temp_name) / "bundle.zip"
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr("manifest.json", "{}")
                archive.writestr("illustrations/clean.png", b"clean")
                archive.writestr("illustrations/flagged.png", b"flagged")
            validate_archive.return_value = {"object_inventory": [
                {"file": "illustrations/clean.png"},
                {"file": "illustrations/flagged.png"},
            ]}
            request_moderation.side_effect = [
                {"flagged": False, "categories": []},
                {"flagged": True, "categories": ["sexual"]},
            ]
            result = moderate.moderate_archive(archive_path, "secret", workers=1)
        self.assertTrue(result["ok"])
        self.assertEqual(result["images"], 2)
        self.assertEqual(result["checked"], 3)
        self.assertEqual(result["flagged_count"], 1)
        self.assertEqual(result["flagged"], [{"file": "illustrations/flagged.png", "categories": ["sexual"]}])

    @mock.patch.object(moderate.bundle_validate, "validate_archive")
    @mock.patch.object(moderate, "request_moderation", side_effect=RuntimeError("moderation request failed"))
    @mock.patch.object(moderate, "request_text_moderation", return_value={"flagged": False, "categories": []})
    def test_archive_moderation_outage_fails_closed(self, _text, _image, validate_archive):
        with tempfile.TemporaryDirectory() as temp_name:
            archive_path = Path(temp_name) / "bundle.zip"
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr("manifest.json", "{}")
                archive.writestr("illustrations/bird.png", b"bird")
            validate_archive.return_value = {"object_inventory": [{"file": "illustrations/bird.png"}]}
            result = moderate.moderate_archive(archive_path, "secret", workers=1)
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "moderation request failed")

    @mock.patch.object(moderate.bundle_validate, "validate_archive")
    @mock.patch.object(moderate, "request_text_moderation", return_value={
        "flagged": True, "categories": ["harassment"],
    })
    @mock.patch.object(moderate, "request_moderation", return_value={"flagged": False, "categories": []})
    def test_manifest_metadata_is_included_in_flag_count(self, _image, _text, validate_archive):
        with tempfile.TemporaryDirectory() as temp_name:
            archive_path = Path(temp_name) / "bundle.zip"
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr("manifest.json", "{}")
                archive.writestr("illustrations/bird.png", b"bird")
            validate_archive.return_value = {"object_inventory": [{"file": "illustrations/bird.png"}]}
            with mock.patch.object(moderate, "public_manifest_text", return_value="metadata"):
                result = moderate.moderate_archive(archive_path, "secret", workers=1)
        self.assertEqual(result["flagged_count"], 1)
        self.assertEqual(result["flagged"][0]["file"], "manifest.json")


if __name__ == "__main__":
    unittest.main()
