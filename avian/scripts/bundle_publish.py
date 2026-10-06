#!/usr/bin/env python3
"""Upload a checksum-bound publication package through the protected API.

This credential-bearing program never opens an archive and never imports or
invokes an image decoder. All image derivation happens in the preceding
secret-free publication materializer.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import urllib.error
import urllib.request
from pathlib import Path, PurePosixPath

import bundle_http
import bundle_inventory_commitment

FORMAT = "avian-visitors-publication-package"
FORMAT_VERSION = 1
SUBMISSION_ID = re.compile(r"[a-z0-9_-]{20,40}")
ATTEMPT = re.compile(r"[A-Za-z0-9_-]{32}")
SHA256 = re.compile(r"[0-9a-f]{64}")
MAX_INDEX_BYTES = 512 * 1024
MAX_MANIFEST_BYTES = 4 * 1024 * 1024
MAX_OBJECT_BYTES = 4 * 1024 * 1024
MAX_OBJECTS = 1500
MAX_GEOMETRY_BYTES = 1024 * 1024
MAX_PREVIEW_BYTES = 4 * 1024 * 1024
MAX_PREVIEWS = 7
MAX_PACKAGE_BYTES = 700 * 1024 * 1024
MAX_RESPONSE_BYTES = 1024 * 1024
CANONICALIZATION = "rgba-png-zero-transparent-v1"


class PublicationError(RuntimeError):
    pass


def request_json(
    url: str, key: str, method: str, body: bytes, content_type: str,
    attempt: str | None = None,
) -> dict:
    headers = {
        "Content-Type": content_type,
        "Content-Length": str(len(body)),
        "X-Bundle-Publish-Key": key,
        "User-Agent": "AvianVisitors-bundle-publisher/2",
    }
    if attempt is not None:
        if not ATTEMPT.fullmatch(attempt):
            raise PublicationError("publication attempt token is invalid")
        headers["X-Bundle-Publication-Attempt"] = attempt
    request = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with bundle_http.urlopen(request, timeout=60) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as exc:
        detail = exc.read(4096).decode("utf-8", "replace")
        raise PublicationError(f"publication API returned HTTP {exc.code}: {detail}") from exc
    except OSError as exc:
        raise PublicationError("publication API could not be reached") from exc
    if len(raw) > MAX_RESPONSE_BYTES:
        raise PublicationError("publication API response is too large")
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PublicationError("publication API returned invalid JSON") from exc
    if not isinstance(value, dict) or not value.get("ok"):
        raise PublicationError("publication API did not confirm the operation")
    return value


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(128 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def read_bounded(path: Path, maximum: int) -> bytes:
    if not path.is_file() or path.is_symlink():
        raise PublicationError("publication package contains a missing or linked file")
    size = path.stat().st_size
    if not 1 <= size <= maximum:
        raise PublicationError("publication package file exceeds its size limit")
    with path.open("rb") as source:
        value = source.read(maximum + 1)
    if len(value) != size or len(value) > maximum:
        raise PublicationError("publication package file changed while being read")
    return value


def checked_descriptor(
    root: Path, value: object, expected_path: str, maximum: int
) -> tuple[dict[str, object], Path]:
    if not isinstance(value, dict) or set(value) != {"path", "sha256", "bytes"}:
        raise PublicationError("publication package has an invalid file descriptor")
    path = value.get("path")
    digest = value.get("sha256")
    size = value.get("bytes")
    if path != expected_path or not isinstance(path, str) or str(PurePosixPath(path)) != path:
        raise PublicationError("publication package has an invalid file path")
    if not isinstance(digest, str) or not SHA256.fullmatch(digest):
        raise PublicationError("publication package has an invalid checksum")
    if not isinstance(size, int) or isinstance(size, bool) or not 1 <= size <= maximum:
        raise PublicationError("publication package has an invalid byte count")
    target = root / path
    if not target.is_file() or target.is_symlink() or target.stat().st_size != size:
        raise PublicationError("publication package file does not match its descriptor")
    if sha256_file(target) != digest:
        raise PublicationError("publication package checksum does not match")
    return value, target


def load_package(root: Path, submission_id: str) -> dict[str, object]:
    if not root.is_dir() or root.is_symlink():
        raise PublicationError("publication package is missing")
    index_raw = read_bounded(root / "index.json", MAX_INDEX_BYTES)
    try:
        package = json.loads(index_raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PublicationError("publication package index is invalid") from exc
    required = {
        "format", "format_version", "submission_id", "canonicalization",
        "archive_sha256", "input_manifest_sha256", "publish_manifest_sha256",
        "object_inventory_sha256", "manifest", "objects", "preview_geometry",
        "previews", "species", "object_count",
    }
    if not isinstance(package, dict) or set(package) != required:
        raise PublicationError("publication package index has an invalid shape")
    if package.get("format") != FORMAT or package.get("format_version") != FORMAT_VERSION:
        raise PublicationError("publication package format is unsupported")
    if package.get("canonicalization") != CANONICALIZATION:
        raise PublicationError("publication package canonicalization is unsupported")
    if package.get("submission_id") != submission_id:
        raise PublicationError("publication package belongs to a different submission")
    archive_sha = package.get("archive_sha256")
    if not isinstance(archive_sha, str) or not SHA256.fullmatch(archive_sha):
        raise PublicationError("publication package archive checksum is invalid")
    input_manifest_sha = package.get("input_manifest_sha256")
    publish_manifest_sha = package.get("publish_manifest_sha256")
    inventory_sha = package.get("object_inventory_sha256")
    if any(
        not isinstance(value, str) or not SHA256.fullmatch(value)
        for value in (input_manifest_sha, publish_manifest_sha, inventory_sha)
    ):
        raise PublicationError("publication package commitment is invalid")

    manifest, manifest_path = checked_descriptor(
        root, package.get("manifest"), "manifest.json", MAX_MANIFEST_BYTES
    )
    if manifest["sha256"] != publish_manifest_sha:
        raise PublicationError("publication manifest does not match its commitment")
    objects = package.get("objects")
    if not isinstance(objects, list) or not 1 <= len(objects) <= MAX_OBJECTS:
        raise PublicationError("publication package object count is invalid")
    if package.get("object_count") != len(objects):
        raise PublicationError("publication package object count does not match")
    species = package.get("species")
    if not isinstance(species, int) or isinstance(species, bool) or not 1 <= species <= 1000:
        raise PublicationError("publication package species count is invalid")

    object_files: list[tuple[dict[str, object], Path]] = []
    seen: set[str] = set()
    for item in objects:
        if not isinstance(item, dict):
            raise PublicationError("publication package object descriptor is invalid")
        digest = item.get("sha256")
        if not isinstance(digest, str) or digest in seen:
            raise PublicationError("publication package contains a duplicate object")
        seen.add(digest)
        object_files.append(checked_descriptor(
            root, item, f"objects/{digest}.png", MAX_OBJECT_BYTES
        ))

    geometry_value = package.get("preview_geometry")
    geometry_digest = geometry_value.get("sha256") if isinstance(geometry_value, dict) else ""
    geometry, geometry_path = checked_descriptor(
        root, geometry_value, f"preview-geometry/{geometry_digest}.json", MAX_GEOMETRY_BYTES
    )
    previews = package.get("previews")
    if not isinstance(previews, list) or not 1 <= len(previews) <= MAX_PREVIEWS:
        raise PublicationError("publication package preview count is invalid")
    preview_files: list[tuple[dict[str, object], Path]] = []
    preview_digests: set[str] = set()
    for item in previews:
        if not isinstance(item, dict):
            raise PublicationError("publication package preview descriptor is invalid")
        digest = item.get("sha256")
        if not isinstance(digest, str) or digest in preview_digests:
            raise PublicationError("publication package contains a duplicate preview")
        preview_digests.add(digest)
        preview_files.append(checked_descriptor(
            root, item, f"previews/{digest}.png", MAX_PREVIEW_BYTES
        ))

    # Parsing bounded JSON does not invoke an image decoder and binds every
    # derived render to the exact manifest reviewed by the maintainer.
    try:
        manifest_json = json.loads(read_bounded(manifest_path, MAX_MANIFEST_BYTES))
        geometry_json = json.loads(read_bounded(geometry_path, MAX_GEOMETRY_BYTES))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PublicationError("publication package JSON asset is invalid") from exc
    if not isinstance(manifest_json, dict) or not isinstance(geometry_json, dict):
        raise PublicationError("publication package JSON asset is invalid")
    try:
        manifest_inventory = bundle_inventory_commitment.manifest_inventory(manifest_json)
        actual_inventory_sha = bundle_inventory_commitment.inventory_sha256(manifest_inventory)
    except bundle_inventory_commitment.InventoryCommitmentError as exc:
        raise PublicationError("publication manifest object inventory is invalid") from exc
    if actual_inventory_sha != inventory_sha:
        raise PublicationError("publication manifest object inventory commitment does not match")
    manifest_objects = {
        (item["sha256"], item["bytes"])
        for item in manifest_inventory
    }
    described_objects = {
        (item[0]["sha256"], item[0]["bytes"])
        for item in object_files
    }
    if len(manifest_objects) != len(manifest_inventory) or manifest_objects != described_objects:
        raise PublicationError("publication objects do not match the canonical manifest")
    if geometry_json.get("format") != "avian-bundle-preview-geometry":
        raise PublicationError("publication preview geometry format is invalid")
    if geometry_json.get("format_version") != 1:
        raise PublicationError("publication preview geometry version is invalid")
    if geometry_json.get("source_manifest_sha256") != manifest["sha256"]:
        raise PublicationError("publication preview geometry is not bound to the manifest")
    cover = geometry_json.get("cover")
    items = geometry_json.get("items")
    order = geometry_json.get("example_order")
    if not isinstance(cover, dict) or not isinstance(items, dict) or not isinstance(order, list):
        raise PublicationError("publication preview geometry inventory is invalid")
    geometry_renders = {cover.get("render_sha256"), *order}
    if (
        None in geometry_renders
        or len(geometry_renders) != len(preview_digests)
        or geometry_renders != preview_digests
        or set(items) != set(order)
    ):
        raise PublicationError("publication preview inventory does not match geometry")

    allowed_files = {
        "index.json", "manifest.json", geometry["path"],
        *(entry[0]["path"] for entry in object_files),
        *(entry[0]["path"] for entry in preview_files),
    }
    actual_files = {
        path.relative_to(root).as_posix()
        for path in root.rglob("*")
        if path.is_file() or path.is_symlink()
    }
    if actual_files != allowed_files:
        raise PublicationError("publication package contains unexpected files")
    total = sum((root / relative).stat().st_size for relative in actual_files)
    if total > MAX_PACKAGE_BYTES:
        raise PublicationError("publication package exceeds the total-size limit")
    return {
        "manifest": (manifest, manifest_path),
        "objects": object_files,
        "preview_geometry": (geometry, geometry_path),
        "previews": preview_files,
    }


def upload(
    base: str, submission_id: str, package_path: Path, key: str, attempt: str,
) -> dict:
    if not ATTEMPT.fullmatch(attempt):
        raise PublicationError("publication attempt token is invalid")
    package = load_package(package_path, submission_id)
    _, manifest_path = package["manifest"]
    prepared = request_json(
        f"{base}/api/bundles/publication/{submission_id}/manifest",
        key, "PUT", read_bounded(manifest_path, MAX_MANIFEST_BYTES), "application/json", attempt,
    )
    if prepared.get("assets_ready"):
        return request_json(
            f"{base}/api/bundles/publication/{submission_id}/finish",
            key, "POST", b"{}", "application/json", attempt,
        )
    for item, path in package["objects"]:
        request_json(
            f"{base}/api/bundles/publication/{submission_id}/objects/{item['sha256']}.png",
            key, "PUT", read_bounded(path, MAX_OBJECT_BYTES), "image/png", attempt,
        )
    geometry, geometry_path = package["preview_geometry"]
    request_json(
        f"{base}/api/bundles/publication/{submission_id}/preview-geometry/{geometry['sha256']}.json",
        key, "PUT", read_bounded(geometry_path, MAX_GEOMETRY_BYTES), "application/json", attempt,
    )
    for item, path in package["previews"]:
        request_json(
            f"{base}/api/bundles/publication/{submission_id}/previews/{item['sha256']}.png",
            key, "PUT", read_bounded(path, MAX_PREVIEW_BYTES), "image/png", attempt,
        )
    return request_json(
        f"{base}/api/bundles/publication/{submission_id}/finish",
        key, "POST", b"{}", "application/json", attempt,
    )


def confirm(base: str, submission_id: str, key: str) -> dict:
    return request_json(
        f"{base}/api/bundles/publication/{submission_id}/confirm",
        key, "POST", b"{}", "application/json",
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("upload", "confirm"))
    parser.add_argument("submission_id")
    parser.add_argument("--base", default="https://avianvisitors.com")
    parser.add_argument("--package", type=Path)
    parser.add_argument("--attempt")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.base != "https://avianvisitors.com" and not args.base.startswith("http://127.0.0.1:"):
        parser.error("base must be the production service or local loopback HTTP")
    if not SUBMISSION_ID.fullmatch(args.submission_id):
        parser.error("invalid submission identifier")
    key = os.environ.get("BUNDLE_PUBLISH_KEY", "")
    if not key:
        parser.error("BUNDLE_PUBLISH_KEY is required")
    if args.action == "upload":
        if not args.package or not args.attempt:
            parser.error("upload requires --package and --attempt")
        result = upload(
            args.base.rstrip("/"), args.submission_id, args.package, key, args.attempt
        )
    else:
        result = confirm(args.base.rstrip("/"), args.submission_id, key)
    output = json.dumps(result, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.write_text(output, encoding="utf-8")
    print(output, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
