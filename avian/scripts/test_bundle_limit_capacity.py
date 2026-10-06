#!/usr/bin/env python3
"""Offline limit regressions: real PNGs, real packages, no external services."""
from __future__ import annotations

import hashlib
import io
import json
import os
import random
import resource
import subprocess
import sys
import tempfile
import time
import unittest
import zipfile
from pathlib import Path
from unittest import mock

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bundle_ai_review
import bundle_canonical_upload
import bundle_moderate
import bundle_publication_package
import bundle_publish
import bundle_review_package
import bundle_review_assets
import bundle_validate


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()


class BundleLimitCapacityTests(unittest.TestCase):
    def test_archive_admission_exact_768_mib_and_one_byte_over(self):
        # Sparse files prove the stat boundary without allocating 768 MiB RAM/disk.
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "boundary.zip"
            for size in (512 * 1024 * 1024 + 1, 768 * 1024 * 1024, 768 * 1024 * 1024 + 1):
                with self.subTest(size=size), path.open("wb") as output:
                    output.truncate(size)
                with mock.patch.object(bundle_validate.zipfile, "ZipFile", side_effect=zipfile.BadZipFile):
                    expected = "compressed-size" if size > 768 * 1024 * 1024 else "not a valid ZIP"
                    with self.assertRaisesRegex(bundle_validate.manager.BundleError, expected):
                        bundle_validate.validate_archive(path)

    def test_publication_workflow_accepts_1499_and_rejects_overflow(self):
        workflow = Path(__file__).resolve().parents[2] / ".github/workflows/publish-bundle.yml"
        predicate = workflow.read_text().split("jq -e '", 1)[1].split("' publication-input/", 1)[0]
        base = {"schema_version": 1, "canonicalization": "rgba-png-zero-transparent-v1"}
        for key in ("input_archive_sha256", "input_manifest_sha256", "publish_manifest_sha256", "object_inventory_sha256"):
            base[key] = "a" * 64
        objects = [{"ordinal": i, "file": f"illustrations/bird-{i}.png", "sha256": "b" * 64,
                    "bytes": 4194304, "width": 4096, "height": 4096} for i in range(1500)]
        for inventory, passes in ((objects, True), (objects + [{**objects[-1], "ordinal": 1500}], False),
                                  ([{**objects[0], "ordinal": 1500}], False),
                                  ([{**objects[0], "bytes": 4194305}], False)):
            with self.subTest(count=len(inventory), last=inventory[-1]["ordinal"]):
                result = subprocess.run(["jq", "-e", predicate], input=encoded({**base, "objects": inventory}),
                                        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=False)
                self.assertEqual(result.returncode == 0, passes, result.stderr.decode())

    def test_unchanged_byte_species_and_decoder_bounds(self):
        self.assertEqual(bundle_validate.MAX_EXPANDED_BYTES, 640 * 1024 * 1024)
        self.assertEqual(bundle_validate.MAX_HOSTED_SPECIES, 1000)
        self.assertEqual(bundle_validate.manager.MAX_OBJECT_BYTES, 4 * 1024 * 1024)
        self.assertEqual(bundle_validate.manager.MAX_IMAGE_SIDE, 4096)
        self.assertEqual(bundle_canonical_upload.MAX_TOTAL_BYTES, 640 * 1024 * 1024)
        self.assertEqual(bundle_canonical_upload.MAX_OBJECT_BYTES, 4 * 1024 * 1024)
        self.assertEqual(bundle_publish.MAX_OBJECT_BYTES, 4 * 1024 * 1024)

    def test_zip_metadata_preserves_exact_image_and_expanded_limits(self):
        def member(index, size):
            info = zipfile.ZipInfo(f"illustrations/bird-{index}.png")
            info.file_size = info.compress_size = size
            return info

        four_mib = 4 * 1024 * 1024
        exact = [member(index, four_mib) for index in range(160)]
        cases = (
            ([member(0, four_mib)], "manifest is missing"),
            ([member(0, four_mib + 1)], "object-size limit"),
            (exact, "manifest is missing"),
            (exact + [member(160, 1)], "expanded-size limit"),
        )
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "metadata.zip"
            path.touch()
            for entries, message in cases:
                with self.subTest(message=message), mock.patch.object(bundle_validate.zipfile, "ZipFile") as archive:
                    archive.return_value.infolist.return_value = entries
                    with self.assertRaisesRegex(bundle_validate.manager.BundleError, message):
                        bundle_validate.validate_archive(path)

    def test_1500_real_pngs_through_offline_review_and_publication(self):
        self._exercise_capacity()

    def test_1500_maximum_supported_names_fit_every_index_reader(self):
        self._exercise_capacity(maximum_names=True)

    def _exercise_capacity(self, maximum_names=False):
        started = time.monotonic()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive_path = root / "bundle.zip"
            manifest = {
                "format": "avian-visitors-asset-pack", "format_version": 1,
                "id": "capacity-test", "version": "1.0.0", "name": "Capacity test",
                "style": {"id": "woodblock", "name": "Woodblock"},
                "coverage": {"type": "selection", "label": "Capacity test", "region_codes": []},
                "license": {"spdx": "CC-BY-4.0"}, "attribution": {"creator": "Test"}, "species": [],
            }
            # Set AVIAN_CAPACITY_SCALE=4 for the bounded 512x384 resource proof.
            scale = int(os.environ.get("AVIAN_CAPACITY_SCALE", "1"))
            self.assertIn(scale, (1, 4))
            base = Image.new("RGBA", (128 * scale, 96 * scale))
            noise = Image.frombytes("RGB", (100 * scale, 72 * scale),
                                    random.Random(17).randbytes(100 * 72 * 3 * scale * scale))
            base.paste(noise, (14 * scale, 12 * scale))
            with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_STORED) as archive:
                for species in range(750):
                    suffix = "".join(chr(97 + (species // divisor) % 26) for divisor in (676, 26, 1))
                    scientific = (
                        "A" + "a" * 39 + " " + "b" * 40 + " " + "c" * 40 + " " + "d" * 37 + suffix
                        if maximum_names else f"Avis {suffix}"
                    )
                    bird = {"scientific_name": scientific, "poses": []}
                    if maximum_names:
                        self.assertEqual(len(scientific), 163)
                        bird["common_name"] = "\U0001f99c" * 100
                    for pose in range(2):
                        ordinal = species * 2 + pose
                        image = base.copy()
                        image.putpixel((32 * scale, 32 * scale), (ordinal % 256, ordinal // 256, 17, 255))
                        output = io.BytesIO()
                        image.save(output, format="PNG")
                        png = output.getvalue()
                        slug = scientific.lower().replace(" ", "-")
                        name = f"illustrations/{slug}{'-2' if pose else ''}.png"
                        bird["poses"].append({"id": "flight" if pose else "perched", "file": name,
                                              "sha256": hashlib.sha256(png).hexdigest(), "bytes": len(png)})
                        archive.writestr(name, png)
                    manifest["species"].append(bird)
                archive.writestr("manifest.json", encoded(manifest))
            context = root / "context.json"
            context.write_bytes(encoded({"metadata": {
                "name": "Capacity test", "species_count": 750, "style_name": "Woodblock",
                "license_spdx": "CC-BY-4.0", "region_label": "Capacity test", "region_codes": [],
                "provenance": {"method": "manual", "model": None, "review": None},
                "attribution": {"creator": "Test", "source_url": None},
                "cover_species": manifest["species"][0]["scientific_name"],
            }}))
            review = root / "review"
            validation = bundle_review_package.create_review_package(archive_path, context, review)
            self.assertEqual((validation["species"], validation["objects"]), (750, 1500))
            _, moderated = bundle_moderate.load_review_package(review)
            _, advisory, _, _ = bundle_ai_review.review_package_inventory(review)
            self.assertEqual((len(moderated), len(advisory)), (1500, 1500))
            review_index = json.loads((review / "index.json").read_bytes())
            review_index_bytes = (review / "index.json").stat().st_size
            moderation = root / "moderation.json"
            # A local transport fixture, never a real moderation result or authorization.
            moderation.write_bytes(encoded({"ok": True, "metadata_checked": True, "checked": 1501,
                                           "flagged_count": 0, "object_inventory_sha256": review_index["object_inventory_sha256"]}))
            if maximum_names:
                self.assertGreater(review_index_bytes, 1024 * 1024)
                self.assertLess(review_index_bytes, 3 * 1024 * 1024)
                original_index = (review / "index.json").read_bytes()
                readers = [
                    (bundle_canonical_upload.load_package, (review, moderation)),
                    (bundle_moderate.load_review_package, (review,)),
                    (bundle_ai_review.review_package_inventory, (review,)),
                ]
                # Only the private hardened asset client consumes the review index.
                if hasattr(bundle_review_assets, "load_review_package"):
                    readers.append((bundle_review_assets.load_review_package, (review,)))
                for extra in (0, 1):
                    (review / "index.json").write_bytes(
                        original_index + b" " * (3 * 1024 * 1024 + extra - len(original_index))
                    )
                    for loader, args in readers:
                        with self.subTest(loader=loader.__module__, index_overflow=extra):
                            if extra:
                                with self.assertRaisesRegex(RuntimeError, "(missing|invalid|too large)"):
                                    loader(*args)
                            else:
                                self.assertIsNotNone(loader(*args))
                (review / "index.json").write_bytes(original_index)
            canonical = bundle_canonical_upload.load_package(review, moderation)
            self.assertEqual(canonical["objects"][-1]["ordinal"], 1499)
            uploads = set()

            def record_put(url, data, content_type, sha, key, attempt, source_file=None):
                self.assertEqual(hashlib.sha256(data).hexdigest(), sha)
                uploads.add(url.rsplit("/", 1)[-1])

            with mock.patch.object(bundle_canonical_upload, "put", new=record_put):
                result = bundle_canonical_upload.upload_package(review, moderation, "capacitytestid00000001", "offline", "A" * 32)
            self.assertTrue(result["ok"])
            self.assertEqual(uploads, {"canonical-manifest", *(str(i) for i in range(1500))})
            canonical_index = root / "canonical-index.json"
            canonical_index.write_bytes(encoded({
                "schema_version": 1, "canonicalization": "rgba-png-zero-transparent-v1",
                "input_archive_sha256": validation["archive_sha256"], "input_manifest_sha256": validation["manifest_sha256"],
                "publish_manifest_sha256": review_index["publish_manifest_sha256"],
                "object_inventory_sha256": review_index["object_inventory_sha256"],
                "objects": [{key: value for key, value in item.items() if key != "path"} for item in canonical["objects"]],
            }))
            publication = root / "publication"
            prepared = bundle_publication_package.materialize(canonical_index, review / "publish-manifest.json",
                        review / "source-images", context, publication, "capacitytestid00000001")
            self.assertEqual(prepared["objects"], 1500)
            self.assertEqual(len(bundle_publish.load_package(publication, "capacitytestid00000001")["objects"]), 1500)
            publication_index_bytes = (publication / "index.json").stat().st_size
            self.assertLessEqual(canonical_index.stat().st_size, 1024 * 1024)
            self.assertLessEqual(publication_index_bytes, 512 * 1024)

            # Overflow must fail at each trust boundary before processing another object.
            manifest["species"].append({"scientific_name": "Avis overflow", "poses": [{
                **manifest["species"][0]["poses"][0], "file": "illustrations/avis-overflow.png"}]})
            overflow_archive = root / "overflow.zip"
            with zipfile.ZipFile(overflow_archive, "w") as archive:
                archive.writestr("manifest.json", encoded(manifest))
            with self.assertRaisesRegex(bundle_validate.manager.BundleError, "hosted illustration limit"):
                bundle_validate.validate_archive(overflow_archive)
            review_index["items"].append(review_index["items"][-1])
            (review / "index.json").write_bytes(encoded(review_index))
            for loader, args in ((bundle_canonical_upload.load_package, (review, moderation)),
                                 (bundle_moderate.load_review_package, (review,)),
                                 (bundle_ai_review.review_package_inventory, (review,))):
                with self.subTest(loader=loader.__module__), self.assertRaisesRegex(RuntimeError, "(inventory|count)"):
                    loader(*args)
            published_index = json.loads((publication / "index.json").read_bytes())
            published_index["objects"].append(published_index["objects"][-1])
            (publication / "index.json").write_bytes(encoded(published_index))
            with self.assertRaisesRegex(bundle_publish.PublicationError, "object count"):
                bundle_publish.load_package(publication, "capacitytestid00000001")
            print(json.dumps({"capacity_proof": {"objects": 1500, "species": 750,
                  "maximum_names": maximum_names,
                  "archive_bytes": archive_path.stat().st_size, "canonical_bytes": canonical["bytes"],
                  "canvas": [128 * scale, 96 * scale], "review_index_bytes": review_index_bytes,
                  "canonical_index_bytes": canonical_index.stat().st_size,
                  "publication_index_bytes": publication_index_bytes,
                  "publication_bytes": prepared["bytes"],
                  "elapsed_seconds": round(time.monotonic() - started, 2),
                  "max_rss_kib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}}))


if __name__ == "__main__":
    unittest.main()
