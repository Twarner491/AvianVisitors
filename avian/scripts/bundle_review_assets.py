#!/usr/bin/env python3
"""Upload canonical review-only JPEGs to private bundle quarantine storage."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

import bundle_http

SUBMISSION_ID = re.compile(r"^[a-z0-9_-]{20,40}$")
ATTEMPT = re.compile(r"^[A-Za-z0-9_-]{32}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
MAX_BYTES = 256 * 1024


def validate_descriptor(value: object, data: bytes) -> None:
    if not isinstance(value, dict):
        raise RuntimeError("review asset descriptor is missing")
    expected_sha = value.get("sha256")
    expected_bytes = value.get("bytes")
    if not isinstance(expected_sha, str) or not SHA256.fullmatch(expected_sha):
        raise RuntimeError("review asset checksum is invalid")
    if not isinstance(expected_bytes, int) or not 1 <= expected_bytes <= MAX_BYTES:
        raise RuntimeError("review asset byte length is invalid")
    if len(data) != expected_bytes or hashlib.sha256(data).hexdigest() != expected_sha:
        raise RuntimeError("review asset does not match its descriptor")


def upload(
    url: str, data: bytes, sha256: str, api_key: str, attempt: str,
    content_type: str = "image/jpeg",
) -> None:
    request = urllib.request.Request(url, data=data, method="PUT", headers={
        "X-Bundle-Validation-Key": api_key,
        "X-Bundle-Validation-Attempt": attempt,
        "X-Content-SHA256": sha256,
        "Content-Type": content_type,
        "Content-Length": str(len(data)),
        "User-Agent": "AvianVisitors-bundle-review-assets/1",
    })
    last_error: Exception | None = None
    for attempt in range(4):
        try:
            with bundle_http.urlopen(request, timeout=45) as response:
                if getattr(response, "status", 200) not in {200, 201, 204}:
                    raise RuntimeError("review asset upload returned an unexpected status")
            return
        except urllib.error.HTTPError as exc:
            last_error = exc
            if exc.code not in {408, 409, 429, 500, 502, 503, 504}:
                break
        except (OSError, RuntimeError) as exc:
            last_error = exc
        if attempt < 3:
            time.sleep(2 ** attempt)
    raise RuntimeError("review asset upload failed") from last_error


def upload_assets(
    review_path: Path, preview_dir: Path, submission_id: str, api_key: str, attempt: str,
    base_url: str = "https://avianvisitors.com",
) -> dict:
    if not SUBMISSION_ID.fullmatch(submission_id):
        raise RuntimeError("submission identifier is invalid")
    if not api_key:
        raise RuntimeError("BUNDLE_VALIDATION_KEY is not configured")
    if not ATTEMPT.fullmatch(attempt):
        raise RuntimeError("validation attempt token is invalid")
    if not base_url.startswith("https://"):
        raise RuntimeError("review asset endpoint must use HTTPS")
    try:
        review = json.loads(review_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("AI review result could not be read") from exc
    if not isinstance(review, dict):
        raise RuntimeError("AI review result is malformed")

    targets = []
    flags = review.get("flags", [])
    if not isinstance(flags, list) or len(flags) > 40:
        raise RuntimeError("AI review flags are malformed")
    for ordinal, item in enumerate(flags):
        if not isinstance(item, dict) or "preview" not in item:
            continue
        targets.append((
            "flag", ordinal, item["preview"], preview_dir / f"flag-{ordinal}.jpg", "image/jpeg",
        ))
    if "contact_sheet" in review:
        targets.append((
            "contact", 0, review["contact_sheet"], preview_dir / "contact-0.jpg", "image/jpeg",
        ))
    uploaded = 0
    root = preview_dir.resolve()
    for role, ordinal, descriptor, path, content_type in targets:
        resolved = path.resolve()
        if resolved.parent != root or not resolved.is_file() or resolved.is_symlink():
            raise RuntimeError("review asset file is missing or unsafe")
        data = resolved.read_bytes()
        validate_descriptor(descriptor, data)
        endpoint = (
            base_url.rstrip("/") + f"/api/bundles/validation/{submission_id}/review-assets/{role}/{ordinal}"
        )
        upload(endpoint, data, descriptor["sha256"], api_key, attempt, content_type)
        uploaded += 1
    return {"ok": True, "uploaded": uploaded, "skipped": not bool(targets)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--review", required=True, type=Path)
    parser.add_argument("--preview-dir", required=True, type=Path)
    parser.add_argument("--submission", required=True)
    parser.add_argument("--attempt", required=True)
    parser.add_argument("--base-url", default="https://avianvisitors.com")
    args = parser.parse_args()
    try:
        result = upload_assets(
            args.review,
            args.preview_dir,
            args.submission,
            os.environ.get("BUNDLE_VALIDATION_KEY", ""),
            args.attempt,
            args.base_url,
        )
        print(json.dumps(result, separators=(",", ":")))
        return 0
    except RuntimeError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, separators=(",", ":")))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
