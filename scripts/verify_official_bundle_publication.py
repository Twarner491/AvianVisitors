#!/usr/bin/env python3
"""Verify and inventory the exact official bundle publication, locally or live.

This program is deliberately read-only. It maps reviewed local sources to the
content-addressed R2 keys consumed by the public Worker, but never uploads,
deletes, or mutates either local files or remote state.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import re
import sys
import urllib.error
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath
from typing import BinaryIO


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "avian" / "scripts"))
import bundle_manager as manager


LOCK_FORMAT = "avian-visitors-official-publication-lock"
LOCK_VERSION = 1
ORIGIN = "https://avianvisitors.com"
ROUTES = {
    "manifest": "/api/bundles/manifests/{sha256}.json",
    "object": "/api/bundles/objects/{sha256}.png",
    "manifest_r2_key": "bundles/manifests/sha256/{prefix}/{sha256}.json",
    "object_r2_key": "bundles/objects/sha256/{prefix}/{sha256}.png",
}
INVENTORY_DOMAIN = b"avian-bundle-object-inventory-v1\0"
PLAN_DOMAIN = b"avian-official-bundle-publication-plan-v1\0"
SHA256 = re.compile(r"^[0-9a-f]{64}$")
MAX_MANIFEST = 4 * 1024 * 1024
MAX_OBJECT = 4 * 1024 * 1024


class VerificationError(RuntimeError):
    pass


def sha256_stream(source: BinaryIO) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    while chunk := source.read(128 * 1024):
        digest.update(chunk)
        size += len(chunk)
    return digest.hexdigest(), size


def checked_file(path: Path, maximum: int | None = None) -> bytes:
    if not path.is_file() or path.is_symlink():
        raise VerificationError(f"missing or linked file: {path}")
    size = path.stat().st_size
    if size < 1 or (maximum is not None and size > maximum):
        raise VerificationError(f"file size is outside its bound: {path}")
    raw = path.read_bytes()
    if len(raw) != size:
        raise VerificationError(f"file changed while it was read: {path}")
    return raw


def checked_relative(value: object, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise VerificationError(f"{label} is invalid")
    path = PurePosixPath(value)
    if path.is_absolute() or str(path) != value or any(part in {"", ".", ".."} for part in path.parts):
        raise VerificationError(f"{label} is not a canonical relative path")
    return value


def checked_hash(value: object, label: str) -> str:
    if not isinstance(value, str) or SHA256.fullmatch(value) is None:
        raise VerificationError(f"{label} is invalid")
    return value


def checked_count(value: object, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise VerificationError(f"{label} is invalid")
    return value


def load_lock(path: Path) -> dict:
    try:
        value = json.loads(checked_file(path, 256 * 1024))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise VerificationError("publication lock is not valid JSON") from exc
    required = {"format", "format_version", "origin", "routes", "payloads", "publication"}
    if not isinstance(value, dict) or set(value) != required:
        raise VerificationError("publication lock has an invalid shape")
    if value["format"] != LOCK_FORMAT or value["format_version"] != LOCK_VERSION:
        raise VerificationError("publication lock format is unsupported")
    if value["origin"] != ORIGIN or value["routes"] != ROUTES:
        raise VerificationError("publication lock does not name the canonical Worker contract")
    payloads = value["payloads"]
    if not isinstance(payloads, list) or not payloads:
        raise VerificationError("publication lock has no payloads")
    seen_payloads: set[tuple[str, str, str]] = set()
    seen_manifests: set[str] = set()
    for payload in payloads:
        required_payload = {
            "authority", "id", "version", "manifest_sha256", "manifest_bytes",
            "object_count", "object_bytes", "object_inventory_sha256", "source",
        }
        if not isinstance(payload, dict) or set(payload) != required_payload:
            raise VerificationError("publication lock payload has an invalid shape")
        authority = payload["authority"]
        if authority not in {"station-install", "public-discovery"}:
            raise VerificationError("publication lock authority is invalid")
        try:
            pack_id = manager.checked_id(payload["id"])
            version = manager.checked_version(payload["version"])
        except manager.BundleError as exc:
            raise VerificationError(str(exc)) from exc
        identity = (authority, pack_id, version)
        if identity in seen_payloads:
            raise VerificationError("publication lock repeats an authority identity")
        seen_payloads.add(identity)
        manifest_sha = checked_hash(payload["manifest_sha256"], "manifest checksum")
        if manifest_sha in seen_manifests:
            raise VerificationError("publication lock repeats a manifest")
        seen_manifests.add(manifest_sha)
        checked_hash(payload["object_inventory_sha256"], "object inventory checksum")
        for field in ("manifest_bytes", "object_count", "object_bytes"):
            checked_count(payload[field], field)
        source = payload["source"]
        if not isinstance(source, dict) or source.get("kind") not in {"object-tree", "zip"}:
            raise VerificationError("publication source is invalid")
        if source["kind"] == "object-tree":
            if set(source) != {"kind", "manifest"}:
                raise VerificationError("object-tree source has an invalid shape")
        else:
            if set(source) != {
                "kind", "manifest", "archive", "archive_sha256", "archive_bytes"
            }:
                raise VerificationError("zip source has an invalid shape")
            checked_relative(source["archive"], "archive path")
            checked_hash(source["archive_sha256"], "archive checksum")
            checked_count(source["archive_bytes"], "archive bytes")
        checked_relative(source["manifest"], "manifest path")
    publication = value["publication"]
    required_publication = {
        "manifest_count", "manifest_bytes", "object_count", "object_bytes",
        "file_count", "total_bytes", "plan_sha256",
    }
    if not isinstance(publication, dict) or set(publication) != required_publication:
        raise VerificationError("publication summary has an invalid shape")
    for field in required_publication - {"plan_sha256"}:
        checked_count(publication[field], field)
    checked_hash(publication["plan_sha256"], "publication plan checksum")
    return value


def object_inventory(manifest: dict) -> list[dict]:
    result = []
    for bird in manifest["species"]:
        for pose in bird["poses"]:
            result.append({
                "file": pose["file"],
                "sha256": pose["sha256"],
                "bytes": pose["bytes"],
            })
    return result


def inventory_sha256(items: list[dict]) -> str:
    digest = hashlib.sha256(INVENTORY_DOMAIN)
    for item in items:
        digest.update(item["file"].encode("utf-8"))
        digest.update(b"\0")
        digest.update(item["sha256"].encode("ascii"))
        digest.update(b"\0")
        digest.update(str(item["bytes"]).encode("ascii"))
        digest.update(b"\0")
    return digest.hexdigest()


def validate_manifest(raw: bytes, payload: dict) -> tuple[dict, list[dict]]:
    if len(raw) != payload["manifest_bytes"] or hashlib.sha256(raw).hexdigest() != payload["manifest_sha256"]:
        raise VerificationError(f"manifest bytes do not match the lock: {payload['authority']}:{payload['id']}")
    try:
        parsed = json.loads(raw)
        manifest = manager.validate_manifest(parsed)
    except (UnicodeDecodeError, json.JSONDecodeError, manager.BundleError) as exc:
        raise VerificationError(f"locked manifest is invalid: {payload['authority']}:{payload['id']}") from exc
    if manifest["id"] != payload["id"] or manifest["version"] != payload["version"]:
        raise VerificationError(f"manifest identity does not match the lock: {payload['authority']}:{payload['id']}")
    items = object_inventory(manifest)
    if len(items) != payload["object_count"]:
        raise VerificationError(f"manifest object count does not match the lock: {payload['authority']}:{payload['id']}")
    if sum(item["bytes"] for item in items) != payload["object_bytes"]:
        raise VerificationError(f"manifest object bytes do not match the lock: {payload['authority']}:{payload['id']}")
    if inventory_sha256(items) != payload["object_inventory_sha256"]:
        raise VerificationError(f"manifest inventory does not match the lock: {payload['authority']}:{payload['id']}")
    return manifest, items


def manifest_url(digest: str) -> str:
    return ORIGIN + ROUTES["manifest"].format(sha256=digest)


def object_url(digest: str) -> str:
    return ORIGIN + ROUTES["object"].format(sha256=digest)


def manifest_key(digest: str) -> str:
    return ROUTES["manifest_r2_key"].format(prefix=digest[:2], sha256=digest)


def object_key(digest: str) -> str:
    return ROUTES["object_r2_key"].format(prefix=digest[:2], sha256=digest)


def add_plan_record(plan: dict[str, dict], record: dict) -> None:
    existing = plan.get(record["r2_key"])
    if existing is not None:
        if (existing["sha256"], existing["bytes"]) != (record["sha256"], record["bytes"]):
            raise VerificationError("publication contains a conflicting content-addressed key")
        return
    plan[record["r2_key"]] = record


def plan_summary(plan: dict[str, dict]) -> dict:
    records = sorted(plan.values(), key=lambda item: item["r2_key"])
    digest = hashlib.sha256(PLAN_DOMAIN)
    for item in records:
        digest.update(item["r2_key"].encode("utf-8"))
        digest.update(b"\0")
        digest.update(item["sha256"].encode("ascii"))
        digest.update(b"\0")
        digest.update(str(item["bytes"]).encode("ascii"))
        digest.update(b"\0")
    manifests = [item for item in records if item["kind"] == "manifest"]
    objects = [item for item in records if item["kind"] == "object"]
    return {
        "manifest_count": len(manifests),
        "manifest_bytes": sum(item["bytes"] for item in manifests),
        "object_count": len(objects),
        "object_bytes": sum(item["bytes"] for item in objects),
        "file_count": len(records),
        "total_bytes": sum(item["bytes"] for item in records),
        "plan_sha256": digest.hexdigest(),
    }


def validate_summary(plan: dict[str, dict], lock: dict) -> dict:
    summary = plan_summary(plan)
    if summary != lock["publication"]:
        raise VerificationError("derived publication plan does not match the locked summary")
    return summary


def load_catalog(path: Path) -> dict:
    try:
        return json.loads(checked_file(path, manager.CATALOG_MAX))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise VerificationError(f"catalog is not valid JSON: {path}") from exc


def validate_catalogs(lock: dict, station_catalog_path: Path, discovery_catalog_path: Path) -> None:
    try:
        station = manager.validate_catalog(load_catalog(station_catalog_path))
    except manager.BundleError as exc:
        raise VerificationError(f"station catalog is invalid: {exc}") from exc
    discovery = load_catalog(discovery_catalog_path)
    if not isinstance(discovery, dict) or not isinstance(discovery.get("packs"), list):
        raise VerificationError("public discovery catalog has an invalid shape")
    station_packs = {(item["id"], item.get("version")): item for item in station["packs"]}
    discovery_packs = {
        (item.get("id"), item.get("version")): item
        for item in discovery["packs"] if isinstance(item, dict)
    }
    for payload in lock["payloads"]:
        index = station_packs if payload["authority"] == "station-install" else discovery_packs
        pack = index.get((payload["id"], payload["version"]))
        if pack is None:
            raise VerificationError(f"catalog is missing locked payload: {payload['authority']}:{payload['id']}")
        manifest = pack.get("manifest")
        if not isinstance(manifest, dict):
            raise VerificationError(f"catalog manifest is missing: {payload['authority']}:{payload['id']}")
        if manifest.get("sha256") != payload["manifest_sha256"] or manifest.get("url") != manifest_url(payload["manifest_sha256"]):
            raise VerificationError(f"catalog manifest identity is not locked: {payload['authority']}:{payload['id']}")
        if payload["authority"] == "station-install":
            if manifest.get("bytes") != payload["manifest_bytes"] or pack.get("archive_bytes") != payload["object_bytes"]:
                raise VerificationError(f"station catalog byte counts are not locked: {payload['id']}")


def verify_plain_file(path: Path, digest: str, size: int) -> None:
    if not path.is_file() or path.is_symlink() or path.stat().st_size != size:
        raise VerificationError(f"publication object is missing or has the wrong size: {path}")
    with path.open("rb") as source:
        actual_digest, actual_size = sha256_stream(source)
    if actual_size != size or actual_digest != digest:
        raise VerificationError(f"publication object checksum does not match: {path}")


def verify_local(lock: dict, station_root: Path, discovery_root: Path,
                 station_catalog: Path, discovery_catalog: Path) -> tuple[dict, list[dict]]:
    if not station_root.is_dir() or station_root.is_symlink():
        raise VerificationError("station publication root is missing or linked")
    if not discovery_root.is_dir() or discovery_root.is_symlink():
        raise VerificationError("discovery publication root is missing or linked")
    validate_catalogs(lock, station_catalog, discovery_catalog)
    plan: dict[str, dict] = {}
    expected_tree_files: set[Path] = set()
    for payload in lock["payloads"]:
        source = payload["source"]
        root = station_root if source["kind"] == "object-tree" else discovery_root
        manifest_path = root / source["manifest"]
        raw = checked_file(manifest_path, MAX_MANIFEST)
        manifest, items = validate_manifest(raw, payload)
        digest = payload["manifest_sha256"]
        add_plan_record(plan, {
            "kind": "manifest", "r2_key": manifest_key(digest),
            "url": manifest_url(digest), "sha256": digest, "bytes": len(raw),
            "source": {"path": str(manifest_path)},
        })
        if source["kind"] == "object-tree":
            expected_tree_files.add(manifest_path)
            for item in items:
                digest = item["sha256"]
                path = root / "objects" / "sha256" / digest[:2] / f"{digest}.png"
                verify_plain_file(path, digest, item["bytes"])
                expected_tree_files.add(path)
                add_plan_record(plan, {
                    "kind": "object", "r2_key": object_key(digest),
                    "url": object_url(digest), "sha256": digest, "bytes": item["bytes"],
                    "source": {"path": str(path)},
                })
            continue

        archive_path = root / source["archive"]
        if not archive_path.is_file() or archive_path.is_symlink():
            raise VerificationError(f"publication archive is missing or linked: {archive_path}")
        if archive_path.stat().st_size != source["archive_bytes"]:
            raise VerificationError(f"publication archive size does not match: {archive_path}")
        with archive_path.open("rb") as archive_source:
            archive_digest, archive_size = sha256_stream(archive_source)
        if archive_size != source["archive_bytes"] or archive_digest != source["archive_sha256"]:
            raise VerificationError(f"publication archive checksum does not match: {archive_path}")
        try:
            with zipfile.ZipFile(archive_path) as archive:
                infos = archive.infolist()
                names = [info.filename for info in infos]
                expected = {"manifest.json", *(item["file"] for item in items)}
                if len(names) != len(set(names)) or set(names) != expected:
                    raise VerificationError(f"publication archive inventory is not exact: {archive_path}")
                if archive.read("manifest.json") != raw:
                    raise VerificationError(f"archive manifest differs from its locked file: {archive_path}")
                for item in items:
                    digest = item["sha256"]
                    info = archive.getinfo(item["file"])
                    if info.file_size != item["bytes"] or info.flag_bits & 1:
                        raise VerificationError(f"archive object metadata does not match: {item['file']}")
                    with archive.open(info) as object_source:
                        actual_digest, actual_size = sha256_stream(object_source)
                    if actual_size != item["bytes"] or actual_digest != digest:
                        raise VerificationError(f"archive object checksum does not match: {item['file']}")
                    add_plan_record(plan, {
                        "kind": "object", "r2_key": object_key(digest),
                        "url": object_url(digest), "sha256": digest, "bytes": item["bytes"],
                        "source": {"archive": str(archive_path), "member": item["file"]},
                    })
        except zipfile.BadZipFile as exc:
            raise VerificationError(f"publication archive is invalid: {archive_path}") from exc

    actual_tree_files = {path for path in station_root.rglob("*") if path.is_file() or path.is_symlink()}
    if actual_tree_files != expected_tree_files:
        missing = len(expected_tree_files - actual_tree_files)
        unexpected = len(actual_tree_files - expected_tree_files)
        raise VerificationError(
            f"station object tree is not exact (missing={missing}, unexpected={unexpected})"
        )
    summary = validate_summary(plan, lock)
    return summary, sorted(plan.values(), key=lambda item: item["r2_key"])


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        return None


def public_request(url: str, method: str, maximum: int) -> tuple[dict[str, str], bytes]:
    request = urllib.request.Request(
        url, method=method,
        headers={"Accept-Encoding": "identity", "User-Agent": "AvianVisitors-publication-smoke/1"},
    )
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=30) as response:
            status = response.status
            headers = {name.lower(): value for name, value in response.headers.items()}
            raw = b"" if method == "HEAD" else response.read(maximum + 1)
    except urllib.error.HTTPError as exc:
        exc.read(4096)
        raise VerificationError(f"{method} {url} returned HTTP {exc.code}") from exc
    except OSError as exc:
        raise VerificationError(f"{method} {url} could not be reached") from exc
    if status != 200:
        raise VerificationError(f"{method} {url} returned HTTP {status}")
    if len(raw) > maximum:
        raise VerificationError(f"{method} {url} exceeded its byte bound")
    return headers, raw


def validate_headers(headers: dict[str, str], media_type: str, expected_size: int, label: str) -> None:
    if headers.get("content-type", "").split(";", 1)[0].strip().lower() != media_type:
        raise VerificationError(f"{label} has the wrong content type")
    cache = {part.strip().lower() for part in headers.get("cache-control", "").split(",")}
    if "public" not in cache or "immutable" not in cache or "max-age=31536000" not in cache:
        raise VerificationError(f"{label} is missing immutable cache controls")
    if headers.get("x-content-type-options", "").lower() != "nosniff":
        raise VerificationError(f"{label} is missing nosniff")
    declared = headers.get("content-length")
    if declared is not None and declared != str(expected_size):
        raise VerificationError(f"{label} has the wrong content length")


def verify_live_object(item: dict, head_only: bool) -> None:
    method = "HEAD" if head_only else "GET"
    headers, raw = public_request(item["url"], method, item["bytes"])
    validate_headers(headers, "image/png", item["bytes"], item["url"])
    if not head_only and (len(raw) != item["bytes"] or hashlib.sha256(raw).hexdigest() != item["sha256"]):
        raise VerificationError(f"live object bytes do not match: {item['url']}")


def verify_live(lock: dict, head_only: bool, workers: int) -> tuple[dict, list[dict]]:
    plan: dict[str, dict] = {}
    for payload in lock["payloads"]:
        digest = payload["manifest_sha256"]
        url = manifest_url(digest)
        headers, raw = public_request(url, "GET", payload["manifest_bytes"])
        validate_headers(headers, "application/json", payload["manifest_bytes"], url)
        _manifest, items = validate_manifest(raw, payload)
        add_plan_record(plan, {
            "kind": "manifest", "r2_key": manifest_key(digest), "url": url,
            "sha256": digest, "bytes": len(raw), "source": {"live": url},
        })
        for item in items:
            digest = item["sha256"]
            add_plan_record(plan, {
                "kind": "object", "r2_key": object_key(digest), "url": object_url(digest),
                "sha256": digest, "bytes": item["bytes"], "source": {"live": object_url(digest)},
            })
    summary = validate_summary(plan, lock)
    objects = sorted(
        (item for item in plan.values() if item["kind"] == "object"),
        key=lambda item: item["r2_key"],
    )
    errors = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(verify_live_object, item, head_only): item for item in objects}
        for future in concurrent.futures.as_completed(futures):
            try:
                future.result()
            except VerificationError as exc:
                errors.append(str(exc))
    if errors:
        errors.sort()
        detail = "; ".join(errors[:10])
        if len(errors) > 10:
            detail += f"; plus {len(errors) - 10} more failures"
        raise VerificationError(f"live publication is incomplete: {detail}")
    return summary, sorted(plan.values(), key=lambda item: item["r2_key"])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--lock", type=Path,
        default=ROOT / "avian" / "bundles" / "publication-lock-v1.json",
    )
    parser.add_argument("--live", action="store_true", help="verify the canonical public Worker")
    parser.add_argument(
        "--head-only", action="store_true",
        help="with --live, prove availability and headers without hashing object bodies",
    )
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--station-publication-root", type=Path)
    parser.add_argument("--discovery-publication-root", type=Path)
    parser.add_argument(
        "--station-catalog", type=Path,
        default=ROOT / "avian" / "bundles" / "catalog-v1.json",
    )
    parser.add_argument("--discovery-catalog", type=Path)
    parser.add_argument(
        "--emit-plan", action="store_true",
        help="include every exact local source, public URL, and destination R2 key",
    )
    args = parser.parse_args()
    try:
        if not 1 <= args.workers <= 32:
            raise VerificationError("workers must be between 1 and 32")
        if args.head_only and not args.live:
            raise VerificationError("--head-only requires --live")
        lock = load_lock(args.lock)
        if args.live:
            summary, plan = verify_live(lock, args.head_only, args.workers)
            mode = "live-head" if args.head_only else "live-content"
        else:
            if args.station_publication_root is None or args.discovery_publication_root is None:
                raise VerificationError("local verification requires both publication roots")
            if args.discovery_catalog is None:
                raise VerificationError("local verification requires the public discovery catalog")
            summary, plan = verify_local(
                lock, args.station_publication_root, args.discovery_publication_root,
                args.station_catalog, args.discovery_catalog,
            )
            mode = "local"
        result = {"ok": True, "mode": mode, **summary}
        if args.emit_plan:
            result["files"] = plan
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
        return 0
    except (VerificationError, OSError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, sort_keys=True, separators=(",", ":")))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
