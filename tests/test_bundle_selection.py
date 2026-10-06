"""Location selection, immutable receipts, and installer rollback."""

from __future__ import annotations

import copy
import json
import os
import shutil
import unittest
from types import SimpleNamespace
from unittest import mock

from tests import test_bundle_manager as fixtures

bundle_manager = fixtures.bundle_manager
png_bytes = fixtures.png_bytes
sha256 = fixtures.sha256


class BundleSelectionTests(unittest.TestCase):
    setUp = fixtures.BundleLifecycleTests.setUp
    tearDown = fixtures.BundleLifecycleTests.tearDown
    queued_install_job = fixtures.BundleLifecycleTests.queued_install_job

    def publish_three_birds(self) -> None:
        for number, name in enumerate(("Corvus corax", "Sitta carolinensis"), start=1):
            raw = png_bytes((number * 30, 80, 190, 255))
            self.fixture.images[name] = raw
            self.fixture.manifest["species"].append({
                "scientific_name": name,
                "common_name": name,
                "poses": [{
                    "id": "perched",
                    "file": bundle_manager.pose_path(name, "perched"),
                    "sha256": sha256(raw),
                    "bytes": len(raw),
                }],
            })
        self.fixture.manifest_raw = bundle_manager.canonical_json(self.fixture.manifest)
        self.fixture.manifest_hash = sha256(self.fixture.manifest_raw)
        self.fixture.pack.update({
            "species_count": 3,
            "species": [bird["scientific_name"] for bird in self.fixture.manifest["species"]],
            "archive_bytes": sum(len(raw) for raw in self.fixture.images.values()),
            "manifest": {
                "url": bundle_manager.MANIFEST_BASE_URL + self.fixture.manifest_hash + ".json",
                "sha256": self.fixture.manifest_hash,
                "bytes": len(self.fixture.manifest_raw),
            },
        })
        self.fixture.publish(self.publication)
        self.catalog_path.write_bytes(bundle_manager.canonical_json(self.fixture.catalog))

    def select(self, names: list[str] | None, *, all_species: bool = False, job_id: str = "b" * 32):
        expected = self.base / "expected.txt"
        if names is not None:
            expected.write_text("\n".join(names) + "\n")
        else:
            expected = self.base / "absent-expected.txt"
        bundle_manager.initialize()
        job = self.queued_install_job(job_id)
        job.update({"operation": "use", "activate": False, "all_species": all_species})
        bundle_manager.atomic_json(self.root / "job.json", job)
        with mock.patch.dict(os.environ, {"AVIAN_BUNDLE_EXPECTED": str(expected)} if names is not None else {}):
            bundle_manager.run_job(job_id)
        return bundle_manager.load_state()["active"]

    def test_use_downloads_only_local_species_and_keeps_full_manifest(self) -> None:
        self.publish_three_birds()
        selected = ["Corvus corax", "Sitta carolinensis"]
        reference = self.select(selected)
        directory = bundle_manager.pack_directory(reference)
        self.assertEqual(directory, self.root / "packs" / self.fixture.pack_id / self.fixture.version
                         / "selections" / reference["selection_revision"])
        self.assertEqual((directory / "manifest.json").read_bytes(), self.fixture.manifest_raw)
        receipt_raw = (directory / "selection.json").read_bytes()
        self.assertEqual(sha256(receipt_raw), reference["selection_revision"])
        receipt = json.loads(receipt_raw)
        self.assertEqual(receipt["species"], selected)
        self.assertEqual(receipt["mode"], "local")
        self.assertEqual(reference["revision"], self.fixture.manifest_hash)
        self.assertEqual(set(bundle_manager.load_index(reference)["assets"]),
                         {bundle_manager.scientific_slug(name) for name in selected})
        stored = bundle_manager.object_store_inventory(self.root)
        self.assertEqual(set(stored), {sha256(self.fixture.images[name]) for name in selected})
        self.assertEqual(bundle_manager.validate_installed_pack(reference)["species_count"], 2)

    def test_same_version_location_change_keeps_both_profiles_and_rolls_back_exactly(self) -> None:
        self.publish_three_birds()
        first = self.select(["Corvus corax"])
        first_bytes = (bundle_manager.pack_directory(first) / "index.json").read_bytes()
        second = self.select(["Sitta carolinensis"], job_id="c" * 32)
        self.assertNotEqual(first["selection_revision"], second["selection_revision"])
        self.assertEqual(first["revision"], second["revision"])
        self.assertEqual(bundle_manager.load_state()["previous"], first)
        bundle_manager.garbage_collect_objects()
        self.assertEqual((bundle_manager.pack_directory(first) / "index.json").read_bytes(), first_bytes)
        self.assertEqual(bundle_manager.rollback_active(), first)
        self.assertEqual(len(bundle_manager.installed_records()), 2)

    def test_all_species_expands_a_local_install_without_rebinding_it(self) -> None:
        self.publish_three_birds()
        local = self.select(["Corvus corax"])
        full = self.select(["Corvus corax"], all_species=True, job_id="d" * 32)
        self.assertNotEqual(local["selection_revision"], full["selection_revision"])
        self.assertEqual(bundle_manager.validate_installed_pack(full)["species_count"], 3)
        self.assertEqual(bundle_manager.validate_installed_pack(local)["species_count"], 1)
        self.assertEqual(bundle_manager.load_state()["previous"], local)

    def test_unset_location_installs_full_selection(self) -> None:
        self.publish_three_birds()
        reference = self.select(None)
        directory = bundle_manager.pack_directory(reference)
        self.assertEqual(json.loads((directory / "selection.json").read_bytes())["mode"], "all")
        self.assertEqual(bundle_manager.validate_installed_pack(reference)["species_count"], 3)

    def test_empty_overlap_preserves_active_and_downloads_nothing(self) -> None:
        self.publish_three_birds()
        first = self.select(["Corvus corax"])
        before = bundle_manager.object_store_inventory(self.root)
        with self.assertRaises(bundle_manager.BundleError) as raised:
            self.select(["Passer domesticus"], job_id="e" * 32)
        self.assertEqual(raised.exception.code, "no_local_species")
        self.assertEqual(bundle_manager.load_state()["active"], first)
        self.assertEqual(bundle_manager.object_store_inventory(self.root), before)

    def test_receipt_and_extra_asset_tampering_are_rejected(self) -> None:
        self.publish_three_birds()
        reference = self.select(["Corvus corax"])
        directory = bundle_manager.pack_directory(reference)
        receipt_raw = (directory / "selection.json").read_bytes()
        receipt = json.loads(receipt_raw)
        receipt["species"].append("Sitta carolinensis")
        (directory / "selection.json").write_bytes(bundle_manager.canonical_json(receipt))
        with self.assertRaises(bundle_manager.BundleError):
            bundle_manager.validate_installed_pack(reference)
        (directory / "selection.json").write_bytes(receipt_raw)
        index = json.loads((directory / "index.json").read_bytes())
        index["assets"]["passer-domesticus"] = copy.deepcopy(index["assets"]["corvus-corax"])
        (directory / "index.json").write_bytes(bundle_manager.canonical_json(index))
        with self.assertRaises(bundle_manager.BundleError):
            bundle_manager.validate_installed_pack(reference)

    def test_failed_local_resolver_does_not_silently_select_all(self) -> None:
        self.publish_three_birds()
        first = self.select(["Corvus corax"])
        config = self.base / "missing.conf"
        config.write_text("LATITUDE=37.7\nLONGITUDE=-122.4\n")
        with self.assertRaises(bundle_manager.BundleError):
            self.select(None, job_id="f" * 32)
        self.assertEqual(bundle_manager.load_state()["active"], first)

    def test_safe_config_symlink_resolves_current_station_location(self) -> None:
        target = self.base / "current.conf"
        target.write_text("LATITUDE=37.7\nLONGITUDE=-122.4\n")
        (self.base / "missing.conf").symlink_to(target)
        self.assertEqual(bundle_manager.station_coordinates(), (37.7, -122.4))

    def test_invalid_configured_coordinates_fail_instead_of_selecting_all(self) -> None:
        (self.base / "missing.conf").write_text("LATITUDE=nan\nLONGITUDE=-122.4\n")
        with self.assertRaises(bundle_manager.BundleError):
            bundle_manager.local_selection_basis()

    def prepare_station_runtime(self):
        (self.base / "missing.conf").write_text("LATITUDE=37.7\nLONGITUDE=-122.4\nSF_THRESH=0.03\n")
        model = self.base / "model"
        model.mkdir()
        for filename in ("BirdNET_GLOBAL_6K_V2.4_MData_Model_V2_FP16.tflite",
                         "BirdNET_GLOBAL_6K_V2.4_Model_FP16_Labels.txt"):
            (model / filename).write_text("model fixture\n")
        python = self.base / "birdnet" / "bin" / "python3"
        python.parent.mkdir(parents=True)
        python.write_text("python fixture\n")
        helper = self.base / "bundle_species.py"
        helper.write_text("# fixed installed helper\n")
        return {"schema_version": 1, "user": "station", "root": str(self.base),
                "account": SimpleNamespace(pw_uid=1000, pw_gid=1000)}, helper

    def test_species_cache_reuses_same_inputs_and_invalidates_location_change(self) -> None:
        runtime, helper = self.prepare_station_runtime()
        output = {"schema_version": 1, "species": ["Corvus corax"], "basis_sha256": "a" * 64}
        with mock.patch.object(bundle_manager, "station_runtime", return_value=runtime), \
             mock.patch.object(bundle_manager, "SPECIES_HELPER_PATH", helper), \
             mock.patch.object(bundle_manager, "species_helper_output", return_value=output) as resolve:
            first = bundle_manager.local_selection_basis()
            self.assertEqual(bundle_manager.local_selection_basis(), first)
            self.assertEqual(resolve.call_count, 1)
            command = resolve.call_args.args[0]
            self.assertEqual(command[:3], ["/usr/bin/setpriv", "--no-new-privs", "--reuid"])
            self.assertIn("--clear-groups", command)
            self.assertIn("--bounding-set=-all", command)
            self.assertIn("-I", command)
            (self.base / "missing.conf").write_text("LATITUDE=40.7\nLONGITUDE=-74.0\nSF_THRESH=0.03\n")
            bundle_manager.local_selection_basis()
            self.assertEqual(resolve.call_count, 2)
            helper.write_text("# changed installed helper\n")
            bundle_manager.local_selection_basis()
            self.assertEqual(resolve.call_count, 3)
        cache = json.loads((self.root / "selection-basis-v1.json").read_bytes())
        self.assertNotIn("coordinates", cache)

    def test_species_cache_includes_heard_and_whitelisted_birds(self) -> None:
        runtime, helper = self.prepare_station_runtime()
        (self.base / "whitelist_species_list.txt").write_text("Sitta carolinensis_White-breasted Nuthatch\n")
        output = {"schema_version": 1, "species": ["Corvus corax"], "basis_sha256": "a" * 64}
        with mock.patch.object(bundle_manager, "station_runtime", return_value=runtime), \
             mock.patch.object(bundle_manager, "SPECIES_HELPER_PATH", helper), \
             mock.patch.object(bundle_manager, "heard_species", return_value={"Passer domesticus"}), \
             mock.patch.object(bundle_manager, "species_helper_output", return_value=output):
            result = bundle_manager.local_selection_basis()
        self.assertEqual(result["species"], ["Corvus corax", "Passer domesticus", "Sitta carolinensis"])

    def test_delisted_install_can_reselect_from_its_cached_manifest(self) -> None:
        self.publish_three_birds()
        first = self.select(["Corvus corax"])
        catalog = copy.deepcopy(self.fixture.catalog)
        catalog["packs"][0]["id"] = "community-other"
        self.catalog_path.write_bytes(bundle_manager.canonical_json(catalog))
        with mock.patch.object(bundle_manager, "fetch_manifest", side_effect=AssertionError("no manifest download")):
            second = self.select(["Sitta carolinensis"], job_id="c" * 32)
        self.assertEqual(second["revision"], first["revision"])
        self.assertNotEqual(second["selection_revision"], first["selection_revision"])

    def test_legacy_full_install_stays_readable_after_local_migration(self) -> None:
        self.publish_three_birds()
        profile = self.select(None)
        directory = bundle_manager.pack_directory(profile)
        legacy = dict(profile)
        del legacy["selection_revision"]
        legacy_directory = bundle_manager.pack_directory(legacy)
        for filename in ("manifest.json", "dims.json", "masks.json"):
            shutil.copyfile(directory / filename, legacy_directory / filename)
        index = json.loads((directory / "index.json").read_bytes())
        del index["selection_revision"]
        bundle_manager.atomic_json(legacy_directory / "index.json", index)
        bundle_manager.atomic_json(legacy_directory / "meta.json", {"reference": legacy, "installed_at": bundle_manager.utc_now()})
        bundle_manager.save_state(legacy, None)
        local = self.select(["Corvus corax"], job_id="d" * 32)
        self.assertEqual(bundle_manager.load_state()["previous"], legacy)
        self.assertEqual(bundle_manager.validate_installed_pack(legacy)["species_count"], 3)
        self.assertEqual(bundle_manager.validate_installed_pack(local)["species_count"], 1)
        self.assertEqual(bundle_manager.rollback_active(), legacy)

    def test_failed_new_selection_download_preserves_active_profile_and_objects(self) -> None:
        self.publish_three_birds()
        first = self.select(["Corvus corax"])
        original_fetch = bundle_manager.fetch_object
        missing = sha256(self.fixture.images["flight"])

        def fail_missing(catalog, digest, size):
            if digest == missing:
                raise bundle_manager.BundleError("missing object", "download_failed")
            return original_fetch(catalog, digest, size)

        with mock.patch.object(bundle_manager, "fetch_object", side_effect=fail_missing):
            with self.assertRaises(bundle_manager.BundleError):
                self.select([self.fixture.scientific_name, "Corvus corax"], job_id="c" * 32)
        self.assertEqual(bundle_manager.load_state()["active"], first)
        self.assertEqual(set(bundle_manager.object_store_inventory(self.root)), {sha256(self.fixture.images["Corvus corax"])})

    def test_unset_basis_response_has_no_locator(self) -> None:
        self.assertEqual(bundle_manager.selection_basis_response(),
                         {"ok": True, "schema_version": 1, "species": None, "basis_sha256": None})

    def test_unrelated_local_bird_does_not_create_a_duplicate_profile(self) -> None:
        self.publish_three_birds()
        first = self.select(["Corvus corax"])
        second = self.select(["Corvus corax", "Passer domesticus"], job_id="c" * 32)
        self.assertEqual(second, first)
        self.assertEqual(len(bundle_manager.installed_records()), 1)

    def test_equivalent_profile_reuse_prefers_the_active_profile(self) -> None:
        self.publish_three_birds()
        first = self.select(["Corvus corax"])
        with mock.patch.object(bundle_manager, "equivalent_selection_reference", return_value=None):
            duplicate = self.select(["Corvus corax", "Passer domesticus"], job_id="c" * 32)
        bundle_manager.activate_reference(first)
        repeated = self.select(["Corvus corax"], job_id="d" * 32)
        self.assertNotEqual(duplicate, first)
        self.assertEqual(repeated, first)
        self.assertEqual(bundle_manager.load_state()["previous"], duplicate)
        self.assertEqual(len(bundle_manager.installed_records()), 2)


if __name__ == "__main__":
    unittest.main()
