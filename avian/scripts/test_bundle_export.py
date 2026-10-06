#!/usr/bin/env python3
from __future__ import annotations

import base64
import errno
import fcntl
import hashlib
import hmac
import http.client
import json
import os
import shutil
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import time
import unittest
import zipfile
import zlib
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from PIL import Image, PngImagePlugin

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bundle_export as exporter

try:
    import bundle_validate
except ImportError:
    bundle_validate = None


class BundleExportTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.illustrations = self.root / "illustrations"
        self.illustrations.mkdir()
        self.catalog = self.root / "catalog.json"
        self.catalog.write_text(json.dumps({
            "format": "avian-visitors-trusted-taxonomy",
            "format_version": 1,
            "species": [{
                "scientific_name": "Turdus migratorius",
                "common_name": "American Robin",
            }],
        }), encoding="utf-8")
        self.labels = self.root / "labels.txt"
        self.labels.write_text("Corvus corax\nNoise\n", encoding="utf-8")
        self.common = self.root / "common.json"
        self.common.write_text(json.dumps({
            "Turdus migratorius": "Robin from labels",
            "Corvus corax": "Common Raven",
            "Noise": "Noise",
        }), encoding="utf-8")
        self.lock = self.root / "generation.lock"
        self.lock.touch(mode=0o600)
        self.lock.chmod(0o600)
        self._write_image(self.illustrations / "turdus-migratorius.png", 3)
        self._write_image(self.illustrations / "turdus-migratorius-2.png", 7)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    @staticmethod
    def _write_image(path: Path, seed: int, *, opaque: bool = False, metadata: bool = True) -> None:
        background = (41, 73, 109, 255 if opaque else 0)
        image = Image.new("RGBA", (72, 56), background)
        for x in range(7, 65):
            for y in range(6, 50):
                image.putpixel((x, y), (
                    (x * (seed + 3) + y) % 256,
                    (y * (seed + 5) + x) % 256,
                    (x * y + seed * 17) % 256,
                    255,
                ))
        info = PngImagePlugin.PngInfo()
        if metadata:
            info.add_text("Comment", "metadata must not survive canonicalization")
        image.save(path, format="PNG", pnginfo=info, compress_level=3)

    def _export(self, output: Path | None = None, **overrides: object) -> tuple[Path, dict]:
        output = output or self.root / "bundle.zip"
        values = {
            "illustrations": self.illustrations,
            "catalogs": [self.catalog],
            "labels": [self.labels],
            "common_names": self.common,
            "output": output,
            "generation_lock": self.lock,
        }
        values.update(overrides)
        return output, exporter.export_bundle(**values)

    def test_deterministic_strict_hosted_bundle(self) -> None:
        first, result = self._export(self.root / "first.zip")
        second, second_result = self._export(self.root / "second.zip")
        self.assertEqual(first.read_bytes(), second.read_bytes())
        self.assertEqual(result["id"], second_result["id"])
        self.assertRegex(result["id"], r"^local-station-[0-9a-f]{32}$")
        self.assertEqual(result["version"], "1.0.0")
        if bundle_validate is not None:
            checked = bundle_validate.validate_archive(first, producer_contract=True)
            self.assertEqual((checked["species"], checked["objects"]), (1, 2))
            self.assertEqual(checked["archive_sha256"], result["archive_sha256"])
        with zipfile.ZipFile(first) as archive:
            names = archive.namelist()
            manifest = json.loads(archive.read("manifest.json"))
            self.assertEqual(names, [
                "illustrations/turdus-migratorius-2.png",
                "illustrations/turdus-migratorius.png",
                exporter.LICENSE_FILE,
                "manifest.json",
            ])
            for info in archive.infolist():
                self.assertEqual(info.date_time, exporter.ZIP_TIMESTAMP)
                self.assertEqual(info.compress_type, zipfile.ZIP_STORED)
                self.assertEqual(stat.S_IMODE(info.external_attr >> 16), 0o644)
                self.assertFalse(info.extra)
                self.assertFalse(info.comment)
            canonical = archive.read("illustrations/turdus-migratorius.png")
        self.assertEqual(manifest["style"], {
            "id": "japanese-woodblock", "name": "Japanese Woodblock",
        })
        self.assertEqual(manifest["name"], "Japanese Woodblock - Local Station")
        self.assertEqual(manifest["coverage"], {
            "type": "selection",
            "label": "Local station illustration library",
            "region_codes": [],
        })
        self.assertEqual(manifest["license"]["spdx"], "CC-BY-NC-SA-4.0")
        self.assertEqual(manifest["attribution"]["creator"], "Avian Visitors and station owner")
        self.assertEqual(manifest["provenance"], {
            "method": "mixed",
            "model": "mixed historical and local image-generation models",
            "review": "contributor-reviewed",
        })
        self.assertEqual(manifest["species"][0]["common_name"], "American Robin")
        self.assertNotIn(b"Comment", canonical)
        with Image.open(__import__("io").BytesIO(canonical)) as image:
            self.assertEqual(image.mode, "RGBA")
            pixels = image.load()
            self.assertTrue(all(
                not (pixels[x, y][0] or pixels[x, y][1] or pixels[x, y][2])
                for y in range(image.height) for x in range(image.width)
                if pixels[x, y][3] == 0
            ))

    def test_exports_all_top_level_art_and_ignores_raw_and_metadata(self) -> None:
        self._write_image(self.illustrations / "corvus-corax.png", 11)
        raw = self.illustrations / "raw"
        raw.mkdir()
        self._write_image(raw / "secret-bird.png", 13)
        (self.illustrations / "dims.json").write_text("{}", encoding="utf-8")
        (self.illustrations / ".ignored").write_text("ignore", encoding="utf-8")
        output, result = self._export()
        self.assertEqual((result["species"], result["objects"]), (2, 3))
        with zipfile.ZipFile(output) as archive:
            self.assertFalse(any("raw/" in name for name in archive.namelist()))
            manifest = json.loads(archive.read("manifest.json"))
        raven = next(bird for bird in manifest["species"] if bird["scientific_name"] == "Corvus corax")
        self.assertEqual(raven["common_name"], "Common Raven")

    def test_catalog_precedes_labels_and_no_name_is_inferred(self) -> None:
        mapping = exporter.load_taxonomy([self.catalog], [self.labels], self.common)
        self.assertEqual(mapping["turdus-migratorius"], ("Turdus migratorius", "American Robin"))
        self.assertEqual(mapping["corvus-corax"], ("Corvus corax", "Common Raven"))
        self._write_image(self.illustrations / "made-up-bird.png", 17)
        with self.assertRaisesRegex(exporter.ExportError, "no trusted taxonomy"):
            self._export()

    def test_rejects_catalog_slug_collision(self) -> None:
        self.catalog.write_text(json.dumps({
            "format": "avian-visitors-trusted-taxonomy",
            "format_version": 1,
            "species": ["Foo-bar baz", "Foo bar-baz"],
        }), encoding="utf-8")
        with self.assertRaisesRegex(exporter.ExportError, "multiple species"):
            exporter.load_taxonomy([self.catalog], [], None)

    def test_rejects_noncanonical_case_colliding_filename(self) -> None:
        self._write_image(self.illustrations / "Corvus-Corax.PNG", 19)
        with self.assertRaisesRegex(exporter.ExportError, "filename is not canonical"):
            self._export()

    @unittest.skipUnless(hasattr(os, "symlink"), "symlinks unavailable")
    def test_rejects_source_and_output_symlinks(self) -> None:
        source = self.illustrations / "turdus-migratorius.png"
        real = self.root / "real.png"
        source.replace(real)
        source.symlink_to(real)
        with self.assertRaisesRegex(exporter.ExportError, "regular non-symlink"):
            self._export()
        source.unlink()
        real.replace(source)
        victim = self.root / "victim"
        victim.write_bytes(b"keep")
        output = self.root / "bundle.zip"
        output.symlink_to(victim)
        with self.assertRaisesRegex(exporter.ExportError, "regular non-symlink"):
            self._export(output)
        self.assertEqual(victim.read_bytes(), b"keep")

    def test_rejects_duplicate_canonical_pixels(self) -> None:
        shutil.copyfile(
            self.illustrations / "turdus-migratorius.png",
            self.illustrations / "corvus-corax.png",
        )
        with self.assertRaisesRegex(exporter.ExportError, "identical after canonicalization"):
            self._export()

    def test_rejects_opaque_image(self) -> None:
        self._write_image(self.illustrations / "turdus-migratorius.png", 3, opaque=True)
        with self.assertRaisesRegex(exporter.ExportError, "transparent and visible"):
            self._export()

    @staticmethod
    def _replace_ihdr_width(data: bytes, width: int) -> bytes:
        payload = struct.pack(">I", width) + data[20:29]
        return data[:16] + payload + struct.pack(">I", zlib.crc32(b"IHDR" + payload) & 0xFFFFFFFF) + data[33:]

    @staticmethod
    def _replace_ihdr_dimensions(data: bytes, width: int, height: int) -> bytes:
        payload = struct.pack(">II", width, height) + data[24:29]
        crc = struct.pack(">I", zlib.crc32(b"IHDR" + payload) & 0xFFFFFFFF)
        return data[:16] + payload + crc + data[33:]

    @staticmethod
    def _insert_chunk(data: bytes, kind: bytes, payload: bytes) -> bytes:
        chunk = struct.pack(">I", len(payload)) + kind + payload
        chunk += struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
        return data[:33] + chunk + data[33:]

    def test_preflight_rejects_dimension_bomb_before_decode(self) -> None:
        path = self.illustrations / "turdus-migratorius.png"
        path.write_bytes(self._replace_ihdr_width(path.read_bytes(), exporter.MAX_IMAGE_SIDE + 1))
        (self.illustrations / "turdus-migratorius-2.png").unlink()
        with mock.patch("PIL.Image.open", side_effect=AssertionError("decoder must not run")):
            with self.assertRaisesRegex(exporter.ExportError, "dimensions exceed"):
                self._export()

    def test_preflight_rejects_over_four_megapixels_before_decode(self) -> None:
        path = self.illustrations / "turdus-migratorius.png"
        path.write_bytes(self._replace_ihdr_dimensions(path.read_bytes(), 2001, 2000))
        (self.illustrations / "turdus-migratorius-2.png").unlink()
        with mock.patch("PIL.Image.open", side_effect=AssertionError("decoder must not run")):
            with self.assertRaisesRegex(exporter.ExportError, "dimensions exceed"):
                self._export()

    def test_four_megapixel_canonicalization_has_pi_safe_peak_rss(self) -> None:
        large = self.root / "large.png"
        image = Image.new("RGBA", (2000, 2000), (91, 73, 51, 0))
        image.paste((31, 97, 173, 255), (250, 250, 1750, 1750))
        image.save(large, format="PNG", compress_level=9)
        image.close()
        code = (
            "import json,re,resource,sys; from pathlib import Path; "
            f"sys.path.insert(0,{str(Path(exporter.__file__).resolve().parent)!r}); "
            "import bundle_export as e; "
            "encoded,w,h=e.canonical_png(Path(sys.argv[1]).read_bytes(),'large.png'); "
            "rss=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss; "
            "peak=rss if sys.platform=='darwin' else rss*1024; "
            # Linux getrusage can retain the parent's pre-exec high-water mark.
            "\nif sys.platform.startswith('linux'):\n"
            " match=re.search(r'^VmHWM:\\s+(\\d+) kB$',Path('/proc/self/status').read_text(),re.M)\n"
            " assert match, 'missing Linux peak RSS'\n"
            " peak=int(match.group(1))*1024\n"
            "print(json.dumps({'peak_bytes':peak,'bytes':len(encoded),'width':w,'height':h}))"
        )
        process = subprocess.run(
            [sys.executable, "-c", code, str(large)],
            check=False, capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(process.returncode, 0, process.stderr)
        result = json.loads(process.stdout)
        self.assertEqual((result["width"], result["height"]), (2000, 2000))
        self.assertLess(result["peak_bytes"], 192 * 1024 * 1024)

    def test_preflight_rejects_animation_bad_crc_and_polyglot_tail(self) -> None:
        original = (self.illustrations / "turdus-migratorius.png").read_bytes()
        cases = [
            (self._insert_chunk(original, b"acTL", struct.pack(">II", 1, 0)), "animated"),
            (original[:-5] + bytes([original[-5] ^ 1]) + original[-4:], "checksum"),
            (original + b"payload", "trailing"),
        ]
        for data, message in cases:
            with self.subTest(message=message):
                path = self.illustrations / "turdus-migratorius.png"
                path.write_bytes(data)
                with self.assertRaisesRegex(exporter.ExportError, message):
                    self._export()
                path.write_bytes(original)

    def test_busy_or_unsafe_generation_lock_fails_without_stage(self) -> None:
        with self.lock.open("rb") as handle:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(exporter.ExportError, "generation is running"):
                self._export()
        self.assertFalse((self.root / "bundle.zip").exists())
        self.assertEqual(list(self.root.glob(".bundle.zip.*.tmp")), [])
        self.lock.chmod(0o644)
        with self.assertRaisesRegex(exporter.ExportError, "lock is unsafe"):
            self._export()

    def test_tiny_sources_still_reserve_full_archive_headroom(self) -> None:
        just_short = exporter.MAX_ARCHIVE_BYTES + exporter.FREE_SPACE_FLOOR - 1
        with mock.patch.object(
            exporter.shutil, "disk_usage", return_value=SimpleNamespace(free=just_short)
        ):
            with self.assertRaisesRegex(exporter.ExportError, "free disk space"):
                self._export()
        self.assertEqual(list(self.root.glob(".bundle.zip.*.tmp")), [])

    def test_export_ceiling_and_disk_reserve_match_768_mib(self) -> None:
        self.assertEqual(exporter.MAX_ARCHIVE_BYTES, 768 * 1024 * 1024)
        self.assertEqual(exporter.MAX_IMAGE_PIXELS, 4_000_000)
        self.assertEqual(exporter.MAX_OBJECT_BYTES, 4 * 1024 * 1024)
        self.assertEqual(exporter.MAX_EXPANDED_BYTES, 640 * 1024 * 1024)
        required = 768 * 1024 * 1024 + exporter.FREE_SPACE_FLOOR
        for available in (required - 1, required):
            with mock.patch.object(exporter.shutil, "disk_usage", return_value=SimpleNamespace(free=available)):
                if available < required:
                    with self.assertRaisesRegex(exporter.ExportError, "free disk space"):
                        exporter._ensure_disk_space(self.root)
                else:
                    exporter._ensure_disk_space(self.root)
        endpoint = (Path(__file__).resolve().parents[1] / "api/export.php").read_text()
        self.assertIn("$size > 768 * 1024 * 1024", endpoint)

    def test_inventory_accepts_1500_objects_but_not_1501(self) -> None:
        inventory = self.root / "capacity"
        inventory.mkdir()
        taxonomy = {}
        for ordinal in range(1500):
            slug = f"avis-species{ordinal // 2}"
            taxonomy[slug] = (f"Avis species{ordinal // 2}", None)
            (inventory / f"{slug}{'-2' if ordinal % 2 else ''}.png").write_bytes(b"png")
        descriptor = os.open(inventory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            sources, _, _ = exporter._source_inventory(descriptor, taxonomy)
            self.assertEqual(len(sources), 1500)
            taxonomy["avis-overflow"] = ("Avis overflow", None)
            (inventory / "avis-overflow.png").write_bytes(b"png")
            with self.assertRaisesRegex(exporter.ExportError, "hosted bundle limits"):
                exporter._source_inventory(descriptor, taxonomy)
        finally:
            os.close(descriptor)

    def test_enospc_preserves_output_and_cleans_private_stage(self) -> None:
        output = self.root / "bundle.zip"
        output.write_bytes(b"existing")
        failure = OSError(errno.ENOSPC, "synthetic disk full")
        with mock.patch.object(exporter.zipfile.ZipFile, "writestr", side_effect=failure):
            with self.assertRaises(OSError) as caught:
                self._export(output)
        self.assertEqual(caught.exception.errno, errno.ENOSPC)
        self.assertEqual(output.read_bytes(), b"existing")
        self.assertEqual(list(self.root.glob(".bundle.zip.*.tmp")), [])

    def test_atomic_validation_failure_preserves_output_and_cleans_stage(self) -> None:
        output = self.root / "bundle.zip"
        output.write_bytes(b"existing")
        with mock.patch.object(exporter, "_validate_archive", side_effect=exporter.ExportError("synthetic validation failure")):
            with self.assertRaisesRegex(exporter.ExportError, "synthetic"):
                self._export(output)
        self.assertEqual(output.read_bytes(), b"existing")
        self.assertEqual(list(self.root.glob(".bundle.zip.*.tmp")), [])

    def test_rejects_nonsticky_attacker_writable_output_parent(self) -> None:
        shared = self.root / "shared"
        shared.mkdir()
        shared.chmod(0o777)
        try:
            with self.assertRaisesRegex(exporter.ExportError, "unsafe local replacement"):
                self._export(shared / "bundle.zip")
        finally:
            shared.chmod(0o700)
        self.assertEqual(list(shared.iterdir()), [])

    def test_stage_path_replacement_preserves_output_and_victim(self) -> None:
        output = self.root / "bundle.zip"
        output.write_bytes(b"existing")
        victim = self.root / "victim"
        victim.write_bytes(b"must survive")
        original = exporter._validate_archive

        def replace_stage(raw, manifest, manifest_bytes, names):
            result = original(raw, manifest, manifest_bytes, names)
            stage, = self.root.glob(".bundle.zip.*.tmp")
            stage.unlink()
            stage.symlink_to(victim)
            return result

        with mock.patch.object(exporter, "_validate_archive", side_effect=replace_stage):
            with self.assertRaisesRegex(exporter.ExportError, "stage path changed"):
                self._export(output)
        self.assertEqual(output.read_bytes(), b"existing")
        self.assertEqual(victim.read_bytes(), b"must survive")
        self.assertEqual(list(self.root.glob(".bundle.zip.*.tmp")), [])

    def test_detects_source_mutation_before_atomic_publish(self) -> None:
        original = exporter.canonical_png
        mutated = False

        def mutate(data: bytes, name: str):
            nonlocal mutated
            value = original(data, name)
            if not mutated:
                mutated = True
                path = self.illustrations / "turdus-migratorius.png"
                path.write_bytes(path.read_bytes() + b"changed")
            return value

        with mock.patch.object(exporter, "canonical_png", side_effect=mutate):
            with self.assertRaisesRegex(exporter.ExportError, "changed (?:before it could be read|during export)"):
                self._export()
        self.assertFalse((self.root / "bundle.zip").exists())

    def test_output_cannot_replace_source_or_taxonomy(self) -> None:
        with self.assertRaisesRegex(exporter.ExportError, "outside the illustration"):
            self._export(self.illustrations / "export.zip")
        before = self.catalog.read_bytes()
        with self.assertRaisesRegex(exporter.ExportError, "taxonomy source"):
            self._export(self.catalog)
        self.assertEqual(self.catalog.read_bytes(), before)

    def test_source_entry_limit_counts_ignored_entries(self) -> None:
        (self.illustrations / "ignored-a").write_text("x", encoding="utf-8")
        with mock.patch.object(exporter, "MAX_SOURCE_ENTRIES", 2):
            with self.assertRaisesRegex(exporter.ExportError, "too many entries"):
                self._export()

    def test_cli_emits_one_bounded_json_result(self) -> None:
        output = self.root / "cli.zip"
        process = subprocess.run([
            sys.executable,
            str(Path(exporter.__file__)),
            "--illustrations", str(self.illustrations),
            "--catalog", str(self.catalog),
            "--label-file", str(self.labels),
            "--common-names", str(self.common),
            "--generation-lock", str(self.lock),
            "--output", str(output),
        ], check=False, capture_output=True, text=True, timeout=30)
        payload = json.loads(process.stdout)
        self.assertEqual(process.returncode, 0, process.stderr + process.stdout)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["objects"], 2)
        self.assertTrue(output.is_file())

    def test_checked_in_gap_mapping_has_all_shipped_non_birdnet_taxa(self) -> None:
        project = Path(__file__).resolve().parents[2]
        gap = project / "avian/scripts/bundle-taxonomy-v1.json"
        mapping = exporter.load_taxonomy([gap], [], None)
        self.assertEqual(set(mapping), {
            "gymnogyps-californianus",
            "leiothlypis-lucidae",
            "oreothlypis-ruficapilla",
            "urile-penicillatus",
        })

    def test_release_taxonomy_covers_all_333_shipped_artwork_species(self) -> None:
        catalogs = exporter._default_existing(exporter.DEFAULT_CATALOGS)
        labels = exporter._default_existing(exporter.DEFAULT_LABELS)
        common = exporter.DEFAULT_COMMON_NAMES if exporter.DEFAULT_COMMON_NAMES.exists() else None
        self.assertTrue(catalogs)
        self.assertFalse(any(".avian" in path.parts for path in catalogs))
        mapping = exporter.load_taxonomy(catalogs, labels, common)
        artwork_slugs = set()
        for path in exporter.DEFAULT_ILLUSTRATIONS.iterdir():
            if not path.is_file() or not exporter.SOURCE_NAME.fullmatch(path.name):
                continue
            stem = path.stem
            artwork_slugs.add(stem[:-2] if stem.endswith("-2") else stem)
        self.assertEqual(len(artwork_slugs), 333)
        self.assertEqual(artwork_slugs - set(mapping), set())

    def test_php_contract_is_full_admin_exact_uncached_and_separate(self) -> None:
        endpoint = (Path(__file__).resolve().parents[1] / "api/export.php").read_text(encoding="utf-8")
        branch = endpoint.index("if ($what === 'bundle')")
        branch_end = (endpoint.index("$requestedEducatorScope", branch)
                      if "$requestedEducatorScope" in endpoint
                      else endpoint.index("if ($what === 'detections')", branch))
        bundle_branch = endpoint[branch:branch_end]
        if "$requestedEducatorScope" in endpoint:
            self.assertIn("avian_require_admin();", endpoint[branch:branch + 200])
        else:
            self.assertIn("avian_require_admin();", endpoint[:branch])
        self.assertIn("!== 'what=bundle'", endpoint)
        self.assertIn("min(1800, $timeoutSeconds)", endpoint)
        self.assertIn("connection_aborted()", endpoint)
        self.assertIn("Cache-Control: no-store", endpoint)
        self.assertIn("Content-Security-Policy", endpoint)
        self.assertIn("avian_bundle_export_request_dir", endpoint)
        self.assertIn("/run/lock/avian-bundle-export.lock", endpoint)
        self.assertIn("LOCK_EX | LOCK_NB", endpoint)
        self.assertIn("$streamDeadline", endpoint)
        self.assertIn("$sent < $size", endpoint)
        self.assertNotIn("set_time_limit(0)", bundle_branch)
        self.assertLess(endpoint.index("@unlink($temporary)", branch), endpoint.index("header('Content-Type: application/zip')", branch))
        self.assertNotIn("--library", bundle_branch)
        if "$requestedEducatorScope" in endpoint:
            self.assertLess(branch, endpoint.index("$requestedEducatorScope"))
            self.assertLess(endpoint.index("educator_assert_no_maintenance_marker"), branch)

    def test_coordination_locks_are_reboot_durable_and_generation_is_shared(self) -> None:
        project = Path(__file__).resolve().parents[2]
        for relative in (
            "scripts/install_services.sh",
            "scripts/reinstall_services.sh",
            "scripts/security_refresh.sh",
        ):
            source = (project / relative).read_text(encoding="utf-8")
            self.assertIn("tmpfiles_dir=/etc/tmpfiles.d", source, relative)
            self.assertIn(
                "/etc/tmpfiles.d/avian-bundle-locks.conf",
                source.replace("$tmpfiles_dir", "/etc/tmpfiles.d"),
                relative,
            )
            self.assertIn("/run/lock/avian-generation.lock", source, relative)
            self.assertIn("/run/lock/avian-bundle-export.lock", source, relative)
            # Create-only metadata must not chmod/chown an existing inode at
            # boot. The real writers' inode/symlink behavior is exercised by
            # tests/smoke_coordination_policy.sh in an isolated root container.
            self.assertEqual(source.count(":0660 :root :%s -\\n"), 2, relative)
            self.assertIn("systemd-tmpfiles --create", source, relative)
            self.assertIn("%u:%g:%a:%h", source, relative)
        generate_php = (project / "avian/api/generate.php").read_text(encoding="utf-8")
        generate_worker = (project / "avian/scripts/generate_one.py").read_text(encoding="utf-8")
        self.assertIn("/run/lock/avian-generation.lock", generate_php)
        self.assertIn("AVIAN_GENERATION_LOCK", generate_php)
        self.assertIn("AVIAN_GENERATION_LOCK", generate_worker)
        self.assertIn("fcntl.LOCK_EX", generate_worker)

    def test_bundle_export_has_exact_dedicated_fpm_hard_deadline(self) -> None:
        project = Path(__file__).resolve().parents[2]
        security = (project / "scripts/security_refresh.sh").read_text(encoding="utf-8")
        caddy = (project / "scripts/update_caddyfile.sh").read_text(encoding="utf-8")
        endpoint = (project / "avian/api/export.php").read_text(encoding="utf-8")
        for expected in (
            "zz-avian-bundle-export.conf",
            "avian-bundle-export-${version}.sock",
            "pm = ondemand",
            "pm.max_children = 2",
            "pm.max_requests = 1",
            "request_terminate_timeout = 3700s",
            "request_terminate_timeout_track_finished = yes",
            "listen.mode = 0600",
        ):
            self.assertIn(expected, security)
        self.assertIn("php-fpm$version", security)
        self.assertIn('systemctl reload "$unit"', security)
        self.assertIn("vars {http.request.orig_uri.query} what=bundle", caddy)
        self.assertNotIn("query what=bundle", caddy)
        self.assertNotIn("vars_regexp", caddy)
        self.assertIn("handle /avian/api/export.php", caddy)
        self.assertIn("AVIAN_BUNDLE_EXPORT_POOL 1", caddy)
        self.assertIn("AVIAN_BUNDLE_EXPORT_POOL", endpoint)
        self.assertIn("PHP_SAPI === 'fpm-fcgi'", endpoint)
        self.assertIn("PATH_INFO", endpoint)
        self.assertIn("bundle export service is unavailable", endpoint)

    @unittest.skipUnless(shutil.which("php"), "PHP CLI unavailable")
    def test_main_php_endpoint_auth_headers_and_archive_contract(self) -> None:
        project = Path(__file__).resolve().parents[2]
        endpoint_source = (project / "avian/api/export.php").read_text(encoding="utf-8")
        if "educator-scope.php" in endpoint_source:
            self.skipTest("station endpoint requires provisioned admin-state integration tests")
        site = self.root / "site"
        for relative in (
            "avian/api/admin-auth.php",
            "avian/api/export.php",
            "avian/scripts/bundle_export.py",
            "avian/scripts/bundle-taxonomy-v1.json",
        ):
            source = project / relative
            destination = site / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)
        station_python = site / "birdnet/bin/python3"
        station_python.parent.mkdir(parents=True)
        station_python.symlink_to(Path(sys.executable).resolve())
        php_temp = self.root / "php-temp"
        php_temp.mkdir()
        request_lock = self.root / "bundle-export.lock"
        request_lock.touch(mode=0o600)
        request_lock.chmod(0o600)
        with socket.socket() as reservation:
            try:
                reservation.bind(("127.0.0.1", 0))
            except PermissionError:
                self.skipTest("loopback sockets are unavailable")
            port = reservation.getsockname()[1]
        environment = os.environ.copy()
        environment.update({
            "AV_REQUIRE_AUTH": "1",
            "AV_ADMIN_PASSWORD": "testpass",
            "AVIAN_EXPORT_ILLUSTRATIONS": str(self.illustrations),
            "AVIAN_EXPORT_CATALOG": str(self.catalog),
            "AVIAN_EXPORT_GENERATION_LOCK": str(self.lock),
            "AVIAN_EXPORT_REQUEST_LOCK": str(request_lock),
            "TMPDIR": str(php_temp),
        })
        server = subprocess.Popen(
            [shutil.which("php") or "php", "-S", f"127.0.0.1:{port}", "-t", str(site)],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            env=environment,
        )
        try:
            deadline = time.monotonic() + 5
            while True:
                if server.poll() is not None:
                    self.fail("PHP server stopped: " + ((server.stdout.read() if server.stdout else "")[-1000:]))
                try:
                    with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                        break
                except OSError:
                    if time.monotonic() >= deadline:
                        self.fail("PHP test server did not start")
                    time.sleep(0.02)

            def request(method: str, path: str, authorized: bool = False):
                connection = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
                headers = {}
                if authorized:
                    token = base64.b64encode(b"birdnet:testpass").decode("ascii")
                    headers["Authorization"] = "Basic " + token
                connection.request(method, path, headers=headers)
                response = connection.getresponse()
                status = response.status
                response_headers = {key.lower(): value for key, value in response.getheaders()}
                body = response.read()
                connection.close()
                return status, response_headers, body

            status, headers, _ = request("GET", "/avian/api/export.php?what=bundle")
            self.assertEqual(status, 401)
            self.assertEqual(headers.get("cache-control"), "no-store")
            with request_lock.open("rb") as held:
                fcntl.flock(held.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                status, _, body = request("GET", "/avian/api/export.php?what=bundle", True)
                self.assertEqual(status, 409, body[:500])
            status, headers, body = request("GET", "/avian/api/export.php?what=bundle", True)
            self.assertEqual(status, 200, body[:1000])
            self.assertEqual(headers.get("content-type"), "application/zip")
            self.assertEqual(headers.get("cache-control"), "no-store")
            self.assertEqual(headers.get("pragma"), "no-cache")
            self.assertEqual(headers.get("x-content-type-options"), "nosniff")
            self.assertEqual(int(headers.get("content-length", "-1")), len(body))
            downloaded = self.root / "endpoint.zip"
            downloaded.write_bytes(body)
            if bundle_validate is not None:
                bundle_validate.validate_archive(downloaded, producer_contract=True)
            status, headers, _ = request("POST", "/avian/api/export.php?what=bundle", True)
            self.assertEqual(status, 405)
            self.assertEqual(headers.get("allow"), "GET")
            status, _, _ = request("GET", "/avian/api/export.php?what=bundle&x=1", True)
            self.assertEqual(status, 400)
            time.sleep(0.05)
            self.assertEqual(list(php_temp.glob("avian-bundle-*")), [])
        finally:
            server.terminate()
            try:
                server.wait(timeout=3)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait(timeout=3)
            if server.stdout is not None:
                server.stdout.close()

    @unittest.skipUnless(shutil.which("php"), "PHP CLI unavailable")
    def test_station_php_endpoint_maintenance_auth_exact_query_and_zip(self) -> None:
        project = Path(__file__).resolve().parents[2]
        endpoint = project / "avian/api/export.php"
        if "educator-scope.php" not in endpoint.read_text(encoding="utf-8"):
            self.skipTest("main endpoint is covered by its HTTP integration test")

        site = self.root / "site"
        for relative in (
            "avian/api/export.php", "avian/api/admin-auth.php", "avian/api/admin-state.php",
            "avian/api/educator-scope.php", "avian/api/educator-state.php", "avian/api/educator-store.php",
            "avian/scripts/bundle_export.py", "avian/scripts/bundle-taxonomy-v1.json",
        ):
            destination = site / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(project / relative, destination)
        # Match the installed station layout, retaining this interpreter's Pillow.
        (site / "birdnet").symlink_to(sys.prefix, target_is_directory=True)
        endpoint = site / "avian/api/export.php"

        educator_lock = self.root / "educators.lock"
        educator_lock.touch(mode=0o600)
        educator_state = self.root / "educators.state"
        educator_state.write_text("v1\t0\t1\n", encoding="ascii")
        maintenance = self.root / "educators.maintenance"
        request_lock = self.root / "bundle-export.lock"
        request_lock.touch(mode=0o600)
        request_lock.chmod(0o600)
        admin_state = self.root / "admin.state"
        verifier = "$2y$14$" + "A" * 53
        admin_state.write_text(f"v1\t1\t1\t{verifier}\n", encoding="ascii")
        session_dir = self.root / "sessions"
        session_dir.mkdir()
        session_id = "a" * 32
        fingerprint = hmac.new(
            verifier.encode("ascii"),
            ("avian-admin-session-v4:1:1:" + session_id).encode("ascii"),
            hashlib.sha256,
        ).hexdigest()
        now = int(time.time())
        (session_dir / ("sess_" + session_id)).write_text(
            f'password_fingerprint|s:64:"{fingerprint}";created_at|i:{now};seen_at|i:{now};',
            encoding="ascii",
        )
        environment = os.environ.copy()
        environment.update({
            "AV_REQUIRE_AUTH": "1",
            "AV_ADMIN_STATE_FILE": str(admin_state),
            "AV_ADMIN_STATE_TEST_METADATA": "1",
            "AV_EDUCATOR_LOCK_FILE": str(educator_lock),
            "AV_EDUCATOR_STATE_FILE": str(educator_state),
            "AV_EDUCATOR_MAINTENANCE_FILE": str(maintenance),
            "AV_EDUCATOR_STORE_TEST_METADATA": "1",
            "AV_EDUCATOR_STATE_TEST_METADATA": "1",
            "AVIAN_EXPORT_ILLUSTRATIONS": str(self.illustrations),
            "AVIAN_EXPORT_CATALOG": str(self.catalog),
            "AVIAN_EXPORT_GENERATION_LOCK": str(self.lock),
            "AVIAN_EXPORT_REQUEST_LOCK": str(request_lock),
            "TMPDIR": str(self.root),
        })

        def invoke(query: str, get: dict[str, object], *, authorized: bool, method: str = "GET"):
            server = {
                "REQUEST_METHOD": method,
                "QUERY_STRING": query,
                "REMOTE_ADDR": "192.168.1.20",
                "HTTP_HOST": "birdnet.local",
            }
            cookies = {"avian_admin": session_id} if authorized else {}
            code = (
                "$_GET=json_decode(" + json.dumps(json.dumps(get)) + ",true);"
                + "$_SERVER=json_decode(" + json.dumps(json.dumps(server)) + ",true);"
                + "$_COOKIE=json_decode(" + json.dumps(json.dumps(cookies)) + ",true);"
                + 'register_shutdown_function(function(){fwrite(STDERR,"\\nSTATUS:".(http_response_code()?:200));});'
                + "include " + json.dumps(str(endpoint)) + ";"
            )
            process = subprocess.run(
                [
                    shutil.which("php") or "php",
                    "-d", "display_errors=0",
                    "-d", "session.save_path=" + str(session_dir),
                    "-r", code,
                ],
                check=False,
                capture_output=True,
                env=environment,
                timeout=30,
            )
            marker = __import__("re").search(rb"STATUS:(\d+)\s*$", process.stderr)
            return (int(marker.group(1)) if marker else 0), process.stdout, process.stderr

        status, body, _ = invoke("what=bundle", {"what": "bundle"}, authorized=False)
        self.assertEqual(status, 401, body[:500])
        maintenance.write_text("v1\tclear\n", encoding="ascii")
        status, body, _ = invoke("what=bundle", {"what": "bundle"}, authorized=True)
        self.assertEqual(status, 503, body[:500])
        maintenance.unlink()
        with request_lock.open("rb") as held:
            fcntl.flock(held.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            status, body, _ = invoke("what=bundle", {"what": "bundle"}, authorized=True)
            self.assertEqual(status, 409, body[:500])
        for query, get in (
            ("what=bundle&extra=1", {"what": "bundle", "extra": "1"}),
            ("what=bundle&edu=active", {"what": "bundle", "edu": "active"}),
            ("what=bundle&grant=" + "f" * 48, {"what": "bundle", "grant": "f" * 48}),
        ):
            status, body, _ = invoke(query, get, authorized=True)
            self.assertEqual(status, 400, (query, body[:500]))
        status, body, _ = invoke("what=bundle", {"what": "bundle"}, authorized=True, method="POST")
        self.assertEqual(status, 405, body[:500])
        status, body, error = invoke("what=bundle", {"what": "bundle"}, authorized=True)
        self.assertEqual(status, 200, error[-1000:] + body[:500])
        archive_path = self.root / "station-endpoint.zip"
        archive_path.write_bytes(body)
        with zipfile.ZipFile(archive_path) as archive:
            manifest_bytes = archive.read("manifest.json")
            manifest = json.loads(manifest_bytes)
            names = [name for name in archive.namelist() if name.startswith("illustrations/")]
        with archive_path.open("rb") as raw:
            checked = exporter._validate_archive(raw, manifest, manifest_bytes, names)
        self.assertEqual((checked["species"], checked["objects"]), (1, 2))
        self.assertEqual(list(self.root.glob("avian-bundle-*")), [])


if __name__ == "__main__":
    unittest.main()
