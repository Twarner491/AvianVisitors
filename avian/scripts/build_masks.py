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
import json
import re
import sys
from pathlib import Path

DIM_MAX = 560   # long side of the stored aspect
MASK_MAX = 93   # long side of the stored silhouette
ALPHA_ON = 127  # opaque above this -> silhouette bit set


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

    dims, masks = build_tables(args.illustrations, only=set(args.add) if args.add else None)
    perched = sum(1 for k in dims if not k.endswith("-2"))
    flight = sum(1 for k in dims if k.endswith("-2"))
    print(f"built {len(dims)} masks ({perched} perched + {flight} flight) "
          f"from {args.illustrations}")
    if not dims:
        print("error: no cutouts found", file=sys.stderr)
        return 1

    dims_path = args.frontend / "dims.json"
    masks_path = args.frontend / "masks.json"

    if args.add:
        missing = sorted(set(args.add) - set(dims))
        if missing:
            print(f"error: no cutout for: {', '.join(missing)}", file=sys.stderr)
            return 1
        cur_d = json.loads(dims_path.read_text()) if dims_path.exists() else {}
        cur_m = json.loads(masks_path.read_text()) if masks_path.exists() else {}
        cur_d.update(dims)
        cur_m.update(masks)
        dims_path.write_text(dump_perkey(cur_d))
        masks_path.write_text(dump_perkey(cur_m))
        print(f"merged {len(dims)} slug(s) into {dims_path.name} + {masks_path.name} "
              f"({len(cur_d)} entries total)")
        return 0

    if args.check:
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

    dims_path.write_text(dump_perkey(dims))
    masks_path.write_text(dump_perkey(masks))
    print(f"wrote {dims_path} + {masks_path} ({len(dims)} entries each)\n"
          "cache reminder: if the tables changed, always bump TABLE_VERSION; "
          "for one corrected species update ART_REVISIONS, or for a regional "
          "or library-wide rebuild bump SKETCH_VERSION + IMG_VERSION")
    return 0


if __name__ == "__main__":
    sys.exit(main())
