"""Adversarial unit and lifecycle coverage for the illustration bundle manager."""

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from io import BytesIO, StringIO
from pathlib import Path
from unittest import mock

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
MANAGER_PATH = ROOT / "avian" / "scripts" / "bundle_manager.py"
SPEC = importlib.util.spec_from_file_location("avian_bundle_manager", MANAGER_PATH)
assert SPEC is not None and SPEC.loader is not None
bundle_manager = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bundle_manager)


def png_bytes(color: tuple[int, int, int, int]) -> bytes:
    """Return a small, static PNG with both visible art and transparency."""
    image = Image.new("RGBA", (4, 3), (0, 0, 0, 0))
    image.putpixel((1, 1), color)
    image.putpixel((2, 1), color)
    output = BytesIO()
    image.save(output, format="PNG", optimize=False)
    return output.getvalue()


class BundleCliBoundaryTests(unittest.TestCase):
    def run_use(self, environment: dict[str, str], effective_uid: int) -> tuple[int, str]:
        arguments = ["avian-bundle-control", "use", "qa-bundle"]
        with mock.patch.object(sys, "argv", arguments), mock.patch.dict(
            os.environ, environment, clear=True
        ), mock.patch.object(
            bundle_manager.os, "geteuid", return_value=effective_uid
        ), mock.patch(
            "sys.stderr", new_callable=StringIO
        ) as stderr:
            result = bundle_manager.main()
        return result, stderr.getvalue()

    def test_web_process_cannot_reach_the_human_use_command_through_sudo(self) -> None:
        result, error = self.run_use({"SUDO_USER": "caddy"}, 0)
        self.assertEqual(result, 1)
        self.assertIn("not available to the web process", error)

    def test_sudo_use_rejects_bundle_path_environment_overrides(self) -> None:
        result, error = self.run_use(
            {
                "SUDO_USER": "birdnet",
                "AVIAN_BUNDLE_CATALOG": "/tmp/untrusted-catalog.json",
            },
            0,
        )
        self.assertEqual(result, 1)
        self.assertIn("path overrides are not allowed", error)

    def test_use_requires_the_installed_root_boundary(self) -> None:
        result, error = self.run_use({}, 501)
        self.assertEqual(result, 1)
        self.assertIn("run this command with sudo", error)


def sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


class BundleFixture:
    pack_id = "community-test-birds"
    version = "1.2.3"
    scientific_name = "Corvus brachyrhynchos"

    def __init__(self) -> None:
        self.images = {
            "perched": png_bytes((20, 30, 40, 255)),
            "flight": png_bytes((80, 90, 100, 255)),
        }
        poses = []
        for pose, raw in self.images.items():
            poses.append(
                {
                    "id": pose,
                    "file": bundle_manager.pose_path(self.scientific_name, pose),
                    "sha256": sha256(raw),
                    "bytes": len(raw),
                }
            )
        self.manifest = {
            "format": bundle_manager.FORMAT_MANIFEST,
            "format_version": bundle_manager.FORMAT_VERSION,
            "id": self.pack_id,
            "version": self.version,
            "name": "Community Test Birds",
            "description": "A tiny validation fixture.",
            "style": {"id": "test-ink", "name": "Test Ink"},
            "coverage": {
                "type": "region",
                "label": "California",
                "region_codes": ["US-CA"],
            },
            "species": [
                {
                    "scientific_name": self.scientific_name,
                    "common_name": "American Crow",
                    "poses": poses,
                }
            ],
            "license": {"spdx": "CC-BY-4.0"},
            "attribution": {
                "creator": "Test Contributor",
                "source_url": "https://github.com/avian-visitors/test-bundle",
            },
            "provenance": {
                "method": "manual",
                "review": "contributor-reviewed",
            },
        }
        self.manifest_raw = bundle_manager.canonical_json(self.manifest)
        self.manifest_hash = sha256(self.manifest_raw)
        preview_pose = poses[0]
        self.pack = {
            "id": self.pack_id,
            "version": self.version,
            "name": "Community Test Birds",
            "description": "A tiny validation fixture.",
            "creator": "Test Contributor",
            "repository_url": "https://github.com/avian-visitors/test-bundle",
            "coverage": {
                "label": "California",
                "group": "western-north-america",
                "region_codes": ["US-CA"],
            },
            "style": {
                "id": "test-ink",
                "name": "Test Ink",
                "category": "illustrated",
                "tags": ["ink", "test"],
            },
            "species_count": 1,
            "species": [self.scientific_name],
            "review": "community",
            "availability": "installable",
            "manifest": {
                "url": (
                    "https://avianvisitors.com/api/bundles/manifests/"
                    f"{self.manifest_hash}.json"
                ),
                "sha256": self.manifest_hash,
                "bytes": len(self.manifest_raw),
            },
            "archive_bytes": sum(len(raw) for raw in self.images.values()),
            "previews": [
                {
                    "scientific_name": self.scientific_name,
                    "common_name": "American Crow",
                    "pose": "perched",
                    "sha256": preview_pose["sha256"],
                    "bytes": preview_pose["bytes"],
                }
            ],
            "license": "CC-BY-4.0",
            "search_terms": ["crow"],
        }
        self.catalog = {
            "format": bundle_manager.FORMAT_CATALOG,
            "format_version": bundle_manager.FORMAT_VERSION,
            "updated": "2026-09-01",
            "object_base_url": "https://avianvisitors.com/api/bundles/objects/",
            "packs": [self.pack],
        }

    def publish(self, root: Path) -> None:
        manifest_path = root / "manifests" / f"{self.manifest_hash}.json"
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        manifest_path.write_bytes(self.manifest_raw)
        for raw in self.images.values():
            digest = sha256(raw)
            object_path = root / "objects" / "sha256" / digest[:2] / f"{digest}.png"
            object_path.parent.mkdir(parents=True, exist_ok=True)
            object_path.write_bytes(raw)


class BundleValidationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = BundleFixture()

    def assert_bundle_error(self, code: str, callback) -> None:
        with self.assertRaises(bundle_manager.BundleError) as raised:
            callback()
        self.assertEqual(raised.exception.code, code)

    def test_semver_accepts_valid_forms_and_rejects_ambiguous_ones(self) -> None:
        for value in ("0.0.0", "1.2.3", "1.2.3-alpha.1", "1.2.3+build.7"):
            with self.subTest(valid=value):
                self.assertEqual(bundle_manager.checked_version(value), value)
        for value in (
            "01.2.3",
            "1.02.3",
            "1.2.03",
            "1.1٠.0",
            "1.2",
            "v1.2.3",
            "1.2.3-01",
            "1.2.3-alpha.01",
            "1.2.3-",
            "1.2.3+",
        ):
            with self.subTest(invalid=value):
                self.assert_bundle_error(
                    "invalid_version", lambda value=value: bundle_manager.checked_version(value)
                )

    def test_semver_precedence_is_numeric_and_ignores_build_metadata(self) -> None:
        precedence = bundle_manager.semver_precedence
        self.assertLess(precedence("1.2.0"), precedence("1.10.0"))
        self.assertLess(precedence("2.0.0-alpha"), precedence("2.0.0-alpha.1"))
        self.assertLess(precedence("2.0.0-alpha.1"), precedence("2.0.0-alpha.beta"))
        self.assertLess(precedence("2.0.0-rc.1"), precedence("2.0.0"))
        self.assertEqual(precedence("2.0.0+build.1"), precedence("2.0.0+build.2"))

    def test_best_installed_version_uses_semver_then_ascii_tie_break(self) -> None:
        records = [
            {"reference": {"id": "test-pack", "version": version}}
            for version in (
                "1.9.0",
                "1.10.0-alpha.9",
                "1.10.0+build.10",
                "1.10.0+build.2",
            )
        ]
        with mock.patch.object(bundle_manager, "installed_records", return_value=records):
            selected = bundle_manager.current_install("test-pack")
            exact = bundle_manager.current_install("test-pack", "1.9.0")
        assert selected is not None and exact is not None
        self.assertEqual(selected["reference"]["version"], "1.10.0+build.2")
        self.assertEqual(exact["reference"]["version"], "1.9.0")

    def test_manifest_is_normalized_and_verifies_against_catalog(self) -> None:
        manifest = bundle_manager.validate_manifest(copy.deepcopy(self.fixture.manifest))
        catalog = bundle_manager.validate_catalog(copy.deepcopy(self.fixture.catalog))
        self.assertEqual(manifest["species_count"], 1)
        self.assertEqual(manifest["pose_count"], 2)
        self.assertEqual(manifest["total_bytes"], self.fixture.pack["archive_bytes"])
        bundle_manager.verify_catalog_manifest(
            catalog["packs"][0], manifest, self.fixture.manifest_hash
        )

    def test_hosted_contract_does_not_replace_station_manifest_api(self) -> None:
        self.assertEqual(bundle_manager.validate_manifest.__code__.co_argcount, 1)
        manifest = bundle_manager.validate_manifest(copy.deepcopy(self.fixture.manifest))
        self.assertIsInstance(manifest, dict)
        self.assertEqual(manifest["id"], self.fixture.pack_id)
        self.assertEqual(manifest["pose_count"], 2)

    def test_manifest_and_catalog_accept_the_exact_qa_license_file_shape(self) -> None:
        value = copy.deepcopy(self.fixture.manifest)
        value["license"] = {
            "file": "LICENSES/CC-BY-NC-SA-4.0.txt",
            "spdx": "CC-BY-NC-SA-4.0",
        }
        manifest_raw = bundle_manager.canonical_json(value)
        manifest_hash = sha256(manifest_raw)
        catalog = copy.deepcopy(self.fixture.catalog)
        catalog["packs"][0]["license"] = "CC-BY-NC-SA-4.0"
        catalog["packs"][0]["manifest"] = {
            "url": (
                "https://avianvisitors.com/api/bundles/manifests/"
                f"{manifest_hash}.json"
            ),
            "sha256": manifest_hash,
            "bytes": len(manifest_raw),
        }

        manifest = bundle_manager.validate_manifest(value)
        pack = bundle_manager.validate_catalog(catalog)["packs"][0]

        self.assertEqual(manifest["license"], {"spdx": "CC-BY-NC-SA-4.0"})
        bundle_manager.verify_catalog_manifest(pack, manifest, manifest_hash)

    def test_use_selector_accepts_id_or_exact_current_install_manifest(self) -> None:
        catalog = bundle_manager.validate_catalog(copy.deepcopy(self.fixture.catalog))
        by_id = bundle_manager.resolve_use_selector(catalog, self.fixture.pack_id)
        by_url = bundle_manager.resolve_use_selector(
            catalog, self.fixture.pack["manifest"]["url"]
        )
        self.assertEqual(by_id["manifest"]["sha256"], self.fixture.manifest_hash)
        self.assertEqual(by_url, by_id)

    def test_use_selector_rejects_discovery_aliases_and_url_variants(self) -> None:
        catalog = bundle_manager.validate_catalog(copy.deepcopy(self.fixture.catalog))
        rejected = (
            # These are real public-discovery artifacts, deliberately distinct
            # from the official station-install payloads.
            "https://avianvisitors.com/api/bundles/manifests/"
            "31fcb450f517acb2ea26b1c559cc3aad1696f583587209bd2a43058d8e6803e1.json",
            "https://avianvisitors.com/api/bundles/manifests/"
            "9d071dba2ef81084d483374a13c852785faa64898b9db461e7b28abb4c7d426b.json",
            self.fixture.pack["manifest"]["url"] + "?download=1",
            "https://example.com/api/bundles/manifests/" + self.fixture.manifest_hash + ".json",
            " " + self.fixture.pack_id,
        )
        for selector in rejected:
            with self.subTest(selector=selector):
                with self.assertRaises(bundle_manager.BundleError) as raised:
                    bundle_manager.resolve_use_selector(catalog, selector)
                self.assertIn(raised.exception.code, {"invalid_selector", "invalid_url", "unknown_bundle"})

    def test_manifest_strips_published_license_member_metadata_without_interpreting_its_path(self) -> None:
        for license_file in (
            "manifest.json",
            "README.md",
            "illustrations/calidris-alba.png",
            "LICENSES/CC-BY-NC-SA-4.0.txt",
        ):
            value = copy.deepcopy(self.fixture.manifest)
            value["license"]["file"] = license_file
            with self.subTest(license_file=license_file):
                self.assertEqual(
                    bundle_manager.validate_manifest(value)["license"],
                    {"spdx": "CC-BY-4.0"},
                )

    def test_manifest_normalizes_empty_license_file_markers_as_absent(self) -> None:
        for license_file in (None, "", False, 0, 0.0, [], {}):
            value = copy.deepcopy(self.fixture.manifest)
            value["license"]["file"] = license_file
            with self.subTest(license_file=license_file):
                self.assertEqual(
                    bundle_manager.validate_manifest(value)["license"],
                    {"spdx": "CC-BY-4.0"},
                )

    def test_manifest_license_requires_spdx_and_rejects_truthy_non_text_or_extra_fields(self) -> None:
        cases = []
        missing_spdx = copy.deepcopy(self.fixture.manifest)
        missing_spdx["license"] = {"file": "LICENSES/CC-BY-4.0.txt"}
        cases.append(("missing SPDX", missing_spdx, "invalid_fields"))
        extra_key = copy.deepcopy(self.fixture.manifest)
        extra_key["license"]["url"] = "https://attacker.example/license.txt"
        cases.append(("extra URL", extra_key, "invalid_fields"))
        for number, license_file in enumerate(
            (
                True,
                1,
                ["LICENSES/license.txt"],
                {"path": "LICENSES/license.txt"},
            )
        ):
            invalid_file = copy.deepcopy(self.fixture.manifest)
            invalid_file["license"]["file"] = license_file
            cases.append((f"invalid file {number}", invalid_file, "invalid_license"))

        for name, value, code in cases:
            with self.subTest(name=name):
                self.assert_bundle_error(
                    code, lambda value=value: bundle_manager.validate_manifest(value)
                )

    def test_manifest_normalizes_optional_description_and_empty_source_variants(self) -> None:
        for source_variant in (None, "", mock.sentinel.missing):
            value = copy.deepcopy(self.fixture.manifest)
            del value["description"]
            if source_variant is mock.sentinel.missing:
                del value["attribution"]["source_url"]
            else:
                value["attribution"]["source_url"] = source_variant
            manifest_raw = bundle_manager.canonical_json(value)
            manifest_hash = sha256(manifest_raw)
            catalog = copy.deepcopy(self.fixture.catalog)
            catalog["packs"][0]["description"] = bundle_manager.DEFAULT_COMMUNITY_DESCRIPTION
            catalog["packs"][0]["manifest"] = {
                "url": (
                    "https://avianvisitors.com/api/bundles/manifests/"
                    f"{manifest_hash}.json"
                ),
                "sha256": manifest_hash,
                "bytes": len(manifest_raw),
            }

            with self.subTest(source_variant=source_variant):
                manifest = bundle_manager.validate_manifest(value)
                pack = bundle_manager.validate_catalog(catalog)["packs"][0]
                self.assertEqual(manifest["description"], bundle_manager.DEFAULT_COMMUNITY_DESCRIPTION)
                self.assertEqual(manifest["attribution"]["source_url"], "")
                bundle_manager.verify_catalog_manifest(pack, manifest, manifest_hash)

    def test_manifest_and_catalog_normalize_whitespace_only_optional_text(self) -> None:
        value = copy.deepcopy(self.fixture.manifest)
        value["description"] = "   "
        value["species"][0]["common_name"] = "  \u2003  "
        manifest_raw = bundle_manager.canonical_json(value)
        manifest_hash = sha256(manifest_raw)
        catalog = copy.deepcopy(self.fixture.catalog)
        catalog["packs"][0]["description"] = value["description"]
        catalog["packs"][0]["previews"][0]["common_name"] = value["species"][0]["common_name"]
        catalog["packs"][0]["manifest"] = {
            "url": (
                "https://avianvisitors.com/api/bundles/manifests/"
                f"{manifest_hash}.json"
            ),
            "sha256": manifest_hash,
            "bytes": len(manifest_raw),
        }

        manifest = bundle_manager.validate_manifest(value)
        pack = bundle_manager.validate_catalog(catalog)["packs"][0]

        self.assertEqual(manifest["description"], "")
        self.assertEqual(manifest["species"][0]["common_name"], "")
        self.assertEqual(pack["description"], "")
        self.assertEqual(pack["previews"][0]["common_name"], "")
        bundle_manager.verify_catalog_manifest(pack, manifest, manifest_hash)

    def test_explicit_null_optional_public_text_is_not_an_omission(self) -> None:
        cases = []
        manifest_description = copy.deepcopy(self.fixture.manifest)
        manifest_description["description"] = None
        cases.append(
            ("manifest description", lambda: bundle_manager.validate_manifest(manifest_description))
        )
        manifest_common_name = copy.deepcopy(self.fixture.manifest)
        manifest_common_name["species"][0]["common_name"] = None
        cases.append(
            ("manifest common name", lambda: bundle_manager.validate_manifest(manifest_common_name))
        )
        catalog_description = copy.deepcopy(self.fixture.catalog)
        catalog_description["packs"][0]["description"] = None
        cases.append(
            ("catalog description", lambda: bundle_manager.validate_catalog(catalog_description))
        )
        catalog_common_name = copy.deepcopy(self.fixture.catalog)
        catalog_common_name["packs"][0]["previews"][0]["common_name"] = None
        cases.append(
            ("catalog common name", lambda: bundle_manager.validate_catalog(catalog_common_name))
        )
        for name, callback in cases:
            with self.subTest(name=name):
                self.assert_bundle_error("invalid_text", callback)

    def test_manifest_and_catalog_accept_delete_only_in_inert_public_text(self) -> None:
        value = copy.deepcopy(self.fixture.manifest)
        value["description"] = "Public\x7fdescription"
        value["species"][0]["common_name"] = "Crow\x7fname"
        manifest_raw = bundle_manager.canonical_json(value)
        manifest_hash = sha256(manifest_raw)
        catalog = copy.deepcopy(self.fixture.catalog)
        catalog["packs"][0]["description"] = value["description"]
        catalog["packs"][0]["previews"][0]["common_name"] = value["species"][0]["common_name"]
        catalog["packs"][0]["manifest"] = {
            "url": (
                "https://avianvisitors.com/api/bundles/manifests/"
                f"{manifest_hash}.json"
            ),
            "sha256": manifest_hash,
            "bytes": len(manifest_raw),
        }

        manifest = bundle_manager.validate_manifest(value)
        pack = bundle_manager.validate_catalog(catalog)["packs"][0]

        self.assertEqual(manifest["description"], value["description"])
        self.assertEqual(manifest["species"][0]["common_name"], value["species"][0]["common_name"])
        self.assertEqual(pack["description"], value["description"])
        self.assertEqual(pack["previews"][0]["common_name"], value["species"][0]["common_name"])
        bundle_manager.verify_catalog_manifest(pack, manifest, manifest_hash)

        claimed = copy.deepcopy(self.fixture.manifest)
        claimed["name"] = "Claimed\x7fname"
        self.assert_bundle_error(
            "invalid_text", lambda: bundle_manager.validate_manifest(claimed)
        )

    def test_manifest_allows_a_missing_optional_common_name(self) -> None:
        value = copy.deepcopy(self.fixture.manifest)
        del value["species"][0]["common_name"]
        manifest = bundle_manager.validate_manifest(value)
        self.assertEqual(manifest["species"][0]["common_name"], "")

    def test_manifest_catalog_and_preview_accept_the_full_scientific_name_grammar(self) -> None:
        scientific_name = "A" + "a" * 39 + " " + "b" * 40 + " " + "c" * 40 + " " + "d" * 40
        self.assertEqual(len(scientific_name), bundle_manager.SCI_NAME_MAX)
        value = copy.deepcopy(self.fixture.manifest)
        value["species"][0]["scientific_name"] = scientific_name
        for pose in value["species"][0]["poses"]:
            pose["file"] = bundle_manager.pose_path(scientific_name, pose["id"])
        manifest_raw = bundle_manager.canonical_json(value)
        manifest_hash = sha256(manifest_raw)
        catalog = copy.deepcopy(self.fixture.catalog)
        catalog["packs"][0]["species"] = [scientific_name]
        catalog["packs"][0]["manifest"] = {
            "url": (
                "https://avianvisitors.com/api/bundles/manifests/"
                f"{manifest_hash}.json"
            ),
            "sha256": manifest_hash,
            "bytes": len(manifest_raw),
        }
        for preview in catalog["packs"][0]["previews"]:
            preview["scientific_name"] = scientific_name

        manifest = bundle_manager.validate_manifest(value)
        pack = bundle_manager.validate_catalog(catalog)["packs"][0]

        self.assertEqual(manifest["species"][0]["scientific_name"], scientific_name)
        self.assertEqual(pack["previews"][0]["scientific_name"], scientific_name)
        bundle_manager.verify_catalog_manifest(pack, manifest, manifest_hash)

    def test_manifest_uses_the_hosted_canonical_scientific_slug(self) -> None:
        scientific_name = "Branta- canadensis--"
        value = copy.deepcopy(self.fixture.manifest)
        value["species"][0]["scientific_name"] = scientific_name
        for pose in value["species"][0]["poses"]:
            pose["file"] = (
                "illustrations/branta-canadensis"
                f"{'-2' if pose['id'] == 'flight' else ''}.png"
            )

        manifest = bundle_manager.validate_manifest(value)

        self.assertEqual(bundle_manager.scientific_slug(scientific_name), "branta-canadensis")
        self.assertEqual(
            [pose["file"] for pose in manifest["species"][0]["poses"]],
            [
                "illustrations/branta-canadensis.png",
                "illustrations/branta-canadensis-2.png",
            ],
        )

    def test_manifest_rejects_distinct_species_with_the_same_runtime_slug(self) -> None:
        value = copy.deepcopy(self.fixture.manifest)
        first = value["species"][0]
        first["scientific_name"] = "Foo bar-baz"
        for pose in first["poses"]:
            pose["file"] = bundle_manager.pose_path(first["scientific_name"], pose["id"])
        second = copy.deepcopy(first)
        second["scientific_name"] = "Foo bar baz"
        value["species"].append(second)
        self.assert_bundle_error(
            "invalid_species", lambda: bundle_manager.validate_manifest(value)
        )

    def test_selection_catalog_with_empty_region_codes_matches_its_manifest(self) -> None:
        value = copy.deepcopy(self.fixture.manifest)
        value["coverage"] = {
            "type": "selection",
            "label": "Personal selection",
        }
        manifest_raw = bundle_manager.canonical_json(value)
        manifest_hash = sha256(manifest_raw)
        catalog = copy.deepcopy(self.fixture.catalog)
        catalog["packs"][0]["coverage"] = {
            "label": "Personal selection",
            "group": "other",
            "region_codes": [],
        }
        catalog["packs"][0]["manifest"] = {
            "url": (
                "https://avianvisitors.com/api/bundles/manifests/"
                f"{manifest_hash}.json"
            ),
            "sha256": manifest_hash,
            "bytes": len(manifest_raw),
        }

        manifest = bundle_manager.validate_manifest(value)
        pack = bundle_manager.validate_catalog(catalog)["packs"][0]

        self.assertEqual(manifest["coverage"]["type"], "selection")
        self.assertEqual(manifest["coverage"]["region_codes"], [])
        self.assertEqual(pack["coverage"]["region_codes"], [])
        bundle_manager.verify_catalog_manifest(pack, manifest, manifest_hash)

    def test_global_manifest_may_omit_region_codes_but_catalog_materializes_them(self) -> None:
        value = copy.deepcopy(self.fixture.manifest)
        value["coverage"] = {"type": "global", "label": "Worldwide"}
        manifest_raw = bundle_manager.canonical_json(value)
        manifest_hash = sha256(manifest_raw)
        catalog = copy.deepcopy(self.fixture.catalog)
        catalog["packs"][0]["coverage"] = {
            "label": "Worldwide",
            "group": "global",
            "region_codes": [],
        }
        catalog["packs"][0]["manifest"] = {
            "url": (
                "https://avianvisitors.com/api/bundles/manifests/"
                f"{manifest_hash}.json"
            ),
            "sha256": manifest_hash,
            "bytes": len(manifest_raw),
        }

        manifest = bundle_manager.validate_manifest(value)
        pack = bundle_manager.validate_catalog(catalog)["packs"][0]
        self.assertEqual(manifest["coverage"]["region_codes"], [])
        self.assertEqual(pack["coverage"]["region_codes"], [])
        bundle_manager.verify_catalog_manifest(pack, manifest, manifest_hash)

    def test_extreme_aspect_ratio_keeps_nonzero_runtime_dimensions(self) -> None:
        image = Image.new("RGBA", (1, bundle_manager.IMAGE_DIM_MAX), (0, 0, 0, 0))
        image.paste(
            (20, 30, 40, 255),
            (0, 0, 1, bundle_manager.IMAGE_DIM_MAX // 2),
        )
        output = BytesIO()
        image.save(output, format="PNG", optimize=False)

        dimensions, mask = bundle_manager.local_mask_geometry(output.getvalue(), "thin-bird")

        self.assertEqual(dimensions, [1, 560])
        self.assertGreaterEqual(mask["w"], 1)
        bundle_manager.checked_geometry({"dimensions": dimensions, "mask": mask})

    def test_uniformly_translucent_canvas_is_not_a_transparent_cutout(self) -> None:
        image = Image.new("RGBA", (4, 3), (20, 30, 40, 128))
        output = BytesIO()
        image.save(output, format="PNG", optimize=False)

        with self.assertRaises(bundle_manager.BundleError) as raised:
            bundle_manager.local_mask_geometry(output.getvalue(), "translucent-canvas")
        self.assertEqual(raised.exception.code, "invalid_alpha")

    def test_manifest_rejects_invalid_coverage_and_generated_provenance(self) -> None:
        cases = []
        regional_without_codes = copy.deepcopy(self.fixture.manifest)
        del regional_without_codes["coverage"]["region_codes"]
        cases.append(("region without codes", regional_without_codes, "invalid_coverage"))
        global_with_codes = copy.deepcopy(self.fixture.manifest)
        global_with_codes["coverage"]["type"] = "global"
        cases.append(("global with codes", global_with_codes, "invalid_coverage"))
        generated_without_model = copy.deepcopy(self.fixture.manifest)
        generated_without_model["provenance"] = {
            "method": "generated",
            "review": "contributor-reviewed",
        }
        cases.append(("generated without model", generated_without_model, "invalid_provenance"))
        mixed_without_model = copy.deepcopy(self.fixture.manifest)
        mixed_without_model["provenance"] = {
            "method": "mixed",
            "review": "human-reviewed",
        }
        cases.append(("mixed without model", mixed_without_model, "invalid_provenance"))
        for name, value, code in cases:
            with self.subTest(name=name):
                self.assert_bundle_error(code, lambda value=value: bundle_manager.validate_manifest(value))

    def test_manifest_accepts_safe_external_attribution_without_granting_download_authority(self) -> None:
        manifest = copy.deepcopy(self.fixture.manifest)
        manifest["attribution"]["source_url"] = "https://artist.example:8443/portfolio/birds?set=west#credits"
        validated = bundle_manager.validate_manifest(manifest)
        self.assertEqual(
            validated["attribution"]["source_url"],
            "https://artist.example:8443/portfolio/birds?set=west#credits",
        )
        spaced = copy.deepcopy(self.fixture.manifest)
        spaced["attribution"]["source_url"] = "https://artist.example/a b"
        self.assertEqual(
            bundle_manager.validate_manifest(spaced)["attribution"]["source_url"],
            "https://artist.example/a b",
        )

        for source_url in (
            False,
            0,
            [],
            "http://artist.example/birds",
            "https://name:secret@artist.example/birds",
            "https://artist.example\\@attacker.example/birds",
            "https://artist.example/<birds>",
            "https://artist.example/birds\nnext",
            "https://artist.example:70000/birds",
        ):
            rejected = copy.deepcopy(self.fixture.manifest)
            rejected["attribution"]["source_url"] = source_url
            with self.subTest(source_url=source_url):
                self.assert_bundle_error(
                    "invalid_url", lambda rejected=rejected: bundle_manager.validate_manifest(rejected)
                )

    def test_manifest_rejects_noncanonical_paths_hashes_and_sizes(self) -> None:
        path = copy.deepcopy(self.fixture.manifest)
        path["species"][0]["poses"][0]["file"] = "illustrations/../bird.png"
        digest = copy.deepcopy(self.fixture.manifest)
        digest["species"][0]["poses"][0]["sha256"] = "A" * 64
        boolean_size = copy.deepcopy(self.fixture.manifest)
        boolean_size["species"][0]["poses"][0]["bytes"] = True
        tiny_size = copy.deepcopy(self.fixture.manifest)
        tiny_size["species"][0]["poses"][0]["bytes"] = 66
        extra_field = copy.deepcopy(self.fixture.manifest)
        extra_field["executable"] = "post-install.sh"
        for name, value, code in (
            ("path", path, "invalid_pose_path"),
            ("hash", digest, "invalid_hash"),
            ("boolean size", boolean_size, "invalid_size"),
            ("tiny size", tiny_size, "invalid_size"),
            ("extra field", extra_field, "invalid_fields"),
        ):
            with self.subTest(name=name):
                self.assert_bundle_error(code, lambda value=value: bundle_manager.validate_manifest(value))

    def test_catalog_rejects_untrusted_urls_and_bad_integrity_metadata(self) -> None:
        object_host = copy.deepcopy(self.fixture.catalog)
        object_host["object_base_url"] = "https://attacker.example/objects/"
        retired_object_host = copy.deepcopy(self.fixture.catalog)
        retired_object_host["object_base_url"] = "https://bundles.avianvisitors.com/v1/objects/sha256/"
        noncanonical_object_path = copy.deepcopy(self.fixture.catalog)
        noncanonical_object_path["object_base_url"] = "https://avianvisitors.com/v1/objects/sha256/"
        object_query = copy.deepcopy(self.fixture.catalog)
        object_query["object_base_url"] += "?token=secret"
        manifest_scheme = copy.deepcopy(self.fixture.catalog)
        manifest_scheme["packs"][0]["manifest"]["url"] = "http://bundles.avianvisitors.com/x"
        wrong_manifest_path = copy.deepcopy(self.fixture.catalog)
        wrong_manifest_path["packs"][0]["manifest"]["url"] = (
            "https://avianvisitors.com/api/bundles/manifests/" + "0" * 64 + ".json"
        )
        repository_host = copy.deepcopy(self.fixture.catalog)
        repository_host["packs"][0]["repository_url"] = "https://example.com/project"
        invalid_hash = copy.deepcopy(self.fixture.catalog)
        invalid_hash["packs"][0]["manifest"]["sha256"] = "0" * 63
        invalid_size = copy.deepcopy(self.fixture.catalog)
        invalid_size["packs"][0]["manifest"]["bytes"] = False
        global_with_codes = copy.deepcopy(self.fixture.catalog)
        global_with_codes["packs"][0]["coverage"]["group"] = "global"
        for name, value, code in (
            ("object host", object_host, "invalid_url"),
            ("retired object host", retired_object_host, "invalid_url"),
            ("noncanonical object path", noncanonical_object_path, "invalid_url"),
            ("object query", object_query, "invalid_url"),
            ("manifest scheme", manifest_scheme, "invalid_url"),
            ("manifest checksum path", wrong_manifest_path, "invalid_url"),
            ("repository host", repository_host, "invalid_url"),
            ("manifest hash", invalid_hash, "invalid_hash"),
            ("manifest size", invalid_size, "invalid_size"),
            ("global coverage with codes", global_with_codes, "invalid_coverage"),
        ):
            with self.subTest(name=name):
                self.assert_bundle_error(code, lambda value=value: bundle_manager.validate_catalog(value))

    def test_checked_url_wraps_malformed_ports_as_a_bounded_bundle_error(self) -> None:
        for value in (
            "https://avianvisitors.com:bad/api/bundles/objects/",
            "https://avianvisitors.com:70000/api/bundles/objects/",
            "https://[not-ipv6]/api/bundles/objects/",
        ):
            with self.subTest(value=value):
                self.assert_bundle_error(
                    "invalid_url",
                    lambda value=value: bundle_manager.checked_url(
                        value,
                        "object base URL",
                        bundle_manager.OBJECT_HOSTS,
                        directory=True,
                    ),
                )

    def test_dedicated_geometry_table_limit_exceeds_other_state_limits(self) -> None:
        self.assertGreaterEqual(bundle_manager.TABLE_MAX, 16 * 1024 * 1024)
        self.assertGreater(bundle_manager.TABLE_MAX, bundle_manager.STATE_MAX)
        self.assertGreater(bundle_manager.TABLE_MAX, bundle_manager.MANIFEST_MAX)

        with tempfile.TemporaryDirectory(prefix="avian-table-limit-") as directory:
            boundary = Path(directory) / "table.bin"
            with boundary.open("wb") as handle:
                handle.truncate(bundle_manager.TABLE_MAX)
            self.assertEqual(
                len(
                    bundle_manager.read_regular(
                        boundary,
                        bundle_manager.TABLE_MAX,
                        allow_writable=True,
                    )
                ),
                bundle_manager.TABLE_MAX,
            )
            with boundary.open("r+b") as handle:
                handle.truncate(bundle_manager.TABLE_MAX + 1)
            self.assert_bundle_error(
                "unsafe_file",
                lambda: bundle_manager.read_regular(
                    boundary,
                    bundle_manager.TABLE_MAX,
                    allow_writable=True,
                ),
            )

    def test_object_url_is_the_worker_flat_digest_route(self) -> None:
        catalog = bundle_manager.validate_catalog(copy.deepcopy(self.fixture.catalog))
        digest = self.fixture.pack["previews"][0]["sha256"]
        self.assertEqual(
            bundle_manager.object_url(catalog, digest),
            f"https://avianvisitors.com/api/bundles/objects/{digest}.png",
        )

    def test_catalog_manifest_cross_checks_identity_coverage_and_previews(self) -> None:
        manifest = bundle_manager.validate_manifest(copy.deepcopy(self.fixture.manifest))
        catalog_pack = bundle_manager.validate_catalog(copy.deepcopy(self.fixture.catalog))["packs"][0]
        mismatches = []
        wrong_identity = copy.deepcopy(catalog_pack)
        wrong_identity["version"] = "1.2.4"
        mismatches.append(("identity", wrong_identity, "identity_mismatch"))
        wrong_coverage = copy.deepcopy(catalog_pack)
        wrong_coverage["coverage"]["region_codes"] = ["US-OR"]
        mismatches.append(("coverage", wrong_coverage, "coverage_mismatch"))
        wrong_preview = copy.deepcopy(catalog_pack)
        wrong_preview["previews"][0]["sha256"] = "0" * 64
        mismatches.append(("preview", wrong_preview, "preview_mismatch"))
        missing_preview_name = copy.deepcopy(catalog_pack)
        missing_preview_name["previews"][0]["common_name"] = ""
        mismatches.append(("missing preview common name", missing_preview_name, "preview_mismatch"))
        wrong_size = copy.deepcopy(catalog_pack)
        wrong_size["archive_bytes"] += 1
        mismatches.append(("size", wrong_size, "size_mismatch"))
        for name, pack, code in mismatches:
            with self.subTest(name=name):
                self.assert_bundle_error(
                    code,
                    lambda pack=pack: bundle_manager.verify_catalog_manifest(
                        pack, manifest, self.fixture.manifest_hash
                    ),
                )

        unnamed_value = copy.deepcopy(self.fixture.manifest)
        unnamed_value["species"][0]["common_name"] = ""
        unnamed_raw = bundle_manager.canonical_json(unnamed_value)
        unnamed_hash = sha256(unnamed_raw)
        unnamed_manifest = bundle_manager.validate_manifest(unnamed_value)
        named_preview = copy.deepcopy(catalog_pack)
        named_preview["manifest"] = {
            "url": (
                "https://avianvisitors.com/api/bundles/manifests/"
                f"{unnamed_hash}.json"
            ),
            "sha256": unnamed_hash,
            "bytes": len(unnamed_raw),
        }
        self.assert_bundle_error(
            "preview_mismatch",
            lambda: bundle_manager.verify_catalog_manifest(
                named_preview, unnamed_manifest, unnamed_hash
            ),
        )


class BundleLifecycleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = BundleFixture()
        self.temporary = tempfile.TemporaryDirectory(prefix="avian-bundle-test-")
        self.base = Path(self.temporary.name)
        self.root = self.base / "state"
        self.publication = self.base / "publication"
        self.catalog_path = self.base / "catalog.json"
        self.lock_path = self.base / "bundle.lock"
        self.fixture.publish(self.publication)
        self.catalog_path.write_bytes(bundle_manager.canonical_json(self.fixture.catalog))
        self.environment = mock.patch.dict(
            os.environ,
            {
                "AVIAN_BUNDLE_ROOT": str(self.root),
                "AVIAN_BUNDLE_CATALOG": str(self.catalog_path),
                "AVIAN_BUNDLE_DEV_ROOT": str(self.publication),
                "AVIAN_BUNDLE_LOCK": str(self.lock_path),
                "AVIAN_BUNDLE_DB": str(self.base / "missing.db"),
                "AVIAN_BUNDLE_CONFIG": str(self.base / "missing.conf"),
            },
            clear=False,
        )
        self.environment.start()

    def tearDown(self) -> None:
        self.environment.stop()
        self.temporary.cleanup()

    def queued_install_job(self, job_id: str) -> dict[str, object]:
        now = bundle_manager.utc_now()
        return {
            "schema_version": 1,
            "id": job_id,
            "operation": "install",
            "bundle_id": self.fixture.pack_id,
            "bundle_version": self.fixture.version,
            "activate": True,
            "state": "queued",
            "phase": "queued",
            "current": 0,
            "total": 0,
            "percent": 0,
            "error": "",
            "created_at": now,
            "updated_at": now,
        }

    def install_fixture(self, job_id: str = "a" * 32) -> dict[str, object]:
        bundle_manager.initialize()
        bundle_manager.atomic_json(self.root / "job.json", self.queued_install_job(job_id))
        bundle_manager.run_job(job_id)
        return bundle_manager.load_state()["active"]

    def stage_job(self, job_id: str, operation: str = "install") -> None:
        job = self.queued_install_job(job_id)
        job["operation"] = operation
        if operation == "activate":
            job["activate"] = False
            job["total"] = 1
        bundle_manager.atomic_json(self.root / "job.json", job)

    def test_install_activate_preview_rollback_reactivate_and_remove(self) -> None:
        initialized = bundle_manager.initialize()
        self.assertEqual(initialized["active"], bundle_manager.builtin_ref())
        reference = self.install_fixture()

        job = bundle_manager.load_job()
        assert job is not None
        self.assertEqual(job["state"], "complete")
        self.assertEqual(job["percent"], 100)
        state = bundle_manager.load_state()
        self.assertEqual(state["active"]["id"], self.fixture.pack_id)
        self.assertEqual(state["previous"], bundle_manager.builtin_ref())

        installed = bundle_manager.pack_directory(reference)
        index = json.loads((installed / "index.json").read_text(encoding="utf-8"))
        dims = json.loads((installed / "dims.json").read_text(encoding="utf-8"))
        masks = json.loads((installed / "masks.json").read_text(encoding="utf-8"))
        expected_slugs = {"corvus-brachyrhynchos", "corvus-brachyrhynchos-2"}
        self.assertEqual(set(dims), expected_slugs)
        self.assertEqual(set(masks), expected_slugs)
        self.assertEqual(set(index["assets"]), {"corvus-brachyrhynchos"})

        for raw in self.fixture.images.values():
            digest = sha256(raw)
            stored = bundle_manager.object_store_path(self.root, digest)
            self.assertEqual(stored.read_bytes(), raw)
            self.assertEqual(stored.stat().st_mode & 0o777, 0o644)

        self.assertEqual(
            bundle_manager.preview_bytes(self.fixture.pack_id, 0),
            self.fixture.images["perched"],
        )

        restored = bundle_manager.rollback_active()
        self.assertEqual(restored, bundle_manager.builtin_ref())
        for _ in range(2):
            reactivated = bundle_manager.activate_pack(
                self.fixture.pack_id, bundle_manager.load_catalog()
            )
            self.assertEqual(reactivated, reference)
            self.assertEqual(bundle_manager.load_state()["active"], reference)
            self.assertEqual(
                bundle_manager.validate_runtime_reference(reactivated)["revision"],
                reference["revision"],
            )
            restored = bundle_manager.rollback_active()
            self.assertEqual(restored, bundle_manager.builtin_ref())
            self.assertEqual(bundle_manager.load_state()["active"], bundle_manager.builtin_ref())

        reactivated = bundle_manager.activate_pack(
            self.fixture.pack_id, bundle_manager.load_catalog()
        )
        self.assertEqual(reactivated, reference)
        bundle_manager.remove_pack(self.fixture.pack_id)

        final_state = bundle_manager.load_state()
        self.assertEqual(final_state["active"], bundle_manager.builtin_ref())
        self.assertIsNone(final_state["previous"])
        self.assertFalse((self.root / "packs" / self.fixture.pack_id).exists())
        for raw in self.fixture.images.values():
            self.assertFalse(bundle_manager.object_store_path(self.root, sha256(raw)).exists())

    def test_use_refreshes_installs_activates_and_is_idempotent(self) -> None:
        bundle_manager.initialize()
        workers = []
        real_popen = subprocess.Popen

        def tracked_popen(*args, **kwargs):
            worker = real_popen(*args, **kwargs)
            workers.append(worker)
            return worker

        with mock.patch.object(
            bundle_manager,
            "refresh_catalog",
            side_effect=bundle_manager.load_catalog,
        ), mock.patch.object(bundle_manager.subprocess, "Popen", side_effect=tracked_popen):
            result = bundle_manager.use_selector(self.fixture.pack["manifest"]["url"])
        for worker in workers:
            worker.wait(timeout=5)
        self.assertTrue(result["changed"])
        self.assertEqual(result["bundle"]["revision"], self.fixture.manifest_hash)
        self.assertEqual(
            bundle_manager.load_state()["active"]["revision"],
            self.fixture.manifest_hash,
        )

        with mock.patch.object(
            bundle_manager,
            "refresh_catalog",
            side_effect=bundle_manager.load_catalog,
        ), mock.patch.object(bundle_manager, "enqueue") as enqueue:
            repeated = bundle_manager.use_selector(self.fixture.pack_id)
        self.assertFalse(repeated["changed"])
        enqueue.assert_not_called()

    def test_full_length_scientific_name_installs_loads_and_activates_with_canonical_slugs(self) -> None:
        scientific_name = "A" + "a" * 39 + " " + "b" * 40 + " " + "c" * 40 + " " + "d" * 40
        self.assertEqual(len(scientific_name), bundle_manager.SCI_NAME_MAX)
        species_slug = bundle_manager.scientific_slug(scientific_name)
        flight_slug = bundle_manager.pose_slug(scientific_name, "flight")
        self.assertEqual(len(species_slug), bundle_manager.SCI_NAME_MAX)
        self.assertEqual(len(flight_slug), bundle_manager.POSE_SLUG_MAX)
        self.assertEqual(len(f"{flight_slug}.png"), 169)

        bird = self.fixture.manifest["species"][0]
        bird["scientific_name"] = scientific_name
        for pose in bird["poses"]:
            pose["file"] = bundle_manager.pose_path(scientific_name, pose["id"])
        self.fixture.pack["species"] = [scientific_name]
        self.fixture.pack["previews"][0]["scientific_name"] = scientific_name
        self.fixture.manifest["coverage"] = {
            "type": "selection",
            "label": "Maximum-name selection",
        }
        self.fixture.pack["coverage"] = {
            "label": "Maximum-name selection",
            "group": "other",
            "region_codes": [],
        }
        self.fixture.manifest_raw = bundle_manager.canonical_json(self.fixture.manifest)
        self.fixture.manifest_hash = sha256(self.fixture.manifest_raw)
        self.fixture.pack["manifest"] = {
            "url": (
                "https://avianvisitors.com/api/bundles/manifests/"
                f"{self.fixture.manifest_hash}.json"
            ),
            "sha256": self.fixture.manifest_hash,
            "bytes": len(self.fixture.manifest_raw),
        }
        self.fixture.publish(self.publication)
        self.catalog_path.write_bytes(bundle_manager.canonical_json(self.fixture.catalog))

        reference = self.install_fixture("aa" * 16)
        installed = bundle_manager.pack_directory(reference)
        index = bundle_manager.load_index(reference)
        self.assertEqual(list(index["assets"]), [species_slug])
        self.assertEqual(
            set(json.loads((installed / "dims.json").read_text(encoding="utf-8"))),
            {species_slug, flight_slug},
        )
        self.assertEqual(
            set(json.loads((installed / "masks.json").read_text(encoding="utf-8"))),
            {species_slug, flight_slug},
        )
        self.assertEqual(bundle_manager.load_state()["active"], reference)
        installed_record = bundle_manager.validate_installed_pack(reference, verify_hashes=True)
        self.assertEqual(installed_record["coverage"]["region_codes"], [])
        self.assertEqual(
            bundle_manager.validate_runtime_reference(reference)["revision"],
            reference["revision"],
        )

    def test_install_keeps_source_attribution_and_license_file_out_of_download_authority(self) -> None:
        self.fixture.manifest["license"] = {
            "file": self.fixture.manifest["species"][0]["poses"][0]["file"],
            "spdx": "CC-BY-NC-SA-4.0",
        }
        source_url = "https://artist.example/a b"
        self.fixture.manifest["attribution"]["source_url"] = source_url
        self.fixture.pack["license"] = "CC-BY-NC-SA-4.0"
        self.fixture.manifest_raw = bundle_manager.canonical_json(self.fixture.manifest)
        self.fixture.manifest_hash = sha256(self.fixture.manifest_raw)
        self.fixture.pack["manifest"] = {
            "url": (
                "https://avianvisitors.com/api/bundles/manifests/"
                f"{self.fixture.manifest_hash}.json"
            ),
            "sha256": self.fixture.manifest_hash,
            "bytes": len(self.fixture.manifest_raw),
        }
        self.catalog_path.write_bytes(bundle_manager.canonical_json(self.fixture.catalog))

        manifest_url = self.fixture.pack["manifest"]["url"]
        object_payloads = {
            f"https://avianvisitors.com/api/bundles/objects/{sha256(raw)}.png": raw
            for raw in self.fixture.images.values()
        }
        payloads = {manifest_url: self.fixture.manifest_raw, **object_payloads}

        def download(url, expected_size, allowed_hosts):
            self.assertIn(url, payloads)
            raw = payloads[url]
            self.assertEqual(len(raw), expected_size)
            self.assertEqual(
                allowed_hosts,
                bundle_manager.MANIFEST_HOSTS
                if url == manifest_url
                else bundle_manager.OBJECT_HOSTS,
            )
            return raw

        with mock.patch.dict(os.environ, {"AVIAN_BUNDLE_DEV_ROOT": ""}), mock.patch.object(
            bundle_manager, "download_https", side_effect=download
        ) as fetched:
            self.install_fixture("ab" * 16)

        self.assertEqual(
            [call.args[0] for call in fetched.call_args_list],
            [manifest_url, *object_payloads],
        )
        self.assertNotIn(
            source_url,
            [call.args[0] for call in fetched.call_args_list],
        )
        reference = bundle_manager.load_state()["active"]
        installed_manifest = bundle_manager.read_json(
            bundle_manager.pack_directory(reference) / "manifest.json",
            bundle_manager.MANIFEST_MAX,
        )
        self.assertEqual(
            (bundle_manager.pack_directory(reference) / "manifest.json").read_bytes(),
            self.fixture.manifest_raw,
        )
        self.assertEqual(
            bundle_manager.validate_manifest(installed_manifest)["license"],
            {"spdx": "CC-BY-NC-SA-4.0"},
        )
        self.assertEqual(installed_manifest["attribution"]["source_url"], source_url)

    def test_inspection_worker_accepts_the_full_flight_slug_label_only(self) -> None:
        scientific_name = "A" + "a" * 39 + " " + "b" * 40 + " " + "c" * 40 + " " + "d" * 40
        label = bundle_manager.pose_slug(scientific_name, "flight")
        raw = self.fixture.images["flight"]
        stdin = mock.Mock(buffer=BytesIO(raw))
        with mock.patch.object(bundle_manager.sys, "stdin", stdin):
            geometry = bundle_manager.inspect_png_command(label)
        bundle_manager.checked_geometry(geometry)

        with self.assertRaises(bundle_manager.BundleError) as raised:
            bundle_manager.inspect_png_command(label + "x")
        self.assertEqual(raised.exception.code, "invalid_text")

    def assert_gc_preserves_active_objects_with_damaged_file(self, filename: str) -> None:
        reference = self.install_fixture("c" * 32)
        installed = bundle_manager.pack_directory(reference)
        (installed / filename).write_text("{}\n", encoding="utf-8")
        self.assertEqual(bundle_manager.installed_records(), [])
        self.assertEqual(
            bundle_manager.validate_runtime_reference(reference)["revision"],
            reference["revision"],
        )

        unrelated = self.root / "packs" / "community-unrelated"
        bundle_manager.safe_directory(unrelated, create=True)
        bundle_manager.remove_pack("community-unrelated")

        self.assertEqual(bundle_manager.load_state()["active"]["id"], self.fixture.pack_id)
        for raw in self.fixture.images.values():
            stored = bundle_manager.object_store_path(self.root, sha256(raw))
            self.assertTrue(stored.is_file(), f"active object was collected after {filename} damage")
            self.assertEqual(stored.read_bytes(), raw)

    def test_gc_preserves_active_objects_when_manifest_metadata_is_damaged(self) -> None:
        self.assert_gc_preserves_active_objects_with_damaged_file("manifest.json")

    def test_gc_preserves_active_objects_when_install_metadata_is_damaged(self) -> None:
        self.assert_gc_preserves_active_objects_with_damaged_file("meta.json")

    def test_runtime_and_rollback_reject_missing_geometry_or_object(self) -> None:
        reference = self.install_fixture("e" * 32)
        self.assertEqual(bundle_manager.rollback_active(), bundle_manager.builtin_ref())
        installed = bundle_manager.pack_directory(reference)
        object_raw = self.fixture.images["perched"]
        object_path = bundle_manager.object_store_path(self.root, sha256(object_raw))

        cases = [
            (installed / "dims.json", (installed / "dims.json").read_bytes()),
            (installed / "masks.json", b"{}\n"),
            (object_path, object_raw),
        ]
        for path, replacement in cases:
            with self.subTest(path=path.name):
                original = path.read_bytes()
                if path.name == "masks.json":
                    path.write_bytes(replacement)
                else:
                    path.unlink()
                with self.assertRaises(bundle_manager.BundleError):
                    bundle_manager.validate_runtime_reference(reference)
                with self.assertRaises(bundle_manager.BundleError) as raised:
                    bundle_manager.rollback_active()
                self.assertEqual(raised.exception.code, "invalid_state")
                path.write_bytes(original)
                self.assertEqual(
                    bundle_manager.validate_runtime_reference(reference)["revision"],
                    reference["revision"],
                )

    def test_reinstall_repairs_same_revision_metadata_tables_and_object(self) -> None:
        reference = self.install_fixture("f" * 32)
        installed = bundle_manager.pack_directory(reference)
        (installed / "meta.json").unlink()
        (installed / "dims.json").write_text("{}\n", encoding="utf-8")
        raw = self.fixture.images["perched"]
        stored = bundle_manager.object_store_path(self.root, sha256(raw))
        stored.write_bytes(b"x" * len(raw))

        job_id = "1" * 32
        self.stage_job(job_id)
        catalog = bundle_manager.load_catalog()
        repaired = bundle_manager.install_pack(
            catalog,
            bundle_manager.catalog_pack(catalog, self.fixture.pack_id),
            job_id,
        )

        self.assertEqual(repaired, reference)
        self.assertEqual(stored.read_bytes(), raw)
        record = bundle_manager.validate_installed_pack(reference, verify_hashes=True)
        self.assertEqual(record["reference"], reference)
        self.assertEqual(record["name"], self.fixture.manifest["name"])
        self.assertEqual(record["coverage"], self.fixture.manifest["coverage"])
        self.assertEqual(record["style"], self.fixture.manifest["style"])
        self.assertEqual(record["archive_bytes"], sum(len(raw) for raw in self.fixture.images.values()))
        self.assertEqual(bundle_manager.load_state()["active"], reference)

    def test_reinstall_repairs_from_meta_when_index_and_manifest_are_unreadable(self) -> None:
        reference = self.install_fixture("6" * 32)
        installed = bundle_manager.pack_directory(reference)
        (installed / "index.json").write_text("{}\n", encoding="utf-8")
        (installed / "manifest.json").write_text("{}\n", encoding="utf-8")
        (installed / "masks.json").write_text("{}\n", encoding="utf-8")

        job_id = "7" * 32
        self.stage_job(job_id)
        catalog = bundle_manager.load_catalog()
        repaired = bundle_manager.install_pack(
            catalog,
            bundle_manager.catalog_pack(catalog, self.fixture.pack_id),
            job_id,
        )

        self.assertEqual(repaired, reference)
        bundle_manager.validate_installed_pack(reference, verify_hashes=True)

    def test_reinstall_rejects_when_no_revision_carrier_is_readable(self) -> None:
        reference = self.install_fixture("8" * 32)
        installed = bundle_manager.pack_directory(reference)
        for name in ("meta.json", "index.json", "manifest.json"):
            (installed / name).write_text("{}\n", encoding="utf-8")
        original = {item.name: item.read_bytes() for item in installed.iterdir()}

        job_id = "9" * 32
        self.stage_job(job_id)
        catalog = bundle_manager.load_catalog()
        with self.assertRaises(bundle_manager.BundleError) as raised:
            bundle_manager.install_pack(
                catalog,
                bundle_manager.catalog_pack(catalog, self.fixture.pack_id),
                job_id,
            )

        self.assertEqual(raised.exception.code, "immutable_version")
        self.assertEqual(
            {item.name: item.read_bytes() for item in installed.iterdir()},
            original,
        )

    def test_repair_exchange_failure_leaves_existing_directory_byte_exact(self) -> None:
        reference = self.install_fixture("a1" * 16)
        installed = bundle_manager.pack_directory(reference)
        (installed / "dims.json").write_text("{}\n", encoding="utf-8")
        original = {item.name: item.read_bytes() for item in installed.iterdir()}

        job_id = "a2" * 16
        self.stage_job(job_id)
        catalog = bundle_manager.load_catalog()
        failure = bundle_manager.BundleError("forced exchange failure", "repair_failed")
        with mock.patch.object(bundle_manager, "exchange_directories", side_effect=failure):
            with self.assertRaises(bundle_manager.BundleError) as raised:
                bundle_manager.install_pack(
                    catalog,
                    bundle_manager.catalog_pack(catalog, self.fixture.pack_id),
                    job_id,
                )

        self.assertEqual(raised.exception.code, "repair_failed")
        self.assertEqual(
            {item.name: item.read_bytes() for item in installed.iterdir()},
            original,
        )

    def test_failed_post_exchange_validation_swaps_the_original_pack_back(self) -> None:
        reference = self.install_fixture("b1" * 16)
        installed = bundle_manager.pack_directory(reference)
        (installed / "dims.json").write_text("{}\n", encoding="utf-8")
        original = {item.name: item.read_bytes() for item in installed.iterdir()}

        job_id = "b2" * 16
        self.stage_job(job_id)
        catalog = bundle_manager.load_catalog()
        real_validate = bundle_manager.validate_installed_pack
        calls = 0
        live_calls = 0

        def fail_new_pack(candidate, *, verify_hashes=False, directory=None):
            nonlocal calls, live_calls
            calls += 1
            if directory is None:
                live_calls += 1
            if directory is None and live_calls == 2:
                raise bundle_manager.BundleError("forced post-swap failure", "invalid_install")
            return real_validate(candidate, verify_hashes=verify_hashes, directory=directory)

        with mock.patch.object(
            bundle_manager,
            "validate_installed_pack",
            side_effect=fail_new_pack,
        ):
            with self.assertRaises(bundle_manager.BundleError) as raised:
                bundle_manager.install_pack(
                    catalog,
                    bundle_manager.catalog_pack(catalog, self.fixture.pack_id),
                    job_id,
                )

        self.assertEqual(raised.exception.code, "invalid_install")
        self.assertEqual(calls, 3)
        self.assertEqual(
            {item.name: item.read_bytes() for item in installed.iterdir()},
            original,
        )

    def test_failed_exchange_durability_sync_restores_the_original_pack(self) -> None:
        reference = self.install_fixture("b3" * 16)
        installed = bundle_manager.pack_directory(reference)
        (installed / "dims.json").write_text("{}\n", encoding="utf-8")
        original = {item.name: item.read_bytes() for item in installed.iterdir()}

        job_id = "b4" * 16
        self.stage_job(job_id)
        catalog = bundle_manager.load_catalog()
        real_fsync = bundle_manager.fsync_directory
        failed = False

        def fail_first_exchange_parent(path):
            nonlocal failed
            if path == self.root / "staging" and not failed:
                failed = True
                raise OSError("forced parent fsync failure")
            return real_fsync(path)

        with mock.patch.object(
            bundle_manager,
            "fsync_directory",
            side_effect=fail_first_exchange_parent,
        ):
            with self.assertRaises(bundle_manager.BundleError) as raised:
                bundle_manager.install_pack(
                    catalog,
                    bundle_manager.catalog_pack(catalog, self.fixture.pack_id),
                    job_id,
                )

        self.assertEqual(raised.exception.code, "repair_failed")
        self.assertTrue(failed)
        self.assertEqual(
            {item.name: item.read_bytes() for item in installed.iterdir()},
            original,
        )
        self.assertEqual(list((self.root / "staging").iterdir()), [])

    def test_activation_repairs_same_revision_corrupt_object(self) -> None:
        reference = self.install_fixture("2" * 32)
        self.assertEqual(bundle_manager.rollback_active(), bundle_manager.builtin_ref())
        raw = self.fixture.images["perched"]
        stored = bundle_manager.object_store_path(self.root, sha256(raw))
        stored.write_bytes(b"x" * len(raw))

        job_id = "3" * 32
        self.stage_job(job_id, "activate")
        activated = bundle_manager.activate_pack(
            self.fixture.pack_id,
            bundle_manager.load_catalog(),
            job_id,
        )

        self.assertEqual(activated, reference)
        self.assertEqual(stored.read_bytes(), raw)
        self.assertEqual(bundle_manager.load_state()["active"], reference)
        bundle_manager.validate_installed_pack(reference, verify_hashes=True)

    def test_same_version_with_a_different_valid_revision_is_immutable(self) -> None:
        reference = self.install_fixture("4" * 32)
        installed = bundle_manager.pack_directory(reference)
        original_index = (installed / "index.json").read_bytes()
        original_manifest = (installed / "manifest.json").read_bytes()

        self.fixture.manifest["description"] = "A different immutable payload."
        self.fixture.pack["description"] = self.fixture.manifest["description"]
        self.fixture.manifest_raw = bundle_manager.canonical_json(self.fixture.manifest)
        self.fixture.manifest_hash = sha256(self.fixture.manifest_raw)
        self.fixture.pack["manifest"] = {
            "url": (
                "https://avianvisitors.com/api/bundles/manifests/"
                f"{self.fixture.manifest_hash}.json"
            ),
            "sha256": self.fixture.manifest_hash,
            "bytes": len(self.fixture.manifest_raw),
        }
        self.fixture.publish(self.publication)
        catalog = bundle_manager.validate_catalog(copy.deepcopy(self.fixture.catalog))
        job_id = "5" * 32
        self.stage_job(job_id)

        with self.assertRaises(bundle_manager.BundleError) as raised:
            bundle_manager.install_pack(
                catalog,
                bundle_manager.catalog_pack(catalog, self.fixture.pack_id),
                job_id,
            )
        self.assertEqual(raised.exception.code, "immutable_version")
        self.assertEqual((installed / "index.json").read_bytes(), original_index)
        self.assertEqual((installed / "manifest.json").read_bytes(), original_manifest)
        bundle_manager.validate_installed_pack(reference, verify_hashes=True)

    def test_preview_rejects_a_same_size_object_with_the_wrong_hash(self) -> None:
        bundle_manager.initialize()
        raw = self.fixture.images["perched"]
        digest = sha256(raw)
        published = (
            self.publication / "objects" / "sha256" / digest[:2] / f"{digest}.png"
        )
        published.write_bytes(b"x" * len(raw))
        with self.assertRaises(bundle_manager.BundleError) as raised:
            bundle_manager.preview_bytes(self.fixture.pack_id, 0)
        self.assertEqual(raised.exception.code, "object_hash")
        self.assertFalse(bundle_manager.object_store_path(self.root, digest).exists())

    def test_remote_preview_never_persists_an_object(self) -> None:
        bundle_manager.initialize()
        raw = self.fixture.images["perched"]
        digest = sha256(raw)

        self.assertEqual(bundle_manager.preview_bytes(self.fixture.pack_id, 0), raw)
        self.assertFalse(bundle_manager.object_store_path(self.root, digest).exists())
        self.assertEqual(
            list((self.root / "objects" / "sha256").rglob("*.png")),
            [],
        )

    def test_install_rejects_object_store_quota_before_downloading_objects(self) -> None:
        bundle_manager.initialize()
        job_id = "c1" * 16
        self.stage_job(job_id)
        catalog = bundle_manager.load_catalog()
        pack = bundle_manager.catalog_pack(catalog, self.fixture.pack_id)

        with mock.patch.object(
            bundle_manager,
            "object_store_inventory",
            return_value={"f" * 64: bundle_manager.OBJECT_STORE_MAX},
        ), mock.patch.object(bundle_manager, "fetch_object") as fetch:
            with self.assertRaises(bundle_manager.BundleError) as raised:
                bundle_manager.install_pack(catalog, pack, job_id)

        self.assertEqual(raised.exception.code, "storage_limit")
        fetch.assert_not_called()

    def test_install_rejects_low_disk_space_before_downloading_objects(self) -> None:
        bundle_manager.initialize()
        job_id = "c2" * 16
        self.stage_job(job_id)
        catalog = bundle_manager.load_catalog()
        pack = bundle_manager.catalog_pack(catalog, self.fixture.pack_id)
        required = sum(len(raw) for raw in self.fixture.images.values())

        with mock.patch.object(
            bundle_manager.shutil,
            "disk_usage",
            return_value=mock.Mock(
                free=required + bundle_manager.FREE_SPACE_RESERVE - 1
            ),
        ), mock.patch.object(bundle_manager, "fetch_object") as fetch:
            with self.assertRaises(bundle_manager.BundleError) as raised:
                bundle_manager.install_pack(catalog, pack, job_id)

        self.assertEqual(raised.exception.code, "storage_full")
        fetch.assert_not_called()

    def test_corrupt_same_size_object_checks_temporary_replacement_space(self) -> None:
        bundle_manager.initialize()
        raw = self.fixture.images["perched"]
        digest = sha256(raw)
        stored = bundle_manager.object_store_path(self.root, digest)
        bundle_manager.safe_directory(stored.parent, create=True)
        corrupt = b"x" * len(raw)
        stored.write_bytes(corrupt)

        job_id = "c3" * 16
        self.stage_job(job_id)
        catalog = bundle_manager.load_catalog()
        pack = bundle_manager.catalog_pack(catalog, self.fixture.pack_id)
        initial_required = len(self.fixture.images["flight"])
        free_space = [
            mock.Mock(free=initial_required + bundle_manager.FREE_SPACE_RESERVE),
            mock.Mock(free=len(raw) + bundle_manager.FREE_SPACE_RESERVE - 1),
        ]

        with mock.patch.object(
            bundle_manager.shutil,
            "disk_usage",
            side_effect=free_space,
        ):
            with self.assertRaises(bundle_manager.BundleError) as raised:
                bundle_manager.install_pack(catalog, pack, job_id)

        self.assertEqual(raised.exception.code, "storage_full")
        self.assertEqual(stored.read_bytes(), corrupt)

    def test_failed_install_collects_partially_downloaded_objects(self) -> None:
        bundle_manager.initialize()
        job_id = "c4" * 16
        bundle_manager.atomic_json(self.root / "job.json", self.queued_install_job(job_id))
        perched = self.fixture.images["perched"]
        perched_digest = sha256(perched)
        flight_digest = sha256(self.fixture.images["flight"])
        original_fetch = bundle_manager.fetch_object
        saw_partial_object = False

        def fail_second_object(catalog, digest, expected_size):
            nonlocal saw_partial_object
            if digest == flight_digest:
                saw_partial_object = bundle_manager.object_store_path(
                    self.root, perched_digest
                ).is_file()
                raise bundle_manager.BundleError("forced object failure", "object_hash")
            return original_fetch(catalog, digest, expected_size)

        with mock.patch.object(
            bundle_manager,
            "fetch_object",
            side_effect=fail_second_object,
        ):
            with self.assertRaises(bundle_manager.BundleError) as raised:
                bundle_manager.run_job(job_id)

        self.assertEqual(raised.exception.code, "object_hash")
        self.assertTrue(saw_partial_object)
        self.assertEqual(
            list((self.root / "objects" / "sha256").rglob("*.png")),
            [],
        )
        self.assertEqual(bundle_manager.load_state()["active"], bundle_manager.builtin_ref())
        job = bundle_manager.load_job()
        assert job is not None
        self.assertEqual(job["state"], "failed")

    def test_partial_pose_install_finishes_with_the_manifest_pose_total(self) -> None:
        self.fixture.manifest["species"][0]["poses"] = [
            self.fixture.manifest["species"][0]["poses"][0]
        ]
        self.fixture.images = {"perched": self.fixture.images["perched"]}
        self.fixture.manifest_raw = bundle_manager.canonical_json(self.fixture.manifest)
        self.fixture.manifest_hash = sha256(self.fixture.manifest_raw)
        self.fixture.pack["manifest"] = {
            "url": (
                "https://avianvisitors.com/api/bundles/manifests/"
                f"{self.fixture.manifest_hash}.json"
            ),
            "sha256": self.fixture.manifest_hash,
            "bytes": len(self.fixture.manifest_raw),
        }
        self.fixture.pack["archive_bytes"] = len(self.fixture.images["perched"])
        self.fixture.publish(self.publication)
        self.catalog_path.write_bytes(bundle_manager.canonical_json(self.fixture.catalog))

        self.install_fixture("d" * 32)
        job = bundle_manager.load_job()
        assert job is not None
        self.assertEqual(job["state"], "complete")
        self.assertEqual(job["total"], 1)
        self.assertEqual(job["current"], 1)

    def assert_enqueue_rejects_unsafe_log(self, kind: str) -> None:
        bundle_manager.initialize()
        target = self.base / f"do-not-touch-{kind}.log"
        target.write_text("sentinel\n", encoding="utf-8")
        log_path = self.root / "operation.log"
        if kind == "symlink":
            log_path.symlink_to(target)
        elif kind == "hardlink":
            os.link(target, log_path)
        elif kind == "group-writable":
            log_path.write_text("sentinel\n", encoding="utf-8")
            log_path.chmod(0o660)
            target = log_path
        else:
            self.fail(f"unknown hostile log kind: {kind}")

        with self.assertRaises(bundle_manager.BundleError) as raised:
            bundle_manager.enqueue("install", self.fixture.pack_id, "", False)
        self.assertEqual(raised.exception.code, "unsafe_log")
        self.assertEqual(target.read_text(encoding="utf-8"), "sentinel\n")
        job = bundle_manager.load_job()
        assert job is not None
        self.assertEqual(job["state"], "failed")

    def test_enqueue_rejects_operation_log_symlink_without_touching_target(self) -> None:
        self.assert_enqueue_rejects_unsafe_log("symlink")

    def test_enqueue_rejects_operation_log_hardlink_without_touching_target(self) -> None:
        self.assert_enqueue_rejects_unsafe_log("hardlink")

    def test_enqueue_rejects_group_writable_operation_log_before_truncation(self) -> None:
        self.assert_enqueue_rejects_unsafe_log("group-writable")

    def test_enqueue_binds_the_exact_version_and_manifest_selected_by_use(self) -> None:
        bundle_manager.initialize()
        for expected_version, expected_revision in (
            ("9.9.9", self.fixture.manifest_hash),
            (self.fixture.version, "0" * 64),
        ):
            with self.subTest(
                expected_version=expected_version,
                expected_revision=expected_revision,
            ):
                with self.assertRaises(bundle_manager.BundleError) as raised:
                    bundle_manager.enqueue(
                        "install",
                        self.fixture.pack_id,
                        "",
                        True,
                        expected_version=expected_version,
                        expected_revision=expected_revision,
                    )
                self.assertEqual(raised.exception.code, "version_mismatch")
        self.assertIsNone(bundle_manager.load_job())

    def assert_hostile_lock_is_rejected(self, kind: str) -> None:
        bundle_manager.ensure_storage()
        target = self.base / f"do-not-touch-{kind}.lock"
        target.write_text("sentinel\n", encoding="utf-8")
        if kind == "symlink":
            self.lock_path.symlink_to(target)
        elif kind == "hardlink":
            os.link(target, self.lock_path)
        elif kind == "group-writable":
            self.lock_path.write_text("sentinel\n", encoding="utf-8")
            self.lock_path.chmod(0o620)
            target = self.lock_path
        else:
            self.fail(f"unknown hostile lock kind: {kind}")

        with self.assertRaises((bundle_manager.BundleError, OSError)) as raised:
            with bundle_manager.locked():
                self.fail("hostile lock unexpectedly opened")
        if isinstance(raised.exception, bundle_manager.BundleError):
            self.assertEqual(raised.exception.code, "unsafe_lock")
        self.assertEqual(target.read_text(encoding="utf-8"), "sentinel\n")

    def test_operation_lock_rejects_symlink(self) -> None:
        self.assert_hostile_lock_is_rejected("symlink")

    def test_operation_lock_rejects_hardlink(self) -> None:
        self.assert_hostile_lock_is_rejected("hardlink")

    def test_operation_lock_rejects_group_writable_file(self) -> None:
        self.assert_hostile_lock_is_rejected("group-writable")

    def test_job_state_rejects_semver_numeric_prerelease_leading_zero(self) -> None:
        bundle_manager.initialize()
        job = self.queued_install_job("b" * 32)
        job["bundle_version"] = "1.2.3-01"
        bundle_manager.atomic_json(self.root / "job.json", job)
        with self.assertRaises(bundle_manager.BundleError) as raised:
            bundle_manager.load_job()
        self.assertEqual(raised.exception.code, "invalid_job")

    def test_missing_active_state_fails_closed_after_initialization(self) -> None:
        bundle_manager.initialize()
        active_path = self.root / "active.json"
        active_path.unlink()

        for operation in (bundle_manager.load_state, bundle_manager.snapshot):
            with self.subTest(operation=operation.__name__):
                with self.assertRaises(bundle_manager.BundleError) as raised:
                    operation()
                self.assertEqual(raised.exception.code, "invalid_state")
                self.assertFalse(active_path.exists())


if __name__ == "__main__":
    unittest.main()
