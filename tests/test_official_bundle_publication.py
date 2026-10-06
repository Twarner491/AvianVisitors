"""Contract tests for the read-only official publication verifier."""
from __future__ import annotations

import hashlib
import importlib.util
from pathlib import Path
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "verify_official_bundle_publication.py"
SPEC = importlib.util.spec_from_file_location("official_bundle_publication", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
publication = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(publication)


class OfficialBundlePublicationTests(unittest.TestCase):
    def test_committed_lock_covers_both_distinct_authorities(self) -> None:
        lock = publication.load_lock(
            ROOT / "avian" / "bundles" / "publication-lock-v1.json"
        )
        by_authority = {}
        for payload in lock["payloads"]:
            by_authority.setdefault(payload["authority"], set()).add(payload["manifest_sha256"])
        self.assertEqual(
            by_authority["station-install"],
            {
                "019d21f5f54b1a68a4510b089544eb7316a3db54dfd37fc129b950eeeffa591f",
                "e069f2ee62cef44d923e136d8eb2011b36ef45d1da46a4cc441ef1916fc3a402",
            },
        )
        self.assertEqual(
            by_authority["public-discovery"],
            {
                "31fcb450f517acb2ea26b1c559cc3aad1696f583587209bd2a43058d8e6803e1",
                "9d071dba2ef81084d483374a13c852785faa64898b9db461e7b28abb4c7d426b",
            },
        )
        self.assertEqual(lock["publication"]["object_count"], 1999)
        self.assertEqual(lock["publication"]["total_bytes"], 977739928)
        self.assertEqual(
            lock["publication"]["plan_sha256"],
            "f18737e16d969aa02c711f1e6440c40a7853c14c077224328f7aac75d495d8d1",
        )

    def test_plan_commitment_is_order_independent_and_content_bound(self) -> None:
        first = {
            "kind": "manifest", "r2_key": "bundles/manifests/sha256/aa/" + "a" * 64 + ".json",
            "sha256": "a" * 64, "bytes": 100,
        }
        second = {
            "kind": "object", "r2_key": "bundles/objects/sha256/bb/" + "b" * 64 + ".png",
            "sha256": "b" * 64, "bytes": 200,
        }
        left = publication.plan_summary({"first": first, "second": second})
        right = publication.plan_summary({"second": second, "first": first})
        self.assertEqual(left, right)
        changed = {**second, "bytes": 201}
        self.assertNotEqual(
            left["plan_sha256"],
            publication.plan_summary({"first": first, "second": changed})["plan_sha256"],
        )

    def test_live_content_smoke_hashes_the_manifest_and_every_object(self) -> None:
        artwork = b"\x89PNG\r\n\x1a\n" + b"x" * 60
        artwork_sha = hashlib.sha256(artwork).hexdigest()
        manifest = {
            "format": "avian-visitors-asset-pack",
            "format_version": 1,
            "id": "official-test",
            "version": "1.0.0",
            "name": "Official Test",
            "description": "A locked smoke fixture.",
            "style": {"id": "test-style", "name": "Test Style"},
            "coverage": {"type": "region", "label": "California", "region_codes": ["US-CA"]},
            "species": [{
                "scientific_name": "Corvus brachyrhynchos",
                "poses": [{
                    "id": "perched",
                    "file": "illustrations/corvus-brachyrhynchos.png",
                    "sha256": artwork_sha,
                    "bytes": len(artwork),
                }],
            }],
            "license": {"spdx": "CC-BY-NC-SA-4.0"},
            "attribution": {
                "creator": "Avian Visitors",
                "source_url": "https://github.com/Twarner491/AvianVisitors",
            },
            "provenance": {"method": "manual", "review": "human-reviewed"},
        }
        raw = publication.manager.canonical_json(manifest)
        manifest_sha = hashlib.sha256(raw).hexdigest()
        payload = {
            "authority": "station-install",
            "id": manifest["id"],
            "version": manifest["version"],
            "manifest_sha256": manifest_sha,
            "manifest_bytes": len(raw),
            "object_count": 1,
            "object_bytes": len(artwork),
            "object_inventory_sha256": publication.inventory_sha256(
                publication.object_inventory(publication.manager.validate_manifest(manifest))
            ),
            "source": {"kind": "object-tree", "manifest": f"manifests/{manifest_sha}.json"},
        }
        plan = {
            publication.manifest_key(manifest_sha): {
                "kind": "manifest", "r2_key": publication.manifest_key(manifest_sha),
                "sha256": manifest_sha, "bytes": len(raw),
            },
            publication.object_key(artwork_sha): {
                "kind": "object", "r2_key": publication.object_key(artwork_sha),
                "sha256": artwork_sha, "bytes": len(artwork),
            },
        }
        lock = {"payloads": [payload], "publication": publication.plan_summary(plan)}
        headers = {
            "cache-control": "public, max-age=31536000, immutable",
            "x-content-type-options": "nosniff",
        }
        calls = []

        def request(url, method, maximum):
            calls.append((url, method, maximum))
            if url == publication.manifest_url(manifest_sha):
                return {**headers, "content-type": "application/json", "content-length": str(len(raw))}, raw
            if url == publication.object_url(artwork_sha):
                return {**headers, "content-type": "image/png", "content-length": str(len(artwork))}, artwork
            raise AssertionError(url)

        with mock.patch.object(publication, "public_request", side_effect=request):
            summary, _records = publication.verify_live(lock, head_only=False, workers=1)
        self.assertEqual(summary, lock["publication"])
        self.assertEqual(
            calls,
            [
                (publication.manifest_url(manifest_sha), "GET", len(raw)),
                (publication.object_url(artwork_sha), "GET", len(artwork)),
            ],
        )


if __name__ == "__main__":
    unittest.main()
