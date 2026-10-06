#!/usr/bin/env python3
"""Deterministically canonicalize hosted bird PNGs and their publish manifest."""
from __future__ import annotations

import copy
import hashlib
import io
import json
import struct
import zlib
from pathlib import Path

import bundle_inventory_commitment


FORMAT = "rgba-png-zero-transparent-v1"
MAX_OBJECT_BYTES = 4 * 1024 * 1024


class CanonicalizationError(ValueError):
    pass


def canonical_png(source: bytes, maximum: int = MAX_OBJECT_BYTES) -> bytes:
    """Return metadata-free RGBA PNG bytes with no payload under alpha zero."""
    try:
        from PIL import Image

        with Image.open(io.BytesIO(source)) as opened:
            if opened.format != "PNG" or getattr(opened, "n_frames", 1) != 1:
                raise CanonicalizationError("canonical source must be one static PNG")
            opened.load()
            rgba = opened.convert("RGBA")
    except CanonicalizationError:
        raise
    except Exception as exc:
        raise CanonicalizationError("canonical source could not be decoded") from exc

    pixels = bytearray(rgba.tobytes())
    for offset in range(0, len(pixels), 4):
        if pixels[offset + 3] == 0:
            pixels[offset:offset + 3] = b"\0\0\0"
    canonical = Image.frombytes("RGBA", rgba.size, bytes(pixels))

    # Prefer the smallest deterministic encoding. The hosted archive bounds
    # file count and decoded pixels separately, so a simple small cutout does
    # not need arbitrary byte padding.
    for level in (9, 6, 3, 1):
        output = io.BytesIO()
        canonical.save(output, format="PNG", optimize=False, compress_level=level)
        encoded = output.getvalue()
        if len(encoded) <= maximum:
            validate_canonical_structure(encoded)
            return encoded
    raise CanonicalizationError("canonical PNG exceeds the object-size limit")


def publish_manifest(manifest: dict, inventory: list[dict]) -> tuple[dict, bytes]:
    """Replace pose byte claims with canonical object claims in exact order."""
    if not isinstance(manifest, dict):
        raise CanonicalizationError("publish manifest is invalid")
    result = copy.deepcopy(manifest)
    cursor = 0
    species = result.get("species")
    if not isinstance(species, list):
        raise CanonicalizationError("publish manifest species inventory is invalid")
    for bird in species:
        poses = bird.get("poses") if isinstance(bird, dict) else None
        if not isinstance(poses, list):
            raise CanonicalizationError("publish manifest pose inventory is invalid")
        for pose in poses:
            if cursor >= len(inventory) or not isinstance(pose, dict):
                raise CanonicalizationError("canonical inventory does not match manifest")
            item = inventory[cursor]
            if pose.get("file") != item.get("file"):
                raise CanonicalizationError("canonical inventory order does not match manifest")
            pose["sha256"] = item.get("sha256")
            pose["bytes"] = item.get("bytes")
            cursor += 1
    if cursor != len(inventory):
        raise CanonicalizationError("canonical inventory does not match manifest")
    bundle_inventory_commitment.manifest_inventory_sha256(result)
    encoded = (
        json.dumps(result, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        + "\n"
    ).encode("utf-8")
    return result, encoded


def descriptor(file: str, data: bytes) -> dict:
    return {"file": file, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}


def png_dimensions(data: bytes) -> tuple[int, int]:
    if (
        len(data) < 33
        or data[:8] != b"\x89PNG\r\n\x1a\n"
        or data[12:16] != b"IHDR"
    ):
        raise CanonicalizationError("canonical PNG header is invalid")
    width, height = struct.unpack(">II", data[16:24])
    if not 1 <= width <= 4096 or not 1 <= height <= 4096:
        raise CanonicalizationError("canonical PNG dimensions are invalid")
    return width, height


def validate_canonical_structure(data: bytes) -> tuple[int, int]:
    """Byte-check the metadata-free RGBA8 canonical PNG grammar."""
    width, height = png_dimensions(data)
    if data[24] != 8 or data[25] != 6:
        raise CanonicalizationError("canonical PNG must use RGBA8 pixels")
    offset = 8
    chunks: list[bytes] = []
    while offset < len(data):
        if len(data) - offset < 12:
            raise CanonicalizationError("canonical PNG is truncated")
        length = struct.unpack(">I", data[offset:offset + 4])[0]
        end = offset + 12 + length
        if end > len(data):
            raise CanonicalizationError("canonical PNG is truncated")
        kind = data[offset + 4:offset + 8]
        payload = data[offset + 8:offset + 8 + length]
        checksum = struct.unpack(">I", data[offset + 8 + length:end])[0]
        if kind not in {b"IHDR", b"IDAT", b"IEND"}:
            raise CanonicalizationError("canonical PNG contains a non-pixel chunk")
        if (kind == b"IHDR" and (chunks or length != 13)) or (
            kind == b"IEND" and length != 0
        ):
            raise CanonicalizationError("canonical PNG has an invalid structural chunk")
        if zlib.crc32(kind + payload) & 0xFFFFFFFF != checksum:
            raise CanonicalizationError("canonical PNG chunk checksum is invalid")
        chunks.append(kind)
        offset = end
        if kind == b"IEND":
            break
    if (
        offset != len(data)
        or not chunks
        or chunks[0] != b"IHDR"
        or chunks[-1] != b"IEND"
        or chunks.count(b"IHDR") != 1
        or chunks.count(b"IEND") != 1
        or b"IDAT" not in chunks
        or any(kind != b"IDAT" for kind in chunks[1:-1])
    ):
        raise CanonicalizationError("canonical PNG chunk order is invalid")
    return width, height


def validate_canonical_png(path: Path, expected_bytes: int) -> tuple[int, int]:
    """Decode-check a persisted canonical object without changing its bytes."""
    if not path.is_file() or path.is_symlink() or path.stat().st_size != expected_bytes:
        raise CanonicalizationError("canonical PNG byte length is invalid")
    try:
        from PIL import Image

        with Image.open(path) as image:
            if (
                image.format != "PNG"
                or image.mode != "RGBA"
                or getattr(image, "n_frames", 1) != 1
            ):
                raise CanonicalizationError("canonical object is not a static RGBA PNG")
            image.load()
            width, height = image.size
            pixels = image.getdata()
            if any(alpha == 0 and (red or green or blue) for red, green, blue, alpha in pixels):
                raise CanonicalizationError("canonical PNG retains RGB below transparent pixels")
    except CanonicalizationError:
        raise
    except Exception as exc:
        raise CanonicalizationError("canonical PNG could not be decoded") from exc
    return width, height
