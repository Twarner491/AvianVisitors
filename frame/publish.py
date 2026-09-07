#!/usr/bin/env python3
"""Render the collage on the mic Pi and publish it in the site's own web root.

The frame Pi (a Zero 2 W or 3 A+) needs ~70-120s and ~300MB of Chromium to
shoot the collage itself. The mic Pi already serves the page and is usually a
4/5, so it renders in seconds - this runs there on a timer and drops the PNG
where Caddy already serves every other static asset. The frame Pi then runs in
image_url mode with no browser at all.

This is also the *only* place the refresh is decided. frame.png changes only
when the birds change, so the frame Pi can gate on the image itself (a
conditional GET) instead of re-deriving the same answer from the API on its own
clock. Two gates on two machines race: a bird arriving between the last render
and the frame Pi's poll flips its signature while the published image still
predates the bird, and the panel is then stranded on the stale collage until the
next species change or the daily heal, with both machines logging success.

Settings come from the environment first (FRAME_URL, FRAME_OUT, ...) so the
systemd unit can pass no arguments at all and /etc/birdframe/publish.env is the
whole tuning surface; CLI flags override for hand runs.

  publish.py --out ~/BirdSongs/frame/frame.png --force
"""
from __future__ import annotations

import argparse
import fcntl
import os
import re
import struct
import sys
import time

from shoot import shoot
# The gate is display.py's, imported rather than reimplemented: both machines
# must bucket call counts identically or the frame Pi's heal is the only thing
# that ever corrects a disagreement. display.py imports PIL at module scope
# (hence Pillow in requirements-publish.txt) but imports inky lazily inside
# push_panel, so this is safe on a machine with no panel.
from display import _auth, fetch_recent, signature, load_state, save_state

# The panel is 1200x1600 and display.py silently resizes anything else, so a
# viewport or device-scale-factor regression would ship soft with no error.
PANEL_W, PANEL_H = 1200, 1600

DEFAULT_URL = "http://127.0.0.1/"          # this Pi's own site; see main()
DEFAULT_TITLE = "Avian Visitors"
DEFAULT_SUBTITLE = "Heard Today"
# 0.65 matches display.py's shoot_count_exp and the countExp already in apt.js.
# shoot.py's own default is 0.4, which would flatten the size hierarchy - the
# frame has to look identical whichever Pi rendered it.
DEFAULT_COUNT_EXP = 0.65
# Playwright applies this to each step separately (goto, the tile wait, the
# image wait), so a run can legitimately take ~3x this plus browser launch.
# TimeoutStartSec in the unit is sized off that, not off this number.
DEFAULT_TIMEOUT_MS = 60000
DEFAULT_HOURS = 24                         # matches display.py and the page's own default
# Re-render at least this often even when the birds have not moved, mirroring
# display.py's heal_hours. Without it a frame.png truncated by a full disk, or
# clobbered by something else, is never repaired for as long as the species set
# holds - and the gate would keep reporting "no change" over the damage.
DEFAULT_HEAL_HOURS = 24


def recs_dir(conf="/etc/birdnet/birdnet.conf"):
    """RECS_DIR from birdnet.conf, so the default output path is never a
    hardcoded ~/BirdSongs - installs relocate it.

    The real file lives here rather than in EXTRACTED (the web root);
    install-publish.sh symlinks it in, which is the same shape spectrogram.png
    already uses. Keeping it out of the root also keeps the lock and temp files
    off the file_server listing.
    """
    try:
        with open(conf) as f:
            for line in f:
                m = re.match(r'\s*RECS_DIR=([^#]*)', line)
                if m:
                    return os.path.expandvars(m.group(1).strip().strip('"\''))
    except OSError:
        pass
    return os.path.expanduser("~/BirdSongs")


def png_size(path):
    """(width, height) straight out of the PNG IHDR, without decoding 1.5MB of
    image data to learn two integers."""
    with open(path, "rb") as f:
        head = f.read(24)
    if len(head) < 24 or head[:8] != b"\x89PNG\r\n\x1a\n" or head[12:16] != b"IHDR":
        raise RuntimeError(f"{path} is not a PNG")
    return struct.unpack(">II", head[16:24])


def sweep(out):
    """Remove a temp render a previous run left behind. publish() cleans up
    after itself on any *exception*, but systemd's TimeoutStartSec sends SIGTERM
    and a cgroup OOM sends SIGKILL - neither runs `finally`, so without this a
    killed render leaks 1.5MB next to the published frame every time."""
    try:
        os.unlink(f"{out}.tmp.png")
    except OSError:
        pass


def publish(url, out, **look):
    """Shoot into a sibling temp file, sanity-check it, then swap it in.

    Anything that raises leaves the published frame - and its mtime - exactly as
    they were, which is what lets the frame Pi keep showing the last good image
    through an outage.
    """
    # Sibling, not /tmp: os.replace is only atomic within one filesystem and
    # /tmp is a separate tmpfs here. A fixed name is safe because the flock in
    # main() already guarantees one publisher at a time, and a fixed name is
    # what makes the sweep above able to find it. It has to keep a .png
    # extension: shoot() hands the path straight to page.screenshot(), and
    # Playwright infers the image format from it - a bare ".tmp" is rejected
    # as an unsupported mime type before a single pixel is rendered.
    tmp = f"{out}.tmp.png"
    try:
        shoot(url, tmp, **look)
        w, h = png_size(tmp)
        if (w, h) != (PANEL_W, PANEL_H):
            raise RuntimeError(f"render is {w}x{h}, expected {PANEL_W}x{PANEL_H}")
        size = os.path.getsize(tmp)
        # Deliberately no "this looks too small, reject it" guard. A big drop in
        # PNG size is normal - twelve species at dawn against two at 4am on a
        # rolling 24h window, a quiet winter day, or the birdless title card
        # shoot.py renders on purpose. Any such guard compares against the last
        # *published* frame, which by definition never updates while the guard
        # is firing, so one legitimate small render would wedge publishing
        # permanently and burn a Chromium launch every tick forever. Log the
        # size instead and let a human spot a run of tiny frames in the journal.
        os.chmod(tmp, 0o644)  # caddy is in the birdnet group; a tight umask would 403
        os.replace(tmp, out)
    finally:
        try:
            os.unlink(tmp)  # a failed shoot must not leave litter next to the frame
        except OSError:
            pass  # never mask the real render error with a cleanup error
    return size


def changed(url, out, state_path, hours, timeout_ms, heal_hours, auth=None):
    """(should_render, signature) - has the bird set moved since the last publish?

    The signature is fetched even when we already know we must render (no frame
    on disk yet), so the first successful publish records it and the second tick
    is a cheap skip instead of a redundant render.

    A fetch that fails is treated as "no change" when a frame already exists,
    matching display.py: a blip in the API must not trigger a render storm, and
    the published frame is still valid. With no frame at all we render anyway -
    an unpublished frame is worse than a possibly-redundant render.
    """
    state = load_state(state_path)
    # A frame that has gone stale past the heal window is re-rendered whatever
    # the signature says, so damage the gate cannot see gets repaired daily.
    due = time.time() - state.get("last_refresh", 0) >= heal_hours * 3600
    first_run = not os.path.exists(out)
    try:
        # auth matters: on a site behind basic auth an unauthenticated gate fetch
        # 401s every tick, which reads as "no change" and freezes the frame on
        # whatever the first run published - forever, with both machines
        # reporting success. That is the exact failure this file exists to avoid.
        sig = signature(fetch_recent(url, hours, timeout_ms / 1000, auth))
    except Exception as e:
        print(f"signature fetch failed: {e}", file=sys.stderr)
        return first_run or due, None
    return first_run or due or sig != state.get("signature"), sig


def env_default(name, fallback, cast=str):
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return fallback
    try:
        return cast(raw)
    except ValueError:
        print(f"{name}={raw!r} is not valid; using {fallback!r}", file=sys.stderr)
        return fallback


def main():
    ap = argparse.ArgumentParser(
        description="Render frame.png and publish it in the web root.",
        epilog="Every option also reads an env var (FRAME_URL, FRAME_OUT, ...), "
               "so the systemd unit passes no arguments and /etc/birdframe/publish.env "
               "is the tuning surface. Flags win over the environment.")
    # 127.0.0.1, not birdnet.local: the site is on this machine, and avahi may
    # not be answering yet when the timer first fires after boot.
    ap.add_argument("--url", default=env_default("FRAME_URL", DEFAULT_URL))
    ap.add_argument("--out", default=env_default(
        "FRAME_OUT", os.path.join(recs_dir(), "frame", "frame.png")))
    ap.add_argument("--state", default=env_default(
        "FRAME_STATE", "~/.birdframe/publish-state.json"),
        help="publisher's own gate state; NOT the frame Pi's state.json")
    ap.add_argument("--title", default=env_default("FRAME_TITLE", DEFAULT_TITLE))
    ap.add_argument("--subtitle", default=env_default("FRAME_SUBTITLE", DEFAULT_SUBTITLE))
    ap.add_argument("--hours", type=int, default=env_default("FRAME_HOURS", DEFAULT_HOURS, int),
                    help="detection window used for the change gate")
    ap.add_argument("--headline-px", type=int, default=env_default("FRAME_HEADLINE_PX", 42, int))
    ap.add_argument("--eyebrow-px", type=int, default=env_default("FRAME_EYEBROW_PX", 18, int))
    # BooleanOptionalAction, not store_true: with an env-derived default of True
    # a store_true flag is a no-op and there is no way to turn it back off from
    # the command line. This gives --lowercase / --no-lowercase.
    ap.add_argument("--lowercase", action=argparse.BooleanOptionalAction,
                    default=env_default("FRAME_LOWERCASE", "", str).lower()
                    in ("1", "true", "yes", "on"))
    ap.add_argument("--mat", type=float, default=env_default("FRAME_MAT", 0.04, float))
    ap.add_argument("--small-floor", type=float, default=env_default("FRAME_SMALL_FLOOR", 0.04, float))
    ap.add_argument("--count-exp", type=float,
                    default=env_default("FRAME_COUNT_EXP", DEFAULT_COUNT_EXP, float))
    ap.add_argument("--timeout", type=int,
                    default=env_default("FRAME_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, int),
                    help="milliseconds, applied per Playwright step")
    ap.add_argument("--heal-hours", type=float,
                    default=env_default("FRAME_HEAL_HOURS", DEFAULT_HEAL_HOURS, float),
                    help="re-render at least this often even with no bird change")
    ap.add_argument("--user", default=env_default("FRAME_USER", None))
    ap.add_argument("--password", default=env_default("FRAME_PASSWORD", None))
    ap.add_argument("--force", action="store_true", help="render even if the birds have not changed")
    a = ap.parse_args()

    out = os.path.abspath(os.path.expanduser(a.out))
    state_path = os.path.expanduser(a.state)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    # `or "."` because --state may be a bare filename, and os.makedirs("") raises.
    os.makedirs(os.path.dirname(state_path) or ".", exist_ok=True)
    auth = _auth({"basic_user": a.user, "basic_pass": a.password})

    # systemd already refuses to start a second copy of a oneshot that is still
    # running, so this only guards a hand-run publish racing the timer: two
    # chromiums at once on a Pi that is also doing realtime tflite inference.
    # Deliberately NOT display.py's .render.lock - that one serialises panel
    # pushes, and sharing the name would deadlock a combined install. It sits
    # beside the state file rather than the output, because the output directory
    # may be inside the web root on a custom FRAME_OUT and a lock file has no
    # business being fetchable.
    lock = open(os.path.join(os.path.dirname(state_path) or ".", ".publish.lock"), "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print("another publish is in progress; skipping")
        return

    sweep(out)

    # The signature is fetched even under --force, so a hand-forced render still
    # records where the birds were; otherwise the next timer tick sees the stale
    # recorded signature and renders a second time for nothing.
    moved, sig = changed(a.url, out, state_path, a.hours, a.timeout, a.heal_hours, auth)
    if not (a.force or moved):
        print("no change; skip")
        return

    try:
        size = publish(a.url, out, title=a.title, subtitle=a.subtitle,
                       headline_px=a.headline_px, eyebrow_px=a.eyebrow_px,
                       lowercase=a.lowercase, mat=a.mat, small_floor=a.small_floor,
                       count_exp=a.count_exp, timeout_ms=a.timeout,
                       # The gate hashes `hours` of detections, so the render has
                       # to cover the same window or a change outside the drawn
                       # window triggers a full repaint of an identical collage.
                       window_hours=a.hours,
                       user=a.user, password=a.password)
    except Exception as e:
        # Non-zero so `systemctl --failed` surfaces it. The previous frame.png is
        # still published and the frame Pi keeps showing it.
        print(f"publish failed, keeping the last frame: {e}", file=sys.stderr)
        sys.exit(1)

    # Only after a successful publish, so a failed render is retried next tick
    # instead of being recorded as done.
    if sig is not None:
        save_state(state_path, sig, time.time())
    print(f"published {out} ({size} bytes)")


if __name__ == "__main__":
    main()
