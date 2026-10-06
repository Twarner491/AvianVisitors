#!/usr/bin/env python3
"""Materialize one immutable moderated bundle into a publication package.

The canonical manifest and PNGs were decoded, normalized, moderated, and
persisted during validation.  This secret-free stage verifies and copies those
exact bytes, then decodes only the bounded preview subset to build public
catalog previews.  It never opens the contributor ZIP or re-encodes an object.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path

import bundle_canonical
import bundle_inventory_commitment
import bundle_validation_contract as manager
import bundle_preview_geometry
import bundle_submission_check
import bundle_validate


FORMAT = "avian-visitors-publication-package"
FORMAT_VERSION = 1
SUBMISSION_ID = re.compile(r"[a-z0-9_-]{20,40}")
SHA256 = re.compile(r"[0-9a-f]{64}")
MAX_CONTEXT_BYTES = 256 * 1024
MAX_INDEX_BYTES = 1024 * 1024
MAX_GEOMETRY_BYTES = 1024 * 1024
MAX_PREVIEW_BYTES = manager.MAX_OBJECT_BYTES
MAX_PREVIEWS = bundle_preview_geometry.MAX_EXAMPLES + 1
MAX_PACKAGE_BYTES = bundle_validate.MAX_EXPANDED_BYTES + (
    MAX_PREVIEWS * MAX_PREVIEW_BYTES
) + MAX_GEOMETRY_BYTES + manager.MAX_MANIFEST_BYTES


class PublicationPackageError(ValueError):
    pass


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def descriptor(path: str, value: bytes) -> dict[str, object]:
    return {"path": path, "sha256": sha256_bytes(value), "bytes": len(value)}


def write_new(root: Path, relative: str, value: bytes) -> None:
    target = root / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("xb") as output:
        output.write(value)


def read_json(path: Path, maximum: int, label: str) -> tuple[dict, bytes]:
    if (
        not path.is_file()
        or path.is_symlink()
        or not 1 <= path.stat().st_size <= maximum
    ):
        raise PublicationPackageError(f"{label} is missing or too large")
    raw = path.read_bytes()
    if len(raw) != path.stat().st_size:
        raise PublicationPackageError(f"{label} changed while being read")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PublicationPackageError(f"{label} is invalid") from exc
    if not isinstance(value, dict):
        raise PublicationPackageError(f"{label} is invalid")
    return value, raw


def checked_object(
    root: Path, ordinal: int, claim: dict, item: object,
) -> tuple[dict[str, object], bytes]:
    if not isinstance(item, dict) or set(item) != {
        "ordinal", "file", "sha256", "bytes", "width", "height"
    }:
        raise PublicationPackageError("canonical object descriptor is invalid")
    if (
        item.get("ordinal") != ordinal
        or item.get("file") != claim.get("file")
        or item.get("sha256") != claim.get("sha256")
        or item.get("bytes") != claim.get("bytes")
    ):
        raise PublicationPackageError("canonical object order does not match the manifest")
    width = item.get("width")
    height = item.get("height")
    if (
        not isinstance(width, int)
        or isinstance(width, bool)
        or not 1 <= width <= manager.MAX_IMAGE_SIDE
        or not isinstance(height, int)
        or isinstance(height, bool)
        or not 1 <= height <= manager.MAX_IMAGE_SIDE
    ):
        raise PublicationPackageError("canonical object dimensions are invalid")
    size = item["bytes"]
    if (
        not isinstance(size, int)
        or isinstance(size, bool)
        or not 1 <= size <= manager.MAX_OBJECT_BYTES
    ):
        raise PublicationPackageError("canonical object byte count is invalid")
    digest = item["sha256"]
    if not isinstance(digest, str) or not SHA256.fullmatch(digest):
        raise PublicationPackageError("canonical object checksum is invalid")

    path = root / f"{ordinal:04d}.png"
    if not path.is_file() or path.is_symlink() or path.stat().st_size != size:
        raise PublicationPackageError("canonical object is missing")
    value = path.read_bytes()
    if len(value) != size or sha256_bytes(value) != digest:
        raise PublicationPackageError("canonical object does not match its commitment")
    try:
        actual_width, actual_height = bundle_canonical.validate_canonical_structure(value)
    except bundle_canonical.CanonicalizationError as exc:
        raise PublicationPackageError("canonical object is not a strict RGBA8 PNG") from exc
    if (actual_width, actual_height) != (width, height):
        raise PublicationPackageError("canonical object dimensions do not match")
    return {
        "file": item["file"], "sha256": digest, "bytes": size,
        "width": width, "height": height,
    }, value


def materialize(
    canonical_index_path: Path,
    canonical_manifest_path: Path,
    canonical_objects: Path,
    context_path: Path,
    output: Path,
    submission_id: str,
) -> dict[str, object]:
    if not SUBMISSION_ID.fullmatch(submission_id):
        raise PublicationPackageError("submission identifier is invalid")
    if output.exists() and any(output.iterdir()):
        raise PublicationPackageError("publication output directory is not empty")
    if not canonical_objects.is_dir() or canonical_objects.is_symlink():
        raise PublicationPackageError("canonical object directory is missing")
    output.mkdir(parents=True, exist_ok=True)

    index, _ = read_json(canonical_index_path, MAX_INDEX_BYTES, "canonical index")
    required_index = {
        "schema_version", "canonicalization", "input_archive_sha256",
        "input_manifest_sha256", "publish_manifest_sha256",
        "object_inventory_sha256", "objects",
    }
    if set(index) != required_index or index.get("schema_version") != 1:
        raise PublicationPackageError("canonical index has an invalid shape")
    if index.get("canonicalization") != bundle_canonical.FORMAT:
        raise PublicationPackageError("canonicalization is unsupported")
    commitments = (
        index.get("input_archive_sha256"),
        index.get("input_manifest_sha256"),
        index.get("publish_manifest_sha256"),
        index.get("object_inventory_sha256"),
    )
    if any(not isinstance(value, str) or not SHA256.fullmatch(value) for value in commitments):
        raise PublicationPackageError("canonical index commitment is invalid")

    manifest, manifest_raw = read_json(
        canonical_manifest_path, manager.MAX_MANIFEST_BYTES, "canonical manifest"
    )
    if sha256_bytes(manifest_raw) != index["publish_manifest_sha256"]:
        raise PublicationPackageError("canonical manifest does not match its commitment")
    bundle_validate.reject_nested_public_overrides(manifest)
    bundle_validate.validate_review_metadata(manifest)
    pack_id = manifest.get("id")
    version = manifest.get("version")
    _, _, manifest_objects, _ = manager.validate_manifest(
        manifest, {"id": pack_id, "version": version}
    )
    if len(manifest_objects) > bundle_validate.MAX_HOSTED_OBJECTS:
        raise PublicationPackageError("canonical manifest exceeds the hosted object limit")
    try:
        manifest_inventory = bundle_inventory_commitment.manifest_inventory(manifest)
    except bundle_inventory_commitment.InventoryCommitmentError as exc:
        raise PublicationPackageError("canonical manifest inventory is invalid") from exc

    context, _ = read_json(context_path, MAX_CONTEXT_BYTES, "submission context")
    bundle_submission_check.check_manifest_claims(manifest, context)
    metadata = context.get("metadata")
    cover_species = metadata.get("cover_species") if isinstance(metadata, dict) else None
    if not isinstance(cover_species, str):
        raise PublicationPackageError("submission cover species is missing")

    indexed_objects = index.get("objects")
    if (
        not isinstance(indexed_objects, list)
        or not 1 <= len(indexed_objects) <= bundle_validate.MAX_HOSTED_OBJECTS
        or len(indexed_objects) != len(manifest_inventory)
    ):
        raise PublicationPackageError("canonical index object inventory is invalid")
    expected_object_names = {
        f"{ordinal:04d}.png" for ordinal in range(len(indexed_objects))
    }
    actual_object_names = {path.name for path in canonical_objects.iterdir()}
    if actual_object_names != expected_object_names:
        raise PublicationPackageError("canonical object directory has an unexpected inventory")

    canonical_inventory: list[dict[str, object]] = []
    canonical_by_file: dict[str, Path] = {}
    object_entries: list[dict[str, object]] = []
    total_objects = 0
    seen_digests: set[str] = set()
    for ordinal, (claim, item) in enumerate(zip(manifest_inventory, indexed_objects)):
        checked, value = checked_object(canonical_objects, ordinal, claim, item)
        digest = checked["sha256"]
        if digest in seen_digests:
            raise PublicationPackageError("canonical index contains duplicate object bytes")
        seen_digests.add(digest)
        canonical_inventory.append(checked)
        relative = f"objects/{digest}.png"
        write_new(output, relative, value)
        canonical_by_file[checked["file"]] = output / relative
        object_entries.append(descriptor(relative, value))
        total_objects += len(value)
        if total_objects > bundle_validate.MAX_EXPANDED_BYTES:
            raise PublicationPackageError("canonical objects exceed the aggregate byte limit")

    try:
        inventory_sha = bundle_inventory_commitment.inventory_sha256(canonical_inventory)
    except bundle_inventory_commitment.InventoryCommitmentError as exc:
        raise PublicationPackageError("canonical inventory is invalid") from exc
    if inventory_sha != index["object_inventory_sha256"]:
        raise PublicationPackageError("canonical inventory commitment does not match")

    manifest_entry = descriptor("manifest.json", manifest_raw)
    write_new(output, "manifest.json", manifest_raw)

    _, geometry_raw, preview_renders = (
        bundle_preview_geometry.build_preview_package_from_reader(
            manifest,
            manifest_raw,
            lambda file: canonical_by_file[file].read_bytes(),
            cover_species,
        )
    )
    if len(geometry_raw) > MAX_GEOMETRY_BYTES:
        raise PublicationPackageError("preview geometry exceeds the publication limit")
    if not 1 <= len(preview_renders) <= MAX_PREVIEWS:
        raise PublicationPackageError("preview count exceeds the publication limit")

    geometry_sha = sha256_bytes(geometry_raw)
    geometry_path = f"preview-geometry/{geometry_sha}.json"
    write_new(output, geometry_path, geometry_raw)
    geometry_entry = descriptor(geometry_path, geometry_raw)

    preview_entries: list[dict[str, object]] = []
    for digest in sorted(preview_renders):
        preview = preview_renders[digest]
        if not 1 <= len(preview) <= MAX_PREVIEW_BYTES or sha256_bytes(preview) != digest:
            raise PublicationPackageError("derived preview exceeds the publication limit")
        relative = f"previews/{digest}.png"
        write_new(output, relative, preview)
        preview_entries.append(descriptor(relative, preview))

    package = {
        "format": FORMAT,
        "format_version": FORMAT_VERSION,
        "submission_id": submission_id,
        "canonicalization": bundle_canonical.FORMAT,
        "archive_sha256": index["input_archive_sha256"],
        "input_manifest_sha256": index["input_manifest_sha256"],
        "publish_manifest_sha256": manifest_entry["sha256"],
        "object_inventory_sha256": inventory_sha,
        "manifest": manifest_entry,
        "objects": object_entries,
        "preview_geometry": geometry_entry,
        "previews": preview_entries,
        "species": len(manifest["species"]),
        "object_count": len(object_entries),
    }
    index_raw = (
        json.dumps(package, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        + "\n"
    ).encode("utf-8")
    write_new(output, "index.json", index_raw)

    total = sum(path.stat().st_size for path in output.rglob("*") if path.is_file())
    if total > MAX_PACKAGE_BYTES:
        raise PublicationPackageError("publication package exceeds the total-size limit")
    return {
        "ok": True,
        "submission_id": submission_id,
        "archive_sha256": index["input_archive_sha256"],
        "input_manifest_sha256": index["input_manifest_sha256"],
        "publish_manifest_sha256": manifest_entry["sha256"],
        "object_inventory_sha256": inventory_sha,
        "objects": len(object_entries),
        "previews": len(preview_entries),
        "bytes": total,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("submission_id")
    parser.add_argument("--canonical-index", type=Path, required=True)
    parser.add_argument("--canonical-manifest", type=Path, required=True)
    parser.add_argument("--canonical-objects", type=Path, required=True)
    parser.add_argument("--context", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        result = materialize(
            args.canonical_index, args.canonical_manifest, args.canonical_objects,
            args.context, args.output, args.submission_id,
        )
    except (
        PublicationPackageError,
        bundle_preview_geometry.PreviewGeometryError,
        bundle_submission_check.ClaimMismatch,
        manager.BundleError,
        EOFError,
        OSError,
        RuntimeError,
    ) as exc:
        result = {"ok": False, "error": str(exc)[:240]}
        print(json.dumps(result, separators=(",", ":")))
        return 1
    print(json.dumps(result, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
