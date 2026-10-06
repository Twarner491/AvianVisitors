#!/usr/bin/env python3
"""AvianVisitors - generate one species' illustrations on the Pi itself.

The on-demand path behind the atlas "generate illustration" button
(avian/api/generate.php). Runs the same Gemini render pregen.py does,
then an instant chroma cutout instead of BiRefNet - the flood-fill
approach needs only Pillow + numpy, both already on a BirdNET-Pi,
where the ~1GB BiRefNet model does not fit.

The raw cream-ground render is kept in illustrations/raw/ so a later
workstation pass (avian/scripts/upgrade_cutouts.py) can re-cut it with
BiRefNet at full quality. Each instant cut is recorded in
illustrations/cuts.json ({slug: "chroma"}); the upgrade pass clears
entries as it replaces them, and the menu badge counts what's left.

Usage:
    GEMINI_API_KEY=... python3 generate_one.py --sci 'Calypte anna' --com "Anna's Hummingbird"
    ... --force        # re-render even if the illustration exists
"""
from __future__ import annotations
import argparse
import fcntl
import json
import os
import secrets
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import pregen  # noqa: E402  (reuses gen_one + the reference machinery)
import build_masks  # noqa: E402  (shared table transaction/cache commit)
from image_files import open_source_image, save_png_atomic  # noqa: E402

ILLUS = HERE.parent / "assets" / "illustrations"
RAW = ILLUS / "raw"
CUTS = ILLUS / "cuts.json"
STATE = ILLUS / ".generate.state.json"
GENERATION_LOCK = Path(os.environ.get(
    "AVIAN_GENERATION_LOCK", "/run/lock/avian-generation.lock"
))


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
        build_masks.fsync_directory(path.parent)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def write_state(**kw) -> None:
    """Single-writer progress file for generate.php's status action."""
    kw["at"] = int(time.time())
    try:
        STATE.write_text(json.dumps(kw) + "\n")
    except OSError:
        pass


def chroma_cut(src: Path, dst: Path) -> None:
    """Instant cutout for a cream-ground render: everything reachable from
    the border through near-paper pixels is background; everything else is
    bird. Enclosed pale patches (a white belly) are unreachable, so they
    stay opaque - the same property the BiRefNet pipeline's fill step has
    to reconstruct. Edges get a light feather instead of a learned matte.

    The paper tolerance adapts per image: the model renders real grain
    and a slight vignette, so the ground's distance-from-corner-paper
    varies render to render (a fixed tolerance either strands ground or
    eats pale plumage). The border strips are guaranteed paper - their
    99th percentile, widened, clears grain and vignette while staying
    far below the inked outline."""
    with open_source_image(src.read_bytes()) as source:
        im = source.convert("RGB")
    arr = np.asarray(im)
    h, w, _ = arr.shape
    corners = np.concatenate([arr[:15, :15].reshape(-1, 3), arr[:15, -15:].reshape(-1, 3),
                              arr[-15:, :15].reshape(-1, 3), arr[-15:, -15:].reshape(-1, 3)])
    paper = np.median(corners, axis=0)
    dist = np.sqrt(((arr.astype(np.int32) - paper) ** 2).sum(2))
    border = np.concatenate([dist[:40, :].ravel(), dist[-40:, :].ravel(),
                             dist[:, :40].ravel(), dist[:, -40:].ravel()])
    tol = float(min(40.0, max(15.0, 2.5 * np.percentile(border, 99))))
    passable = dist < tol

    # Flood the passable region from the border (ImageDraw.floodfill runs
    # at C speed; seeds cover each edge in case a wing splits the margin).
    # The .copy() is load-bearing: floodfill's writes are lost on a
    # numpy-buffer-backed image (observed on Pillow 12.3).
    m = Image.fromarray(np.where(passable, 128, 0).astype(np.uint8)).copy()
    seeds = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1),
             (w // 2, 0), (w // 2, h - 1), (0, h // 2), (w - 1, h // 2)]
    for s in seeds:
        if m.getpixel(s) == 128:
            ImageDraw.floodfill(m, s, 255)
    exterior = np.asarray(m) == 255
    if exterior.mean() < 0.5:
        raise RuntimeError(f"cutout flood failed (tol {tol:.0f}, "
                           f"exterior {100 * exterior.mean():.0f}%) - raw kept for the upgrade pass")

    solid = ~exterior
    # Opening (erode then dilate) drops stray grain specks the flood
    # couldn't reach without nibbling the bird.
    sm = Image.fromarray(solid.astype(np.uint8) * 255)
    sm = sm.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3))
    solid = np.asarray(sm) > 127
    binary = solid.astype(np.uint8) * 255
    # Feather: soften the silhouette edge, keep the interior fully opaque,
    # never bleed outside the silhouette.
    af = np.asarray(Image.fromarray(binary).filter(ImageFilter.GaussianBlur(0.8))).copy()
    af[~solid] = 0

    rgba = np.dstack([arr, af]).astype(np.uint8)
    fg = af > 40
    ys, xs = np.where(fg)
    if not len(ys):
        raise RuntimeError("cutout produced an empty image (bad ground?)")
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    pad = round(0.03 * max(y1 - y0, x1 - x0))
    y0 = max(0, y0 - pad); x0 = max(0, x0 - pad)
    y1 = min(h, y1 + pad); x1 = min(w, x1 + pad)
    save_png_atomic(Image.fromarray(rgba[y0:y1, x0:x1]), dst)
    build_masks.fsync_directory(dst.parent)


def record_cut(slug: str, kind: str) -> None:
    cuts = {}
    if CUTS.exists():
        try:
            cuts = json.loads(CUTS.read_text())
        except ValueError:
            cuts = {}
    cuts[slug] = kind
    CUTS.write_text(json.dumps(cuts, indent=0, sort_keys=True) + "\n")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sci", required=True)
    ap.add_argument("--com", required=True)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--sleep", type=float, default=6.0,
                    help="seconds between the two Gemini calls")
    args = ap.parse_args()

    key = os.environ.get("GEMINI_API_KEY", "")
    if not key:
        print("error: GEMINI_API_KEY required in the environment", file=sys.stderr)
        return 2

    # generate.php holds this lock while spawning us. Blocking here is
    # intentional: the API only waits for a live PID, releases its descriptor,
    # and then this worker owns the same lock through every PNG/index mutation.
    # The updater takes the lock only after its separate root update lock, while
    # generation never takes that update lock, so there is no lock-order cycle.
    try:
        generation_lock = build_masks.open_generation_lock(GENERATION_LOCK)
        fcntl.flock(generation_lock.fileno(), fcntl.LOCK_EX)
    except (OSError, RuntimeError) as exc:
        print(f"error: illustration generation lock unavailable: {exc}", file=sys.stderr)
        return 2
    try:
        revision_state = build_masks.open_art_revision_state(
            os.fstat(generation_lock.fileno()).st_gid
        )
        if revision_state is None:
            raise RuntimeError("illustration content revision state is missing")
    except (OSError, RuntimeError) as exc:
        fcntl.flock(generation_lock.fileno(), fcntl.LOCK_UN)
        generation_lock.close()
        print(f"error: illustration content revision unavailable: {exc}", file=sys.stderr)
        return 2

    sci, com = args.sci.strip(), args.com.strip()
    slug = pregen.slugify(sci)
    ILLUS.mkdir(parents=True, exist_ok=True)
    RAW.mkdir(parents=True, exist_ok=True)
    write_state(running=True, sci=sci, com=com, step="render")

    try:
        prompt = pregen.load_prompt(HERE / "prompt.template.md")
        notes = pregen.load_species_notes(HERE / "species-notes.json")
        refs = HERE.parent / "assets" / "references"
        pos_ref = pregen.ensure_reference(refs, slug, sci, com)
        anti_key = pregen.select_anti_ref_key(sci)
        anti = pregen.load_anti_ref(refs, anti_key) if anti_key else None

        made = []
        have = []   # poses already on disk - may still need mask registration
        content_invalidated = False
        for pose in (1, 2):
            fname = f"{slug}.png" if pose == 1 else f"{slug}-{pose}.png"
            out = ILLUS / fname
            if out.exists() and not args.force:
                print(f"[skip] {fname} exists")
                have.append(fname)
                continue
            style_path = refs / "styles" / pregen.select_style_ref(sci, pose)
            if not style_path.exists():
                # The curated style refs are gitignored and absent on
                # installs; a canonical bundled illustration anchors the
                # style instead (the fix for watercolor drift).
                style_path = ILLUS / ("turdus-migratorius.png" if pose == 1
                                      else "turdus-migratorius-2.png")
                if not style_path.exists():
                    style_path = None
            png = pregen.gen_one(key, prompt, sci, com, pose,
                                 positive_ref=pos_ref,
                                 anti_ref=anti, anti_ref_key=anti_key if anti else None,
                                 species_note=notes.get(sci),
                                 style_ref=style_path)
            raw_path = RAW / fname
            if not content_invalidated:
                # From this point a killed or partially failed render may have
                # changed pixels without matching geometry. Readers stay closed
                # until build_masks commits both tables and a fresh nonce.
                build_masks.invalidate_content_revision(revision_state)
                content_invalidated = True
            durable_atomic_bytes(raw_path, png)  # keep the raw for the upgrade pass
            chroma_cut(raw_path, out)
            record_cut(fname[:-4], "chroma")
            made.append(fname)
            print(f"[ok] {fname} ({len(png) // 1024}KB raw, chroma cut)")
            if pose == 1:
                write_state(running=True, sci=sci, com=com, step="render flight")
                time.sleep(args.sleep)

        if made or have:
            # Register skipped-but-present poses too: a run that rendered
            # pose 1 then died before this step would otherwise leave the
            # perched mask unregistered forever (the retry skips the file).
            # Re-merging a registered slug is idempotent, so this also
            # self-heals installs already stuck that way.
            write_state(running=True, sci=sci, com=com, step="masks")
            slugs = [f[:-4] for f in made + have]
            mask_environment = os.environ.copy()
            mask_environment["AVIAN_GENERATION_LOCK_FD"] = str(generation_lock.fileno())
            r = subprocess.run(
                [sys.executable, str(HERE / "build_masks.py"), "--add", *slugs],
                env=mask_environment,
                pass_fds=(generation_lock.fileno(),),
            )
            if r.returncode != 0:
                raise RuntimeError("build_masks --add failed")
    except Exception as e:
        write_state(running=False, sci=sci, com=com, ok=False, error=str(e))
        print(f"error: {e}", file=sys.stderr)
        return 1
    finally:
        # Publish the successful state only after readers can acquire the lock
        # and observe the committed nonce/tables. Failed jobs likewise release
        # promptly while retaining the invalid marker when pixels changed.
        fcntl.flock(generation_lock.fileno(), fcntl.LOCK_UN)
        generation_lock.close()
        revision_state.close()

    write_state(running=False, sci=sci, com=com, ok=True, made=made)
    print(f"done: {len(made)} rendered for {sci}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
