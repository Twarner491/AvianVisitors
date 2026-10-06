#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import io
import json
import struct
import sys
import tempfile
import unittest
import zlib
from pathlib import Path
from unittest import mock

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bundle_canonical
import bundle_canonical_upload as uploader
import bundle_inventory_commitment


class FakeResponse:
    status = 204

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


class BundleCanonicalUploadTests(unittest.TestCase):
    submission = "canonicaltestid000001"
    attempt = "A" * 32

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.review = self.root / "review"
        (self.review / "source-images").mkdir(parents=True)
        image = Image.new("RGBA", (2, 1), (255, 0, 255, 0))
        image.putpixel((1, 0), (40, 60, 80, 255))
        encoded = io.BytesIO()
        image.save(encoded, format="PNG")
        self.canonical = bundle_canonical.canonical_png(encoded.getvalue())
        self.assertLess(len(self.canonical), 1024)
        self.item = bundle_canonical.descriptor(
            "illustrations/turdus-migratorius.png", self.canonical
        )
        width, height = bundle_canonical.png_dimensions(self.canonical)
        manifest = {
            "format": "avian-visitors-asset-pack", "format_version": 1,
            "id": "canonical-test", "version": "1.0.0", "name": "Canonical test",
            "style": {"id": "woodblock", "name": "Woodblock"},
            "coverage": {"type": "region", "label": "California", "region_codes": ["US-CA"]},
            "species": [{"scientific_name": "Turdus migratorius", "poses": [{
                "id": "perched", "file": self.item["file"],
                "sha256": self.item["sha256"], "bytes": self.item["bytes"],
            }]}],
            "license": {"spdx": "CC-BY-4.0"},
            "attribution": {"creator": "Test"},
        }
        self.publish_raw = (
            json.dumps(manifest, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
            + "\n"
        ).encode()
        (self.review / "publish-manifest.json").write_bytes(self.publish_raw)
        (self.review / "source-images" / "0000.png").write_bytes(self.canonical)
        self.inventory_sha = bundle_inventory_commitment.inventory_sha256([self.item])
        (self.review / "index.json").write_text(json.dumps({
            "schema_version": 1,
            "canonicalization": uploader.CANONICALIZATION,
            "publish_manifest_sha256": hashlib.sha256(self.publish_raw).hexdigest(),
            "object_inventory_sha256": self.inventory_sha,
            "items": [{
                "file": self.item["file"],
                "source_image": "source-images/0000.png",
                "source_sha256": self.item["sha256"],
                "source_bytes": self.item["bytes"],
                "width": width, "height": height,
            }],
        }))
        self.moderation = self.root / "moderation.json"
        self.moderation.write_text(json.dumps({
            "ok": True, "metadata_checked": True, "checked": 2,
            "flagged_count": 0, "object_inventory_sha256": self.inventory_sha,
        }))

    def tearDown(self):
        self.temp.cleanup()

    @mock.patch("bundle_canonical_upload.bundle_http.urlopen", return_value=FakeResponse())
    def test_uploads_manifest_then_exact_tiny_canonical_png(self, urlopen):
        result = uploader.upload_package(
            self.review, self.moderation, self.submission, "secret", self.attempt,
            "https://example.test", workers=1,
        )
        self.assertEqual(result["uploaded"], 2)
        self.assertEqual(urlopen.call_count, 2)
        manifest_request = urlopen.call_args_list[0].args[0]
        object_request = urlopen.call_args_list[1].args[0]
        self.assertTrue(manifest_request.full_url.endswith("/canonical-manifest"))
        self.assertEqual(manifest_request.data, self.publish_raw)
        self.assertTrue(object_request.full_url.endswith("/canonical-objects/0"))
        self.assertEqual(object_request.data, self.canonical)
        self.assertEqual(
            object_request.get_header("X-bundle-source-file"), self.item["file"]
        )
        self.assertEqual(
            object_request.get_header("X-bundle-validation-attempt"), self.attempt
        )

    @mock.patch("bundle_canonical_upload.bundle_http.urlopen")
    def test_incomplete_moderation_does_not_upload(self, urlopen):
        value = json.loads(self.moderation.read_text())
        value["metadata_checked"] = False
        self.moderation.write_text(json.dumps(value))
        result = uploader.upload_package(
            self.review, self.moderation, self.submission, "secret", self.attempt,
            "https://example.test", workers=1,
        )
        self.assertTrue(result["skipped"])
        urlopen.assert_not_called()

    def test_swapped_object_is_rejected_before_network(self):
        (self.review / "source-images" / "0000.png").write_bytes(b"different")
        with self.assertRaisesRegex(RuntimeError, "missing or unsafe"):
            uploader.upload_package(
                self.review, self.moderation, self.submission, "secret", self.attempt,
                "https://example.test", workers=1,
            )

    def test_moderation_inventory_must_bind_uploaded_bytes(self):
        value = json.loads(self.moderation.read_text())
        value["object_inventory_sha256"] = "f" * 64
        self.moderation.write_text(json.dumps(value))
        result = uploader.load_package(self.review, self.moderation)
        self.assertTrue(result["skipped"])

    def test_canonical_structure_rejects_even_valid_ancillary_chunks(self):
        marker = self.canonical.rfind(b"\x00\x00\x00\x00IEND")
        self.assertGreater(marker, 0)
        kind = b"tEXt"
        payload = b"comment\x00unreviewed"
        chunk = (
            struct.pack(">I", len(payload)) + kind + payload
            + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
        )
        tainted = self.canonical[:marker] + chunk + self.canonical[marker:]
        with self.assertRaisesRegex(Exception, "non-pixel"):
            bundle_canonical.validate_canonical_structure(tainted)


if __name__ == "__main__":
    unittest.main()
