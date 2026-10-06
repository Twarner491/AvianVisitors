#!/usr/bin/env python3
"""Screen every manifest-listed bundle image with OpenAI moderation."""
from __future__ import annotations

import argparse
import base64
import concurrent.futures
import hashlib
import json
import os
import re
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

import bundle_http
import bundle_inventory_commitment
import bundle_validate


MODEL = "omni-moderation-latest"
ENDPOINT = "https://api.openai.com/v1/moderations"
MAX_WORKERS = 4
MAX_API_RESPONSE_BYTES = 256 * 1024
REQUIRED_CATEGORIES = frozenset({
    "harassment", "harassment/threatening", "hate", "hate/threatening",
    "illicit", "illicit/violent", "self-harm", "self-harm/intent",
    "self-harm/instructions", "sexual", "sexual/minors", "violence",
    "violence/graphic",
})


def parallel_checks(check, inventory: list[dict], workers: int) -> list[dict | None]:
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=max(1, min(workers, 8)))
    futures = [pool.submit(check, item) for item in inventory]
    try:
        results = [future.result() for future in futures]
    except Exception:
        for future in futures:
            future.cancel()
        pool.shutdown(wait=True, cancel_futures=True)
        raise
    else:
        pool.shutdown(wait=True)
        return results


def _request_moderation_input(item: dict, api_key: str) -> dict:
    body = json.dumps({
        "model": MODEL,
        "input": [item],
    }, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(ENDPOINT, data=body, method="POST", headers={
        "Authorization": "Bearer " + api_key,
        "Content-Type": "application/json",
        "Content-Length": str(len(body)),
        "User-Agent": "AvianVisitors-bundle-moderator/1",
    })
    last_error: Exception | None = None
    for attempt in range(4):
        try:
            with bundle_http.urlopen(request, timeout=45) as response:
                raw = response.read(MAX_API_RESPONSE_BYTES + 1)
            if len(raw) > MAX_API_RESPONSE_BYTES:
                raise RuntimeError("moderation response is too large")
            result = json.loads(raw)
            rows = result.get("results") if isinstance(result, dict) else None
            if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict):
                raise RuntimeError("moderation response is malformed")
            row = rows[0]
            categories = row.get("categories")
            if (
                not isinstance(row.get("flagged"), bool)
                or not isinstance(categories, dict)
                or not categories
                or not REQUIRED_CATEGORIES.issubset(categories)
                or any(not isinstance(value, bool) for value in categories.values())
            ):
                raise RuntimeError("moderation response is incomplete")
            flagged = sorted(key for key, value in categories.items() if value is True)
            # Fail closed on an internally inconsistent response rather than
            # treating true category bits as clean because the aggregate bit
            # was false.
            return {"flagged": row["flagged"] or bool(flagged), "categories": flagged}
        except urllib.error.HTTPError as exc:
            last_error = exc
            if exc.code not in {408, 409, 429, 500, 502, 503, 504}:
                break
        except (OSError, ValueError, RuntimeError) as exc:
            last_error = exc
        if attempt < 3:
            time.sleep(2 ** attempt)
    raise RuntimeError("moderation request failed") from last_error


def request_moderation(image: bytes, api_key: str, mime_type: str = "image/png") -> dict:
    return _request_moderation_input({
        "type": "image_url",
        "image_url": {"url": f"data:{mime_type};base64," + base64.b64encode(image).decode("ascii")},
    }, api_key)


def request_text_moderation(text: str, api_key: str) -> dict:
    return _request_moderation_input({"type": "text", "text": text}, api_key)


def public_manifest_text(archive_path: Path) -> str:
    with zipfile.ZipFile(archive_path) as archive:
        manifest = json.loads(archive.read("manifest.json").decode("utf-8"))
    selected = {
        "name": manifest.get("name"),
        "description": manifest.get("description"),
        "style": manifest.get("style"),
        "coverage": manifest.get("coverage"),
        "license": manifest.get("license"),
        "attribution": manifest.get("attribution"),
        "provenance": manifest.get("provenance"),
        "species": [
            {
                "scientific_name": bird.get("scientific_name"),
                "common_name": bird.get("common_name"),
            }
            for bird in manifest.get("species", [])
        ],
    }
    return json.dumps(selected, ensure_ascii=True, separators=(",", ":"))


def moderate_archive(archive_path: Path, api_key: str, workers: int = MAX_WORKERS) -> dict:
    if not api_key:
        return {"ok": False, "model": MODEL, "error": "OPENAI_API_KEY is not configured"}
    validation = bundle_validate.validate_archive(archive_path)
    inventory = validation["object_inventory"]

    def check(item: dict) -> dict:
        with zipfile.ZipFile(archive_path) as archive:
            image = archive.read(item["file"])
        result = request_moderation(image, api_key)
        return {
            "file": item["file"],
            "sha256": hashlib.sha256(image).hexdigest(),
            "bytes": len(image),
            "flagged": result["flagged"],
            "categories": result["categories"][:12],
        }

    flagged = []
    try:
        metadata_result = request_text_moderation(public_manifest_text(archive_path), api_key)
        if metadata_result["flagged"]:
            flagged.append({"file": "manifest.json", "categories": metadata_result["categories"][:12]})
        checked_items = parallel_checks(check, inventory, workers)
        for result in checked_items:
            if result["flagged"]:
                flagged.append({"file": result["file"], "categories": result["categories"]})
    except (RuntimeError, bundle_inventory_commitment.InventoryCommitmentError) as exc:
        return {"ok": False, "model": MODEL, "error": str(exc)}
    return {
        "ok": True,
        "model": MODEL,
        "images": len(inventory),
        "checked": len(inventory) + 1,
        "metadata_checked": True,
        "object_inventory_sha256": bundle_inventory_commitment.inventory_sha256(checked_items),
        "flagged": flagged[:100],
        "flagged_count": len(flagged),
    }


def load_review_package(review_dir: Path) -> tuple[dict, list[dict]]:
    index_path = review_dir / "index.json"
    if not index_path.is_file() or index_path.is_symlink() or index_path.stat().st_size > bundle_validate.MAX_REVIEW_INDEX_BYTES:
        raise RuntimeError("canonical review package is missing or invalid")
    try:
        index = json.loads(index_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("canonical review package is invalid") from exc
    items = index.get("items") if isinstance(index, dict) else None
    metadata = index.get("metadata") if isinstance(index, dict) else None
    if index.get("schema_version") != 1 or not isinstance(metadata, dict) or not isinstance(items, list):
        raise RuntimeError("canonical review package is invalid")
    if not 1 <= len(items) <= bundle_validate.MAX_HOSTED_OBJECTS:
        raise RuntimeError("canonical review package has an invalid item count")
    checked = []
    root = review_dir.resolve()
    for ordinal, item in enumerate(items):
        expected = f"source-images/{ordinal:04d}.png"
        if not isinstance(item, dict) or item.get("source_image") != expected:
            raise RuntimeError("canonical review package inventory is invalid")
        size = item.get("source_bytes")
        sha = item.get("source_sha256")
        if not isinstance(size, int) or not 1 <= size <= 4 * 1024 * 1024:
            raise RuntimeError("review source image byte length is invalid")
        if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{64}", sha):
            raise RuntimeError("canonical review image checksum is invalid")
        path = (review_dir / expected).resolve()
        if path.parent != root / "source-images" or not path.is_file() or path.is_symlink():
            raise RuntimeError("review source image path is invalid")
        data = path.read_bytes()
        if len(data) != size or hashlib.sha256(data).hexdigest() != sha:
            raise RuntimeError("review source image does not match its descriptor")
        checked.append({**item, "path": path})
    return metadata, checked


def moderate_review_package(review_dir: Path, api_key: str, workers: int = MAX_WORKERS) -> dict:
    if not api_key:
        return {"ok": False, "model": MODEL, "error": "OPENAI_API_KEY is not configured"}
    try:
        metadata, inventory = load_review_package(review_dir)
        flagged = []
        metadata_result = request_text_moderation(
            json.dumps(metadata, ensure_ascii=True, separators=(",", ":")), api_key,
        )
        if metadata_result["flagged"]:
            flagged.append({"file": "manifest.json", "categories": metadata_result["categories"][:12]})

        def check(item: dict) -> dict:
            # Send the exact validated PNG bytes that publication will serve.
            # This path performs no local image decoding.
            data = item["path"].read_bytes()
            actual_sha = hashlib.sha256(data).hexdigest()
            if len(data) != item["source_bytes"] or actual_sha != item["source_sha256"]:
                raise RuntimeError("canonical review image changed during moderation")
            result = request_moderation(data, api_key, "image/png")
            return {
                "file": item["file"],
                "sha256": actual_sha,
                "bytes": len(data),
                "flagged": result["flagged"],
                "categories": result["categories"][:12],
            }

        checked_items = parallel_checks(check, inventory, workers)
        for result in checked_items:
            if result["flagged"]:
                flagged.append({"file": result["file"], "categories": result["categories"]})
        return {
            "ok": True,
            "model": MODEL,
            "images": len(inventory),
            "checked": len(inventory) + 1,
            "metadata_checked": True,
            "object_inventory_sha256": bundle_inventory_commitment.inventory_sha256(checked_items),
            "flagged": flagged[:100],
            "flagged_count": len(flagged),
        }
    except (RuntimeError, bundle_inventory_commitment.InventoryCommitmentError) as exc:
        return {"ok": False, "model": MODEL, "error": str(exc)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", nargs="?", type=Path)
    parser.add_argument("--review-package", type=Path)
    parser.add_argument("--workers", type=int, default=MAX_WORKERS)
    args = parser.parse_args()
    try:
        if bool(args.archive) == bool(args.review_package):
            raise RuntimeError("choose exactly one archive or canonical review package")
        if args.review_package:
            result = moderate_review_package(args.review_package, os.environ.get("OPENAI_API_KEY", ""), args.workers)
        else:
            result = moderate_archive(args.archive, os.environ.get("OPENAI_API_KEY", ""), args.workers)
    except Exception:
        result = {"ok": False, "model": MODEL, "error": "artwork moderation failed unexpectedly"}
    print(json.dumps(result, separators=(",", ":")))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
