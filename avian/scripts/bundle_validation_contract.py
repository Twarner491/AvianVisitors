#!/usr/bin/env python3
"""Hosted bundle manifest and PNG validation contract.

This code is intentionally separate from the station bundle manager. Hosted
review accepts both the strict producer format and the legacy consumer format,
while the station manager normalizes only verified published manifests.
"""
from __future__ import annotations

import re
import struct
import urllib.parse
import zlib
from pathlib import Path


PACK_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,79}$")
VERSION = re.compile(
    r"(?=.{1,40}\Z)"
    r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
    r"(?:-(?:"
    r"(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)"
    r")(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
)
LEGACY_VERSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$")
SCI_NAME = re.compile(r"^[A-Z][A-Za-z-]{1,39}(?: [a-z][A-Za-z-]{1,39}){1,3}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
LICENSE_FILE = re.compile(r"^LICENSES/[A-Za-z0-9._-]{1,100}\.txt$")
MAX_MANIFEST_BYTES = 4 * 1024 * 1024
MAX_OBJECT_BYTES = 4 * 1024 * 1024
MAX_TOTAL_BYTES = 1024 * 1024 * 1024
MAX_SPECIES = 5000
MAX_OBJECTS = 10000
MAX_IMAGE_SIDE = 4096
MAX_IMAGE_PIXELS = 16_000_000


class BundleError(RuntimeError):
    pass


def only_keys(value: dict, allowed: set[str], label: str) -> None:
    unknown = set(value) - allowed
    if unknown:
        raise BundleError(f"{label} contains unsupported fields")


def validate_artwork_metadata(data: dict, producer_contract: bool = False) -> None:
    only_keys(data, {
        "format", "format_version", "id", "version", "name", "description",
        "style", "coverage", "species", "license", "attribution", "provenance",
    }, "manifest")
    if "description" in data and (
        not isinstance(data["description"], str) or len(data["description"]) > 260
    ):
        raise BundleError("manifest description is invalid")
    style = data.get("style")
    if not isinstance(style, dict):
        raise BundleError("manifest style is required")
    only_keys(style, {"id", "name"}, "style")
    style_id = style.get("id")
    if producer_contract:
        style_id_invalid = not isinstance(style_id, str) or not PACK_ID.fullmatch(style_id)
    else:
        style_id_invalid = not PACK_ID.fullmatch(str(style_id))
    if style_id_invalid or not str(style.get("name", "")).strip():
        raise BundleError("manifest style is invalid")
    coverage = data.get("coverage")
    if not isinstance(coverage, dict):
        raise BundleError("manifest coverage is required")
    only_keys(coverage, {"type", "label", "region_codes"}, "coverage")
    if coverage.get("type") not in {"region", "global", "selection"}:
        raise BundleError("manifest coverage type is invalid")
    coverage_type = coverage.get("type")
    if producer_contract and "region_codes" not in coverage:
        raise BundleError("manifest region codes are required")
    codes = coverage.get("region_codes", [])
    if not isinstance(codes, list) or len(codes) > 32 or any(
        not isinstance(code, str) or not re.fullmatch(r"[A-Z]{2}(?:-[A-Z0-9]{1,8}){0,3}", code)
        for code in codes
    ) or len(set(codes)) != len(codes):
        raise BundleError("manifest region codes are invalid")
    if producer_contract and (
        (coverage_type == "region" and not codes)
        or (coverage_type == "global" and codes)
    ):
        raise BundleError("manifest coverage type and region codes do not agree")
    license_data = data.get("license")
    attribution = data.get("attribution")
    if not isinstance(license_data, dict) or not isinstance(attribution, dict):
        raise BundleError("manifest license and attribution are required")
    only_keys(license_data, {"spdx", "file"}, "license")
    only_keys(attribution, {"creator", "source_url"}, "attribution")
    if not re.fullmatch(r"[A-Za-z0-9.+-]{2,80}", str(license_data.get("spdx", ""))):
        raise BundleError("manifest license identifier is invalid")
    if producer_contract and "file" in license_data and (
        license_data["file"] is not None
        and (
            not isinstance(license_data["file"], str)
            or not LICENSE_FILE.fullmatch(license_data["file"])
        )
    ):
        raise BundleError("manifest license file is invalid")
    if not str(attribution.get("creator", "")).strip():
        raise BundleError("manifest creator attribution is required")
    source_url = attribution.get("source_url")
    if source_url:
        source_url = str(source_url)
        if producer_contract and "\\" in source_url:
            raise BundleError("attribution source URL must be HTTPS")
        parsed = urllib.parse.urlparse(source_url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            raise BundleError("attribution source URL must be HTTPS")
    provenance = data.get("provenance")
    if provenance is not None:
        if not isinstance(provenance, dict):
            raise BundleError("manifest provenance is invalid")
        only_keys(provenance, {"method", "model", "review"}, "provenance")
        if provenance.get("method") == "generated" and not str(provenance.get("model", "")).strip():
            raise BundleError("generated artwork must name its model")


def validate_manifest(
    data: dict, catalog_pack: dict, producer_contract: bool = False,
) -> tuple[str, str, list[dict], int]:
    format_version = data.get("format_version")
    if (
        data.get("format") != "avian-visitors-asset-pack"
        or (producer_contract and isinstance(format_version, bool))
        or (producer_contract and not isinstance(format_version, int))
        or format_version != 1
    ):
        raise BundleError("unsupported bundle manifest")
    validate_artwork_metadata(data, producer_contract)
    pack_id = data.get("id")
    version = data.get("version")
    if (
        not isinstance(pack_id, str)
        or not PACK_ID.fullmatch(pack_id)
        or (producer_contract and pack_id.startswith("official-"))
    ):
        raise BundleError("invalid manifest pack ID")
    version_pattern = VERSION if producer_contract else LEGACY_VERSION
    if not isinstance(version, str) or not version_pattern.fullmatch(version):
        raise BundleError("invalid manifest version")
    if pack_id != catalog_pack.get("id") or version != catalog_pack.get("version"):
        raise BundleError("manifest ID or version does not match the catalog")
    species = data.get("species")
    if not isinstance(species, list) or not 1 <= len(species) <= MAX_SPECIES:
        raise BundleError("manifest species list is empty or too large")
    objects = []
    seen_names, seen_files, seen_objects = set(), set(), set()
    total_bytes = 0
    for bird in species:
        if not isinstance(bird, dict) or not SCI_NAME.fullmatch(str(bird.get("scientific_name", ""))):
            raise BundleError("manifest contains an invalid scientific name")
        only_keys(bird, {"scientific_name", "common_name", "poses", "license", "attribution", "provenance"}, "species")
        if "common_name" in bird:
            common_name = bird["common_name"]
            if (
                not isinstance(common_name, str)
                or len(common_name) > 100
                or any(
                    ord(character) < 0x20
                    or (producer_contract and ord(character) == 0x7F)
                    or 0xD800 <= ord(character) <= 0xDFFF
                    or character in "<>"
                    for character in common_name
                )
            ):
                raise BundleError("manifest contains an invalid common name")
        scientific = bird["scientific_name"]
        if scientific in seen_names:
            raise BundleError("manifest repeats a scientific name")
        seen_names.add(scientific)
        slug = re.sub(r"[^a-z0-9]+", "-", scientific.lower()).strip("-")
        poses = bird.get("poses")
        if not isinstance(poses, list) or not 1 <= len(poses) <= 2:
            raise BundleError(f"{scientific} must contain one or two poses")
        seen_pose = set()
        for pose in poses:
            if not isinstance(pose, dict) or pose.get("id") not in {"perched", "flight"}:
                raise BundleError(f"{scientific} has an unsupported pose")
            only_keys(pose, {"id", "file", "sha256", "bytes", "license", "attribution", "provenance"}, "pose")
            pose_id = pose["id"]
            if pose_id in seen_pose:
                raise BundleError(f"{scientific} repeats a pose")
            seen_pose.add(pose_id)
            expected_file = f"illustrations/{slug}{'-2' if pose_id == 'flight' else ''}.png"
            if pose.get("file") != expected_file or expected_file in seen_files:
                raise BundleError(f"{scientific} has an invalid or duplicate path")
            seen_files.add(expected_file)
            sha = pose.get("sha256")
            size = pose.get("bytes")
            if not isinstance(sha, str) or not SHA256.fullmatch(sha):
                raise BundleError(f"{scientific} has an invalid checksum")
            if (
                (producer_contract and isinstance(size, bool))
                or not isinstance(size, int)
                or not 1 <= size <= MAX_OBJECT_BYTES
            ):
                raise BundleError(f"{scientific} has an invalid byte length")
            total_bytes += size
            if total_bytes > MAX_TOTAL_BYTES:
                raise BundleError("bundle is larger than the installed-size limit")
            item = {"sha256": sha, "bytes": size, "file": expected_file, "slug": slug, "pose": pose_id}
            objects.append(item)
            seen_objects.add(sha)
    if len(objects) > MAX_OBJECTS:
        raise BundleError("bundle contains too many objects")
    return pack_id, version, objects, total_bytes


def validate_png(path: Path, expected_bytes: int) -> None:
    if path.stat().st_size != expected_bytes:
        raise BundleError("object byte length does not match its manifest")
    validate_png_chunks(path)
    try:
        from PIL import Image
        Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
        with Image.open(path) as image:
            if image.format != "PNG":
                raise BundleError("bundle objects must be PNG images")
            if getattr(image, "n_frames", 1) != 1:
                raise BundleError("bird PNG must contain exactly one static frame")
            width, height = image.size
            if width < 1 or height < 1 or width > MAX_IMAGE_SIDE or height > MAX_IMAGE_SIDE:
                raise BundleError("PNG dimensions exceed the bundle limit")
            if width * height > MAX_IMAGE_PIXELS:
                raise BundleError("PNG decoded pixel count exceeds the bundle limit")
            if image.mode not in {"RGBA", "LA"} and "transparency" not in image.info:
                raise BundleError("bird PNG must support transparency")
            image.verify()
        with Image.open(path) as image:
            alpha = image.getchannel("A") if image.mode in {"RGBA", "LA"} else image.convert("RGBA").getchannel("A")
            alpha_min, alpha_max = alpha.getextrema()
            if alpha_min != 0 or alpha_max <= 127:
                raise BundleError(
                    "bird PNG must contain transparent and visible alpha pixels; "
                    "it has no visible alpha pixels or no transparent pixels"
                )
    except BundleError:
        raise
    except Exception as exc:
        raise BundleError("object is not a valid bounded PNG") from exc


def validate_png_chunks(path: Path) -> None:
    """Reject metadata, animation, polyglot tails, and unknown PNG chunks.

    Bundle objects are executable browser inputs as well as artwork.  Keeping
    only the pixel-structure chunks used by current official packs ensures the
    maintainer reviews the same meaningful content that is later published.
    """
    raw = path.read_bytes()
    if not raw.startswith(b"\x89PNG\r\n\x1a\n"):
        raise BundleError("bundle objects must be PNG images")
    allowed = {b"IHDR", b"PLTE", b"tRNS", b"IDAT", b"IEND"}
    offset = 8
    seen: list[bytes] = []
    idat_ended = False
    while offset < len(raw):
        if len(raw) - offset < 12:
            raise BundleError("PNG has trailing or truncated data")
        length = struct.unpack(">I", raw[offset:offset + 4])[0]
        chunk_end = offset + 12 + length
        if chunk_end > len(raw):
            raise BundleError("PNG has a truncated chunk")
        chunk_type = raw[offset + 4:offset + 8]
        chunk_data = raw[offset + 8:offset + 8 + length]
        claimed_crc = struct.unpack(">I", raw[offset + 8 + length:chunk_end])[0]
        if chunk_type not in allowed:
            raise BundleError("PNG contains unsupported metadata or ancillary chunks")
        if zlib.crc32(chunk_type + chunk_data) & 0xFFFFFFFF != claimed_crc:
            raise BundleError("PNG contains a chunk checksum mismatch")
        if chunk_type == b"IHDR":
            if seen or length != 13:
                raise BundleError("PNG has an invalid IHDR chunk")
        elif not seen:
            raise BundleError("PNG must begin with IHDR")
        if chunk_type in {b"IHDR", b"PLTE", b"tRNS", b"IEND"} and chunk_type in seen:
            raise BundleError("PNG repeats a structural chunk")
        if chunk_type in {b"PLTE", b"tRNS"} and b"IDAT" in seen:
            raise BundleError("PNG color chunks must precede image data")
        if chunk_type == b"IDAT":
            if idat_ended:
                raise BundleError("PNG image-data chunks must be consecutive")
        elif b"IDAT" in seen:
            idat_ended = True
        if chunk_type == b"IEND":
            if length != 0 or b"IDAT" not in seen or chunk_end != len(raw):
                raise BundleError("PNG has an invalid end or trailing data")
            seen.append(chunk_type)
            offset = chunk_end
            break
        seen.append(chunk_type)
        offset = chunk_end
    if not seen or seen[0] != b"IHDR" or seen[-1] != b"IEND":
        raise BundleError("PNG is missing required structural chunks")
