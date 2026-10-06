#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bundle_validation_report as report
import bundle_inventory_commitment


class BundleValidationReportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.archive = self.root / "bundle.zip"
        self.manifest = b'{"format":"avian-visitors-asset-pack"}'
        self.public_manifest = {
            "id": "test-pack", "version": "1.0.0", "name": "Test pack", "description": "",
            "style": {"id": "woodblock", "name": "Woodblock"},
            "coverage": {"type": "region", "label": "California", "region_codes": ["US-CA"]},
            "license": {"spdx": "CC-BY-4.0"},
            "attribution": {"creator": "Test", "source_url": None},
            "provenance": {"method": "manual", "model": None, "review": "contributor-reviewed"},
        }
        self.publish_inventory = [{
            "file": "illustrations/test.png", "sha256": "d" * 64, "bytes": 1234,
        }]
        self.required_validation = {
            "publish_manifest_sha256": "c" * 64,
            "publish_object_inventory": self.publish_inventory,
        }
        self.inventory_sha256 = bundle_inventory_commitment.inventory_sha256(
            self.publish_inventory
        )
        self.canonical_sample = {
            "object_ordinal": 0, "file": "illustrations/test.png", "sha256": "d" * 64,
            "bytes": 1234, "width": 100, "height": 100, "role": "flag",
        }
        with zipfile.ZipFile(self.archive, "w") as bundle:
            bundle.writestr("manifest.json", self.manifest)

    def tearDown(self):
        self.temp.cleanup()

    def test_success_is_bounded_and_contains_only_hashes_and_counts(self):
        validation = {
            **self.required_validation,
            "ok": True, "id": "test-pack", "version": "1.0.0",
            "species": 12, "objects": 24, "expanded_bytes": 4096,
            "object_inventory": [{"private": "not forwarded"}],
            "public_manifest": self.public_manifest,
        }
        result = report.build_report(self.archive, validation)
        self.assertTrue(result["ok"])
        self.assertEqual(result["summary"]["manifest_sha256"], hashlib.sha256(self.manifest).hexdigest())
        self.assertNotIn("object_inventory", json.dumps(result))
        self.assertEqual(result["public_manifest"], self.public_manifest)

    def test_secret_bearing_job_can_report_from_precomputed_hashes_without_archive(self):
        validation = {
            **self.required_validation,
            "ok": True, "id": "test-pack", "version": "1.0.0",
            "species": 1, "objects": 1, "expanded_bytes": 1024,
            "archive_sha256": "a" * 64, "manifest_sha256": "b" * 64,
            "public_manifest": self.public_manifest,
        }
        result = report.build_report(None, validation)
        self.assertTrue(result["ok"])
        self.assertEqual(result["summary"]["archive_sha256"], "a" * 64)

    def test_failure_text_is_cleaned_and_truncated(self):
        result = report.build_report(self.archive, {"ok": False, "error": "<bad>\n" + "x" * 300})
        self.assertFalse(result["ok"])
        self.assertNotIn("<", result["findings"][0])
        self.assertLessEqual(len(result["findings"][0]), 240)

    def test_maximum_ai_sample_and_flag_paths_remain_exact_and_distinct(self):
        first = "illustrations/" + "a" * 163 + "-2.png"
        second = "illustrations/" + "a" * 162 + "b-2.png"
        self.assertEqual(len(first), report.MAX_ILLUSTRATION_PATH_CHARS)
        self.assertEqual(len(second), report.MAX_ILLUSTRATION_PATH_CHARS)

        def normalize(path):
            return report.normalize_ai_review({
                "schema_version": 1,
                "prompt_version": "avian-bundle-triage-v2",
                "model": "gpt-5.6-luna",
                "ok": True,
                "checked": 1,
                "sampled": 1,
                "bird_assessment": {"not_bird": 0, "uncertain": 0},
                "style_assessment": {
                    "name_fit": "apt", "consistency": "consistent", "summary": "Exact.",
                },
                "flags": [{
                    "file": path, "code": "style_uncertain", "confidence": 0.8,
                    "reason": "Review.", "canonical_index": 0,
                    "preview": {"sha256": "a" * 64, "bytes": 1234},
                }],
                "canonical_samples": [{
                    "object_ordinal": 0, "file": path, "sha256": "d" * 64,
                    "bytes": 1234, "width": 100, "height": 80, "role": "flag",
                }],
                "total_flag_count": 1,
                "flags_truncated": False,
                "contact_sheet": {"sha256": "b" * 64, "bytes": 2345, "sampled": 1},
            }, 1)

        first_result = normalize(first)
        second_result = normalize(second)
        self.assertTrue(first_result["ok"])
        self.assertTrue(second_result["ok"])
        self.assertEqual(first_result["flags"][0]["file"], first)
        self.assertEqual(first_result["canonical_samples"][0]["file"], first)
        self.assertNotEqual(
            first_result["flags"][0]["file"], second_result["flags"][0]["file"]
        )

    def test_184_character_ai_evidence_path_is_rejected_not_truncated(self):
        overlong = "illustrations/" + "a" * 166 + ".png"
        self.assertEqual(len(overlong), report.MAX_ILLUSTRATION_PATH_CHARS + 1)
        value = {
            "schema_version": 1,
            "prompt_version": "avian-bundle-triage-v2",
            "model": "gpt-5.6-luna",
            "ok": True,
            "checked": 1,
            "sampled": 1,
            "bird_assessment": {"not_bird": 0, "uncertain": 0},
            "style_assessment": {
                "name_fit": "apt", "consistency": "consistent", "summary": "Exact.",
            },
            "flags": [{
                "file": overlong, "code": "style_uncertain", "confidence": 0.8,
                "reason": "Review.", "canonical_index": 0,
            }],
            "canonical_samples": [{
                "object_ordinal": 0, "file": overlong, "sha256": "d" * 64,
                "bytes": 1234, "width": 100, "height": 80, "role": "flag",
            }],
            "total_flag_count": 1,
            "flags_truncated": False,
            "contact_sheet": {"sha256": "b" * 64, "bytes": 2345, "sampled": 1},
        }
        normalized = report.normalize_ai_review(value, 1)
        self.assertFalse(normalized["ok"])
        self.assertEqual(normalized["flags"], [])

    def test_report_rejects_delete_control_in_public_text_and_url(self):
        base = {
            **self.required_validation,
            "ok": True, "id": "test-pack", "version": "1.0.0",
            "species": 1, "objects": 1, "expanded_bytes": 1024,
            "archive_sha256": "a" * 64, "manifest_sha256": "b" * 64,
        }
        for public_manifest in (
            {**self.public_manifest, "description": "delete\x7fcontrol"},
            {
                **self.public_manifest,
                "attribution": {
                    "creator": "Test",
                    "source_url": "https://example.com/delete\x7fcontrol",
                },
            },
        ):
            with self.subTest(public_manifest=public_manifest):
                result = report.build_report(
                    None, {**base, "public_manifest": public_manifest},
                )
                self.assertFalse(result["ok"])
                self.assertIn("public manifest", result["findings"][0])

    def test_report_rejects_reserved_community_id_and_invalid_coverage_semantics(self):
        base = {
            **self.required_validation,
            "ok": True, "id": "test-pack", "version": "1.0.0",
            "species": 1, "objects": 1, "expanded_bytes": 1024,
            "archive_sha256": "a" * 64, "manifest_sha256": "b" * 64,
        }
        reserved = {
            **self.public_manifest,
            "id": "official-lookalike",
        }
        result = report.build_report(
            None, {**base, "id": "official-lookalike", "public_manifest": reserved},
        )
        self.assertFalse(result["ok"])
        self.assertIn("public manifest", result["findings"][0])

        for coverage in (
            {"type": "region", "label": "Nowhere", "region_codes": []},
            {"type": "global", "label": "Global", "region_codes": ["US-CA"]},
        ):
            with self.subTest(coverage=coverage):
                result = report.build_report(None, {
                    **base,
                    "public_manifest": {**self.public_manifest, "coverage": coverage},
                })
                self.assertFalse(result["ok"])
                self.assertIn("public manifest", result["findings"][0])

    def test_report_rejects_literal_backslash_in_attribution_url(self):
        validation = {
            **self.required_validation,
            "ok": True, "id": "test-pack", "version": "1.0.0",
            "species": 1, "objects": 1, "expanded_bytes": 1024,
            "archive_sha256": "a" * 64, "manifest_sha256": "b" * 64,
            "public_manifest": {
                **self.public_manifest,
                "attribution": {
                    "creator": "Test",
                    "source_url": "https://artist.example/work\\credit",
                },
            },
        }
        result = report.build_report(None, validation)
        self.assertFalse(result["ok"])
        self.assertIn("public manifest", result["findings"][0])

        validation["public_manifest"]["attribution"]["source_url"] = (
            "https://artist.example:8443/work?view=full#credit"
        )
        result = report.build_report(None, validation)
        self.assertTrue(result["ok"])
        self.assertEqual(
            result["public_manifest"]["attribution"]["source_url"],
            "https://artist.example:8443/work?view=full#credit",
        )

    def test_submission_claim_mismatch_becomes_validation_failure(self):
        manifest = {
            "name": "Archive name",
            "species": [{}],
            "style": {"name": "Woodblock"},
            "license": {"spdx": "CC-BY-4.0"},
            "coverage": {"label": "California", "region_codes": ["US-CA"]},
        }
        with zipfile.ZipFile(self.archive, "w") as bundle:
            bundle.writestr("manifest.json", json.dumps(manifest))
        context = {
            "metadata": {
                "name": "Different name",
                "species_count": 1,
                "style_name": "Woodblock",
                "license_spdx": "CC-BY-4.0",
                "region_label": "California",
                "region_codes": ["US-CA"],
                "provenance": {"method": "manual", "model": None},
            }
        }
        validation = {
            **self.required_validation,
            "ok": True, "id": "test-pack", "version": "1.0.0",
            "species": 1, "objects": 1, "expanded_bytes": 1024,
            "public_manifest": self.public_manifest,
        }
        result = report.build_report(self.archive, validation, context)
        self.assertFalse(result["ok"])
        self.assertIn("bundle name", result["findings"][0])

    def test_moderation_outage_fails_closed(self):
        validation = {
            **self.required_validation,
            "ok": True, "id": "test-pack", "version": "1.0.0",
            "species": 1, "objects": 1, "expanded_bytes": 1024,
            "public_manifest": self.public_manifest,
        }
        result = report.build_report(
            self.archive, validation, moderation={"ok": False, "error": "moderation request failed"}
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["findings"], ["moderation request failed"])
        self.assertNotIn("public_manifest", result)

    def test_flagged_safety_content_blocks_submission(self):
        validation = {
            **self.required_validation,
            "ok": True, "id": "test-pack", "version": "1.0.0",
            "species": 1, "objects": 1, "expanded_bytes": 1024,
            "public_manifest": self.public_manifest,
        }
        moderation = {
            "ok": True, "images": 1, "checked": 2, "flagged_count": 1,
            "metadata_checked": True,
            "object_inventory_sha256": self.inventory_sha256,
            "flagged": [{"file": "illustrations/test.png", "categories": ["violence"]}],
        }
        result = report.build_report(self.archive, validation, moderation=moderation)
        self.assertFalse(result["ok"])
        self.assertEqual(result["summary"]["moderation_flagged"], 1)
        self.assertIn("violence", result["findings"][0])
        self.assertNotIn("public_manifest", result)

    def test_incomplete_safety_coverage_fails_closed(self):
        validation = {
            **self.required_validation,
            "ok": True, "id": "test-pack", "version": "1.0.0",
            "species": 2, "objects": 2, "expanded_bytes": 1024,
            "public_manifest": self.public_manifest,
        }
        moderation = {
            "ok": True, "checked": 2, "flagged_count": 0, "flagged": [],
            "metadata_checked": True,
            "object_inventory_sha256": self.inventory_sha256,
        }
        result = report.build_report(self.archive, validation, moderation=moderation)
        self.assertFalse(result["ok"])
        self.assertIn("every image", result["findings"][0])

    def test_unapproved_hosted_license_cannot_enter_success_report(self):
        validation = {
            **self.required_validation,
            "ok": True, "id": "test-pack", "version": "1.0.0",
            "species": 1, "objects": 1, "expanded_bytes": 1024,
            "archive_sha256": "a" * 64, "manifest_sha256": "b" * 64,
            "public_manifest": {**self.public_manifest, "license": {"spdx": "LicenseRef-Custom"}},
        }
        result = report.build_report(None, validation)
        self.assertFalse(result["ok"])
        self.assertIn("public manifest", result["findings"][0])

    def test_ai_flags_are_bounded_structured_and_advisory(self):
        validation = {
            **self.required_validation,
            "ok": True, "id": "test-pack", "version": "1.0.0",
            "species": 1, "objects": 1, "expanded_bytes": 1024,
            "public_manifest": self.public_manifest,
        }
        ai_review = {
            "schema_version": 1,
            "prompt_version": "avian-bundle-triage-v1",
            "model": "gpt-5.6-luna",
            "ok": True,
            "checked": 1,
            "sampled": 1,
            "bird_assessment": {"not_bird": 1, "uncertain": 0},
            "style_assessment": {"name_fit": "mismatch", "consistency": "mixed", "summary": "Two treatments."},
            "flags": [{
                "file": "illustrations/test.png",
                "code": "not_bird",
                "confidence": .94,
                "reason": "The subject appears to be a cat.",
                "canonical_index": 0,
                "preview": {"sha256": "a" * 64, "bytes": 1234},
            }],
            "canonical_samples": [self.canonical_sample],
            "total_flag_count": 1,
            "flags_truncated": False,
            "contact_sheet": {"sha256": "b" * 64, "bytes": 2345, "sampled": 1},
        }
        result = report.build_report(self.archive, validation, ai_review=ai_review)
        self.assertTrue(result["ok"])
        self.assertTrue(result["ai_review"]["ok"])
        self.assertEqual(result["ai_review"]["flags"][0]["code"], "not_bird")
        self.assertEqual(result["ai_review"]["contact_sheet"]["sampled"], 1)
        self.assertTrue(any("style name" in finding for finding in result["findings"]))

    def test_ai_flag_truncation_is_explicit(self):
        validation = {
            **self.required_validation,
            "ok": True, "id": "test-pack", "version": "1.0.0",
            "species": 6, "objects": 6, "expanded_bytes": 1024,
            "archive_sha256": "a" * 64, "manifest_sha256": "b" * 64,
            "public_manifest": self.public_manifest,
        }
        flags = [{
            "file": "illustrations/test.png", "code": "style_outlier",
            "confidence": .8, "reason": f"Outlier {index}", "canonical_index": 0,
            "preview": {"sha256": "a" * 64, "bytes": 1234},
        } for index in range(40)]
        ai_review = {
            "schema_version": 1, "prompt_version": "avian-bundle-triage-v1",
            "model": "gpt-5.6-luna", "ok": True, "checked": 6, "sampled": 6,
            "bird_assessment": {"not_bird": 0, "uncertain": 0},
            "style_assessment": {
                "name_fit": "apt", "consistency": "mixed", "summary": "Some outliers.",
            },
            "flags": flags, "canonical_samples": [self.canonical_sample],
            "total_flag_count": 41, "flags_truncated": True,
            "contact_sheet": {"sha256": "b" * 64, "bytes": 2345, "sampled": 6},
        }
        result = report.build_report(None, validation, ai_review=ai_review)
        self.assertTrue(result["ok"])
        self.assertEqual(result["ai_review"]["total_flag_count"], 41)
        self.assertTrue(result["ai_review"]["flags_truncated"])
        self.assertTrue(any("40 of 41" in finding for finding in result["findings"]))

    def test_thirteen_object_report_keeps_style_and_contact_sample_counts_independent(self):
        inventory = [{
            "file": f"illustrations/bird-{index}.png",
            "sha256": f"{index + 1:064x}",
            "bytes": 1000 + index,
        } for index in range(13)]
        validation = {
            "ok": True, "id": "test-pack", "version": "1.0.0",
            "species": 13, "objects": 13, "expanded_bytes": 20_000,
            "archive_sha256": "a" * 64, "manifest_sha256": "b" * 64,
            "publish_manifest_sha256": "c" * 64,
            "publish_object_inventory": inventory,
            "public_manifest": self.public_manifest,
        }
        samples = [{
            "object_ordinal": index,
            "file": item["file"],
            "sha256": item["sha256"],
            "bytes": item["bytes"],
            "width": 100,
            "height": 80,
            "role": "control",
        } for index, item in enumerate(inventory[:12])]
        ai_review = {
            "schema_version": 1,
            "prompt_version": "avian-bundle-triage-v2",
            "model": "gpt-5.6-luna",
            "ok": True,
            "checked": 13,
            "sampled": 6,
            "bird_assessment": {"not_bird": 0, "uncertain": 0},
            "style_assessment": {
                "name_fit": "apt", "consistency": "consistent", "summary": "Consistent.",
            },
            "flags": [],
            "canonical_samples": samples,
            "total_flag_count": 0,
            "flags_truncated": False,
            "contact_sheet": {"sha256": "e" * 64, "bytes": 4096, "sampled": 12},
        }
        moderation = {
            "ok": True,
            "images": 13,
            "checked": 14,
            "metadata_checked": True,
            "object_inventory_sha256": bundle_inventory_commitment.inventory_sha256(inventory),
            "flagged": [],
            "flagged_count": 0,
        }
        result = report.build_report(
            None, validation, moderation=moderation, ai_review=ai_review,
        )
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["ai_review"]["sampled"], 6)
        self.assertEqual(result["ai_review"]["contact_sheet"]["sampled"], 12)

    def test_ai_outage_is_visible_but_does_not_fail_safe_submission(self):
        validation = {
            **self.required_validation,
            "ok": True, "id": "test-pack", "version": "1.0.0",
            "species": 1, "objects": 1, "expanded_bytes": 1024,
            "public_manifest": self.public_manifest,
        }
        ai_review = report.failed_ai_review("temporary API outage")
        result = report.build_report(self.archive, validation, ai_review=ai_review)
        self.assertTrue(result["ok"])
        self.assertFalse(result["ai_review"]["ok"])
        self.assertIn("temporary API outage", result["findings"][0])


if __name__ == "__main__":
    unittest.main()
