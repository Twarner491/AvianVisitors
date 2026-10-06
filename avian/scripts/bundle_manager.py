#!/usr/bin/python3
"""Install and select untrusted Avian Visitors illustration bundles.

The manager is the only station process that downloads bundle data.  It accepts
catalog IDs, never caller URLs, validates every byte into a content-addressed
store, and replaces the station-wide active record only after a complete pack
has been prepared.  The PHP API invokes ``snapshot`` and ``enqueue`` with a
fixed argv; the detached ``run-job`` worker owns the long operation.

Production state lives in ``/var/lib/avian-visitors/bundles``.  Tests and the
local review harness may set AVIAN_BUNDLE_ROOT, AVIAN_BUNDLE_CATALOG,
AVIAN_BUNDLE_DEV_ROOT, AVIAN_BUNDLE_LOCK, and AVIAN_BUNDLE_DB in the process
environment.  None of those paths are accepted from an HTTP request.
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import ctypes
import datetime as dt
import fcntl
import hashlib
import json
import http.client
import ipaddress
import os
import pwd
import re
import resource
import select
import signal
import shutil
import socket
import sqlite3
import ssl
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import warnings
from pathlib import Path
from typing import Any, Iterable


FORMAT_CATALOG = "avian-visitors-bundle-catalog"
FORMAT_MANIFEST = "avian-visitors-asset-pack"
FORMAT_ACTIVE = "avian-visitors-active-bundle"
FORMAT_JOB = "avian-visitors-bundle-job"
FORMAT_VERSION = 1

BUILTIN_ID = "official-western-us-woodblock"
BUILTIN_VERSION = "1.0.0"
BUILTIN_REVISION = "included-woodblock-v1"

ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,79}$")
VERSION_RE = re.compile(
    r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
    r"(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)
HASH_RE = re.compile(r"^[0-9a-f]{64}$")
REVISION_RE = re.compile(r"^(?:included-woodblock-v1|[0-9a-f]{64})$")
SCI_RE = re.compile(r"^[A-Z][A-Za-z-]{1,39}(?: [a-z][A-Za-z-]{1,39}){1,3}$")
SCI_NAME_MAX = 163
SCI_SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)+$")
POSE_SLUG_MAX = SCI_NAME_MAX + 2
REGION_RE = re.compile(r"^[A-Z]{2}(?:-[A-Z0-9]{1,8}){0,3}$")

CATALOG_MAX = 2 * 1024 * 1024
CATALOG_HISTORY_MAX = 4 * 1024 * 1024
CATALOG_HISTORY_ENTRIES_MAX = 10_000
MANIFEST_MAX = 4 * 1024 * 1024
IMAGE_MAX = 4 * 1024 * 1024
TOTAL_MAX = 1024 * 1024 * 1024
OBJECT_STORE_MAX = 2 * 1024 * 1024 * 1024
FREE_SPACE_RESERVE = 256 * 1024 * 1024
IMAGE_DIM_MAX = 4096
IMAGE_PIXELS_MAX = 16_000_000
SPECIES_MAX = 5000
OBJECTS_MAX = SPECIES_MAX * 2
PREVIEWS_MAX = 6
REDIRECT_MAX = 3
STATE_MAX = 8 * 1024 * 1024
TABLE_MAX = 24 * 1024 * 1024
JOB_STALE_SECONDS = 4 * 60 * 60
USE_POLL_SECONDS = 0.25
USE_WAIT_SECONDS = JOB_STALE_SECONDS + 60

PUBLIC_BUNDLE_ORIGIN = "https://avianvisitors.com"
OBJECT_BASE_URL = f"{PUBLIC_BUNDLE_ORIGIN}/api/bundles/objects/"
MANIFEST_BASE_URL = f"{PUBLIC_BUNDLE_ORIGIN}/api/bundles/manifests/"
MANIFEST_HOSTS = frozenset({"avianvisitors.com"})
OBJECT_HOSTS = MANIFEST_HOSTS
LIVE_CATALOG_HOSTS = frozenset({"avianvisitors.com"})
LICENSES = frozenset({"CC0-1.0", "CC-BY-4.0", "CC-BY-SA-4.0", "CC-BY-NC-SA-4.0"})
DEFAULT_COMMUNITY_DESCRIPTION = "Community-maintained bird artwork."
POSES = frozenset({"perched", "flight"})
REVIEWS = frozenset({"official", "community"})
ACTIONS = frozenset({"use", "install", "update", "activate", "remove", "rollback", "refresh"})
CATALOG_URL = "https://avianvisitors.com/bundles"
LIVE_CATALOG_URL = "https://avianvisitors.com/api/bundles/catalog/community-v1.json"
CACHE_CATALOG_NAME = "community-catalog-v1.json"
CATALOG_HISTORY_NAME = "community-catalog-bindings-v1.json"
IMAGE_SANDBOX_USER = "avian-bundle"
IMAGE_SANDBOX_ROOT = "/var/empty/avian-bundle"
STATION_RUNTIME_PATH = Path("/usr/share/avian-visitors/bundles/station.json")
SPECIES_HELPER_PATH = Path("/usr/share/avian-visitors/bundles/bundle_species.py")
SELECTION_MAX = 1024 * 1024


class BundleError(RuntimeError):
    """A safe, user-facing bundle failure."""

    def __init__(self, message: str, code: str = "bundle_error") -> None:
        super().__init__(message)
        self.code = code


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def canonical_json(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def plain_record(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        raise BundleError(f"{label} must be an object", "invalid_record")
    return value


def exact_keys(value: dict[str, Any], required: set[str], optional: set[str], label: str) -> None:
    keys = set(value)
    missing = required - keys
    extra = keys - required - optional
    if missing or extra:
        raise BundleError(f"{label} has unsupported or missing fields", "invalid_fields")


def clean_text(value: Any, maximum: int, label: str, *, optional: bool = False) -> str:
    if optional and (value is None or value == ""):
        return ""
    if not isinstance(value, str):
        raise BundleError(f"{label} must be text", "invalid_text")
    text = " ".join(value.split()).strip()
    invalid_characters = (
        any(
            ord(ch) < 32 or ord(ch) == 127 or 0xD800 <= ord(ch) <= 0xDFFF
            for ch in value
        )
        or "<" in value
        or ">" in value
    )
    if optional and not text and len(value) <= maximum and not invalid_characters:
        return ""
    if not text or len(text) > maximum or invalid_characters:
        raise BundleError(f"{label} is invalid", "invalid_text")
    return text


def clean_optional_public_text(value: Any, maximum: int, label: str) -> str:
    """Normalize inert optional display text accepted by hosted bundle v1."""
    if value == "":
        return ""
    if not isinstance(value, str):
        raise BundleError(f"{label} must be text", "invalid_text")
    text = " ".join(value.split()).strip()
    invalid_characters = (
        any(ord(ch) < 32 or 0xD800 <= ord(ch) <= 0xDFFF for ch in value)
        or "<" in value
        or ">" in value
    )
    if not text and len(value) <= maximum and not invalid_characters:
        return ""
    if not text or len(text) > maximum or invalid_characters:
        raise BundleError(f"{label} is invalid", "invalid_text")
    return text


def checked_id(value: Any, label: str = "bundle id") -> str:
    if not isinstance(value, str) or ID_RE.fullmatch(value) is None:
        raise BundleError(f"{label} is invalid", "invalid_id")
    return value


def checked_version(value: Any) -> str:
    if not isinstance(value, str) or len(value) > 64 or VERSION_RE.fullmatch(value) is None:
        raise BundleError("bundle version is invalid", "invalid_version")
    without_build = value.split("+", 1)[0]
    if "-" in without_build:
        prerelease = without_build.split("-", 1)[1]
        if any(part.isdigit() and len(part) > 1 and part.startswith("0") for part in prerelease.split(".")):
            raise BundleError("bundle version is invalid", "invalid_version")
    return value


def semver_precedence(value: Any) -> tuple[Any, ...]:
    """Return SemVer precedence, deliberately ignoring build metadata."""
    version = checked_version(value)
    without_build = version.split("+", 1)[0]
    core, separator, prerelease = without_build.partition("-")
    major, minor, patch = (int(part) for part in core.split("."))
    if not separator:
        prerelease_key: tuple[Any, ...] = (1, ())
    else:
        identifiers = tuple(
            (0, int(part)) if part.isascii() and part.isdigit() else (1, part)
            for part in prerelease.split(".")
        )
        prerelease_key = (0, identifiers)
    return major, minor, patch, prerelease_key


def installed_version_key(value: Any) -> tuple[Any, ...]:
    """Order verified installs by SemVer, then full ASCII version text."""
    version = checked_version(value)
    return semver_precedence(version), version


def installed_activation_presentation(
    item: dict[str, Any], *, coverage_group: str, review: str
) -> dict[str, Any]:
    """Return public-safe facts for the exact verified install being activated."""
    reference = item["reference"]
    return {
        "name": item["name"],
        "coverage": {
            "label": item["coverage"]["label"],
            "group": coverage_group,
        },
        "style": item["style"],
        "species_count": item["species_count"],
        "creator": item["creator"],
        "review": review,
        "version": reference["version"],
        "license": item["license"],
        "archive_bytes": item["archive_bytes"],
    }


def checked_hash(value: Any, label: str = "SHA-256") -> str:
    if not isinstance(value, str) or HASH_RE.fullmatch(value) is None:
        raise BundleError(f"{label} is invalid", "invalid_hash")
    return value


def checked_url(value: Any, label: str, hosts: frozenset[str], *, directory: bool = False) -> str:
    if not isinstance(value, str) or len(value) > 500:
        raise BundleError(f"{label} is invalid", "invalid_url")
    try:
        parsed = urllib.parse.urlsplit(value)
        # Accessing port raises for malformed and out-of-range values.
        port = parsed.port
    except ValueError as error:
        raise BundleError(f"{label} is invalid", "invalid_url") from error
    decoded_path = urllib.parse.unquote(parsed.path)
    host = (parsed.hostname or "").lower()
    if (
        parsed.scheme != "https"
        or host not in hosts
        or parsed.username is not None
        or parsed.password is not None
        or port is not None
        or parsed.fragment
        or not parsed.path.startswith("/")
        or (directory and not parsed.path.endswith("/"))
        or (directory and bool(parsed.query))
        or "\\" in decoded_path
        or "\x00" in decoded_path
        or any(part in {".", ".."} for part in decoded_path.split("/"))
    ):
        raise BundleError(f"{label} uses an unsupported location", "invalid_url")
    return urllib.parse.urlunsplit(parsed)


def checked_source_url(value: Any) -> str:
    """Validate an attribution link without granting it download authority."""
    if (
        not isinstance(value, str)
        or not value
        or len(value) > 500
        or any(character in value for character in "\\<>")
        or any(ord(character) < 0x20 or ord(character) == 0x7F for character in value)
    ):
        raise BundleError("source URL is invalid", "invalid_url")
    try:
        parsed = urllib.parse.urlsplit(value)
        # Accessing port also rejects malformed and out-of-range ports while
        # deliberately allowing valid HTTPS portfolio URLs on custom ports.
        parsed.port
    except ValueError as exc:
        raise BundleError("source URL is invalid", "invalid_url") from exc
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
    ):
        raise BundleError("source URL is invalid", "invalid_url")
    return urllib.parse.urlunsplit(parsed)


def checked_string_list(
    value: Any,
    label: str,
    maximum: int,
    item_maximum: int,
    pattern: re.Pattern[str] | None = None,
) -> list[str]:
    if not isinstance(value, list) or len(value) > maximum:
        raise BundleError(f"{label} is invalid", "invalid_list")
    output: list[str] = []
    seen: set[str] = set()
    for raw in value:
        item = clean_text(raw, item_maximum, label)
        if item in seen or (pattern is not None and pattern.fullmatch(item) is None):
            raise BundleError(f"{label} is invalid", "invalid_list")
        output.append(item)
        seen.add(item)
    return output


def scientific_slug(scientific_name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", scientific_name.lower()).strip("-")


def pose_slug(scientific_name: str, pose: str) -> str:
    return scientific_slug(scientific_name) + ("-2" if pose == "flight" else "")


def pose_path(scientific_name: str, pose: str) -> str:
    return f"illustrations/{pose_slug(scientific_name, pose)}.png"


def validate_manifest(raw: Any) -> dict[str, Any]:
    value = plain_record(raw, "manifest")
    exact_keys(
        value,
        {
            "format", "format_version", "id", "version", "name",
            "style", "coverage", "species", "license", "attribution",
        },
        {"description", "provenance"},
        "manifest",
    )
    if value["format"] != FORMAT_MANIFEST or value["format_version"] != FORMAT_VERSION:
        raise BundleError("unsupported bundle manifest", "unsupported_manifest")

    style = plain_record(value["style"], "style")
    exact_keys(style, {"id", "name"}, set(), "style")
    coverage = plain_record(value["coverage"], "coverage")
    exact_keys(coverage, {"type", "label"}, {"region_codes"}, "coverage")
    if not isinstance(coverage["type"], str) or coverage["type"] not in {"region", "global", "selection"}:
        raise BundleError("coverage type is invalid", "invalid_coverage")
    region_codes = checked_string_list(
        coverage.get("region_codes", []), "region codes", 32, 40, REGION_RE
    )
    if (coverage["type"] == "region" and not region_codes) or (
        coverage["type"] == "global" and region_codes
    ):
        raise BundleError("coverage type and region codes do not agree", "invalid_coverage")

    license_record = plain_record(value["license"], "license")
    exact_keys(license_record, {"spdx"}, {"file"}, "license")
    if not isinstance(license_record["spdx"], str) or license_record["spdx"] not in LICENSES:
        raise BundleError("bundle license is unsupported", "invalid_license")
    license_file = license_record.get("file")
    # Frozen v1 publication already proved that a truthy license.file names an
    # archive member. It is attribution metadata, carries no fetch authority,
    # and is deliberately stripped from the normalized station manifest.
    if "file" in license_record and license_file and not isinstance(license_file, str):
        raise BundleError("bundle license file is invalid", "invalid_license")

    attribution = plain_record(value["attribution"], "attribution")
    exact_keys(attribution, {"creator"}, {"source_url"}, "attribution")
    source_url = ""
    if (
        "source_url" in attribution
        and attribution["source_url"] is not None
        and attribution["source_url"] != ""
    ):
        source_url = checked_source_url(attribution["source_url"])

    description = (
        DEFAULT_COMMUNITY_DESCRIPTION
        if "description" not in value
        else clean_optional_public_text(value["description"], 260, "description")
    )

    provenance: dict[str, str] | None = None
    if "provenance" in value:
        raw_provenance = plain_record(value["provenance"], "provenance")
        exact_keys(raw_provenance, {"method", "review"}, {"model"}, "provenance")
        method = raw_provenance["method"]
        review = raw_provenance["review"]
        if (
            not isinstance(method, str)
            or not isinstance(review, str)
            or method not in {"manual", "generated", "mixed"}
            or review not in {"human-reviewed", "contributor-reviewed"}
        ):
            raise BundleError("provenance is invalid", "invalid_provenance")
        model = clean_text(raw_provenance.get("model"), 100, "model", optional=True)
        if method in {"generated", "mixed"} and not model:
            raise BundleError("generated provenance must identify its model", "invalid_provenance")
        provenance = {
            "method": method,
            "review": review,
            "model": model,
        }

    raw_species = value["species"]
    if not isinstance(raw_species, list) or not 1 <= len(raw_species) <= SPECIES_MAX:
        raise BundleError("species list is invalid", "invalid_species")
    species: list[dict[str, Any]] = []
    species_seen: set[str] = set()
    species_slugs_seen: set[str] = set()
    files_seen: set[str] = set()
    total_bytes = 0
    pose_count = 0
    for raw_bird in raw_species:
        bird = plain_record(raw_bird, "species")
        exact_keys(bird, {"scientific_name", "poses"}, {"common_name"}, "species")
        scientific_name = clean_text(bird["scientific_name"], SCI_NAME_MAX, "scientific name")
        species_slug = scientific_slug(scientific_name)
        if (
            SCI_RE.fullmatch(scientific_name) is None
            or scientific_name in species_seen
            or species_slug in species_slugs_seen
        ):
            raise BundleError("scientific name is invalid or repeated", "invalid_species")
        species_seen.add(scientific_name)
        species_slugs_seen.add(species_slug)
        raw_poses = bird["poses"]
        if not isinstance(raw_poses, list) or not 1 <= len(raw_poses) <= 2:
            raise BundleError("species poses are invalid", "invalid_pose")
        poses: list[dict[str, Any]] = []
        pose_seen: set[str] = set()
        for raw_pose in raw_poses:
            item = plain_record(raw_pose, "pose")
            exact_keys(item, {"id", "file", "sha256", "bytes"}, set(), "pose")
            pose = item["id"]
            if not isinstance(pose, str) or pose not in POSES or pose in pose_seen:
                raise BundleError("pose is invalid or repeated", "invalid_pose")
            pose_seen.add(pose)
            expected_file = pose_path(scientific_name, pose)
            if item["file"] != expected_file or expected_file in files_seen:
                raise BundleError("pose path is not canonical", "invalid_pose_path")
            files_seen.add(expected_file)
            size = item["bytes"]
            if isinstance(size, bool) or not isinstance(size, int) or not 67 <= size <= IMAGE_MAX:
                raise BundleError("illustration size is invalid", "invalid_size")
            total_bytes += size
            if total_bytes > TOTAL_MAX:
                raise BundleError("bundle is too large", "bundle_too_large")
            poses.append(
                {
                    "id": pose,
                    "file": expected_file,
                    "sha256": checked_hash(item["sha256"], "illustration SHA-256"),
                    "bytes": size,
                }
            )
            pose_count += 1
        species.append(
            {
                "scientific_name": scientific_name,
                "common_name": clean_optional_public_text(
                    bird.get("common_name", ""), 100, "common name"
                ),
                "poses": poses,
            }
        )

    return {
        "format": FORMAT_MANIFEST,
        "format_version": FORMAT_VERSION,
        "id": checked_id(value["id"]),
        "version": checked_version(value["version"]),
        "name": clean_text(value["name"], 90, "bundle name"),
        "description": description,
        "style": {"id": checked_id(style["id"], "style id"), "name": clean_text(style["name"], 90, "style")},
        "coverage": {
            "type": coverage["type"],
            "label": clean_text(coverage["label"], 90, "coverage label"),
            "region_codes": region_codes,
        },
        "species": species,
        "species_count": len(species),
        "pose_count": pose_count,
        "total_bytes": total_bytes,
        "license": {"spdx": license_record["spdx"]},
        "attribution": {
            "creator": clean_text(attribution["creator"], 100, "creator"),
            "source_url": source_url,
        },
        "provenance": provenance,
    }


def validate_preview(raw: Any) -> dict[str, Any]:
    item = plain_record(raw, "preview")
    exact_keys(item, {"scientific_name", "common_name", "pose", "sha256", "bytes"}, set(), "preview")
    scientific_name = clean_text(
        item["scientific_name"], SCI_NAME_MAX, "preview scientific name"
    )
    size = item["bytes"]
    if (
        SCI_RE.fullmatch(scientific_name) is None
        or not isinstance(item["pose"], str)
        or item["pose"] not in POSES
        or isinstance(size, bool)
        or not isinstance(size, int)
        or not 67 <= size <= IMAGE_MAX
    ):
        raise BundleError("preview is invalid", "invalid_preview")
    return {
        "scientific_name": scientific_name,
        "common_name": clean_optional_public_text(
            item["common_name"], 100, "preview common name"
        ),
        "pose": item["pose"],
        "sha256": checked_hash(item["sha256"], "preview SHA-256"),
        "bytes": size,
    }


def checked_catalog_date(value: Any, *, timestamp: bool = False) -> str:
    updated = clean_text(value, 32, "catalog date")
    try:
        if re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", updated):
            dt.date.fromisoformat(updated)
        elif timestamp and re.fullmatch(
            r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z",
            updated,
        ):
            dt.datetime.strptime(updated, "%Y-%m-%dT%H:%M:%S.%fZ")
        else:
            raise ValueError
    except ValueError as error:
        raise BundleError("catalog date is invalid", "invalid_date") from error
    return updated


def catalog_revision(value: str) -> dt.datetime:
    if "T" in value:
        return dt.datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(
            tzinfo=dt.timezone.utc
        )
    return dt.datetime.combine(dt.date.fromisoformat(value), dt.time(), dt.timezone.utc)


def validate_catalog(raw: Any, *, timestamp: bool = False) -> dict[str, Any]:
    value = plain_record(raw, "catalog")
    exact_keys(value, {"format", "format_version", "updated", "object_base_url", "packs"}, set(), "catalog")
    if value["format"] != FORMAT_CATALOG or value["format_version"] != FORMAT_VERSION:
        raise BundleError("unsupported bundle catalog", "unsupported_catalog")
    object_base_url = checked_url(value["object_base_url"], "object base URL", OBJECT_HOSTS, directory=True)
    if object_base_url != OBJECT_BASE_URL:
        raise BundleError("object base URL is not the canonical bundle route", "invalid_url")
    raw_packs = value["packs"]
    if not isinstance(raw_packs, list) or not 1 <= len(raw_packs) <= 1000:
        raise BundleError("catalog pack list is invalid", "invalid_catalog")
    seen: set[str] = set()
    packs: list[dict[str, Any]] = []
    for raw_pack in raw_packs:
        pack = plain_record(raw_pack, "catalog pack")
        exact_keys(
            pack,
            {
                "id", "version", "name", "description", "creator", "repository_url", "coverage",
                "style", "species_count", "species", "review", "availability", "manifest",
                "archive_bytes", "previews", "license",
            },
            {"local_id", "search_terms"},
            "catalog pack",
        )
        pack_id = checked_id(pack["id"])
        if pack_id in seen:
            raise BundleError("catalog repeats a bundle id", "duplicate_id")
        seen.add(pack_id)
        version = checked_version(pack["version"])
        availability = pack["availability"]
        if not isinstance(availability, str) or availability not in {"included", "installable", "unavailable"}:
            raise BundleError("bundle availability is invalid", "invalid_availability")
        if availability == "included" and pack_id != BUILTIN_ID:
            raise BundleError("only the built-in bundle may be included", "invalid_availability")
        review = pack["review"]
        if not isinstance(review, str) or review not in REVIEWS:
            raise BundleError("review label is invalid", "invalid_review")
        if not isinstance(pack["license"], str) or pack["license"] not in LICENSES:
            raise BundleError("bundle license is unsupported", "invalid_license")
        count = pack["species_count"]
        if isinstance(count, bool) or not isinstance(count, int) or not 1 <= count <= SPECIES_MAX:
            raise BundleError("species count is invalid", "invalid_species")
        names = checked_string_list(
            pack["species"], "catalog species", SPECIES_MAX, SCI_NAME_MAX, SCI_RE
        )
        if len(names) != count:
            raise BundleError("catalog species count does not match", "invalid_species")
        archive_bytes = pack["archive_bytes"]
        if isinstance(archive_bytes, bool) or not isinstance(archive_bytes, int) or not 1 <= archive_bytes <= TOTAL_MAX:
            raise BundleError("archive size is invalid", "invalid_size")
        manifest_record = plain_record(pack["manifest"], "catalog manifest")
        exact_keys(manifest_record, {"url", "sha256", "bytes"}, set(), "catalog manifest")
        manifest_size = manifest_record["bytes"]
        if isinstance(manifest_size, bool) or not isinstance(manifest_size, int) or not 2 <= manifest_size <= MANIFEST_MAX:
            raise BundleError("manifest size is invalid", "invalid_size")
        manifest_hash = checked_hash(manifest_record["sha256"], "manifest SHA-256")
        manifest_url = checked_url(manifest_record["url"], "manifest URL", MANIFEST_HOSTS)
        if manifest_url != f"{MANIFEST_BASE_URL}{manifest_hash}.json":
            raise BundleError("manifest URL is not its canonical checksum route", "invalid_url")
        raw_previews = pack["previews"]
        if not isinstance(raw_previews, list) or not 1 <= len(raw_previews) <= PREVIEWS_MAX:
            raise BundleError("catalog previews are invalid", "invalid_preview")
        coverage = plain_record(pack["coverage"], "catalog coverage")
        exact_keys(coverage, {"label", "group", "region_codes"}, set(), "catalog coverage")
        coverage_group = clean_text(coverage["group"], 30, "coverage group")
        coverage_codes = checked_string_list(
            coverage["region_codes"], "region codes", 32, 40, REGION_RE
        )
        if coverage_group == "global" and coverage_codes:
            raise BundleError(
                "catalog coverage group and region codes do not agree", "invalid_coverage"
            )
        style = plain_record(pack["style"], "catalog style")
        exact_keys(style, {"id", "name", "category", "tags"}, set(), "catalog style")
        previews = [validate_preview(item) for item in raw_previews]
        local_id = "" if "local_id" not in pack else checked_id(pack["local_id"], "local bundle id")
        search_terms = checked_string_list(
            pack.get("search_terms", []),
            "search terms",
            32,
            60,
        )
        packs.append(
            {
                "id": pack_id,
                "version": version,
                "name": clean_text(pack["name"], 90, "bundle name"),
                "description": clean_optional_public_text(
                    pack["description"], 260, "description"
                ),
                "creator": clean_text(pack["creator"], 100, "creator"),
                "repository_url": checked_url(pack["repository_url"], "repository URL", frozenset({"github.com"})),
                "coverage": {
                    "label": clean_text(coverage["label"], 90, "coverage label"),
                    "group": coverage_group,
                    "region_codes": coverage_codes,
                },
                "style": {
                    "id": checked_id(style["id"], "style id"),
                    "name": clean_text(style["name"], 90, "style name"),
                    "category": clean_text(style["category"], 30, "style category"),
                    "tags": checked_string_list(style["tags"], "style tags", 16, 30),
                },
                "species_count": count,
                "species": names,
                "review": review,
                "license": pack["license"],
                "availability": availability,
                "local_id": local_id,
                "search_terms": search_terms,
                "manifest": {
                    "url": manifest_url,
                    "sha256": manifest_hash,
                    "bytes": manifest_size,
                },
                "archive_bytes": archive_bytes,
                "previews": previews,
            }
        )
    updated = checked_catalog_date(value["updated"], timestamp=timestamp)
    return {
        "format": FORMAT_CATALOG,
        "format_version": FORMAT_VERSION,
        "updated": updated,
        "object_base_url": object_base_url,
        "packs": packs,
    }


def verify_catalog_manifest(pack: dict[str, Any], manifest: dict[str, Any], manifest_hash: str) -> None:
    if pack["id"] != manifest["id"] or pack["version"] != manifest["version"]:
        raise BundleError("catalog and manifest identity do not match", "identity_mismatch")
    if pack["manifest"]["sha256"] != manifest_hash:
        raise BundleError("manifest hash does not match the catalog", "manifest_hash")
    if pack["species_count"] != manifest["species_count"]:
        raise BundleError("manifest species count does not match the catalog", "species_mismatch")
    if pack["archive_bytes"] != manifest["total_bytes"]:
        raise BundleError("manifest size does not match the catalog", "size_mismatch")
    if pack["license"] != manifest["license"]["spdx"]:
        raise BundleError("manifest license does not match the catalog", "license_mismatch")
    if (
        pack["name"] != manifest["name"]
        or pack["description"] != manifest["description"]
        or pack["creator"] != manifest["attribution"]["creator"]
        or pack["style"]["id"] != manifest["style"]["id"]
        or pack["style"]["name"] != manifest["style"]["name"]
    ):
        raise BundleError("manifest metadata does not match the catalog", "metadata_mismatch")
    if (
        pack["coverage"]["label"] != manifest["coverage"]["label"]
        or pack["coverage"]["region_codes"] != manifest["coverage"]["region_codes"]
        or (manifest["coverage"]["type"] == "global") != (pack["coverage"]["group"] == "global")
    ):
        raise BundleError("manifest coverage does not match the catalog", "coverage_mismatch")
    manifest_species = [bird["scientific_name"] for bird in manifest["species"]]
    if pack["species"] != manifest_species:
        raise BundleError("manifest species do not match the catalog", "species_mismatch")
    objects = {
        (bird["scientific_name"], pose["id"]): (bird["common_name"], pose["sha256"], pose["bytes"])
        for bird in manifest["species"]
        for pose in bird["poses"]
    }
    for preview in pack["previews"]:
        match = objects.get((preview["scientific_name"], preview["pose"]))
        if match is None or match[1:] != (preview["sha256"], preview["bytes"]):
            raise BundleError("catalog preview does not match its manifest object", "preview_mismatch")
        if preview["common_name"] != match[0]:
            raise BundleError("catalog preview name does not match", "preview_mismatch")


def configured_path(environment: str, fallback: str) -> Path:
    raw = os.environ.get(environment, fallback)
    if not raw or "\x00" in raw:
        raise BundleError(f"{environment} is invalid", "invalid_configuration")
    path = Path(raw)
    if not path.is_absolute():
        raise BundleError(f"{environment} must be absolute", "invalid_configuration")
    return path


def bundle_root() -> Path:
    return configured_path("AVIAN_BUNDLE_ROOT", "/var/lib/avian-visitors/bundles")


def catalog_path() -> Path:
    override = os.environ.get("AVIAN_BUNDLE_CATALOG")
    if override:
        return configured_path("AVIAN_BUNDLE_CATALOG", override)
    source = Path(__file__).resolve().parents[1] / "bundles" / "catalog-v1.json"
    if source.is_file():
        return source
    return Path("/usr/share/avian-visitors/bundles/catalog-v1.json")


def catalog_cache_path() -> Path:
    """Return the root-owned cache used only for verified community listings."""
    return bundle_root() / CACHE_CATALOG_NAME


def catalog_history_path() -> Path:
    """Return the durable id/version binding floor for community releases."""
    return bundle_root() / CATALOG_HISTORY_NAME


def lock_path() -> Path:
    override = os.environ.get("AVIAN_BUNDLE_LOCK")
    if override:
        return configured_path("AVIAN_BUNDLE_LOCK", override)
    return bundle_root() / "operation.lock"


def database_path() -> Path | None:
    override = os.environ.get("AVIAN_BUNDLE_DB")
    if override:
        return configured_path("AVIAN_BUNDLE_DB", override)
    source = station_root() / "scripts" / "birds.db"
    return source if source.is_file() else None


def config_path() -> Path | None:
    override = os.environ.get("AVIAN_BUNDLE_CONFIG")
    if override:
        return configured_path("AVIAN_BUNDLE_CONFIG", override)
    source = station_root() / "birdnet.conf"
    if source.is_file():
        return source
    system = Path("/etc/birdnet/birdnet.conf")
    return system if system.is_file() else None


def station_runtime() -> dict[str, Any] | None:
    if not STATION_RUNTIME_PATH.exists() and not STATION_RUNTIME_PATH.is_symlink():
        return None
    value = read_json(STATION_RUNTIME_PATH, 4096)
    exact_keys(value, {"schema_version", "user", "root"}, set(), "station runtime")
    if value["schema_version"] != 1 or not isinstance(value["user"], str):
        raise BundleError("station runtime is invalid", "invalid_configuration")
    root = value["root"]
    if not isinstance(root, str) or not root.startswith("/") or ".." in Path(root).parts:
        raise BundleError("station runtime path is invalid", "invalid_configuration")
    try:
        account = pwd.getpwnam(value["user"])
    except KeyError as error:
        raise BundleError("station account is unavailable", "invalid_configuration") from error
    if account.pw_uid == 0 or account.pw_gid == 0:
        raise BundleError("station account is unsafe", "invalid_configuration")
    return {**value, "account": account}


def station_root() -> Path:
    runtime = station_runtime()
    return Path(runtime["root"]) if runtime is not None else Path(__file__).resolve().parents[2]


def configure_station(user: str, root: str) -> dict[str, Any]:
    if os.geteuid() != 0:
        raise BundleError("station setup requires root", "root_required")
    try:
        account = pwd.getpwnam(user)
        resolved = Path(root).resolve(strict=True)
    except (KeyError, OSError, RuntimeError) as error:
        raise BundleError("station setup is invalid", "invalid_configuration") from error
    if account.pw_uid == 0 or account.pw_gid == 0 or not resolved.is_dir():
        raise BundleError("station setup is unsafe", "invalid_configuration")
    safe_directory(STATION_RUNTIME_PATH.parent)
    atomic_json(STATION_RUNTIME_PATH, {"schema_version": 1, "user": user, "root": str(resolved)})
    return {"ok": True}


def dev_root() -> Path | None:
    raw = os.environ.get("AVIAN_BUNDLE_DEV_ROOT")
    return configured_path("AVIAN_BUNDLE_DEV_ROOT", raw) if raw else None


def safe_directory(path: Path, *, create: bool = False, mode: int = 0o755) -> None:
    if create:
        old_umask = os.umask(0o022)
        try:
            path.mkdir(mode=mode, parents=True, exist_ok=True)
        finally:
            os.umask(old_umask)
    try:
        info = path.lstat()
    except FileNotFoundError as error:
        raise BundleError("bundle storage is unavailable", "storage_unavailable") from error
    if (
        not stat.S_ISDIR(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_mode & 0o022
        or info.st_uid != os.geteuid()
        or info.st_gid != os.getegid()
    ):
        raise BundleError("bundle storage is unsafe", "unsafe_storage")
    if create and info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) != mode:
        os.chmod(path, mode)


def ensure_storage() -> Path:
    root = bundle_root()
    if not os.environ.get("AVIAN_BUNDLE_ROOT"):
        safe_directory(root.parent)
    old_umask = os.umask(0o022)
    try:
        safe_directory(root, create=True)
        for relative in ("objects", "objects/sha256", "packs", "staging"):
            safe_directory(root / relative, create=True)
    finally:
        os.umask(old_umask)
    return root


@contextlib.contextmanager
def locked(*, exclusive: bool = True) -> Iterable[None]:
    path = lock_path()
    old_umask = os.umask(0o022)
    try:
        path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    finally:
        os.umask(old_umask)
    safe_directory(path.parent)
    flags = os.O_RDWR | os.O_CREAT
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags, 0o600)
    try:
        before = path.lstat()
        info = os.fstat(descriptor)
        if (
            not stat.S_ISREG(info.st_mode)
            or stat.S_ISLNK(before.st_mode)
            or info.st_nlink != 1
            or info.st_mode & 0o077
            or info.st_uid != os.geteuid()
            or info.st_gid != os.getegid()
            or info.st_dev != before.st_dev
            or info.st_ino != before.st_ino
        ):
            raise BundleError("bundle operation lock is unsafe", "unsafe_lock")
        fcntl.flock(descriptor, fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)
        yield
    finally:
        os.close(descriptor)


def read_regular(
    path: Path,
    maximum: int,
    *,
    allow_writable: bool = False,
    require_owner: bool = True,
) -> bytes:
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except (FileNotFoundError, OSError) as error:
        raise BundleError(f"{path.name} is unavailable", "missing_file") from error
    try:
        before = path.lstat()
        opened = os.fstat(descriptor)
        if (
            not stat.S_ISREG(opened.st_mode)
            or stat.S_ISLNK(before.st_mode)
            or opened.st_nlink != 1
            or (require_owner and opened.st_uid != os.geteuid())
            or (require_owner and opened.st_gid != os.getegid())
            or (not allow_writable and opened.st_mode & 0o022)
            or opened.st_dev != before.st_dev
            or opened.st_ino != before.st_ino
            or opened.st_size < 1
            or opened.st_size > maximum
        ):
            raise BundleError(f"{path.name} is unsafe", "unsafe_file")
        chunks: list[bytes] = []
        remaining = opened.st_size
        while remaining:
            chunk = os.read(descriptor, min(remaining, 1024 * 1024))
            if not chunk:
                raise BundleError(f"{path.name} changed while reading", "changed_file")
            chunks.append(chunk)
            remaining -= len(chunk)
        if os.fstat(descriptor).st_size != opened.st_size:
            raise BundleError(f"{path.name} changed while reading", "changed_file")
        return b"".join(chunks)
    finally:
        os.close(descriptor)


def read_json(path: Path, maximum: int, *, allow_writable: bool = False) -> dict[str, Any]:
    raw = read_regular(path, maximum, allow_writable=allow_writable)
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BundleError(f"{path.name} is invalid", "invalid_json") from error
    return plain_record(value, path.name)


def fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def exchange_directories(first: Path, second: Path) -> None:
    """Atomically swap two same-filesystem directories.

    Bundle versions are immutable and readers resolve a version directory
    directly. Repair therefore replaces the whole directory in one namespace
    operation instead of exposing a partial pack to PHP or to power loss.
    """
    safe_directory(first)
    safe_directory(second)
    first_raw = os.fsencode(first)
    second_raw = os.fsencode(second)
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform.startswith("linux") and hasattr(libc, "renameat2"):
        renameat2 = libc.renameat2
        renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        renameat2.restype = ctypes.c_int
        result = renameat2(-100, first_raw, -100, second_raw, 2)  # AT_FDCWD, RENAME_EXCHANGE
    elif sys.platform == "darwin" and hasattr(libc, "renamex_np"):
        renamex_np = libc.renamex_np
        renamex_np.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        renamex_np.restype = ctypes.c_int
        result = renamex_np(first_raw, second_raw, 2)  # RENAME_SWAP
    else:
        raise BundleError("atomic bundle repair is unavailable", "unsupported_platform")
    if result != 0:
        error_number = ctypes.get_errno()
        raise BundleError("atomic bundle repair failed", "repair_failed") from OSError(
            error_number, os.strerror(error_number)
        )


def sync_exchanged_directories(first: Path, second: Path) -> None:
    """Durably publish a completed directory exchange.

    Keep this separate from the namespace swap so the caller can record that
    the swap happened before a parent-directory fsync can fail. A durability
    failure must take the same rollback path as failed post-swap validation.
    """
    try:
        fsync_directory(first.parent)
        if second.parent != first.parent:
            fsync_directory(second.parent)
    except OSError as error:
        raise BundleError(
            "atomic bundle repair could not be made durable", "repair_failed"
        ) from error


def atomic_bytes(path: Path, raw: bytes, mode: int = 0o644) -> None:
    safe_directory(path.parent)
    temporary = path.parent / f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(temporary, flags, mode)
    try:
        offset = 0
        while offset < len(raw):
            written = os.write(descriptor, raw[offset:])
            if written < 1:
                raise BundleError("could not write bundle data", "write_failed")
            offset += written
        os.fsync(descriptor)
        os.fchmod(descriptor, mode)
    except Exception:
        os.close(descriptor)
        temporary.unlink(missing_ok=True)
        raise
    else:
        os.close(descriptor)
    os.replace(temporary, path)
    fsync_directory(path.parent)


def atomic_json(path: Path, value: Any, mode: int = 0o644) -> None:
    atomic_bytes(path, canonical_json(value), mode)


def parse_json_bytes(raw: bytes, label: str) -> dict[str, Any]:
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BundleError(f"{label} is not valid JSON", "invalid_json") from error
    return plain_record(value, label)


def load_bundled_catalog() -> dict[str, Any]:
    """Load the release catalog, whose entries are always authoritative."""
    # A checkout may be developer-writable. Production copies this same file
    # into /usr/share as root-owned data during provisioning.
    path = catalog_path()
    safe_directory(path.parent)
    raw = read_regular(path, CATALOG_MAX, allow_writable=bool(os.environ.get("AVIAN_BUNDLE_CATALOG")))
    return validate_catalog(parse_json_bytes(raw, "catalog"))


def validate_community_catalog(
    community: dict[str, Any], bundled: dict[str, Any]
) -> dict[str, Any]:
    """Prove that a live catalog can only extend the bundled catalog."""
    if community["object_base_url"] != bundled["object_base_url"]:
        raise BundleError("community object storage is not trusted", "invalid_catalog")
    reserved = {pack["id"] for pack in bundled["packs"]}
    for pack in community["packs"]:
        if (
            pack["review"] != "community"
            or pack["availability"] != "installable"
            or pack["id"].startswith("official-")
            or pack["id"] in reserved
            or pack.get("local_id")
        ):
            raise BundleError(
                "the community catalog attempted to replace a protected bundle",
                "protected_bundle",
            )
    return community


def parse_community_catalog(
    raw: bytes, bundled: dict[str, Any], label: str
) -> dict[str, Any]:
    """Validate a community feed, including the intentional empty-feed case."""
    value = parse_json_bytes(raw, label)
    packs = value.get("packs")
    if packs == []:
        exact_keys(
            value,
            {"format", "format_version", "updated", "object_base_url", "packs"},
            set(),
            label,
        )
        if value["format"] != FORMAT_CATALOG or value["format_version"] != FORMAT_VERSION:
            raise BundleError("unsupported bundle catalog", "unsupported_catalog")
        community = {
            "format": FORMAT_CATALOG,
            "format_version": FORMAT_VERSION,
            "updated": checked_catalog_date(value["updated"], timestamp=True),
            "object_base_url": checked_url(
                value["object_base_url"], "object base URL", OBJECT_HOSTS, directory=True
            ),
            "packs": [],
        }
    else:
        if isinstance(packs, list):
            required_pack_fields = {
                "id", "version", "name", "description", "creator", "repository_url",
                "coverage", "style", "species_count", "species", "review",
                "availability", "manifest", "archive_bytes", "previews", "license",
            }
            for raw_pack in packs:
                pack = plain_record(raw_pack, "community catalog pack")
                exact_keys(pack, required_pack_fields, set(), "community catalog pack")
        community = validate_catalog(value, timestamp=True)
    validate_community_catalog(community, bundled)
    updated = catalog_revision(community["updated"])
    if updated > dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=1):
        raise BundleError("community catalog date is too far in the future", "catalog_future")
    return community


def merge_catalogs(
    bundled: dict[str, Any], community: dict[str, Any] | None
) -> dict[str, Any]:
    """Append verified community entries without altering any bundled field."""
    if community is None:
        return bundled
    validate_community_catalog(community, bundled)
    return {
        "format": bundled["format"],
        "format_version": bundled["format_version"],
        "updated": max(bundled["updated"], community["updated"]),
        "object_base_url": bundled["object_base_url"],
        "packs": [*bundled["packs"], *community["packs"]],
    }


def load_cached_community_catalog(
    bundled: dict[str, Any],
) -> dict[str, Any] | None:
    """Load a verified cache, failing closed to release data on any damage."""
    path = catalog_cache_path()
    if not path.exists() and not path.is_symlink():
        return None
    try:
        raw = read_regular(path, CATALOG_MAX)
        return parse_community_catalog(raw, bundled, "community catalog cache")
    except BundleError:
        return None


def load_catalog() -> dict[str, Any]:
    bundled = load_bundled_catalog()
    return merge_catalogs(bundled, load_cached_community_catalog(bundled))


def catalog_pack(catalog: dict[str, Any], pack_id: str) -> dict[str, Any]:
    wanted = checked_id(pack_id)
    for pack in catalog["packs"]:
        if pack["id"] == wanted:
            return pack
    raise BundleError("bundle is not in the trusted catalog", "unknown_bundle")


def resolve_use_selector(catalog: dict[str, Any], selector: str) -> dict[str, Any]:
    """Resolve a CLI selector without granting the caller download authority.

    IDs select the current row in the freshly validated install catalog. URLs
    are accepted only when they are byte-for-byte equal to that row's canonical
    checksum route. Public-discovery manifests intentionally use a different
    artifact contract and therefore are not aliases for station payloads.
    """
    if not isinstance(selector, str) or not selector or selector != selector.strip():
        raise BundleError("bundle selector is invalid", "invalid_selector")
    if ID_RE.fullmatch(selector) is not None:
        pack = catalog_pack(catalog, selector)
    else:
        candidate = checked_url(selector, "bundle manifest URL", MANIFEST_HOSTS)
        pack = next(
            (item for item in catalog["packs"] if item["manifest"]["url"] == candidate),
            None,
        )
        if pack is None:
            raise BundleError(
                "manifest URL is not in the current trusted install catalog",
                "unknown_bundle",
            )
    if pack["availability"] not in {"included", "installable"}:
        raise BundleError("this bundle is not available to use", "not_installable")
    return pack


class PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host: str, address: str, timeout: float = 25.0) -> None:
        super().__init__(host, 443, timeout=timeout, context=ssl.create_default_context())
        self._address = address

    def connect(self) -> None:
        socket_handle = socket.create_connection((self._address, 443), self.timeout)
        try:
            self.sock = self._context.wrap_socket(socket_handle, server_hostname=self.host)
        except Exception:
            socket_handle.close()
            raise


def public_addresses(host: str) -> list[str]:
    try:
        records = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    except socket.gaierror as error:
        raise BundleError("bundle host could not be resolved", "download_failed") from error
    output: list[str] = []
    for record in records:
        address = record[4][0]
        try:
            parsed = ipaddress.ip_address(address)
        except ValueError:
            continue
        if not parsed.is_global:
            raise BundleError("bundle host resolved to a private address", "unsafe_download")
        normalized = str(parsed)
        if normalized not in output:
            output.append(normalized)
    if not output:
        raise BundleError("bundle host has no public address", "download_failed")
    return output


def download_https(url: str, expected: int, hosts: frozenset[str]) -> bytes:
    current = checked_url(url, "download URL", hosts)
    for _redirect in range(REDIRECT_MAX + 1):
        parsed = urllib.parse.urlsplit(current)
        host = parsed.hostname or ""
        target = parsed.path + (("?" + parsed.query) if parsed.query else "")
        last_error: Exception | None = None
        for address in public_addresses(host):
            connection = PinnedHTTPSConnection(host, address)
            try:
                connection.request(
                    "GET",
                    target,
                    headers={"Accept": "application/json,image/png", "Accept-Encoding": "identity", "User-Agent": "AvianVisitors/1 bundle-manager"},
                )
                response = connection.getresponse()
                if response.status in {301, 302, 303, 307, 308}:
                    location = response.getheader("Location")
                    response.read(4096)
                    if not location:
                        raise BundleError("bundle redirect is invalid", "download_failed")
                    current = checked_url(urllib.parse.urljoin(current, location), "redirect URL", hosts)
                    break
                if response.status != 200:
                    response.read(4096)
                    raise BundleError("bundle download was not available", "download_failed")
                declared = response.getheader("Content-Length")
                if declared is not None and (not declared.isdigit() or int(declared) != expected):
                    raise BundleError("bundle download size is incorrect", "size_mismatch")
                raw = response.read(expected + 1)
                if len(raw) != expected or response.read(1):
                    raise BundleError("bundle download size is incorrect", "size_mismatch")
                return raw
            except BundleError:
                raise
            except (OSError, ssl.SSLError, http.client.HTTPException) as error:
                last_error = error
            finally:
                connection.close()
        else:
            raise BundleError("bundle download failed", "download_failed") from last_error
        # A redirect breaks the address loop above and continues here.
        continue
    raise BundleError("bundle used too many redirects", "download_failed")


def download_live_catalog_bytes() -> bytes:
    """Fetch the one fixed community feed with strict transport bounds."""
    current = checked_url(LIVE_CATALOG_URL, "community catalog URL", LIVE_CATALOG_HOSTS)
    if current != LIVE_CATALOG_URL:
        raise BundleError("community catalog URL is not canonical", "invalid_configuration")
    for _redirect in range(REDIRECT_MAX + 1):
        parsed = urllib.parse.urlsplit(current)
        host = parsed.hostname or ""
        target = parsed.path + (("?" + parsed.query) if parsed.query else "")
        last_error: Exception | None = None
        for address in public_addresses(host):
            connection = PinnedHTTPSConnection(host, address)
            try:
                connection.request(
                    "GET",
                    target,
                    headers={
                        "Accept": "application/json",
                        "Accept-Encoding": "identity",
                        "User-Agent": "AvianVisitors/1 bundle-catalog",
                    },
                )
                response = connection.getresponse()
                if response.status in {301, 302, 303, 307, 308}:
                    response.read(4096)
                    raise BundleError("community catalog must not redirect", "download_failed")
                if response.status != 200:
                    response.read(4096)
                    raise BundleError("community catalog was not available", "download_failed")
                media_type = (response.getheader("Content-Type") or "").split(";", 1)[0].strip().lower()
                if media_type not in {"application/json", "application/octet-stream"}:
                    raise BundleError("community catalog response is not JSON", "invalid_catalog")
                declared = response.getheader("Content-Length")
                if declared is not None and (
                    not declared.isdigit() or not 1 <= int(declared) <= CATALOG_MAX
                ):
                    raise BundleError("community catalog is too large", "catalog_too_large")
                raw = response.read(CATALOG_MAX + 1)
                if not raw or len(raw) > CATALOG_MAX:
                    raise BundleError("community catalog is too large", "catalog_too_large")
                return raw
            except BundleError:
                raise
            except (OSError, ssl.SSLError, http.client.HTTPException) as error:
                last_error = error
            finally:
                connection.close()
        else:
            raise BundleError("community catalog download failed", "download_failed") from last_error
        continue
    raise BundleError("community catalog used too many redirects", "download_failed")


def empty_catalog_history() -> dict[str, Any]:
    return {
        "format": "avian-station-community-catalog-bindings",
        "format_version": 1,
        "updated": None,
        "catalog_sha256": None,
        "ids": {},
    }


def load_catalog_history() -> tuple[dict[str, Any], bool]:
    path = catalog_history_path()
    if not path.exists() and not path.is_symlink():
        return empty_catalog_history(), False
    value = parse_json_bytes(
        read_regular(path, CATALOG_HISTORY_MAX), "community catalog bindings"
    )
    exact_keys(
        value,
        {"format", "format_version", "updated", "catalog_sha256", "ids"},
        set(),
        "community catalog bindings",
    )
    if (
        value["format"] != "avian-station-community-catalog-bindings"
        or value["format_version"] != 1
        or not isinstance(value["ids"], dict)
    ):
        raise BundleError(
            "community catalog bindings are invalid", "invalid_catalog_history"
        )
    normalized = empty_catalog_history()
    updated = value["updated"]
    catalog_digest = value["catalog_sha256"]
    if (updated is None) != (catalog_digest is None):
        raise BundleError(
            "community catalog bindings are invalid", "invalid_catalog_history"
        )
    if updated is not None:
        normalized["updated"] = checked_catalog_date(updated, timestamp=True)
        normalized["catalog_sha256"] = checked_hash(
            catalog_digest, "catalog SHA-256"
        )
    total = 0
    for raw_id, raw_record in value["ids"].items():
        pack_id = checked_id(raw_id)
        if pack_id.startswith("official-"):
            raise BundleError(
                "community catalog bindings are invalid", "invalid_catalog_history"
            )
        record = plain_record(raw_record, "community catalog binding")
        exact_keys(
            record,
            {"highest_version", "versions"},
            set(),
            "community catalog binding",
        )
        highest = checked_version(record["highest_version"])
        versions_raw = record["versions"]
        if not isinstance(versions_raw, dict) or highest not in versions_raw:
            raise BundleError(
                "community catalog bindings are invalid", "invalid_catalog_history"
            )
        versions: dict[str, str] = {}
        highest_precedence = semver_precedence(highest)
        precedence_seen: dict[tuple[Any, ...], str] = {}
        for raw_version, raw_digest in versions_raw.items():
            version = checked_version(raw_version)
            digest = checked_hash(raw_digest, "catalog row SHA-256")
            precedence = semver_precedence(version)
            if precedence > highest_precedence or (
                precedence in precedence_seen and precedence_seen[precedence] != version
            ):
                raise BundleError(
                    "community catalog bindings are invalid", "invalid_catalog_history"
                )
            precedence_seen[precedence] = version
            versions[version] = digest
            total += 1
            if total > CATALOG_HISTORY_ENTRIES_MAX:
                raise BundleError(
                    "community catalog binding history is full", "catalog_history_full"
                )
        normalized["ids"][pack_id] = {
            "highest_version": highest,
            "versions": versions,
        }
    return normalized, True


def record_catalog_revision(
    history: dict[str, Any], catalog: dict[str, Any], raw: bytes
) -> None:
    """Advance the durable publication-date and exact-byte binding floor."""
    updated = catalog["updated"]
    digest = sha256_bytes(raw)
    previous = history["updated"]
    if previous is not None:
        previous_revision = catalog_revision(previous)
        current_revision = catalog_revision(updated)
        if current_revision < previous_revision:
            raise BundleError(
                "community catalog date moved backwards", "catalog_rollback"
            )
        if current_revision == previous_revision and digest != history["catalog_sha256"]:
            raise BundleError(
                "community catalog changed without a new date", "catalog_equivocation"
            )
    history["updated"] = updated
    history["catalog_sha256"] = digest


def record_catalog_bindings(
    history: dict[str, Any], packs: Iterable[dict[str, Any]]
) -> dict[str, Any]:
    ids = history["ids"]
    total = sum(len(record["versions"]) for record in ids.values())
    for pack in packs:
        pack_id = pack["id"]
        version = pack["version"]
        row_digest = sha256_bytes(canonical_json(pack))
        record = ids.get(pack_id)
        if record is None:
            total += 1
            if total > CATALOG_HISTORY_ENTRIES_MAX:
                raise BundleError(
                    "community catalog binding history is full", "catalog_history_full"
                )
            ids[pack_id] = {
                "highest_version": version,
                "versions": {version: row_digest},
            }
            continue
        highest = record["highest_version"]
        precedence = semver_precedence(version)
        highest_precedence = semver_precedence(highest)
        if precedence < highest_precedence:
            raise BundleError(
                "community bundle version moved backwards", "catalog_version_rollback"
            )
        if precedence == highest_precedence and version != highest:
            raise BundleError(
                "community bundle version was rebound to different content",
                "catalog_version_rebinding",
            )
        bound = record["versions"].get(version)
        if bound is not None and bound != row_digest:
            raise BundleError(
                "community bundle version was rebound to different content",
                "catalog_version_rebinding",
            )
        if bound is None:
            total += 1
            if total > CATALOG_HISTORY_ENTRIES_MAX:
                raise BundleError(
                    "community catalog binding history is full", "catalog_history_full"
                )
            record["versions"][version] = row_digest
        if precedence > highest_precedence:
            record["highest_version"] = version
    if len(canonical_json(history)) > CATALOG_HISTORY_MAX:
        raise BundleError(
            "community catalog binding history is full", "catalog_history_full"
        )
    return history


def refresh_catalog() -> dict[str, Any]:
    """Validate and atomically cache a newer community-only catalog."""
    ensure_storage()
    bundled = load_bundled_catalog()
    raw = download_live_catalog_bytes()
    community = parse_community_catalog(raw, bundled, "community catalog")

    # Download without holding the operation lock. Compare and publish under
    # the lock so a manual root refresh cannot race the web-triggered worker.
    with locked():
        cache_path = catalog_cache_path()
        previous = None
        previous_bytes = b""
        if cache_path.exists() or cache_path.is_symlink():
            try:
                previous_bytes = read_regular(cache_path, CATALOG_MAX)
                previous = parse_community_catalog(
                    previous_bytes, bundled, "community catalog cache"
                )
            except BundleError:
                previous = None
        if previous is not None:
            community_revision = catalog_revision(community["updated"])
            previous_revision = catalog_revision(previous["updated"])
            if community_revision < previous_revision:
                raise BundleError("community catalog date moved backwards", "catalog_rollback")
            if community_revision == previous_revision and raw != previous_bytes:
                raise BundleError(
                    "community catalog changed without a new date", "catalog_equivocation"
                )
            previous_by_id = {pack["id"]: pack for pack in previous["packs"]}
            community_by_id = {pack["id"]: pack for pack in community["packs"]}
            for pack_id in previous_by_id.keys() & community_by_id.keys():
                old_pack = previous_by_id[pack_id]
                new_pack = community_by_id[pack_id]
                old_precedence = semver_precedence(old_pack["version"])
                new_precedence = semver_precedence(new_pack["version"])
                if new_precedence < old_precedence:
                    raise BundleError(
                        "community bundle version moved backwards",
                        "catalog_version_rollback",
                    )
                if (
                    new_precedence == old_precedence
                    and canonical_json(new_pack) != canonical_json(old_pack)
                ):
                    raise BundleError(
                        "community bundle version was rebound to different content",
                        "catalog_version_rebinding",
                    )
        history, existed = load_catalog_history()
        if not existed and previous is not None:
            record_catalog_bindings(history, previous["packs"])
            record_catalog_revision(history, previous, previous_bytes)
        record_catalog_bindings(history, community["packs"])
        record_catalog_revision(history, community, raw)
        # Advance the durable binding floor first. A crash before the catalog
        # replacement may delay visibility, but cannot permit a previously
        # observed id/version to return with different bytes.
        atomic_bytes(catalog_history_path(), canonical_json(history))
        atomic_bytes(cache_path, raw)
    return merge_catalogs(bundled, community)


def dev_manifest_bytes(expected_hash: str, expected_size: int) -> bytes:
    root = dev_root()
    if root is None:
        raise BundleError("developer bundle root is not configured", "invalid_configuration")
    safe_directory(root)
    path = root / "manifests" / f"{expected_hash}.json"
    raw = read_regular(path, MANIFEST_MAX, allow_writable=True)
    if len(raw) != expected_size:
        raise BundleError("developer manifest size is incorrect", "size_mismatch")
    return raw


def object_store_path(root: Path, digest: str) -> Path:
    checked_hash(digest)
    return root / "objects" / "sha256" / digest[:2] / f"{digest}.png"


def object_store_inventory(root: Path) -> dict[str, int]:
    """Return a strict, bounded inventory for storage admission checks."""
    objects = root / "objects" / "sha256"
    safe_directory(objects)
    inventory: dict[str, int] = {}
    total = 0
    try:
        prefixes = list(objects.iterdir())
    except OSError as error:
        raise BundleError("bundle object storage is unavailable", "storage_unavailable") from error
    for prefix in prefixes:
        if re.fullmatch(r"[0-9a-f]{2}", prefix.name) is None:
            raise BundleError("bundle object storage is unsafe", "unsafe_storage")
        safe_directory(prefix)
        try:
            candidates = list(prefix.iterdir())
        except OSError as error:
            raise BundleError("bundle object storage is unavailable", "storage_unavailable") from error
        for candidate in candidates:
            match = re.fullmatch(r"([0-9a-f]{64})[.]png", candidate.name)
            try:
                info = candidate.lstat()
            except OSError as error:
                raise BundleError("bundle object storage is unsafe", "unsafe_storage") from error
            if (
                match is None
                or match.group(1)[:2] != prefix.name
                or not stat.S_ISREG(info.st_mode)
                or stat.S_ISLNK(info.st_mode)
                or info.st_nlink != 1
                or info.st_mode & 0o022
                or info.st_uid != os.geteuid()
                or info.st_gid != os.getegid()
                or not 67 <= info.st_size <= IMAGE_MAX
            ):
                raise BundleError("bundle object storage is unsafe", "unsafe_storage")
            inventory[match.group(1)] = info.st_size
            total += info.st_size
            if total > OBJECT_STORE_MAX:
                raise BundleError("bundle object storage is full", "storage_limit")
    return inventory


def dev_object_bytes(digest: str, expected_size: int) -> bytes:
    root = dev_root()
    if root is None:
        raise BundleError("developer bundle root is not configured", "invalid_configuration")
    path = root / "objects" / "sha256" / digest[:2] / f"{digest}.png"
    raw = read_regular(path, IMAGE_MAX, allow_writable=True)
    if len(raw) != expected_size:
        raise BundleError("developer object size is incorrect", "size_mismatch")
    return raw


def fetch_manifest(pack: dict[str, Any]) -> bytes:
    record = pack["manifest"]
    if dev_root() is not None:
        raw = dev_manifest_bytes(record["sha256"], record["bytes"])
    else:
        raw = download_https(record["url"], record["bytes"], MANIFEST_HOSTS)
    if sha256_bytes(raw) != record["sha256"]:
        raise BundleError("manifest hash is incorrect", "manifest_hash")
    return raw


def object_url(catalog: dict[str, Any], digest: str) -> str:
    return urllib.parse.urljoin(catalog["object_base_url"], f"{digest}.png")


def fetch_object(catalog: dict[str, Any], digest: str, expected_size: int) -> bytes:
    raw = (
        dev_object_bytes(digest, expected_size)
        if dev_root() is not None
        else download_https(object_url(catalog, digest), expected_size, OBJECT_HOSTS)
    )
    if sha256_bytes(raw) != digest:
        raise BundleError("illustration hash is incorrect", "object_hash")
    return raw


def open_png(raw: bytes, label: str):
    """Decode a PNG locally for the unprivileged builder and test harness."""
    try:
        from PIL import Image
    except ImportError as error:
        raise BundleError("Pillow is required to inspect bundle images", "missing_dependency") from error
    if not raw.startswith(b"\x89PNG\r\n\x1a\n"):
        raise BundleError(f"{label} is not a PNG", "invalid_png")
    previous_limit = Image.MAX_IMAGE_PIXELS
    Image.MAX_IMAGE_PIXELS = IMAGE_PIXELS_MAX
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(__import__("io").BytesIO(raw)) as source:
                if source.format != "PNG" or getattr(source, "n_frames", 1) != 1:
                    raise BundleError(f"{label} is not a static PNG", "invalid_png")
                width, height = source.size
                if (
                    width < 1
                    or height < 1
                    or width > IMAGE_DIM_MAX
                    or height > IMAGE_DIM_MAX
                    or width * height > IMAGE_PIXELS_MAX
                ):
                    raise BundleError(f"{label} dimensions are unsupported", "invalid_png")
                image = source.convert("RGBA")
                image.load()
    except BundleError:
        raise
    except Exception as error:
        raise BundleError(f"{label} could not be decoded", "invalid_png") from error
    finally:
        Image.MAX_IMAGE_PIXELS = previous_limit
    low, _high = image.getchannel("A").getextrema()
    # A cutout needs a genuinely empty background pixel. Merely carrying an
    # alpha channel, or making the full canvas uniformly translucent, is not
    # enough. local_mask_geometry separately proves visible foreground art.
    if low != 0:
        raise BundleError(f"{label} must contain visible art and transparency", "invalid_alpha")
    return image


def local_mask_geometry(raw: bytes, slug: str) -> tuple[list[int], dict[str, Any]]:
    from PIL import Image

    resampling = getattr(Image, "Resampling", Image).LANCZOS
    image = open_png(raw, slug)
    try:
        width, height = image.size
        scale = 560 / max(width, height)
        dimensions = [max(1, round(width * scale)), max(1, round(height * scale))]
        mask_scale = 93 / max(width, height)
        mask_width = max(1, round(width * mask_scale))
        mask_height = max(1, round(height * mask_scale))
        alpha = image.getchannel("A").resize((mask_width, mask_height), resampling)
        pixels = alpha.load()
        packed = bytearray((mask_width * mask_height + 7) // 8)
        for y in range(mask_height):
            for x in range(mask_width):
                if pixels[x, y] > 127:
                    offset = y * mask_width + x
                    packed[offset >> 3] |= 1 << (7 - (offset & 7))
        if not any(packed):
            raise BundleError(f"{slug} has no visible mask", "invalid_alpha")
        mask = {
            "w": mask_width,
            "h": mask_height,
            "bits": base64.b64encode(packed).decode("ascii"),
        }
        return dimensions, mask
    finally:
        image.close()


def checked_geometry(raw: Any) -> tuple[list[int], dict[str, Any]]:
    value = plain_record(raw, "image geometry")
    exact_keys(value, {"dimensions", "mask"}, set(), "image geometry")
    dimensions = value["dimensions"]
    mask = plain_record(value["mask"], "image mask")
    exact_keys(mask, {"w", "h", "bits"}, set(), "image mask")
    if (
        not isinstance(dimensions, list)
        or len(dimensions) != 2
        or any(isinstance(item, bool) or not isinstance(item, int) or item < 1 or item > 560 for item in dimensions)
        or isinstance(mask["w"], bool)
        or not isinstance(mask["w"], int)
        or not 1 <= mask["w"] <= 93
        or isinstance(mask["h"], bool)
        or not isinstance(mask["h"], int)
        or not 1 <= mask["h"] <= 93
        or not isinstance(mask["bits"], str)
        or len(mask["bits"]) > 2048
    ):
        raise BundleError("image geometry is invalid", "invalid_png")
    try:
        packed = base64.b64decode(mask["bits"], validate=True)
    except (ValueError, TypeError) as error:
        raise BundleError("image geometry is invalid", "invalid_png") from error
    expected = (mask["w"] * mask["h"] + 7) // 8
    if len(packed) != expected or not any(packed):
        raise BundleError("image geometry is invalid", "invalid_png")
    return list(dimensions), {"w": mask["w"], "h": mask["h"], "bits": mask["bits"]}


def mask_geometry(raw: bytes, slug: str) -> tuple[list[int], dict[str, Any]]:
    # Development runs already execute without privilege. Production forks a
    # one-image worker, removes its network and filesystem view, drops every
    # group and capability-bearing identity, and accepts only bounded geometry
    # over a private pipe.
    if os.geteuid() != 0 or os.environ.get("AVIAN_BUNDLE_ROOT"):
        return local_mask_geometry(raw, slug)
    try:
        account = pwd.getpwnam(IMAGE_SANDBOX_USER)
    except KeyError as error:
        raise BundleError("bundle image sandbox is unavailable", "missing_dependency") from error
    if account.pw_uid == 0 or account.pw_gid == 0:
        raise BundleError("bundle image sandbox is unsafe", "unsafe_sandbox")
    sandbox_root = Path(IMAGE_SANDBOX_ROOT)
    safe_directory(sandbox_root.parent)
    safe_directory(sandbox_root)
    sandbox_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    if hasattr(os, "O_NOFOLLOW"):
        sandbox_flags |= os.O_NOFOLLOW
    try:
        sandbox_descriptor = os.open(sandbox_root, sandbox_flags)
    except OSError as error:
        raise BundleError("bundle image sandbox is unsafe", "unsafe_sandbox") from error
    try:
        from PIL import Image

        Image.init()
    except Exception as error:
        raise BundleError("Pillow is required to inspect bundle images", "missing_dependency") from error

    read_descriptor, write_descriptor = os.pipe()
    child = os.fork()
    if child == 0:
        try:
            os.close(read_descriptor)
            libc = ctypes.CDLL(None, use_errno=True)
            if not hasattr(libc, "unshare") or libc.unshare(0x40000000) != 0:
                os._exit(70)
            for name in os.listdir("/proc/self/fd"):
                descriptor = int(name)
                if descriptor not in {write_descriptor, sandbox_descriptor}:
                    try:
                        os.close(descriptor)
                    except OSError:
                        pass
            resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
            resource.setrlimit(resource.RLIMIT_CPU, (15, 15))
            resource.setrlimit(resource.RLIMIT_FSIZE, (1024 * 1024, 1024 * 1024))
            resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))
            resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024, 256 * 1024 * 1024))
            if hasattr(resource, "RLIMIT_NPROC"):
                resource.setrlimit(resource.RLIMIT_NPROC, (0, 0))
            if not hasattr(libc, "prctl") or libc.prctl(38, 1, 0, 0, 0) != 0:  # PR_SET_NO_NEW_PRIVS
                os._exit(70)
            os.fchdir(sandbox_descriptor)
            os.chroot(".")
            os.chdir("/")
            os.close(sandbox_descriptor)
            os.setgroups([])
            os.setgid(account.pw_gid)
            os.setuid(account.pw_uid)
            os.umask(0o077)
            dimensions, mask = local_mask_geometry(raw, slug)
            output = canonical_json({"dimensions": dimensions, "mask": mask})
            if len(output) > 4096:
                os._exit(70)
            offset = 0
            while offset < len(output):
                offset += os.write(write_descriptor, output[offset:])
            os.close(write_descriptor)
            os._exit(0)
        except BaseException:
            os._exit(70)

    os.close(write_descriptor)
    os.close(sandbox_descriptor)
    output = bytearray()
    deadline = time.monotonic() + 25
    status: int | None = None
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError
            ready, _, _ = select.select([read_descriptor], [], [], min(remaining, 0.25))
            if ready:
                chunk = os.read(read_descriptor, 4097 - len(output))
                if not chunk:
                    break
                output.extend(chunk)
                if len(output) > 4096:
                    raise BundleError("bundle image validation failed safely", "invalid_png")
            finished, candidate = os.waitpid(child, os.WNOHANG)
            if finished:
                status = candidate
                if not ready:
                    continue
        if status is None:
            _, status = os.waitpid(child, 0)
    except (OSError, TimeoutError, BundleError) as error:
        try:
            os.kill(child, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(child, 0)
        except ChildProcessError:
            pass
        if isinstance(error, BundleError):
            raise
        raise BundleError("bundle image validation failed safely", "invalid_png") from error
    finally:
        os.close(read_descriptor)
    if status is None or os.waitstatus_to_exitcode(status) != 0:
        raise BundleError("bundle image validation failed safely", "invalid_png")
    return checked_geometry(parse_json_bytes(bytes(output), "image geometry"))


def mask_tables(images: dict[str, bytes]) -> tuple[dict[str, list[int]], dict[str, dict[str, Any]]]:
    dims: dict[str, list[int]] = {}
    masks: dict[str, dict[str, Any]] = {}
    for slug in sorted(images):
        dims[slug], masks[slug] = mask_geometry(images[slug], slug)
    return dims, masks


def builtin_ref() -> dict[str, Any]:
    return {
        "id": BUILTIN_ID,
        "version": BUILTIN_VERSION,
        "revision": BUILTIN_REVISION,
        "included": True,
        "name": "Japanese Woodblock",
    }


def normalize_ref(raw: Any, label: str) -> dict[str, Any]:
    value = plain_record(raw, label)
    exact_keys(value, {"id", "version", "revision", "included", "name"}, {"selection_revision"}, label)
    included = value["included"]
    if not isinstance(included, bool):
        raise BundleError(f"{label} is invalid", "invalid_state")
    name = clean_text(value["name"], 90, f"{label} name")
    if included:
        if value != builtin_ref():
            raise BundleError(f"{label} is invalid", "invalid_state")
        return builtin_ref()
    reference = {
        "id": checked_id(value["id"]),
        "version": checked_version(value["version"]),
        "revision": checked_hash(value["revision"], "revision"),
        "included": False,
        "name": name,
    }
    if "selection_revision" in value:
        reference["selection_revision"] = checked_hash(value["selection_revision"], "selection revision")
    return reference


def pack_directory(reference: dict[str, Any]) -> Path:
    directory = bundle_root() / "packs" / checked_id(reference["id"]) / checked_version(reference["version"])
    if "selection_revision" in reference:
        directory = directory / "selections" / checked_hash(reference["selection_revision"], "selection revision")
    return directory


def selection_record(manifest: dict[str, Any], revision: str, basis: dict[str, Any] | None) -> dict[str, Any]:
    available = {bird["scientific_name"] for bird in manifest["species"]}
    selected = available if basis is None else available & set(basis["species"])
    if not selected:
        raise BundleError("This bundle has no illustrations for your station's local birds.", "no_local_species")
    return {
        "schema_version": 1,
        "mode": "all" if basis is None else "local",
        "manifest_sha256": revision,
        "species": sorted(selected),
        "basis_sha256": (
            sha256_bytes(canonical_json({"schema_version": 1, "mode": "all"}))
            if basis is None else basis["basis_sha256"]
        ),
    }


def load_selection(reference: dict[str, Any], directory: Path) -> dict[str, Any]:
    raw = read_regular(directory / "selection.json", SELECTION_MAX)
    if sha256_bytes(raw) != reference["selection_revision"]:
        raise BundleError("installed selection revision is invalid", "invalid_install")
    selection = parse_json_bytes(raw, "installed selection")
    exact_keys(selection, {"schema_version", "mode", "manifest_sha256", "species", "basis_sha256"}, set(), "installed selection")
    if (
        selection["schema_version"] != 1
        or not isinstance(selection["mode"], str)
        or selection["mode"] not in {"local", "all"}
        or selection["manifest_sha256"] != reference["revision"]
    ):
        raise BundleError("installed selection is invalid", "invalid_install")
    checked_hash(selection["basis_sha256"], "selection basis")
    names = checked_string_list(selection["species"], "selected species", SPECIES_MAX, SCI_NAME_MAX, SCI_RE)
    if not names or names != selection["species"] or names != sorted(set(names)):
        raise BundleError("installed selection species are invalid", "invalid_install")
    return selection


def selected_species(manifest: dict[str, Any], reference: dict[str, Any], directory: Path) -> list[dict[str, Any]]:
    if "selection_revision" not in reference:
        return manifest["species"]
    selection = load_selection(reference, directory)
    names = set(selection["species"])
    available = {bird["scientific_name"] for bird in manifest["species"]}
    if not names <= available:
        raise BundleError("installed selection species are invalid", "invalid_install")
    if selection["mode"] == "all" and selection != selection_record(manifest, reference["revision"], None):
        raise BundleError("installed full selection is incomplete", "invalid_install")
    return [bird for bird in manifest["species"] if bird["scientific_name"] in names]


def load_index(
    reference: dict[str, Any],
    *,
    directory: Path | None = None,
) -> dict[str, Any]:
    if reference.get("included"):
        raise BundleError("the included bundle has no installed index", "invalid_state")
    if directory is None:
        directory = pack_directory(reference)
        parent = directory.parent
        while parent != bundle_root():
            safe_directory(parent)
            parent = parent.parent
    safe_directory(directory.parent)
    safe_directory(directory)
    index = read_json(directory / "index.json", STATE_MAX)
    exact_keys(index, {"schema_version", "id", "version", "revision", "assets"}, {"selection_revision"}, "bundle index")
    if (
        index["schema_version"] != 1
        or index["id"] != reference["id"]
        or index["version"] != reference["version"]
        or index["revision"] != reference["revision"]
        or index.get("selection_revision") != reference.get("selection_revision")
        or ("selection_revision" in index) != ("selection_revision" in reference)
    ):
        raise BundleError("installed bundle identity is invalid", "invalid_install")
    assets = plain_record(index["assets"], "bundle assets")
    if not assets or len(assets) > SPECIES_MAX:
        raise BundleError("installed bundle inventory is invalid", "invalid_install")
    if "selection_revision" in reference:
        selection = load_selection(reference, directory)
        if set(assets) != {scientific_slug(name) for name in selection["species"]}:
            raise BundleError("installed inventory does not match its selection", "invalid_install")
    count = 0
    for slug, raw_poses in assets.items():
        if (
            not isinstance(slug, str)
            or len(slug) > SCI_NAME_MAX
            or SCI_SLUG_RE.fullmatch(slug) is None
        ):
            raise BundleError("installed bundle slug is invalid", "invalid_install")
        poses = plain_record(raw_poses, "bundle poses")
        if not poses or set(poses) - POSES:
            raise BundleError("installed bundle poses are invalid", "invalid_install")
        for pose, raw_object in poses.items():
            item = plain_record(raw_object, "bundle object")
            exact_keys(item, {"sha256", "bytes"}, set(), "bundle object")
            size = item["bytes"]
            if (
                pose not in POSES
                or isinstance(size, bool)
                or not isinstance(size, int)
                or not 67 <= size <= IMAGE_MAX
            ):
                raise BundleError("installed bundle object is invalid", "invalid_install")
            checked_hash(item["sha256"], "object SHA-256")
            count += 1
            if count > OBJECTS_MAX:
                raise BundleError("installed bundle has too many objects", "invalid_install")
    return index


def reference_exists(reference: dict[str, Any]) -> bool:
    if reference.get("included"):
        return reference == builtin_ref()
    try:
        validate_runtime_reference(reference)
        return True
    except BundleError:
        return False


def load_state(*, missing_ok: bool = False) -> dict[str, Any]:
    path = bundle_root() / "active.json"
    if not path.exists() and not path.is_symlink():
        if missing_ok:
            return {"schema_version": 1, "active": builtin_ref(), "previous": None}
        raise BundleError("active bundle state is missing", "invalid_state")
    state = read_json(path, 16 * 1024)
    exact_keys(state, {"schema_version", "active", "previous"}, set(), "active state")
    if state["schema_version"] != 1:
        raise BundleError("active bundle state is invalid", "invalid_state")
    active = normalize_ref(state["active"], "active bundle")
    previous = None if state["previous"] is None else normalize_ref(state["previous"], "previous bundle")
    if not reference_exists(active) or (previous is not None and not reference_exists(previous)):
        raise BundleError("active bundle state refers to missing data", "invalid_state")
    return {"schema_version": 1, "active": active, "previous": previous}


def save_state(active: dict[str, Any], previous: dict[str, Any] | None) -> None:
    normalized_active = normalize_ref(active, "active bundle")
    normalized_previous = None if previous is None else normalize_ref(previous, "previous bundle")
    if not reference_exists(normalized_active) or (
        normalized_previous is not None and not reference_exists(normalized_previous)
    ):
        raise BundleError("bundle state refers to missing data", "invalid_state")
    atomic_json(
        bundle_root() / "active.json",
        {"schema_version": 1, "active": normalized_active, "previous": normalized_previous},
    )


def installed_records() -> list[dict[str, Any]]:
    root = bundle_root() / "packs"
    output: list[dict[str, Any]] = []
    if not root.is_dir() or root.is_symlink():
        return output
    for id_path in sorted(root.iterdir(), key=lambda item: item.name):
        if ID_RE.fullmatch(id_path.name) is None or not id_path.is_dir() or id_path.is_symlink():
            continue
        for version_path in sorted(id_path.iterdir(), key=lambda item: item.name):
            if VERSION_RE.fullmatch(version_path.name) is None or not version_path.is_dir() or version_path.is_symlink():
                continue
            try:
                safe_directory(id_path)
                safe_directory(version_path)
                directories = installed_profile_directories(version_path)
            except BundleError:
                continue
            for directory in directories:
                try:
                    meta = read_json(directory / "meta.json", STATE_MAX)
                    reference = normalize_ref(meta["reference"], "installed bundle")
                    if (reference["id"] != id_path.name or reference["version"] != version_path.name
                            or pack_directory(reference) != directory):
                        raise BundleError("installed path identity is invalid", "invalid_install")
                    output.append(validate_installed_pack(reference))
                except (BundleError, KeyError, TypeError):
                    continue
    return output


def installed_profile_directories(version_path: Path) -> list[Path]:
    safe_directory(version_path)
    output = []
    if any((version_path / name).exists() or (version_path / name).is_symlink()
           for name in ("meta.json", "index.json", "manifest.json", "dims.json", "masks.json")):
        output.append(version_path)
    selections = version_path / "selections"
    if selections.exists() or selections.is_symlink():
        safe_directory(selections)
        entries = list(selections.iterdir())
        if len(entries) > 128:
            raise BundleError("too many installed local selections", "storage_limit")
        for entry in sorted(entries):
            checked_hash(entry.name, "selection revision")
            safe_directory(entry)
            output.append(entry)
    if not output and any(version_path.iterdir()):
        raise BundleError("installed bundle storage is invalid", "invalid_install")
    return output


def current_install(pack_id: str, version: str | None = None) -> dict[str, Any] | None:
    candidates = [
        item for item in installed_records()
        if item["reference"]["id"] == pack_id
        and (version is None or item["reference"]["version"] == version)
    ]
    if not candidates:
        return None
    return max(
        candidates,
        key=lambda item: (
            installed_version_key(item["reference"]["version"]),
            item.get("installed_at", ""),
            item["reference"].get("selection_revision", ""),
        ),
    )


def validate_stored_object(
    root: Path,
    digest: str,
    expected_size: int,
    *,
    inspect: bool = True,
) -> bytes:
    path = object_store_path(root, digest)
    safe_directory(path.parent)
    raw = read_regular(path, IMAGE_MAX)
    if len(raw) != expected_size or sha256_bytes(raw) != digest:
        raise BundleError("stored illustration is corrupt", "object_hash")
    if inspect:
        mask_geometry(raw, digest)
    return raw


def validate_stored_object_stat(root: Path, digest: str, expected_size: int) -> None:
    path = object_store_path(root, digest)
    safe_directory(path.parent)
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise BundleError("stored illustration is unavailable", "missing_file") from error
    try:
        before = path.lstat()
        opened = os.fstat(descriptor)
        if (
            not stat.S_ISREG(opened.st_mode)
            or stat.S_ISLNK(before.st_mode)
            or opened.st_nlink != 1
            or opened.st_mode & 0o022
            or opened.st_uid != os.geteuid()
            or opened.st_gid != os.getegid()
            or opened.st_dev != before.st_dev
            or opened.st_ino != before.st_ino
            or opened.st_size != expected_size
        ):
            raise BundleError("stored illustration is unsafe", "unsafe_file")
    finally:
        os.close(descriptor)


def validate_runtime_reference(
    reference: dict[str, Any],
    *,
    verify_hashes: bool = False,
) -> dict[str, Any]:
    normalized = normalize_ref(reference, "bundle runtime reference")
    if normalized["included"]:
        if normalized != builtin_ref():
            raise BundleError("included bundle reference is invalid", "invalid_state")
        return {"schema_version": 1, "assets": {}}
    if verify_hashes and "selection_revision" in normalized:
        validate_installed_pack(normalized, verify_hashes=True)
    index = load_index(normalized)
    directory = pack_directory(normalized)
    dims = read_json(directory / "dims.json", TABLE_MAX)
    masks = read_json(directory / "masks.json", TABLE_MAX)
    expected_slugs = {
        species_slug + ("-2" if pose == "flight" else "")
        for species_slug, poses in index["assets"].items()
        for pose in poses
    }
    if set(dims) != expected_slugs or set(masks) != expected_slugs:
        raise BundleError("bundle runtime geometry is invalid", "invalid_install")
    for slug in expected_slugs:
        checked_geometry({"dimensions": dims[slug], "mask": masks[slug]})
    root = bundle_root()
    for poses in index["assets"].values():
        for item in poses.values():
            if verify_hashes:
                validate_stored_object(root, item["sha256"], item["bytes"], inspect=False)
            else:
                validate_stored_object_stat(root, item["sha256"], item["bytes"])
    return index


def validate_installed_pack(
    reference: dict[str, Any],
    *,
    verify_hashes: bool = False,
    directory: Path | None = None,
) -> dict[str, Any]:
    normalized = normalize_ref(reference, "installed bundle")
    if normalized["included"]:
        raise BundleError("the included bundle has no installed files", "invalid_install")
    directory = pack_directory(normalized) if directory is None else directory
    safe_directory(directory.parent)
    safe_directory(directory)
    allowed = {"manifest.json", "index.json", "dims.json", "masks.json", "meta.json"}
    if "selection_revision" in normalized:
        allowed.add("selection.json")
    elif (directory / "selections").exists():
        safe_directory(directory / "selections")
        allowed.add("selections")
    try:
        if {item.name for item in directory.iterdir()} != allowed:
            raise BundleError("installed bundle contains unsupported files", "invalid_install")
    except OSError as error:
        raise BundleError("installed bundle is unavailable", "invalid_install") from error

    meta = read_json(directory / "meta.json", STATE_MAX)
    exact_keys(meta, {"reference", "installed_at"}, set(), "installed metadata")
    if normalize_ref(meta["reference"], "installed bundle") != normalized:
        raise BundleError("installed metadata identity is invalid", "invalid_install")
    clean_text(meta["installed_at"], 32, "installation date")

    manifest_raw = read_regular(directory / "manifest.json", MANIFEST_MAX)
    if sha256_bytes(manifest_raw) != normalized["revision"]:
        raise BundleError("installed manifest revision is invalid", "invalid_install")
    manifest = validate_manifest(parse_json_bytes(manifest_raw, "installed manifest"))
    if manifest["id"] != normalized["id"] or manifest["version"] != normalized["version"]:
        raise BundleError("installed manifest identity is invalid", "invalid_install")

    index = load_index(normalized, directory=directory)
    birds = selected_species(manifest, normalized, directory)
    expected_assets: dict[str, dict[str, dict[str, Any]]] = {}
    for bird in birds:
        species_slug = scientific_slug(bird["scientific_name"])
        expected_assets[species_slug] = {
            pose["id"]: {"sha256": pose["sha256"], "bytes": pose["bytes"]}
            for pose in bird["poses"]
        }
    if index["assets"] != expected_assets:
        raise BundleError("installed inventory does not match its manifest", "invalid_install")

    dims = read_json(directory / "dims.json", TABLE_MAX)
    masks = read_json(directory / "masks.json", TABLE_MAX)
    expected_slugs = {
        pose_slug(bird["scientific_name"], pose["id"])
        for bird in birds
        for pose in bird["poses"]
    }
    if set(dims) != expected_slugs or set(masks) != expected_slugs:
        raise BundleError("installed geometry inventory is invalid", "invalid_install")
    for slug in expected_slugs:
        checked_geometry({"dimensions": dims[slug], "mask": masks[slug]})

    root = bundle_root()
    for poses in index["assets"].values():
        for item in poses.values():
            if verify_hashes:
                validate_stored_object(root, item["sha256"], item["bytes"], inspect=False)
            else:
                validate_stored_object_stat(root, item["sha256"], item["bytes"])
    return {
        "reference": normalized,
        "name": manifest["name"],
        "coverage": manifest["coverage"],
        "style": manifest["style"],
        "species_count": len(index["assets"]),
        "license": manifest["license"]["spdx"],
        "creator": manifest["attribution"]["creator"],
        "archive_bytes": manifest["total_bytes"],
        "installed_bytes": sum({item["sha256"]: item["bytes"] for poses in index["assets"].values() for item in poses.values()}.values()),
        "installed_at": meta["installed_at"],
    }


def store_object(
    root: Path,
    digest: str,
    expected_size: int,
    raw: bytes,
    *,
    inspected: bool = False,
) -> None:
    path = object_store_path(root, digest)
    safe_directory(path.parent, create=True)
    if path.exists() or path.is_symlink():
        validate_stored_object(root, digest, expected_size, inspect=not inspected)
        return
    if len(raw) != expected_size or sha256_bytes(raw) != digest:
        raise BundleError("illustration does not match its manifest", "object_hash")
    if not inspected:
        mask_geometry(raw, digest)
    atomic_bytes(path, raw)


def update_job(job_id: str, **changes: Any) -> dict[str, Any]:
    with locked():
        job = load_job()
        if job is None or job.get("id") != job_id:
            raise BundleError("bundle job is no longer current", "job_changed")
        job.update(changes)
        job["updated_at"] = utc_now()
        atomic_json(bundle_root() / "job.json", job)
        return job


def verify_installed_version_binding(reference: dict[str, Any]) -> None:
    version_path = bundle_root() / "packs" / reference["id"] / reference["version"]
    if not version_path.exists() and not version_path.is_symlink():
        return
    safe_directory(version_path.parent)
    for directory in installed_profile_directories(version_path):
        recovered: set[str] = set()
        for filename in ("meta.json", "index.json", "manifest.json"):
            try:
                raw = read_regular(directory / filename, STATE_MAX)
                value = parse_json_bytes(raw, "installed identity")
                if filename == "meta.json":
                    value = normalize_ref(value["reference"], "installed identity")
                elif filename == "manifest.json":
                    value = validate_manifest(value)
                    value["revision"] = sha256_bytes(raw)
                if value["id"] == reference["id"] and value["version"] == reference["version"]:
                    recovered.add(checked_hash(value["revision"], "installed revision"))
            except (BundleError, KeyError):
                continue
        if recovered != {reference["revision"]}:
            raise BundleError("an installed bundle version is immutable", "immutable_version")


def equivalent_selection_reference(reference: dict[str, Any], selection: dict[str, Any]) -> dict[str, Any] | None:
    version_path = bundle_root() / "packs" / reference["id"] / reference["version"]
    if not version_path.exists() and not version_path.is_symlink():
        return None
    try:
        active = load_state(missing_ok=True)["active"]
    except BundleError:
        active = None
    active_path = pack_directory(active) if active is not None and not active["included"] else None
    directories = installed_profile_directories(version_path)
    for directory in sorted(directories, key=lambda item: (item != active_path, item.name)):
        if directory == version_path:
            continue
        try:
            meta = read_json(directory / "meta.json", STATE_MAX)
            candidate = normalize_ref(meta["reference"], "installed bundle")
            if (pack_directory(candidate) != directory or candidate["revision"] != reference["revision"]
                    or "selection_revision" not in candidate
                    or (candidate["selection_revision"] == reference.get("selection_revision")
                        and directory != active_path)):
                continue
            receipt = load_selection(candidate, directory)
            if any(receipt[key] != selection[key] for key in ("mode", "manifest_sha256", "species")):
                continue
            validate_installed_pack(candidate, verify_hashes=True)
            return candidate
        except (BundleError, KeyError):
            continue
    return None


def install_pack(
    catalog: dict[str, Any], pack: dict[str, Any], job_id: str, *, all_species: bool = False,
    cached_manifest: bytes | None = None,
) -> dict[str, Any]:
    if pack["availability"] != "installable":
        raise BundleError("this bundle is not available to download", "not_installable")
    update_job(job_id, phase="downloading manifest", current=0, total=0, percent=1)
    manifest_raw = fetch_manifest(pack) if cached_manifest is None else cached_manifest
    manifest_hash = sha256_bytes(manifest_raw)
    manifest = validate_manifest(parse_json_bytes(manifest_raw, "manifest"))
    verify_catalog_manifest(pack, manifest, manifest_hash)
    basis = None if all_species else local_selection_basis()
    selection = selection_record(manifest, manifest_hash, basis)
    birds = [bird for bird in manifest["species"] if bird["scientific_name"] in selection["species"]]
    poses = [(bird, pose) for bird in birds for pose in bird["poses"]]
    total = len(poses)
    update_job(job_id, phase="checking illustrations", current=0, total=total, percent=2)
    reference = {
        "id": manifest["id"],
        "version": manifest["version"],
        "revision": manifest_hash,
        "included": False,
        "name": manifest["name"],
        "selection_revision": sha256_bytes(canonical_json(selection)),
    }
    verify_installed_version_binding(reference)
    equivalent = equivalent_selection_reference(reference, selection)
    if equivalent is not None:
        return equivalent
    final = pack_directory(reference)
    if (not final.exists() and final.parent.is_dir()
            and len(list(final.parent.iterdir())) >= 128):
        raise BundleError("too many installed local selections", "storage_limit")
    repair_existing = False
    if final.exists() or final.is_symlink():
        if final.is_symlink() or not final.is_dir():
            raise BundleError("installed bundle path is unsafe", "unsafe_storage")
        safe_directory(final.parent)
        safe_directory(final)
        recovered_revisions: set[str] = set()
        try:
            existing_meta = read_json(final / "meta.json", STATE_MAX)
            exact_keys(existing_meta, {"reference", "installed_at"}, set(), "installed metadata")
            existing_reference = normalize_ref(existing_meta["reference"], "installed bundle")
            if (
                existing_reference["id"] == reference["id"]
                and existing_reference["version"] == reference["version"]
                and not existing_reference["included"]
            ):
                recovered_revisions.add(existing_reference["revision"])
        except BundleError:
            pass
        try:
            existing_index = read_json(final / "index.json", STATE_MAX)
            existing_revision = checked_hash(existing_index.get("revision"), "installed revision")
            if (
                existing_index.get("id") == reference["id"]
                and existing_index.get("version") == reference["version"]
            ):
                recovered_revisions.add(existing_revision)
        except (BundleError, AttributeError):
            pass
        try:
            existing_manifest_raw = read_regular(final / "manifest.json", MANIFEST_MAX)
            existing_manifest = validate_manifest(
                parse_json_bytes(existing_manifest_raw, "installed manifest")
            )
            if (
                existing_manifest["id"] == reference["id"]
                and existing_manifest["version"] == reference["version"]
            ):
                recovered_revisions.add(sha256_bytes(existing_manifest_raw))
        except BundleError:
            pass
        if recovered_revisions != {reference["revision"]}:
            raise BundleError("an installed bundle version is immutable", "immutable_version")
        try:
            validate_installed_pack(reference, verify_hashes=True)
            return reference
        except BundleError:
            allowed = {"manifest.json", "index.json", "dims.json", "masks.json", "meta.json", "selection.json"}
            if any(
                item.name not in allowed or (item.is_dir() and not item.is_symlink())
                for item in final.iterdir()
            ):
                raise BundleError("installed bundle contains unsupported files", "invalid_install")
            repair_existing = True

    root = ensure_storage()
    stored_sizes = object_store_inventory(root)
    requested_sizes: dict[str, int] = {}
    for _, pose in poses:
        prior_size = requested_sizes.setdefault(pose["sha256"], pose["bytes"])
        if prior_size != pose["bytes"]:
            raise BundleError("manifest object sizes do not agree", "invalid_manifest")
    additional_bytes = sum(
        max(0, expected_size - stored_sizes.get(digest, 0))
        for digest, expected_size in requested_sizes.items()
    )
    if sum(stored_sizes.values()) + additional_bytes > OBJECT_STORE_MAX:
        raise BundleError("this bundle would exceed the station storage limit", "storage_limit")
    try:
        free_bytes = shutil.disk_usage(root).free
    except OSError as error:
        raise BundleError("station storage could not be checked", "storage_unavailable") from error
    if free_bytes < additional_bytes + FREE_SPACE_RESERVE:
        raise BundleError("there is not enough free space for this bundle", "storage_full")
    assets: dict[str, dict[str, dict[str, Any]]] = {}
    dims: dict[str, list[int]] = {}
    masks: dict[str, dict[str, Any]] = {}
    for number, (bird, pose) in enumerate(poses, start=1):
        digest = pose["sha256"]
        expected_size = pose["bytes"]
        stored = object_store_path(root, digest)
        stored_valid = stored.exists() and not stored.is_symlink()
        if stored_valid:
            try:
                raw = validate_stored_object(root, digest, expected_size, inspect=False)
            except BundleError:
                raw = fetch_object(catalog, digest, expected_size)
                stored_valid = False
        else:
            raw = fetch_object(catalog, digest, expected_size)
        slug = pose_slug(bird["scientific_name"], pose["id"])
        dims[slug], masks[slug] = mask_geometry(raw, slug)
        if not stored_valid:
            safe_directory(stored.parent, create=True)
            if stored.exists() and not stored.is_symlink() and not stored.is_file():
                raise BundleError("stored illustration path is unsafe", "unsafe_file")
            # atomic_bytes writes a sibling temporary file before replacing the
            # destination. A corrupt same-size cached object contributes no
            # final-size delta above, but still needs one full object's worth
            # of temporary space during that replacement.
            try:
                free_bytes = shutil.disk_usage(stored.parent).free
            except OSError as error:
                raise BundleError(
                    "station storage could not be checked", "storage_unavailable"
                ) from error
            if free_bytes < len(raw) + FREE_SPACE_RESERVE:
                raise BundleError(
                    "there is not enough free space for this bundle", "storage_full"
                )
            atomic_bytes(stored, raw)
        species_slug = scientific_slug(bird["scientific_name"])
        assets.setdefault(species_slug, {})[pose["id"]] = {
            "sha256": digest,
            "bytes": expected_size,
        }
        update_job(
            job_id,
            phase="checking illustrations",
            current=number,
            total=total,
            percent=max(2, min(82, round(number / total * 80))),
        )

    update_job(job_id, phase="preparing library", current=total, total=total, percent=86)
    staging = root / "staging" / f"{manifest['id']}.{manifest['version']}.{uuid.uuid4().hex}"
    staging.mkdir(mode=0o700)
    cleanup_staging = True
    try:
        atomic_bytes(staging / "manifest.json", manifest_raw)
        atomic_json(
            staging / "index.json",
            {
                "schema_version": 1,
                "id": reference["id"],
                "version": reference["version"],
                "revision": reference["revision"],
                "selection_revision": reference["selection_revision"],
                "assets": dict(sorted(assets.items())),
            },
        )
        atomic_json(staging / "dims.json", dims)
        atomic_json(staging / "masks.json", masks)
        atomic_json(staging / "selection.json", selection)
        installed_at = dt.datetime.now(dt.timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")
        atomic_json(staging / "meta.json", {"reference": reference, "installed_at": installed_at})
        os.chmod(staging, 0o755)
        # Prove the complete staged pack against the exact same parser used by
        # activation before any reader-visible directory is published. This
        # also enforces the bounded index and geometry-table sizes.
        validate_installed_pack(
            reference,
            verify_hashes=True,
            directory=staging,
        )
        id_parent = root / "packs" / reference["id"]
        safe_directory(id_parent, create=True)
        safe_directory(id_parent / reference["version"], create=True)
        safe_directory(final.parent, create=True)
        if repair_existing:
            safe_directory(final)
            exchange_directories(staging, final)
            cleanup_staging = False
            try:
                sync_exchanged_directories(staging, final)
                validate_installed_pack(reference, verify_hashes=True)
            except Exception:
                try:
                    exchange_directories(staging, final)
                    sync_exchanged_directories(staging, final)
                    cleanup_staging = True
                except (BundleError, OSError):
                    # The old directory remains at staging if rollback itself
                    # fails. Never delete it in that ambiguous state.
                    cleanup_staging = False
                raise
            else:
                # The old, damaged directory now occupies the unique staging
                # path and is safe to discard after the durable exchange.
                cleanup_staging = True
        elif final.exists() or final.is_symlink():
            if final.is_symlink() or validate_installed_pack(reference, verify_hashes=True)["reference"] != reference:
                raise BundleError("an installed bundle version is immutable", "immutable_version")
        else:
            os.rename(staging, final)
            fsync_directory(final.parent)
    finally:
        if cleanup_staging and staging.exists() and not staging.is_symlink():
            shutil.rmtree(staging)
    update_job(job_id, phase="ready", current=total, total=total, percent=92)
    return reference


def activate_reference(reference: dict[str, Any]) -> None:
    state = load_state()
    active = state["active"]
    if active == reference:
        return
    save_state(reference, active)


def activate_pack(
    pack_id: str,
    catalog: dict[str, Any],
    job_id: str | None = None,
    version: str | None = None,
) -> dict[str, Any]:
    if pack_id == BUILTIN_ID:
        if version is not None and checked_version(version) != BUILTIN_VERSION:
            raise BundleError("bundle version is no longer available", "version_mismatch")
        reference = builtin_ref()
    else:
        pack = next((item for item in catalog["packs"] if item["id"] == pack_id), None)
        wanted_version = checked_version(version) if version is not None else (
            pack["version"] if pack is not None else ""
        )
        if not wanted_version:
            raise BundleError("bundle is not in the trusted catalog", "unknown_bundle")
        installed = current_install(pack_id, wanted_version)
        if installed is None:
            raise BundleError("download this bundle before using it", "not_installed")
        reference = installed["reference"]
        try:
            validate_installed_pack(reference, verify_hashes=True)
        except BundleError:
            if job_id is None or pack is None or pack["version"] != wanted_version:
                raise
            reference = install_pack(catalog, pack, job_id)
    with locked():
        activate_reference(reference)
    return reference


def rollback_active() -> dict[str, Any]:
    state = load_state()
    previous = state["previous"]
    if previous is None:
        raise BundleError("there is no previous bundle to restore", "no_previous")
    if not previous["included"]:
        validate_runtime_reference(previous, verify_hashes=True)
    save_state(previous, state["active"])
    return previous


def remove_pack(pack_id: str) -> None:
    checked_id(pack_id)
    if pack_id == BUILTIN_ID:
        raise BundleError("the included bundle cannot be removed", "included_bundle")
    state = load_state()
    active = state["active"]
    previous = state["previous"]
    if active["id"] == pack_id:
        save_state(builtin_ref(), None)
    elif previous is not None and previous["id"] == pack_id:
        save_state(active, None)
    target = bundle_root() / "packs" / pack_id
    if target.exists() or target.is_symlink():
        if target.is_symlink() or not target.is_dir():
            raise BundleError("installed bundle path is unsafe", "unsafe_storage")
        shutil.rmtree(target)
        fsync_directory(target.parent)
    garbage_collect_objects()


def garbage_collect_objects() -> None:
    root = bundle_root()
    referenced: set[str] = set()
    state = load_state()
    for reference in (state["active"], state["previous"]):
        if reference is None or reference["included"]:
            continue
        index = load_index(reference)
        for poses in index["assets"].values():
            referenced.update(value["sha256"] for value in poses.values())

    # Inventory metadata is not needed to serve active art, but it is needed
    # to prove which inactive objects are reclaimable. If any remaining pack
    # directory cannot be fully validated, delete nothing.
    packs_root = root / "packs"
    safe_directory(packs_root)
    directory_count = 0
    try:
        for id_path in packs_root.iterdir():
            if (
                ID_RE.fullmatch(id_path.name) is None
                or not id_path.is_dir()
                or id_path.is_symlink()
            ):
                return
            safe_directory(id_path)
            for version_path in id_path.iterdir():
                if (
                    not version_path.is_dir()
                    or version_path.is_symlink()
                ):
                    return
                checked_version(version_path.name)
                safe_directory(version_path)
                directory_count += len(installed_profile_directories(version_path))
    except (BundleError, OSError):
        return

    records = installed_records()
    if len(records) != directory_count:
        return
    for item in records:
        index = load_index(item["reference"])
        for poses in index["assets"].values():
            referenced.update(value["sha256"] for value in poses.values())
    objects = root / "objects" / "sha256"
    if not objects.is_dir() or objects.is_symlink():
        return
    for prefix in list(objects.iterdir()):
        if not prefix.is_dir() or prefix.is_symlink() or not re.fullmatch(r"[0-9a-f]{2}", prefix.name):
            continue
        for candidate in list(prefix.iterdir()):
            match = re.fullmatch(r"([0-9a-f]{64})[.]png", candidate.name)
            if match and match.group(1) not in referenced and candidate.is_file() and not candidate.is_symlink():
                candidate.unlink()
        if not any(prefix.iterdir()):
            prefix.rmdir()


def heard_species() -> set[str]:
    path = database_path()
    if path is None or not path.is_file() or path.is_symlink():
        return set()
    try:
        connection = sqlite3.connect(f"file:{urllib.parse.quote(str(path))}?mode=ro", uri=True, timeout=1)
        try:
            rows = connection.execute("SELECT DISTINCT Sci_Name FROM detections LIMIT 12001").fetchall()
        finally:
            connection.close()
    except sqlite3.Error:
        return set()
    return {
        value
        for (value,) in rows
        if isinstance(value, str) and len(value) <= SCI_NAME_MAX and SCI_RE.fullmatch(value)
    }


def expected_species() -> set[str]:
    raw_path = os.environ.get("AVIAN_BUNDLE_EXPECTED")
    if not raw_path:
        return set()
    try:
        raw = read_regular(
            configured_path("AVIAN_BUNDLE_EXPECTED", raw_path),
            1024 * 1024,
            allow_writable=True,
            require_owner=False,
        )
        values = raw.decode("utf-8").splitlines()
    except (BundleError, UnicodeDecodeError):
        return set()
    output: set[str] = set()
    for line in values:
        name = line.strip()
        if name and not name.startswith("#") and SCI_RE.fullmatch(name):
            output.add(name)
    return output


def station_settings(*, strict: bool = False) -> dict[str, str]:
    path = config_path()
    if path is None:
        return {}
    if not path.exists() and not path.is_symlink() and station_runtime() is None:
        return {}
    try:
        path = path.resolve(strict=True)
        raw = read_regular(
            path,
            2 * 1024 * 1024,
            allow_writable=True,
            require_owner=False,
        ).decode("utf-8")
    except (BundleError, UnicodeDecodeError, OSError, RuntimeError) as error:
        if strict:
            raise BundleError("station location configuration is unavailable", "location_unavailable") from error
        return {}
    values: dict[str, str] = {}
    matcher = re.compile(r"^\s*(?:export\s+)?(LATITUDE|LONGITUDE|DATA_MODEL_VERSION|SF_THRESH)\s*=\s*([^#\s]+)\s*(?:#.*)?$")
    for line in raw.splitlines():
        match = matcher.fullmatch(line)
        if match:
            values[match.group(1)] = match.group(2).strip("\"'")
        elif strict and re.match(r"^\s*(?:export\s+)?(?:LATITUDE|LONGITUDE|DATA_MODEL_VERSION|SF_THRESH)\s*=", line):
            raise BundleError("station location configuration is invalid", "location_unavailable")
    return values


def station_coordinates() -> tuple[float, float] | None:
    values = station_settings()
    try:
        latitude = float(values["LATITUDE"])
        longitude = float(values["LONGITUDE"])
    except (KeyError, ValueError):
        return None
    if not -90 <= latitude <= 90 or not -180 <= longitude <= 180:
        return None
    # 0,0 is BirdNET-Pi's unset first-install sentinel, not a station match.
    if latitude == 0 and longitude == 0:
        return None
    return latitude, longitude


def station_list_species() -> set[str]:
    output: set[str] = set()
    for filename in ("include_species_list.txt", "whitelist_species_list.txt"):
        path = station_root() / filename
        if not path.is_file():
            continue
        try:
            raw = read_regular(path.resolve(strict=True), SELECTION_MAX, allow_writable=True, require_owner=False)
            for line in raw.decode("utf-8").splitlines():
                name = " ".join(line.split("_", 1)[0].split())
                if SCI_RE.fullmatch(name):
                    output.add(name)
        except (BundleError, OSError, UnicodeDecodeError):
            continue
    return output


def species_helper_output(command: list[str]) -> dict[str, Any]:
    environment = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "PYTHONDONTWRITEBYTECODE": "1"}
    child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, env=environment, cwd="/", start_new_session=True)
    assert child.stdout is not None
    output = bytearray()
    deadline = time.monotonic() + 45
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise BundleError("local bird lookup timed out", "location_unavailable")
            ready, _, _ = select.select([child.stdout], [], [], min(remaining, 1))
            if not ready:
                continue
            chunk = os.read(child.stdout.fileno(), min(65536, 2 * SELECTION_MAX + 1 - len(output)))
            if not chunk:
                break
            output.extend(chunk)
            if len(output) > 2 * SELECTION_MAX:
                raise BundleError("local bird lookup returned too much data", "location_unavailable")
        if child.wait(timeout=max(0.01, deadline - time.monotonic())) != 0:
            raise BundleError("local bird lookup failed", "location_unavailable")
        value = parse_json_bytes(bytes(output), "local birds")
        exact_keys(value, {"schema_version", "species", "basis_sha256"}, set(), "local birds")
        names = checked_string_list(value["species"], "local birds", 12000, SCI_NAME_MAX, SCI_RE)
        if value["schema_version"] != 1 or not names or names != sorted(names):
            raise BundleError("local bird lookup returned invalid species", "location_unavailable")
        checked_hash(value["basis_sha256"], "local bird basis")
        return value
    except (OSError, subprocess.TimeoutExpired) as error:
        raise BundleError("local bird lookup failed", "location_unavailable") from error
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
        child.wait()
        child.stdout.close()


def species_file_identity(path: Path) -> list[Any]:
    try:
        resolved = path.resolve(strict=True)
        info = resolved.stat()
    except (OSError, RuntimeError) as error:
        raise BundleError("station species model is unavailable", "location_unavailable") from error
    if not stat.S_ISREG(info.st_mode):
        raise BundleError("station species model is unsafe", "location_unavailable")
    return [str(resolved), info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns]


@contextlib.contextmanager
def selection_basis_lock() -> Iterable[None]:
    path = bundle_root() / "selection-basis.lock"
    flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags, 0o600)
    except OSError as error:
        raise BundleError("local bird lookup lock is unavailable", "unsafe_lock") from error
    try:
        info = os.fstat(descriptor)
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_mode & 0o077
                or info.st_uid != os.geteuid() or info.st_gid != os.getegid()):
            raise BundleError("local bird lookup lock is unsafe", "unsafe_lock")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise BundleError("local bird lookup is already running", "location_busy") from error
        yield
    finally:
        os.close(descriptor)


def local_selection_basis() -> dict[str, Any] | None:
    if os.environ.get("AVIAN_BUNDLE_EXPECTED"):
        names = sorted(expected_species())
        if not names:
            raise BundleError("configured local birds are unavailable", "location_unavailable")
        return {"schema_version": 1, "species": names,
                "basis_sha256": sha256_bytes(canonical_json({"species": names}))}
    settings = station_settings(strict=True)
    coordinates = station_coordinates()
    if coordinates is None:
        if ("LATITUDE" in settings or "LONGITUDE" in settings):
            try:
                unset = float(settings.get("LATITUDE", "nan")) == 0 and float(settings.get("LONGITUDE", "nan")) == 0
            except ValueError:
                unset = False
            if not unset:
                raise BundleError("station location is invalid", "location_unavailable")
        elif station_runtime() is not None and config_path() is None:
            raise BundleError("station location configuration is unavailable", "location_unavailable")
        return None
    runtime = station_runtime()
    if runtime is None:
        raise BundleError("station species lookup is not configured", "location_unavailable")
    try:
        model_version = int(settings.get("DATA_MODEL_VERSION", "2"))
        threshold = float(settings.get("SF_THRESH", "0.03"))
    except ValueError as error:
        raise BundleError("station species settings are invalid", "location_unavailable") from error
    if model_version not in {1, 2} or not 0 <= threshold <= 1:
        raise BundleError("station species settings are invalid", "location_unavailable")
    root = Path(runtime["root"])
    model_dir = root / "model"
    model = model_dir / ("BirdNET_GLOBAL_6K_V2.4_MData_Model_FP16.tflite" if model_version == 1
                         else "BirdNET_GLOBAL_6K_V2.4_MData_Model_V2_FP16.tflite")
    labels = model_dir / "BirdNET_GLOBAL_6K_V2.4_Model_FP16_Labels.txt"
    python = root / "birdnet" / "bin" / "python3"
    identities = [species_file_identity(path) for path in (model, labels, python)]
    helper_hash = sha256_bytes(read_regular(SPECIES_HELPER_PATH, SELECTION_MAX))
    extras = sorted(heard_species() | station_list_species())
    key = sha256_bytes(canonical_json({"coordinates": coordinates, "model_version": model_version,
                                      "threshold": threshold, "files": identities, "extras": extras,
                                      "helper_sha256": helper_hash}))
    ensure_storage()
    with selection_basis_lock():
        cache = bundle_root() / "selection-basis-v1.json"
        if cache.exists() or cache.is_symlink():
            try:
                value = read_json(cache, 2 * SELECTION_MAX)
                exact_keys(value, {"schema_version", "input_sha256", "species", "basis_sha256"}, set(), "local bird cache")
                names = checked_string_list(value["species"], "local birds", 12000, SCI_NAME_MAX, SCI_RE)
                checked_hash(value["basis_sha256"], "local bird basis")
                if value["schema_version"] == 1 and value["input_sha256"] == key and names and names == sorted(names):
                    return {name: value[name] for name in ("schema_version", "species", "basis_sha256")}
            except BundleError:
                pass
        account = runtime["account"]
        command = ["/usr/bin/setpriv", "--no-new-privs", "--reuid", str(account.pw_uid),
                   "--regid", str(account.pw_gid), "--clear-groups", "--bounding-set=-all",
                   "--inh-caps=-all", "--ambient-caps=-all", "--", str(python), "-I",
                   str(SPECIES_HELPER_PATH), "--latitude", str(coordinates[0]),
                   "--longitude", str(coordinates[1]), "--model-dir", str(model_dir),
                   "--model-version", str(model_version), "--threshold", str(threshold)]
        try:
            basis = species_helper_output(command)
        except OSError as error:
            raise BundleError("station species lookup is unavailable", "location_unavailable") from error
        if (station_coordinates() != coordinates or station_settings() != settings
                or [species_file_identity(path) for path in (model, labels, python)] != identities
                or sha256_bytes(read_regular(SPECIES_HELPER_PATH, SELECTION_MAX)) != helper_hash):
            raise BundleError("station location changed during local bird lookup", "location_changed")
        names = sorted(set(basis["species"]) | set(extras))
        result = {"schema_version": 1, "species": names,
                  "basis_sha256": sha256_bytes(canonical_json({"model": basis["basis_sha256"],
                                                               "extras": extras, "helper_sha256": helper_hash}))}
        atomic_json(cache, {**result, "input_sha256": key}, mode=0o600)
        return result


def selection_basis_response() -> dict[str, Any]:
    basis = local_selection_basis()
    return {"ok": True, **(basis if basis is not None else
            {"schema_version": 1, "species": None, "basis_sha256": None})}


def location_matches(group: str, coordinates: tuple[float, float] | None) -> bool:
    if group == "global":
        return True
    if coordinates is None:
        return False
    latitude, longitude = coordinates
    if group == "western-north-america":
        return 10 <= latitude <= 75 and -180 <= longitude <= -90
    if group == "north-america":
        return 5 <= latitude <= 84 and -180 <= longitude <= -50
    return False


def record_for_reference(reference: dict[str, Any], catalog: dict[str, Any]) -> dict[str, Any]:
    pack = next((item for item in catalog["packs"] if item["id"] == reference["id"]), None)
    if not reference["included"]:
        count = len(load_index(reference)["assets"])
    elif pack is not None and pack["version"] == reference["version"]:
        count = pack["species_count"]
    elif reference["included"]:
        count = 333
    else:
        count = len(load_index(reference)["assets"])
    return {**reference, "species_count": count}


def load_job() -> dict[str, Any] | None:
    path = bundle_root() / "job.json"
    if not path.exists() and not path.is_symlink():
        return None
    job = read_json(path, 64 * 1024)
    required = {
        "schema_version", "id", "operation", "bundle_id", "bundle_version", "activate", "state", "phase",
        "current", "total", "percent", "error", "created_at", "updated_at",
    }
    exact_keys(job, required, {"all_species"}, "bundle job")
    operation = job["operation"]
    state = job["state"]
    bundle_id = job["bundle_id"]
    version = job["bundle_version"]
    if (
        job["schema_version"] != 1
        or not isinstance(job["id"], str)
        or re.fullmatch(r"[0-9a-f]{32}", job["id"]) is None
        or not isinstance(operation, str)
        or operation not in ACTIONS
        or not isinstance(state, str)
        or state not in {"queued", "running", "complete", "failed"}
        or not isinstance(job["activate"], bool)
        or not isinstance(job.get("all_species", False), bool)
        or not isinstance(bundle_id, str)
        or not isinstance(version, str)
        or not isinstance(job["phase"], str)
        or not job["phase"]
        or len(job["phase"]) > 80
        or not isinstance(job["error"], str)
        or len(job["error"]) > 260
        or not isinstance(job["created_at"], str)
        or not isinstance(job["updated_at"], str)
    ):
        raise BundleError("bundle job state is invalid", "invalid_job")
    if operation in {"rollback", "refresh"}:
        if bundle_id or version or job["activate"]:
            raise BundleError("bundle job state is invalid", "invalid_job")
    else:
        try:
            checked_id(bundle_id)
            checked_version(version)
        except BundleError as error:
            raise BundleError("bundle job state is invalid", "invalid_job") from error
        if operation in {"use", "activate", "remove"} and job["activate"]:
            raise BundleError("bundle job state is invalid", "invalid_job")
    if job.get("all_species", False) and operation not in {"use", "install", "update"}:
        raise BundleError("bundle job state is invalid", "invalid_job")
    for field in ("created_at", "updated_at"):
        try:
            dt.datetime.strptime(job[field], "%Y-%m-%dT%H:%M:%SZ")
        except ValueError as error:
            raise BundleError("bundle job state is invalid", "invalid_job") from error
    for field in ("current", "total", "percent"):
        if isinstance(job[field], bool) or not isinstance(job[field], int) or job[field] < 0:
            raise BundleError("bundle job progress is invalid", "invalid_job")
    if job["percent"] > 100 or (job["total"] and job["current"] > job["total"]):
        raise BundleError("bundle job progress is invalid", "invalid_job")
    return job


def normalized_job(job: dict[str, Any] | None) -> dict[str, Any] | None:
    if job is None:
        return None
    return {
        "id": job["id"],
        "operation": job["operation"],
        "pack_id": job["bundle_id"],
        "version": job["bundle_version"],
        "activate_on_success": job["activate"],
        "state": "running" if job["state"] in {"queued", "running"} else (
            "succeeded" if job["state"] == "complete" else "failed"
        ),
        "phase": job["phase"],
        "current": job["current"],
        "total": job["total"],
        "percent": job["percent"],
        "error": job["error"],
        "created_at": job["created_at"],
        "updated_at": job["updated_at"],
    }


def snapshot() -> dict[str, Any]:
    ensure_storage()
    with locked(exclusive=False):
        catalog = load_catalog()
        state = load_state()
        installed = installed_records()
        job = load_job()
    installed_by_id: dict[str, list[dict[str, Any]]] = {}
    for item in installed:
        installed_by_id.setdefault(item["reference"]["id"], []).append(item)
    expected = expected_species()
    heard = heard_species()
    basis = expected if expected else heard
    scope = "expected" if expected else ("heard" if heard else "")
    coordinates = station_coordinates()
    packs: list[dict[str, Any]] = []
    for pack in catalog["packs"]:
        available_species = set(pack["species"])
        covered = len(basis & available_species) if basis else None
        versions = installed_by_id.get(pack["id"], [])
        installed_versions = sorted(
            {item["reference"]["version"] for item in versions},
            key=installed_version_key,
        )
        activation_item = (
            max(
                versions,
                key=lambda item: installed_version_key(item["reference"]["version"]),
            )
            if versions else None
        )
        activation_version = (
            BUILTIN_VERSION
            if pack["availability"] == "included"
            else (
                activation_item["reference"]["version"]
                if activation_item is not None else None
            )
        )
        activation_presentation = (
            installed_activation_presentation(
                activation_item,
                coverage_group=pack["coverage"]["group"],
                review=pack["review"],
            )
            if activation_item is not None else None
        )
        active = state["active"]["id"] == pack["id"]
        active_current = active and state["active"]["version"] == pack["version"]
        installed_current = any(item["reference"]["version"] == pack["version"] for item in versions)
        installed_any = bool(versions) or pack["availability"] == "included"
        preview_values = []
        for index, preview in enumerate(pack["previews"]):
            preview_values.append(
                {
                    "url": f"/avian/api/bundle-preview.php?id={urllib.parse.quote(pack['id'])}&index={index}",
                    "scientific_name": preview["scientific_name"],
                    "common_name": preview["common_name"],
                    "pose": 2 if preview["pose"] == "flight" else 1,
                }
            )
        packs.append(
            {
                **pack,
                "source_url": pack["repository_url"],
                "bytes": pack["archive_bytes"],
                "previews": preview_values,
                "included": pack["availability"] == "included",
                "installed": installed_any,
                "installed_current": installed_current or pack["availability"] == "included",
                "installed_versions": installed_versions,
                "activation_version": activation_version,
                "activation_presentation": activation_presentation,
                "active": active,
                "active_current": active_current,
                "active_version": state["active"]["version"] if active else "",
                "catalog_current": True,
                "update_available": installed_any and not installed_current and pack["availability"] == "installable",
                "matches_station": True if active else (
                    location_matches(pack["coverage"]["group"], coordinates)
                    or (covered is not None and covered > 0)
                    if coordinates is not None or basis else None
                ),
                "coverage_scope": scope or None,
                "covered_count": covered,
                "coverage_total": len(basis) if basis else None,
            }
        )
    # A verified installed pack remains locally manageable if its community
    # listing is temporarily unavailable or intentionally delisted. It is not
    # installable or updatable without the feed, and no remote metadata is
    # invented. The immutable installed manifest supplies the display facts.
    catalog_ids = {pack["id"] for pack in catalog["packs"]}
    for pack_id, versions in installed_by_id.items():
        if pack_id in catalog_ids:
            continue
        active = state["active"]["id"] == pack_id
        item = next(
            (
                candidate for candidate in versions
                if active
                and candidate["reference"]["version"] == state["active"]["version"]
            ),
            max(
                versions,
                key=lambda candidate: installed_version_key(
                    candidate["reference"]["version"]
                ),
            ),
        )
        reference = item["reference"]
        try:
            manifest_raw = read_regular(
                pack_directory(reference) / "manifest.json", MANIFEST_MAX
            )
            manifest = validate_manifest(
                parse_json_bytes(manifest_raw, "installed manifest")
            )
        except BundleError:
            continue
        available_species = {
            bird["scientific_name"] for bird in manifest["species"]
        }
        covered = len(basis & available_species) if basis else None
        installed_versions = sorted(
            {candidate["reference"]["version"] for candidate in versions},
            key=installed_version_key,
        )
        activation_item = max(
            versions,
            key=lambda candidate: installed_version_key(
                candidate["reference"]["version"]
            ),
        )
        packs.append(
            {
                "id": reference["id"],
                "version": reference["version"],
                "name": manifest["name"],
                "description": manifest["description"],
                "creator": manifest["attribution"]["creator"],
                "repository_url": manifest["attribution"]["source_url"],
                "source_url": manifest["attribution"]["source_url"],
                "coverage": {
                    "label": manifest["coverage"]["label"],
                    "group": "global" if manifest["coverage"]["type"] == "global" else "unlisted",
                    "region_codes": manifest["coverage"]["region_codes"],
                },
                "style": {
                    "id": manifest["style"]["id"],
                    "name": manifest["style"]["name"],
                    "category": "Illustrated",
                    "tags": [],
                },
                "species_count": manifest["species_count"],
                "species": sorted(available_species),
                "pose_count": manifest["pose_count"],
                "review": "community",
                "license": manifest["license"]["spdx"],
                "availability": "unavailable",
                "bytes": manifest["total_bytes"],
                "archive_bytes": manifest["total_bytes"],
                "previews": [],
                "included": False,
                "installed": True,
                "installed_current": True,
                "installed_versions": installed_versions,
                "activation_version": installed_versions[-1],
                "activation_presentation": installed_activation_presentation(
                    activation_item,
                    coverage_group=(
                        "global"
                        if activation_item["coverage"]["type"] == "global"
                        else "unlisted"
                    ),
                    review="community",
                ),
                "active": active,
                "active_current": active and state["active"]["version"] == reference["version"],
                "active_version": state["active"]["version"] if active else "",
                "catalog_current": False,
                "update_available": False,
                "matches_station": True if active else (
                    covered > 0 if covered is not None else None
                ),
                "coverage_scope": scope or None,
                "covered_count": covered,
                "coverage_total": len(basis) if basis else None,
            }
        )
    installed_output = [
        {**item["reference"], "species_count": item["species_count"], "installed_at": item["installed_at"]}
        for item in installed
    ]
    if not any(item["id"] == BUILTIN_ID for item in installed_output):
        built = next((pack for pack in catalog["packs"] if pack["id"] == BUILTIN_ID), None)
        installed_output.insert(0, {**builtin_ref(), "species_count": built["species_count"] if built else 333})
    refresh_failed = bool(
        job is not None and job["operation"] == "refresh" and job["state"] == "failed"
    )
    return {
        "ok": True,
        "catalog": {
            "updated": catalog["updated"],
            "catalog_url": CATALOG_URL,
            "packs": packs,
            "stale": refresh_failed,
            "error": job["error"] if refresh_failed else None,
        },
        "library": {
            "active": record_for_reference(state["active"], catalog),
            "previous": None if state["previous"] is None else record_for_reference(state["previous"], catalog),
            "installed": installed_output,
        },
        "job": normalized_job(job),
    }


def job_running(job: dict[str, Any]) -> bool:
    if job["state"] not in {"queued", "running"}:
        return False
    try:
        updated = dt.datetime.fromisoformat(job["updated_at"].replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return True
    return (dt.datetime.now(dt.timezone.utc) - updated).total_seconds() <= JOB_STALE_SECONDS


def use_target(catalog: dict[str, Any], pack_id: str, version: str = "") -> tuple[dict[str, Any], bytes | None]:
    if pack_id == BUILTIN_ID:
        return catalog_pack(catalog, pack_id), None
    installed = current_install(pack_id, version or None)
    if installed is None:
        pack = catalog_pack(catalog, pack_id)
        if version and pack["version"] != version:
            raise BundleError("bundle version is no longer available", "version_mismatch")
        return pack, None
    reference = installed["reference"]
    raw = read_regular(pack_directory(reference) / "manifest.json", MANIFEST_MAX)
    if sha256_bytes(raw) != reference["revision"]:
        raise BundleError("installed manifest revision is invalid", "invalid_install")
    manifest = validate_manifest(parse_json_bytes(raw, "installed manifest"))
    listed = next((item for item in catalog["packs"] if item["id"] == pack_id), None)
    if (listed is not None and listed["version"] == reference["version"]
            and listed["manifest"]["sha256"] != reference["revision"]):
        raise BundleError("an installed bundle version is immutable", "immutable_version")
    return {
        "id": reference["id"], "version": reference["version"],
        "name": manifest["name"], "description": manifest["description"],
        "creator": manifest["attribution"]["creator"], "style": manifest["style"],
        "coverage": {"label": manifest["coverage"]["label"],
                     "region_codes": manifest["coverage"]["region_codes"],
                     "group": "global" if manifest["coverage"]["type"] == "global" else "other"},
        "species_count": manifest["species_count"],
        "species": [bird["scientific_name"] for bird in manifest["species"]],
        "archive_bytes": manifest["total_bytes"], "license": manifest["license"]["spdx"],
        "manifest": {"sha256": reference["revision"], "bytes": len(raw),
                     "url": MANIFEST_BASE_URL + reference["revision"] + ".json"},
        "previews": [], "availability": "installable",
    }, raw


def enqueue(
    action: str,
    pack_id: str,
    version: str,
    activate: bool,
    *,
    expected_version: str = "",
    expected_revision: str = "",
    all_species: bool = False,
) -> dict[str, Any]:
    if action not in ACTIONS:
        raise BundleError("bundle action is invalid", "invalid_action")
    if not isinstance(all_species, bool) or (all_species and action not in {"use", "install", "update"}):
        raise BundleError("bundle selection is invalid", "invalid_action")
    ensure_storage()
    with locked():
        catalog = load_catalog()
        existing = load_job()
        if existing is not None and job_running(existing):
            raise BundleError("another bundle operation is still running", "job_running")
        state = load_state()
        if action in {"rollback", "refresh"}:
            if pack_id or version or activate:
                raise BundleError("this action does not accept a bundle id", "invalid_action")
            if action == "rollback" and state["previous"] is None:
                raise BundleError("there is no previous bundle to restore", "no_previous")
        else:
            listed_pack = next(
                (item for item in catalog["packs"] if item["id"] == pack_id), None
            )
            if action in {"use", "install", "update"} and version:
                raise BundleError("install resolves the current trusted version", "invalid_action")
            if action == "use" and activate:
                raise BundleError("use does not accept an activation flag", "invalid_action")
            if action in {"use", "install", "update"}:
                pack = use_target(catalog, pack_id, expected_version)[0] if action == "use" else catalog_pack(catalog, pack_id)
                if expected_version and pack["version"] != checked_version(expected_version):
                    raise BundleError(
                        "bundle version changed before the operation was queued",
                        "version_mismatch",
                    )
                if (
                    expected_revision
                    and pack["manifest"]["sha256"]
                    != checked_hash(expected_revision, "expected manifest SHA-256")
                ):
                    raise BundleError(
                        "bundle manifest changed before the operation was queued",
                        "version_mismatch",
                    )
                if pack["availability"] != "installable" and not (action == "use" and pack["availability"] == "included"):
                    raise BundleError("this bundle is not available to download", "not_installable")
                installed = current_install(pack_id, pack["version"])
                if action == "install" and installed is not None:
                    raise BundleError("this bundle is already installed", "already_installed")
                if action == "update" and installed is not None:
                    raise BundleError("this bundle is already current", "already_current")
            elif action == "activate":
                wanted_version = checked_version(version)
                if pack_id == BUILTIN_ID:
                    if wanted_version != BUILTIN_VERSION:
                        raise BundleError("bundle version is no longer available", "version_mismatch")
                elif current_install(pack_id, wanted_version) is None:
                    raise BundleError("download this bundle before using it", "not_installed")
                if activate:
                    raise BundleError("activate does not accept an activation flag", "invalid_action")
            elif action == "remove":
                wanted_version = checked_version(version)
                if pack_id == BUILTIN_ID:
                    raise BundleError("the included bundle cannot be removed", "included_bundle")
                if listed_pack is not None and wanted_version != listed_pack["version"]:
                    raise BundleError("bundle version is no longer current", "version_mismatch")
                installed = current_install(
                    pack_id, wanted_version if listed_pack is None else None
                )
                if installed is None:
                    raise BundleError("this bundle is not installed", "not_installed")
                if activate:
                    raise BundleError("remove does not accept an activation flag", "invalid_action")
            resolved_version = pack["version"] if action in {"use", "install", "update"} else wanted_version
        if action in {"rollback", "refresh"}:
            resolved_version = ""
        now = utc_now()
        total = 0 if action in {"use", "install", "update"} else 1
        job = {
            "schema_version": 1,
            "id": uuid.uuid4().hex,
            "operation": action,
            "bundle_id": pack_id,
            "bundle_version": resolved_version,
            "activate": activate,
            "all_species": all_species,
            "state": "queued",
            "phase": "queued",
            "current": 0,
            "total": total,
            "percent": 0,
            "error": "",
            "created_at": now,
            "updated_at": now,
        }
        atomic_json(bundle_root() / "job.json", job)
    log_path = bundle_root() / "operation.log"
    log_flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT
    if hasattr(os, "O_NOFOLLOW"):
        log_flags |= os.O_NOFOLLOW
    try:
        log_descriptor = os.open(log_path, log_flags, 0o640)
    except OSError as error:
        update_job(job["id"], state="failed", phase="failed", error="Could not open the bundle log.")
        raise BundleError("bundle operation log is unsafe", "unsafe_log") from error
    try:
        before = log_path.lstat()
        opened = os.fstat(log_descriptor)
        if (
            not stat.S_ISREG(opened.st_mode)
            or stat.S_ISLNK(before.st_mode)
            or opened.st_nlink != 1
            or opened.st_mode & 0o022
            or opened.st_uid != os.geteuid()
            or opened.st_gid != os.getegid()
            or opened.st_dev != before.st_dev
            or opened.st_ino != before.st_ino
        ):
            raise BundleError("bundle operation log is unsafe", "unsafe_log")
        os.ftruncate(log_descriptor, 0)
        os.fsync(log_descriptor)
        worker_environment = {
            "PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
            **{
                key: value
                for key, value in os.environ.items()
                if key.startswith("AVIAN_BUNDLE_")
            },
        }
        subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), "run-job", "--job-id", job["id"]],
            stdin=subprocess.DEVNULL,
            stdout=log_descriptor,
            stderr=log_descriptor,
            close_fds=True,
            start_new_session=True,
            env=worker_environment,
        )
    except OSError as error:
        update_job(job["id"], state="failed", phase="failed", error="Could not start the bundle operation.")
        raise BundleError("could not start bundle operation", "worker_failed") from error
    except BundleError:
        update_job(job["id"], state="failed", phase="failed", error="The bundle operation log is unsafe.")
        raise
    finally:
        os.close(log_descriptor)
    return {"ok": True, "job": normalized_job(job)}


def wait_for_job(job_id: str) -> dict[str, Any]:
    """Wait for one exact detached operation without following replacement state."""
    if not isinstance(job_id, str) or re.fullmatch(r"[0-9a-f]{32}", job_id) is None:
        raise BundleError("bundle job id is invalid", "invalid_job")
    deadline = time.monotonic() + USE_WAIT_SECONDS
    while time.monotonic() < deadline:
        with locked(exclusive=False):
            job = load_job()
        if job is None or job["id"] != job_id:
            raise BundleError("bundle operation was replaced", "job_changed")
        if job["state"] == "complete":
            return job
        if job["state"] == "failed":
            raise BundleError(
                job["error"] or "bundle operation failed",
                "operation_failed",
            )
        time.sleep(USE_POLL_SECONDS)
    raise BundleError("bundle operation timed out", "operation_timeout")


def use_selector(selector: str, *, all_species: bool = False) -> dict[str, Any]:
    """Refresh trust data, install if needed, and atomically activate a bundle."""
    ensure_storage()
    catalog = refresh_catalog()
    if ID_RE.fullmatch(selector):
        pack, _ = use_target(catalog, selector)
    else:
        pack = resolve_use_selector(catalog, selector)
    if pack["availability"] == "included":
        expected = builtin_ref()
    else:
        basis = None if all_species else local_selection_basis()
        selection = selection_record(
            {"species": [{"scientific_name": name} for name in pack["species"]]},
            pack["manifest"]["sha256"], basis,
        )
        expected = {"id": pack["id"], "version": pack["version"],
                    "revision": pack["manifest"]["sha256"], "included": False,
                    "name": pack["name"], "selection_revision": sha256_bytes(canonical_json(selection))}
        expected = equivalent_selection_reference(expected, selection) or expected

    with locked(exclusive=False):
        state = load_state()
        previous_active = state["active"]
        if state["active"] == expected:
            if not expected["included"]:
                validate_runtime_reference(expected, verify_hashes=True)
            return {
                "ok": True,
                "changed": False,
                "bundle": expected,
            }

    queued = enqueue("use", pack["id"], "", False,
                     expected_version=pack["version"], expected_revision=pack["manifest"]["sha256"],
                     all_species=all_species)
    job = queued["job"]
    if job is None:
        raise BundleError("bundle operation did not start", "worker_failed")
    wait_for_job(job["id"])

    with locked(exclusive=False):
        state = load_state()
        active = state["active"]
        if any(active[key] != expected[key] for key in ("id", "version", "revision")):
            raise BundleError(
                "bundle activation did not publish the expected revision",
                "activation_mismatch",
            )
        if not active["included"]:
            validate_runtime_reference(active, verify_hashes=True)
    return {
        "ok": True,
        "changed": active != previous_active,
        "bundle": active,
    }


def run_job(job_id: str) -> None:
    try:
        with locked():
            job = load_job()
            if job is None or job["id"] != job_id or job["state"] != "queued":
                raise BundleError("bundle job is no longer queued", "job_changed")
            job.update({"state": "running", "phase": "starting", "updated_at": utc_now()})
            atomic_json(bundle_root() / "job.json", job)
        catalog = load_catalog()
        operation = job["operation"]
        pack_id = job["bundle_id"]
        if operation in {"use", "install", "update"}:
            selected_pack, cached_manifest = (use_target(catalog, pack_id, job["bundle_version"])
                                             if operation == "use" else (catalog_pack(catalog, pack_id), None))
            if selected_pack["version"] != job["bundle_version"]:
                raise BundleError("bundle version changed before download", "version_mismatch")
            reference = (builtin_ref() if selected_pack["availability"] == "included" else
                         install_pack(catalog, selected_pack, job_id, all_species=job.get("all_species", False),
                                      cached_manifest=cached_manifest))
            if job["activate"] or operation == "use":
                update_job(job_id, phase="activating", percent=96)
                with locked():
                    activate_reference(reference)
        elif operation == "activate":
            update_job(job_id, phase="activating", current=0, total=1, percent=20)
            activate_pack(pack_id, catalog, job_id, job["bundle_version"])
        elif operation == "remove":
            update_job(job_id, phase="removing", current=0, total=1, percent=20)
            with locked():
                remove_pack(pack_id)
        elif operation == "rollback":
            update_job(job_id, phase="restoring", current=0, total=1, percent=20)
            with locked():
                rollback_active()
        elif operation == "refresh":
            update_job(job_id, phase="checking catalog", current=0, total=1, percent=20)
            refresh_catalog()
        latest = load_job()
        if latest is None or latest["id"] != job_id:
            raise BundleError("bundle job is no longer current", "job_changed")
        update_job(
            job_id,
            state="complete",
            phase="complete",
            current=latest["total"],
            percent=100,
            error="",
        )
    except BundleError as error:
        try:
            update_job(job_id, state="failed", phase="failed", error=str(error))
        except BundleError:
            pass
        try:
            with locked():
                garbage_collect_objects()
        except (BundleError, OSError):
            # Preserve the original operation error. Garbage collection is
            # fail-closed and can be retried by a later successful mutation.
            pass
        raise
    except Exception as error:
        try:
            update_job(job_id, state="failed", phase="failed", error="The bundle operation failed validation.")
        except BundleError:
            pass
        try:
            with locked():
                garbage_collect_objects()
        except (BundleError, OSError):
            pass
        raise BundleError("bundle operation failed", "worker_failed") from error


def preview_bytes(pack_id: str, index: int) -> bytes:
    if index < 0 or index >= PREVIEWS_MAX:
        raise BundleError("preview index is invalid", "invalid_preview")
    ensure_storage()
    catalog = load_catalog()
    pack = catalog_pack(catalog, pack_id)
    if index >= len(pack["previews"]):
        raise BundleError("preview is not available", "invalid_preview")
    preview = pack["previews"][index]
    root = bundle_root()
    path = object_store_path(root, preview["sha256"])
    with locked():
        if path.exists() and not path.is_symlink():
            raw = validate_stored_object(root, preview["sha256"], preview["bytes"])
        else:
            raw = fetch_object(catalog, preview["sha256"], preview["bytes"])
            mask_geometry(raw, preview["sha256"])
            # Browsing must not grow persistent station storage. Installed
            # pack objects may be reused above, but remote-only previews stay
            # in the HTTP/browser cache and are never written to the store.
    return raw


def initialize() -> dict[str, Any]:
    ensure_storage()
    with locked():
        load_catalog()
        state = load_state(missing_ok=True)
        if not (bundle_root() / "active.json").exists():
            save_state(state["active"], state["previous"])
    return {"ok": True, "active": state["active"]}


def emit_json(value: Any) -> None:
    sys.stdout.buffer.write(canonical_json(value))


def inspect_png_command(label: str) -> dict[str, Any]:
    checked_label = clean_text(label, POSE_SLUG_MAX, "image label")
    raw = sys.stdin.buffer.read(IMAGE_MAX + 1)
    if not raw or len(raw) > IMAGE_MAX or sys.stdin.buffer.read(1):
        raise BundleError("illustration size is invalid", "invalid_size")
    dimensions, mask = local_mask_geometry(raw, checked_label)
    return {"dimensions": dimensions, "mask": mask}


def parser() -> argparse.ArgumentParser:
    arguments = argparse.ArgumentParser(description=__doc__)
    commands = arguments.add_subparsers(dest="command", required=True)
    snapshot_parser = commands.add_parser("snapshot")
    snapshot_parser.add_argument("--json", action="store_true", required=True)
    basis_parser = commands.add_parser("selection-basis")
    basis_parser.add_argument("--json", action="store_true", required=True)
    configure_parser = commands.add_parser("configure-station")
    configure_parser.add_argument("--user", required=True)
    configure_parser.add_argument("--root", required=True)
    configure_parser.add_argument("--json", action="store_true", required=True)
    enqueue_parser = commands.add_parser("enqueue")
    enqueue_parser.add_argument("--action", required=True, choices=sorted(ACTIONS))
    enqueue_parser.add_argument("--id", default="")
    enqueue_parser.add_argument("--version", default="")
    enqueue_parser.add_argument("--activate", action="store_true")
    enqueue_parser.add_argument("--all-species", action="store_true")
    enqueue_parser.add_argument("--json", action="store_true", required=True)
    preview_parser = commands.add_parser("preview")
    preview_parser.add_argument("--id", required=True)
    preview_parser.add_argument("--index", required=True, type=int)
    run_parser = commands.add_parser("run-job")
    run_parser.add_argument("--job-id", required=True)
    initialize_parser = commands.add_parser("initialize")
    initialize_parser.add_argument("--json", action="store_true", required=True)
    inspect_parser = commands.add_parser("inspect-png")
    inspect_parser.add_argument("--label", required=True)
    use_parser = commands.add_parser(
        "use",
        help="install and activate a trusted bundle by id or exact install-manifest URL",
    )
    use_parser.add_argument("selector")
    use_parser.add_argument("--all-species", action="store_true", help="install every bird in the bundle")
    use_parser.add_argument("--json", action="store_true")
    return arguments


def main() -> int:
    arguments = parser().parse_args()
    try:
        sudo_user = os.environ.get("SUDO_USER", "")
        if sudo_user:
            if arguments.command == "use":
                if sudo_user == "caddy":
                    raise BundleError(
                        "this bundle command is not available to the web process",
                        "forbidden",
                    )
            elif sudo_user != "caddy" or arguments.command not in {"snapshot", "enqueue", "preview", "selection-basis"}:
                raise BundleError("this bundle command is not available through sudo", "forbidden")
            if any(key.startswith("AVIAN_BUNDLE_") for key in os.environ):
                raise BundleError("bundle path overrides are not allowed through sudo", "forbidden")
        if arguments.command == "use" and os.geteuid() != 0:
            raise BundleError("run this command with sudo", "root_required")
        if arguments.command == "snapshot":
            emit_json(snapshot())
        elif arguments.command == "selection-basis":
            emit_json(selection_basis_response())
        elif arguments.command == "configure-station":
            emit_json(configure_station(arguments.user, arguments.root))
        elif arguments.command == "enqueue":
            emit_json(enqueue(arguments.action, arguments.id, arguments.version, arguments.activate,
                              all_species=arguments.all_species))
        elif arguments.command == "preview":
            sys.stdout.buffer.write(preview_bytes(arguments.id, arguments.index))
        elif arguments.command == "run-job":
            run_job(arguments.job_id)
        elif arguments.command == "initialize":
            emit_json(initialize())
        elif arguments.command == "inspect-png":
            emit_json(inspect_png_command(arguments.label))
        elif arguments.command == "use":
            result = use_selector(arguments.selector, all_species=arguments.all_species)
            if arguments.json:
                emit_json(result)
            else:
                bundle = result["bundle"]
                verb = "Already using" if not result["changed"] else "Now using"
                print(f"{verb} {bundle['name']} ({bundle['id']}@{bundle['version']}).")
        return 0
    except BundleError as error:
        if arguments.command in {"snapshot", "enqueue", "initialize", "inspect-png", "selection-basis", "configure-station"} or (
            arguments.command == "use" and arguments.json
        ):
            emit_json({"ok": False, "error": str(error), "code": error.code})
        else:
            print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
