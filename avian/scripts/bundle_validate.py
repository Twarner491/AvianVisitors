#!/usr/bin/env python3
"""Validate a self-contained bird bundle archive without installing it."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

import bundle_validation_contract as manager


MAX_ARCHIVE_BYTES = 768 * 1024 * 1024
# Hosted review must finish inside one bounded Actions job. The two current
# full-size official candidates contain 666 objects, so this still leaves
# generous room without allowing a 10,000-request moderation flood.
MAX_HOSTED_SPECIES = 1000
MAX_HOSTED_OBJECTS = 1500
MAX_EXPANDED_BYTES = 640 * 1024 * 1024
MAX_FILES = MAX_HOSTED_OBJECTS + 64
MAX_TEXT_BYTES = 1024 * 1024
# Separate from uploaded text: 1,500 UTF-8 review items and repeated bounded names.
MAX_REVIEW_INDEX_BYTES = 3 * 1024 * 1024
MAX_RATIO = 100
ALLOWED_COMPRESSIONS = {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}
SUPPORTED_HOSTED_LICENSES = {
    "CC0-1.0", "CC-BY-4.0", "CC-BY-SA-4.0", "CC-BY-NC-SA-4.0",
}
MAX_PUBLIC_METADATA_CHARS = 160_000
PROMPT_INJECTION = re.compile(
    r"(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|system|developer)?\s*"
    r"(?:instructions?|prompts?|messages?)|(?:system|developer|assistant)\s*prompt|<\|[^>]{1,80}\|>",
    re.IGNORECASE,
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(128 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def normalized_name(name: str) -> str:
    if "\\" in name or "\x00" in name:
        raise manager.BundleError("archive contains an invalid path")
    path = PurePosixPath(name)
    if path.is_absolute() or not path.parts or any(part in {"", ".", ".."} for part in path.parts):
        raise manager.BundleError("archive contains an unsafe path")
    return str(path)


def allowed_name(name: str) -> bool:
    if name in {"manifest.json", "README.md"}:
        return True
    if re.fullmatch(r"LICENSES/[A-Za-z0-9._-]{1,100}\.txt", name):
        return True
    if re.fullmatch(r"illustrations/[a-z0-9]+(?:-[a-z0-9]+)*(?:-2)?\.png", name):
        return True
    return False


def checked_public_text(
    value: object, label: str, limit: int, required: bool = False,
    producer_contract: bool = False,
) -> str:
    if value is None and not required:
        return ""
    if not isinstance(value, str) or (required and not value.strip()) or len(value) > limit:
        raise manager.BundleError(f"manifest {label} is invalid")
    if any(
        ord(char) < 0x20
        or (producer_contract and ord(char) == 0x7F)
        or 0xD800 <= ord(char) <= 0xDFFF
        or char in "<>"
        for char in value
    ):
        raise manager.BundleError(f"manifest {label} is invalid")
    if PROMPT_INJECTION.search(value):
        raise manager.BundleError("manifest metadata contains instruction-like content")
    return value


def validate_review_metadata(manifest: dict, producer_contract: bool = False) -> None:
    license_data = manifest.get("license")
    if (
        not isinstance(license_data, dict)
        or license_data.get("spdx") not in SUPPORTED_HOSTED_LICENSES
    ):
        raise manager.BundleError("hosted bundle license is not supported")
    def public_text(value: object, label: str, limit: int, required: bool = False) -> str:
        return checked_public_text(
            value, label, limit, required, producer_contract=producer_contract
        )
    values = [
        public_text(manifest.get("name"), "name", 90, True),
        public_text(manifest.get("description"), "description", 260),
    ]
    style = manifest.get("style") or {}
    coverage = manifest.get("coverage") or {}
    attribution = manifest.get("attribution") or {}
    provenance = manifest.get("provenance") or {}
    values.extend([
        public_text(style.get("name"), "style name", 80, True),
        public_text(coverage.get("label"), "coverage label", 120, True),
        public_text(attribution.get("creator"), "creator", 120, True),
        public_text(attribution.get("source_url"), "source URL", 500),
        public_text(provenance.get("method"), "provenance method", 40),
        public_text(provenance.get("model"), "provenance model", 120),
        public_text(provenance.get("review"), "review state", 80),
    ])
    species = manifest.get("species")
    if isinstance(species, list):
        for bird in species:
            if isinstance(bird, dict):
                values.append(public_text(bird.get("common_name"), "common name", 100))
    if sum(len(value) for value in values) > MAX_PUBLIC_METADATA_CHARS:
        raise manager.BundleError("manifest public metadata exceeds the text limit")


def reject_nested_public_overrides(manifest: dict) -> None:
    """Keep every hosted-v1 public claim at the reviewed top level.

    The installed format historically reserved these keys on species and poses,
    but hosted review does not surface or moderate them.  Accepting them here
    would create an unreviewed text channel that publication could preserve.
    """
    override_keys = {"license", "attribution", "provenance"}
    species = manifest.get("species")
    if not isinstance(species, list):
        return
    for bird in species:
        if not isinstance(bird, dict):
            continue
        if override_keys.intersection(bird):
            raise manager.BundleError(
                "hosted bundles do not support per-species metadata overrides"
            )
        poses = bird.get("poses")
        if not isinstance(poses, list):
            continue
        for pose in poses:
            if isinstance(pose, dict) and override_keys.intersection(pose):
                raise manager.BundleError(
                    "hosted bundles do not support per-pose metadata overrides"
                )


def validate_archive(path: Path, producer_contract: bool = False) -> dict:
    if not path.is_file() or path.stat().st_size > MAX_ARCHIVE_BYTES:
        raise manager.BundleError("archive is missing or exceeds the compressed-size limit")
    try:
        archive = zipfile.ZipFile(path)
    except (OSError, zipfile.BadZipFile) as exc:
        raise manager.BundleError("upload is not a valid ZIP archive") from exc
    with archive:
        all_infos = archive.infolist()
        if len(all_infos) > MAX_FILES + 64:
            raise manager.BundleError("archive entry count is outside the allowed limit")
        infos = [info for info in all_infos if not info.is_dir()]
        if not 1 <= len(infos) <= MAX_FILES:
            raise manager.BundleError("archive file count is outside the allowed limit")
        names: dict[str, zipfile.ZipInfo] = {}
        folded = set()
        expanded = 0
        for info in infos:
            name = normalized_name(info.filename)
            if name in names or name.casefold() in folded:
                raise manager.BundleError("archive contains duplicate or case-colliding paths")
            names[name] = info
            folded.add(name.casefold())
            mode = (info.external_attr >> 16) & 0xFFFF
            if mode and stat.S_ISLNK(mode):
                raise manager.BundleError("archive contains a symlink")
            if info.flag_bits & 0x1:
                raise manager.BundleError("encrypted archives are not supported")
            if info.compress_type not in ALLOWED_COMPRESSIONS:
                raise manager.BundleError("archive uses an unsupported compression method")
            if not allowed_name(name):
                raise manager.BundleError("archive contains an unsupported file type")
            if name.startswith("illustrations/") and info.file_size > manager.MAX_OBJECT_BYTES:
                raise manager.BundleError("archive PNG exceeds the object-size limit")
            if (name == "README.md" or name.startswith("LICENSES/")) and info.file_size > MAX_TEXT_BYTES:
                raise manager.BundleError("archive text file exceeds the size limit")
            expanded += info.file_size
            if expanded > MAX_EXPANDED_BYTES:
                raise manager.BundleError("archive exceeds the expanded-size limit")
            if info.file_size > 0 and info.compress_size == 0:
                raise manager.BundleError("archive member has an invalid compression size")
            if info.compress_size and info.file_size / info.compress_size > MAX_RATIO:
                raise manager.BundleError("archive member exceeds the compression-ratio limit")
        manifest_info = names.get("manifest.json")
        if not manifest_info or manifest_info.file_size > manager.MAX_MANIFEST_BYTES:
            raise manager.BundleError("archive manifest is missing or too large")
        try:
            manifest = json.loads(archive.read(manifest_info).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise manager.BundleError("archive manifest is invalid JSON") from exc
        if not isinstance(manifest, dict):
            raise manager.BundleError("archive manifest must be a JSON object")
        species = manifest.get("species")
        if isinstance(species, list) and len(species) > MAX_HOSTED_SPECIES:
            raise manager.BundleError("archive exceeds the hosted species limit")
        reject_nested_public_overrides(manifest)
        validate_review_metadata(manifest, producer_contract)
        pack_id = manifest.get("id")
        version = manifest.get("version")
        _, _, objects, _ = manager.validate_manifest(
            manifest, {"id": pack_id, "version": version}, producer_contract
        )
        if len(objects) > MAX_HOSTED_OBJECTS:
            raise manager.BundleError("archive exceeds the hosted illustration limit")
        sha_claims: dict[str, list[str]] = {}
        for item in objects:
            sha_claims.setdefault(item["sha256"], []).append(item["file"])
        if any(len(files) > 1 for files in sha_claims.values()):
            raise manager.BundleError("archive reuses identical illustration bytes for multiple manifest poses")
        referenced = {item["file"] for item in objects}
        present_pngs = {name for name in names if name.startswith("illustrations/")}
        if referenced != present_pngs:
            raise manager.BundleError("archive illustration inventory does not match the manifest")
        license_file = manifest["license"].get("file")
        if (
            (producer_contract and license_file is not None)
            or (not producer_contract and bool(license_file))
        ) and license_file not in names:
            raise manager.BundleError("manifest license file is missing")
        normalized = []
        with tempfile.TemporaryDirectory(prefix="avian-bundle-validation-") as temp_name:
            temp = Path(temp_name)
            for index, item in enumerate(objects, start=1):
                info = names[item["file"]]
                destination = temp / f"{index}.png"
                digest = hashlib.sha256()
                total = 0
                with archive.open(info) as source, destination.open("xb") as output:
                    while True:
                        chunk = source.read(128 * 1024)
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > manager.MAX_OBJECT_BYTES:
                            raise manager.BundleError("archive PNG exceeds the object-size limit")
                        digest.update(chunk)
                        output.write(chunk)
                if total != item["bytes"] or digest.hexdigest() != item["sha256"]:
                    raise manager.BundleError("archive PNG does not match its manifest")
                manager.validate_png(destination, item["bytes"])
                normalized.append({"sha256": item["sha256"], "bytes": item["bytes"], "file": item["file"]})
        return {
            "ok": True,
            "id": pack_id,
            "version": version,
            "species": len(manifest["species"]),
            "objects": len(objects),
            "expanded_bytes": expanded,
            "archive_sha256": sha256_file(path),
            "manifest_sha256": hashlib.sha256(archive.read(manifest_info)).hexdigest(),
            "object_inventory": normalized,
        }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(
            validate_archive(args.archive, producer_contract=True), separators=(",", ":")
        ))
        return 0
    except manager.BundleError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, separators=(",", ":")))
        return 1
    except (EOFError, OSError, RuntimeError, zipfile.BadZipFile, zipfile.LargeZipFile):
        print(json.dumps({"ok": False, "error": "archive structure is invalid"}, separators=(",", ":")))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
