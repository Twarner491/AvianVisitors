#!/usr/bin/env python3
"""Trim fully-transparent rows/columns from PNG images.

Usage:
  python3 trim_transparent.py [--dry-run] [--no-backup] [paths...]

By default it processes `avian/assets/illustrations` and
`avian/assets/cutouts` recursively. It backs up each original as
`<file>.orig` unless `--no-backup` is given.
"""
from __future__ import annotations
import argparse
import os
import shutil
import sys
from datetime import datetime
from pathlib import Path

try:
    from PIL import Image
except Exception as e:
    print("Pillow is required: pip3 install pillow", file=sys.stderr)
    raise


def trim_image(p: Path, backup: bool = True, dry_run: bool = False) -> bool:
    try:
        im = Image.open(p)
    except Exception as e:
        print(f"SKIP: {p} (open error: {e})")
        return False
    # ensure an alpha channel
    if im.mode not in ("RGBA", "LA"):
        im = im.convert("RGBA")
    alpha = im.split()[-1]
    bbox = alpha.getbbox()
    if bbox is None:
        print(f"SKIP: {p} (fully transparent)")
        return False
    if bbox == (0, 0, im.width, im.height):
        print(f"OK:   {p} (already tight)")
        return False
    print(f"TRIM: {p} -> bbox={bbox}")
    if dry_run:
        return True
    if backup:
        bak = p.with_suffix(p.suffix + '.orig')
        # avoid overwriting an existing backup; add timestamp if exists
        if bak.exists():
            ts = datetime.utcnow().strftime('%Y%m%dT%H%M%SZ')
            bak = p.with_name(p.stem + f'.orig.{ts}' + p.suffix)
        shutil.copy2(p, bak)
    cropped = im.crop(bbox)
    # Preserve PNG info where possible
    try:
        cropped.save(p, optimize=True)
    except Exception:
        cropped.save(p)
    return True


def iter_paths(paths):
    for p in paths:
        path = Path(p)
        if path.is_file():
            yield path
        elif path.is_dir():
            for f in path.rglob('*.png'):
                yield f
        else:
            print(f"Warning: {p} does not exist, skipping")


def main(argv=None):
    argv = argv or sys.argv[1:]
    parser = argparse.ArgumentParser(description='Trim transparent edges from PNGs')
    parser.add_argument('paths', nargs='*', help='Files or directories to process')
    parser.add_argument('--no-backup', dest='backup', action='store_false', help='Do not create .orig backups')
    parser.add_argument('--dry-run', action='store_true', help='Show what would be trimmed without modifying files')
    parser.add_argument('--examples', action='store_true', help='Print default paths and exit')
    args = parser.parse_args(argv)

    defaults = [Path(__file__).resolve().parents[2] / 'avian' / 'assets' / 'illustrations',
                Path(__file__).resolve().parents[2] / 'avian' / 'assets' / 'cutouts']
    if args.examples:
        print('Default target directories:')
        for d in defaults:
            print('  ', d)
        return 0

    targets = args.paths or [str(d) for d in defaults]
    any_changes = False
    for f in iter_paths(targets):
        try:
            changed = trim_image(f, backup=args.backup, dry_run=args.dry_run)
            if changed:
                any_changes = True
        except KeyboardInterrupt:
            raise
        except Exception as e:
            print(f"ERROR processing {f}: {e}")

    if args.dry_run:
        print('\nDry-run complete. No files were modified.')
    else:
        print('\nDone.')
    return 0 if any_changes else 0


if __name__ == '__main__':
    raise SystemExit(main())
