"""Integrity checks for the root-installed station bundle catalog."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
CATALOG_PATH = ROOT / "avian" / "bundles" / "catalog-v1.json"
MANAGER_PATH = ROOT / "avian" / "scripts" / "bundle_manager.py"
SPEC = importlib.util.spec_from_file_location("station_bundle_catalog_manager", MANAGER_PATH)
assert SPEC is not None and SPEC.loader is not None
bundle_manager = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bundle_manager)


class StationBundleCatalogTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        raw = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
        cls.catalog = bundle_manager.validate_catalog(raw)

    def test_catalog_contains_only_the_reviewed_initial_release(self) -> None:
        packs = {pack["id"]: pack for pack in self.catalog["packs"]}
        self.assertEqual(
            set(packs),
            {
                "official-western-us-woodblock",
                "official-western-us-impressionist",
            },
        )
        self.assertEqual(packs["official-western-us-woodblock"]["availability"], "included")
        self.assertEqual(packs["official-western-us-impressionist"]["availability"], "installable")
        self.assertEqual(
            [pack["id"] for pack in self.catalog["packs"] if pack["availability"] == "included"],
            ["official-western-us-woodblock"],
        )
        for pack in packs.values():
            with self.subTest(pack=pack["id"]):
                self.assertEqual(pack["review"], "official")
                self.assertEqual(pack["species_count"], 333)
                self.assertEqual(len(pack["species"]), 333)
                self.assertEqual(len(set(pack["species"])), 333)
                self.assertEqual(len(pack["previews"]), 6)

    def test_catalog_has_no_executable_or_caller_selected_install_surface(self) -> None:
        self.assertEqual(
            self.catalog["object_base_url"],
            "https://avianvisitors.com/api/bundles/objects/",
        )
        for pack in self.catalog["packs"]:
            with self.subTest(pack=pack["id"]):
                self.assertEqual(
                    pack["manifest"]["url"],
                    "https://avianvisitors.com/api/bundles/manifests/"
                    f"{pack['manifest']['sha256']}.json",
                )
                self.assertNotIn("install_hook", pack)
                self.assertNotIn("script", pack)

    def test_catalog_uses_the_flat_public_worker_object_contract(self) -> None:
        digest = self.catalog["packs"][1]["previews"][0]["sha256"]
        url = bundle_manager.object_url(self.catalog, digest)
        self.assertEqual(
            url,
            f"https://avianvisitors.com/api/bundles/objects/{digest}.png",
        )
        self.assertNotIn(f"/{digest[:2]}/{digest}.png", url)


if __name__ == "__main__":
    unittest.main()
