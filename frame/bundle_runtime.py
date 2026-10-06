#!/usr/bin/env python3
"""Catalog-bound illustration bundle runtime for a standalone bird frame.

The caller supplies an inert bundle ID (preferred) or an exact manifest URL
already present in the freshly fetched Avian Visitors catalog. The caller's URL
is never fetched directly. Every manifest and PNG is checksum-addressed,
bounded, decoded before publication, and activated with one atomic state write.
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import ctypes
import datetime as dt
import fcntl
import hashlib
import http.client
import io
import ipaddress
import importlib.util
import json
import os
import re
import shutil
import socket
import ssl
import stat
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
import uuid
import warnings
from pathlib import Path
from typing import Any, Callable, Iterable

try:
    import tomllib
except ModuleNotFoundError:  # Python < 3.11
    import tomli as tomllib


CATALOG_URL = "https://avianvisitors.com/api/bundles/catalog/community-v1.json"
ORIGIN = "https://avianvisitors.com"
MANIFEST_BASE = ORIGIN + "/api/bundles/manifests/"
OBJECT_BASE = ORIGIN + "/api/bundles/objects/"
ALLOWED_HOSTS = frozenset({"avianvisitors.com"})
CATALOG_FORMAT = "avian-visitors-bundle-catalog"
VENDOR_CATALOG_FORMAT = "avian-visitors-frame-bundle-catalog"
MANIFEST_FORMAT = "avian-visitors-asset-pack"
ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,79}$")
VERSION_RE = re.compile(
    r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
    r"(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)
HASH_RE = re.compile(r"^[0-9a-f]{64}$")
SCI_RE = re.compile(r"^[A-Z][A-Za-z-]{1,39}(?: [a-z][A-Za-z-]{1,39}){1,3}$")
REGION_RE = re.compile(r"^[A-Z]{2}(?:-[A-Z0-9]{1,8}){0,3}$")
CATALOG_MAX = 2 * 1024 * 1024
CATALOG_HISTORY_MAX = 4 * 1024 * 1024
CATALOG_HISTORY_ENTRIES_MAX = 10_000
MANIFEST_MAX = 4 * 1024 * 1024
TABLE_MAX = 24 * 1024 * 1024
IMAGE_MAX = 4 * 1024 * 1024
TOTAL_MAX = 1024 * 1024 * 1024
SPECIES_MAX = 5000
PREVIEWS_MAX = 6
IMAGE_DIM_MAX = 4096
IMAGE_PIXELS_MAX = 16_000_000
FREE_SPACE_RESERVE = 128 * 1024 * 1024
CONFIG_MAX = 256 * 1024
SELECTION_MAX = 2 * 1024 * 1024
DEFAULT_CONFIG = "~/.birdframe/config.toml"
DEFAULT_BUNDLE_ROOT = "~/.birdframe/bundles"
LICENSES = frozenset({"CC0-1.0", "CC-BY-4.0", "CC-BY-SA-4.0", "CC-BY-NC-SA-4.0"})


class BundleError(RuntimeError):
    def __init__(self, message: str, code: str = "bundle_error") -> None:
        super().__init__(message)
        self.code = code


def _sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _json(raw: bytes, label: str) -> dict[str, Any]:
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BundleError(f"{label} is not valid JSON", "invalid_json") from error
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        raise BundleError(f"{label} must be an object", "invalid_json")
    return value


def _exact_keys(
    value: dict[str, Any],
    required: set[str],
    optional: set[str],
    label: str,
    code: str,
) -> None:
    keys = set(value)
    if required - keys or keys - required - optional:
        raise BundleError(f"{label} has unsupported or missing fields", code)


def _canonical(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def _checked_id(value: Any) -> str:
    if not isinstance(value, str) or ID_RE.fullmatch(value) is None:
        raise BundleError("bundle id is invalid", "invalid_id")
    return value


def _checked_version(value: Any) -> str:
    if not isinstance(value, str) or len(value) > 64 or VERSION_RE.fullmatch(value) is None:
        raise BundleError("bundle version is invalid", "invalid_version")
    prerelease = value.split("+", 1)[0].partition("-")[2]
    if prerelease and any(
        part.isdigit() and len(part) > 1 and part.startswith("0")
        for part in prerelease.split(".")
    ):
        raise BundleError("bundle version is invalid", "invalid_version")
    return value


def _version_key(value: str) -> tuple[Any, ...]:
    version = _checked_version(value).split("+", 1)[0]
    core, separator, prerelease = version.partition("-")
    major, minor, patch = (int(part) for part in core.split("."))
    if not separator:
        suffix: tuple[Any, ...] = (1, ())
    else:
        suffix = (
            0,
            tuple(
                (0, int(part)) if part.isascii() and part.isdigit() else (1, part)
                for part in prerelease.split(".")
            ),
        )
    return major, minor, patch, suffix


def _checked_hash(value: Any, label: str = "SHA-256") -> str:
    if not isinstance(value, str) or HASH_RE.fullmatch(value) is None:
        raise BundleError(f"{label} is invalid", "invalid_hash")
    return value


def _checked_name(value: Any, label: str, maximum: int = 120) -> str:
    if not isinstance(value, str):
        raise BundleError(f"{label} is invalid", "invalid_text")
    clean = " ".join(value.split())
    if (
        not clean
        or len(clean) > maximum
        or any(
            ord(character) < 32
            or ord(character) == 127
            or 0xD800 <= ord(character) <= 0xDFFF
            for character in value
        )
        or "<" in value
        or ">" in value
    ):
        raise BundleError(f"{label} is invalid", "invalid_text")
    return clean


def _checked_optional_text(value: Any, label: str, maximum: int) -> str:
    if value is None or value == "":
        return ""
    return _checked_name(value, label, maximum)


def _checked_optional_public_text(value: Any, label: str, maximum: int) -> str:
    if value is None or value == "":
        return ""
    if not isinstance(value, str):
        raise BundleError(f"{label} is invalid", "invalid_text")
    clean = " ".join(value.split()).strip()
    if (
        not clean
        or len(clean) > maximum
        or any(
            ord(character) < 32 or 0xD800 <= ord(character) <= 0xDFFF
            for character in value
        )
        or "<" in value
        or ">" in value
    ):
        raise BundleError(f"{label} is invalid", "invalid_text")
    return clean


def _checked_string_list(
    value: Any,
    label: str,
    maximum: int,
    item_maximum: int,
    pattern: re.Pattern[str] | None = None,
    code: str = "invalid_catalog",
) -> list[str]:
    if not isinstance(value, list) or len(value) > maximum:
        raise BundleError(f"{label} is invalid", code)
    output: list[str] = []
    seen: set[str] = set()
    for raw in value:
        item = _checked_name(raw, label, item_maximum)
        if item in seen or (pattern is not None and pattern.fullmatch(item) is None):
            raise BundleError(f"{label} is invalid", code)
        output.append(item)
        seen.add(item)
    return output


def _checked_source_url(value: Any) -> str:
    if value is None or value == "":
        return ""
    if (
        not isinstance(value, str)
        or len(value) > 500
        or any(character in value for character in "\\<>")
        or any(ord(character) < 32 or ord(character) == 127 for character in value)
    ):
        raise BundleError("source URL is invalid", "invalid_manifest")
    try:
        parsed = urllib.parse.urlsplit(value)
        parsed.port
    except ValueError as error:
        raise BundleError("source URL is invalid", "invalid_manifest") from error
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
    ):
        raise BundleError("source URL is invalid", "invalid_manifest")
    return urllib.parse.urlunsplit(parsed)


def _checked_repository_url(value: Any) -> str:
    url = _checked_source_url(value)
    parsed = urllib.parse.urlsplit(url)
    decoded = urllib.parse.unquote(parsed.path)
    if (
        (parsed.hostname or "").lower() != "github.com"
        or parsed.port is not None
        or parsed.fragment
        or not parsed.path.startswith("/")
        or "\\" in decoded
        or "\x00" in decoded
        or any(part in {".", ".."} for part in decoded.split("/"))
    ):
        raise BundleError("repository URL is invalid", "invalid_catalog")
    return url


def _checked_url(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 500:
        raise BundleError(f"{label} is invalid", "invalid_url")
    try:
        parsed = urllib.parse.urlsplit(value)
        port = parsed.port
    except ValueError as error:
        raise BundleError(f"{label} is invalid", "invalid_url") from error
    decoded = urllib.parse.unquote(parsed.path)
    if (
        parsed.scheme != "https"
        or (parsed.hostname or "").lower() not in ALLOWED_HOSTS
        or parsed.username is not None
        or parsed.password is not None
        or port is not None
        or parsed.query
        or parsed.fragment
        or "\\" in decoded
        or "\x00" in decoded
        or any(part in {".", ".."} for part in decoded.split("/"))
    ):
        raise BundleError(f"{label} is not an Avian Visitors checksum route", "invalid_url")
    return urllib.parse.urlunsplit(parsed)


def _manifest_url(digest: str) -> str:
    return MANIFEST_BASE + digest + ".json"


def _object_url(digest: str) -> str:
    return OBJECT_BASE + digest + ".png"


def _catalog_timestamp(value: Any) -> dt.datetime:
    if not isinstance(value, str) or len(value) > 32:
        raise BundleError("catalog date is invalid", "invalid_catalog")
    try:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            return dt.datetime.combine(dt.date.fromisoformat(value), dt.time(), dt.timezone.utc)
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", value):
            return dt.datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(
                tzinfo=dt.timezone.utc
            )
    except ValueError as error:
        raise BundleError("catalog date is invalid", "invalid_catalog") from error
    raise BundleError("catalog date is invalid", "invalid_catalog")


def _root(path: str | os.PathLike[str] | None = None) -> Path:
    configured = (
        os.environ.get("AVIAN_FRAME_BUNDLE_ROOT", DEFAULT_BUNDLE_ROOT)
        if path is None
        else path
    )
    expanded = Path(configured).expanduser()
    if not expanded.is_absolute():
        raise BundleError("bundle root must be absolute", "invalid_configuration")
    return expanded


def _frame_config_path() -> Path:
    path = Path(DEFAULT_CONFIG).expanduser()
    if not path.is_absolute():
        raise BundleError("frame config path must be absolute", "invalid_configuration")
    return path


def _configured_bundle_root(config_path: Path | None = None) -> Path:
    """Resolve the CLI store from the same config file used by the renderer.

    The CLI deliberately ignores AVIAN_FRAME_BUNDLE_ROOT. That override remains
    useful for direct library tests, but an installed command must never write
    an active state that the timer's renderer cannot see.
    """
    value = _load_frame_config(config_path)
    configured = value.get("bundle_root", DEFAULT_BUNDLE_ROOT)
    if not isinstance(configured, str) or not configured or "\x00" in configured:
        raise BundleError("bundle root is invalid", "invalid_configuration")
    return _root(configured)


def _load_frame_config(config_path: Path | None = None) -> dict[str, Any]:
    path = config_path or _frame_config_path()
    if path.exists() or path.is_symlink():
        raw = _safe_file(path, CONFIG_MAX, allow_writable=True)
        try:
            value = tomllib.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, tomllib.TOMLDecodeError) as error:
            raise BundleError("frame config is invalid", "invalid_configuration") from error
        if not isinstance(value, dict):
            raise BundleError("frame config is invalid", "invalid_configuration")
        return value
    return {}


def _load_checkout_module(name: str, path: Path) -> Any:
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise BundleError("the frame location helper is unavailable", "location_unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _selection_species(value: Any, maximum: int = 12000) -> list[str]:
    if not isinstance(value, list) or not 1 <= len(value) <= maximum or any(
        not isinstance(name, str) or SCI_RE.fullmatch(name) is None for name in value
    ) or value != sorted(set(value)):
        raise BundleError("the location species list is invalid", "invalid_selection")
    return value


def _selection_basis(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {"schema_version", "species", "basis_sha256"} or \
            type(value["schema_version"]) is not int or value["schema_version"] != 1:
        raise BundleError("the location species response is invalid", "invalid_selection")
    return {
        "schema_version": 1,
        "species": _selection_species(value["species"]),
        "basis_sha256": _checked_hash(value["basis_sha256"], "location basis"),
    }


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        raise BundleError("the station location endpoint redirected", "location_unavailable")


def _mirror_selection_basis(config: dict[str, Any]) -> dict[str, Any] | None:
    base = config.get("base_url", "http://birdnet.local")
    if not isinstance(base, str) or any(character in base for character in "\\\r\n\x00"):
        raise BundleError("the station URL is invalid", "invalid_configuration")
    try:
        parsed = urllib.parse.urlsplit(base)
        parsed.port
    except ValueError as error:
        raise BundleError("the station URL is invalid", "invalid_configuration") from error
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username is not None or \
            parsed.password is not None or parsed.query or parsed.fragment:
        raise BundleError("the station URL is invalid", "invalid_configuration")
    request = urllib.request.Request(base.rstrip("/") + "/avian/api/bundle-species.php", headers={
        "Accept": "application/json", "User-Agent": "AvianVisitors-frame/1.0",
    })
    if config.get("basic_user"):
        credentials = f"{config['basic_user']}:{config.get('basic_pass') or ''}".encode()
        request.add_header("Authorization", "Basic " + base64.b64encode(credentials).decode())
    try:
        opener = urllib.request.build_opener(_NoRedirect())
        with opener.open(request, timeout=30) as response:
            raw = response.read(SELECTION_MAX + 1)
        if len(raw) > SELECTION_MAX:
            raise BundleError("the station species response is too large", "location_unavailable")
        value = _json(raw, "station species response")
        if set(value) != {"ok", "schema_version", "species", "basis_sha256"} or value["ok"] is not True:
            raise BundleError("the station species response is invalid", "location_unavailable")
        if type(value["schema_version"]) is not int or value["schema_version"] != 1:
            raise BundleError("the station species response is invalid", "location_unavailable")
        if value["species"] is None and value["basis_sha256"] is None:
            return None
        return _selection_basis({key: item for key, item in value.items() if key != "ok"})
    except Exception as error:
        raise BundleError("the station location could not be resolved; retry or use --all-species", "location_unavailable") from error


def _resolve_selection_basis(config: dict[str, Any]) -> dict[str, Any] | None:
    if config.get("species_source") == "birdweather":
        frame = Path(__file__).resolve().parent
        weather = _load_checkout_module("avian_frame_weather", frame / "birdweather.py")
        station = config.get("bw_station_id")
        postal = config.get("zip")
        has_station = station not in (None, "", 0)
        has_postal = isinstance(postal, str) and bool(postal.strip())
        if has_station and has_postal:
            raise BundleError("BirdWeather config must use either bw_station_id or zip", "invalid_configuration")
        if not has_station and not has_postal:
            return None
        try:
            days = config.get("bw_days", 7)
            if type(days) is not int or not 1 <= days <= 365:
                raise BundleError("BirdWeather days must be from 1 through 365", "invalid_configuration")
            if has_station:
                latitude, longitude = weather.station_location(station)
            else:
                latitude, longitude = weather.geocode(postal.strip(), config.get("bw_country", "us"))
            helper = _load_checkout_module("avian_frame_bundle_species", frame.parent / "avian" / "scripts" / "bundle_species.py")
            basis = _selection_basis(helper.annual_species(latitude, longitude, frame.parent / "model"))
            observations = (
                [weather.top_species_for_station(station, days=days, limit=200)]
                if has_station else
                [weather.top_species(latitude, longitude, miles, days=days, limit=200) for miles in (15, 30, 50)]
            )
            extras: set[str] = set()
            for rows in observations:
                if not isinstance(rows, list) or len(rows) > 200:
                    raise BundleError("BirdWeather returned an invalid species list", "location_unavailable")
                for row in rows:
                    name = row.get("sci") if isinstance(row, dict) else None
                    if isinstance(name, str) and SCI_RE.fullmatch(name):
                        extras.add(name)
            return _selection_basis({
                "schema_version": 1,
                "species": sorted(set(basis["species"]) | extras),
                "basis_sha256": _sha(_canonical({"model": basis["basis_sha256"], "extras": sorted(extras)})),
            })
        except Exception as error:
            raise BundleError("the frame location could not be resolved; retry or use --all-species", "location_unavailable") from error
    if config.get("shoot") is True:
        return _mirror_selection_basis(config)
    return None


def _safe_dir(path: Path, *, create: bool = False, mode: int = 0o700) -> None:
    created = False
    if create:
        try:
            path.lstat()
        except FileNotFoundError:
            created = True
        path.mkdir(parents=True, mode=mode, exist_ok=True)
    try:
        info = path.lstat()
    except OSError as error:
        raise BundleError("bundle storage is unavailable", "storage_unavailable") from error
    if (
        not stat.S_ISDIR(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != os.geteuid()
        or info.st_mode & 0o022
    ):
        raise BundleError("bundle storage is unsafe", "unsafe_storage")
    if create and stat.S_IMODE(info.st_mode) != mode:
        os.chmod(path, mode)
    if created:
        _fsync_dir(path)
        _fsync_dir(path.parent)


def _ensure_root(root: Path) -> None:
    old_umask = os.umask(0o077)
    try:
        _safe_dir(root, create=True)
        for name in ("objects", "objects/sha256", "packs", "staging"):
            _safe_dir(root / name, create=True)
    finally:
        os.umask(old_umask)


def _safe_file(path: Path, maximum: int, *, allow_writable: bool = False) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise BundleError(f"{path.name} is unavailable", "missing_file") from error
    try:
        before = path.lstat()
        info = os.fstat(descriptor)
        if (
            not stat.S_ISREG(info.st_mode)
            or stat.S_ISLNK(before.st_mode)
            or info.st_uid != os.geteuid()
            or info.st_nlink != 1
            or (not allow_writable and info.st_mode & 0o022)
            or info.st_dev != before.st_dev
            or info.st_ino != before.st_ino
            or not 0 < info.st_size <= maximum
        ):
            raise BundleError(f"{path.name} is unsafe", "unsafe_file")
        raw = b""
        while len(raw) < info.st_size:
            chunk = os.read(descriptor, min(1024 * 1024, info.st_size - len(raw)))
            if not chunk:
                raise BundleError(f"{path.name} changed while reading", "changed_file")
            raw += chunk
        if os.read(descriptor, 1):
            raise BundleError(f"{path.name} changed while reading", "changed_file")
        return raw
    finally:
        os.close(descriptor)


def _safe_size(path: Path, maximum: int) -> int:
    """Validate a regular stored object without reading its full image body."""
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise BundleError(f"{path.name} is unavailable", "missing_file") from error
    try:
        before = path.lstat()
        info = os.fstat(descriptor)
        if (
            not stat.S_ISREG(info.st_mode)
            or stat.S_ISLNK(before.st_mode)
            or info.st_uid != os.geteuid()
            or info.st_nlink != 1
            or info.st_mode & 0o022
            or info.st_dev != before.st_dev
            or info.st_ino != before.st_ino
            or not 0 < info.st_size <= maximum
        ):
            raise BundleError(f"{path.name} is unsafe", "unsafe_file")
        return info.st_size
    finally:
        os.close(descriptor)


def _fsync_dir(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _exchange_directories(first: Path, second: Path) -> None:
    """Atomically swap two verified same-filesystem directories."""
    _safe_dir(first)
    _safe_dir(second)
    libc = ctypes.CDLL(None, use_errno=True)
    first_raw = os.fsencode(first)
    second_raw = os.fsencode(second)
    if sys.platform.startswith("linux") and hasattr(libc, "renameat2"):
        rename = libc.renameat2
        rename.argtypes = [
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        ]
        rename.restype = ctypes.c_int
        result = rename(-100, first_raw, -100, second_raw, 2)
    elif sys.platform == "darwin" and hasattr(libc, "renamex_np"):
        rename = libc.renamex_np
        rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        rename.restype = ctypes.c_int
        result = rename(first_raw, second_raw, 2)
    else:
        raise BundleError("atomic bundle repair is unavailable", "unsupported_platform")
    if result != 0:
        number = ctypes.get_errno()
        raise BundleError("atomic bundle repair failed", "repair_failed") from OSError(
            number, os.strerror(number)
        )


def _atomic(path: Path, raw: bytes, mode: int = 0o600) -> None:
    _safe_dir(path.parent)
    descriptor, temporary = tempfile.mkstemp(prefix="." + path.name + ".", dir=path.parent)
    temporary_path = Path(temporary)
    try:
        os.fchmod(descriptor, mode)
        offset = 0
        while offset < len(raw):
            offset += os.write(descriptor, raw[offset:])
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = -1
        os.replace(temporary_path, path)
        _fsync_dir(path.parent)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            temporary_path.unlink()
        except FileNotFoundError:
            pass


@contextlib.contextmanager
def operation_lock(root: Path) -> Iterable[None]:
    _ensure_root(root)
    path = root / "operation.lock"
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        before = path.lstat()
        info = os.fstat(descriptor)
        if (
            not stat.S_ISREG(info.st_mode)
            or stat.S_ISLNK(before.st_mode)
            or info.st_uid != os.geteuid()
            or info.st_nlink != 1
            or info.st_mode & 0o077
            or info.st_dev != before.st_dev
            or info.st_ino != before.st_ino
        ):
            raise BundleError("bundle operation lock is unsafe", "unsafe_lock")
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        os.close(descriptor)


class _PinnedHTTPS(http.client.HTTPSConnection):
    def __init__(self, host: str, address: str) -> None:
        super().__init__(host, 443, timeout=30, context=ssl.create_default_context())
        self._address = address

    def connect(self) -> None:
        handle = socket.create_connection((self._address, 443), self.timeout)
        try:
            self.sock = self._context.wrap_socket(handle, server_hostname=self.host)
        except Exception:
            handle.close()
            raise


def _public_addresses(host: str) -> list[str]:
    try:
        records = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    except socket.gaierror as error:
        raise BundleError("bundle host could not be resolved", "download_failed") from error
    result: list[str] = []
    for record in records:
        address = str(ipaddress.ip_address(record[4][0]))
        if not ipaddress.ip_address(address).is_global:
            raise BundleError("bundle host resolved to a private address", "unsafe_download")
        if address not in result:
            result.append(address)
    if not result:
        raise BundleError("bundle host has no public address", "download_failed")
    return result


def _dev_download(url: str) -> bytes | None:
    configured = os.environ.get("AVIAN_FRAME_BUNDLE_DEV_ROOT")
    if not configured:
        return None
    root = Path(configured)
    if not root.is_absolute():
        raise BundleError("developer bundle root must be absolute", "invalid_configuration")
    if url == CATALOG_URL:
        path = root / "catalog.json"
        maximum = CATALOG_MAX
    else:
        parsed = urllib.parse.urlsplit(url)
        name = Path(parsed.path).name
        if parsed.path.startswith("/api/bundles/manifests/"):
            path, maximum = root / "manifests" / name, MANIFEST_MAX
        elif parsed.path.startswith("/api/bundles/objects/"):
            path, maximum = root / "objects" / name, IMAGE_MAX
        else:
            raise BundleError("developer download route is invalid", "invalid_url")
    return _safe_file(path, maximum, allow_writable=True)


def _download(url: str, maximum: int, expected: int | None = None) -> bytes:
    current = _checked_url(url, "download URL")
    local = _dev_download(current)
    if local is not None:
        if expected is not None and len(local) != expected:
            raise BundleError("bundle download size is incorrect", "size_mismatch")
        return local
    parsed = urllib.parse.urlsplit(current)
    host = parsed.hostname or ""
    target = parsed.path
    last_error: Exception | None = None
    for address in _public_addresses(host):
        connection = _PinnedHTTPS(host, address)
        try:
            connection.request(
                "GET",
                target,
                headers={
                    "Accept": "application/json,image/png",
                    "Accept-Encoding": "identity",
                    "User-Agent": "AvianVisitors-frame/1 bundle-runtime",
                },
            )
            response = connection.getresponse()
            if response.status != 200:
                response.read(4096)
                raise BundleError("bundle download was not available", "download_failed")
            media_type = (response.getheader("Content-Type") or "").split(";", 1)[0].strip().lower()
            allowed_media = (
                {"image/png", "application/octet-stream"}
                if parsed.path.endswith(".png")
                else {"application/json", "application/octet-stream"}
            )
            if media_type not in allowed_media:
                raise BundleError("bundle response has the wrong media type", "invalid_response")
            declared = response.getheader("Content-Length")
            if declared is not None and (
                not declared.isdigit()
                or int(declared) > maximum
                or (expected is not None and int(declared) != expected)
            ):
                raise BundleError("bundle download size is incorrect", "size_mismatch")
            raw = response.read(maximum + 1)
            if not raw or len(raw) > maximum or response.read(1):
                raise BundleError("bundle download is too large", "size_mismatch")
            if expected is not None and len(raw) != expected:
                raise BundleError("bundle download size is incorrect", "size_mismatch")
            return raw
        except BundleError:
            raise
        except (OSError, ssl.SSLError, http.client.HTTPException) as error:
            last_error = error
        finally:
            connection.close()
    raise BundleError("bundle download failed", "download_failed") from last_error


def _validate_catalog_manifest(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise BundleError("catalog manifest is invalid", "invalid_catalog")
    _exact_keys(
        value,
        {"url", "sha256", "bytes"},
        set(),
        "catalog manifest",
        "invalid_catalog",
    )
    digest = _checked_hash(value["sha256"], "manifest SHA-256")
    url = _checked_url(value["url"], "manifest URL")
    size = value["bytes"]
    if (
        url != _manifest_url(digest)
        or isinstance(size, bool)
        or not isinstance(size, int)
        or not 2 <= size <= MANIFEST_MAX
    ):
        raise BundleError("catalog manifest is not checksum-addressed", "invalid_catalog")
    return {"url": url, "sha256": digest, "bytes": size}


def _validate_catalog_preview(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise BundleError("catalog preview is invalid", "invalid_catalog")
    _exact_keys(
        value,
        {"scientific_name", "common_name", "pose", "sha256", "bytes"},
        set(),
        "catalog preview",
        "invalid_catalog",
    )
    scientific = _checked_name(
        value["scientific_name"], "preview scientific name", 163
    )
    size = value["bytes"]
    if (
        SCI_RE.fullmatch(scientific) is None
        or not isinstance(value["pose"], str)
        or value["pose"] not in {"perched", "flight"}
        or isinstance(size, bool)
        or not isinstance(size, int)
        or not 67 <= size <= IMAGE_MAX
    ):
        raise BundleError("catalog preview is invalid", "invalid_catalog")
    return {
        "scientific_name": scientific,
        "common_name": _checked_optional_public_text(
            value["common_name"], "common name", 100
        ),
        "pose": value["pose"],
        "sha256": _checked_hash(value["sha256"], "preview SHA-256"),
        "bytes": size,
    }


def _validate_community_pack(source: dict[str, Any]) -> dict[str, Any]:
    required = {
        "id", "version", "name", "description", "creator", "repository_url",
        "coverage", "style", "species_count", "species", "review",
        "availability", "manifest", "archive_bytes", "previews", "license",
    }
    _exact_keys(source, required, set(), "community catalog row", "invalid_catalog")
    pack_id = _checked_id(source["id"])
    if pack_id.startswith("official-"):
        raise BundleError("community catalog used the official namespace", "catalog_collision")
    if source["review"] != "community" or source["availability"] != "installable":
        raise BundleError("community catalog row is not community-installable", "invalid_catalog")
    if not isinstance(source["license"], str) or source["license"] not in LICENSES:
        raise BundleError("bundle license is unsupported", "invalid_catalog")

    coverage = source["coverage"]
    if not isinstance(coverage, dict):
        raise BundleError("catalog coverage is invalid", "invalid_catalog")
    _exact_keys(
        coverage,
        {"label", "group", "region_codes"},
        set(),
        "catalog coverage",
        "invalid_catalog",
    )
    coverage_group = _checked_name(coverage["group"], "coverage group", 30)
    region_codes = _checked_string_list(
        coverage["region_codes"], "region codes", 32, 40, REGION_RE
    )
    if coverage_group == "global" and region_codes:
        raise BundleError("catalog global coverage has region codes", "invalid_catalog")

    style = source["style"]
    if not isinstance(style, dict):
        raise BundleError("catalog style is invalid", "invalid_catalog")
    _exact_keys(
        style,
        {"id", "name", "category", "tags"},
        set(),
        "catalog style",
        "invalid_catalog",
    )
    raw_species = source["species"]
    species = _checked_string_list(raw_species, "catalog species", SPECIES_MAX, 163, SCI_RE)
    count = source["species_count"]
    if (
        not species
        or isinstance(count, bool)
        or not isinstance(count, int)
        or count != len(species)
    ):
        raise BundleError("catalog species inventory is invalid", "invalid_catalog")
    archive_bytes = source["archive_bytes"]
    if (
        isinstance(archive_bytes, bool)
        or not isinstance(archive_bytes, int)
        or not 1 <= archive_bytes <= TOTAL_MAX
    ):
        raise BundleError("catalog archive size is invalid", "invalid_catalog")
    raw_previews = source["previews"]
    if not isinstance(raw_previews, list) or not 1 <= len(raw_previews) <= PREVIEWS_MAX:
        raise BundleError("catalog previews are invalid", "invalid_catalog")
    return {
        "id": pack_id,
        "version": _checked_version(source["version"]),
        "name": _checked_name(source["name"], "bundle name", 90),
        "description": _checked_optional_public_text(
            source["description"], "description", 260
        ),
        "creator": _checked_name(source["creator"], "creator", 100),
        "repository_url": _checked_repository_url(source["repository_url"]),
        "coverage": {
            "label": _checked_name(coverage["label"], "coverage label", 90),
            "group": coverage_group,
            "region_codes": region_codes,
        },
        "style": {
            "id": _checked_id(style["id"]),
            "name": _checked_name(style["name"], "style name", 90),
            "category": _checked_name(style["category"], "style category", 30),
            "tags": _checked_string_list(style["tags"], "style tags", 16, 30),
        },
        "species_count": count,
        "species": species,
        "review": "community",
        "license": source["license"],
        "availability": "installable",
        "manifest": _validate_catalog_manifest(source["manifest"]),
        "archive_bytes": archive_bytes,
        "previews": [_validate_catalog_preview(item) for item in raw_previews],
    }


def _validate_catalog(
    raw: bytes, label: str, *, community: bool = False
) -> dict[str, Any]:
    value = _json(raw, label)
    _exact_keys(
        value,
        {"format", "format_version", "updated", "object_base_url", "packs"},
        set(),
        label,
        "invalid_catalog",
    )
    expected_format = CATALOG_FORMAT if community else VENDOR_CATALOG_FORMAT
    if value["format"] != expected_format or value["format_version"] != 1:
        raise BundleError("bundle catalog format is unsupported", "invalid_catalog")
    updated = value["updated"]
    _catalog_timestamp(updated)
    if value["object_base_url"] != OBJECT_BASE:
        raise BundleError("bundle catalog object route is invalid", "invalid_catalog")
    source_packs = value["packs"]
    if (
        not isinstance(source_packs, list)
        or len(source_packs) > 1000
        or (not community and not source_packs)
    ):
        raise BundleError("bundle catalog pack list is invalid", "invalid_catalog")
    packs: list[dict[str, Any]] = []
    seen: set[str] = set()
    for source in source_packs:
        if not isinstance(source, dict):
            raise BundleError("bundle catalog row is invalid", "invalid_catalog")
        if community:
            pack = _validate_community_pack(source)
        else:
            _exact_keys(
                source,
                {"id", "version", "name", "availability", "manifest"},
                set(),
                "vendored catalog row",
                "invalid_catalog",
            )
            pack_id = _checked_id(source["id"])
            if not pack_id.startswith("official-") or source["availability"] != "installable":
                raise BundleError("vendored bundle row is invalid", "invalid_catalog")
            pack = {
                "id": pack_id,
                "version": _checked_version(source["version"]),
                "name": _checked_name(source["name"], "bundle name", 90),
                "availability": "installable",
                "manifest": _validate_catalog_manifest(source["manifest"]),
            }
        if pack["id"] in seen:
            raise BundleError("bundle catalog repeats an id", "invalid_catalog")
        seen.add(pack["id"])
        packs.append(pack)
    return {
        "format": expected_format,
        "format_version": 1,
        "updated": updated,
        "object_base_url": OBJECT_BASE,
        "packs": packs,
    }


def _vendor_catalog() -> dict[str, Any]:
    path = Path(__file__).resolve().parent / "vendor" / "catalog-v1.json"
    return _validate_catalog(_safe_file(path, CATALOG_MAX), "vendored catalog")


def _reject_future_catalog(catalog: dict[str, Any]) -> None:
    if _catalog_timestamp(catalog["updated"]) > dt.datetime.now(
        dt.timezone.utc
    ) + dt.timedelta(days=1):
        raise BundleError("community catalog date is too far in the future", "catalog_future")


def _catalog_history_path(root: Path) -> Path:
    return root / "community-catalog-bindings-v1.json"


def _empty_catalog_history() -> dict[str, Any]:
    return {
        "format": "avian-birdframe-community-catalog-bindings",
        "format_version": 1,
        "updated": None,
        "catalog_sha256": None,
        "ids": {},
    }


def _load_catalog_history(root: Path) -> tuple[dict[str, Any], bool]:
    path = _catalog_history_path(root)
    if not path.exists() and not path.is_symlink():
        return _empty_catalog_history(), False
    value = _json(_safe_file(path, CATALOG_HISTORY_MAX), "community catalog bindings")
    _exact_keys(
        value,
        {"format", "format_version", "updated", "catalog_sha256", "ids"},
        set(),
        "community catalog bindings",
        "invalid_catalog_history",
    )
    if (
        value["format"] != "avian-birdframe-community-catalog-bindings"
        or value["format_version"] != 1
        or not isinstance(value["ids"], dict)
    ):
        raise BundleError("community catalog bindings are invalid", "invalid_catalog_history")
    normalized = _empty_catalog_history()
    updated = value["updated"]
    catalog_digest = value["catalog_sha256"]
    if (updated is None) != (catalog_digest is None):
        raise BundleError("community catalog bindings are invalid", "invalid_catalog_history")
    if updated is not None:
        _catalog_timestamp(updated)
        normalized["updated"] = updated
        normalized["catalog_sha256"] = _checked_hash(
            catalog_digest, "catalog SHA-256"
        )
    total = 0
    for raw_id, raw_record in value["ids"].items():
        pack_id = _checked_id(raw_id)
        if pack_id.startswith("official-") or not isinstance(raw_record, dict):
            raise BundleError("community catalog bindings are invalid", "invalid_catalog_history")
        _exact_keys(
            raw_record,
            {"highest_version", "versions"},
            set(),
            "community catalog binding",
            "invalid_catalog_history",
        )
        highest = _checked_version(raw_record["highest_version"])
        if not isinstance(raw_record["versions"], dict) or highest not in raw_record["versions"]:
            raise BundleError("community catalog bindings are invalid", "invalid_catalog_history")
        versions: dict[str, str] = {}
        highest_key = _version_key(highest)
        precedence_seen: dict[tuple[Any, ...], str] = {}
        for raw_version, raw_digest in raw_record["versions"].items():
            version = _checked_version(raw_version)
            digest = _checked_hash(raw_digest, "catalog row SHA-256")
            precedence = _version_key(version)
            if precedence > highest_key or (
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


def _record_catalog_revision(
    history: dict[str, Any], catalog: dict[str, Any], raw: bytes
) -> None:
    updated = catalog["updated"]
    digest = _sha(raw)
    previous = history["updated"]
    if previous is not None:
        old_time = _catalog_timestamp(previous)
        new_time = _catalog_timestamp(updated)
        if new_time < old_time:
            raise BundleError("community catalog moved backwards", "catalog_rollback")
        if new_time == old_time and digest != history["catalog_sha256"]:
            raise BundleError(
                "community catalog changed without a new date", "catalog_equivocation"
            )
    history["updated"] = updated
    history["catalog_sha256"] = digest


def _record_catalog_bindings(
    history: dict[str, Any], packs: Iterable[dict[str, Any]]
) -> dict[str, Any]:
    ids = history["ids"]
    total = sum(len(record["versions"]) for record in ids.values())
    for pack in packs:
        pack_id = pack["id"]
        version = pack["version"]
        row_digest = _sha(_canonical(pack))
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
        precedence = _version_key(version)
        highest_precedence = _version_key(highest)
        if precedence < highest_precedence:
            raise BundleError("community bundle version moved backwards", "catalog_rollback")
        if precedence == highest_precedence and version != highest:
            raise BundleError(
                "community bundle precedence was rebound to new content",
                "catalog_rebinding",
            )
        bound = record["versions"].get(version)
        if bound is not None and bound != row_digest:
            raise BundleError(
                "community bundle version was rebound to new content",
                "catalog_rebinding",
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
    raw = _canonical(history)
    if len(raw) > CATALOG_HISTORY_MAX:
        raise BundleError("community catalog binding history is full", "catalog_history_full")
    return history


def refresh_catalog(root: Path) -> dict[str, Any]:
    vendor = _vendor_catalog()
    raw = _download(CATALOG_URL, CATALOG_MAX)
    community = _validate_catalog(raw, "community catalog", community=True)
    _reject_future_catalog(community)
    cache = root / "community-catalog-v1.json"
    previous: dict[str, Any] | None = None
    previous_raw = b""
    if cache.exists() or cache.is_symlink():
        try:
            previous_raw = _safe_file(cache, CATALOG_MAX)
            previous = _validate_catalog(
                previous_raw, "cached community catalog", community=True
            )
            _reject_future_catalog(previous)
        except BundleError:
            # A damaged cache, including one written by an older runtime before
            # the future-date guard existed, is not authority. A freshly
            # verified feed may safely replace it.
            previous = None
            previous_raw = b""
    if previous is not None:
        old_time = _catalog_timestamp(previous["updated"])
        new_time = _catalog_timestamp(community["updated"])
        if new_time < old_time:
            raise BundleError("community catalog moved backwards", "catalog_rollback")
        if new_time == old_time and raw != previous_raw:
            raise BundleError("community catalog changed without a new date", "catalog_equivocation")
        previous_by_id = {pack["id"]: pack for pack in previous["packs"]}
        current_by_id = {pack["id"]: pack for pack in community["packs"]}
        for pack_id in previous_by_id.keys() & current_by_id.keys():
            old_pack, new_pack = previous_by_id[pack_id], current_by_id[pack_id]
            old_precedence = _version_key(old_pack["version"])
            new_precedence = _version_key(new_pack["version"])
            if new_precedence < old_precedence:
                raise BundleError("community bundle version moved backwards", "catalog_rollback")
            if (
                new_precedence == old_precedence
                and new_pack != old_pack
            ):
                raise BundleError(
                    "community bundle precedence was rebound to new content",
                    "catalog_rebinding",
                )
    packs = list(vendor["packs"])
    ids = {pack["id"] for pack in packs}
    for pack in community["packs"]:
        if pack["id"] in ids:
            raise BundleError("community catalog shadows an official bundle", "catalog_collision")
        packs.append(pack)
        ids.add(pack["id"])
    history, existed = _load_catalog_history(root)
    if not existed and previous is not None:
        _record_catalog_bindings(history, previous["packs"])
        _record_catalog_revision(history, previous, previous_raw)
    _record_catalog_bindings(history, community["packs"])
    _record_catalog_revision(history, community, raw)
    # Publish the durable binding floor first. A power loss between these two
    # atomic replacements can make a validated feed temporarily unavailable,
    # but can never reopen an old id/version to different bytes.
    _atomic(_catalog_history_path(root), _canonical(history), 0o600)
    _atomic(cache, raw, 0o600)
    return {"packs": packs}


def resolve_selector(catalog: dict[str, Any], selector: str) -> dict[str, Any]:
    if not isinstance(selector, str) or not selector or selector != selector.strip():
        raise BundleError("bundle selector is invalid", "invalid_selector")
    if ID_RE.fullmatch(selector):
        match = next((pack for pack in catalog["packs"] if pack["id"] == selector), None)
    else:
        url = _checked_url(selector, "bundle manifest URL")
        match = next(
            (pack for pack in catalog["packs"] if pack["manifest"]["url"] == url),
            None,
        )
    if match is None:
        raise BundleError("bundle is not in the current trusted catalog", "unknown_bundle")
    return match


def _slug(scientific_name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", scientific_name.lower()).strip("-")


def _pose_slug(scientific_name: str, pose: str) -> str:
    return _slug(scientific_name) + ("-2" if pose == "flight" else "")


def _validate_manifest(raw: bytes, pack: dict[str, Any]) -> dict[str, Any]:
    value = _json(raw, "bundle manifest")
    _exact_keys(
        value,
        {
            "format", "format_version", "id", "version", "name", "style",
            "coverage", "species", "license", "attribution",
        },
        {"description", "provenance"},
        "bundle manifest",
        "invalid_manifest",
    )
    if value["format"] != MANIFEST_FORMAT or value["format_version"] != 1:
        raise BundleError("bundle manifest format is unsupported", "invalid_manifest")
    if _checked_id(value["id"]) != pack["id"] or _checked_version(value["version"]) != pack["version"]:
        raise BundleError("manifest identity does not match the catalog", "identity_mismatch")

    name = _checked_name(value["name"], "bundle name", 90)
    description = _checked_optional_public_text(
        value.get("description", "Community-maintained bird artwork."),
        "description",
        260,
    )
    style = value["style"]
    if not isinstance(style, dict):
        raise BundleError("manifest style is invalid", "invalid_manifest")
    _exact_keys(style, {"id", "name"}, set(), "manifest style", "invalid_manifest")
    normalized_style = {
        "id": _checked_id(style["id"]),
        "name": _checked_name(style["name"], "style name", 90),
    }

    coverage = value["coverage"]
    if not isinstance(coverage, dict):
        raise BundleError("manifest coverage is invalid", "invalid_manifest")
    _exact_keys(
        coverage,
        {"type", "label"},
        {"region_codes"},
        "manifest coverage",
        "invalid_manifest",
    )
    coverage_type = coverage["type"]
    if not isinstance(coverage_type, str) or coverage_type not in {
        "region", "global", "selection"
    }:
        raise BundleError("manifest coverage is invalid", "invalid_manifest")
    region_codes = _checked_string_list(
        coverage.get("region_codes", []),
        "region codes",
        32,
        40,
        REGION_RE,
        "invalid_manifest",
    )
    if (coverage_type == "region" and not region_codes) or (
        coverage_type == "global" and region_codes
    ):
        raise BundleError("manifest coverage is invalid", "invalid_manifest")
    normalized_coverage = {
        "type": coverage_type,
        "label": _checked_name(coverage["label"], "coverage label", 90),
        "region_codes": region_codes,
    }

    license_record = value["license"]
    if not isinstance(license_record, dict):
        raise BundleError("manifest license is invalid", "invalid_manifest")
    _exact_keys(
        license_record,
        {"spdx"},
        {"file"},
        "manifest license",
        "invalid_manifest",
    )
    spdx = license_record["spdx"]
    if not isinstance(spdx, str) or spdx not in LICENSES:
        raise BundleError("manifest license is unsupported", "invalid_manifest")
    if "file" in license_record and license_record["file"] and not isinstance(
        license_record["file"], str
    ):
        raise BundleError("manifest license file is invalid", "invalid_manifest")

    attribution = value["attribution"]
    if not isinstance(attribution, dict):
        raise BundleError("manifest attribution is invalid", "invalid_manifest")
    _exact_keys(
        attribution,
        {"creator"},
        {"source_url"},
        "manifest attribution",
        "invalid_manifest",
    )
    normalized_attribution = {
        "creator": _checked_name(attribution["creator"], "creator", 100),
        "source_url": _checked_source_url(attribution.get("source_url")),
    }

    provenance: dict[str, str] | None = None
    if "provenance" in value:
        source_provenance = value["provenance"]
        if not isinstance(source_provenance, dict):
            raise BundleError("manifest provenance is invalid", "invalid_manifest")
        _exact_keys(
            source_provenance,
            {"method", "review"},
            {"model"},
            "manifest provenance",
            "invalid_manifest",
        )
        method = source_provenance["method"]
        review = source_provenance["review"]
        if (
            not isinstance(method, str)
            or method not in {"manual", "generated", "mixed"}
            or not isinstance(review, str)
            or review not in {"human-reviewed", "contributor-reviewed"}
        ):
            raise BundleError("manifest provenance is invalid", "invalid_manifest")
        model = _checked_optional_text(source_provenance.get("model"), "model", 100)
        if method in {"generated", "mixed"} and not model:
            raise BundleError("generated manifest must identify its model", "invalid_manifest")
        provenance = {"method": method, "review": review, "model": model}

    species = value["species"]
    if not isinstance(species, list) or not 1 <= len(species) <= SPECIES_MAX:
        raise BundleError("manifest species list is invalid", "invalid_manifest")
    assets: dict[str, dict[str, dict[str, Any]]] = {}
    normalized_species: list[dict[str, Any]] = []
    seen_species: set[str] = set()
    seen_species_slugs: set[str] = set()
    seen_paths: set[str] = set()
    object_sizes: dict[str, int] = {}
    total = 0
    for bird in species:
        if not isinstance(bird, dict):
            raise BundleError("manifest species row is invalid", "invalid_manifest")
        _exact_keys(
            bird,
            {"scientific_name", "poses"},
            {"common_name"},
            "manifest species row",
            "invalid_manifest",
        )
        scientific = _checked_name(
            bird["scientific_name"], "scientific name", 163
        )
        if SCI_RE.fullmatch(scientific) is None:
            raise BundleError("manifest scientific name is invalid", "invalid_manifest")
        species_slug = _slug(scientific)
        if scientific in seen_species or species_slug in seen_species_slugs:
            raise BundleError("manifest scientific name is repeated", "invalid_manifest")
        seen_species.add(scientific)
        seen_species_slugs.add(species_slug)
        common_name = _checked_optional_public_text(
            bird.get("common_name"), "common name", 100
        )
        poses = bird["poses"]
        if not isinstance(poses, list) or not 1 <= len(poses) <= 2:
            raise BundleError("manifest poses are invalid", "invalid_manifest")
        pose_ids: set[str] = set()
        normalized_poses: list[dict[str, Any]] = []
        for pose in poses:
            if not isinstance(pose, dict):
                raise BundleError("manifest pose is invalid", "invalid_manifest")
            _exact_keys(
                pose,
                {"id", "file", "sha256", "bytes"},
                set(),
                "manifest pose",
                "invalid_manifest",
            )
            if not isinstance(pose["id"], str) or pose["id"] not in {"perched", "flight"}:
                raise BundleError("manifest pose is invalid", "invalid_manifest")
            pose_id = pose["id"]
            if pose_id in pose_ids:
                raise BundleError("manifest pose is repeated", "invalid_manifest")
            pose_ids.add(pose_id)
            expected_path = "illustrations/" + _pose_slug(scientific, pose_id) + ".png"
            if pose.get("file") != expected_path or expected_path in seen_paths:
                raise BundleError("manifest pose path is not canonical", "invalid_manifest")
            seen_paths.add(expected_path)
            digest = _checked_hash(pose.get("sha256"), "illustration SHA-256")
            size = pose.get("bytes")
            if isinstance(size, bool) or not isinstance(size, int) or not 67 <= size <= IMAGE_MAX:
                raise BundleError("manifest illustration size is invalid", "invalid_manifest")
            if digest in object_sizes and object_sizes[digest] != size:
                raise BundleError("manifest object sizes disagree", "invalid_manifest")
            object_sizes[digest] = size
            total += size
            if total > TOTAL_MAX:
                raise BundleError("bundle is too large", "bundle_too_large")
            assets.setdefault(species_slug, {})[pose_id] = {
                "sha256": digest,
                "bytes": size,
            }
            normalized_poses.append(
                {
                    "id": pose_id,
                    "file": expected_path,
                    "sha256": digest,
                    "bytes": size,
                }
            )
        normalized_species.append(
            {
                "scientific_name": scientific,
                "common_name": common_name,
                "poses": normalized_poses,
            }
        )

    manifest = {
        "name": name,
        "description": description,
        "style": normalized_style,
        "coverage": normalized_coverage,
        "species": normalized_species,
        "license": {"spdx": spdx},
        "attribution": normalized_attribution,
        "provenance": provenance,
        "assets": assets,
        "object_sizes": object_sizes,
        "total_bytes": total,
    }
    if "species_count" in pack:
        manifest_species = [item["scientific_name"] for item in normalized_species]
        if (
            pack["name"] != name
            or pack["description"] != description
            or pack["creator"] != normalized_attribution["creator"]
            or pack["style"]["id"] != normalized_style["id"]
            or pack["style"]["name"] != normalized_style["name"]
            or pack["coverage"]["label"] != normalized_coverage["label"]
            or pack["coverage"]["region_codes"] != region_codes
            or (coverage_type == "global") != (pack["coverage"]["group"] == "global")
            or pack["species_count"] != len(normalized_species)
            or pack["species"] != manifest_species
            or pack["license"] != spdx
            or pack["archive_bytes"] != total
        ):
            raise BundleError("manifest metadata does not match the catalog", "manifest_mismatch")
        objects = {
            (item["scientific_name"], pose["id"]): (
                item["common_name"], pose["sha256"], pose["bytes"]
            )
            for item in normalized_species
            for pose in item["poses"]
        }
        for preview in pack["previews"]:
            match = objects.get((preview["scientific_name"], preview["pose"]))
            if match != (
                preview["common_name"], preview["sha256"], preview["bytes"]
            ):
                raise BundleError("manifest preview does not match the catalog", "manifest_mismatch")
    return manifest


def _geometry(raw: bytes, label: str) -> tuple[list[int], dict[str, Any]]:
    try:
        from PIL import Image
    except ImportError as error:
        raise BundleError("Pillow is required for bundle validation", "missing_dependency") from error
    if not raw.startswith(b"\x89PNG\r\n\x1a\n"):
        raise BundleError(f"{label} is not a PNG", "invalid_png")
    previous = Image.MAX_IMAGE_PIXELS
    Image.MAX_IMAGE_PIXELS = IMAGE_PIXELS_MAX
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as source:
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
        Image.MAX_IMAGE_PIXELS = previous
    try:
        low, high = image.getchannel("A").getextrema()
        if low != 0 or high == 0:
            raise BundleError(f"{label} must contain visible art and transparency", "invalid_png")
        dimensions_scale = 560 / max(width, height)
        dimensions = [max(1, round(width * dimensions_scale)), max(1, round(height * dimensions_scale))]
        scale = 93 / max(width, height)
        mask = image.getchannel("A").resize(
            (max(1, round(width * scale)), max(1, round(height * scale))),
            getattr(Image, "Resampling", Image).LANCZOS,
        )
        packed = bytearray((mask.width * mask.height + 7) // 8)
        pixels = mask.load()
        for y in range(mask.height):
            for x in range(mask.width):
                if pixels[x, y] > 127:
                    offset = y * mask.width + x
                    packed[offset >> 3] |= 1 << (7 - (offset & 7))
        if not any(packed):
            raise BundleError(f"{label} has no visible mask", "invalid_png")
        return dimensions, {
            "w": mask.width,
            "h": mask.height,
            "bits": base64.b64encode(packed).decode(),
        }
    finally:
        image.close()


def _checked_geometry(dimensions: Any, mask: Any) -> None:
    if (
        not isinstance(dimensions, list)
        or len(dimensions) != 2
        or any(
            isinstance(item, bool) or not isinstance(item, int) or not 1 <= item <= 560
            for item in dimensions
        )
        or not isinstance(mask, dict)
        or set(mask) != {"w", "h", "bits"}
        or isinstance(mask.get("w"), bool)
        or not isinstance(mask.get("w"), int)
        or not 1 <= mask["w"] <= 93
        or isinstance(mask.get("h"), bool)
        or not isinstance(mask.get("h"), int)
        or not 1 <= mask["h"] <= 93
        or not isinstance(mask.get("bits"), str)
        or len(mask["bits"]) > 2048
    ):
        raise BundleError("installed illustration geometry is invalid", "invalid_install")
    try:
        packed = base64.b64decode(mask["bits"], validate=True)
    except (ValueError, TypeError) as error:
        raise BundleError(
            "installed illustration geometry is invalid", "invalid_install"
        ) from error
    expected = (mask["w"] * mask["h"] + 7) // 8
    if len(packed) != expected or not any(packed):
        raise BundleError("installed illustration geometry is invalid", "invalid_install")


def _object_path(root: Path, digest: str) -> Path:
    return root / "objects" / "sha256" / digest[:2] / (digest + ".png")


def _all_selection_basis() -> str:
    return _sha(_canonical({"schema_version": 1, "mode": "all"}))


def _make_selection(manifest: dict[str, Any], revision: str, basis: dict[str, Any] | None) -> dict[str, Any]:
    available = {item["scientific_name"] for item in manifest["species"]}
    if basis is None:
        selected = sorted(available)
        mode, basis_digest = "all", _all_selection_basis()
    else:
        basis = _selection_basis(basis)
        selected = sorted(available.intersection(basis["species"]))
        mode, basis_digest = "local", basis["basis_sha256"]
    if not selected:
        raise BundleError("this bundle has no birds for the configured location", "no_matching_species")
    return {"schema_version": 1, "mode": mode, "manifest_sha256": revision,
            "species": selected, "basis_sha256": basis_digest}


def _validate_selection(raw: bytes, reference: dict[str, str], manifest: dict[str, Any]) -> dict[str, Any]:
    receipt = _json(raw, "bundle selection")
    if set(receipt) != {"schema_version", "mode", "manifest_sha256", "species", "basis_sha256"} or \
            type(receipt["schema_version"]) is not int or receipt["schema_version"] != 1 or \
            not isinstance(receipt["mode"], str) or receipt["mode"] not in {"local", "all"} or \
            receipt["manifest_sha256"] != reference["revision"] or \
            _canonical(receipt) != raw or _sha(raw) != reference["selection_revision"]:
        raise BundleError("installed bundle selection is invalid", "invalid_install")
    selected = _selection_species(receipt["species"], SPECIES_MAX)
    _checked_hash(receipt["basis_sha256"], "selection basis")
    available = {item["scientific_name"] for item in manifest["species"]}
    if not set(selected) <= available or (receipt["mode"] == "all" and (
        set(selected) != available or receipt["basis_sha256"] != _all_selection_basis()
    )):
        raise BundleError("installed bundle selection is invalid", "invalid_install")
    return receipt


def _selection_assets(manifest: dict[str, Any], receipt: dict[str, Any]) -> dict[str, Any]:
    return {_slug(name): manifest["assets"][_slug(name)] for name in receipt["species"]}


def _equivalent_selection_reference(
    root: Path, reference: dict[str, str], receipt: dict[str, Any], manifest: dict[str, Any],
) -> dict[str, str] | None:
    selections = _pack_dir(root, reference).parent
    active = _load_state(root)["active"]
    active_path = _pack_dir(root, active) if active is not None else None
    for directory in sorted(selections.iterdir(), key=lambda item: (item != active_path, item.name)):
        if HASH_RE.fullmatch(directory.name) is None or (
            directory.name == reference["selection_revision"] and directory != active_path
        ):
            continue
        candidate = {**reference, "selection_revision": directory.name}
        try:
            _safe_dir(directory)
            stored = _validate_selection(
                _safe_file(directory / "selection.json", SELECTION_MAX), candidate, manifest,
            )
            if any(stored[key] != receipt[key] for key in ("mode", "manifest_sha256", "species")):
                continue
            _validate_install(root, candidate, verify_hashes=True)
            return candidate
        except BundleError:
            continue
    return None


def _install(root: Path, pack: dict[str, Any], basis: dict[str, Any] | None = None) -> dict[str, str]:
    record = pack["manifest"]
    manifest_raw = _download(record["url"], MANIFEST_MAX, record["bytes"])
    if _sha(manifest_raw) != record["sha256"]:
        raise BundleError("manifest checksum is incorrect", "manifest_hash")
    manifest = _validate_manifest(manifest_raw, pack)
    receipt = _make_selection(manifest, record["sha256"], basis)
    selection_raw = _canonical(receipt)
    assets = _selection_assets(manifest, receipt)
    reference = {
        "id": pack["id"],
        "version": pack["version"],
        "revision": record["sha256"],
        "name": manifest["name"],
        "selection_revision": _sha(selection_raw),
    }
    version_dir = root / "packs" / reference["id"] / reference["version"]
    _safe_dir(version_dir.parent, create=True)
    _safe_dir(version_dir, create=True)
    if version_dir.exists() and not version_dir.is_symlink():
        _safe_dir(version_dir)
        others = [item for item in version_dir.iterdir() if item.name != reference["revision"]]
        if others:
            raise BundleError("an installed bundle version is immutable", "immutable_version")
    revision_dir = version_dir / reference["revision"]
    _safe_dir(revision_dir, create=True)
    _safe_dir(revision_dir / "selections", create=True)
    equivalent = _equivalent_selection_reference(root, reference, receipt, manifest)
    if equivalent is not None:
        return equivalent
    final = _pack_dir(root, reference)
    repair_existing = False
    if final.exists() or final.is_symlink():
        if final.is_symlink() or not final.is_dir():
            raise BundleError("installed bundle path is unsafe", "unsafe_storage")
        try:
            _validate_install(root, reference, verify_hashes=True)
            return reference
        except BundleError:
            _safe_dir(final)
            allowed = {"manifest.json", "selection.json", "index.json", "dims.json", "masks.json"}
            if any(
                item.name not in allowed or (item.is_dir() and not item.is_symlink())
                for item in final.iterdir()
            ):
                raise BundleError(
                    "installed bundle contains unsupported files", "invalid_install"
                )
            repair_existing = True
    object_sizes = {item["sha256"]: item["bytes"] for poses in assets.values() for item in poses.values()}
    required = sum(
        size
        for digest, size in object_sizes.items()
        if not _object_path(root, digest).exists()
    )
    if shutil.disk_usage(root).free < required + FREE_SPACE_RESERVE:
        raise BundleError("there is not enough space for this bundle", "storage_full")
    dims: dict[str, list[int]] = {}
    masks: dict[str, dict[str, Any]] = {}
    for species_slug, poses in assets.items():
        for pose_id, item in poses.items():
            digest, size = item["sha256"], item["bytes"]
            target = _object_path(root, digest)
            if target.parent.exists() or target.parent.is_symlink():
                _safe_dir(target.parent)
            stored_valid = target.exists() and not target.is_symlink()
            if stored_valid:
                if not target.is_file():
                    raise BundleError("cached illustration path is unsafe", "unsafe_file")
                try:
                    raw = _safe_file(target, IMAGE_MAX)
                    stored_valid = len(raw) == size and _sha(raw) == digest
                except BundleError:
                    stored_valid = False
            if not stored_valid:
                raw = _download(_object_url(digest), IMAGE_MAX, size)
                if _sha(raw) != digest:
                    raise BundleError("illustration checksum is incorrect", "object_hash")
            slug = species_slug + ("-2" if pose_id == "flight" else "")
            dims[slug], masks[slug] = _geometry(raw, slug)
            if not stored_valid:
                _safe_dir(target.parent, create=True)
                _atomic(target, raw, 0o444)
    staging = root / "staging" / (reference["id"] + "." + uuid.uuid4().hex)
    staging.mkdir(mode=0o700)
    cleanup_staging = True
    try:
        dimensions_raw = _canonical(dims)
        masks_raw = _canonical(masks)
        if len(dimensions_raw) > TABLE_MAX or len(masks_raw) > TABLE_MAX:
            raise BundleError("derived bundle tables are too large", "bundle_too_large")
        _atomic(staging / "manifest.json", manifest_raw, 0o600)
        _atomic(staging / "selection.json", selection_raw, 0o600)
        _atomic(staging / "index.json", _canonical({"reference": reference, "assets": assets}), 0o600)
        _atomic(staging / "dims.json", dimensions_raw, 0o600)
        _atomic(staging / "masks.json", masks_raw, 0o600)
        _validate_install_contents(root, reference, staging, verify_hashes=True)
        if repair_existing:
            _exchange_directories(staging, final)
            try:
                _fsync_dir(final.parent)
                _validate_install(root, reference, verify_hashes=True)
            except Exception:
                try:
                    _exchange_directories(staging, final)
                    _fsync_dir(final.parent)
                except Exception:
                    # The old directory's location is ambiguous after a failed
                    # rollback; retain both rather than deleting evidence.
                    cleanup_staging = False
                raise
        else:
            os.rename(staging, final)
            _fsync_dir(final.parent)
    finally:
        if cleanup_staging and staging.exists() and not staging.is_symlink():
            shutil.rmtree(staging)
    _validate_install(root, reference, verify_hashes=True)
    return reference


def _pack_dir(root: Path, reference: dict[str, str]) -> Path:
    directory = root / "packs" / reference["id"] / reference["version"] / reference["revision"]
    if reference.get("selection_revision"):
        directory = directory / "selections" / reference["selection_revision"]
    return directory


def _validate_reference(value: Any) -> dict[str, str]:
    if not isinstance(value, dict) or set(value) not in (
        {"id", "version", "revision", "name"},
        {"id", "version", "revision", "name", "selection_revision"},
    ):
        raise BundleError("active bundle reference is invalid", "invalid_state")
    reference = {
        "id": _checked_id(value["id"]),
        "version": _checked_version(value["version"]),
        "revision": _checked_hash(value["revision"]),
        "name": _checked_name(value["name"], "bundle name"),
    }
    if "selection_revision" in value:
        reference["selection_revision"] = _checked_hash(value["selection_revision"], "selection revision")
    return reference


def _validate_install_contents(
    root: Path,
    reference: dict[str, str],
    directory: Path,
    *,
    verify_hashes: bool,
) -> dict[str, Any]:
    _safe_dir(directory)
    expected_files = {"manifest.json", "index.json", "dims.json", "masks.json"}
    if "selection_revision" in reference:
        expected_files.add("selection.json")
    names = {item.name for item in directory.iterdir()}
    if "selection_revision" not in reference and "selections" in names:
        _safe_dir(directory / "selections")
        names.remove("selections")
    if names != expected_files:
        raise BundleError("installed bundle contains unsupported files", "invalid_install")
    index = _json(_safe_file(directory / "index.json", MANIFEST_MAX), "installed index")
    if (
        set(index) != {"reference", "assets"}
        or _validate_reference(index.get("reference")) != reference
        or not isinstance(index.get("assets"), dict)
    ):
        raise BundleError("installed bundle index is invalid", "invalid_install")
    manifest_raw = _safe_file(directory / "manifest.json", MANIFEST_MAX)
    if _sha(manifest_raw) != reference["revision"]:
        raise BundleError("installed manifest checksum is incorrect", "invalid_install")
    manifest = _validate_manifest(
        manifest_raw,
        {"id": reference["id"], "version": reference["version"]},
    )
    expected_assets = manifest["assets"]
    if "selection_revision" in reference:
        receipt = _validate_selection(_safe_file(directory / "selection.json", SELECTION_MAX), reference, manifest)
        expected_assets = _selection_assets(manifest, receipt)
    if manifest["name"] != reference["name"] or index["assets"] != expected_assets:
        raise BundleError("installed bundle inventory is invalid", "invalid_install")
    for poses in index["assets"].values():
        if not isinstance(poses, dict):
            raise BundleError("installed bundle index is invalid", "invalid_install")
        for item in poses.values():
            if not isinstance(item, dict):
                raise BundleError("installed bundle index is invalid", "invalid_install")
            digest = _checked_hash(item.get("sha256"))
            size = item.get("bytes")
            if isinstance(size, bool) or not isinstance(size, int) or not 67 <= size <= IMAGE_MAX:
                raise BundleError("installed bundle index is invalid", "invalid_install")
            object_path = _object_path(root, digest)
            _safe_dir(object_path.parent)
            if verify_hashes:
                raw = _safe_file(object_path, IMAGE_MAX)
                valid = len(raw) == size and _sha(raw) == digest
            else:
                valid = _safe_size(object_path, IMAGE_MAX) == size
            if not valid:
                raise BundleError("installed illustration checksum is incorrect", "invalid_install")
    dimensions = _json(_safe_file(directory / "dims.json", TABLE_MAX), "installed dimensions")
    masks = _json(_safe_file(directory / "masks.json", TABLE_MAX), "installed masks")
    expected_slugs = {
        species_slug + ("-2" if pose_id == "flight" else "")
        for species_slug, poses in index["assets"].items()
        for pose_id in poses
    }
    if set(dimensions) != expected_slugs or set(masks) != expected_slugs:
        raise BundleError("installed illustration geometry is incomplete", "invalid_install")
    for slug in expected_slugs:
        _checked_geometry(dimensions[slug], masks[slug])
    return index


def _validate_install(
    root: Path, reference: dict[str, str], *, verify_hashes: bool
) -> dict[str, Any]:
    directory = _pack_dir(root, reference)
    _safe_dir(root / "packs")
    _safe_dir(root / "packs" / reference["id"])
    _safe_dir(root / "packs" / reference["id"] / reference["version"])
    if "selection_revision" in reference:
        _safe_dir(directory.parent.parent)
        _safe_dir(directory.parent)
    return _validate_install_contents(
        root, reference, directory, verify_hashes=verify_hashes
    )


def _state_path(root: Path) -> Path:
    return root / "active.json"


def _load_state(root: Path) -> dict[str, Any]:
    path = _state_path(root)
    if not path.exists() and not path.is_symlink():
        return {"format": "avian-birdframe-active-bundle", "format_version": 1, "active": None, "previous": None}
    value = _json(_safe_file(path, 64 * 1024), "active bundle state")
    if (
        set(value) != {"format", "format_version", "active", "previous"}
        or value.get("format") != "avian-birdframe-active-bundle"
        or value.get("format_version") != 1
    ):
        raise BundleError("active bundle state is invalid", "invalid_state")
    for key in ("active", "previous"):
        if value.get(key) is not None:
            value[key] = _validate_reference(value[key])
    return value


def _save_state(root: Path, state: dict[str, Any]) -> None:
    _atomic(_state_path(root), _canonical(state), 0o600)


def use(
    selector: str,
    *,
    root: str | os.PathLike[str] | None = None,
    render: Callable[[], None] | None = None,
    config: dict[str, Any] | None = None,
    all_species: bool = False,
) -> dict[str, Any]:
    storage = _root(root)
    with operation_lock(storage):
        basis = None if all_species else _resolve_selection_basis(
            _load_frame_config() if config is None else config
        )
        catalog = refresh_catalog(storage)
        pack = resolve_selector(catalog, selector)
        reference = _install(storage, pack, basis)
        before = _load_state(storage)
        changed = before["active"] != reference
        if changed:
            after = {
                "format": "avian-birdframe-active-bundle",
                "format_version": 1,
                "active": reference,
                "previous": before["active"],
            }
            _save_state(storage, after)
        try:
            if render is not None and changed:
                render()
        except Exception as error:
            if changed:
                _save_state(storage, before)
                try:
                    render()
                except Exception:
                    pass
            raise BundleError("frame render failed; the previous bundle was restored", "render_failed") from error
        return {"ok": True, "changed": changed, "bundle": reference}


def rollback(
    *,
    root: str | os.PathLike[str] | None = None,
    render: Callable[[], None] | None = None,
) -> dict[str, Any]:
    storage = _root(root)
    with operation_lock(storage):
        before = _load_state(storage)
        if before["previous"] is None:
            raise BundleError("there is no previous frame bundle", "no_previous")
        _validate_install(storage, before["previous"], verify_hashes=True)
        after = {
            "format": "avian-birdframe-active-bundle",
            "format_version": 1,
            "active": before["previous"],
            "previous": before["active"],
        }
        _save_state(storage, after)
        try:
            if render is not None:
                render()
        except Exception as error:
            _save_state(storage, before)
            try:
                render()
            except Exception:
                pass
            raise BundleError("frame render failed; the active bundle was restored", "render_failed") from error
        return {"ok": True, "bundle": after["active"]}


class ActiveBundle:
    def __init__(self, root: Path, reference: dict[str, str], index: dict[str, Any]) -> None:
        self.root = root
        self.reference = reference
        self.index = index
        self.directory = _pack_dir(root, reference)

    @property
    def dims_path(self) -> Path:
        return self.directory / "dims.json"

    @property
    def masks_path(self) -> Path:
        return self.directory / "masks.json"

    @property
    def drawable_slugs(self) -> frozenset[str]:
        return frozenset(self.index["assets"])

    def assets_response(self) -> dict[str, Any]:
        """Return the modern frontend's exact active-geometry contract."""
        index = _validate_install(self.root, self.reference, verify_hashes=False)
        dimensions = _json(
            _safe_file(self.directory / "dims.json", TABLE_MAX),
            "installed dimensions",
        )
        masks = _json(
            _safe_file(self.directory / "masks.json", TABLE_MAX),
            "installed masks",
        )
        return {
            "ok": True,
            "active": {
                "id": self.reference["id"],
                "version": self.reference["version"],
                "revision": self.reference["revision"],
                "included": False,
                "name": self.reference["name"],
                "content_revision": self.reference.get("selection_revision", self.reference["revision"]),
                **({"selection_revision": self.reference["selection_revision"]} if "selection_revision" in self.reference else {}),
                "species_count": len(index["assets"]),
                "pose_count": sum(len(poses) for poses in index["assets"].values()),
            },
            "dims": dimensions,
            "masks": masks,
        }

    def resolve(self, scientific_name: str, pose: str) -> Path | None:
        if not isinstance(scientific_name, str) or pose not in {"perched", "flight"}:
            return None
        item = self.index["assets"].get(_slug(scientific_name), {}).get(pose)
        if not isinstance(item, dict):
            return None
        digest = _checked_hash(item.get("sha256"))
        size = item.get("bytes")
        path = _object_path(self.root, digest)
        _safe_dir(path.parent)
        raw = _safe_file(path, IMAGE_MAX)
        if len(raw) != size or _sha(raw) != digest:
            raise BundleError("active illustration checksum is incorrect", "invalid_install")
        return path


def active_bundle(root: str | os.PathLike[str] | None = None) -> ActiveBundle | None:
    storage = _root(root)
    if not storage.exists() and not storage.is_symlink():
        return None
    _safe_dir(storage)
    state = _load_state(storage)
    if state["active"] is None:
        return None
    index = _validate_install(storage, state["active"], verify_hashes=False)
    return ActiveBundle(storage, state["active"], index)


def _render_callback(config_path: Path | None = None) -> None:
    frame = Path(__file__).resolve().parent
    config = config_path or _frame_config_path()
    environment = os.environ.copy()
    for name in (
        "PYTHONBREAKPOINT",
        "PYTHONHOME",
        "PYTHONINSPECT",
        "PYTHONPATH",
        "PYTHONSTARTUP",
        "PYTHONWARNINGS",
    ):
        environment.pop(name, None)
    environment["PYTHONNOUSERSITE"] = "1"
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    completed = subprocess.run(
        [
            sys.executable,
            str(frame / "display.py"),
            "--config",
            str(config),
            "--force",
            "--no-signature",
            "--wait-lock",
        ],
        check=False,
        env=environment,
    )
    if completed.returncode != 0:
        raise BundleError("frame renderer returned an error", "render_failed")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    use_parser = commands.add_parser("use")
    use_parser.add_argument("selector")
    use_parser.add_argument("--all-species", action="store_true", help="install every bird in the selected bundle")
    use_parser.add_argument("--no-render", action="store_true", help=argparse.SUPPRESS)
    use_parser.add_argument("--json", action="store_true", help=argparse.SUPPRESS)
    rollback_parser = commands.add_parser("rollback")
    rollback_parser.add_argument("--no-render", action="store_true", help=argparse.SUPPRESS)
    rollback_parser.add_argument("--json", action="store_true", help=argparse.SUPPRESS)
    arguments = parser.parse_args()
    try:
        config_path = _frame_config_path()
        storage = _configured_bundle_root(config_path)
        render = (
            None
            if arguments.no_render
            else lambda: _render_callback(config_path)
        )
        result = (
            use(arguments.selector, root=storage, render=render,
                config=_load_frame_config(config_path), all_species=arguments.all_species)
            if arguments.command == "use"
            else rollback(root=storage, render=render)
        )
        if arguments.json:
            sys.stdout.buffer.write(_canonical(result))
        else:
            reference = result["bundle"]
            verb = (
                "Already using"
                if arguments.command == "use" and not result["changed"]
                else "Now using"
            )
            print(f"{verb} {reference['name']} ({reference['id']}@{reference['version']}).")
        return 0
    except BundleError as error:
        if arguments.json:
            sys.stdout.buffer.write(_canonical({"ok": False, "code": error.code, "error": str(error)}))
        else:
            print(f"avian-bundle: {error}", file=sys.stderr)
        return 1
    except Exception:
        if arguments.json:
            sys.stdout.buffer.write(
                _canonical(
                    {
                        "ok": False,
                        "code": "internal_error",
                        "error": "the bundle operation failed safely",
                    }
                )
            )
        else:
            print("avian-bundle: the bundle operation failed safely", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
