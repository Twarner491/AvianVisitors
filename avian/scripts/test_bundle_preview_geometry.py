#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import io
import json
import base64
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bundle_preview_geometry as preview


class BundlePreviewGeometryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def make_archive(self, alpha: int = 255) -> tuple[Path, dict]:
        species = []
        images = {}
        names = [
            ("Corvus brachyrhynchos", "American Crow"),
            ("Turdus migratorius", "American Robin"),
            ("Cyanocitta stelleri", "Steller's Jay"),
            ("Calypte anna", "Anna's Hummingbird"),
            ("Ardea herodias", "Great Blue Heron"),
            ("Piranga ludoviciana", "Western Tanager"),
            ("Tyto alba", "Barn Owl"),
            ("Colaptes auratus", "Northern Flicker"),
        ]
        for index, (scientific, common) in enumerate(names):
            image = Image.new("RGBA", (128, 96), (0, 0, 0, 0))
            for x in range(18 + index, 83 + index):
                for y in range(13, 75):
                    image.putpixel((x, y), (20 + index, 40, 60, alpha))
            path = self.root / f"bird-{index}.png"
            image.save(path, format="PNG")
            raw = path.read_bytes()
            slug = "-".join(scientific.lower().split())
            file_name = f"illustrations/{slug}.png"
            images[file_name] = raw
            species.append({
                "scientific_name": scientific,
                "common_name": common,
                "poses": [{
                    "id": "perched",
                    "file": file_name,
                    "sha256": hashlib.sha256(raw).hexdigest(),
                    "bytes": len(raw),
                }],
            })
        manifest = {
            "format": "avian-visitors-asset-pack",
            "format_version": 1,
            "id": "preview-test",
            "version": "1.0.0",
            "species": species,
        }
        archive_path = self.root / f"bundle-{alpha}.zip"
        with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("manifest.json", json.dumps(manifest, separators=(",", ":")))
            for name, raw in images.items():
                archive.writestr(name, raw)
        return archive_path, manifest

    @staticmethod
    def station_vector(opaque_side: int) -> bytes:
        image = Image.new("RGBA", (560, 560), (0, 0, 0, 0))
        offset = (560 - opaque_side) // 2
        for x in range(offset, offset + opaque_side):
            for y in range(offset, offset + opaque_side):
                image.putpixel((x, y), (40, 80, 120, 255))
        output = io.BytesIO()
        image.save(output, format="PNG")
        return output.getvalue()

    def test_cover_is_separate_and_six_examples_are_reproducible(self):
        archive, manifest = self.make_archive()
        first, first_raw, first_renders = preview.build_preview_package(
            archive, manifest, "Corvus brachyrhynchos"
        )
        second, second_raw, second_renders = preview.build_preview_package(
            archive, manifest, "Corvus brachyrhynchos"
        )
        self.assertEqual(first_raw, second_raw)
        self.assertEqual(first_renders, second_renders)
        self.assertEqual(first["cover"]["scientific_name"], "Corvus brachyrhynchos")
        self.assertEqual(len(first["example_order"]), 6)
        self.assertNotIn(first["cover"]["render_sha256"], first["example_order"])
        self.assertNotIn(
            "Corvus brachyrhynchos",
            [first["items"][digest]["scientific_name"] for digest in first["example_order"]],
        )
        for digest in [first["cover"]["render_sha256"], *first["example_order"]]:
            self.assertEqual(hashlib.sha256(first_renders[digest]).hexdigest(), digest)
        for digest in first["example_order"]:
            item = first["items"][digest]
            mask = item["mask"]
            self.assertEqual(max(mask["w"], mask["h"]), 93)
            self.assertEqual(item["dims"], [65, 62])

    def test_subthreshold_alpha_is_not_publishable(self):
        archive, manifest = self.make_archive(alpha=127)
        with self.assertRaisesRegex(preview.PreviewGeometryError, "no visible alpha"):
            preview.build_preview_package(archive, manifest, "Corvus brachyrhynchos")

    def test_station_full_canvas_sparse_boundary_matches_frozen_vector(self):
        with self.assertRaisesRegex(preview.PreviewGeometryError, "full-canvas mask is empty"):
            preview.station_full_canvas_geometry(self.station_vector(4))

        dimensions, mask = preview.station_full_canvas_geometry(self.station_vector(5))
        self.assertEqual(dimensions, [560, 560])
        self.assertEqual((mask["w"], mask["h"]), (93, 93))
        packed = base64.b64decode(mask["bits"], validate=True)
        self.assertEqual(
            hashlib.sha256(packed).hexdigest(),
            "8fb6b102f9f0b3010564d6987712f392b28af11317d16df07be2b6052575dbf5",
        )
        active = [
            index
            for index in range(mask["w"] * mask["h"])
            if packed[index >> 3] & (1 << (7 - (index & 7)))
        ]
        self.assertEqual(active, [4324])

    def test_unknown_cover_is_rejected(self):
        archive, manifest = self.make_archive()
        with self.assertRaisesRegex(preview.PreviewGeometryError, "not in manifest"):
            preview.build_preview_package(archive, manifest, "Falco peregrinus")

    def test_common_name_is_optional_and_preserved_exactly(self):
        archive, manifest = self.make_archive()
        manifest["species"][0].pop("common_name")
        manifest["species"][1]["common_name"] = "  Māui 🪶  "
        geometry, _, _ = preview.build_preview_package(
            archive, manifest, "Corvus brachyrhynchos"
        )
        self.assertEqual(geometry["cover"]["common_name"], "")
        first = geometry["items"][geometry["example_order"][0]]
        self.assertEqual(first["common_name"], "  Māui 🪶  ")

        manifest["species"][0]["common_name"] = "🪶" * 100
        geometry, _, _ = preview.build_preview_package(
            archive, manifest, "Corvus brachyrhynchos"
        )
        self.assertEqual(geometry["cover"]["common_name"], "🪶" * 100)

    def test_invalid_common_name_is_rejected(self):
        archive, manifest = self.make_archive()
        for value in (
            None, 7, {}, "🪶" * 101, "line\nbreak", "delete\x7fcontrol",
            "<Robin>", "\ud800", "\udfff"
        ):
            with self.subTest(value=repr(value)[:20]):
                manifest["species"][0]["common_name"] = value
                with self.assertRaisesRegex(preview.PreviewGeometryError, "invalid common name"):
                    preview.build_preview_package(
                        archive, manifest, "Corvus brachyrhynchos"
                    )

    def test_distinct_sources_with_one_render_fail_explicitly(self):
        archive, manifest = self.make_archive()
        first_file = manifest["species"][1]["poses"][0]["file"]
        second_pose = manifest["species"][2]["poses"][0]
        with zipfile.ZipFile(archive) as original:
            members = {name: original.read(name) for name in original.namelist() if name != "manifest.json"}
        with Image.open(io.BytesIO(members[first_file])) as image:
            alternate = io.BytesIO()
            image.save(alternate, format="PNG", compress_level=1)
        alternate_raw = alternate.getvalue()
        self.assertNotEqual(alternate_raw, members[first_file])
        members[second_pose["file"]] = alternate_raw
        second_pose["sha256"] = hashlib.sha256(alternate_raw).hexdigest()
        second_pose["bytes"] = len(alternate_raw)
        duplicate_archive = self.root / "duplicate-render.zip"
        with zipfile.ZipFile(duplicate_archive, "w", zipfile.ZIP_DEFLATED) as output:
            output.writestr("manifest.json", json.dumps(manifest, separators=(",", ":")))
            for name, raw in members.items():
                output.writestr(name, raw)
        with self.assertRaisesRegex(preview.PreviewGeometryError, "identical rendered artwork"):
            preview.build_preview_package(
                duplicate_archive, manifest, "Corvus brachyrhynchos"
            )

    def test_cover_and_example_with_one_render_fail_explicitly(self):
        archive, manifest = self.make_archive()
        cover_file = manifest["species"][0]["poses"][0]["file"]
        example_pose = manifest["species"][1]["poses"][0]
        with zipfile.ZipFile(archive) as original:
            members = {name: original.read(name) for name in original.namelist() if name != "manifest.json"}
        with Image.open(io.BytesIO(members[cover_file])) as image:
            alternate = io.BytesIO()
            image.save(alternate, format="PNG", compress_level=1)
        alternate_raw = alternate.getvalue()
        self.assertNotEqual(alternate_raw, members[cover_file])
        members[example_pose["file"]] = alternate_raw
        example_pose["sha256"] = hashlib.sha256(alternate_raw).hexdigest()
        example_pose["bytes"] = len(alternate_raw)
        duplicate_archive = self.root / "cover-example-render.zip"
        with zipfile.ZipFile(duplicate_archive, "w", zipfile.ZIP_DEFLATED) as output:
            output.writestr("manifest.json", json.dumps(manifest, separators=(",", ":")))
            for name, raw in members.items():
                output.writestr(name, raw)
        with self.assertRaisesRegex(
            preview.PreviewGeometryError,
            "cover and example species produce identical rendered artwork",
        ):
            preview.build_preview_package(
                duplicate_archive, manifest, "Corvus brachyrhynchos"
            )


if __name__ == "__main__":
    unittest.main()
