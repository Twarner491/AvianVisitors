#!/usr/bin/env python3
"""Validate an untrusted bundle and emit a bounded, secret-free review package."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import tempfile
import zipfile
from pathlib import Path

import bundle_ai_review
import bundle_canonical
import bundle_inventory_commitment
import bundle_validation_contract as manager
import bundle_preview_geometry
import bundle_submission_check
import bundle_validate


SCHEMA_VERSION = 1
MAX_CONTEXT_BYTES = 256 * 1024
MAX_CANONICAL_BYTES = (
    bundle_validate.MAX_HOSTED_OBJECTS + 1
) * bundle_ai_review.MAX_REVIEW_PREVIEW_BYTES
MAX_SOURCE_BYTES = bundle_validate.MAX_EXPANDED_BYTES


def read_context(path: Path) -> dict:
    if not path.is_file() or path.stat().st_size > MAX_CONTEXT_BYTES:
        raise bundle_submission_check.ClaimMismatch("submission context is missing or too large")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise bundle_submission_check.ClaimMismatch("submission context is invalid") from exc
    if not isinstance(value, dict):
        raise bundle_submission_check.ClaimMismatch("submission context is invalid")
    return value


def manifest_items(manifest: dict) -> list[dict]:
    items = []
    for bird in manifest["species"]:
        for pose in bird["poses"]:
            items.append({
                "file": pose["file"],
                "source_sha256": pose["sha256"],
                "scientific_name": bird["scientific_name"],
                "common_name": str(bird.get("common_name") or "")[:100],
                "pose": pose["id"],
            })
    return items


def public_metadata(manifest: dict, items: list[dict]) -> dict:
    return {
        "name": manifest.get("name"),
        "description": manifest.get("description"),
        "style": manifest.get("style"),
        "coverage": manifest.get("coverage"),
        "license": manifest.get("license"),
        "attribution": manifest.get("attribution"),
        "provenance": manifest.get("provenance"),
        "species": [
            {
                "scientific_name": item["scientific_name"],
                "common_name": item["common_name"],
            }
            for item in items
        ],
    }


def public_manifest(manifest: dict) -> dict:
    style = manifest.get("style") or {}
    coverage = manifest.get("coverage") or {}
    license_data = manifest.get("license") or {}
    attribution = manifest.get("attribution") or {}
    provenance = manifest.get("provenance") or {"method": "manual", "model": None, "review": None}
    return {
        "id": manifest.get("id"),
        "version": manifest.get("version"),
        "name": manifest.get("name"),
        "description": manifest.get("description") or "",
        "style": {"id": style.get("id"), "name": style.get("name")},
        "coverage": {
            "type": coverage.get("type"),
            "label": coverage.get("label"),
            "region_codes": coverage.get("region_codes") or [],
        },
        "license": {"spdx": license_data.get("spdx")},
        "attribution": {
            "creator": attribution.get("creator"),
            "source_url": attribution.get("source_url") or None,
        },
        "provenance": {
            "method": provenance.get("method"),
            "model": provenance.get("model") or None,
            "review": provenance.get("review") or None,
        },
    }


def create_review_package(archive_path: Path, context_path: Path, output_dir: Path) -> dict:
    validation = bundle_validate.validate_archive(archive_path, producer_contract=True)
    context = read_context(context_path)
    bundle_submission_check.check_claims(archive_path, context)
    metadata = context.get("metadata")
    cover_species = metadata.get("cover_species") if isinstance(metadata, dict) else None
    if not isinstance(cover_species, str):
        raise manager.BundleError("submission cover species is missing")
    if output_dir.exists():
        raise manager.BundleError("review package destination already exists")

    with zipfile.ZipFile(archive_path) as archive:
        submitted_manifest = json.loads(archive.read("manifest.json").decode("utf-8"))
        items = manifest_items(submitted_manifest)
        parent = output_dir.parent
        parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".bundle-review-", dir=parent) as temp_name:
            stage = Path(temp_name)
            image_dir = stage / "images"
            image_dir.mkdir()
            source_dir = stage / "source-images"
            source_dir.mkdir()
            package_items = []
            canonical_inventory = []
            canonical_paths = {}
            seen_canonical = set()
            canonical_total = 0
            source_total = 0
            for ordinal, item in enumerate(items):
                source = archive.read(item["file"])
                if (
                    len(source) > manager.MAX_OBJECT_BYTES
                    or hashlib.sha256(source).hexdigest() != item["source_sha256"]
                ):
                    raise manager.BundleError("validated source image changed during sanitization")
                try:
                    canonical_source = bundle_canonical.canonical_png(source)
                except bundle_canonical.CanonicalizationError as exc:
                    raise manager.BundleError(str(exc)) from exc
                canonical_descriptor = bundle_canonical.descriptor(item["file"], canonical_source)
                width, height = bundle_canonical.png_dimensions(canonical_source)
                if canonical_descriptor["sha256"] in seen_canonical:
                    raise manager.BundleError(
                        "canonicalization produced duplicate illustration bytes for multiple poses"
                    )
                seen_canonical.add(canonical_descriptor["sha256"])
                canonical_inventory.append(canonical_descriptor)
                source_total += len(canonical_source)
                if source_total > MAX_SOURCE_BYTES:
                    raise manager.BundleError("review source inventory exceeds its byte limit")
                source_relative = f"source-images/{ordinal:04d}.png"
                source_path = stage / source_relative
                source_path.write_bytes(canonical_source)
                manager.validate_png(source_path, len(canonical_source))
                try:
                    bundle_preview_geometry.station_full_canvas_geometry(canonical_source)
                except bundle_preview_geometry.PreviewGeometryError as exc:
                    raise manager.BundleError(str(exc)) from exc
                canonical_paths[item["file"]] = source_path
                image = bundle_ai_review.dual_ground_jpeg(
                    canonical_source, bundle_ai_review.MAX_REVIEW_PREVIEW_BYTES,
                )
                canonical_total += len(image)
                if canonical_total > MAX_CANONICAL_BYTES:
                    raise manager.BundleError("canonical review package exceeds its byte limit")
                relative = f"images/{ordinal:04d}.jpg"
                (stage / relative).write_bytes(image)
                package_items.append({
                    **item,
                    "input_sha256": item["source_sha256"],
                    "source_image": source_relative,
                    "source_sha256": canonical_descriptor["sha256"],
                    "source_bytes": canonical_descriptor["bytes"],
                    "width": width,
                    "height": height,
                    "canonical_dual": True,
                    "image": relative,
                    "sha256": hashlib.sha256(image).hexdigest(),
                    "bytes": len(image),
                })
            try:
                publish_manifest, publish_manifest_raw = bundle_canonical.publish_manifest(
                    submitted_manifest, canonical_inventory
                )
            except bundle_canonical.CanonicalizationError as exc:
                raise manager.BundleError(str(exc)) from exc
            (stage / "publish-manifest.json").write_bytes(publish_manifest_raw)
            try:
                bundle_preview_geometry.build_preview_package_from_reader(
                    publish_manifest,
                    publish_manifest_raw,
                    lambda file: canonical_paths[file].read_bytes(),
                    cover_species,
                )
            except bundle_preview_geometry.PreviewGeometryError as exc:
                raise manager.BundleError(str(exc)) from exc
            contact_data, sampled = bundle_ai_review.build_contact_sheet(
                lambda item: canonical_paths[item["file"]].read_bytes(), items, [],
            )
            canonical_total += len(contact_data)
            if canonical_total > MAX_CANONICAL_BYTES:
                raise manager.BundleError("canonical review package exceeds its byte limit")
            (stage / "contact-0.jpg").write_bytes(contact_data)
            index = {
                "schema_version": SCHEMA_VERSION,
                "canonicalization": bundle_canonical.FORMAT,
                "metadata": public_metadata(publish_manifest, package_items),
                "public_manifest": public_manifest(publish_manifest),
                "publish_manifest_sha256": hashlib.sha256(publish_manifest_raw).hexdigest(),
                "object_inventory_sha256": bundle_inventory_commitment.inventory_sha256(
                    canonical_inventory
                ),
                "items": package_items,
                "contact_sheet": {
                    "image": "contact-0.jpg",
                    "sha256": hashlib.sha256(contact_data).hexdigest(),
                    "bytes": len(contact_data),
                    "sampled": sampled,
                },
            }
            encoded = json.dumps(index, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            if len(encoded) > bundle_validate.MAX_REVIEW_INDEX_BYTES:
                raise manager.BundleError("canonical review index exceeds its byte limit")
            (stage / "index.json").write_bytes(encoded)
            os.replace(stage, output_dir)
    validation["public_manifest"] = public_manifest(publish_manifest)
    validation["publish_manifest_sha256"] = hashlib.sha256(publish_manifest_raw).hexdigest()
    validation["publish_object_inventory"] = canonical_inventory
    return validation


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--context", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    try:
        result = create_review_package(args.archive, args.context, args.output)
    except (manager.BundleError, bundle_submission_check.ClaimMismatch) as exc:
        result = {"ok": False, "error": str(exc)}
    except Exception:
        result = {"ok": False, "error": "bundle sanitization failed unexpectedly"}
    print(json.dumps(result, separators=(",", ":")))
    # Validation failures are data, not workflow failures; the secret-bearing job
    # reports the bounded result without ever receiving the raw archive.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
