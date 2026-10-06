from __future__ import annotations

import copy
import datetime as dt
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from unittest import mock

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bundle_runtime


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def unique_scientific_name(number: int) -> str:
    letters = ""
    value = number
    while True:
        letters = chr(ord("a") + value % 26) + letters
        value = value // 26 - 1
        if value < 0:
            break
    return "Genus a" + letters


def catalog_timestamp(minutes: int = 0) -> str:
    value = dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=minutes)
    return value.strftime("%Y-%m-%dT%H:%M:%S.000Z")


class FrameBundleFixture:
    def __init__(self, base: Path) -> None:
        self.base = base
        self.root = base / "state"
        self.dev = base / "publication"
        image = Image.new("RGBA", (5, 4), (0, 0, 0, 0))
        image.putpixel((2, 1), (120, 40, 20, 255))
        output = BytesIO()
        image.save(output, "PNG")
        self.png = output.getvalue()
        self.object_hash = hashlib.sha256(self.png).hexdigest()
        self.manifest = {
            "format": "avian-visitors-asset-pack",
            "format_version": 1,
            "id": "qa-frame-birds",
            "version": "1.2.3",
            "name": "QA Frame Birds",
            "style": {"id": "qa-ink", "name": "QA Ink"},
            "coverage": {"type": "selection", "label": "QA"},
            "species": [
                {
                    "scientific_name": "Corvus corax",
                    "common_name": "Common Raven",
                    "poses": [
                        {
                            "id": "perched",
                            "file": "illustrations/corvus-corax.png",
                            "sha256": self.object_hash,
                            "bytes": len(self.png),
                        }
                    ],
                }
            ],
            "license": {"spdx": "CC-BY-4.0"},
            "attribution": {"creator": "QA"},
        }
        self.manifest_raw = canonical(self.manifest)
        self.manifest_hash = hashlib.sha256(self.manifest_raw).hexdigest()
        self.pack = {
            "id": self.manifest["id"],
            "version": self.manifest["version"],
            "name": self.manifest["name"],
            "description": "Community-maintained bird artwork.",
            "creator": "QA",
            "repository_url": "https://github.com/avian-visitors/qa-frame-birds",
            "coverage": {"label": "QA", "group": "other", "region_codes": []},
            "style": {
                "id": "qa-ink",
                "name": "QA Ink",
                "category": "illustrated",
                "tags": ["qa"],
            },
            "species_count": 1,
            "species": ["Corvus corax"],
            "review": "community",
            "availability": "installable",
            "manifest": {
                "url": bundle_runtime._manifest_url(self.manifest_hash),
                "sha256": self.manifest_hash,
                "bytes": len(self.manifest_raw),
            },
            "archive_bytes": len(self.png),
            "previews": [
                {
                    "scientific_name": "Corvus corax",
                    "common_name": "Common Raven",
                    "pose": "perched",
                    "sha256": self.object_hash,
                    "bytes": len(self.png),
                }
            ],
            "license": "CC-BY-4.0",
        }
        self.write_catalog()
        (self.dev / "manifests").mkdir(parents=True)
        (self.dev / "objects").mkdir()
        (self.dev / "manifests" / f"{self.manifest_hash}.json").write_bytes(
            self.manifest_raw
        )
        (self.dev / "objects" / f"{self.object_hash}.png").write_bytes(self.png)

    def write_catalog(self, *, updated="2026-09-08", packs=None) -> None:
        self.dev.mkdir(parents=True, exist_ok=True)
        catalog = {
            "format": "avian-visitors-bundle-catalog",
            "format_version": 1,
            "updated": updated,
            "object_base_url": bundle_runtime.OBJECT_BASE,
            "packs": [self.pack] if packs is None and hasattr(self, "pack") else (packs or []),
        }
        (self.dev / "catalog.json").write_bytes(canonical(catalog))

    def add_species(self) -> dict[str, str]:
        hashes = {"Corvus corax": self.object_hash}
        for index, scientific in enumerate(("Calypte anna", "Haemorhous mexicanus")):
            image = Image.new("RGBA", (5, 4), (0, 0, 0, 0))
            image.putpixel((2, 1), (30 + index, 90, 180, 255))
            output = BytesIO()
            image.save(output, "PNG")
            raw = output.getvalue()
            digest = hashlib.sha256(raw).hexdigest()
            hashes[scientific] = digest
            (self.dev / "objects" / f"{digest}.png").write_bytes(raw)
            self.manifest["species"].append({
                "scientific_name": scientific,
                "poses": [{"id": "perched", "file": "illustrations/" + bundle_runtime._slug(scientific) + ".png",
                           "sha256": digest, "bytes": len(raw)}],
            })
        self.manifest_raw = canonical(self.manifest)
        self.manifest_hash = hashlib.sha256(self.manifest_raw).hexdigest()
        (self.dev / "manifests" / f"{self.manifest_hash}.json").write_bytes(self.manifest_raw)
        self.pack["manifest"] = {"url": bundle_runtime._manifest_url(self.manifest_hash),
                                 "sha256": self.manifest_hash, "bytes": len(self.manifest_raw)}
        self.pack["species"] = [bird["scientific_name"] for bird in self.manifest["species"]]
        self.pack["species_count"] = len(self.pack["species"])
        self.pack["archive_bytes"] = sum(pose["bytes"] for bird in self.manifest["species"] for pose in bird["poses"])
        self.write_catalog()
        return hashes


class FrameBundleRuntimeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="avian-frame-bundle-")
        self.base = Path(self.temporary.name)
        self.fixture = FrameBundleFixture(self.base)
        self.config = mock.patch.object(bundle_runtime, "DEFAULT_CONFIG", str(self.base / "config.toml"))
        self.config.start()
        self.addCleanup(self.config.stop)
        self.environment = mock.patch.dict(
            os.environ,
            {
                "AVIAN_FRAME_BUNDLE_ROOT": str(self.fixture.root),
                "AVIAN_FRAME_BUNDLE_DEV_ROOT": str(self.fixture.dev),
            },
            clear=False,
        )
        self.environment.start()

    def tearDown(self) -> None:
        self.environment.stop()
        self.temporary.cleanup()

    def test_use_by_id_installs_activates_resolves_and_is_idempotent(self) -> None:
        first = bundle_runtime.use(self.fixture.pack["id"])
        self.assertTrue(first["changed"])
        active = bundle_runtime.active_bundle()
        assert active is not None
        self.assertEqual(active.reference["revision"], self.fixture.manifest_hash)
        self.assertEqual(
            active.resolve("Corvus corax", "perched").read_bytes(), self.fixture.png
        )
        self.assertIsNone(active.resolve("Calypte anna", "perched"))
        self.assertTrue(active.dims_path.is_file())
        self.assertTrue(active.masks_path.is_file())
        assets = active.assets_response()
        self.assertEqual(set(assets), {"ok", "active", "dims", "masks"})
        self.assertEqual(
            assets["active"],
            {
                "id": self.fixture.pack["id"],
                "version": self.fixture.pack["version"],
                "revision": self.fixture.manifest_hash,
                "included": False,
                "name": self.fixture.pack["name"],
                "content_revision": active.reference["selection_revision"],
                "selection_revision": active.reference["selection_revision"],
                "species_count": 1,
                "pose_count": 1,
            },
        )
        self.assertEqual(set(assets["dims"]), {"corvus-corax"})
        self.assertEqual(set(assets["masks"]), {"corvus-corax"})

        repeated = bundle_runtime.use(self.fixture.pack["manifest"]["url"])
        self.assertFalse(repeated["changed"])

    def test_selector_never_treats_url_variants_as_download_authority(self) -> None:
        catalog = {"packs": [self.fixture.pack]}
        self.assertEqual(
            bundle_runtime.resolve_selector(catalog, self.fixture.pack["id"]),
            self.fixture.pack,
        )
        self.assertEqual(
            bundle_runtime.resolve_selector(
                catalog, self.fixture.pack["manifest"]["url"]
            ),
            self.fixture.pack,
        )
        for selector in (
            self.fixture.pack["manifest"]["url"] + "?download=1",
            self.fixture.pack["manifest"]["url"].replace(
                "avianvisitors.com", "example.com"
            ),
            "https://avianvisitors.com:bad/api/bundles/manifests/" + "a" * 64 + ".json",
            " https://avianvisitors.com/",
        ):
            with self.subTest(selector=selector):
                with self.assertRaises(bundle_runtime.BundleError):
                    bundle_runtime.resolve_selector(catalog, selector)

    def test_vendored_catalog_uses_install_payloads_and_rejects_discovery_urls(self) -> None:
        catalog = bundle_runtime._vendor_catalog()
        expected = {
            "official-western-us-woodblock": (
                "019d21f5f54b1a68a4510b089544eb7316a3db54dfd37fc129b950eeeffa591f",
                131283,
            ),
            "official-western-us-impressionist": (
                "e069f2ee62cef44d923e136d8eb2011b36ef45d1da46a4cc441ef1916fc3a402",
                131310,
            ),
        }
        self.assertEqual(
            {
                pack["id"]: (pack["manifest"]["sha256"], pack["manifest"]["bytes"])
                for pack in catalog["packs"]
            },
            expected,
        )
        for digest in (
            "31fcb450f517acb2ea26b1c559cc3aad1696f583587209bd2a43058d8e6803e1",
            "9d071dba2ef81084d483374a13c852785faa64898b9db461e7b28abb4c7d426b",
        ):
            with self.subTest(digest=digest):
                with self.assertRaises(bundle_runtime.BundleError) as raised:
                    bundle_runtime.resolve_selector(
                        catalog, bundle_runtime._manifest_url(digest)
                    )
                self.assertEqual(raised.exception.code, "unknown_bundle")

    def test_same_date_catalog_equivocation_is_rejected(self) -> None:
        bundle_runtime.use(self.fixture.pack["id"])
        changed = dict(self.fixture.pack)
        changed["name"] = "Different Name"
        self.fixture.write_catalog(packs=[changed])
        with self.assertRaises(bundle_runtime.BundleError) as raised:
            bundle_runtime.use(self.fixture.pack["id"])
        self.assertEqual(raised.exception.code, "catalog_equivocation")

    def test_catalog_rejects_rollback_and_equal_precedence_rebinding(self) -> None:
        bundle_runtime.use(self.fixture.pack["id"])
        for version, code in (
            ("1.2.2", "catalog_rollback"),
            ("1.2.3+different-build", "catalog_rebinding"),
        ):
            changed = copy.deepcopy(self.fixture.pack)
            changed["version"] = version
            self.fixture.write_catalog(updated="2026-09-09", packs=[changed])
            with self.subTest(version=version):
                with self.assertRaises(bundle_runtime.BundleError) as raised:
                    bundle_runtime.use(self.fixture.pack["id"])
                self.assertEqual(raised.exception.code, code)
            self.fixture.write_catalog()

    def test_community_catalog_cannot_shadow_vendored_official_id(self) -> None:
        official = bundle_runtime._vendor_catalog()["packs"][0]
        protected = copy.deepcopy(self.fixture.pack)
        protected["id"] = official["id"]
        self.fixture.write_catalog(packs=[protected])
        with self.assertRaises(bundle_runtime.BundleError) as raised:
            bundle_runtime.use(official["id"])
        self.assertEqual(raised.exception.code, "catalog_collision")
        self.assertFalse(
            (self.fixture.root / "community-catalog-v1.json").exists()
        )

    def test_render_failure_rolls_back_the_exact_previous_state(self) -> None:
        before = bundle_runtime._load_state(self.fixture.root)
        with self.assertRaises(bundle_runtime.BundleError) as raised:
            bundle_runtime.use(
                self.fixture.pack["id"],
                render=mock.Mock(side_effect=RuntimeError("panel failed")),
            )
        self.assertEqual(raised.exception.code, "render_failed")
        self.assertEqual(bundle_runtime._load_state(self.fixture.root), before)

    def test_failed_rollback_restores_state_and_rerenders_active_bundle(self) -> None:
        reference = bundle_runtime.use(self.fixture.pack["id"])["bundle"]
        before = {
            "format": "avian-birdframe-active-bundle",
            "format_version": 1,
            "active": None,
            "previous": reference,
        }
        bundle_runtime._save_state(self.fixture.root, before)
        render = mock.Mock(side_effect=RuntimeError("panel failed"))
        with self.assertRaises(bundle_runtime.BundleError) as raised:
            bundle_runtime.rollback(render=render)
        self.assertEqual(raised.exception.code, "render_failed")
        self.assertEqual(bundle_runtime._load_state(self.fixture.root), before)
        self.assertEqual(render.call_count, 2)

    def test_active_object_symlink_is_rejected_without_following_it(self) -> None:
        bundle_runtime.use(self.fixture.pack["id"])
        active = bundle_runtime.active_bundle()
        assert active is not None
        object_path = bundle_runtime._object_path(
            self.fixture.root, self.fixture.object_hash
        )
        target = self.base / "sentinel.png"
        target.write_bytes(self.fixture.png)
        object_path.unlink()
        object_path.symlink_to(target)
        with self.assertRaises(bundle_runtime.BundleError):
            active.resolve("Corvus corax", "perched")
        self.assertEqual(target.read_bytes(), self.fixture.png)

    def test_active_pack_rejects_a_symlinked_version_ancestor(self) -> None:
        reference = bundle_runtime.use(self.fixture.pack["id"])["bundle"]
        version_dir = (
            self.fixture.root
            / "packs"
            / reference["id"]
            / reference["version"]
        )
        relocated = self.base / "relocated-version"
        version_dir.rename(relocated)
        version_dir.symlink_to(relocated, target_is_directory=True)
        with self.assertRaises(bundle_runtime.BundleError) as raised:
            bundle_runtime.active_bundle()
        self.assertEqual(raised.exception.code, "unsafe_storage")

    def test_active_pack_rejects_a_symlinked_object_prefix(self) -> None:
        bundle_runtime.use(self.fixture.pack["id"])
        prefix = bundle_runtime._object_path(
            self.fixture.root, self.fixture.object_hash
        ).parent
        relocated = self.base / "relocated-objects"
        prefix.rename(relocated)
        prefix.symlink_to(relocated, target_is_directory=True)
        with self.assertRaises(bundle_runtime.BundleError) as raised:
            bundle_runtime.active_bundle()
        self.assertEqual(raised.exception.code, "unsafe_storage")

    def test_active_object_is_rehashed_on_every_resolution(self) -> None:
        bundle_runtime.use(self.fixture.pack["id"])
        active = bundle_runtime.active_bundle()
        assert active is not None
        object_path = active.resolve("Corvus corax", "perched")
        assert object_path is not None
        damaged = bytearray(self.fixture.png)
        damaged[-1] ^= 1
        object_path.chmod(0o600)
        object_path.write_bytes(damaged)
        object_path.chmod(0o444)
        with self.assertRaises(bundle_runtime.BundleError) as raised:
            active.resolve("Corvus corax", "perched")
        self.assertEqual(raised.exception.code, "invalid_install")

    def test_active_index_must_match_the_checksum_bound_manifest(self) -> None:
        installed = bundle_runtime.use(self.fixture.pack["id"])["bundle"]
        index_path = bundle_runtime._pack_dir(self.fixture.root, installed) / "index.json"
        index = json.loads(index_path.read_text())
        index["assets"] = {}
        index_path.write_bytes(canonical(index))
        with self.assertRaises(bundle_runtime.BundleError) as raised:
            bundle_runtime.active_bundle()
        self.assertEqual(raised.exception.code, "invalid_install")

    def test_active_geometry_inventory_and_values_are_validated(self) -> None:
        installed = bundle_runtime.use(self.fixture.pack["id"])["bundle"]
        pack_dir = bundle_runtime._pack_dir(self.fixture.root, installed)
        (pack_dir / "dims.json").write_bytes(canonical({"corvus-corax": [0, 1]}))
        with self.assertRaises(bundle_runtime.BundleError) as raised:
            bundle_runtime.active_bundle()
        self.assertEqual(raised.exception.code, "invalid_install")

    def test_manifest_rejects_distinct_species_that_share_a_runtime_slug(self) -> None:
        manifest = copy.deepcopy(self.fixture.manifest)
        first = manifest["species"][0]
        first["scientific_name"] = "Foo bar-baz"
        first["poses"][0]["file"] = "illustrations/foo-bar-baz.png"
        second = copy.deepcopy(first)
        second["scientific_name"] = "Foo bar baz"
        second["poses"][0]["id"] = "flight"
        second["poses"][0]["file"] = "illustrations/foo-bar-baz-2.png"
        manifest["species"].append(second)
        with self.assertRaises(bundle_runtime.BundleError) as raised:
            bundle_runtime._validate_manifest(canonical(manifest), self.fixture.pack)
        self.assertEqual(raised.exception.code, "invalid_manifest")

    def test_manifest_normalizes_station_accepted_scientific_name_spacing(self) -> None:
        manifest = copy.deepcopy(self.fixture.manifest)
        manifest["species"][0]["scientific_name"] = "Corvus   corax"
        checked = bundle_runtime._validate_manifest(
            canonical(manifest),
            {"id": manifest["id"], "version": manifest["version"]},
        )
        self.assertEqual(
            checked["species"][0]["scientific_name"], "Corvus corax"
        )
        self.assertEqual(set(checked["assets"]), {"corvus-corax"})

    def test_manifest_contract_rejects_missing_and_unknown_fields(self) -> None:
        cases = []
        for field in ("style", "coverage", "license", "attribution"):
            value = copy.deepcopy(self.fixture.manifest)
            del value[field]
            cases.append((f"missing {field}", value))
        executable = copy.deepcopy(self.fixture.manifest)
        executable["executable"] = "post-install.sh"
        cases.append(("top-level executable", executable))
        nested = copy.deepcopy(self.fixture.manifest)
        nested["species"][0]["poses"][0]["script"] = "run-me"
        cases.append(("nested script", nested))
        for label, manifest in cases:
            with self.subTest(label=label):
                with self.assertRaises(bundle_runtime.BundleError) as raised:
                    bundle_runtime._validate_manifest(
                        canonical(manifest),
                        {"id": self.fixture.manifest["id"], "version": "1.2.3"},
                    )
                self.assertEqual(raised.exception.code, "invalid_manifest")

    def test_community_catalog_contract_rejects_unknown_review_and_official_ids(self) -> None:
        cases = []
        unknown = copy.deepcopy(self.fixture.pack)
        unknown["install_hook"] = "run-me"
        cases.append(("unknown field", unknown, "invalid_catalog"))
        wrong_review = copy.deepcopy(self.fixture.pack)
        wrong_review["review"] = "official"
        cases.append(("wrong review", wrong_review, "invalid_catalog"))
        official = copy.deepcopy(self.fixture.pack)
        official["id"] = "official-community-shadow"
        cases.append(("official prefix", official, "catalog_collision"))
        repository_port = copy.deepcopy(self.fixture.pack)
        repository_port["repository_url"] = (
            "https://github.com:8443/avian-visitors/qa-frame-birds"
        )
        cases.append(("repository port", repository_port, "invalid_catalog"))
        repository_traversal = copy.deepcopy(self.fixture.pack)
        repository_traversal["repository_url"] = (
            "https://github.com/avian-visitors/%2e%2e/qa-frame-birds"
        )
        cases.append(("repository traversal", repository_traversal, "invalid_catalog"))
        for label, pack, code in cases:
            self.fixture.write_catalog(packs=[pack])
            with self.subTest(label=label):
                with self.assertRaises(bundle_runtime.BundleError) as raised:
                    bundle_runtime.refresh_catalog(self.fixture.root)
                self.assertEqual(raised.exception.code, code)
        self.assertFalse((self.fixture.root / "community-catalog-v1.json").exists())

    def test_future_catalog_is_rejected_before_it_can_poison_the_cache_floor(self) -> None:
        self.fixture.write_catalog(updated="2999-01-01T00:00:00.000Z")
        with self.assertRaises(bundle_runtime.BundleError) as raised:
            bundle_runtime.use(self.fixture.pack["id"])
        self.assertEqual(raised.exception.code, "catalog_future")
        self.assertFalse((self.fixture.root / "community-catalog-v1.json").exists())
        self.assertFalse(
            (self.fixture.root / "community-catalog-bindings-v1.json").exists()
        )

    def test_catalog_binding_history_survives_delist_and_exact_reappearance(self) -> None:
        bundle_runtime.use(self.fixture.pack["id"])
        self.fixture.write_catalog(updated=catalog_timestamp(1), packs=[])
        merged = bundle_runtime.refresh_catalog(self.fixture.root)
        self.assertNotIn(self.fixture.pack["id"], {item["id"] for item in merged["packs"]})

        downgraded = copy.deepcopy(self.fixture.pack)
        downgraded["version"] = "1.2.2"
        self.fixture.write_catalog(updated=catalog_timestamp(2), packs=[downgraded])
        with self.assertRaises(bundle_runtime.BundleError) as raised:
            bundle_runtime.refresh_catalog(self.fixture.root)
        self.assertEqual(raised.exception.code, "catalog_rollback")

        rebound = copy.deepcopy(self.fixture.pack)
        rebound["manifest"] = {
            "url": bundle_runtime._manifest_url("b" * 64),
            "sha256": "b" * 64,
            "bytes": rebound["manifest"]["bytes"],
        }
        self.fixture.write_catalog(updated=catalog_timestamp(3), packs=[rebound])
        with self.assertRaises(bundle_runtime.BundleError) as raised:
            bundle_runtime.refresh_catalog(self.fixture.root)
        self.assertEqual(raised.exception.code, "catalog_rebinding")

        self.fixture.write_catalog(updated=catalog_timestamp(4), packs=[self.fixture.pack])
        merged = bundle_runtime.refresh_catalog(self.fixture.root)
        self.assertEqual(
            bundle_runtime.resolve_selector(merged, self.fixture.pack["id"])["manifest"],
            self.fixture.pack["manifest"],
        )
        history = json.loads(
            (self.fixture.root / "community-catalog-bindings-v1.json").read_text()
        )
        self.assertEqual(
            history["ids"][self.fixture.pack["id"]]["versions"]["1.2.3"],
            hashlib.sha256(canonical(self.fixture.pack)).hexdigest(),
        )

    def test_catalog_revision_history_survives_missing_or_corrupt_cache(self) -> None:
        original_updated = "2026-09-08T12:00:00.000Z"
        bundle_runtime._ensure_root(self.fixture.root)
        self.fixture.write_catalog(updated=original_updated)
        bundle_runtime.refresh_catalog(self.fixture.root)
        cache = self.fixture.root / "community-catalog-v1.json"
        history = self.fixture.root / "community-catalog-bindings-v1.json"
        history_bytes = history.read_bytes()

        cache.unlink()
        self.fixture.write_catalog(
            updated="2026-09-08T11:59:59.999Z", packs=[]
        )
        with self.assertRaises(bundle_runtime.BundleError) as raised:
            bundle_runtime.refresh_catalog(self.fixture.root)
        self.assertEqual(raised.exception.code, "catalog_rollback")
        self.assertFalse(cache.exists())
        self.assertEqual(history.read_bytes(), history_bytes)

        self.fixture.write_catalog(updated=original_updated, packs=[])
        with self.assertRaises(bundle_runtime.BundleError) as raised:
            bundle_runtime.refresh_catalog(self.fixture.root)
        self.assertEqual(raised.exception.code, "catalog_equivocation")
        self.assertFalse(cache.exists())

        self.fixture.write_catalog(updated=original_updated)
        bundle_runtime.refresh_catalog(self.fixture.root)
        cache.write_bytes(b"{broken\n")
        self.fixture.write_catalog(
            updated="2026-09-08T11:59:59.999Z", packs=[]
        )
        with self.assertRaises(bundle_runtime.BundleError) as raised:
            bundle_runtime.refresh_catalog(self.fixture.root)
        self.assertEqual(raised.exception.code, "catalog_rollback")
        self.assertEqual(cache.read_bytes(), b"{broken\n")

    def test_manifest_accepts_5000_species_and_rejects_5001(self) -> None:
        manifest = copy.deepcopy(self.fixture.manifest)
        template = manifest["species"][0]
        species = []
        for number in range(5000):
            scientific = unique_scientific_name(number)
            bird = copy.deepcopy(template)
            bird["scientific_name"] = scientific
            bird["poses"][0]["file"] = (
                "illustrations/" + bundle_runtime._slug(scientific) + ".png"
            )
            species.append(bird)
        manifest["species"] = species
        validated = bundle_runtime._validate_manifest(
            canonical(manifest), {"id": manifest["id"], "version": manifest["version"]}
        )
        self.assertEqual(len(validated["assets"]), 5000)
        manifest["species"].append(copy.deepcopy(species[-1]))
        with self.assertRaises(bundle_runtime.BundleError) as raised:
            bundle_runtime._validate_manifest(
                canonical(manifest),
                {"id": manifest["id"], "version": manifest["version"]},
            )
        self.assertEqual(raised.exception.code, "invalid_manifest")

    def test_dedicated_table_limit_exceeds_manifest_limit(self) -> None:
        table = self.base / "large-table.json"
        raw = b'{"padding":"' + b"x" * (bundle_runtime.MANIFEST_MAX + 1) + b'"}\n'
        table.write_bytes(raw)
        with self.assertRaises(bundle_runtime.BundleError):
            bundle_runtime._safe_file(
                table, bundle_runtime.MANIFEST_MAX, allow_writable=True
            )
        self.assertEqual(
            bundle_runtime._json(
                bundle_runtime._safe_file(
                    table, bundle_runtime.TABLE_MAX, allow_writable=True
                ),
                "large table",
            )["padding"],
            "x" * (bundle_runtime.MANIFEST_MAX + 1),
        )
        self.assertGreaterEqual(bundle_runtime.TABLE_MAX, 16 * 1024 * 1024)

        boundary = self.base / "table-boundary.bin"
        with boundary.open("wb") as handle:
            handle.truncate(bundle_runtime.TABLE_MAX)
        self.assertEqual(
            len(
                bundle_runtime._safe_file(
                    boundary,
                    bundle_runtime.TABLE_MAX,
                    allow_writable=True,
                )
            ),
            bundle_runtime.TABLE_MAX,
        )
        with boundary.open("r+b") as handle:
            handle.truncate(bundle_runtime.TABLE_MAX + 1)
        with self.assertRaises(bundle_runtime.BundleError):
            bundle_runtime._safe_file(
                boundary,
                bundle_runtime.TABLE_MAX,
                allow_writable=True,
            )

    def test_retry_repairs_corrupt_object_and_installed_tables(self) -> None:
        reference = bundle_runtime.use(self.fixture.pack["id"])["bundle"]
        final = bundle_runtime._pack_dir(self.fixture.root, reference)
        object_path = bundle_runtime._object_path(
            self.fixture.root, self.fixture.object_hash
        )
        object_path.chmod(0o600)
        object_path.write_bytes(b"x" * len(self.fixture.png))
        object_path.chmod(0o444)
        (final / "masks.json").write_bytes(b"{}\n")

        repeated = bundle_runtime.use(self.fixture.pack["id"])

        self.assertFalse(repeated["changed"])
        self.assertEqual(object_path.read_bytes(), self.fixture.png)
        active = bundle_runtime.active_bundle()
        assert active is not None
        self.assertIn("corvus-corax", active.assets_response()["masks"])

    def test_late_table_limit_failure_leaves_existing_revision_untouched(self) -> None:
        reference = bundle_runtime.use(self.fixture.pack["id"])["bundle"]
        final = bundle_runtime._pack_dir(self.fixture.root, reference)
        corrupt = b"{}\n"
        (final / "masks.json").write_bytes(corrupt)
        with mock.patch.object(bundle_runtime, "TABLE_MAX", 10):
            with self.assertRaises(bundle_runtime.BundleError) as raised:
                bundle_runtime.use(self.fixture.pack["id"])
        self.assertEqual(raised.exception.code, "bundle_too_large")
        self.assertEqual((final / "masks.json").read_bytes(), corrupt)

    def test_cli_uses_renderer_configured_custom_root_and_ignores_root_override(self) -> None:
        home = self.base / "cli-home"
        config_dir = home / ".birdframe"
        config_dir.mkdir(parents=True)
        custom_root = self.base / "custom-bundle-root"
        poisoned_root = self.base / "wrong-root"
        (config_dir / "config.toml").write_text(
            "bundle_root = " + json.dumps(str(custom_root)) + "\n"
        )
        environment = os.environ.copy()
        environment.update(
            {
                "HOME": str(home),
                "AVIAN_FRAME_BUNDLE_DEV_ROOT": str(self.fixture.dev),
                "AVIAN_FRAME_BUNDLE_ROOT": str(poisoned_root),
                "PYTHONDONTWRITEBYTECODE": "1",
            }
        )
        completed = subprocess.run(
            [
                sys.executable,
                str(Path(bundle_runtime.__file__).resolve()),
                "use",
                self.fixture.pack["id"],
                "--no-render",
                "--json",
            ],
            env=environment,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertTrue(json.loads(completed.stdout)["ok"])
        self.assertTrue((custom_root / "active.json").is_file())
        self.assertFalse(poisoned_root.exists())

    def test_render_callback_strips_python_injection_environment(self) -> None:
        poisoned = {
            "PYTHONBREAKPOINT": "hook.run",
            "PYTHONHOME": "/tmp/fake-python",
            "PYTHONINSPECT": "1",
            "PYTHONPATH": "/tmp/fake-modules",
            "PYTHONSTARTUP": "/tmp/startup.py",
            "PYTHONWARNINGS": "error",
        }
        with mock.patch.dict(os.environ, poisoned, clear=False), mock.patch.object(
            bundle_runtime.subprocess,
            "run",
            return_value=mock.Mock(returncode=0),
        ) as run:
            bundle_runtime._render_callback()
        environment = run.call_args.kwargs["env"]
        for name in poisoned:
            self.assertNotIn(name, environment)
        self.assertEqual(environment["PYTHONNOUSERSITE"], "1")
        self.assertEqual(environment["PYTHONDONTWRITEBYTECODE"], "1")
        self.assertFalse(run.call_args.kwargs["check"])

    def test_location_install_fetches_only_selected_objects_and_keeps_full_manifest(self) -> None:
        hashes = self.fixture.add_species()
        basis = {"schema_version": 1, "species": ["Calypte anna", "Corvus corax"], "basis_sha256": "a" * 64}
        with mock.patch.object(bundle_runtime, "_resolve_selection_basis", return_value=basis), \
             mock.patch.object(bundle_runtime, "_download", wraps=bundle_runtime._download) as download:
            result = bundle_runtime.use(self.fixture.pack["id"])
        active = bundle_runtime.active_bundle()
        self.assertEqual(active.drawable_slugs, {"calypte-anna", "corvus-corax"})
        self.assertEqual((active.directory / "manifest.json").read_bytes(), self.fixture.manifest_raw)
        receipt_raw = (active.directory / "selection.json").read_bytes()
        receipt = json.loads(receipt_raw)
        self.assertEqual(receipt, {"schema_version": 1, "mode": "local", "manifest_sha256": self.fixture.manifest_hash,
                                   "species": basis["species"], "basis_sha256": basis["basis_sha256"]})
        selection_revision = hashlib.sha256(receipt_raw).hexdigest()
        self.assertEqual(result["bundle"]["selection_revision"], selection_revision)
        self.assertEqual(active.assets_response()["active"]["content_revision"], selection_revision)
        requested_objects = {call.args[0] for call in download.call_args_list if "/objects/" in call.args[0]}
        self.assertEqual(requested_objects, {bundle_runtime._object_url(hashes[name]) for name in basis["species"]})
        self.assertFalse(bundle_runtime._object_path(self.fixture.root, hashes["Haemorhous mexicanus"]).exists())

    def test_all_species_override_skips_location_and_downloads_full_inventory(self) -> None:
        self.fixture.add_species()
        with mock.patch.object(bundle_runtime, "_resolve_selection_basis", side_effect=RuntimeError("offline")) as resolve:
            bundle_runtime.use(self.fixture.pack["id"], all_species=True)
        resolve.assert_not_called()
        active = bundle_runtime.active_bundle()
        self.assertEqual(len(active.drawable_slugs), 3)
        self.assertEqual(json.loads((active.directory / "selection.json").read_bytes())["mode"], "all")

    def test_location_change_creates_a_distinct_selection_and_rolls_back_exactly(self) -> None:
        self.fixture.add_species()
        first_basis = {"schema_version": 1, "species": ["Corvus corax"], "basis_sha256": "a" * 64}
        second_basis = {"schema_version": 1, "species": ["Calypte anna"], "basis_sha256": "b" * 64}
        with mock.patch.object(bundle_runtime, "_resolve_selection_basis", return_value=first_basis):
            first = bundle_runtime.use(self.fixture.pack["id"])["bundle"]
        with mock.patch.object(bundle_runtime, "_resolve_selection_basis", return_value=second_basis):
            second = bundle_runtime.use(self.fixture.pack["id"])["bundle"]
            self.assertFalse(bundle_runtime.use(self.fixture.pack["id"])["changed"])
        self.assertEqual(first["revision"], second["revision"])
        self.assertNotEqual(first["selection_revision"], second["selection_revision"])
        self.assertTrue(bundle_runtime._pack_dir(self.fixture.root, first).is_dir())
        bundle_runtime.rollback()
        self.assertEqual(bundle_runtime.active_bundle().reference, first)
        self.assertEqual(bundle_runtime.active_bundle().drawable_slugs, {"corvus-corax"})

    def test_unrelated_local_species_reuses_profile_without_rendering_again(self) -> None:
        self.fixture.add_species()
        first_basis = {"schema_version": 1, "species": ["Corvus corax"], "basis_sha256": "a" * 64}
        second_basis = {"schema_version": 1, "species": ["Corvus corax", "Passer domesticus"],
                        "basis_sha256": "b" * 64}
        renders = []
        with mock.patch.object(bundle_runtime, "_resolve_selection_basis", return_value=first_basis):
            first = bundle_runtime.use(self.fixture.pack["id"], render=lambda: renders.append("rendered"))
        directory = bundle_runtime._pack_dir(self.fixture.root, first["bundle"])
        receipt = (directory / "selection.json").read_bytes()
        with mock.patch.object(bundle_runtime, "_resolve_selection_basis", return_value=second_basis):
            second = bundle_runtime.use(self.fixture.pack["id"], render=lambda: renders.append("rendered"))
        self.assertEqual(second["bundle"], first["bundle"])
        self.assertFalse(second["changed"])
        self.assertEqual(renders, ["rendered"])
        self.assertEqual((directory / "selection.json").read_bytes(), receipt)
        self.assertEqual(list(directory.parent.iterdir()), [directory])

    def test_equivalent_profile_reuse_rejects_corrupt_cached_inventory(self) -> None:
        self.fixture.add_species()
        first_basis = {"schema_version": 1, "species": ["Corvus corax"], "basis_sha256": "a" * 64}
        second_basis = {"schema_version": 1, "species": ["Corvus corax", "Passer domesticus"],
                        "basis_sha256": "b" * 64}
        with mock.patch.object(bundle_runtime, "_resolve_selection_basis", return_value=first_basis):
            first = bundle_runtime.use(self.fixture.pack["id"])["bundle"]
        directory = bundle_runtime._pack_dir(self.fixture.root, first)
        index = json.loads((directory / "index.json").read_bytes())
        index["assets"] = {}
        (directory / "index.json").write_bytes(canonical(index))
        with mock.patch.object(bundle_runtime, "_resolve_selection_basis", return_value=second_basis):
            second = bundle_runtime.use(self.fixture.pack["id"])["bundle"]
        self.assertNotEqual(second, first)
        self.assertEqual(bundle_runtime.active_bundle().drawable_slugs, {"corvus-corax"})

    def test_equivalent_profile_reuse_prefers_the_active_profile(self) -> None:
        self.fixture.add_species()
        basis = {"schema_version": 1, "species": ["Corvus corax"], "basis_sha256": "a" * 64}
        other_basis = {**basis, "basis_sha256": "b" * 64}
        with mock.patch.object(bundle_runtime, "_resolve_selection_basis", return_value=basis):
            first = bundle_runtime.use(self.fixture.pack["id"])["bundle"]
            with mock.patch.object(bundle_runtime, "_equivalent_selection_reference", return_value=None):
                duplicate = bundle_runtime._install(self.fixture.root, self.fixture.pack, other_basis)
            render = mock.Mock()
            repeated = bundle_runtime.use(self.fixture.pack["id"], render=render)
        self.assertNotEqual(first, duplicate)
        self.assertEqual(repeated["bundle"], first)
        self.assertFalse(repeated["changed"])
        render.assert_not_called()

    def test_rollback_rejects_corrupt_previous_selection_before_activation(self) -> None:
        self.fixture.add_species()
        first = bundle_runtime.use(self.fixture.pack["id"], all_species=True)["bundle"]
        basis = {"schema_version": 1, "species": ["Corvus corax"], "basis_sha256": "a" * 64}
        with mock.patch.object(bundle_runtime, "_resolve_selection_basis", return_value=basis):
            bundle_runtime.use(self.fixture.pack["id"])
        before = bundle_runtime._load_state(self.fixture.root)
        (bundle_runtime._pack_dir(self.fixture.root, first) / "selection.json").write_bytes(b"{}\n")
        with self.assertRaises(bundle_runtime.BundleError):
            bundle_runtime.rollback()
        self.assertEqual(bundle_runtime._load_state(self.fixture.root), before)

    def test_malformed_selection_receipt_and_extra_inventory_fail_closed(self) -> None:
        self.fixture.add_species()
        basis = {"schema_version": 1, "species": ["Corvus corax"], "basis_sha256": "a" * 64}
        with mock.patch.object(bundle_runtime, "_resolve_selection_basis", return_value=basis):
            reference = bundle_runtime.use(self.fixture.pack["id"])["bundle"]
        directory = bundle_runtime._pack_dir(self.fixture.root, reference)
        receipt_path = directory / "selection.json"
        original = receipt_path.read_bytes()
        for raw in (original.replace(b'"mode":"local"', b'"mode":"all"'), b"{}\n", original + b"\n"):
            with self.subTest(raw=raw):
                receipt_path.write_bytes(raw)
                with self.assertRaises(bundle_runtime.BundleError):
                    bundle_runtime.active_bundle()
        receipt_path.write_bytes(original)
        (directory / "unlisted.txt").write_text("extra")
        with self.assertRaises(bundle_runtime.BundleError):
            bundle_runtime.active_bundle()

    def test_empty_selection_or_resolver_failure_preserves_the_active_bundle(self) -> None:
        self.fixture.add_species()
        bundle_runtime.use(self.fixture.pack["id"], all_species=True)
        before = bundle_runtime._load_state(self.fixture.root)
        for basis in ({"schema_version": 1, "species": ["Passer domesticus"], "basis_sha256": "a" * 64},
                      {"schema_version": 1, "species": [], "basis_sha256": "a" * 64}):
            with mock.patch.object(bundle_runtime, "_resolve_selection_basis", return_value=basis):
                with self.assertRaises(bundle_runtime.BundleError):
                    bundle_runtime.use(self.fixture.pack["id"])
            self.assertEqual(bundle_runtime._load_state(self.fixture.root), before)
        with mock.patch.object(bundle_runtime, "_resolve_selection_basis", side_effect=bundle_runtime.BundleError("offline", "location_unavailable")):
            with self.assertRaises(bundle_runtime.BundleError):
                bundle_runtime.use(self.fixture.pack["id"])
        self.assertEqual(bundle_runtime._load_state(self.fixture.root), before)

    def test_failed_subset_render_restores_previous_selection(self) -> None:
        self.fixture.add_species()
        bundle_runtime.use(self.fixture.pack["id"], all_species=True)
        before = bundle_runtime._load_state(self.fixture.root)
        basis = {"schema_version": 1, "species": ["Corvus corax"], "basis_sha256": "a" * 64}
        with mock.patch.object(bundle_runtime, "_resolve_selection_basis", return_value=basis):
            with self.assertRaises(bundle_runtime.BundleError) as raised:
                bundle_runtime.use(self.fixture.pack["id"], render=mock.Mock(side_effect=RuntimeError("panel failed")))
        self.assertEqual(raised.exception.code, "render_failed")
        self.assertEqual(bundle_runtime._load_state(self.fixture.root), before)
        self.assertEqual(len(bundle_runtime.active_bundle().drawable_slugs), 3)

    def test_legacy_full_install_remains_valid_alongside_new_selections(self) -> None:
        reference = bundle_runtime.use(self.fixture.pack["id"], all_species=True)["bundle"]
        selected = bundle_runtime._pack_dir(self.fixture.root, reference)
        legacy_reference = {key: value for key, value in reference.items() if key != "selection_revision"}
        legacy = bundle_runtime._pack_dir(self.fixture.root, legacy_reference)
        for filename in ("manifest.json", "dims.json", "masks.json"):
            (legacy / filename).write_bytes((selected / filename).read_bytes())
        index = json.loads((selected / "index.json").read_bytes())
        index["reference"] = legacy_reference
        (legacy / "index.json").write_bytes(canonical(index))
        for filename in ("manifest.json", "dims.json", "masks.json", "index.json"):
            (legacy / filename).chmod(0o600)
        state = bundle_runtime._load_state(self.fixture.root)
        state["active"] = legacy_reference
        bundle_runtime._save_state(self.fixture.root, state)
        active = bundle_runtime.active_bundle()
        self.assertEqual(active.reference, legacy_reference)
        self.assertEqual(active.assets_response()["active"]["content_revision"], self.fixture.manifest_hash)
        self.assertEqual(active.resolve("Corvus corax", "perched").read_bytes(), self.fixture.png)

    def test_location_resolver_uses_exact_birdweather_station_and_annual_model(self) -> None:
        basis = {"schema_version": 1, "species": ["Corvus corax"], "basis_sha256": "a" * 64}
        weather = mock.Mock()
        weather.station_location.return_value = (37.7, -122.4)
        weather.top_species_for_station.return_value = [{"sci": "Calypte anna", "n": 1}]
        helper = mock.Mock()
        helper.annual_species.return_value = basis
        with mock.patch.object(bundle_runtime, "_load_checkout_module", side_effect=[weather, helper]):
            actual = bundle_runtime._resolve_selection_basis({"species_source": "birdweather", "bw_station_id": "42"})
        self.assertEqual(actual["species"], ["Calypte anna", "Corvus corax"])
        self.assertEqual(actual["basis_sha256"], hashlib.sha256(canonical({"model": basis["basis_sha256"], "extras": ["Calypte anna"]})).hexdigest())
        weather.station_location.assert_called_once_with("42")
        weather.top_species_for_station.assert_called_once_with("42", days=7, limit=200)
        weather.top_species.assert_not_called()
        weather.geocode.assert_not_called()
        helper.annual_species.assert_called_once_with(37.7, -122.4, Path(bundle_runtime.__file__).resolve().parent.parent / "model")

    def test_mirror_location_endpoint_distinguishes_unset_from_invalid(self) -> None:
        config = {"shoot": True}
        responses = [
            {"ok": True, "schema_version": 1, "species": None, "basis_sha256": None},
            {"ok": True, "schema_version": 1, "species": ["Corvus corax"], "basis_sha256": "a" * 64},
            {"ok": False, "error": "offline"},
            {"ok": True, "schema_version": 1, "species": None, "basis_sha256": "a" * 64},
        ]
        for index, value in enumerate(responses):
            with self.subTest(value=value):
                response = mock.MagicMock()
                response.__enter__.return_value = response
                response.read.return_value = canonical(value)
                opener = mock.Mock()
                opener.open.return_value = response
                with mock.patch.object(bundle_runtime.urllib.request, "build_opener", return_value=opener):
                    if index < 2:
                        actual = bundle_runtime._resolve_selection_basis(config)
                        self.assertEqual(actual, None if index == 0 else {key: item for key, item in value.items() if key != "ok"})
                    else:
                        with self.assertRaises(bundle_runtime.BundleError):
                            bundle_runtime._resolve_selection_basis(config)
                self.assertEqual(opener.open.call_args.args[0].full_url, "http://birdnet.local/avian/api/bundle-species.php")
                response.read.assert_called_once_with(bundle_runtime.SELECTION_MAX + 1)

    def test_zip_location_keeps_annual_birds_and_observed_area_birds(self) -> None:
        basis = {"schema_version": 1, "species": ["Corvus corax"], "basis_sha256": "a" * 64}
        weather = mock.Mock()
        weather.geocode.return_value = (37.7, -122.4)
        weather.top_species.side_effect = [[{"sci": "Calypte anna"}], [], [{"sci": "Haemorhous mexicanus"}]]
        helper = mock.Mock()
        helper.annual_species.return_value = basis
        with mock.patch.object(bundle_runtime, "_load_checkout_module", side_effect=[weather, helper]):
            actual = bundle_runtime._resolve_selection_basis({"species_source": "birdweather", "zip": "94107", "bw_days": 14})
        self.assertEqual(actual["species"], ["Calypte anna", "Corvus corax", "Haemorhous mexicanus"])
        weather.geocode.assert_called_once_with("94107", "us")
        self.assertEqual(weather.top_species.call_args_list, [mock.call(37.7, -122.4, miles, days=14, limit=200) for miles in (15, 30, 50)])
        weather.station_location.assert_not_called()
        weather.top_species_for_station.assert_not_called()
        weather.triangulate.assert_not_called()


if __name__ == "__main__":
    unittest.main()
