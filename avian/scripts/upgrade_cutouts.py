#!/usr/bin/env python3
"""AvianVisitors - upgrade the Pi's instant cutouts to BiRefNet quality.

Run on a workstation or laptop, not the Pi. The on-Pi generate path
(generate_one.py) cuts new birds with a quick chroma flood - good
enough to draw, rough at the edges. This pulls each such bird's raw
cream-ground render from the Pi over SSH, mattes it locally with
BiRefNet (the ~1GB model the Pi can't fit), pushes the refined cutouts
back over ssh, and rebuilds their masks in place. cuts.json entries
clear as birds are upgraded, which also clears the menu notification.

Usage:
    python3 upgrade_cutouts.py --pi <user>@birdnet.local

Needs:  pip install rembg onnxruntime scipy pillow numpy
The first run downloads the BiRefNet model (~1GB) to ~/.u2net/.
"""
from __future__ import annotations
import argparse
import json
import re
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path

CREAM_TOL = 11   # near-paper distance (matches the repo cutout pipeline)
PLUMAGE = 18     # beyond this distance from paper counts as inked body
PI_TARGET_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_-]*@[A-Za-z0-9][A-Za-z0-9._:-]*$")
PATH_PART_RE = re.compile(r"^[A-Za-z0-9._-]+$")
SLUG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")


def birefnet_cut(src: Path, dst: Path, sess) -> None:
    """BiRefNet matte + exterior-cream peel + belly fill. A filled region
    whose boundary is mostly not plumage is a between-legs pocket, not a
    belly, and is rejected. Same approach the bundled set was cut with."""
    import numpy as np
    from PIL import Image, ImageFilter
    from rembg import remove
    from scipy import ndimage

    im = Image.open(src).convert("RGB")
    arr = np.asarray(im)
    h, w, _ = arr.shape
    a = np.asarray(remove(im, session=sess))[:, :, 3]
    corners = np.concatenate([arr[:15, :15].reshape(-1, 3), arr[:15, -15:].reshape(-1, 3),
                              arr[-15:, :15].reshape(-1, 3), arr[-15:, -15:].reshape(-1, 3)])
    paper = np.median(corners, axis=0)
    dist = np.sqrt(((arr - paper) ** 2).sum(2))
    passable = (a < 100) | (dist < CREAM_TOL)
    lbl, _n = ndimage.label(passable)
    border = set(lbl[0, :]) | set(lbl[-1, :]) | set(lbl[:, 0]) | set(lbl[:, -1])
    border.discard(0)
    exterior = np.isin(lbl, list(border))
    base = (a >= 100) & ~exterior
    solid = ndimage.binary_fill_holes(base)
    added = solid & ~base
    plumage = (a >= 100) & (dist > PLUMAGE)
    al, an = ndimage.label(added)
    reject = np.zeros_like(solid)
    for i in range(1, an + 1):
        C = al == i
        ring = ndimage.binary_dilation(C, iterations=3) & ~C & ~exterior
        if ring.sum() == 0 or plumage[ring].mean() < 0.30:
            reject |= C
    solid = solid & ~reject
    L, m = ndimage.label(solid)
    if m > 1:
        sizes = ndimage.sum(np.ones_like(L), L, range(1, m + 1))
        solid = (L == int(np.argmax(sizes)) + 1)
    inside = ndimage.binary_erosion(solid, iterations=2)
    af = a.copy(); af[inside] = 255; af[~solid] = 0
    af = np.maximum(np.asarray(Image.fromarray(af).filter(ImageFilter.GaussianBlur(0.4))),
                    (inside * 255).astype(np.uint8))
    af[~solid] = 0
    rgba = np.dstack([arr, af]).astype(np.uint8)
    fg = af > 40
    ys, xs = np.where(fg)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    pad = round(0.03 * max(y1 - y0, x1 - x0))
    y0 = max(0, y0 - pad); x0 = max(0, x0 - pad)
    y1 = min(h, y1 + pad); x1 = min(w, x1 + pad)
    Image.fromarray(rgba[y0:y1, x0:x1], "RGBA").save(dst)


def validate_target(value: str) -> str:
    if not PI_TARGET_RE.fullmatch(value):
        raise ValueError("--pi must be a safe user@host target")
    return value


def validate_repo(value: str) -> str:
    repo = value.rstrip("/")
    parts = repo.split("/")
    if (not repo or repo.startswith("/") or any(
            part in ("", ".", "..") or not PATH_PART_RE.fullmatch(part)
            for part in parts)):
        raise ValueError("--repo must be a safe relative path")
    return repo


def validate_slug(value: object) -> str:
    if not isinstance(value, str) or not SLUG_RE.fullmatch(value):
        raise ValueError(f"unsafe cutout name in cuts.json: {value!r}")
    return value


def read_remote(pi: str, path: str) -> bytes:
    """Read one validated station file without publishing it through Caddy."""
    result = subprocess.run(
        ["ssh", pi, f"cat -- {shlex.quote(path)}"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", "replace").strip()
        raise RuntimeError(detail or f"ssh could not read {path}")
    return result.stdout


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pi", required=True, metavar="USER@HOST",
                    help="ssh target for the Pi (e.g. pi@birdnet.local)")
    ap.add_argument("--repo", default="BirdNET-Pi",
                    help="repo dir on the Pi, relative to its $HOME (default BirdNET-Pi)")
    args = ap.parse_args()

    try:
        pi = validate_target(args.pi)
        repo = validate_repo(args.repo)
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    host = pi.split("@", 1)[1]
    base = f"{repo}/avian/assets/illustrations"

    try:
        from rembg import new_session  # noqa: F401
        import scipy  # noqa: F401
    except ImportError as e:
        print(f"error: missing dependency ({e.name}). Run:\n"
              "    pip install rembg onnxruntime scipy pillow numpy", file=sys.stderr)
        return 2

    try:
        cuts = json.loads(read_remote(pi, f"{base}/cuts.json"))
        if not isinstance(cuts, dict):
            raise ValueError("cuts.json is not an object")
        slugs = sorted(validate_slug(k) for k, v in cuts.items() if v == "chroma")
    except Exception as e:
        print(f"error: could not read cuts.json from {host}: {e}", file=sys.stderr)
        return 1
    if not slugs:
        print("nothing to upgrade - no instant cutouts recorded")
        return 0
    print(f"{len(slugs)} instant cutout(s) to upgrade: {', '.join(slugs)}")

    from rembg import new_session
    sess = new_session("birefnet-general")

    tmp = Path(tempfile.mkdtemp(prefix="av-upgrade-"))
    done, failed = [], []
    for slug in slugs:
        try:
            raw = read_remote(pi, f"{base}/raw/{slug}.png")
            src = tmp / f"{slug}.raw.png"
            src.write_bytes(raw)
            out = tmp / f"{slug}.png"
            birefnet_cut(src, out, sess)
            done.append(slug)
            print(f"  [ok] {slug}")
        except Exception as e:
            failed.append(slug)
            print(f"  [fail] {slug}: {e}", file=sys.stderr)
    if not done:
        print("nothing upgraded", file=sys.stderr)
        return 1

    # Push through a staging dir, then mv into place on the Pi: the files
    # being replaced were created by php-fpm (owned by caddy), so a direct
    # scp overwrite fails; a rename into the group-writable dir doesn't.
    # cuts.json is only pruned after the masks rebuild succeeds, so a
    # failed run stays retryable instead of "nothing to upgrade".
    stage = f"{repo}/avian/assets/illustrations/.upgrade-stage"
    for s in done:
        cuts.pop(s, None)
    cj = tmp / "cuts.json"
    cj.write_text(json.dumps(cuts, indent=0, sort_keys=True) + "\n")
    print(f"pushing {len(done)} cutout(s) to {args.pi}:{stage}/")
    if subprocess.run(["ssh", pi, f"mkdir -p -- {shlex.quote(stage)}"]).returncode != 0:
        print("error: ssh mkdir failed", file=sys.stderr)
        return 1
    files = [str(tmp / f"{s}.png") for s in done] + [str(cj)]
    if subprocess.run(["scp", "-q", *files, f"{pi}:{stage}/"]).returncode != 0:
        print("error: scp failed", file=sys.stderr)
        return 1
    # Braces, not parentheses: a subshell would drop the P assignment.
    remote = (f"cd -- {shlex.quote(repo)}"
              f" && {{ test -x birdnet/bin/python3 && P=birdnet/bin/python3 || P=python3; }}"
              f" && mv -f avian/assets/illustrations/.upgrade-stage/*.png avian/assets/illustrations/"
              f" && $P avian/scripts/build_masks.py --add {' '.join(shlex.quote(s) for s in done)}"
              f" && mv -f avian/assets/illustrations/.upgrade-stage/cuts.json avian/assets/illustrations/"
              f" && rmdir avian/assets/illustrations/.upgrade-stage")
    if subprocess.run(["ssh", pi, remote]).returncode != 0:
        print("error: remote install failed (staged files remain in .upgrade-stage; rerun after fixing)",
              file=sys.stderr)
        return 1

    print(f"done: {len(done)} upgraded" + (f", {len(failed)} failed" if failed else ""))
    print("hard-refresh the collage (or wait for the next poll) to see the new edges")
    return 0


if __name__ == "__main__":
    sys.exit(main())
