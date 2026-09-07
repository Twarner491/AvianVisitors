#!/usr/bin/env python3
"""Frame-Pi client: turn a collage screenshot into Inky panel pixels.

Runs on the frame Pi (a 3 A+ or Zero 2 W) on a systemd timer. Each run it decides whether a
refresh is worth it (the species set or call-count brackets changed, and it
is not quiet hours), then crops the title and collage from the screenshot,
centres and mats them, and pushes the result to the Inky Impression 13.3".
``--preview out.png`` writes an approximate 6-ink dither instead, so the
look can be checked on any machine without the panel.
"""
from __future__ import annotations

import argparse
import fcntl
import base64
import hashlib
import inspect
import io
import json
import os
import re
import statistics
import sys
import time
import urllib.request
from datetime import datetime

from PIL import Image, ImageChops, ImageDraw

try:
    import tomllib
except ModuleNotFoundError:  # Python < 3.11
    import tomli as tomllib

PANEL_W, PANEL_H = 1200, 1600  # portrait; the panel itself is 1600x1200

# Approximate Spectra-6 inks, used only for --preview. On hardware the Inky
# library maps to the panel's real palette.
SPECTRA6 = [(236, 234, 223), (26, 26, 28), (165, 60, 56),
            (198, 176, 74), (49, 71, 130), (58, 110, 72)]

DEFAULTS = {
    "base_url": "http://birdnet.local",
    "species_source": "",   # "" = the recent API; "birdweather" = one station or a ZIP
    "zip": "",              # BirdWeather ZIP / postal code (use one locator only)
    "bw_station_id": "",    # public BirdWeather station ID (use instead of zip)
    "bw_days": 7,           # BirdWeather lookback window, in days
    "bw_country": "us",     # geocoder country for the ZIP
    "hours": 24,
    "daily_reset": False,   # True = "Heard Today" window is since local midnight,
                            # not the last `hours`; resets daily at the device TZ's midnight
    "image": "",            # local PNG written by the shooter
    "image_url": "",        # or a published screenshot URL
    "shoot": False,         # or capture inline (needs a browser; the 3 A+ and Zero 2 W both handle it)
    "shoot_title": None, "shoot_subtitle": None,
    "shoot_headline_px": 42, "shoot_eyebrow_px": 18, "shoot_lowercase": False,
    "shoot_mat": 0.04, "shoot_small_floor": 0.04, "shoot_count_exp": 0.65,
    "bird_names": False,
    "mat": 0.0,             # extra global shrink of the content inside the A5 opening
    "opening": 0.7071,      # opening height as a panel fraction; 0.7071 preserves A5
    "rotate": 90,           # 90 or 270 if the frame hangs the other way up
    "saturation": 0.6,
    "panel": "",            # "el133uf1" forces the 13.3" driver if auto() fails;
                            # "waveshare13in3e" for the Waveshare 13.3" HAT+ (E)
    "quiet_start": 0, "quiet_end": 0,    # 0/0 = no quiet hours
    "heal_hours": 24,
    "state": "~/.birdframe/state.json",
    "cache": "~/.birdframe",
    "timeout": 180,      # seconds; a Zero 2 W needs ~70-120s to shoot the collage
    "basic_user": None, "basic_pass": None,
    "auto_power_cycle": True,  # reboot to power-cycle a wedged e-ink controller on a no-op refresh
}


def _auth(cfg):
    if not cfg.get("basic_user"):
        return None
    raw = f"{cfg['basic_user']}:{cfg.get('basic_pass') or ''}".encode()
    return "Basic " + base64.b64encode(raw).decode()


# --- change detection -------------------------------------------------------
def slugify(sci):
    return re.sub(r"[^a-z0-9]+", "-", sci.lower()).strip("-")


def _bucket(n):
    for i, edge in enumerate((1, 2, 5, 15, 40, 100, 300, 1000)):
        if n <= edge:
            return i
    return 8


def fetch_recent(base, hours, timeout, auth=None, daily=False):
    url = f"{base.rstrip('/')}/avian/api/birdnet-api.php?action=recent&hours={hours}"
    if daily:
        url += "&daily=1"
    req = urllib.request.Request(url, headers={"User-Agent": "AvianVisitors-frame/1.0"})
    if auth:
        req.add_header("Authorization", auth)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read(2_000_000)).get("species", [])


def signature(species, scope=""):
    items = sorted((slugify(s["sci"]), _bucket(int(s.get("n") or 1))) for s in species)
    material = [scope, items] if scope else items
    return hashlib.sha256(json.dumps(material).encode()).hexdigest()[:16]


def birdweather_locator(cfg):
    """Return (kind, value) for the one configured BirdWeather source."""
    station = cfg.get("bw_station_id")
    has_station = station not in (None, "", 0)
    zip_code = cfg.get("zip")
    has_zip = isinstance(zip_code, str) and bool(zip_code.strip())
    if has_station and has_zip:
        raise ValueError("BirdWeather config must use either bw_station_id or zip, not both")
    if has_station:
        import birdweather
        return "station", birdweather.station_id(station)
    if has_zip:
        return "zip", zip_code.strip()
    raise ValueError("BirdWeather config needs bw_station_id or zip")


def birdweather_signature_scope(cfg):
    kind, value = birdweather_locator(cfg)
    if kind == "station":
        return f"birdweather:station:{value}:days:{cfg['bw_days']}"
    return f"birdweather:zip:{cfg['bw_country']}:{value}:days:{cfg['bw_days']}"


def fetch_species(cfg, auth=None):
    """The species list the signature is built from: the BirdNET-Pi recent API
    by default, or BirdWeather detections from one station or near a ZIP when
    species_source = "birdweather"."""
    if cfg.get("species_source") == "birdweather":
        import birdweather
        kind, value = birdweather_locator(cfg)
        if kind == "station":
            return birdweather.species_for_station(value, days=cfg["bw_days"])
        return birdweather.species_for_zip(value, country=cfg["bw_country"], days=cfg["bw_days"])
    return fetch_recent(cfg["base_url"], cfg["hours"], cfg["timeout"], auth,
                        daily=cfg.get("daily_reset", False))


# --- image ------------------------------------------------------------------
def get_image(src, timeout, auth=None):
    if re.match(r"^https?://", src):
        req = urllib.request.Request(src, headers={"User-Agent": "AvianVisitors-frame/1.0"})
        if auth:
            req.add_header("Authorization", auth)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return Image.open(io.BytesIO(r.read(20_000_000))).convert("RGB")
    return Image.open(os.path.expanduser(src)).convert("RGB")


def fit_panel(img):
    if img.size != (PANEL_W, PANEL_H):
        img = img.resize((PANEL_W, PANEL_H), Image.LANCZOS)
    return img


def _paper(img):
    """Median of the four corners, robust to a stray inked corner."""
    w, h = img.size
    px = (img.getpixel(p) for p in ((4, 4), (w - 5, 4), (4, h - 5), (w - 5, h - 5)))
    return tuple(int(statistics.median(c)) for c in zip(*px))


# The opening is a 1:sqrt(2) rectangle centred in the panel. `opening` sets
# how much of the panel height it covers; 0.7071 preserves the A5 default.
def opening_size(opening):
    if isinstance(opening, bool):
        raise ValueError("opening must be greater than 0 and at most 1")
    try:
        opening = float(opening)
    except (TypeError, ValueError) as exc:
        raise ValueError("opening must be greater than 0 and at most 1") from exc
    if not 0 < opening <= 1:
        raise ValueError("opening must be greater than 0 and at most 1")
    h = PANEL_H * opening
    return h / 1.41421, h


def _place(content, paper, mat, opening):
    box_w, box_h = opening_size(opening)
    s = min(box_w * (1 - mat) / content.width, box_h * (1 - mat) / content.height)
    nw, nh = max(1, round(content.width * s)), max(1, round(content.height * s))
    content = content.resize((nw, nh), Image.LANCZOS)
    canvas = Image.new("RGB", (PANEL_W, PANEL_H), paper)
    canvas.paste(content, ((PANEL_W - nw) // 2, (PANEL_H - nh) // 2))
    return canvas


def _region_bbox(img, paper, y0, y1):
    region = img.crop((0, y0, img.width, y1))
    diff = ImageChops.difference(region, Image.new("RGB", region.size, paper))
    bb = diff.convert("L").point(lambda p: 255 if p > 34 else 0).getbbox()
    return None if not bb else (bb[0], y0 + bb[1], bb[2], y0 + bb[3])


def _scale_w(img, target_w):
    s = target_w / img.width
    return img.resize((max(1, round(img.width * s)), max(1, round(img.height * s))), Image.LANCZOS)


def _scale_h(img, target_h):
    s = target_h / img.height
    return img.resize((max(1, round(img.width * s)), max(1, round(img.height * s))), Image.LANCZOS)


def _centroid_x(img, paper):
    """Horizontal centre of ink weight (what the eye reads as centred)."""
    m = ImageChops.difference(img, Image.new("RGB", img.size, paper)).convert("L")
    cols = list(m.resize((img.width, 1), Image.BOX).tobytes())
    total = sum(cols) or 1
    return sum(x * v for x, v in enumerate(cols)) / total


# Content layout inside the A5 opening: the title and collage are sized
# independently (as fractions of the opening width), so tuning one leaves the
# other untouched. gap is a fraction of the opening height.
TITLE_H_FRAC, COLLAGE_FRAC, GAP_FRAC = 0.065, 0.66, 0.1


def mat_and_center(img, mat, opening):
    """Crop the title and collage, size each to a fraction of the opening,
    stack with a gap, and centre on the panel."""
    img = img.convert("RGB")
    paper = _paper(img)
    mask = ImageChops.difference(img, Image.new("RGB", img.size, paper))
    mask = mask.convert("L").point(lambda p: 255 if p > 34 else 0)
    full = mask.getbbox()
    if not full:
        return img
    levels = list(mask.resize((1, img.height), Image.BOX).tobytes())  # per-row content
    top, bot = full[1], full[3]
    split, run = None, 0
    for y in range(top, bot):
        if levels[y] <= 2:
            run += 1
            if run >= 60:  # split below the headline; a 60px band clears the ~30px eyebrow/headline gap so the title stays whole
                cy = y
                while cy < bot and levels[cy] <= 2:
                    cy += 1
                split = (y - run + 1, cy)
                break
        else:
            run = 0
    tb = _region_bbox(img, paper, top, split[0]) if split else None
    cb = _region_bbox(img, paper, split[1], bot + 1) if split else None
    ow, oh = opening_size(opening)
    box_w, box_h = ow * (1 - mat), oh * (1 - mat)
    if not (tb and cb):
        return _place(img.crop(full), paper, mat, opening)
    title = _scale_h(img.crop(tb), box_h * TITLE_H_FRAC)
    gap = round(box_h * GAP_FRAC)
    # Size the collage to fill the room left under the fixed-size title,
    # binding on whichever of width or remaining height runs out first, so the
    # title stays a consistent size whether the collage is tall or compact
    # instead of ballooning when the collage happens to be short.
    coll = img.crop(cb)
    cs = min(box_w * COLLAGE_FRAC / coll.width, (box_h - title.height - gap) / coll.height)
    collage = coll.resize((max(1, round(coll.width * cs)), max(1, round(coll.height * cs))), Image.LANCZOS)
    ccx = _centroid_x(collage, paper)  # centre the collage by ink weight, not bbox
    half = max(ccx, collage.width - ccx)
    # A wildly off-centre collage can push the centroid-mirrored width (2*half)
    # past the A5 opening; shrink only the collage, never the fixed-size title,
    # so nothing spills under the physical mat.
    if 2 * half > box_w:
        s = box_w / (2 * half)
        collage = collage.resize((max(1, round(collage.width * s)), max(1, round(collage.height * s))), Image.LANCZOS)
        ccx = round(ccx * s)
        half = max(ccx, collage.width - ccx)
    cw = round(max(title.width, 2 * half))
    comp = Image.new("RGB", (cw, title.height + gap + collage.height), paper)
    comp.paste(title, ((cw - title.width) // 2, 0))
    comp.paste(collage, (round(cw / 2 - ccx), title.height + gap))
    canvas = Image.new("RGB", (PANEL_W, PANEL_H), paper)
    canvas.paste(comp, ((PANEL_W - comp.width) // 2, (PANEL_H - comp.height) // 2))
    return canvas


def quantize_spectra6(img):
    pal = Image.new("P", (1, 1))
    flat = [c for ink in SPECTRA6 for c in ink]
    flat += list(SPECTRA6[0]) * ((768 - len(flat)) // 3)  # pad the 256-entry palette with paper
    pal.putpalette(flat[:768])
    return img.convert("RGB").quantize(palette=pal, dither=Image.Dither.FLOYDSTEINBERG).convert("RGB")


def _draw_mat_box(img, opening):
    """Dev aid: outline the configured mat opening."""
    ow, oh = opening_size(opening)
    x0, y0 = round((PANEL_W - ow) / 2), round((PANEL_H - oh) / 2)
    ImageDraw.Draw(img).rectangle((x0, y0, PANEL_W - x0 - 1, PANEL_H - y0 - 1),
                                  outline=(170, 60, 56), width=2)


# --- hardware ---------------------------------------------------------------
# The Waveshare 13.3" e-Paper HAT+ (E) carries the same EL133UF1 Spectra 6 panel
# as the Inky Impression 13.3", so the Inky driver runs it once the control pins
# are remapped. It has no EEPROM, so inky.auto() can't identify it.
WAVESHARE_PINS = {"cs_pin_0": 8, "cs_pin_1": 7, "dc_pin": 25,
                  "reset_pin": 17, "busy_pin": 24}
WAVESHARE_PWR_PIN = 18


def _power_cycle(pin):
    """Bring the panel's power rail up the way Waveshare's module_init does.

    The HAT+ gates panel power behind a GPIO the Inky driver doesn't know about.
    Waveshare's reference power-ON is a 1,0,1 pulse (30 ms each) ending with the
    rail held HIGH. Returns the LineRequest with the rail held HIGH (on) across
    the refresh; call _power_off() when it's done.
    """
    import time
    import gpiod
    import gpiodevice
    from gpiod.line import Direction, Value
    chip = gpiodevice.find_chip_by_platform()
    offset = chip.line_offset_from_id(pin)
    pwr = chip.request_lines(consumer="birdframe-pwr", config={
        offset: gpiod.LineSettings(
            direction=Direction.OUTPUT, output_value=Value.INACTIVE)})
    pwr.set_value(offset, Value.INACTIVE)  # LOW = panel powered off
    time.sleep(0.03)                       # settle in the off state
    for level in (Value.ACTIVE, Value.INACTIVE, Value.ACTIVE):  # 1,0,1 (30ms each)
        pwr.set_value(offset, level)
        time.sleep(0.03)
    return (pwr, offset)  # rail now HIGH (on)


def _power_off(pwr, offset):
    """Drop the rail to LOW (panel powered off) the way Waveshare's module_exit
    does, then release the line. Runs after the refresh so the panel is truly
    powered down instead of left in a high-voltage state."""
    import time
    from gpiod.line import Value
    pwr.set_value(offset, Value.INACTIVE)
    time.sleep(0.03)
    pwr.release()


# A refresh is trusted only when the BUSY line proves it. The Inky driver's
# _busy_wait returns after a fixed wait when BUSY never signals, so a wedged or
# unpowered controller can "succeed" having changed nothing; wall-clock time is
# useless as a signal. The only reliable evidence is the BUSY pin itself: a real
# refresh toggles it idle -> busy -> idle. If it never changes level, the
# controller ignored the refresh command and the panel still shows the old image.
class PanelRefreshError(RuntimeError):
    """A refresh did not actually reach the panel; the panel still shows the
    previous image. Callers must never swallow this silently."""


def _show_verified(dev, timeout=90.0):
    """Run dev.show() while sampling the BUSY pin; return (elapsed, ok, reason).

    ok is True only if BUSY toggled through the refresh and settled back to idle.
    A wedged/unpowered panel leaves BUSY stuck at one level for the whole call, so
    it is caught here. On timeout the caller's finally drops the power rail (a
    wedged refresh would otherwise hold the HAT's power-enable high, which the
    datasheet warns can damage the diaphragm)."""
    import threading
    from gpiod.line import Value

    samples = []
    stop = threading.Event()

    def level():
        g = getattr(dev, "_gpio", None)
        if g is None:
            return None
        return int(g.get_value(dev.busy_pin) == Value.ACTIVE)  # 1 = high

    def sampler():
        while not stop.is_set():
            v = level()
            if v is not None:
                samples.append((time.monotonic(), v))
            time.sleep(0.2)

    done = threading.Event()
    error = []

    def worker():
        try:
            dev.show()
        except Exception as e:  # noqa: BLE001
            error.append(e)
        finally:
            done.set()

    sampler_t = threading.Thread(target=sampler, daemon=True)
    worker_t = threading.Thread(target=worker, daemon=True)
    t0 = time.monotonic()
    sampler_t.start()
    worker_t.start()
    if not done.wait(timeout):
        error.append(TimeoutError(f"show() did not return within {timeout:.0f}s"))
    elapsed = time.monotonic() - t0
    stop.set()
    sampler_t.join()

    levels = [v for _, v in samples]
    if not levels:
        return elapsed, False, "could not read the BUSY line during the refresh"
    idle = levels[0]
    final = levels[-1]
    # Compact BUSY trace: only the level transitions (t is relative to the first
    # readable sample, i.e. just after the controller finished its reset/init).
    if samples:
        t0 = samples[0][0]
        trans = []
        prev = None
        for t, v in samples:
            if v != prev:
                trans.append(f"{t - t0:+.1f}s={v}")
                prev = v
        print(f"BUSY trace ({len(samples)} samples, {elapsed:.1f}s total): "
              f"{' -> '.join(trans) if trans else 'no transitions'}", file=sys.stderr)
    if error:
        return elapsed, False, f"show() raised: {error[0]}"
    if len(set(levels)) < 2:
        return elapsed, False, (
            f"BUSY never toggled — stuck at level {final} for the whole {elapsed:.1f}s, "
            f"so the panel controller did not run a refresh (unpowered or wedged)")
    if final != idle:
        return elapsed, False, (
            f"BUSY did not settle back to idle (idle={idle}, final={final}); refresh incomplete")
    return elapsed, True, f"BUSY toggled through the refresh and returned to idle"


# --- Waveshare 13.3" e-Paper HAT+ (E) retargeting ----------------------------
# The Inky driver targets the Pimoroni Impression 13.3", which has no power
# management. This HAT differs in ways that break the stock driver, each
# confirmed against Waveshare's own reference driver for the HAT:
#   * BUSY is active-low (LOW=busy, HIGH=idle); the stock _busy_wait waits on
#     BUSY-high, the inverse, so it returns before the ~19 s refresh finishes.
#   * The reset is a double pulse (RST 1,0,1,0,1); the stock driver sends one.
#   * The init values the panel needs (AN_TM, CDI, PSR, BTST_P, BTST_N) are
#     Waveshare's, not the Pimoroni ones the stock driver sends.
#   * The panel must be deep-slept after each refresh, per the HAT's manual.
# These retarget the stock driver in place rather than forking it.
def _waveshare_busy_wait(dev, timeout=40.0):
    """Wait for a refresh the way the Waveshare reference does (BUSY active-low)."""
    from gpiod.line import Value
    time.sleep(0.05)  # grace for the controller to start driving BUSY low
    t_start = time.time()
    while dev._gpio.get_value(dev.busy_pin) == Value.INACTIVE:  # LOW = busy
        time.sleep(0.1)
        if time.time() - t_start > timeout:
            print(f"BUSY stuck low for {timeout:.0f}s — refresh did not complete", file=sys.stderr)
            return
    time.sleep(0.02)


def _waveshare_init(dev):
    """Re-send the init sequence with the values from Waveshare's own reference
    driver for this HAT (EPD_13in3e.c), not the Inky/Pimoroni ones. The command
    bytes are identical, but the panel is tuned differently: AN_TM (refresh
    waveform), CDI, PSR and the boost-test values all differ, and the Pimoroni
    driver sends extra commands (DCDC/PLL/POFS/CMDA4) this HAT's init omits. A
    reset clears the controller, so this is called right after one."""
    import inky.inky_el133uf1 as m
    s = dev._send_command
    s(m.EL133UF1_ANTM, m.CS0_SEL, [0xC0, 0x1C, 0x1C, 0xCC, 0xCC, 0xCC, 0x15, 0x15, 0x55])
    s(m.EL133UF1_CMD66, m.CS_BOTH_SEL, [0x49, 0x55, 0x13, 0x5D, 0x05, 0x10])
    s(m.EL133UF1_PSR, m.CS_BOTH_SEL, [0xDF, 0x69])
    s(m.EL133UF1_CDI, m.CS_BOTH_SEL, [0xF7])
    s(m.EL133UF1_TCON, m.CS_BOTH_SEL, [0x03, 0x03])
    s(m.EL133UF1_AGID, m.CS_BOTH_SEL, [0x10])
    s(m.EL133UF1_PWS, m.CS_BOTH_SEL, [0x22])
    s(m.EL133UF1_CCSET, m.CS_BOTH_SEL, [0x01])
    s(m.EL133UF1_TRES, m.CS_BOTH_SEL, [0x04, 0xB0, 0x03, 0x20])
    s(m.EL133UF1_PWR, m.CS0_SEL, [0x0F, 0x00, 0x28, 0x2C, 0x28, 0x38])
    s(m.EL133UF1_EN_BUF, m.CS0_SEL, [0x07])
    s(m.EL133UF1_BTST_P, m.CS0_SEL, [0xE8, 0x28])
    s(m.EL133UF1_BOOST_VDDP_EN, m.CS0_SEL, [0x01])
    s(m.EL133UF1_BTST_N, m.CS0_SEL, [0xE8, 0x28])
    s(m.EL133UF1_BUCK_BOOST_VDDN, m.CS0_SEL, [0x01])
    s(m.EL133UF1_TFT_VCOM_POWER, m.CS0_SEL, [0x02])


def _waveshare_double_reset(dev):
    """The Waveshare reference reset (RST 1,0,1,0,1, 30 ms each) followed by the
    HAT's own init values. Inky's setup() already did one reset + init with the
    Pimoroni values; re-resetting clears the controller so the Waveshare values
    take effect."""
    from gpiod.line import Value
    for level in (Value.ACTIVE, Value.INACTIVE, Value.ACTIVE, Value.INACTIVE, Value.ACTIVE):
        dev._gpio.set_value(dev.reset_pin, level)
        time.sleep(0.03)
    dev._busy_wait(0.3)
    _waveshare_init(dev)


def _waveshare_sleep(dev):
    """Deep-sleep (0x07, 0xA5) before opening the power switch, so the panel is
    never cut from its high-voltage drive mid-state (which wedges the next refresh)."""
    import inky.inky_el133uf1 as m
    dev._send_command(0x07, m.CS_BOTH_SEL, [0xA5])
    time.sleep(0.1)


def _patch_waveshare(dev):
    """Retarget the stock Inky device to this HAT: fix the BUSY polarity
    (active-low here), apply the Waveshare double reset + its own init values
    after Inky's setup, and deep-sleep the panel after each refresh."""
    dev._busy_wait = lambda timeout=40.0: _waveshare_busy_wait(dev, timeout)
    orig_setup = dev.setup
    def setup_ws():
        orig_setup()
        _waveshare_double_reset(dev)
    dev.setup = setup_ws
    orig_update = dev._update
    def update_ws(buf_a, buf_b):
        orig_update(buf_a, buf_b)
        _waveshare_sleep(dev)
    dev._update = update_ws


def _panel_power_cycle(cache_dir, min_interval=600, enabled=True):
    """Recover a wedged e-ink controller with a power cycle. The only reliable
    fix is to drop panel power, which on this HAT means rebooting the Pi; the
    frame then self-heals on its next timer run instead of sitting frozen on a
    stale image. Reboot at most once per min_interval so a panel that wedges on
    every boot doesn't turn the Pi into a reboot loop — that case needs a human.
    """
    if not enabled:
        print("panel controller wedged; auto_power_cycle disabled, not rebooting", file=sys.stderr)
        return
    if os.environ.get("BIRDFRAME_DRY_RUN_POWER_CYCLE"):
        print("panel controller wedged; DRY RUN (BIRDFRAME_DRY_RUN_POWER_CYCLE) — would reboot", file=sys.stderr)
        return
    import subprocess
    mark = os.path.join(os.path.expanduser(cache_dir), ".last_panel_power_cycle")
    now = time.time()
    try:
        with open(mark) as f:
            if now - float(f.read().strip()) < min_interval:
                print(f"panel power cycle already done <{min_interval}s ago; not rebooting again (needs a human)", file=sys.stderr)
                return
    except Exception:
        pass
    try:
        with open(mark + ".tmp", "w") as f:
            f.write(repr(now))
        os.replace(mark + ".tmp", mark)
    except Exception:
        pass
    print("rebooting in 5s to power-cycle the wedged e-ink controller", file=sys.stderr)
    time.sleep(5)  # let this log line and state flush before the reboot
    try:
        subprocess.Popen(["sudo", "systemctl", "reboot"])
    except Exception as e:
        print(f"could not schedule the power-cycle reboot: {e}", file=sys.stderr)


def push_panel(img, rotate, saturation, panel="", cache_dir="~/.birdframe", auto_power_cycle=True):
    """Rotate to the panel's landscape buffer and push. Lazy import so this
    module still loads on a machine without the Inky library. Returns the seconds
    the refresh ran. Raises PanelRefreshError (after an attempt to power-cycle a
    wedged controller) if the BUSY line shows no refresh actually happened — it
    never returns silently on a no-op."""
    if rotate not in (90, 270):
        print(f"rotate must be 90 or 270, not {rotate}; using 90", file=sys.stderr)
        rotate = 90
    pwr = None
    if panel == "waveshare13in3e":
        from inky.inky_el133uf1 import Inky
        pwr = _power_cycle(WAVESHARE_PWR_PIN)
        dev = Inky(resolution=(1600, 1200), **WAVESHARE_PINS)
        _patch_waveshare(dev)
    elif panel == "el133uf1":
        from inky.inky_el133uf1 import Inky
        dev = Inky(resolution=(1600, 1200))
    else:
        from inky.auto import auto
        dev = auto()
    buf = img.rotate(rotate, expand=True)
    if buf.size != (dev.width, dev.height):
        buf = buf.resize((dev.width, dev.height), Image.LANCZOS)
    kw = {"saturation": saturation} if "saturation" in inspect.signature(dev.set_image).parameters else {}
    dev.set_image(buf, **kw)
    try:
        elapsed, ok, reason = _show_verified(dev)
    finally:
        if pwr:
            _power_off(*pwr)
        # Release the gpiod claim explicitly. _patch_waveshare's closures keep
        # the device alive (a dev -> lambda -> dev cycle), so without this the
        # lines stay claimed and a second push in the same process cannot
        # request them — its BUSY verification would have nothing to read.
        g = getattr(dev, "_gpio", None)
        if g is not None:
            try:
                g.release()
            except Exception:
                pass
    if not ok:
        print("===============================================================", file=sys.stderr)
        print(f"!! PANEL REFRESH FAILED: {reason}", file=sys.stderr)
        print(f"!! the panel is still showing the PREVIOUS image (show ran {elapsed:.1f}s)", file=sys.stderr)
        print("===============================================================", file=sys.stderr)
        _panel_power_cycle(cache_dir, enabled=auto_power_cycle)
        raise PanelRefreshError(reason)
    return elapsed


# --- state ------------------------------------------------------------------
def load_state(path):
    try:
        with open(os.path.expanduser(path)) as f:
            return json.load(f)
    except Exception:
        return {"signature": None, "last_refresh": 0}


def save_state(path, sig, when):
    path = os.path.expanduser(path)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"signature": sig, "last_refresh": when}, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)  # atomic: a power cut can't leave a half-written file


def in_quiet_hours(cfg, hour):
    s, e = cfg["quiet_start"], cfg["quiet_end"]
    if s == e:
        return False
    return s <= hour < e if s < e else hour >= s or hour < e


def frame_url(url, bird_names):
    """Set the frame's label preference without disturbing other URL state."""
    import urllib.parse
    parts = urllib.parse.urlsplit(url)
    query = [(k, v) for k, v in urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
             if k != "labels"]
    query.append(("labels", "1" if bird_names else "0"))
    return urllib.parse.urlunsplit(parts._replace(query=urllib.parse.urlencode(query)))


# --- run --------------------------------------------------------------------
def obtain_image(cfg, species=None):
    if cfg.get("species_source") == "birdweather":
        from shoot import shoot_birdweather
        if species is None:  # gate skipped (--no-signature): fetch the list to render
            species = fetch_species(cfg, _auth(cfg))
        out = os.path.join(os.path.expanduser(cfg["cache"]), "frame.png")
        os.makedirs(os.path.dirname(out), exist_ok=True)
        shoot_birdweather(out, species, title=cfg["shoot_title"], subtitle=cfg["shoot_subtitle"],
                          timeout_ms=cfg["timeout"] * 1000, bird_names=cfg["bird_names"])
        return Image.open(out).convert("RGB")
    if cfg["shoot"]:
        from shoot import shoot
        out = os.path.join(os.path.expanduser(cfg["cache"]), "shot.png")
        os.makedirs(os.path.dirname(out), exist_ok=True)
        shoot(cfg["base_url"], out, title=cfg["shoot_title"], subtitle=cfg["shoot_subtitle"],
              headline_px=cfg["shoot_headline_px"], eyebrow_px=cfg["shoot_eyebrow_px"],
              lowercase=cfg["shoot_lowercase"], mat=cfg["shoot_mat"],
              small_floor=cfg["shoot_small_floor"], count_exp=cfg["shoot_count_exp"], timeout_ms=cfg["timeout"] * 1000,
              user=cfg["basic_user"], password=cfg["basic_pass"], window_hours=cfg["hours"],
              bird_names=cfg["bird_names"], daily=cfg.get("daily_reset", False))
        return Image.open(out).convert("RGB")
    src = cfg["image_url"] or cfg["image"]
    if not src:
        raise ValueError("set image, image_url, or shoot in config")
    # A pre-rendered frame is still someone's render, so ask it for names the
    # same way this Pi asks its own browser. A source that does not know the
    # parameter ignores it and sends what it always sent, so this is safe
    # against anything. URLs only: a local file path has no query string.
    if cfg["image_url"]:
        src = frame_url(src, cfg["bird_names"])
    return get_image(src, cfg["timeout"], _auth(cfg))


def run(cfg, preview=None, force=False, use_signature=True, mat_box=False):
    now = time.time()
    state = load_state(cfg["state"])
    sig = None
    species = None
    if use_signature:
        try:
            species = fetch_species(cfg, _auth(cfg))
            scope = birdweather_signature_scope(cfg) if cfg.get("species_source") == "birdweather" else ""
            sig = signature(species, scope)
        except Exception as e:
            print(f"signature fetch failed: {e}", file=sys.stderr)  # treat as no change
    heal_due = now - state.get("last_refresh", 0) >= cfg["heal_hours"] * 3600
    changed = (not use_signature) or (sig is not None and sig != state.get("signature"))
    if not force and not preview:
        if in_quiet_hours(cfg, datetime.now().hour):
            print("quiet hours; skip")
            return
        if not changed and not heal_due:
            print("no change; skip")
            return
        print("refresh:", "changed" if changed else "heal")

    try:
        img = fit_panel(obtain_image(cfg, species))
    except Exception as e:
        print(f"could not get image: {e}", file=sys.stderr)  # keep last panel image
        return
    img = mat_and_center(img, cfg["mat"], cfg["opening"])
    if preview:
        out = quantize_spectra6(img)
        if mat_box:
            _draw_mat_box(out, cfg["opening"])
        out.save(preview)
        print(f"wrote preview {preview}")
        return
    try:
        push_panel(img, cfg["rotate"], cfg["saturation"], cfg.get("panel", ""),
                   cache_dir=cfg["cache"], auto_power_cycle=cfg.get("auto_power_cycle", True))
    except PanelRefreshError as e:
        # A refresh that does not reach the panel must be impossible to miss.
        print("===============================================================")
        print(f"PANEL REFRESH FAILED: {e}")
        print("The panel is still showing the PREVIOUS image. The refresh was")
        print("attempted and verified to have failed (this is not a silent no-op).")
        print("If this recurs, the e-ink controller is wedged or unpowered.")
        print("===============================================================")
        return
    except Exception as e:
        print(f"panel push failed: {e}", file=sys.stderr)
        return
    save_state(cfg["state"], sig if sig is not None else state.get("signature"), now)
    print("panel updated")


def load_config(path):
    cfg = dict(DEFAULTS)
    if path:
        with open(os.path.expanduser(path), "rb") as f:
            cfg.update(tomllib.load(f))
    return cfg


def main():
    ap = argparse.ArgumentParser(description="Push the collage screenshot to the Inky panel.")
    ap.add_argument("--config")
    ap.add_argument("--base-url")
    ap.add_argument("--image")
    ap.add_argument("--image-url")
    ap.add_argument("--preview", help="write a 6-ink preview PNG instead of pushing")
    ap.add_argument("--rotate", type=int)
    ap.add_argument("--force", action="store_true", help="refresh even if unchanged")
    ap.add_argument("--no-signature", action="store_true", help="skip change detection")
    ap.add_argument("--mat-box", action="store_true", help="dev: outline the mat window on the preview")
    args = ap.parse_args()

    cfg = load_config(args.config)
    for key in ("base_url", "image", "image_url"):
        val = getattr(args, key)
        if val:
            cfg[key] = val
    if args.rotate is not None:
        cfg["rotate"] = args.rotate
    # One render at a time. A manual --force colliding with the timer's run
    # pushes two refreshes into the panel mid-cycle; on the 13.3" (two
    # half-panel controllers) that shows a split image and can wedge one
    # controller until a full power cycle. The lock lives in the cache dir
    # and is dropped automatically on exit.
    lock_path = os.path.join(os.path.expanduser(cfg["cache"]), ".render.lock")
    os.makedirs(os.path.dirname(lock_path), exist_ok=True)
    lock = open(lock_path, "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print("another render is in progress; skipping")
        return
    run(cfg, preview=args.preview, force=args.force, use_signature=not args.no_signature, mat_box=args.mat_box)


if __name__ == "__main__":
    main()
