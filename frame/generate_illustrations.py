#!/usr/bin/env python3
"""Generate the kachō-e illustrations a ZIP needs but the repo doesn't bundle.

Compares a ZIP's most-detected birds (BirdWeather) against the bundled
illustration set and, for the gap, runs the repo's illustration pipeline:

    pregen.py (Gemini, cream ground)
      -> cutout.py (BiRefNet matte via rembg)
      -> build_masks.py (so the new birds become drawable)

The bundled set centers on the western U.S., so an out-of-region frame drops
its local birds until they are generated. Run this on a machine with the
pipeline deps (rembg + onnxruntime, per avian/scripts/requirements.txt) - a
laptop or workstation, not the frame Pi, which can't fit rembg in memory. Then
commit the new cutouts (or copy them to the Pi) and the frame draws them.

Needs a PAID Google Gemini API key: image generation is not on the free tier.
Get one at https://ai.google.dev, then pass it by env (keeps it out of shell
history) or let it prompt:

    GEMINI_API_KEY=KEY python3 frame/generate_illustrations.py --zip 10001
    python3 frame/generate_illustrations.py --zip 10001            # prompts for the key
    python3 frame/generate_illustrations.py --zip 10001 --gemini-key KEY

--country and --sample carry through for non-US postcodes or a wider region.
"""
from __future__ import annotations

import argparse
import getpass
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.join(HERE, "..", "avian", "scripts")
ILLUSTRATIONS = os.path.join(HERE, "..", "avian", "assets", "illustrations")

sys.path.insert(0, HERE)
import birdweather  # noqa: E402  (local module, after sys.path is set)


def _generate(missing, key):
    """Run pregen -> cutout (rembg) -> build_masks for the missing species.
    Returns 0 on success."""
    lines = "".join(f'{s["sci"]}|{s["com"]}\n' for s in missing)
    print(f"\nGenerating {len(missing)} birds x 2 poses with Gemini (a few minutes; "
          f"~6s between calls to stay under the rate limit)...")
    # Key via env, not argv, so it doesn't surface in `ps` during the long run.
    env = dict(os.environ, GEMINI_API_KEY=key)
    r = subprocess.run([sys.executable, os.path.join(SCRIPTS, "pregen.py"), "--stdin"],
                       input=lines, text=True, env=env)
    if r.returncode not in (0, 1):  # 1 = some species failed; still cut what landed
        print("generation failed; leaving the bundle unchanged", file=sys.stderr)
        return r.returncode

    made = []
    for s in missing:
        base = birdweather.slugify(s["sci"])
        made += [g for g in (base, base + "-2")
                 if os.path.isfile(os.path.join(ILLUSTRATIONS, g + ".png"))]
    if not made:
        print("no illustrations were produced; nothing to cut", file=sys.stderr)
        return 1

    print(f"\nCutting the cream ground off {len(made)} new illustrations (rembg)...")
    c = subprocess.run([sys.executable, os.path.join(SCRIPTS, "cutout.py")] + made)
    if c.returncode != 0:
        print("cutout failed; not rebuilding masks", file=sys.stderr)
        return c.returncode

    print("\nRebuilding the collage masks so the new birds become drawable...")
    b = subprocess.run([sys.executable, os.path.join(SCRIPTS, "build_masks.py")])
    if b.returncode != 0:
        return b.returncode
    print(f"\nDone - {len(made)} new illustrations are cut and drawable. Commit them "
          f"(or copy them to the frame Pi) and the collage will draw them.")
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--zip", required=True)
    ap.add_argument("--country", default="us")
    ap.add_argument("--gemini-key", default=os.environ.get("GEMINI_API_KEY", ""),
                    help="Paid Google Gemini API key (or GEMINI_API_KEY env).")
    ap.add_argument("--sample", type=int, default=15,
                    help="How many of the ZIP's top birds to weigh (default 15).")
    a = ap.parse_args()

    try:
        have, missing = birdweather.coverage_for_zip(a.zip, a.country, a.sample)
    except Exception as e:
        print(f"coverage lookup for {a.zip} failed ({e})", file=sys.stderr)
        return 1
    total = len(have) + len(missing)
    if not missing:
        if total == 0:
            print(f"Couldn't find local birds for {a.zip} (BirdWeather may have no "
                  f"station nearby).")
        else:
            print(f"All {total} of the top birds near {a.zip} are already bundled - "
                  f"nothing to generate.")
        return 0

    names = ", ".join(s["com"] for s in missing[:6]) + (" ..." if len(missing) > 6 else "")
    print(f"{len(missing)} of the top {total} birds near {a.zip} aren't bundled:\n  {names}")

    key = a.gemini_key
    if not key:
        if not sys.stdin.isatty():
            print("\nPass --gemini-key <KEY> (a paid Google Gemini key, https://ai.google.dev) "
                  "to generate them.", file=sys.stderr)
            return 1
        key = getpass.getpass("\nPaste your Gemini API key (paid; https://ai.google.dev): ").strip()
        if not key:
            print("No key entered.", file=sys.stderr)
            return 1

    return _generate(missing, key)


if __name__ == "__main__":
    sys.exit(main())
