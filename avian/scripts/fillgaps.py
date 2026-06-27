#!/usr/bin/env python3
"""AvianVisitors - generate matching-style art for detected birds that lack it.

Self-contained gap filler, meant to run on the Pi. It:

  1. reads every species you've actually detected from BirdNET-Pi's birds.db,
  2. finds the ones with no bundled illustration,
  3. renders + cuts each one in a STAGING dir, then atomically moves the
     finished transparent cutout into avian/assets/illustrations/, and
  4. rebuilds the collage masks (build_masks.py) and bumps the cache version
     in apt.js so the new birds show up in BOTH the atlas and the collage and
     browsers drop any stale copies.

Why staging + atomic move: pregen.py first writes each PNG *with* its cream
ground, and cutout.py overwrites it transparent ~30-60s later. cutout.php
serves with a 24h cache, so a browser that loads a bird mid-generation would
cache the cream version. Generating off to the side and moving only the final
file means the served path only ever holds a finished, transparent cutout.

Idempotent: a species that already has <slug>.png is skipped. Re-run anytime
(by hand or from cron) to catch up on newly heard birds.

Cutout uses a light matting model (isnet-general-use, ~170 MB) by default so
it stays within a 4 GB Pi's RAM while BirdNET-Pi keeps running. Override with
--model birefnet-general on a beefier box for slightly cleaner mattes.

Set GEMINI_API_KEY in the environment or in a .env file next to this script
(KEY=VALUE per line; .env is gitignored).

Usage:
    .venv/bin/python3 fillgaps.py                 # fill all detected gaps
    .venv/bin/python3 fillgaps.py --dry-run       # list gaps, generate nothing
    .venv/bin/python3 fillgaps.py --species "Chaetura pelagica|Chimney Swift"
                                                  # force-regenerate one bird
    .venv/bin/python3 fillgaps.py --limit 3       # only the first 3 gaps
    .venv/bin/python3 fillgaps.py --no-masks      # skip mask rebuild + bump
"""
from __future__ import annotations
import argparse
import os
import re
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
AVIAN = HERE.parent
ILLUS = AVIAN / "assets" / "illustrations"
STAGING = AVIAN / "assets" / ".staging"
APT = AVIAN / "frontend" / "apt.js"
DEFAULT_DB = AVIAN.parent / "scripts" / "birds.db"


def slugify(sci: str) -> str:
    """Match pregen.py / apt.js slugify() exactly."""
    return re.sub(r"[^a-z0-9]+", "-", sci.lower()).strip("-")


def load_dotenv() -> None:
    """Load KEY=VALUE lines from .env next to this script into os.environ.
    Existing environment values win."""
    env = HERE / ".env"
    if not env.is_file():
        return
    for line in env.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def detected_species(db: Path) -> list[tuple[str, str]]:
    """Distinct (Sci_Name, Com_Name) the analyzer has logged, most-heard first."""
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        rows = con.execute(
            "SELECT Sci_Name, Com_Name, COUNT(*) c FROM detections "
            "GROUP BY Sci_Name ORDER BY c DESC"
        ).fetchall()
    finally:
        con.close()
    return [(r[0], r[1]) for r in rows]


def bump_versions(apt: Path) -> str:
    """Increment SKETCH_VERSION and IMG_VERSION ('rN' -> 'rN+1') so browsers
    and any CDN drop cached image copies. Returns the new token."""
    src = apt.read_text()
    nums = [int(n) for n in re.findall(r"(?:SKETCH|IMG)_VERSION = 'r(\d+)'", src)]
    nxt = (max(nums) + 1) if nums else 1
    src = re.sub(r"((?:SKETCH|IMG)_VERSION = ')r\d+(')",
                 lambda m: f"{m.group(1)}r{nxt}{m.group(2)}", src)
    apt.write_text(src)
    return f"r{nxt}"


def generate_one(sci: str, com: str, model: str) -> list[str]:
    """Render + cut one species in STAGING, atomically move finished cutouts
    into ILLUS. Returns the list of slugs successfully placed."""
    slug = slugify(sci)
    py = sys.executable
    STAGING.mkdir(parents=True, exist_ok=True)
    for s in (slug, f"{slug}-2"):  # clear any stale staging files
        (STAGING / f"{s}.png").unlink(missing_ok=True)

    r = subprocess.run([py, str(HERE / "pregen.py"), "--species", f"{sci}|{com}",
                        "--out", str(STAGING), "--force"])
    if r.returncode != 0:
        print(f"  pregen failed for {slug}", file=sys.stderr)
        return []
    staged = [s for s in (slug, f"{slug}-2") if (STAGING / f"{s}.png").is_file()]
    if not staged:
        print(f"  nothing rendered for {slug}", file=sys.stderr)
        return []
    r = subprocess.run([py, str(HERE / "cutout.py"), "--dir", str(STAGING),
                        "--model", model, "--force", *staged])
    if r.returncode != 0:
        print(f"  cutout failed for {slug}", file=sys.stderr)
        return []
    placed = []
    for s in staged:
        os.replace(STAGING / f"{s}.png", ILLUS / f"{s}.png")  # atomic, same fs
        placed.append(s)
    return placed


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", type=Path, default=DEFAULT_DB,
                    help=f"birds.db path (default: {DEFAULT_DB})")
    ap.add_argument("--species", action="append", default=[],
                    help="Force-(re)generate this 'Sci|Com' bird, ignoring the "
                         "gap check. Repeatable.")
    ap.add_argument("--model", default="isnet-general-use",
                    help="rembg cutout model (default: isnet-general-use)")
    ap.add_argument("--limit", type=int, default=0,
                    help="Only fill the first N gaps this run (0 = all)")
    ap.add_argument("--dry-run", action="store_true",
                    help="List the gaps and exit without generating")
    ap.add_argument("--no-masks", action="store_true",
                    help="Skip the collage mask rebuild + cache-version bump")
    args = ap.parse_args()

    load_dotenv()

    # Build the work list: explicit --species override, else detected gaps.
    if args.species:
        targets = []
        for spec in args.species:
            if "|" not in spec:
                print(f"error: --species must be 'Sci|Com', got {spec!r}",
                      file=sys.stderr)
                return 2
            sci, com = spec.split("|", 1)
            targets.append((sci.strip(), com.strip()))
        print(f"force-regenerating {len(targets)} species:")
        for sci, com in targets:
            print(f"  - {com}  ({sci})  -> {slugify(sci)}.png")
    else:
        if not args.db.is_file():
            print(f"error: birds.db not found at {args.db}", file=sys.stderr)
            return 2
        species = detected_species(args.db)
        targets = [(sci, com) for sci, com in species
                   if not (ILLUS / f"{slugify(sci)}.png").is_file()]
        if not targets:
            print(f"All {len(species)} detected species already have illustrations.")
            return 0
        print(f"{len(targets)} of {len(species)} detected species need art:")
        for sci, com in targets:
            print(f"  - {com}  ({sci})  -> {slugify(sci)}.png")
        if args.dry_run:
            return 0
        if args.limit > 0:
            targets = targets[:args.limit]

    if args.dry_run:
        return 0
    if not os.environ.get("GEMINI_API_KEY"):
        print(f"\nerror: GEMINI_API_KEY not set (export it or put it in "
              f"{HERE/'.env'})", file=sys.stderr)
        return 2

    placed_any, failures = [], []
    for sci, com in targets:
        print(f"\n=== {com} ({sci}) ===")
        placed = generate_one(sci, com, args.model)
        if placed:
            placed_any.extend(placed)
        else:
            failures.append(slugify(sci))

    if STAGING.is_dir():
        shutil.rmtree(STAGING, ignore_errors=True)

    if placed_any and not args.no_masks:
        print("\n=== rebuilding collage masks + bumping cache version ===")
        subprocess.run([sys.executable, str(HERE / "build_masks.py"),
                        "--illustrations", str(ILLUS), "--apt", str(APT)])
        ver = bump_versions(APT)
        print(f"cache version bumped to {ver}")

    done = len(set(s.removesuffix("-2") for s in placed_any))
    print(f"\nfilled {done} species · "
          f"{'failures: ' + ', '.join(failures) if failures else 'no failures'}")
    print("Birds serve immediately via cutout.php; reload the page to see them.")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
