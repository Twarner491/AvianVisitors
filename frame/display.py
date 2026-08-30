#!/usr/bin/env python3
"""Frame-Pi client: turn a collage screenshot into Inky panel pixels.

Runs on the frame Pi (a 3 A+ or Zero 2 W) on a systemd timer. Each run it decides
whether a refresh is worth it, then crops the title and collage from the
screenshot, centres and mats them, and pushes the result to the Inky Impression
13.3". ``--preview out.png`` writes an approximate 6-ink dither instead, so the
look can be checked on any machine without the panel.

How "worth it" is decided depends on where the image comes from. When this Pi
renders (local or birdweather mode) it hashes the species set and call-count
brackets. When the mic Pi publishes a PNG for us (image_url mode) the published
bytes are the signal instead: a conditional GET, and a 304 means nothing to do.
Re-deriving the answer from the API there would be a second gate on a second
clock, which can fire on a bird the downloaded image predates. Either way a
refresh is suppressed during quiet hours.
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
import urllib.error   # explicit: urllib.request happens to pull it in, but the 304 path relies on it
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
    "species_source": "",   # "" = the recent API at base_url; "birdweather" = BirdWeather near a ZIP
    "zip": "",              # BirdWeather ZIP / postal code (with species_source = "birdweather")
    "bw_days": 7,           # BirdWeather lookback window, in days
    "bw_country": "us",     # geocoder country for the ZIP
    "hours": 24,
    "image": "",            # local PNG written by the shooter
    "image_url": "",        # or a published screenshot URL
    "shoot": False,         # or capture inline (needs a browser; the 3 A+ and Zero 2 W both handle it)
    "shoot_title": None, "shoot_subtitle": None,
    "shoot_headline_px": 42, "shoot_eyebrow_px": 18, "shoot_lowercase": False,
    "shoot_mat": 0.04, "shoot_small_floor": 0.04, "shoot_count_exp": 0.65,
    "bird_names": "",       # "" = follow the station's COLLAGE_LABELS; true/false override
    "mat": 0.0,             # extra global shrink of the content inside the A5 opening
    "opening": 0.7071,      # opening height as a panel fraction; 0.7071 preserves A5
    "rotate": 90,           # 90 or 270 if the frame hangs the other way up
    "saturation": 0.6,
    "panel": "",            # "el133uf1" forces the 13.3" driver if auto() fails
    "quiet_start": 0, "quiet_end": 0,    # 0/0 = no quiet hours
    "heal_hours": 24,
    "state": "~/.birdframe/state.json",
    "cache": "~/.birdframe",
    "timeout": 180,      # seconds; a Zero 2 W needs ~70-120s to shoot the collage
    "basic_user": None, "basic_pass": None,
}


def labels_pref(cfg):
    """The frame's label override, or None to follow the station.

    TOML has no "unset" a user can type, so "" (what install.sh and
    birdframe-names auto write), "auto" and "site" all mean follow; booleans
    and on/off/true/false are explicit overrides."""
    v = cfg.get("bird_names")
    if isinstance(v, bool):
        return v
    if isinstance(v, int):      # bird_names = 0 / 1 in TOML; bool is checked first
        return bool(v)
    s = str(v or "").strip().lower()
    if s in ("", "auto", "site", "follow"):
        return None
    return s in ("1", "true", "on", "yes")


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


def fetch_recent_payload(base, hours, timeout, auth=None):
    """The whole recent payload: species for the signature, plus the station's
    `labels` default, which the gate has to watch separately - a label flip
    changes the picture without changing a single bird."""
    url = f"{base.rstrip('/')}/avian/api/birdnet-api.php?action=recent&hours={hours}"
    req = urllib.request.Request(url, headers={"User-Agent": "AvianVisitors-frame/1.0"})
    if auth:
        req.add_header("Authorization", auth)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read(2_000_000))


def fetch_recent(base, hours, timeout, auth=None):
    return fetch_recent_payload(base, hours, timeout, auth).get("species", [])


def signature(species):
    items = sorted((slugify(s["sci"]), _bucket(int(s.get("n") or 1))) for s in species)
    return hashlib.sha256(json.dumps(items).encode()).hexdigest()[:16]


def fetch_species(cfg, auth=None):
    """The species list the signature is built from: the BirdNET-Pi recent API
    by default, or BirdWeather's recent detections near a ZIP when
    species_source = "birdweather"."""
    if cfg.get("species_source") == "birdweather":
        import birdweather
        return birdweather.species_for_zip(cfg["zip"], country=cfg["bw_country"], days=cfg["bw_days"])
    return fetch_recent(cfg["base_url"], cfg["hours"], cfg["timeout"], auth)


# --- image ------------------------------------------------------------------
NOT_MODIFIED = object()   # sentinel: the server says the bytes have not changed


def _http_image(url, timeout, auth=None, validators=None):
    """Download the frame, optionally conditionally.

    `validators` is the {"etag", "last_modified"} recorded from the previous
    fetch; when given, this sends a conditional request and returns
    NOT_MODIFIED instead of a body if the server answers 304. Returns
    (Image | NOT_MODIFIED, validators from this response).
    """
    req = urllib.request.Request(url, headers={"User-Agent": "AvianVisitors-frame/1.0"})
    if auth:
        req.add_header("Authorization", auth)
    if validators:
        if validators.get("etag"):
            req.add_header("If-None-Match", validators["etag"])
        if validators.get("last_modified"):
            req.add_header("If-Modified-Since", validators["last_modified"])
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read(20_000_000)
            ctype = (r.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            # Only real values: a dict of two Nones is still truthy, so keeping
            # them would make the next run take the conditional branch, send no
            # conditional headers, and get a 200 every time - a gate that has
            # silently turned itself off while logging "refresh: changed"
            # forever. Empty means "cannot gate", and says so below.
            got = {k: v for k, v in (("etag", r.headers.get("ETag")),
                                     ("last_modified", r.headers.get("Last-Modified"))) if v}
    except urllib.error.HTTPError as e:
        if e.code == 304:
            return NOT_MODIFIED, validators
        raise
    # A missing frame.png does NOT 404 on a BirdNET-Pi: Caddy's try_files falls
    # through to index.php, so an unpublished frame - or a dangling symlink -
    # comes back as 200 with the HTML shell. Match on markup rather than on
    # "not image/*", because some object stores and workers serve a perfectly
    # good PNG as application/octet-stream.
    if ctype.startswith("text/") or ctype.endswith(("html", "xml", "json")):
        raise RuntimeError(
            f"{url} returned {ctype}, not an image - is the publisher running?")
    if not got:
        print(f"{url} sends no ETag or Last-Modified; refreshing every run",
              file=sys.stderr)
    return Image.open(io.BytesIO(body)).convert("RGB"), got


def get_image(src, timeout, auth=None):
    if re.match(r"^https?://", src):
        img, _ = _http_image(src, timeout, auth)
        return img
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
def push_panel(img, rotate, saturation, panel=""):
    """Rotate to the panel's landscape buffer and push. Lazy import so this
    module still loads on a machine without the Inky library."""
    if rotate not in (90, 270):
        print(f"rotate must be 90 or 270, not {rotate}; using 90", file=sys.stderr)
        rotate = 90
    if panel == "el133uf1":
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
    dev.show()


# --- state ------------------------------------------------------------------
def load_state(path):
    try:
        with open(os.path.expanduser(path)) as f:
            return json.load(f)
    except Exception:
        return {"signature": None, "last_refresh": 0}


def save_state(path, sig, when, validators=None, url=None, labels=None):
    """`validators` is image mode's {etag, last_modified} and `url` is the
    address they describe; keeping both is what lets the next run send a
    conditional request and know when it must not. Optional so publish.py and
    the other three modes can keep calling this with three arguments."""
    path = os.path.expanduser(path)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"signature": sig, "last_refresh": when,
                   "validators": validators, "url": url, "labels": labels}, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)  # atomic: a power cut can't leave a half-written file


def in_quiet_hours(cfg, hour):
    s, e = cfg["quiet_start"], cfg["quiet_end"]
    if s == e:
        return False
    return s <= hour < e if s < e else hour >= s or hour < e


def frame_url(url, bird_names):
    """Set the frame's label preference without disturbing other URL state.
    None means follow the station: leave the URL alone."""
    import urllib.parse
    if bird_names is None:
        return url
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
                          timeout_ms=cfg["timeout"] * 1000, bird_names=labels_pref(cfg))
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
              bird_names=labels_pref(cfg))
        return Image.open(out).convert("RGB")
    src = cfg["image_url"] or cfg["image"]
    if not src:
        raise ValueError("set image, image_url, or shoot in config")
    # A pre-rendered frame is still someone's render, so ask it for names the
    # same way this Pi asks its own browser. A source that does not know the
    # parameter ignores it and sends what it always sent, so this is safe
    # against anything. URLs only: a local file path has no query string.
    if cfg["image_url"]:
        src = frame_url(src, labels_pref(cfg))
    return get_image(src, cfg["timeout"], _auth(cfg))


def run(cfg, preview=None, force=False, use_signature=True, mat_box=False):
    now = time.time()
    state = load_state(cfg["state"])
    sig = None
    species = None
    fetched = None                        # image mode downloads during its gate
    resolved_url = state.get("url")       # the URL those validators describe
    resolved_labels = state.get("labels")  # what the last render drew names as
    validators = state.get("validators")
    heal_due = now - state.get("last_refresh", 0) >= cfg["heal_hours"] * 3600

    # In image mode the published PNG *is* the signal. The mic Pi's publisher
    # only re-renders when the birds change, so unchanged bytes mean there is
    # nothing new to draw. Asking the API here instead would be a second gate on
    # a second clock: it can flip on a bird the downloaded image predates, which
    # strands a stale collage on the panel until the next species change or the
    # daily heal, with both machines logging success. It also drops this mode's
    # dependence on base_url being reachable at all.
    gate_on_image = (use_signature and bool(cfg["image_url"]) and not cfg["shoot"]
                     and cfg.get("species_source") != "birdweather")

    if not force and not preview and in_quiet_hours(cfg, datetime.now().hour):
        print("quiet hours; skip")
        return

    if gate_on_image:
        # Ask the source for names the same way obtain_image does. The gate path
        # bypasses obtain_image entirely, so without this the label preference
        # would silently never reach an image_url source.
        src = frame_url(cfg["image_url"], labels_pref(cfg))
        # A validator only means anything for the URL it came from. Toggling
        # labels changes the URL but not the file caddy serves, so the ETag is
        # unchanged and a stale validator would take a 304 for an image rendered
        # under the other setting. State written before this key existed has no
        # url, which has to mean "drop them once", not "assume they match".
        if state.get("url") != src:
            validators = None
        # Send the validators only when a 304 would actually let us stop. On a
        # heal we want the bytes back even though nothing changed, so the panel
        # redraws and clears its ghosting.
        conditional = None if (force or preview or heal_due) else validators
        try:
            fetched, got = _http_image(src, cfg["timeout"], _auth(cfg), conditional)
        except Exception as e:
            print(f"could not get image: {e}", file=sys.stderr)  # keep last panel image
            return
        if fetched is NOT_MODIFIED:
            print("no change; skip")
            return
        # `got`, not `got or validators`: we just downloaded new bytes, so the
        # old validators describe an image that is no longer the one on the
        # panel. Keeping them would send a stale If-None-Match and could take a
        # 304 for the wrong image.
        validators = got or None
        resolved_url = src
        if not force and not preview:
            print("refresh:", "heal" if heal_due else "changed")
    else:
        site_labels = None
        if use_signature:
            try:
                if cfg.get("species_source") == "birdweather":
                    species = fetch_species(cfg, _auth(cfg))
                else:
                    payload = fetch_recent_payload(cfg["base_url"], cfg["hours"], cfg["timeout"], _auth(cfg))
                    species = payload.get("species", [])
                    site_labels = payload.get("labels")
                sig = signature(species)
            except Exception as e:
                print(f"signature fetch failed: {e}", file=sys.stderr)  # treat as no change
        changed = (not use_signature) or (sig is not None and sig != state.get("signature"))
        # Labels are tracked beside the signature, not inside it: the hash must
        # stay identical on every machine, and a flip of the station's default
        # changes the picture without moving a single bird. Resolve like the
        # page: explicit override, else the station, else on.
        if sig is not None:
            override = labels_pref(cfg)
            resolved_labels = override if override is not None else (
                site_labels if isinstance(site_labels, bool) else True)
            # A state file with no labels key predates this gate; treat it as a
            # flip so the first tick after an upgrade draws whatever the station
            # says now, rather than waiting for a bird or the daily heal.
            if resolved_labels != state.get("labels"):
                changed = True
        if not force and not preview:
            if not changed and not heal_due:
                print("no change; skip")
                return
            print("refresh:", "changed" if changed else "heal")

    try:
        img = fit_panel(fetched if fetched is not None else obtain_image(cfg, species))
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
        push_panel(img, cfg["rotate"], cfg["saturation"], cfg.get("panel", ""))
    except Exception as e:
        print(f"panel push failed: {e}", file=sys.stderr)
        return
    save_state(cfg["state"], sig if sig is not None else state.get("signature"), now,
               validators, resolved_url, resolved_labels)
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
