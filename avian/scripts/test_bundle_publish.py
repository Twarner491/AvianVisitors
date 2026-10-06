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
import bundle_publish


class BundlePublishTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.package = self.root / "package"
        self.package.mkdir()
        self.submission = "publicationtestid000001"
        self.attempt = "A" * 32
        self.object = b"\x89PNG\r\n\x1a\nobject"
        object_sha = hashlib.sha256(self.object).hexdigest()
        self.manifest = json.dumps({
            "format": "avian-visitors-asset-pack",
            "species": [{
                "scientific_name": "Turdus migratorius",
                "poses": [{
                    "id": "perched",
                    "file": "illustrations/turdus-migratorius.png",
                    "sha256": object_sha,
                    "bytes": len(self.object),
                }],
            }],
        }, separators=(",", ":")).encode()
        self.preview = b"\x89PNG\r\n\x1a\npreview"
        preview_sha = hashlib.sha256(self.preview).hexdigest()
        self.geometry = json.dumps({
            "format": "avian-bundle-preview-geometry",
            "format_version": 1,
            "source_manifest_sha256": hashlib.sha256(self.manifest).hexdigest(),
            "cover": {"render_sha256": preview_sha},
            "example_order": [],
            "items": {},
        }, separators=(",", ":")).encode()
        self._write("manifest.json", self.manifest)
        geometry_sha = hashlib.sha256(self.geometry).hexdigest()
        self._write(f"objects/{object_sha}.png", self.object)
        self._write(f"previews/{preview_sha}.png", self.preview)
        self._write(f"preview-geometry/{geometry_sha}.json", self.geometry)
        index = {
            "format": bundle_publish.FORMAT,
            "format_version": bundle_publish.FORMAT_VERSION,
            "submission_id": self.submission,
            "canonicalization": bundle_publish.CANONICALIZATION,
            "archive_sha256": "a" * 64,
            "input_manifest_sha256": "b" * 64,
            "publish_manifest_sha256": hashlib.sha256(self.manifest).hexdigest(),
            "object_inventory_sha256": bundle_publish.bundle_inventory_commitment.inventory_sha256([{
                "file": "illustrations/turdus-migratorius.png",
                "sha256": object_sha,
                "bytes": len(self.object),
            }]),
            "manifest": self._descriptor("manifest.json", self.manifest),
            "objects": [self._descriptor(f"objects/{object_sha}.png", self.object)],
            "preview_geometry": self._descriptor(
                f"preview-geometry/{geometry_sha}.json", self.geometry
            ),
            "previews": [self._descriptor(f"previews/{preview_sha}.png", self.preview)],
            "species": 1,
            "object_count": 1,
        }
        (self.package / "index.json").write_text(json.dumps(index, separators=(",", ":")))

    def tearDown(self):
        self.temp.cleanup()

    def _write(self, relative: str, data: bytes) -> None:
        target = self.package / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)

    @staticmethod
    def _descriptor(relative: str, data: bytes) -> dict:
        return {"path": relative, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}

    @mock.patch.object(bundle_publish, "request_json")
    def test_assets_ready_retry_finishes_without_reuploading(self, request_json):
        request_json.side_effect = [
            {"ok": True, "assets_ready": True},
            {"ok": True, "status": "approved", "catalog_entry": {}},
        ]
        result = bundle_publish.upload(
            "https://avianvisitors.com", self.submission, self.package, "publisher-key", self.attempt
        )
        self.assertEqual(result["status"], "approved")
        self.assertEqual(request_json.call_count, 2)
        self.assertTrue(request_json.call_args_list[0].args[0].endswith("/manifest"))
        self.assertTrue(request_json.call_args_list[1].args[0].endswith("/finish"))

    @mock.patch.object(bundle_publish, "request_json")
    def test_uploads_only_fixed_checksum_bound_inventory_without_decoder(self, request_json):
        request_json.side_effect = [
            {"ok": True, "assets_ready": False},
            {"ok": True}, {"ok": True}, {"ok": True},
            {"ok": True, "status": "approved", "catalog_entry": {}},
        ]
        real_import = __import__

        def reject_decoder(name, *args, **kwargs):
            if name == "PIL" or name.startswith("PIL."):
                raise AssertionError("image decoder imported")
            return real_import(name, *args, **kwargs)

        with mock.patch("builtins.__import__", side_effect=reject_decoder):
            result = bundle_publish.upload(
                "https://avianvisitors.com", self.submission, self.package, "publisher-key", self.attempt
            )
        self.assertEqual(result["status"], "approved")
        self.assertEqual(request_json.call_count, 5)
        urls = [call.args[0] for call in request_json.call_args_list]
        self.assertTrue(any("/objects/" in url for url in urls))
        self.assertTrue(any("/preview-geometry/" in url for url in urls))
        self.assertTrue(any("/previews/" in url for url in urls))
        self.assertTrue(all(call.args[-1] == self.attempt for call in request_json.call_args_list))

    @mock.patch.object(bundle_publish, "request_json")
    def test_corruption_fails_before_publication_request(self, request_json):
        next((self.package / "objects").iterdir()).write_bytes(b"changed")
        with self.assertRaisesRegex(bundle_publish.PublicationError, "descriptor|checksum"):
            bundle_publish.upload(
                "https://avianvisitors.com", self.submission, self.package, "publisher-key", self.attempt
            )
        request_json.assert_not_called()

    def test_unexpected_file_is_rejected(self):
        (self.package / "unexpected.html").write_text("<script></script>")
        with self.assertRaisesRegex(bundle_publish.PublicationError, "unexpected files"):
            bundle_publish.load_package(self.package, self.submission)

    @mock.patch("bundle_publish.bundle_http.urlopen")
    def test_attempt_header_is_attached_only_when_requested(self, urlopen):
        class Response:
            def __enter__(self): return self
            def __exit__(self, *_): return False
            def read(self, *_): return b'{"ok":true}'

        urlopen.return_value = Response()
        bundle_publish.request_json(
            "https://avianvisitors.com/test", "key", "POST", b"{}", "application/json",
            self.attempt,
        )
        request = urlopen.call_args.args[0]
        self.assertEqual(request.get_header("X-bundle-publication-attempt"), self.attempt)

    def test_invalid_attempt_is_rejected_before_package_read(self):
        with self.assertRaisesRegex(bundle_publish.PublicationError, "attempt token"):
            bundle_publish.upload(
                "https://avianvisitors.com", self.submission, self.package, "publisher-key", "stale"
            )


if __name__ == "__main__":
    unittest.main()
