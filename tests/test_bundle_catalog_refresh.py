"""Focused trust, cache, and lifecycle tests for community catalog refresh."""

from __future__ import annotations

import copy
import datetime as dt
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
MANAGER_PATH = ROOT / "avian" / "scripts" / "bundle_manager.py"
SPEC = importlib.util.spec_from_file_location("avian_bundle_refresh_manager", MANAGER_PATH)
assert SPEC is not None and SPEC.loader is not None
bundle_manager = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bundle_manager)

from tests.test_bundle_manager import BundleFixture


class CommunityCatalogRefreshTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="avian-catalog-refresh-")
        self.base = Path(self.temporary.name)
        self.root = self.base / "state"
        self.lock = self.base / "operation.lock"
        self.environment = mock.patch.dict(
            os.environ,
            {
                "AVIAN_BUNDLE_ROOT": str(self.root),
                "AVIAN_BUNDLE_CATALOG": str(ROOT / "avian" / "bundles" / "catalog-v1.json"),
                "AVIAN_BUNDLE_LOCK": str(self.lock),
                "AVIAN_BUNDLE_DB": str(self.base / "missing.db"),
                "AVIAN_BUNDLE_CONFIG": str(self.base / "missing.conf"),
            },
            clear=False,
        )
        self.environment.start()
        self.bundled = bundle_manager.load_bundled_catalog()
        template = copy.deepcopy(self.bundled["packs"][1])
        template.update(
            {
                "id": "community-42-pacific-paint",
                "version": "1.0.0",
                "name": "Pacific Paint",
                "creator": "Field Artist",
                "description": "A community field set.",
                "review": "community",
                "availability": "installable",
            }
        )
        template.pop("local_id", None)
        template.pop("search_terms", None)
        self.community_pack = template
        self.community = {
            "format": bundle_manager.FORMAT_CATALOG,
            "format_version": bundle_manager.FORMAT_VERSION,
            "updated": "2026-09-02",
            "object_base_url": self.bundled["object_base_url"],
            "packs": [template],
        }
        bundle_manager.initialize()

    def tearDown(self) -> None:
        self.environment.stop()
        self.temporary.cleanup()

    def catalog_bytes(self, value: dict | None = None) -> bytes:
        return bundle_manager.canonical_json(value or self.community)

    def refresh(self, value: dict | None = None) -> dict:
        with mock.patch.object(
            bundle_manager, "download_live_catalog_bytes", return_value=self.catalog_bytes(value)
        ):
            return bundle_manager.refresh_catalog()

    def assert_error(self, code: str, callback) -> None:
        with self.assertRaises(bundle_manager.BundleError) as raised:
            callback()
        self.assertEqual(raised.exception.code, code)

    def test_live_feed_is_the_canonical_public_worker_contract(self) -> None:
        self.assertEqual(
            bundle_manager.LIVE_CATALOG_URL,
            "https://avianvisitors.com/api/bundles/catalog/community-v1.json",
        )
        self.assertEqual(bundle_manager.LIVE_CATALOG_HOSTS, frozenset({"avianvisitors.com"}))
        self.assertNotIn("bundles.avianvisitors.com", bundle_manager.LIVE_CATALOG_URL)
        self.assertEqual(
            bundle_manager.parse_community_catalog(
                self.catalog_bytes(), self.bundled, "published station feed"
            ),
            bundle_manager.validate_catalog(copy.deepcopy(self.community)),
        )

    def test_refresh_atomically_adds_only_community_and_never_changes_active(self) -> None:
        before_state = bundle_manager.load_state()
        merged = self.refresh()

        self.assertEqual(merged["packs"][: len(self.bundled["packs"])], self.bundled["packs"])
        self.assertEqual(merged["packs"][-1]["id"], self.community_pack["id"])
        self.assertEqual(bundle_manager.load_catalog(), merged)
        self.assertEqual(bundle_manager.load_state(), before_state)

        cache = bundle_manager.catalog_cache_path()
        self.assertTrue(cache.is_file())
        self.assertFalse(cache.is_symlink())
        self.assertEqual(cache.stat().st_uid, os.geteuid())
        self.assertEqual(cache.stat().st_gid, os.getegid())
        self.assertEqual(cache.stat().st_mode & 0o777, 0o644)
        self.assertEqual(
            bundle_manager.validate_catalog(json.loads(cache.read_text(encoding="utf-8"))),
            bundle_manager.validate_catalog(copy.deepcopy(self.community)),
        )

    def test_official_prefix_review_and_bundled_collisions_are_rejected(self) -> None:
        cases = []
        official_review = copy.deepcopy(self.community)
        official_review["packs"][0]["review"] = "official"
        cases.append(official_review)

        official_prefix = copy.deepcopy(self.community)
        official_prefix["packs"][0]["id"] = "official-community-impostor"
        cases.append(official_prefix)

        bundled_collision = copy.deepcopy(self.community)
        bundled_collision["packs"][0]["id"] = self.bundled["packs"][1]["id"]
        cases.append(bundled_collision)

        for value in cases:
            with self.subTest(bundle=value["packs"][0]["id"]):
                self.assert_error("protected_bundle", lambda value=value: self.refresh(value))
                self.assertFalse(bundle_manager.catalog_cache_path().exists())

    def test_noncanonical_object_route_and_alias_are_rejected(self) -> None:
        wrong_store = copy.deepcopy(self.community)
        wrong_store["object_base_url"] = "https://avianvisitors.com/v1/objects/sha256/"
        self.assert_error("invalid_url", lambda: self.refresh(wrong_store))

        alias = copy.deepcopy(self.community)
        alias["packs"][0]["local_id"] = self.bundled["packs"][0]["id"]
        self.assert_error("invalid_fields", lambda: self.refresh(alias))

    def test_community_feed_rejects_catalog_only_optional_pack_fields(self) -> None:
        for field, value in (
            ("local_id", "legacy-local-alias"),
            ("search_terms", ["legacy search term"]),
        ):
            feed = copy.deepcopy(self.community)
            feed["packs"][0][field] = value
            with self.subTest(field=field):
                self.assert_error("invalid_fields", lambda feed=feed: self.refresh(feed))
                self.assertFalse(bundle_manager.catalog_cache_path().exists())

    def test_date_rollback_and_same_date_changed_content_keep_previous_cache(self) -> None:
        original_feed = copy.deepcopy(self.community)
        original_feed["updated"] = "2026-09-02T14:00:00.100Z"
        original = self.refresh(original_feed)
        original_bytes = bundle_manager.catalog_cache_path().read_bytes()

        same_date = copy.deepcopy(original_feed)
        same_date["packs"][0]["name"] = "Changed without publication date"
        self.assert_error("catalog_equivocation", lambda: self.refresh(same_date))
        self.assertEqual(bundle_manager.catalog_cache_path().read_bytes(), original_bytes)
        self.assertEqual(bundle_manager.load_catalog(), original)

        later_same_date = copy.deepcopy(original_feed)
        later_same_date["updated"] = "2026-09-02T14:00:00.900Z"
        later_same_date["packs"][0]["version"] = "1.0.1"
        later_same_date["packs"][0]["name"] = "Second same-day publication"
        advanced = self.refresh(later_same_date)
        self.assertEqual(advanced["packs"][-1]["name"], "Second same-day publication")
        advanced_bytes = bundle_manager.catalog_cache_path().read_bytes()

        rollback = copy.deepcopy(original_feed)
        rollback["updated"] = "2026-09-02T14:00:00.500Z"
        rollback["packs"][0]["version"] = "0.9.0"
        self.assert_error("catalog_rollback", lambda: self.refresh(rollback))
        self.assertEqual(bundle_manager.catalog_cache_path().read_bytes(), advanced_bytes)
        self.assertEqual(bundle_manager.load_catalog(), advanced)

    def test_pack_version_cannot_downgrade_or_rebind_at_a_newer_revision(self) -> None:
        original = copy.deepcopy(self.community)
        original["updated"] = "2026-09-02T14:00:00.100Z"
        original["packs"][0]["version"] = "2.0.0"
        accepted = self.refresh(original)
        accepted_bytes = bundle_manager.catalog_cache_path().read_bytes()

        downgrade = copy.deepcopy(original)
        downgrade["updated"] = "2026-09-02T14:00:00.200Z"
        downgrade["packs"][0]["version"] = "1.99.0"
        self.assert_error("catalog_version_rollback", lambda: self.refresh(downgrade))
        self.assertEqual(bundle_manager.catalog_cache_path().read_bytes(), accepted_bytes)
        self.assertEqual(bundle_manager.load_catalog(), accepted)

        rebound = copy.deepcopy(original)
        rebound["updated"] = "2026-09-02T14:00:00.300Z"
        old_hash = rebound["packs"][0]["manifest"]["sha256"]
        new_hash = ("0" if old_hash[0] != "0" else "1") + old_hash[1:]
        rebound["packs"][0]["manifest"]["sha256"] = new_hash
        rebound["packs"][0]["manifest"]["url"] = (
            f"{bundle_manager.MANIFEST_BASE_URL}{new_hash}.json"
        )
        self.assert_error("catalog_version_rebinding", lambda: self.refresh(rebound))
        self.assertEqual(bundle_manager.catalog_cache_path().read_bytes(), accepted_bytes)

        equal_precedence = copy.deepcopy(original)
        equal_precedence["updated"] = "2026-09-02T14:00:00.400Z"
        equal_precedence["packs"][0]["version"] = "2.0.0+replacement"
        self.assert_error(
            "catalog_version_rebinding", lambda: self.refresh(equal_precedence)
        )
        self.assertEqual(bundle_manager.catalog_cache_path().read_bytes(), accepted_bytes)

    def test_newer_revision_may_add_and_remove_catalog_members(self) -> None:
        original = copy.deepcopy(self.community)
        original["updated"] = "2026-09-02T14:00:00.100Z"
        self.refresh(original)

        added = copy.deepcopy(original)
        added["updated"] = "2026-09-02T14:00:00.200Z"
        second = copy.deepcopy(added["packs"][0])
        second["id"] = "community-43-pacific-paint"
        second["name"] = "Pacific Paint Two"
        added["packs"].append(second)
        expanded = self.refresh(added)
        self.assertEqual(
            [pack["id"] for pack in expanded["packs"][-2:]],
            ["community-42-pacific-paint", "community-43-pacific-paint"],
        )

        removed = copy.deepcopy(added)
        removed["updated"] = "2026-09-02T14:00:00.300Z"
        removed["packs"] = [removed["packs"][1]]
        reduced = self.refresh(removed)
        self.assertNotIn(
            "community-42-pacific-paint", {pack["id"] for pack in reduced["packs"]}
        )
        self.assertIn(
            "community-43-pacific-paint", {pack["id"] for pack in reduced["packs"]}
        )

    def test_newer_empty_feed_delists_community_without_altering_officials(self) -> None:
        first = copy.deepcopy(self.community)
        first["updated"] = "2026-09-01"
        self.refresh(first)
        empty = {
            "format": bundle_manager.FORMAT_CATALOG,
            "format_version": bundle_manager.FORMAT_VERSION,
            "updated": "2026-09-02",
            "object_base_url": self.bundled["object_base_url"],
            "packs": [],
        }
        merged = self.refresh(empty)
        self.assertEqual(merged, self.bundled | {"updated": "2026-09-02"})
        self.assertEqual(bundle_manager.load_catalog(), merged)

    def test_binding_history_rejects_mutation_after_delist_and_accepts_exact_return(self) -> None:
        original = copy.deepcopy(self.community)
        original["updated"] = "2026-09-02T14:00:00.100Z"
        self.refresh(original)
        empty = copy.deepcopy(original)
        empty["updated"] = "2026-09-02T14:00:00.200Z"
        empty["packs"] = []
        self.refresh(empty)

        downgraded = copy.deepcopy(original)
        downgraded["updated"] = "2026-09-02T14:00:00.250Z"
        downgraded["packs"][0]["version"] = "0.9.0"
        self.assert_error(
            "catalog_version_rollback", lambda: self.refresh(downgraded)
        )

        rebound = copy.deepcopy(original)
        rebound["updated"] = "2026-09-02T14:00:00.300Z"
        old_hash = rebound["packs"][0]["manifest"]["sha256"]
        new_hash = ("0" if old_hash[0] != "0" else "1") + old_hash[1:]
        rebound["packs"][0]["manifest"]["sha256"] = new_hash
        rebound["packs"][0]["manifest"]["url"] = (
            f"{bundle_manager.MANIFEST_BASE_URL}{new_hash}.json"
        )
        self.assert_error(
            "catalog_version_rebinding", lambda: self.refresh(rebound)
        )
        self.assertEqual(
            json.loads(bundle_manager.catalog_cache_path().read_text())["packs"],
            [],
        )

        returned = copy.deepcopy(original)
        returned["updated"] = "2026-09-02T14:00:00.400Z"
        merged = self.refresh(returned)
        self.assertEqual(merged["packs"][-1]["manifest"], self.community_pack["manifest"])
        history = json.loads(bundle_manager.catalog_history_path().read_text())
        expected = bundle_manager.sha256_bytes(
            bundle_manager.canonical_json(
                bundle_manager.validate_catalog(original, timestamp=True)["packs"][0]
            )
        )
        self.assertEqual(
            history["ids"][self.community_pack["id"]]["versions"]["1.0.0"],
            expected,
        )

    def test_catalog_revision_history_survives_missing_or_corrupt_cache(self) -> None:
        original = copy.deepcopy(self.community)
        original["updated"] = "2026-09-02T14:00:00.100Z"
        self.refresh(original)
        cache = bundle_manager.catalog_cache_path()
        history = bundle_manager.catalog_history_path()
        history_bytes = history.read_bytes()

        cache.unlink()
        rollback = copy.deepcopy(original)
        rollback["updated"] = "2026-09-02T14:00:00.099Z"
        rollback["packs"] = []
        self.assert_error("catalog_rollback", lambda: self.refresh(rollback))
        self.assertFalse(cache.exists())
        self.assertEqual(history.read_bytes(), history_bytes)

        equivocation = copy.deepcopy(original)
        equivocation["packs"] = []
        self.assert_error(
            "catalog_equivocation", lambda: self.refresh(equivocation)
        )
        self.assertFalse(cache.exists())

        self.refresh(original)
        cache.write_text("{broken\n", encoding="utf-8")
        cache.chmod(0o644)
        self.assert_error("catalog_rollback", lambda: self.refresh(rollback))
        self.assertEqual(cache.read_bytes(), b"{broken\n")

    def test_future_dated_feed_cannot_pin_updates(self) -> None:
        future = copy.deepcopy(self.community)
        future["updated"] = (
            dt.datetime.now(dt.timezone.utc).date() + dt.timedelta(days=30)
        ).isoformat()
        self.assert_error("catalog_future", lambda: self.refresh(future))
        self.assertFalse(bundle_manager.catalog_cache_path().exists())

    def test_network_or_cache_damage_falls_back_without_touching_active_art(self) -> None:
        merged = self.refresh()
        before_state = bundle_manager.load_state()
        before_cache = bundle_manager.catalog_cache_path().read_bytes()
        with mock.patch.object(
            bundle_manager,
            "download_live_catalog_bytes",
            side_effect=bundle_manager.BundleError("offline", "download_failed"),
        ):
            self.assert_error("download_failed", bundle_manager.refresh_catalog)
        self.assertEqual(bundle_manager.catalog_cache_path().read_bytes(), before_cache)
        self.assertEqual(bundle_manager.load_catalog(), merged)
        self.assertEqual(bundle_manager.load_state(), before_state)

        bundle_manager.catalog_cache_path().write_text("{broken\n", encoding="utf-8")
        bundle_manager.catalog_cache_path().chmod(0o644)
        fallback = bundle_manager.load_catalog()
        self.assertEqual(fallback, self.bundled)
        self.assertEqual(bundle_manager.load_state(), before_state)

    def test_unsafe_cache_links_fall_back_and_refresh_never_touches_the_target(self) -> None:
        target = self.base / "do-not-touch.json"
        target.write_text("sentinel\n", encoding="utf-8")
        cache = bundle_manager.catalog_cache_path()
        cache.symlink_to(target)
        self.assertEqual(bundle_manager.load_catalog(), self.bundled)
        self.refresh()
        self.assertEqual(target.read_text(encoding="utf-8"), "sentinel\n")
        self.assertTrue(cache.is_file())
        self.assertFalse(cache.is_symlink())

    def test_refresh_job_has_no_target_and_worker_does_not_activate(self) -> None:
        before_state = bundle_manager.load_state()
        with mock.patch.object(bundle_manager.subprocess, "Popen") as popen:
            result = bundle_manager.enqueue("refresh", "", "", False)
        popen.assert_called_once()
        job = bundle_manager.load_job()
        assert job is not None
        self.assertEqual(job["operation"], "refresh")
        self.assertEqual(job["bundle_id"], "")
        self.assertEqual(job["bundle_version"], "")
        self.assertFalse(job["activate"])
        self.assertEqual(result["job"]["operation"], "refresh")

        with mock.patch.object(
            bundle_manager, "download_live_catalog_bytes", return_value=self.catalog_bytes()
        ):
            bundle_manager.run_job(job["id"])
        self.assertEqual(bundle_manager.load_job()["state"], "complete")
        self.assertEqual(bundle_manager.load_state(), before_state)
        self.assertIn(
            self.community_pack["id"],
            {pack["id"] for pack in bundle_manager.snapshot()["catalog"]["packs"]},
        )

    def test_delisted_install_remains_visible_activatable_and_removable(self) -> None:
        fixture = BundleFixture()
        publication = self.base / "publication"
        fixture.publish(publication)
        feed = copy.deepcopy(fixture.catalog)
        feed["packs"][0].pop("search_terms", None)
        feed["updated"] = "2026-09-01"
        feed["object_base_url"] = self.bundled["object_base_url"]

        with mock.patch.dict(
            os.environ, {"AVIAN_BUNDLE_DEV_ROOT": str(publication)}, clear=False
        ):
            self.refresh(feed)
            fresh = next(
                pack for pack in bundle_manager.snapshot()["catalog"]["packs"]
                if pack["id"] == fixture.pack_id
            )
            self.assertFalse(fresh["installed"])
            self.assertIsNone(fresh["activation_version"])
            self.assertIsNone(fresh["activation_presentation"])
            now = bundle_manager.utc_now()
            install_job = {
                "schema_version": 1,
                "id": "a" * 32,
                "operation": "install",
                "bundle_id": fixture.pack_id,
                "bundle_version": fixture.version,
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
            bundle_manager.atomic_json(self.root / "job.json", install_job)
            bundle_manager.run_job(install_job["id"])

            empty = {
                "format": bundle_manager.FORMAT_CATALOG,
                "format_version": bundle_manager.FORMAT_VERSION,
                "updated": "2026-09-02",
                "object_base_url": self.bundled["object_base_url"],
                "packs": [],
            }
            self.refresh(empty)
            listed = {
                pack["id"]: pack for pack in bundle_manager.snapshot()["catalog"]["packs"]
            }
            self.assertEqual(listed[fixture.pack_id]["availability"], "unavailable")
            self.assertTrue(listed[fixture.pack_id]["installed"])
            self.assertTrue(listed[fixture.pack_id]["active"])
            self.assertEqual(
                listed[fixture.pack_id]["activation_presentation"]["version"],
                fixture.version,
            )
            self.assertEqual(
                listed[fixture.pack_id]["activation_presentation"]["style"],
                fixture.manifest["style"],
            )

            self.assertEqual(bundle_manager.rollback_active(), bundle_manager.builtin_ref())
            with mock.patch.object(bundle_manager.subprocess, "Popen"):
                activation = bundle_manager.enqueue(
                    "activate", fixture.pack_id, fixture.version, False
                )
            bundle_manager.run_job(activation["job"]["id"])
            self.assertEqual(bundle_manager.load_state()["active"]["id"], fixture.pack_id)

            with mock.patch.object(bundle_manager.subprocess, "Popen"):
                removal = bundle_manager.enqueue(
                    "remove", fixture.pack_id, fixture.version, False
                )
            bundle_manager.run_job(removal["job"]["id"])
            self.assertEqual(bundle_manager.load_state()["active"], bundle_manager.builtin_ref())
            self.assertFalse((self.root / "packs" / fixture.pack_id).exists())

    def test_remove_current_feed_version_accepts_an_older_local_install(self) -> None:
        listed = copy.deepcopy(self.community_pack)
        listed["version"] = "2.0.0"
        merged = {
            **self.bundled,
            "updated": "2026-09-02",
            "packs": [*self.bundled["packs"], listed],
        }
        installed_v1 = {
            "reference": {
                "id": listed["id"],
                "version": "1.0.0",
                "revision": "1" * 64,
                "included": False,
                "name": listed["name"],
            }
        }

        def current_install(pack_id: str, version: str | None = None):
            if pack_id != listed["id"]:
                return None
            return installed_v1 if version in {None, "1.0.0"} else None

        with mock.patch.object(bundle_manager, "load_catalog", return_value=merged), mock.patch.object(
            bundle_manager, "current_install", side_effect=current_install
        ), mock.patch.object(bundle_manager.subprocess, "Popen"):
            result = bundle_manager.enqueue("remove", listed["id"], "2.0.0", False)
        self.assertEqual(result["job"]["operation"], "remove")
        self.assertEqual(result["job"]["version"], "2.0.0")

    def test_catalog_update_keeps_an_older_active_family_visible(self) -> None:
        fixture = BundleFixture()
        publication = self.base / "publication-active-family"
        fixture.publish(publication)
        feed = copy.deepcopy(fixture.catalog)
        feed["packs"][0].pop("search_terms", None)
        feed["updated"] = "2026-09-01"
        feed["object_base_url"] = self.bundled["object_base_url"]

        with mock.patch.dict(
            os.environ, {"AVIAN_BUNDLE_DEV_ROOT": str(publication)}, clear=False
        ):
            self.refresh(feed)
            now = bundle_manager.utc_now()
            install_job = {
                "schema_version": 1,
                "id": "b" * 32,
                "operation": "install",
                "bundle_id": fixture.pack_id,
                "bundle_version": fixture.version,
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
            bundle_manager.atomic_json(self.root / "job.json", install_job)
            bundle_manager.run_job(install_job["id"])

            installed = next(
                pack for pack in bundle_manager.snapshot()["catalog"]["packs"]
                if pack["id"] == fixture.pack_id
            )
            self.assertTrue(installed["installed_current"])
            self.assertEqual(installed["activation_version"], fixture.version)
            self.assertEqual(installed["activation_presentation"], {
                "name": fixture.manifest["name"],
                "coverage": {
                    "label": fixture.manifest["coverage"]["label"],
                    "group": fixture.pack["coverage"]["group"],
                },
                "style": fixture.manifest["style"],
                "species_count": 1,
                "creator": fixture.manifest["attribution"]["creator"],
                "review": fixture.pack["review"],
                "version": fixture.version,
                "license": fixture.manifest["license"]["spdx"],
                "archive_bytes": fixture.pack["archive_bytes"],
            })

            next_feed = copy.deepcopy(feed)
            next_feed["updated"] = "2026-09-02"
            next_feed["packs"][0]["version"] = "2.0.0"
            self.refresh(next_feed)

            rows = [
                pack for pack in bundle_manager.snapshot()["catalog"]["packs"]
                if pack["id"] == fixture.pack_id
            ]
            self.assertEqual(len(rows), 1)
            row = rows[0]
            self.assertTrue(row["active"])
            self.assertFalse(row["active_current"])
            self.assertEqual(row["active_version"], fixture.version)
            self.assertTrue(row["installed"])
            self.assertFalse(row["installed_current"])
            self.assertEqual(row["installed_versions"], [fixture.version])
            self.assertEqual(row["activation_version"], fixture.version)
            self.assertEqual(row["activation_presentation"]["version"], fixture.version)
            self.assertEqual(row["activation_presentation"]["name"], fixture.manifest["name"])
            self.assertEqual(row["activation_presentation"]["style"], fixture.manifest["style"])
            self.assertTrue(row["catalog_current"])
            self.assertTrue(row["update_available"])

    def test_catalog_transport_has_no_caller_url_and_is_strictly_bounded(self) -> None:
        self.assertEqual(
            bundle_manager.LIVE_CATALOG_URL,
            "https://avianvisitors.com/api/bundles/catalog/community-v1.json",
        )
        self.assertEqual(bundle_manager.LIVE_CATALOG_HOSTS, {"avianvisitors.com"})
        self.assertEqual(bundle_manager.download_live_catalog_bytes.__code__.co_argcount, 0)

        class Response:
            status = 200

            @staticmethod
            def getheader(name: str):
                return {
                    "Content-Type": "application/json",
                    "Content-Length": str(bundle_manager.CATALOG_MAX + 1),
                }.get(name)

            @staticmethod
            def read(_size: int = -1) -> bytes:
                return b""

        class Connection:
            def __init__(self, *_args, **_kwargs) -> None:
                pass

            def request(self, *_args, **_kwargs) -> None:
                pass

            @staticmethod
            def getresponse():
                return Response()

            def close(self) -> None:
                pass

        with mock.patch.object(bundle_manager, "public_addresses", return_value=["1.1.1.1"]), mock.patch.object(
            bundle_manager, "PinnedHTTPSConnection", Connection
        ):
            self.assert_error("catalog_too_large", bundle_manager.download_live_catalog_bytes)

    def test_catalog_rejects_every_redirect(self) -> None:
        class Response:
            status = 302
            location = ""

            @classmethod
            def getheader(cls, name: str):
                return cls.location if name == "Location" else None

            @staticmethod
            def read(_size: int = -1) -> bytes:
                return b""

        class Connection:
            def __init__(self, *_args, **_kwargs) -> None:
                pass

            def request(self, *_args, **_kwargs) -> None:
                pass

            @staticmethod
            def getresponse():
                return Response()

            def close(self) -> None:
                pass

        with mock.patch.object(bundle_manager, "public_addresses", return_value=["1.1.1.1"]), mock.patch.object(
            bundle_manager, "PinnedHTTPSConnection", Connection
        ):
            for location in (
                "https://evil.example/catalog.json",
                "https://avianvisitors.com/bundles",
                f"{bundle_manager.LIVE_CATALOG_URL}?alternate=1",
                bundle_manager.LIVE_CATALOG_URL,
            ):
                with self.subTest(location=location):
                    Response.location = location
                    self.assert_error(
                        "download_failed", bundle_manager.download_live_catalog_bytes
                    )


if __name__ == "__main__":
    unittest.main()
