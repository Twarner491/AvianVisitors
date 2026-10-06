#!/usr/bin/env python3
"""Atomically install workstation-refined cutouts on a running station.

The workstation upgrader copies files into ``.upgrade-stage`` and invokes this
station-side helper. The helper shares the generation lock and persistent
revision journal with on-device generation, so mutable PNGs and their geometry
can never be served under a previously committed browser cache key.
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import stat
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ILLUSTRATIONS = HERE.parent / "assets" / "illustrations"
STAGE = ILLUSTRATIONS / ".upgrade-stage"
MAX_PNG_BYTES = 32 * 1024 * 1024
MAX_CUTS_BYTES = 1024 * 1024
SLUG_RE = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")

sys.path.insert(0, str(HERE))
import build_masks  # noqa: E402

GENERATION_LOCK = build_masks.GENERATION_LOCK
ART_REVISION_STATE = build_masks.ART_REVISION_STATE


def validate_slug(value: str) -> str:
    if not SLUG_RE.fullmatch(value):
        raise ValueError(f"unsafe upgraded cutout slug: {value!r}")
    return value


def committed_revision(handle) -> bool:
    handle.seek(0)
    return re.fullmatch(r"[0-9a-f]{64}\n", handle.read(66)) is not None


def read_staged_file(path: Path, max_bytes: int) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        info = os.fstat(descriptor)
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                or info.st_size < 1 or info.st_size > max_bytes):
            raise RuntimeError(f"unsafe staged file: {path.name}")
        chunks = []
        remaining = max_bytes + 1
        while remaining:
            chunk = os.read(descriptor, min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        contents = b"".join(chunks)
        if len(contents) != info.st_size:
            raise RuntimeError(f"staged file changed while reading: {path.name}")
        return contents
    finally:
        os.close(descriptor)


def publish_staged_file(source: Path, target: Path, max_bytes: int) -> None:
    # Reading validates the exact inode and bounds before it can replace a live
    # path. Reopen for fsync without following links, then publish by rename.
    read_staged_file(source, max_bytes)
    descriptor = os.open(source, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        os.fchmod(descriptor, 0o664)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.replace(source, target)
    build_masks.fsync_directory(target.parent)


def validate_staged_cuts(path: Path) -> None:
    try:
        value = json.loads(read_staged_file(path, MAX_CUTS_BYTES))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("staged cuts.json is invalid") from exc
    if not isinstance(value, dict):
        raise RuntimeError("staged cuts.json is invalid")
    for slug, kind in value.items():
        if not isinstance(slug, str) or not SLUG_RE.fullmatch(slug) \
                or kind != "chroma":
            raise RuntimeError("staged cuts.json is invalid")


def run_mask_builder(lock_handle, slugs: list[str] | None) -> None:
    environment = os.environ.copy()
    environment["AVIAN_GENERATION_LOCK"] = str(GENERATION_LOCK)
    environment["AVIAN_GENERATION_LOCK_FD"] = str(lock_handle.fileno())
    environment["AVIAN_ART_REVISION_STATE"] = str(ART_REVISION_STATE)
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    command = [sys.executable, str(HERE / "build_masks.py")]
    if slugs is not None:
        command.extend(["--add", *slugs])
    result = subprocess.run(
        command,
        env=environment,
        pass_fds=(lock_handle.fileno(),),
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError("illustration mask rebuild failed")


def install(slugs: list[str]) -> None:
    normalized = sorted({validate_slug(slug) for slug in slugs})
    if not normalized:
        raise ValueError("at least one upgraded cutout is required")
    cuts_path = STAGE / "cuts.json"
    validate_staged_cuts(cuts_path)
    for slug in normalized:
        read_staged_file(STAGE / f"{slug}.png", MAX_PNG_BYTES)

    lock_handle = build_masks.open_generation_lock(GENERATION_LOCK)
    revision_state = None
    try:
        fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX)
        lock_info = build_masks.validate_generation_lock(lock_handle, GENERATION_LOCK)
        revision_state = build_masks.open_art_revision_state(lock_info.st_gid)
        if revision_state is None:
            raise RuntimeError("illustration content revision state is missing")

        # A previous interrupted writer may have left unrelated pixels and
        # tables out of sync. Repair the complete inventory before layering the
        # requested incremental upgrade onto it.
        if not committed_revision(revision_state):
            run_mask_builder(lock_handle, None)
            if not committed_revision(revision_state):
                raise RuntimeError("illustration content revision was not recovered")

        build_masks.invalidate_content_revision(revision_state)
        for slug in normalized:
            publish_staged_file(
                STAGE / f"{slug}.png",
                ILLUSTRATIONS / f"{slug}.png",
                MAX_PNG_BYTES,
            )
        run_mask_builder(lock_handle, normalized)
        if not committed_revision(revision_state):
            raise RuntimeError("illustration content revision was not committed")
        publish_staged_file(cuts_path, ILLUSTRATIONS / "cuts.json", MAX_CUTS_BYTES)
    finally:
        if revision_state is not None:
            revision_state.close()
        fcntl.flock(lock_handle.fileno(), fcntl.LOCK_UN)
        lock_handle.close()
    try:
        STAGE.rmdir()
    except OSError:
        pass


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("slugs", nargs="+")
    args = parser.parse_args()
    try:
        install(args.slugs)
    except (OSError, RuntimeError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
