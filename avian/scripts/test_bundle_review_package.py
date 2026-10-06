#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import io
import json
import sys
import tempfile
import unittest
import zipfile
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest import mock

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bundle_ai_review
import bundle_canonical
import bundle_inventory_commitment
import bundle_moderate
import bundle_review_package as package
import bundle_validation_report


class BundleReviewPackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        image = Image.new("RGBA", (180, 120), (0, 0, 0, 0))
        for x in range(20, 160):
            for y in range(15, 105):
                image.putpixel((x, y), ((x * 11 + y) % 256, (y * 7) % 256, (x * y) % 256, 255))
        image.putpixel((0, 0), (255, 0, 255, 0))
        output = io.BytesIO()
        image.save(output, format="PNG")
        self.png = output.getvalue()
        sha = hashlib.sha256(self.png).hexdigest()
        self.manifest = {
            "format": "avian-visitors-asset-pack", "format_version": 1,
            "id": "review-test", "version": "1.0.0", "name": "Review test",
            "style": {"id": "woodblock", "name": "Japanese woodblock"},
            "coverage": {"type": "region", "label": "California", "region_codes": ["US-CA"]},
            "species": [{"scientific_name": "Turdus migratorius", "common_name": "American Robin", "poses": [{
                "id": "perched", "file": "illustrations/turdus-migratorius.png",
                "sha256": sha, "bytes": len(self.png),
            }]}],
            "license": {"spdx": "CC-BY-4.0"},
            "attribution": {"creator": "Test"},
        }
        self.archive = self.root / "bundle.zip"
        with zipfile.ZipFile(self.archive, "w", zipfile.ZIP_DEFLATED) as bundle:
            bundle.writestr("manifest.json", json.dumps(self.manifest))
            bundle.writestr("illustrations/turdus-migratorius.png", self.png)
        self.context = self.root / "context.json"
        self.context.write_text(json.dumps({"metadata": {
            "name": "Review test", "species_count": 1,
            "style_name": "Japanese woodblock", "license_spdx": "CC-BY-4.0",
            "region_label": "California", "region_codes": ["US-CA"],
            "provenance": {"method": "manual", "model": None, "review": None},
            "attribution": {"creator": "Test", "source_url": None},
            "cover_species": "Turdus migratorius",
        }}))

    def tearDown(self):
        self.temp.cleanup()

    def run_sanitizer_cli(self, output: Path) -> dict:
        stdout = StringIO()
        with mock.patch("sys.argv", [
            "bundle_review_package.py",
            "--archive", str(self.archive),
            "--context", str(self.context),
            "--output", str(output),
        ]), redirect_stdout(stdout):
            self.assertEqual(package.main(), 0)
        return json.loads(stdout.getvalue())

    def test_emits_exact_source_png_and_canonical_dual_ground_review_jpeg(self):
        output = self.root / "review"
        with mock.patch.object(
            package.bundle_validate,
            "validate_archive",
            wraps=package.bundle_validate.validate_archive,
        ) as validate:
            result = package.create_review_package(self.archive, self.context, output)
        validate.assert_called_once_with(self.archive, producer_contract=True)
        self.assertTrue(result["ok"])
        self.assertRegex(result["archive_sha256"], r"^[0-9a-f]{64}$")
        image_path = output / "images" / "0000.jpg"
        with Image.open(image_path) as image:
            self.assertEqual(image.format, "JPEG")
            self.assertEqual(image.size, (384, 384))
            self.assertFalse(image.getexif())
        index = json.loads((output / "index.json").read_text())
        self.assertTrue(index["items"][0]["canonical_dual"])
        self.assertEqual(index["public_manifest"], result["public_manifest"])
        self.assertEqual(index["public_manifest"]["description"], "")
        self.assertEqual(index["public_manifest"]["style"]["id"], "woodblock")
        source_path = output / "source-images" / "0000.png"
        canonical = bundle_canonical.canonical_png(self.png)
        self.assertNotEqual(canonical, self.png)
        self.assertEqual(source_path.read_bytes(), canonical)
        self.assertEqual(
            bundle_canonical.validate_canonical_structure(canonical), (180, 120)
        )
        with Image.open(source_path) as image:
            self.assertEqual(image.mode, "RGBA")
            self.assertEqual(image.getpixel((0, 0)), (0, 0, 0, 0))
        self.assertEqual(index["items"][0]["input_sha256"], hashlib.sha256(self.png).hexdigest())
        self.assertEqual(index["items"][0]["source_sha256"], hashlib.sha256(canonical).hexdigest())
        self.assertEqual(index["items"][0]["source_bytes"], len(canonical))
        self.assertEqual(result["publish_manifest_sha256"], index["publish_manifest_sha256"])
        self.assertEqual(
            index["object_inventory_sha256"],
            bundle_inventory_commitment.inventory_sha256(result["publish_object_inventory"]),
        )
        self.assertNotIn("bundle.zip", {str(path.relative_to(output)) for path in output.rglob("*")})

        metadata, moderation_items = bundle_moderate.load_review_package(output)
        ai_metadata, ai_items, reader, contact = bundle_ai_review.review_package_inventory(output)
        self.assertEqual(metadata["style"]["name"], "Japanese woodblock")
        self.assertEqual(ai_metadata, metadata)
        self.assertEqual(len(moderation_items), 1)
        self.assertEqual(moderation_items[0]["path"], source_path.resolve())
        self.assertEqual(len(ai_items), 1)
        self.assertEqual(hashlib.sha256(reader(ai_items[0])).hexdigest(), ai_items[0]["sha256"])
        self.assertEqual(contact["sampled"], 1)

    def test_review_index_producer_accepts_three_mib_and_rejects_one_byte_over(self):
        original_dumps = json.dumps
        for extra in (0, 1):
            output = self.root / f"index-boundary-{extra}"

            def padded_index(value, *args, **kwargs):
                serialized = original_dumps(value, *args, **kwargs)
                if isinstance(value, dict) and "items" in value and "contact_sheet" in value:
                    # Valid whitespace probes the byte guard beyond the bounded metadata envelope.
                    serialized += " " * (3 * 1024 * 1024 + extra - len(serialized.encode("utf-8")))
                return serialized

            with self.subTest(extra=extra), mock.patch.object(package.json, "dumps", new=padded_index):
                if extra:
                    with self.assertRaisesRegex(package.manager.BundleError, "review index exceeds"):
                        package.create_review_package(self.archive, self.context, output)
                    self.assertFalse(output.exists())
                else:
                    result = package.create_review_package(self.archive, self.context, output)
                    self.assertTrue(result["ok"])
                    self.assertEqual((output / "index.json").stat().st_size, 3 * 1024 * 1024)

    def test_external_https_source_url_with_fragment_survives_unchanged(self):
        source_url = "https://artist.example/work#credit"
        self.manifest["attribution"]["source_url"] = source_url
        with zipfile.ZipFile(self.archive, "w", zipfile.ZIP_DEFLATED) as bundle:
            bundle.writestr("manifest.json", json.dumps(self.manifest))
            bundle.writestr("illustrations/turdus-migratorius.png", self.png)
        context = json.loads(self.context.read_text())
        context["metadata"]["attribution"]["source_url"] = source_url
        self.context.write_text(json.dumps(context))
        output = self.root / "external-source-review"
        result = package.create_review_package(self.archive, self.context, output)
        self.assertTrue(result["ok"])
        index = json.loads((output / "index.json").read_text())
        self.assertEqual(index["public_manifest"]["attribution"]["source_url"], source_url)

    def test_missing_cover_is_a_controlled_validation_failure(self):
        context = json.loads(self.context.read_text())
        del context["metadata"]["cover_species"]
        self.context.write_text(json.dumps(context))

        output = self.root / "missing-cover-review"
        result = self.run_sanitizer_cli(output)
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "submission cover species is missing")
        self.assertFalse(output.exists())

    def test_sparse_canonical_art_fails_before_review_package_handoff(self):
        image = Image.new("RGBA", (560, 560), (0, 0, 0, 0))
        for x in range(278, 282):
            for y in range(278, 282):
                image.putpixel((x, y), (40, 80, 120, 255))
        raw = io.BytesIO()
        image.save(raw, format="PNG")
        sparse = raw.getvalue()
        self.manifest["species"][0]["poses"][0].update({
            "sha256": hashlib.sha256(sparse).hexdigest(),
            "bytes": len(sparse),
        })
        with zipfile.ZipFile(self.archive, "w", zipfile.ZIP_DEFLATED) as bundle:
            bundle.writestr("manifest.json", json.dumps(self.manifest))
            bundle.writestr("illustrations/turdus-migratorius.png", sparse)

        output = self.root / "sparse-review"
        result = self.run_sanitizer_cli(output)
        self.assertFalse(result["ok"])
        self.assertIn("station full-canvas mask is empty", result["error"])
        report = bundle_validation_report.build_report(None, result)
        self.assertFalse(report["ok"])
        self.assertEqual(report["findings"], ["station full-canvas mask is empty"])
        self.assertFalse(output.exists())

    def test_canonical_preview_collision_is_a_controlled_validation_failure(self):
        with Image.open(io.BytesIO(self.png)) as first:
            tight = first.convert("RGBA").crop((20, 15, 160, 105))
        second = Image.new("RGBA", (200, 140), (0, 0, 0, 0))
        second.paste(tight, (30, 25))
        second_raw = io.BytesIO()
        second.save(second_raw, format="PNG")
        alternate = second_raw.getvalue()
        self.assertNotEqual(
            bundle_canonical.canonical_png(alternate),
            bundle_canonical.canonical_png(self.png),
        )

        self.manifest["species"].append({
            "scientific_name": "Corvus brachyrhynchos",
            "common_name": "American Crow",
            "poses": [{
                "id": "perched",
                "file": "illustrations/corvus-brachyrhynchos.png",
                "sha256": hashlib.sha256(alternate).hexdigest(),
                "bytes": len(alternate),
            }],
        })
        with zipfile.ZipFile(self.archive, "w", zipfile.ZIP_DEFLATED) as bundle:
            bundle.writestr("manifest.json", json.dumps(self.manifest))
            bundle.writestr("illustrations/turdus-migratorius.png", self.png)
            bundle.writestr("illustrations/corvus-brachyrhynchos.png", alternate)
        context = json.loads(self.context.read_text())
        context["metadata"]["species_count"] = 2
        self.context.write_text(json.dumps(context))

        output = self.root / "collision-review"
        result = self.run_sanitizer_cli(output)
        self.assertFalse(result["ok"])
        self.assertIn(
            "cover and example species produce identical rendered artwork",
            result["error"],
        )
        report = bundle_validation_report.build_report(None, result)
        self.assertFalse(report["ok"])
        self.assertEqual(report["findings"], [
            "cover and example species produce identical rendered artwork",
        ])
        self.assertFalse(output.exists())

    @mock.patch.object(bundle_moderate, "request_text_moderation", return_value={
        "flagged": False, "categories": [],
    })
    @mock.patch.object(bundle_moderate, "request_moderation", return_value={
        "flagged": False, "categories": [],
    })
    def test_moderation_receives_exact_public_png_bytes(self, request_image, _request_text):
        output = self.root / "review"
        package.create_review_package(self.archive, self.context, output)
        result = bundle_moderate.moderate_review_package(output, "secret", workers=1)
        self.assertTrue(result["ok"])
        canonical = (output / "source-images/0000.png").read_bytes()
        self.assertEqual(request_image.call_args.args, (canonical, "secret", "image/png"))
        self.assertEqual(
            result["object_inventory_sha256"],
            bundle_inventory_commitment.inventory_sha256([{
                "file": "illustrations/turdus-migratorius.png",
                "sha256": hashlib.sha256(canonical).hexdigest(),
                "bytes": len(canonical),
            }]),
        )

    @mock.patch.object(bundle_moderate, "request_text_moderation", return_value={
        "flagged": False, "categories": [],
    })
    @mock.patch.object(bundle_moderate, "request_moderation", return_value={
        "flagged": False, "categories": [],
    })
    def test_swapped_safe_moderation_copy_cannot_bind_real_publish_inventory(
        self, _request_image, _request_text,
    ):
        output = self.root / "review"
        validation = package.create_review_package(self.archive, self.context, output)

        alternate_image = Image.new("RGBA", (180, 120), (0, 0, 0, 0))
        for x in range(15, 165):
            for y in range(20, 100):
                alternate_image.putpixel((x, y), (20, 100, 180, 255))
        alternate_raw = io.BytesIO()
        alternate_image.save(alternate_raw, format="PNG")
        alternate = bundle_canonical.canonical_png(alternate_raw.getvalue())
        source_path = output / "source-images/0000.png"
        source_path.write_bytes(alternate)
        index_path = output / "index.json"
        index = json.loads(index_path.read_text())
        index["items"][0]["source_sha256"] = hashlib.sha256(alternate).hexdigest()
        index["items"][0]["source_bytes"] = len(alternate)
        index_path.write_text(json.dumps(index, separators=(",", ":")))

        moderation = bundle_moderate.moderate_review_package(output, "secret", workers=1)
        self.assertTrue(moderation["ok"])
        self.assertNotEqual(
            moderation["object_inventory_sha256"], index["object_inventory_sha256"]
        )
        result = bundle_validation_report.build_report(
            None,
            validation,
            moderation=moderation,
            ai_review=bundle_validation_report.failed_ai_review("advisory unavailable"),
        )
        self.assertFalse(result["ok"])
        self.assertIn("inventory", result["findings"][0])


if __name__ == "__main__":
    unittest.main()
