#!/usr/bin/env python3
"""Export the station's top-level illustration library as one upload-ready ZIP.

The exporter is deliberately self-contained: it does not import the installed
bundle manager, mutate station state, or trust filenames to invent taxonomy.
Every source PNG is decoded and re-encoded into the hosted canonical form while
an exclusive generation lock holds the local library still and serializes CLI
exports on memory-constrained stations.
"""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import io
import json
import os
import re
import shutil
import signal
import stat
import struct
import tempfile
import warnings
import zipfile
import zlib
from pathlib import Path
from typing import BinaryIO, Iterator, Sequence


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_ILLUSTRATIONS = ROOT / "avian/assets/illustrations"
DEFAULT_GENERATION_LOCK = Path("/run/lock/avian-generation.lock")
DEFAULT_CATALOGS = (
    ROOT / "avian/bundles/catalog-v1.json",
    ROOT / "assembled/site/public/catalog/bundles-v1.json",
    ROOT / "avian/scripts/bundle-taxonomy-v1.json",
)
DEFAULT_LABELS = (
    ROOT / "model/BirdNET_6K_GLOBAL_MODEL_Labels.txt",
    ROOT / "model/BirdNET_GLOBAL_6K_V2.4_Model_FP16_Labels.txt",
)
DEFAULT_COMMON_NAMES = ROOT / "model/l18n/labels_en.json"

FORMAT = "avian-visitors-asset-pack"
FORMAT_VERSION = 1
VERSION = "1.0.0"
LICENSE_SPDX = "CC-BY-NC-SA-4.0"
LICENSE_FILE = f"LICENSES/{LICENSE_SPDX}.txt"
LICENSE_URL = "https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode"
ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)

MAX_ARCHIVE_BYTES = 768 * 1024 * 1024
MAX_EXPANDED_BYTES = 640 * 1024 * 1024
MAX_OBJECT_BYTES = 4 * 1024 * 1024
MAX_MANIFEST_BYTES = 4 * 1024 * 1024
MAX_CATALOG_BYTES = 4 * 1024 * 1024
MAX_LABEL_BYTES = 2 * 1024 * 1024
MAX_TEXT_BYTES = 1024 * 1024
MAX_IMAGE_SIDE = 4096
# The hosted validator permits larger images, but export runs beside BirdNET on
# a 512 MiB Pi Zero 2 W.  Four megapixels keeps decode/canonicalization bounded;
# the shipped library currently tops out at 1,039,360 pixels.
MAX_IMAGE_PIXELS = 4_000_000
MAX_SPECIES = 1000
MAX_OBJECTS = 1500
MAX_SOURCE_ENTRIES = 4096
MAX_TAXONOMY_ENTRIES = 20_000
FREE_SPACE_FLOOR = 64 * 1024 * 1024
IO_CHUNK = 128 * 1024

SCI_NAME = re.compile(r"^[A-Z][A-Za-z-]{1,39}(?: [a-z][A-Za-z-]{1,39}){1,3}$")
SOURCE_NAME = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)+(?:-2)?\.png$")


class ExportError(ValueError):
    """A bounded, user-safe export failure."""


class ExportInterrupted(ExportError):
    """Raised so normal finally blocks remove a private stage on SIGTERM."""


def _path(value: object, label: str) -> Path:
    if isinstance(value, bytes) or not isinstance(value, (str, os.PathLike)):
        raise ExportError(f"{label} path is invalid")
    try:
        result = Path(value)
    except (TypeError, ValueError, OSError) as exc:
        raise ExportError(f"{label} path is invalid") from exc
    if "\x00" in os.fspath(result):
        raise ExportError(f"{label} path is invalid")
    return result


def _directory(value: object, label: str) -> Path:
    path = _path(value, label)
    try:
        before = path.lstat()
        if stat.S_ISLNK(before.st_mode) or not stat.S_ISDIR(before.st_mode):
            raise ExportError(f"{label} directory is unsafe or missing")
        resolved = path.resolve(strict=True)
        after = resolved.stat()
    except ExportError:
        raise
    except (OSError, RuntimeError) as exc:
        raise ExportError(f"{label} directory is unsafe or missing") from exc
    if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
        raise ExportError(f"{label} directory changed while it was opened")
    return resolved


def _identity(info: os.stat_result) -> tuple[int, int, int, int, int]:
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

@contextlib.contextmanager
def _open_regular(path: Path, label: str, limit: int) -> Iterator[tuple[BinaryIO, os.stat_result]]:
    try:
        before = path.lstat()
        if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            raise ExportError(f"{label} must be a regular non-symlink file")
        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
    except ExportError:
        raise
    except OSError as exc:
        raise ExportError(f"{label} must be a regular non-symlink file") from exc
    try:
        opened = os.fstat(descriptor)
        if (
            not stat.S_ISREG(opened.st_mode)
            or opened.st_nlink != 1
            or opened.st_size < 1
            or opened.st_size > limit
            or _identity(before) != _identity(opened)
        ):
            raise ExportError(f"{label} is unsafe, empty, or exceeds its size limit")
        with os.fdopen(descriptor, "rb", closefd=False) as handle:
            yield handle, opened
    finally:
        os.close(descriptor)


def _read_regular(path: Path, label: str, limit: int) -> bytes:
    chunks: list[bytes] = []
    total = 0
    with _open_regular(path, label, limit) as (handle, opened):
        while True:
            chunk = handle.read(min(IO_CHUNK, limit + 1 - total))
            if not chunk:
                break
            total += len(chunk)
            if total > limit:
                raise ExportError(f"{label} exceeds its size limit")
            chunks.append(chunk)
        after = os.fstat(handle.fileno())
        if total != opened.st_size or _identity(after) != _identity(opened):
            raise ExportError(f"{label} changed while it was read")
    return b"".join(chunks)


def _read_json(path: Path, label: str, limit: int) -> dict:
    try:
        decoded = _read_regular(path, label, limit).decode("utf-8")
        value = json.loads(decoded)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ExportError(f"{label} is not valid JSON") from exc
    if not isinstance(value, dict):
        raise ExportError(f"{label} must contain a JSON object")
    return value


def _scientific_slug(scientific: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", scientific.lower()).strip("-")


def _validated_scientific(value: object, label: str) -> str:
    if not isinstance(value, str) or not SCI_NAME.fullmatch(value):
        raise ExportError(f"{label} contains an invalid scientific name")
    return value


def _validated_common(value: object) -> str | None:
    if value is None or value == "":
        return None
    if (
        not isinstance(value, str)
        or len(value) > 100
        or any(ord(char) < 0x20 or ord(char) == 0x7F or char in "<>" for char in value)
    ):
        raise ExportError("taxonomy contains an invalid common name")
    return value


def _add_taxon(
    mapping: dict[str, tuple[str, str | None]],
    scientific: object,
    common: object,
    label: str,
    *,
    preserve_existing: bool,
) -> None:
    name = _validated_scientific(scientific, label)
    common_name = _validated_common(common)
    slug = _scientific_slug(name)
    current = mapping.get(slug)
    if current is not None:
        if current[0] != name:
            raise ExportError(f"{label} maps one filename slug to multiple species")
        if current[1] is None and common_name is not None:
            mapping[slug] = (name, common_name)
        elif current[1] is not None and common_name is not None and current[1] != common_name and not preserve_existing:
            raise ExportError(f"{label} contains conflicting common names")
        return
    if len(mapping) >= MAX_TAXONOMY_ENTRIES:
        raise ExportError("taxonomy contains too many species")
    mapping[slug] = (name, common_name)


def _catalog_taxa(path: Path, mapping: dict[str, tuple[str, str | None]]) -> None:
    value = _read_json(path, "taxonomy catalog", MAX_CATALOG_BYTES)
    if value.get("format") in {FORMAT, "avian-visitors-trusted-taxonomy"} and value.get("format_version") == FORMAT_VERSION:
        sources = [value]
    elif value.get("format") == "avian-visitors-bundle-catalog" and value.get("format_version") == 1:
        packs = value.get("packs")
        if not isinstance(packs, list) or len(packs) > 1000:
            raise ExportError("taxonomy catalog packs are invalid")
        sources = packs
    else:
        raise ExportError("taxonomy catalog format is unsupported")
    for source in sources:
        if not isinstance(source, dict):
            raise ExportError("taxonomy catalog contains an invalid pack")
        species = source.get("species")
        if species is None:
            continue
        if not isinstance(species, list) or len(species) > 5000:
            raise ExportError("taxonomy catalog species are invalid")
        for bird in species:
            if isinstance(bird, str):
                _add_taxon(mapping, bird, None, "taxonomy catalog", preserve_existing=True)
            elif isinstance(bird, dict):
                _add_taxon(
                    mapping,
                    bird.get("scientific_name"),
                    bird.get("common_name"),
                    "taxonomy catalog",
                    preserve_existing=True,
                )
            else:
                raise ExportError("taxonomy catalog contains an invalid species")


def _label_taxa(path: Path, mapping: dict[str, tuple[str, str | None]]) -> None:
    try:
        text = _read_regular(path, "BirdNET label file", MAX_LABEL_BYTES).decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ExportError("BirdNET label file is not UTF-8") from exc
    lines = text.splitlines()
    if len(lines) > MAX_TAXONOMY_ENTRIES:
        raise ExportError("BirdNET label file contains too many species")
    local: dict[str, str] = {}
    for raw in lines:
        if not raw:
            continue
        # BirdNET label sets also contain a handful of sound classes such as
        # Noise and Engine. They are not taxonomy and cannot name artwork.
        if not SCI_NAME.fullmatch(raw):
            continue
        scientific = raw
        slug = _scientific_slug(scientific)
        if slug in local and local[slug] != scientific:
            raise ExportError("BirdNET labels map one filename slug to multiple species")
        local[slug] = scientific
    for slug in sorted(local):
        scientific = local[slug]
        if slug in mapping:
            continue
        _add_taxon(mapping, scientific, None, "BirdNET label file", preserve_existing=True)


def _common_names(path: Path, mapping: dict[str, tuple[str, str | None]]) -> None:
    value = _read_json(path, "BirdNET common-name file", MAX_LABEL_BYTES)
    if len(value) > MAX_TAXONOMY_ENTRIES:
        raise ExportError("BirdNET common-name file contains too many species")
    common_by_scientific: dict[str, str] = {}
    for scientific, common in value.items():
        if not SCI_NAME.fullmatch(scientific):
            continue
        name = scientific
        common_name = _validated_common(common)
        if common_name is not None:
            common_by_scientific[name] = common_name
    for slug, (scientific, common) in list(mapping.items()):
        if common is None and scientific in common_by_scientific:
            mapping[slug] = (scientific, common_by_scientific[scientific])


def load_taxonomy(
    catalogs: Sequence[Path],
    labels: Sequence[Path],
    common_names: Path | None,
) -> dict[str, tuple[str, str | None]]:
    mapping: dict[str, tuple[str, str | None]] = {}
    if not catalogs:
        raise ExportError("a trusted taxonomy catalog is required")
    for catalog in catalogs:
        _catalog_taxa(_path(catalog, "taxonomy catalog"), mapping)
    for label in labels:
        _label_taxa(_path(label, "BirdNET label file"), mapping)
    if common_names is not None:
        _common_names(_path(common_names, "BirdNET common-name file"), mapping)
    if not mapping:
        raise ExportError("trusted taxonomy sources contain no species")
    return mapping


@contextlib.contextmanager
def generation_snapshot_lock(value: Path) -> Iterator[None]:
    path = _path(value, "generation lock")
    parent = _directory(path.parent, "generation lock parent")
    path = parent / path.name
    try:
        before = path.lstat()
        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
    except OSError as exc:
        raise ExportError("illustration generation lock is unavailable") from exc
    try:
        opened = os.fstat(descriptor)
        permissions = stat.S_IMODE(opened.st_mode)
        is_default = path == DEFAULT_GENERATION_LOCK
        if (
            stat.S_ISLNK(before.st_mode)
            or not stat.S_ISREG(opened.st_mode)
            or opened.st_nlink != 1
            or _identity(before) != _identity(opened)
            or (is_default and (opened.st_uid != 0 or permissions != 0o660))
            or (not is_default and permissions != 0o600)
        ):
            raise ExportError("illustration generation lock is unsafe")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise ExportError("illustration generation is running; try again when it finishes") from exc
        yield
    finally:
        with contextlib.suppress(OSError):
            fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


def _open_illustration_directory(path: Path) -> tuple[int, os.stat_result, Path]:
    root = _directory(path, "illustration")
    flags = (
        os.O_RDONLY
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_DIRECTORY", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    try:
        descriptor = os.open(root, flags)
        opened = os.fstat(descriptor)
    except OSError as exc:
        raise ExportError("illustration directory cannot be opened safely") from exc
    if not stat.S_ISDIR(opened.st_mode):
        os.close(descriptor)
        raise ExportError("illustration directory cannot be opened safely")
    return descriptor, opened, root


def _source_inventory(
    directory_fd: int,
    taxonomy: dict[str, tuple[str, str | None]],
) -> tuple[list[tuple[str, str, str]], dict[str, tuple[int, int, int, int, int]], int]:
    sources: list[tuple[str, str, str]] = []
    identities: dict[str, tuple[int, int, int, int, int]] = {}
    total_bytes = 0
    seen_poses: set[tuple[str, str]] = set()
    try:
        with os.scandir(directory_fd) as entries:
            for count, entry in enumerate(entries, start=1):
                if count > MAX_SOURCE_ENTRIES:
                    raise ExportError("illustration directory contains too many entries")
                name = entry.name
                if not name.lower().endswith(".png"):
                    continue
                if not SOURCE_NAME.fullmatch(name):
                    raise ExportError(f"illustration filename is not canonical: {name}")
                try:
                    info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
                except OSError as exc:
                    raise ExportError(f"illustration cannot be inspected safely: {name}") from exc
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    raise ExportError(f"illustration must be a regular non-symlink file: {name}")
                if info.st_size < 1 or info.st_size > MAX_OBJECT_BYTES:
                    raise ExportError(f"illustration is empty or exceeds 4 MiB: {name}")
                stem = name[:-4]
                pose = "flight" if stem.endswith("-2") else "perched"
                slug = stem[:-2] if pose == "flight" else stem
                if slug not in taxonomy:
                    raise ExportError(f"illustration has no trusted taxonomy mapping: {name}")
                key = (slug, pose)
                if key in seen_poses:
                    raise ExportError(f"illustration repeats a canonical species pose: {name}")
                seen_poses.add(key)
                sources.append((name, slug, pose))
                identities[name] = _identity(info)
                total_bytes += info.st_size
                if len(sources) > MAX_OBJECTS or total_bytes > MAX_EXPANDED_BYTES:
                    raise ExportError("illustration library exceeds hosted bundle limits")
    except ExportError:
        raise
    except OSError as exc:
        raise ExportError("illustration directory cannot be enumerated safely") from exc
    if not sources:
        raise ExportError("the local illustration library contains no top-level PNGs")
    sources.sort()
    return sources, identities, total_bytes


def _read_directory_file(
    directory_fd: int,
    name: str,
    expected: tuple[int, int, int, int, int],
) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(name, flags, dir_fd=directory_fd)
    except OSError as exc:
        raise ExportError(f"illustration cannot be opened safely: {name}") from exc
    try:
        opened = os.fstat(descriptor)
        if (
            not stat.S_ISREG(opened.st_mode)
            or opened.st_nlink != 1
            or _identity(opened) != expected
            or opened.st_size < 1
            or opened.st_size > MAX_OBJECT_BYTES
        ):
            raise ExportError(f"illustration changed before it could be read: {name}")
        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = os.read(descriptor, min(IO_CHUNK, MAX_OBJECT_BYTES + 1 - total))
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_OBJECT_BYTES:
                raise ExportError(f"illustration exceeds 4 MiB: {name}")
            chunks.append(chunk)
        after = os.fstat(descriptor)
        if total != opened.st_size or _identity(after) != expected:
            raise ExportError(f"illustration changed while it was read: {name}")
        return b"".join(chunks)
    finally:
        os.close(descriptor)


def _recheck_inventory(
    directory_fd: int,
    directory_identity: os.stat_result,
    identities: dict[str, tuple[int, int, int, int, int]],
) -> None:
    opened = os.fstat(directory_fd)
    if (opened.st_dev, opened.st_ino, opened.st_mtime_ns, opened.st_ctime_ns) != (
        directory_identity.st_dev,
        directory_identity.st_ino,
        directory_identity.st_mtime_ns,
        directory_identity.st_ctime_ns,
    ):
        raise ExportError("illustration directory changed during export")
    for name, expected in identities.items():
        try:
            current = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        except OSError as exc:
            raise ExportError(f"illustration changed during export: {name}") from exc
        if _identity(current) != expected or not stat.S_ISREG(current.st_mode) or current.st_nlink != 1:
            raise ExportError(f"illustration changed during export: {name}")


def _preflight_png(data: bytes, name: str) -> tuple[int, int]:
    if len(data) < 45 or data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ExportError(f"illustration is not a valid PNG: {name}")
    offset = 8
    seen: list[bytes] = []
    idat_ended = False
    width = height = 0
    while offset < len(data):
        if len(data) - offset < 12:
            raise ExportError(f"PNG is truncated or has trailing data: {name}")
        length = struct.unpack(">I", data[offset:offset + 4])[0]
        end = offset + 12 + length
        if end > len(data):
            raise ExportError(f"PNG contains a truncated chunk: {name}")
        kind = data[offset + 4:offset + 8]
        payload = data[offset + 8:offset + 8 + length]
        claimed_crc = struct.unpack(">I", data[offset + 8 + length:end])[0]
        if not re.fullmatch(rb"[A-Za-z]{4}", kind) or kind[2] & 0x20:
            raise ExportError(f"PNG contains an invalid chunk type: {name}")
        if zlib.crc32(kind + payload) & 0xFFFFFFFF != claimed_crc:
            raise ExportError(f"PNG contains a chunk checksum mismatch: {name}")
        if kind == b"IHDR":
            if seen or length != 13:
                raise ExportError(f"PNG has an invalid IHDR chunk: {name}")
            width, height = struct.unpack(">II", payload[:8])
            if (
                width < 1
                or height < 1
                or width > MAX_IMAGE_SIDE
                or height > MAX_IMAGE_SIDE
                or width * height > MAX_IMAGE_PIXELS
            ):
                raise ExportError(f"PNG dimensions exceed the hosted limit: {name}")
        elif not seen:
            raise ExportError(f"PNG must begin with IHDR: {name}")
        if kind in {b"acTL", b"fcTL", b"fdAT"}:
            raise ExportError(f"animated PNGs are not supported: {name}")
        if not kind[0] & 0x20 and kind not in {b"IHDR", b"PLTE", b"IDAT", b"IEND"}:
            raise ExportError(f"PNG contains an unsupported critical chunk: {name}")
        if kind in {b"IHDR", b"PLTE", b"IEND"} and kind in seen:
            raise ExportError(f"PNG repeats a structural chunk: {name}")
        if kind == b"IDAT":
            if idat_ended:
                raise ExportError(f"PNG image-data chunks are not consecutive: {name}")
        elif b"IDAT" in seen:
            idat_ended = True
        if kind == b"IEND":
            if length != 0 or b"IDAT" not in seen or end != len(data):
                raise ExportError(f"PNG has an invalid end or trailing data: {name}")
            seen.append(kind)
            offset = end
            break
        seen.append(kind)
        offset = end
    if not seen or seen[0] != b"IHDR" or seen[-1] != b"IEND" or seen.count(b"IHDR") != 1:
        raise ExportError(f"PNG is missing required structural chunks: {name}")
    return width, height


def _validate_canonical_png(data: bytes, name: str) -> tuple[int, int]:
    width, height = _preflight_png(data, name)
    if data[24] != 8 or data[25] != 6:
        raise ExportError(f"canonical PNG is not RGBA8: {name}")
    offset = 8
    kinds: list[bytes] = []
    while offset < len(data):
        length = struct.unpack(">I", data[offset:offset + 4])[0]
        kinds.append(data[offset + 4:offset + 8])
        offset += 12 + length
    if kinds[0] != b"IHDR" or kinds[-1] != b"IEND" or any(kind != b"IDAT" for kind in kinds[1:-1]):
        raise ExportError(f"canonical PNG contains metadata: {name}")
    return width, height


def canonical_png(data: bytes, name: str) -> tuple[bytes, int, int]:
    expected_width, expected_height = _preflight_png(data, name)
    try:
        from PIL import Image

        Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as opened:
                if opened.format != "PNG" or getattr(opened, "n_frames", 1) != 1:
                    raise ExportError(f"illustration must be one static PNG: {name}")
                if opened.size != (expected_width, expected_height):
                    raise ExportError(f"PNG dimensions changed during decode: {name}")
                opened.load()
                rgba = opened.convert("RGBA")
    except ExportError:
        raise
    except Exception as exc:
        raise ExportError(f"illustration could not be decoded safely: {name}") from exc
    try:
        alpha = rgba.getchannel("A")
        try:
            alpha_min, alpha_max = alpha.getextrema()
            if alpha_min != 0 or alpha_max <= 127:
                raise ExportError(f"illustration must contain transparent and visible pixels: {name}")
            transparent = alpha.point(lambda value: 255 if value == 0 else 0)
        finally:
            alpha.close()
        try:
            # Pillow applies a constant tuple directly; unlike tobytes ->
            # bytearray -> bytes -> frombytes, this does not allocate three
            # additional full-size RGBA copies.
            rgba.paste((0, 0, 0, 0), (0, 0), transparent)
        finally:
            transparent.close()
        target = io.BytesIO()
        rgba.save(target, format="PNG", optimize=False, compress_level=9)
        encoded = target.getvalue()
    finally:
        rgba.close()
    if not 1 <= len(encoded) <= MAX_OBJECT_BYTES:
        raise ExportError(f"canonical illustration exceeds 4 MiB: {name}")
    _validate_canonical_png(encoded, name)
    return encoded, expected_width, expected_height


def _zip_info(name: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, ZIP_TIMESTAMP)
    info.create_system = 3
    info.compress_type = zipfile.ZIP_STORED
    info.external_attr = (stat.S_IFREG | 0o644) << 16
    info.extra = b""
    info.comment = b""
    return info


def _license_bytes() -> bytes:
    return (
        f"SPDX-License-Identifier: {LICENSE_SPDX}\n"
        f"This Avian Visitors illustration bundle is licensed under {LICENSE_SPDX}.\n"
        f"Canonical license terms: {LICENSE_URL}\n"
    ).encode("utf-8")


def _manifest(species: list[dict]) -> tuple[dict, bytes]:
    identity_bytes = json.dumps(
        species, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode("utf-8")
    pack_id = "local-station-" + hashlib.sha256(identity_bytes).hexdigest()[:32]
    manifest = {
        "format": FORMAT,
        "format_version": FORMAT_VERSION,
        "id": pack_id,
        "version": VERSION,
        "name": "Japanese Woodblock - Local Station",
        "description": "Local station illustration library exported for review and sharing.",
        "style": {"id": "japanese-woodblock", "name": "Japanese Woodblock"},
        "coverage": {
            "type": "selection",
            "label": "Local station illustration library",
            "region_codes": [],
        },
        "species": species,
        "license": {"spdx": LICENSE_SPDX, "file": LICENSE_FILE},
        "attribution": {"creator": "Avian Visitors and station owner"},
        "provenance": {
            "method": "mixed",
            "model": "mixed historical and local image-generation models",
            "review": "contributor-reviewed",
        },
    }
    encoded = (
        json.dumps(manifest, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        + "\n"
    ).encode("utf-8")
    if len(encoded) > MAX_MANIFEST_BYTES:
        raise ExportError("export manifest exceeds its size limit")
    return manifest, encoded


def _output_path(value: Path, illustrations: Path, protected: Sequence[Path]) -> tuple[Path, Path]:
    output = _path(value, "output")
    if output.name in {"", ".", ".."} or any(ord(char) < 0x20 for char in output.name):
        raise ExportError("output path is invalid")
    parent = _directory(output.parent, "output parent")
    parent_info = parent.stat()
    parent_mode = stat.S_IMODE(parent_info.st_mode)
    if parent_info.st_uid not in {0, os.geteuid()} or (
        parent_mode & (stat.S_IWGRP | stat.S_IWOTH)
        and not parent_mode & stat.S_ISVTX
    ):
        raise ExportError("output parent permits unsafe local replacement")
    output = parent / output.name
    try:
        output.relative_to(illustrations)
    except ValueError:
        pass
    else:
        raise ExportError("output must be outside the illustration library")
    protected_resolved = set()
    for path in protected:
        with contextlib.suppress(OSError, RuntimeError):
            protected_resolved.add(path.resolve(strict=True))
    try:
        resolved_output = output.resolve(strict=True)
    except (FileNotFoundError, OSError, RuntimeError):
        resolved_output = None
    if resolved_output is not None and resolved_output in protected_resolved:
        raise ExportError("output must not replace a taxonomy source")
    try:
        current = output.lstat()
    except FileNotFoundError:
        pass
    except OSError as exc:
        raise ExportError("output path is unsafe") from exc
    else:
        if stat.S_ISLNK(current.st_mode) or not stat.S_ISREG(current.st_mode) or current.st_nlink != 1:
            raise ExportError("output must be a regular non-symlink file")
    return output, parent


def _ensure_disk_space(parent: Path) -> None:
    # A small, highly compressed source PNG can canonicalize into a much larger
    # RGBA PNG.  Source byte counts therefore cannot bound the staged ZIP.  Keep
    # room for the full hosted archive ceiling and a post-write safety floor.
    if shutil.disk_usage(parent).free < MAX_ARCHIVE_BYTES + FREE_SPACE_FLOOR:
        raise ExportError("not enough free disk space to export this bundle safely")


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _validate_archive(raw: BinaryIO, manifest: dict, manifest_bytes: bytes, names: list[str]) -> dict:
    try:
        raw.flush()
        info = os.fstat(raw.fileno())
    except (AttributeError, OSError) as exc:
        raise ExportError("export archive is unavailable") from exc
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or not 1024 <= info.st_size <= MAX_ARCHIVE_BYTES:
        raise ExportError("export archive is outside hosted size limits")
    expected_names = names + [LICENSE_FILE, "manifest.json"]
    expanded = 0
    archive_digest = hashlib.sha256()
    raw.seek(0)
    while chunk := raw.read(IO_CHUNK):
        archive_digest.update(chunk)
    raw.seek(0)
    try:
        archive = zipfile.ZipFile(raw)
    except (OSError, zipfile.BadZipFile) as exc:
        raise ExportError("export archive is not a valid ZIP") from exc
    with archive:
        infos = archive.infolist()
        if archive.comment or [item.filename for item in infos] != expected_names:
            raise ExportError("export archive member order or inventory is invalid")
        if len({item.filename.casefold() for item in infos}) != len(infos):
            raise ExportError("export archive contains duplicate member names")
        by_name = {item.filename: item for item in infos}
        for item in infos:
            mode = (item.external_attr >> 16) & 0xFFFF
            if (
                item.date_time != ZIP_TIMESTAMP
                or item.compress_type != zipfile.ZIP_STORED
                or item.flag_bits & 0x1
                or item.extra
                or item.comment
                or not stat.S_ISREG(mode)
                or stat.S_IMODE(mode) != 0o644
                or item.file_size < 1
                or item.compress_size != item.file_size
            ):
                raise ExportError("export archive contains a non-canonical member")
            expanded += item.file_size
            if expanded > MAX_EXPANDED_BYTES:
                raise ExportError("export archive exceeds its expanded-size limit")
        if archive.read(by_name["manifest.json"]) != manifest_bytes:
            raise ExportError("export manifest changed after it was written")
        if archive.read(by_name[LICENSE_FILE]) != _license_bytes():
            raise ExportError("export license changed after it was written")
        seen: set[str] = set()
        objects = 0
        for bird in manifest["species"]:
            for pose in bird["poses"]:
                member = pose["file"]
                data = archive.read(by_name[member])
                if len(data) != pose["bytes"] or hashlib.sha256(data).hexdigest() != pose["sha256"]:
                    raise ExportError("export illustration does not match its manifest")
                _validate_canonical_png(data, member)
                if pose["sha256"] in seen:
                    raise ExportError("export archive reuses canonical illustration bytes")
                seen.add(pose["sha256"])
                objects += 1
    return {
        "species": len(manifest["species"]),
        "objects": objects,
        "expanded_bytes": expanded,
        "archive_sha256": archive_digest.hexdigest(),
    }


def export_bundle(
    illustrations: Path,
    catalogs: Sequence[Path],
    labels: Sequence[Path],
    common_names: Path | None,
    output: Path,
    generation_lock: Path,
) -> dict:
    illustration_root = _directory(illustrations, "illustration")
    taxonomy = load_taxonomy(catalogs, labels, common_names)
    output, output_parent = _output_path(
        output,
        illustration_root,
        [*catalogs, *labels, *([common_names] if common_names is not None else [])],
    )
    stage: Path | None = None
    with generation_snapshot_lock(generation_lock):
        directory_fd, directory_identity, _ = _open_illustration_directory(illustration_root)
        try:
            sources, identities, _ = _source_inventory(directory_fd, taxonomy)
            _ensure_disk_space(output_parent)
            descriptor, stage_name = tempfile.mkstemp(
                prefix=f".{output.name}.", suffix=".tmp", dir=output_parent
            )
            stage = Path(stage_name)
            species_poses: dict[str, dict[str, dict]] = {}
            canonical_digests: set[str] = set()
            archive_names: list[str] = []
            try:
                try:
                    os.fchmod(descriptor, 0o600)
                    stage_identity = os.fstat(descriptor)
                except BaseException:
                    os.close(descriptor)
                    raise
                with os.fdopen(descriptor, "w+b") as stage_handle:
                    with zipfile.ZipFile(
                        stage_handle,
                        "w",
                        compression=zipfile.ZIP_STORED,
                        allowZip64=False,
                    ) as archive:
                        for name, slug, pose_id in sources:
                            source = _read_directory_file(directory_fd, name, identities[name])
                            canonical, _, _ = canonical_png(source, name)
                            digest = hashlib.sha256(canonical).hexdigest()
                            if digest in canonical_digests:
                                raise ExportError("two illustrations become identical after canonicalization")
                            canonical_digests.add(digest)
                            archive_name = f"illustrations/{name}"
                            descriptor_data = {
                                "id": pose_id,
                                "file": archive_name,
                                "sha256": digest,
                                "bytes": len(canonical),
                            }
                            species_poses.setdefault(slug, {})[pose_id] = descriptor_data
                            archive.writestr(_zip_info(archive_name), canonical)
                            archive_names.append(archive_name)
                            if os.fstat(stage_handle.fileno()).st_size > MAX_ARCHIVE_BYTES:
                                raise ExportError("export archive exceeds 768 MiB")
                        species: list[dict] = []
                        for slug in sorted(species_poses, key=lambda item: taxonomy[item][0]):
                            scientific, common = taxonomy[slug]
                            poses = species_poses[slug]
                            ordered = [poses[key] for key in ("perched", "flight") if key in poses]
                            bird: dict = {"scientific_name": scientific, "poses": ordered}
                            if common is not None:
                                bird["common_name"] = common
                            species.append(bird)
                        if len(species) > MAX_SPECIES:
                            raise ExportError("illustration library exceeds the hosted species limit")
                        manifest, manifest_bytes = _manifest(species)
                        archive.writestr(_zip_info(LICENSE_FILE), _license_bytes())
                        archive.writestr(_zip_info("manifest.json"), manifest_bytes)
                    _recheck_inventory(directory_fd, directory_identity, identities)
                    if os.fstat(stage_handle.fileno()).st_size > MAX_ARCHIVE_BYTES:
                        raise ExportError("export archive exceeds 768 MiB")
                    stage_handle.flush()
                    os.fsync(stage_handle.fileno())
                    checked = _validate_archive(stage_handle, manifest, manifest_bytes, archive_names)
                    stage_opened = os.fstat(stage_handle.fileno())
                    try:
                        stage_path = stage.lstat()
                    except OSError as exc:
                        raise ExportError("export stage path changed during export") from exc
                    if (
                        not stat.S_ISREG(stage_path.st_mode)
                        or stage_path.st_nlink != 1
                        or stat.S_IMODE(stage_path.st_mode) != 0o600
                        or stage_path.st_uid != os.geteuid()
                        or (stage_path.st_dev, stage_path.st_ino)
                        != (stage_identity.st_dev, stage_identity.st_ino)
                        or (stage_path.st_dev, stage_path.st_ino)
                        != (stage_opened.st_dev, stage_opened.st_ino)
                    ):
                        raise ExportError("export stage path changed during export")
                    try:
                        current = output.lstat()
                    except FileNotFoundError:
                        pass
                    else:
                        if stat.S_ISLNK(current.st_mode) or not stat.S_ISREG(current.st_mode) or current.st_nlink != 1:
                            raise ExportError("output path became unsafe during export")
                    os.replace(stage, output)
                    stage = None
                    published = output.lstat()
                    if (published.st_dev, published.st_ino) != (
                        stage_opened.st_dev,
                        stage_opened.st_ino,
                    ):
                        raise ExportError("output path changed during atomic publish")
                    _fsync_directory(output_parent)
            finally:
                if stage is not None:
                    with contextlib.suppress(FileNotFoundError):
                        stage.unlink()
        finally:
            os.close(directory_fd)
    return {
        "ok": True,
        "id": manifest["id"],
        "version": manifest["version"],
        "name": manifest["name"],
        "region": manifest["coverage"]["label"],
        "style": manifest["style"]["name"],
        "species": checked["species"],
        "objects": checked["objects"],
        "license": LICENSE_SPDX,
        "method": manifest["provenance"]["method"],
        "model": manifest["provenance"]["model"],
        "creator": manifest["attribution"]["creator"],
        "archive_sha256": checked["archive_sha256"],
        "archive": str(output),
    }


def _default_existing(paths: Sequence[Path]) -> list[Path]:
    return [path for path in paths if path.exists() and not path.is_symlink()]


@contextlib.contextmanager
def _interruptible_export() -> Iterator[None]:
    previous: dict[int, object] = {}

    def interrupted(signum: int, _frame: object) -> None:
        raise ExportInterrupted(f"bundle export interrupted by signal {signum}")

    for signum in (signal.SIGINT, signal.SIGTERM):
        previous[signum] = signal.getsignal(signum)
        signal.signal(signum, interrupted)
    try:
        yield
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--illustrations", type=Path, default=DEFAULT_ILLUSTRATIONS)
    parser.add_argument("--catalog", action="append", type=Path, default=[])
    parser.add_argument("--label-file", action="append", type=Path, default=[])
    parser.add_argument("--common-names", type=Path)
    parser.add_argument("--generation-lock", type=Path, default=DEFAULT_GENERATION_LOCK)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    catalogs = args.catalog or _default_existing(DEFAULT_CATALOGS)
    labels = args.label_file or _default_existing(DEFAULT_LABELS)
    if args.common_names is not None:
        common_names = args.common_names
    else:
        common_names = DEFAULT_COMMON_NAMES if DEFAULT_COMMON_NAMES.exists() else None
    try:
        with _interruptible_export():
            result = export_bundle(
                args.illustrations,
                catalogs,
                labels,
                common_names,
                args.output,
                args.generation_lock,
            )
        print(json.dumps(result, separators=(",", ":")))
        return 0
    except ExportError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, separators=(",", ":")))
        return 1
    except (EOFError, OSError, RuntimeError, zipfile.BadZipFile, zipfile.LargeZipFile):
        print(json.dumps(
            {"ok": False, "error": "bundle export could not safely access its local files"},
            separators=(",", ":"),
        ))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
