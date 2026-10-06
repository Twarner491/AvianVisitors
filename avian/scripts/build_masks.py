#!/usr/bin/env python3
"""AvianVisitors - rebuild the collage silhouette masks from the cutouts.

Step 3 of the illustration pipeline (after pregen.py and cutout.py).

The collage packs birds by their actual silhouette, not bounding boxes,
so the frontend ships a tiny 1-bit mask per illustration. This reads every
cutout in avian/assets/illustrations/ and writes two data files that
apt.js fetches at load:

    dims.json   {slug: [w, h]}         aspect, scaled so the long side is 560
    masks.json  {slug: {w, h, bits}}   silhouette downscaled to <=93px, 1-bit
                packed MSB-first row-major, base64. A bit is 1 where the
                cutout is opaque (alpha > 127). This is exactly what
                loadMask() in apt.js decodes.

Both files are written one key per line (sorted by slug), so adding a
species is a clean localized diff and two contributors adding different
species produce non-overlapping diffs instead of colliding. The tables
used to be inlined in apt.js as single ~800KB lines, which turned every
species-add into a whole-line rewrite and an unavoidable merge conflict.

Run after changing the illustration set. If dims.json or masks.json changes,
always bump TABLE_VERSION in apt.js. For a one-species correction, also add or
update that species in ART_REVISIONS. For a regional or library-wide rebuild,
bump SKETCH_VERSION and IMG_VERSION instead of creating hundreds of species
revisions.

Usage:
    python3 build_masks.py            # write dims.json + masks.json
    python3 build_masks.py --check    # report only, don't write
"""
from __future__ import annotations
import argparse
import base64
from contextlib import contextmanager
import fcntl
import json
import os
import re
import secrets
import stat
import sys
from pathlib import Path

DIM_MAX = 560   # long side of the stored aspect
MASK_MAX = 93   # long side of the stored silhouette
ALPHA_ON = 127  # opaque above this -> silhouette bit set
GENERATION_LOCK = Path(os.environ.get(
    "AVIAN_GENERATION_LOCK", "/run/lock/avian-generation.lock"
))
ART_REVISION_STATE = Path(os.environ.get(
    "AVIAN_ART_REVISION_STATE", "/var/lib/avian-visitors/included-art.revision"
))
INCLUDED_ILLUSTRATIONS = Path(__file__).resolve().parents[1] / "assets" / "illustrations"
INVALID_CONTENT_REVISION = "invalid" + "!" * 57


def write_content_revision(handle, revision: str) -> None:
    """Durably overwrite one fixed-size record without truncate-first risk."""
    if len(revision) != 64 or "\n" in revision:
        raise ValueError("illustration content revision must be 64 bytes")
    handle.seek(0)
    handle.write(revision + "\n")
    handle.flush()
    os.fsync(handle.fileno())
    os.ftruncate(handle.fileno(), 65)
    os.fsync(handle.fileno())


def invalidate_content_revision(handle) -> None:
    write_content_revision(handle, INVALID_CONTENT_REVISION)


def rotate_content_revision(handle) -> None:
    write_content_revision(handle, secrets.token_hex(32))


def fsync_directory(path: Path) -> None:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    descriptor = os.open(path, flags)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def durable_atomic_bytes(path: Path, contents: bytes) -> None:
    temporary = path.with_name(f".{path.name}.tmp.{secrets.token_hex(8)}")
    descriptor = None
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o664)
        view = memoryview(contents)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                raise OSError("short illustration write")
            view = view[written:]
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = None
        os.replace(temporary, path)
        fsync_directory(path.parent)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def durable_write_text(path: Path, contents: str) -> None:
    """Write through the existing inode, then durably publish its new length.

    The frontend directory is deliberately not writable by the web worker, so
    replacing these files would lose their root-provisioned group boundary.
    The persistent invalid journal and generation lock provide pair atomicity.
    """
    mode = "r+" if path.exists() else "x+"
    with path.open(mode, encoding="utf-8") as handle:
        handle.seek(0)
        handle.write(contents)
        handle.flush()
        os.fsync(handle.fileno())
        handle.truncate()
        handle.flush()
        os.fsync(handle.fileno())


def regular_file_identity(path: Path):
    """Return a replacement-sensitive identity, or None for an absent path."""
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise RuntimeError(f"unsafe illustration path: {path.name}")
    return (
        info.st_dev,
        info.st_ino,
        info.st_size,
        info.st_mtime_ns,
        info.st_ctime_ns,
    )


def validate_file_identities(expected) -> None:
    for path, identity in expected.items():
        if regular_file_identity(path) != identity:
            raise RuntimeError(
                f"illustration changed while it was being prepared: {path.name}"
            )


def validate_generation_lock(handle, path: Path):
    info = os.fstat(handle.fileno())
    permissions = stat.S_IMODE(info.st_mode)
    is_default = path == Path("/run/lock/avian-generation.lock")
    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
            or (is_default and (info.st_uid != 0 or permissions != 0o660))
            or (not is_default and permissions != 0o600)):
        raise RuntimeError("unsafe illustration generation lock")
    return info


def open_generation_lock(path: Path | None = None):
    selected = GENERATION_LOCK if path is None else path
    flags = os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(selected, flags)
    handle = os.fdopen(descriptor, "r+", encoding="ascii")
    try:
        validate_generation_lock(handle, selected)
    except Exception:
        handle.close()
        raise
    return handle


def open_art_revision_state(expected_gid=None):
    flags = os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(ART_REVISION_STATE, flags)
    except FileNotFoundError:
        return None
    handle = os.fdopen(descriptor, "r+", encoding="ascii")
    info = os.fstat(handle.fileno())
    permissions = stat.S_IMODE(info.st_mode)
    is_default = ART_REVISION_STATE == Path(
        "/var/lib/avian-visitors/included-art.revision"
    )
    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
            or (is_default and (
                info.st_uid != 0 or permissions != 0o660
                or expected_gid is None or info.st_gid != expected_gid
            ))
            or (not is_default and permissions != 0o600)):
        handle.close()
        raise RuntimeError("unsafe illustration content revision state")
    return handle


@contextmanager
def included_art_write_transaction(directory: Path, expected=None):
    """Invalidate live included art before one durable PNG replacement.

    Offline/custom output directories need no station coordination. The exact
    checked-out illustration directory remains usable in an unprovisioned
    workstation clone when neither runtime inode exists. A provisioned station
    must have both validated files and leaves the journal invalid until the
    final build_masks transaction publishes matching geometry.
    """
    expected = expected or {}
    if directory.resolve() != INCLUDED_ILLUSTRATIONS.resolve():
        validate_file_identities(expected)
        yield
        return
    try:
        lock_handle = open_generation_lock()
    except FileNotFoundError:
        if ART_REVISION_STATE.exists() or ART_REVISION_STATE.is_symlink():
            raise RuntimeError("illustration lock is missing")
        validate_file_identities(expected)
        yield
        return

    revision_state = None
    try:
        fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX)
        lock_info = validate_generation_lock(lock_handle, GENERATION_LOCK)
        revision_state = open_art_revision_state(lock_info.st_gid)
        if revision_state is None:
            raise RuntimeError("illustration content revision state is missing")
        # API rendering and BiRefNet work happen outside this short critical
        # section. Refuse to overwrite an updater/generator result that landed
        # since the caller took its input snapshot.
        validate_file_identities(expected)
        invalidate_content_revision(revision_state)
        yield
    finally:
        if revision_state is not None:
            revision_state.close()
        fcntl.flock(lock_handle.fileno(), fcntl.LOCK_UN)
        lock_handle.close()


class TableWriteCommit:
    """Explicit commit guard for a locked PNG/table transaction."""

    def __init__(self, handle):
        self.handle = handle
        self.started = False

    def begin(self) -> None:
        if self.started:
            return
        if self.handle is not None:
            invalidate_content_revision(self.handle)
        self.started = True


@contextmanager
def table_write_transaction():
    """Serialize the two table writes and publish one commit nonce.

    The on-device generator passes its already locked descriptor to avoid a
    self-deadlock. Direct maintenance runs acquire the same lock. A source
    checkout without a provisioned lock remains usable without web readers.
    """
    inherited = os.environ.get("AVIAN_GENERATION_LOCK_FD", "")
    owned_lock = False
    handle = None
    if inherited:
        if not inherited.isdigit():
            raise RuntimeError("invalid inherited illustration generation lock")
        handle = os.fdopen(os.dup(int(inherited)), "r+", encoding="ascii")
        validate_generation_lock(handle, GENERATION_LOCK)
    else:
        try:
            handle = open_generation_lock()
        except FileNotFoundError:
            if ART_REVISION_STATE.exists():
                raise RuntimeError("illustration lock is missing")
            yield TableWriteCommit(None)
            return
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        owned_lock = True

    revision_state = None
    try:
        info = validate_generation_lock(handle, GENERATION_LOCK)
        revision_state = open_art_revision_state(info.st_gid)
        if revision_state is None:
            raise RuntimeError("illustration content revision state is missing")
        transaction = TableWriteCommit(revision_state)
        yield transaction
    except Exception:
        # A killed/failed writer leaves the explicit invalid marker. Runtime
        # readers then fail closed until a complete rebuild commits a nonce.
        raise
    else:
        if not transaction.started:
            return
        rotate_content_revision(revision_state)
    finally:
        if owned_lock:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        if revision_state is not None:
            revision_state.close()
        handle.close()


def build_tables(illus_dir: Path, only=None):
    """Return (dims, masks) dicts keyed by slug, in sorted order.
    `only` (a set of slugs) restricts the scan for incremental --add runs."""
    from PIL import Image
    dims, masks = {}, {}
    pngs = sorted(p for p in illus_dir.glob("*.png")
                  if re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", p.stem))
    if only is not None:
        pngs = [p for p in pngs if p.stem in only]
    for p in pngs:
        slug = p.stem
        im = Image.open(p).convert("RGBA")
        w, h = im.size
        scale = DIM_MAX / max(w, h)
        dims[slug] = [round(w * scale), round(h * scale)]

        ms = MASK_MAX / max(w, h)
        mw, mh = max(1, round(w * ms)), max(1, round(h * ms))
        alpha = im.getchannel("A").resize((mw, mh), Image.LANCZOS)
        px = alpha.load()
        bits = bytearray((mw * mh + 7) // 8)
        for y in range(mh):
            for x in range(mw):
                if px[x, y] > ALPHA_ON:
                    i = y * mw + x
                    bits[i >> 3] |= 1 << (7 - (i & 7))
        masks[slug] = {"w": mw, "h": mh, "bits": base64.b64encode(bytes(bits)).decode()}
    return dims, masks


def dump_perkey(table) -> str:
    """Serialize {key: value} as valid JSON with one key per line, sorted.

    A per-key layout keeps a species-add to a single inserted line, so
    independent regional contributions produce non-overlapping diffs
    instead of rewriting one giant line and colliding on every merge.
    json.loads reads it back exactly as a normal object.
    """
    lines = [f"{json.dumps(k)}:{json.dumps(v, separators=(',', ':'))}"
             for k, v in sorted(table.items())]
    return "{\n" + ",\n".join(lines) + "\n}\n"


def main() -> int:
    here = Path(__file__).resolve().parents[1]
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--illustrations", type=Path, default=here / "assets" / "illustrations",
                    help="Cutout directory (default: avian/assets/illustrations/)")
    ap.add_argument("--frontend", type=Path, default=here / "frontend",
                    help="Dir to write dims.json + masks.json (default: avian/frontend/)")
    ap.add_argument("--check", action="store_true",
                    help="Report counts against the current dims.json, don't write")
    ap.add_argument("--add", nargs="+", metavar="SLUG",
                    help="Update only these slugs, merged into the existing "
                         "dims.json/masks.json (the on-Pi generate path - a "
                         "full rescan of hundreds of cutouts is slow there)")
    args = ap.parse_args()

    dims_path = args.frontend / "dims.json"
    masks_path = args.frontend / "masks.json"

    if args.check and not args.add:
        dims, _ = build_tables(args.illustrations)
        perched = sum(1 for k in dims if not k.endswith("-2"))
        flight = sum(1 for k in dims if k.endswith("-2"))
        print(f"built {len(dims)} masks ({perched} perched + {flight} flight) "
              f"from {args.illustrations}")
        if not dims:
            print("error: no cutouts found", file=sys.stderr)
            return 1
        cur = json.loads(dims_path.read_text()) if dims_path.exists() else {}
        added = sorted(set(dims) - set(cur))
        removed = sorted(set(cur) - set(dims))
        print(f"dims.json currently has {len(cur)} entries; "
              f"+{len(added)} new, -{len(removed)} removed")
        if added:
            print("  new:", ", ".join(added[:8]) + (" ..." if len(added) > 8 else ""))
        if removed:
            print("  gone:", ", ".join(removed[:8]) + (" ..." if len(removed) > 8 else ""))
        return 0

    # The scan belongs to the write transaction. In particular, a direct
    # maintenance run must not sample old PNGs while generate_one owns the lock,
    # then wait and publish those stale masks after generation has committed.
    with table_write_transaction() as transaction:
        dims, masks = build_tables(
            args.illustrations, only=set(args.add) if args.add else None
        )
        perched = sum(1 for k in dims if not k.endswith("-2"))
        flight = sum(1 for k in dims if k.endswith("-2"))
        print(f"built {len(dims)} masks ({perched} perched + {flight} flight) "
              f"from {args.illustrations}")
        if not dims:
            print("error: no cutouts found", file=sys.stderr)
            return 1

        if args.add:
            missing = sorted(set(args.add) - set(dims))
            if missing:
                print(f"error: no cutout for: {', '.join(missing)}", file=sys.stderr)
                return 1
            cur_d = json.loads(dims_path.read_text()) if dims_path.exists() else {}
            cur_m = json.loads(masks_path.read_text()) if masks_path.exists() else {}
            cur_d.update(dims)
            cur_m.update(masks)
            transaction.begin()
            durable_write_text(dims_path, dump_perkey(cur_d))
            durable_write_text(masks_path, dump_perkey(cur_m))
            fsync_directory(args.frontend)
        else:
            transaction.begin()
            durable_write_text(dims_path, dump_perkey(dims))
            durable_write_text(masks_path, dump_perkey(masks))
            fsync_directory(args.frontend)

    if args.add:
        print(f"merged {len(dims)} slug(s) into {dims_path.name} + {masks_path.name} "
              f"({len(cur_d)} entries total)")
        return 0
    print(f"wrote {dims_path} + {masks_path} ({len(dims)} entries each)\n"
          "cache reminder: if the tables changed, always bump TABLE_VERSION; "
          "for one corrected species update ART_REVISIONS, or for a regional "
          "or library-wide rebuild bump SKETCH_VERSION + IMG_VERSION")
    return 0


if __name__ == "__main__":
    sys.exit(main())
