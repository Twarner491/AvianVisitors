#!/usr/bin/env python3
"""Match public bundle submission claims to the archive manifest."""
from __future__ import annotations

import json
import zipfile
from pathlib import Path


class ClaimMismatch(ValueError):
    pass


def read_manifest(archive: Path) -> dict:
    with zipfile.ZipFile(archive) as bundle:
        value = json.loads(bundle.read("manifest.json").decode("utf-8"))
    if not isinstance(value, dict):
        raise ClaimMismatch("archive manifest is not an object")
    return value


def require_equal(actual: object, expected: object, label: str) -> None:
    if actual != expected:
        raise ClaimMismatch(f"submitted {label} does not match manifest.json")


def check_manifest_claims(manifest: dict, context: dict) -> None:
    metadata = context.get("metadata")
    if not isinstance(metadata, dict):
        raise ClaimMismatch("submission metadata is missing")
    require_equal(manifest.get("name"), metadata.get("name"), "bundle name")
    require_equal(len(manifest.get("species") or []), metadata.get("species_count"), "species count")
    require_equal((manifest.get("style") or {}).get("name"), metadata.get("style_name"), "style")
    require_equal((manifest.get("license") or {}).get("spdx"), metadata.get("license_spdx"), "license")
    coverage = manifest.get("coverage") or {}
    require_equal(coverage.get("label"), metadata.get("region_label"), "region")
    require_equal(
        sorted(set(coverage.get("region_codes") or [])),
        sorted(set(metadata.get("region_codes") or [])),
        "region codes",
    )
    submitted = metadata.get("provenance") or {}
    provenance = manifest.get("provenance") or {"method": "manual", "model": None}
    require_equal(provenance.get("method"), submitted.get("method"), "artwork method")
    require_equal(provenance.get("model") or None, submitted.get("model") or None, "model provenance")
    require_equal(provenance.get("review"), submitted.get("review"), "review state")
    attribution = manifest.get("attribution") or {}
    submitted_attribution = metadata.get("attribution") or {}
    require_equal(attribution.get("creator"), submitted_attribution.get("creator"), "creator attribution")
    require_equal(
        attribution.get("source_url") or None,
        submitted_attribution.get("source_url") or None,
        "attribution source",
    )


def check_claims(archive: Path, context: dict) -> None:
    check_manifest_claims(read_manifest(archive), context)
