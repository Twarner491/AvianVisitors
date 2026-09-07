"""Panel self-test: push a distinctive test card to the e-paper panel and report
whether a real refresh happened. Run it on the Pi:

    python3 _panel_test.py --times 3

Exits 0 on a BUSY-verified refresh, 1 if no refresh reached the panel (a silent
no-op). --times N pushes N consecutive refreshes to confirm the panel keeps
refreshing — a wedged controller would fail a later one.

This only exercises the panel path (display.push_panel); it needs no BirdNET,
bird site, or apt.js, so it validates the panel in isolation.
"""
import argparse
import os
import sys
import time

from PIL import Image, ImageDraw

import display

PANEL = "waveshare13in3e"


def make_card(w, h):
    img = Image.new("RGB", (w, h), (236, 234, 223))  # paper
    d = ImageDraw.Draw(img)
    d.rectangle([80, 80, w - 80, h - 80], outline=(26, 26, 28), width=24)
    d.rectangle([150, 200, int(w * 0.58), 750], fill=(165, 60, 56))      # red
    d.rectangle([int(w * 0.62), 200, w - 150, 750], fill=(49, 71, 130))  # blue
    d.rectangle([150, 900, w - 150, h - 150], fill=(198, 176, 74))       # yellow
    for y in range(950, h - 150, 100):
        d.rectangle([180, y, w - 180, y + 40], fill=(26, 26, 28))        # stripes
    return img


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--times", type=int, default=1,
                    help="consecutive refreshes to push (default 1)")
    ap.add_argument("--panel", default=PANEL, help="panel name (default %(default)s)")
    args = ap.parse_args()

    cache = os.path.expanduser("~/.birdframe")
    os.makedirs(cache, exist_ok=True)
    img = make_card(display.PANEL_W, display.PANEL_H)

    for i in range(1, args.times + 1):
        t0 = time.monotonic()
        try:
            elapsed = display.push_panel(
                img, rotate=90, saturation=0.6,
                panel=args.panel, cache_dir=cache, auto_power_cycle=False)
        except display.PanelRefreshError as e:
            total = time.monotonic() - t0
            print(f"[{i}/{args.times}] FAIL after {total:.1f}s: {e}")
            print(f"RESULT=FAIL (refresh {i} of {args.times} never reached the panel)")
            return 1
        total = time.monotonic() - t0
        print(f"[{i}/{args.times}] PASS  BUSY-verified  PUSH_ELAPSED={elapsed:.1f}s TOTAL={total:.1f}s")

    print(f"RESULT=PASS ({args.times}/{args.times} refreshes BUSY-verified on the panel)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
