#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bundle_canonical
import bundle_inventory_commitment
import bundle_publication_package as publication


class BundlePublicationPackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        image = Image.new("RGBA", (180, 120), (0, 0, 0, 0))
        for x in range(20, 160):
            for y in range(15, 105):
                image.putpixel(
                    (x, y), ((x * 11 + y) % 256, (y * 7) % 256, (x * y) % 256, 255)
                )
        image.putpixel((0, 0), (255, 0, 255, 0))
        raw = io.BytesIO()
        image.save(raw, format="PNG")
        self.png = raw.getvalue()
        digest = hashlib.sha256(self.png).hexdigest()
        self.manifest = {
            "format": "avian-visitors-asset-pack", "format_version": 1,
            "id": "publish-test", "version": "1.0.0", "name": "Publish test",
            "description": "A reviewed bird set.",
            "style": {"id": "woodblock", "name": "Japanese woodblock"},
            "coverage": {"type": "region", "label": "California", "region_codes": ["US-CA"]},
            "species": [{
                "scientific_name": "Turdus migratorius", "common_name": "American Robin",
                "poses": [{
                    "id": "perched", "file": "illustrations/turdus-migratorius.png",
                    "sha256": digest, "bytes": len(self.png),
                }],
            }],
            "license": {"spdx": "CC-BY-4.0"},
            "attribution": {"creator": "Test", "source_url": "https://example.com/source"},
            "provenance": {"method": "manual", "review": "contributor-reviewed"},
        }
        self.context = self.root / "context.json"
        self.context.write_text(json.dumps({"metadata": {
            "name": "Publish test", "species_count": 1,
            "style_name": "Japanese woodblock", "license_spdx": "CC-BY-4.0",
            "region_label": "California", "region_codes": ["US-CA"],
            "provenance": {"method": "manual", "model": None, "review": "contributor-reviewed"},
            "attribution": {"creator": "Test", "source_url": "https://example.com/source"},
            "cover_species": "Turdus migratorius",
        }}))
        self._write_canonical_inputs(self.png)

    def tearDown(self):
        self.temp.cleanup()

    def _write_canonical_inputs(self, submitted_png: bytes) -> bytes:
        self.canonical_root = self.root / "canonical"
        self.canonical_objects = self.canonical_root / "objects"
        self.canonical_objects.mkdir(parents=True, exist_ok=True)
        canonical = bundle_canonical.canonical_png(submitted_png)
        item = bundle_canonical.descriptor(
            "illustrations/turdus-migratorius.png", canonical
        )
        width, height = bundle_canonical.png_dimensions(canonical)
        publish_manifest, publish_raw = bundle_canonical.publish_manifest(
            self.manifest, [item]
        )
        self.canonical_manifest = self.canonical_root / "manifest.json"
        self.canonical_manifest.write_bytes(publish_raw)
        (self.canonical_objects / "0000.png").write_bytes(canonical)
        self.canonical_index = self.canonical_root / "index.json"
        self.canonical_index.write_text(json.dumps({
            "schema_version": 1,
            "canonicalization": bundle_canonical.FORMAT,
            "input_archive_sha256": "a" * 64,
            "input_manifest_sha256": hashlib.sha256(
                json.dumps(self.manifest).encode()
            ).hexdigest(),
            "publish_manifest_sha256": hashlib.sha256(publish_raw).hexdigest(),
            "object_inventory_sha256": (
                bundle_inventory_commitment.manifest_inventory_sha256(publish_manifest)
            ),
            "objects": [{
                "ordinal": 0, **item, "width": width, "height": height,
            }],
        }))
        return canonical

    def test_materializes_strict_hash_bound_publication_inventory(self):
        output = self.root / "publication"
        result = publication.materialize(
            self.canonical_index, self.canonical_manifest, self.canonical_objects,
            self.context, output, "publicationtestid000001"
        )
        self.assertTrue(result["ok"])
        package = json.loads((output / "index.json").read_text())
        self.assertEqual(package["format"], publication.FORMAT)
        self.assertEqual(package["submission_id"], "publicationtestid000001")
        self.assertEqual(package["object_count"], 1)
        self.assertEqual(len(package["previews"]), 1)
        canonical_object = (output / package["objects"][0]["path"]).read_bytes()
        self.assertNotEqual(canonical_object, self.png)
        self.assertEqual(canonical_object, (self.canonical_objects / "0000.png").read_bytes())
        with Image.open(io.BytesIO(canonical_object)) as image:
            self.assertEqual(image.mode, "RGBA")
            self.assertEqual(image.getpixel((0, 0)), (0, 0, 0, 0))
        for entry in [
            package["manifest"], package["preview_geometry"],
            *package["objects"], *package["previews"],
        ]:
            data = (output / entry["path"]).read_bytes()
            self.assertEqual(len(data), entry["bytes"])
            self.assertEqual(hashlib.sha256(data).hexdigest(), entry["sha256"])
        self.assertFalse(any(path.suffix == ".zip" for path in output.rglob("*")))

    def test_tiny_canonical_object_below_legacy_floor_publishes_exactly(self):
        image = Image.new("RGBA", (2, 1), (0, 0, 0, 0))
        image.putpixel((0, 0), (255, 0, 255, 0))
        image.putpixel((1, 0), (20, 40, 60, 255))
        raw = io.BytesIO()
        image.save(raw, format="PNG")
        submitted = raw.getvalue()
        self.manifest["species"][0]["poses"][0].update({
            "sha256": hashlib.sha256(submitted).hexdigest(),
            "bytes": len(submitted),
        })
        canonical = self._write_canonical_inputs(submitted)
        self.assertLess(len(canonical), 1024)
        output = self.root / "tiny-publication"
        publication.materialize(
            self.canonical_index, self.canonical_manifest, self.canonical_objects,
            self.context, output, "publicationtestid000001",
        )
        package = json.loads((output / "index.json").read_text())
        self.assertEqual(
            (output / package["objects"][0]["path"]).read_bytes(), canonical
        )

    def test_claim_mismatch_materializes_no_public_bytes(self):
        context = json.loads(self.context.read_text())
        context["metadata"]["style_name"] = "Different"
        self.context.write_text(json.dumps(context))
        output = self.root / "publication"
        with self.assertRaisesRegex(Exception, "style"):
            publication.materialize(
                self.canonical_index, self.canonical_manifest, self.canonical_objects,
                self.context, output, "publicationtestid000001"
            )
        self.assertFalse((output / "manifest.json").exists())


if __name__ == "__main__":
    unittest.main()
