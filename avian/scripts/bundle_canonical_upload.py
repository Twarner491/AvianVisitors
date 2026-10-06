#!/usr/bin/env python3
"""Persist the exact moderated canonical bundle package in private storage."""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

import bundle_http
import bundle_inventory_commitment
import bundle_canonical


CANONICALIZATION = "rgba-png-zero-transparent-v1"
SUBMISSION_ID = re.compile(r"^[a-z0-9_-]{20,40}$")
ATTEMPT = re.compile(r"^[A-Za-z0-9_-]{32}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
MAX_INDEX_BYTES = 1024 * 1024
# Derived UTF-8 review index only; moderation reports keep the smaller bound.
MAX_REVIEW_INDEX_BYTES = 3 * 1024 * 1024
MAX_MANIFEST_BYTES = 4 * 1024 * 1024
MAX_OBJECT_BYTES = 4 * 1024 * 1024
MAX_OBJECTS = 1500
MAX_TOTAL_BYTES = 640 * 1024 * 1024
MAX_WORKERS = 4


def read_json(path: Path, maximum: int) -> dict:
    if not path.is_file() or path.is_symlink() or not 1 <= path.stat().st_size <= maximum:
        raise RuntimeError("canonical package JSON is missing or too large")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("canonical package JSON is invalid") from exc
    if not isinstance(value, dict):
        raise RuntimeError("canonical package JSON is invalid")
    return value


def checked_file(path: Path, root: Path, relative: str, sha: str, size: int) -> bytes:
    target = path.resolve()
    if (
        target.parent != (root / Path(relative).parent).resolve()
        or target != (root / relative).resolve()
        or not target.is_file()
        or target.is_symlink()
        or target.stat().st_size != size
    ):
        raise RuntimeError("canonical package file is missing or unsafe")
    data = target.read_bytes()
    if len(data) != size or hashlib.sha256(data).hexdigest() != sha:
        raise RuntimeError("canonical package file does not match its descriptor")
    return data


def load_package(root: Path, moderation_path: Path) -> dict:
    root = root.resolve()
    moderation = read_json(moderation_path.resolve(), MAX_INDEX_BYTES)
    # A rejected/invalid submission may intentionally have no canonical
    # package. Preserve its specific validation/moderation report instead of
    # turning the upload no-op into a generic workflow failure.
    if (
        moderation.get("ok") is not True
        or moderation.get("metadata_checked") is not True
        or moderation.get("flagged_count") != 0
    ):
        return {"skipped": True, "reason": "canonical package did not pass complete moderation"}
    index = read_json(root / "index.json", MAX_REVIEW_INDEX_BYTES)
    if index.get("schema_version") != 1 or index.get("canonicalization") != CANONICALIZATION:
        raise RuntimeError("canonical package format is unsupported")
    items = index.get("items")
    if not isinstance(items, list) or not 1 <= len(items) <= MAX_OBJECTS:
        raise RuntimeError("canonical package object inventory is invalid")
    publish_sha = index.get("publish_manifest_sha256")
    inventory_sha = index.get("object_inventory_sha256")
    if (
        not isinstance(publish_sha, str) or not SHA256.fullmatch(publish_sha)
        or not isinstance(inventory_sha, str) or not SHA256.fullmatch(inventory_sha)
    ):
        raise RuntimeError("canonical package commitment is invalid")
    manifest_path = root / "publish-manifest.json"
    if not manifest_path.is_file() or manifest_path.is_symlink():
        raise RuntimeError("canonical publish manifest is missing")
    manifest_raw = manifest_path.read_bytes()
    if (
        not 1 <= len(manifest_raw) <= MAX_MANIFEST_BYTES
        or hashlib.sha256(manifest_raw).hexdigest() != publish_sha
    ):
        raise RuntimeError("canonical publish manifest does not match its commitment")
    try:
        manifest = json.loads(manifest_raw.decode("utf-8"))
        manifest_inventory = bundle_inventory_commitment.manifest_inventory(manifest)
    except (UnicodeDecodeError, json.JSONDecodeError, bundle_inventory_commitment.InventoryCommitmentError) as exc:
        raise RuntimeError("canonical publish manifest is invalid") from exc
    if len(manifest_inventory) != len(items):
        raise RuntimeError("canonical package inventory does not match its manifest")

    objects = []
    total = 0
    for ordinal, (item, claim) in enumerate(zip(items, manifest_inventory)):
        relative = f"source-images/{ordinal:04d}.png"
        if (
            not isinstance(item, dict)
            or item.get("source_image") != relative
            or item.get("file") != claim["file"]
            or item.get("source_sha256") != claim["sha256"]
            or item.get("source_bytes") != claim["bytes"]
        ):
            raise RuntimeError("canonical package inventory order is invalid")
        sha = claim["sha256"]
        size = claim["bytes"]
        width = item.get("width")
        height = item.get("height")
        if (
            not isinstance(size, int) or isinstance(size, bool) or not 1 <= size <= MAX_OBJECT_BYTES
            or not isinstance(width, int) or isinstance(width, bool) or not 1 <= width <= 4096
            or not isinstance(height, int) or isinstance(height, bool) or not 1 <= height <= 4096
        ):
            raise RuntimeError("canonical package object descriptor is invalid")
        data = checked_file(root / relative, root, relative, sha, size)
        try:
            actual_dimensions = bundle_canonical.validate_canonical_structure(data)
        except bundle_canonical.CanonicalizationError as exc:
            raise RuntimeError("canonical package object is not a strict RGBA8 PNG") from exc
        if actual_dimensions != (width, height):
            raise RuntimeError("canonical package object dimensions do not match")
        total += size
        if total > MAX_TOTAL_BYTES:
            raise RuntimeError("canonical package exceeds its aggregate byte limit")
        objects.append({
            "ordinal": ordinal, "file": claim["file"], "sha256": sha,
            "bytes": size, "width": width, "height": height,
            "path": root / relative,
        })
    actual_inventory_sha = bundle_inventory_commitment.inventory_sha256(objects)
    if actual_inventory_sha != inventory_sha:
        raise RuntimeError("canonical package inventory commitment does not match")
    if (
        moderation.get("checked") != len(objects) + 1
        or moderation.get("flagged_count") != 0
        or moderation.get("object_inventory_sha256") != actual_inventory_sha
    ):
        return {"skipped": True, "reason": "canonical package did not pass complete moderation"}
    return {
        "skipped": False,
        "manifest": manifest_raw,
        "publish_manifest_sha256": publish_sha,
        "object_inventory_sha256": actual_inventory_sha,
        "objects": objects,
        "bytes": total,
    }


def put(
    url: str, data: bytes, content_type: str, sha: str, key: str, attempt: str,
    source_file: str | None = None,
) -> None:
    headers = {
        "X-Bundle-Validation-Key": key,
        "X-Bundle-Validation-Attempt": attempt,
        "X-Content-SHA256": sha,
        "Content-Type": content_type,
        "Content-Length": str(len(data)),
        "User-Agent": "AvianVisitors-canonical-uploader/1",
    }
    if source_file is not None:
        headers["X-Bundle-Source-File"] = source_file
    request = urllib.request.Request(url, data=data, method="PUT", headers=headers)
    last_error: Exception | None = None
    for retry in range(4):
        try:
            with bundle_http.urlopen(request, timeout=90) as response:
                if getattr(response, "status", 200) not in {200, 201, 204}:
                    raise RuntimeError("canonical upload returned an unexpected status")
            return
        except urllib.error.HTTPError as exc:
            last_error = exc
            if exc.code not in {408, 409, 429, 500, 502, 503, 504}:
                break
        except (OSError, RuntimeError) as exc:
            last_error = exc
        if retry < 3:
            time.sleep(2 ** retry)
    raise RuntimeError("canonical package upload failed") from last_error


def upload_package(
    root: Path, moderation_path: Path, submission: str, key: str, attempt: str,
    base_url: str = "https://avianvisitors.com", workers: int = MAX_WORKERS,
) -> dict:
    if not SUBMISSION_ID.fullmatch(submission) or not ATTEMPT.fullmatch(attempt):
        raise RuntimeError("canonical upload identifiers are invalid")
    if not key:
        raise RuntimeError("BUNDLE_VALIDATION_KEY is not configured")
    if not base_url.startswith("https://") and not base_url.startswith("http://127.0.0.1:"):
        raise RuntimeError("canonical upload endpoint is invalid")
    package = load_package(root, moderation_path)
    if package.get("skipped"):
        return {"ok": True, **package, "uploaded": 0}
    endpoint = base_url.rstrip("/") + f"/api/bundles/validation/{submission}"
    put(
        endpoint + "/canonical-manifest", package["manifest"], "application/json",
        package["publish_manifest_sha256"], key, attempt,
    )

    def upload_one(item: dict) -> None:
        data = item["path"].read_bytes()
        if (
            len(data) != item["bytes"]
            or hashlib.sha256(data).hexdigest() != item["sha256"]
        ):
            raise RuntimeError("canonical package object changed before upload")
        put(
            endpoint + f"/canonical-objects/{item['ordinal']}",
            data, "image/png", item["sha256"], key, attempt,
            item["file"],
        )

    pool = concurrent.futures.ThreadPoolExecutor(max_workers=max(1, min(workers, 8)))
    futures = [pool.submit(upload_one, item) for item in package["objects"]]
    try:
        for future in futures:
            future.result()
    except Exception:
        for future in futures:
            future.cancel()
        pool.shutdown(wait=True, cancel_futures=True)
        raise
    else:
        pool.shutdown(wait=True)
    return {
        "ok": True,
        "skipped": False,
        "uploaded": len(package["objects"]) + 1,
        "objects": len(package["objects"]),
        "bytes": package["bytes"],
        "publish_manifest_sha256": package["publish_manifest_sha256"],
        "object_inventory_sha256": package["object_inventory_sha256"],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--review-package", required=True, type=Path)
    parser.add_argument("--moderation", required=True, type=Path)
    parser.add_argument("--submission", required=True)
    parser.add_argument("--attempt", required=True)
    parser.add_argument("--base-url", default="https://avianvisitors.com")
    parser.add_argument("--workers", type=int, default=MAX_WORKERS)
    args = parser.parse_args()
    try:
        result = upload_package(
            args.review_package, args.moderation, args.submission,
            os.environ.get("BUNDLE_VALIDATION_KEY", ""), args.attempt,
            args.base_url, args.workers,
        )
        print(json.dumps(result, separators=(",", ":")))
        return 0
    except RuntimeError as exc:
        print(json.dumps({"ok": False, "error": str(exc)[:240]}, separators=(",", ":")))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
