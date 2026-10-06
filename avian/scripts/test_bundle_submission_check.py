#!/usr/bin/env python3
from __future__ import annotations

import json
import tempfile
import unittest
import zipfile
from pathlib import Path

import bundle_submission_check as claims


def manifest() -> dict:
    return {
        "name": "Test birds",
        "style": {"name": "Japanese woodblock"},
        "coverage": {"label": "Northern California", "region_codes": ["US-CA"]},
        "license": {"spdx": "CC-BY-4.0"},
        "provenance": {"method": "generated", "model": "Example model", "review": "contributor-reviewed"},
        "attribution": {"creator": "Bird Artist", "source_url": "https://example.com/birds"},
        "species": [{"scientific_name": "Turdus migratorius"}],
    }


def context() -> dict:
    return {
        "metadata": {
            "name": "Test birds",
            "style_name": "Japanese woodblock",
            "region_label": "Northern California",
            "region_codes": ["US-CA"],
            "license_spdx": "CC-BY-4.0",
            "provenance": {"method": "generated", "model": "Example model", "review": "contributor-reviewed"},
            "attribution": {"creator": "Bird Artist", "source_url": "https://example.com/birds"},
            "species_count": 1,
        }
    }


class SubmissionClaimTests(unittest.TestCase):
    def archive(self, root: Path, value: dict) -> Path:
        path = root / "bundle.zip"
        with zipfile.ZipFile(path, "w") as bundle:
            bundle.writestr("manifest.json", json.dumps(value))
        return path

    def test_matching_claims_pass(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            claims.check_claims(self.archive(Path(name), manifest()), context())

    def test_public_license_cannot_differ_from_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            submitted = context()
            submitted["metadata"]["license_spdx"] = "CC0-1.0"
            with self.assertRaisesRegex(claims.ClaimMismatch, "license"):
                claims.check_claims(self.archive(Path(name), manifest()), submitted)

    def test_generated_art_cannot_be_claimed_as_manual(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            submitted = context()
            submitted["metadata"]["provenance"] = {
                "method": "manual", "model": None, "review": "contributor-reviewed",
            }
            with self.assertRaisesRegex(claims.ClaimMismatch, "artwork method"):
                claims.check_claims(self.archive(Path(name), manifest()), submitted)

    def test_region_code_order_is_not_significant(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            value = manifest()
            value["coverage"]["region_codes"] = ["US-NV", "US-CA"]
            submitted = context()
            submitted["metadata"]["region_codes"] = ["US-CA", "US-NV"]
            claims.check_claims(self.archive(Path(name), value), submitted)


if __name__ == "__main__":
    unittest.main()
