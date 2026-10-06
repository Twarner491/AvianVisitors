#!/usr/bin/env python3
"""Screenshot the live AvianVisitors collage for the e-ink frame.

Loads the real site (the LAN default http://birdnet.local, or a forwarded
public URL) at a portrait viewport, hides the controls, sets the frame
titles, and rewrites a few of the page's own apt.js tunables at capture time
(cluster bias, count-to-size exponent, a rare-bird floor). The result is the
actual website, framed for the wall, with no changes to AvianVisitors.

Needs a real headless browser, so it runs on any 64-bit capable machine,
including the frame's own Pi (3 A+ / Zero 2 W) but NOT an original ARMv6
Pi Zero W. Writes a 1200x1600 PNG; display.py turns it into panel pixels.

  pip install -r requirements-shoot.txt && playwright install chromium
  python3 shoot.py --url https://bird.onethreenine.net \
      --title "onethreenine birds" --subtitle "heard today" --out frame.png
"""
from __future__ import annotations

import argparse
import base64
import contextlib
import http.server
import importlib.util
import io
import json
import math
import os
import re
import socketserver
import stat
import sys
import tempfile
import threading
import time
import urllib.parse
from fractions import Fraction

from playwright.sync_api import TimeoutError as PWTimeout
from playwright.sync_api import sync_playwright
from PIL import Image

# Load beside this script, including callers that import shoot.py by file path.
_art_spec = importlib.util.spec_from_file_location("frame_capture_art", os.path.join(os.path.dirname(__file__), "capture_art.py"))
capture_art = importlib.util.module_from_spec(_art_spec)
_art_spec.loader.exec_module(capture_art)

# --bird-weather resolves cutouts from the local clone first, then falls back to
# the repo's raw GitHub URLs: a fresh install needs no illustration redeploy,
# upstream additions arrive with a git pull, and cutouts you generate and copy
# into the clone render even before they reach GitHub.
RAW_ILLUSTRATIONS = ("https://raw.githubusercontent.com/Twarner491/AvianVisitors/"
                     "avian-visitors/avian/assets/illustrations/")

# Hide the controls and the other views, freeze animations. Titles + collage
# stay. Injected before first paint.
HIDE_CSS = """
  .top, .slider, .return-to-atlas, .menu-shell, #menu-dd, #detail-modal, #about-modal,
  .admin-screen, #collageTip, .modal-backdrop, #v1, #v2 { display: none !important; }
  .views { transform: none !important; }
  *, *::before, *::after { animation: none !important; transition: none !important; }
  html, body { background: var(--paper, #efece0) !important; }
  #collage img { visibility: hidden !important; }
"""

FRAME_READY = """() => {
  const c = document.getElementById('collage');
  if (!c || !c.dataset.frameToken || document.body.classList.contains('educator-data-loading')) return false;
  const count = Number(c.dataset.frameCount);
  const tiles = [...c.querySelectorAll('.gtile')];
  const images = [...c.querySelectorAll(count ? '.gtile img' : '.nest-img')];
  if (tiles.length !== count || images.length !== (count || 1)
    || !images.every(i => i.complete && i.naturalWidth > 0)) return false;
  return {token: c.dataset.frameToken, revision: c.dataset.frameRevision};
}"""

FRAME_UNCHANGED = """expected => {
  const current = (""" + FRAME_READY + """)();
  return current && current.token === expected.token && current.revision === expected.revision;
}"""

CAPTURE_LAYOUT = """() => {
  const rect = e => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
  const c = document.getElementById('collage');
  if (!window.__frameImageIds) { window.__frameImageIds = new WeakMap(); window.__frameImageSeq = 0; }
  const images = [...c.querySelectorAll('img')].map(i => {
    if (!window.__frameImageIds.has(i)) window.__frameImageIds.set(i, ++window.__frameImageSeq);
    const s = getComputedStyle(i);
    return {id: window.__frameImageIds.get(i), src: i.currentSrc || i.src,
      box: rect(i), natural: [i.naturalWidth, i.naturalHeight],
      fit: s.objectFit, position: s.objectPosition, filter: s.filter};
  });
  const labels = [...document.querySelectorAll('.static-head, .gtile-label, .empty-nest .empty')].map(e => {
    const s = getComputedStyle(e);
    return {box: rect(e), html: e.innerHTML, font: s.font, color: s.color,
      opacity: s.opacity, display: s.display, visibility: s.visibility};
  });
  return {images, labels, token: c.dataset.frameToken, revision: c.dataset.frameRevision};
}"""

# Deferred font/table retries run after 60/80 ms. Observe stability past both.
FRAME_STABLE = """() => {
  const ready = (""" + FRAME_READY + """)();
  const state = ready && JSON.stringify((""" + CAPTURE_LAYOUT + """)());
  const previous = window.__frameStable;
  if (!state || !previous || previous.state !== state) {
    window.__frameStable = {state, since: performance.now()};
    return false;
  }
  return performance.now() - previous.since >= 100 && ready;
}"""


def _output_size(vw, vh, dsf):
    if not all(math.isfinite(n) and n > 0 for n in (vw, vh, dsf)):
        raise RuntimeError("invalid capture dimensions")
    size = (round(vw * dsf), round(vh * dsf))
    if min(size) < 1 or size[0] * size[1] > capture_art.MAX_OUTPUT_PIXELS:
        raise RuntimeError("capture output pixel limit exceeded")
    return size


class _CaptureChanged(RuntimeError):
    pass


def capture_text_overlay(page, vw: int, vh: int, dsf: float, *, remaining_ms=None, check_snapshot=None) -> Image.Image:
    """Keep browser typography, but bound each transparent screenshot's surface."""
    size = _output_size(vw, vh, dsf)
    rows = capture_art.MAX_STRIP_PIXELS // size[0]
    # Integer CSS and device-pixel boundaries avoid Chromium flooring a final
    # fractional clip one row short (for example at device scale 1.5).
    unit = Fraction(str(dsf)).numerator
    rows -= rows % unit
    if rows < 1:
        raise RuntimeError("capture strip is too wide")
    layout = page.evaluate(CAPTURE_LAYOUT)
    page.add_style_tag(content="html,body{background:transparent!important} #collage img{visibility:hidden!important}")
    # A screenshot clip alone can still leave a full-size compositor surface.
    # Bound the visible surface without changing the page's layout dimensions.
    # Keep this session attached until browser closure: detaching resets metrics.
    surface = page.context.new_cdp_session(page)
    overlay = Image.new("RGBA", size)
    try:
        for top in range(0, size[1], rows):
            height = min(rows, size[1] - top)
            clip = {"x": 0, "y": top / dsf, "width": vw, "height": height / dsf}
            surface.send("Emulation.setDeviceMetricsOverride", {
                "width": vw, "height": vh, "deviceScaleFactor": dsf, "mobile": False,
                "viewport": {**clip, "scale": 1},
            })
            options = {"timeout": remaining_ms()} if remaining_ms is not None else {}
            png = page.screenshot(type="png", omit_background=True, clip=clip, **options)
            unchanged = page.evaluate(FRAME_UNCHANGED, layout)
            current_layout = page.evaluate(CAPTURE_LAYOUT)
            if check_snapshot is not None:
                check_snapshot()
            if any(current_layout[key] != layout[key] for key in ("token", "revision")):
                raise _CaptureChanged("collage changed during capture")
            if not unchanged or current_layout != layout:
                raise RuntimeError("collage changed during capture")
            with Image.open(io.BytesIO(png)) as strip:
                if strip.size != (size[0], height) or strip.mode != "RGBA":
                    raise RuntimeError("unexpected capture strip dimensions or transparency")
                overlay.paste(strip, (0, top))
        return overlay
    except Exception:
        overlay.close()
        raise


def _composition_images(layout, responses, dsf):
    if not layout["images"] or len(layout["images"]) > capture_art.MAX_IMAGES:
        raise RuntimeError("capture image count exceeds limits")
    images, retained = [], 0
    for item in layout["images"]:
        response = responses.get(item["src"])
        if response is None or not response.ok:
            raise RuntimeError("capture artwork response is missing or unsuccessful")
        length = response.header_value("content-length")
        if length is not None and (not length.isdigit() or int(length) > capture_art.MAX_ASSET_BYTES):
            raise RuntimeError("capture artwork byte limit exceeded")
        try:
            body = response.body()
        except Exception as error:
            raise RuntimeError("capture artwork response is incomplete") from error
        retained += len(body)
        if len(body) > capture_art.MAX_ASSET_BYTES or retained > capture_art.MAX_RETAINED_BYTES:
            raise RuntimeError("capture artwork byte limit exceeded")
        position = re.fullmatch(r"([\d.]+)% ([\d.]+)%", item["position"])
        if not position:
            raise RuntimeError("unsupported capture object-position")
        shadow = None
        if item["filter"] != "none":
            match = re.fullmatch(r"drop-shadow\(rgba?\(([^)]+)\) (-?[\d.]+)px (-?[\d.]+)px ([\d.]+)px\)", item["filter"])
            if not match:
                raise RuntimeError("unsupported capture artwork filter")
            color = [float(n.strip()) for n in match[1].split(",")]
            shadow = {"color": [round(n) for n in color[:3]] + [round(color[3] * 255) if len(color) == 4 else 255],
                      "offset": [float(match[2]) * dsf, float(match[3]) * dsf], "blur": float(match[4]) * dsf}
        images.append({"body": body, "rect": [n * dsf for n in item["box"]],
                       "natural": item["natural"], "fit": item["fit"],
                       "position": [float(position[1]) / 100, float(position[2]) / 100], "shadow": shadow})
    return images


def _frame_css(headline_px, eyebrow_px, lowercase, pad_top, pad_side, pad_bottom, collage_vh):
    css = (
        f".stage {{ padding: {pad_top}px {pad_side}px {pad_bottom}px !important;"
        f" box-sizing: border-box !important; justify-content: center !important; }}"
        f".views {{ flex: 0 0 auto !important; height: {collage_vh}vh !important; }}"
        f".view#v0 {{ height: 100% !important; flex: 1 1 100% !important; padding: 6px 0 !important; }}"
        f".gcollage {{ max-width: none !important; }}"
        f".static-head {{ padding: 0 8px 14px !important; }}"
        f".static-head .pre {{ font-size: {eyebrow_px}px !important; }}"
        f".static-head h1 {{ font-size: {headline_px}px !important; }}"
        ".gtile-label text { fill: #000 !important; filter: none !important;"
        " font-weight: 400 !important; }"
        ".empty-nest .empty { font-size: 18px !important; font-weight: 650 !important;"
        " letter-spacing: 0.12em !important; color: #242424 !important; }"
    )
    if lowercase:
        css += ".static-head h1 { text-transform: none !important; }"
    return css


def _safe_continue(route):
    try:
        route.continue_()
    except Exception:
        pass


def _frame_url(url, bird_names):
    """Set the frame's label preference without disturbing other URL state."""
    parts = urllib.parse.urlsplit(url)
    query = [(key, value) for key, value in urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
             if key != "labels"]
    query.append(("labels", "1" if bird_names else "0"))
    return urllib.parse.urlunsplit(parts._replace(query=urllib.parse.urlencode(query)))


def _make_api_handler(floor_frac, window_hours, auth, species=None, capture=None):
    """Re-window action=recent (to preview busy days) and floor the rarest
    counts so the packer draws them a little larger. With `species` set
    (--bird-weather), serve that list for recent and an empty body for the
    other views, which have no backend in that mode."""
    def handler(route):
        req = route.request
        if "action=recent" not in req.url:
            if species is not None:
                return route.fulfill(status=200, content_type="application/json", body="{}")
            return route.continue_()
        try:
            if species is not None:
                data = {"hours": int(window_hours or 24), "species": species, "as_of": ""}
            else:
                url = re.sub(r"hours=\d+", f"hours={int(window_hours)}", req.url) if window_hours else req.url
                kw = {"url": url}
                if auth:
                    kw["headers"] = {**req.headers, "authorization": auth}
                response = route.fetch(**kw)
                if not response.ok:
                    raise RuntimeError(f"recent API returned HTTP {response.status}")
                data = response.json()
            if not isinstance(data, dict) or not isinstance(data.get("species"), list):
                raise ValueError("recent API has no species list")
            if any(not isinstance(s, dict) or not isinstance(s.get("sci"), str)
                   or not s["sci"].strip() for s in data["species"]):
                raise ValueError("recent API has an invalid species")
            data = {**data, "species": [dict(s) for s in data["species"]]}
            if capture is not None:
                capture["token"] = capture.get("token", 0) + 1
                capture["species"] = [dict(s) for s in data["species"]]
                data["frame_capture_id"] = capture["token"]
            sp = data["species"]
            if sp and floor_frac > 0:
                floor = max((s.get("n") or 1) for s in sp) * floor_frac
                for s in sp:
                    if (s.get("n") or 1) < floor:
                        s["n"] = max(1, round(floor))
            route.fulfill(status=200, content_type="application/json", body=json.dumps(data))
        except Exception as e:
            if capture is not None:
                capture["error"] = str(e)
            print(f"recent API failed: {e}", file=sys.stderr)
            route.fulfill(status=502, content_type="application/json",
                          body='{"error":"frame recent API failed"}')
    return handler


def _serve_frontend(directory):
    """Serve the static collage frontend on a free localhost port (daemon thread)."""
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass

    def make(*args, **kwargs):
        return Quiet(*args, directory=directory, **kwargs)

    httpd = socketserver.TCPServer(("127.0.0.1", 0), make)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


def _make_cutout_handler(base=None, local_dir=None, resolver=None, errors=None, bundle_assets=None):
    """Resolve each cutout.php lookup to the bird's illustration. Serve a local
    file first when `local_dir` has it - that is how cutouts you generate and copy
    into the clone render before they reach GitHub - otherwise 302 to the raw
    GitHub copy. Trusts species_for_zip to pre-filter to drawable slugs, so the
    GitHub fallback only lands on a missing file if the repo is mid-update."""
    expected_identity = None
    if resolver is not None and bundle_assets is not None:
        active = bundle_assets()["active"]
        expected_identity = {"bundle": active["revision"], "content": active["content_revision"]}

    def handler(route):
        try:
            params = urllib.parse.parse_qs(urllib.parse.urlparse(route.request.url).query, keep_blank_values=True)
            slug = re.sub(r"[^a-z0-9]+", "-", (params.get("sci") or [""])[0].lower()).strip("-")
            pose = "flight" if (params.get("pose") or ["1"])[0] == "2" else "perched"
            if pose == "flight":
                slug += "-2"
            if resolver is not None:
                if expected_identity is not None:
                    if any(key in params and params[key] != [revision] for key, revision in expected_identity.items()):
                        raise RuntimeError("cutout does not match the active bundle selection")
                resolved = resolver((params.get("sci") or [""])[0], pose)
                if resolved is not None:
                    return route.fulfill(path=str(resolved))
                return route.fulfill(
                    status=404,
                    content_type="text/plain",
                    body="not in active bundle",
                )
            if local_dir:
                local = os.path.join(local_dir, slug + ".png")
                if os.path.isfile(local):
                    return route.fulfill(path=local)
            if base:
                return route.fulfill(
                    status=302, headers={"location": base + slug + ".png"}
                )
            return route.fulfill(
                status=404, content_type="text/plain", body="cutout unavailable"
            )
        except Exception as error:
            if errors is None:
                _safe_continue(route)
                return
            errors.append(str(error))
            try:
                route.fulfill(
                    status=500,
                    content_type="text/plain",
                    body="bundle validation failed",
                )
            except Exception:
                pass
    return handler


def _make_bundle_assets_handler(provider, errors=None):
    """Serve metadata from the same verified revision as the frame cutouts."""
    def handler(route):
        try:
            payload = provider()
            route.fulfill(
                status=200,
                content_type="application/json; charset=utf-8",
                body=json.dumps(payload, sort_keys=True, separators=(",", ":")),
            )
        except Exception as error:
            if errors is not None:
                errors.append(str(error))
            try:
                route.fulfill(
                    status=500,
                    content_type="application/json; charset=utf-8",
                    body='{"ok":false,"error":"bundle validation failed"}',
                )
            except Exception:
                pass
    return handler


def _make_js_handler(xbias, ybias, count_exp, pad, label_min_px, auth, misses):
    """Rewrite the collage tunables inside the page's apt.js at capture time."""
    def handler(route):
        try:
            kw = {"headers": {**route.request.headers, "authorization": auth}} if auth else {}
            js = route.fetch(**kw).text()
            for pat, repl in ((r"var xBias = narrow \? 1 : T\.ellipseAspectBias;", f"var xBias = {xbias};"),
                              (r"var yBias = narrow \? 1\.7 : 1;", f"var yBias = {ybias};"),
                              (r"countExp:\s*[\d.]+,", f"countExp: {count_exp},"),
                              (r"var pad = narrow \? Math\.max\(1, COLLAGE_PAD - 1\) : COLLAGE_PAD;", f"var pad = {pad};"),
                              (r"var LABEL_MIN_PX = \d+;", f"var LABEL_MIN_PX = {int(label_min_px)};")):
                js, n = re.subn(pat, repl, js)
                if not n:
                    misses.append(pat)
            route.fulfill(status=200, content_type="application/javascript; charset=utf-8", body=js)
        except Exception as e:
            print(f"apt.js rewrite skipped: {e}", file=sys.stderr)
            _safe_continue(route)
    return handler


def shoot(url, out, *, title=None, subtitle=None, vw=600, vh=800, dsf=2,
          headline_px=42, eyebrow_px=18, lowercase=False,
          mat=0.04, collage_vh=52, cluster_xbias=1.0, cluster_ybias=1.2,
          count_exp=0.4, cluster_pad=1, label_min_px=11, small_floor=0.04, window_hours=None,
          timeout_ms=45000, user=None, password=None, species=None, cutout_base=None,
          cutout_local=None, cutout_resolver=None, dims_path=None, masks_path=None,
          bundle_assets=None, empty_text="listening for birds…", bird_names=False, capture=None):
    size = _output_size(vw, vh, dsf)
    pad_side, pad_top, pad_bottom = int(vw * mat), int(vh * mat * 0.92), int(vh * mat)
    auth = "Basic " + base64.b64encode(f"{user}:{password or ''}".encode()).decode() if user else None

    with contextlib.ExitStack() as buffers:
        with sync_playwright() as p:
            browser = p.chromium.launch(args=["--force-color-profile=srgb", "--disable-dev-shm-usage"])
            try:
                ctx_kw = {
                    "viewport": {"width": vw, "height": vh},
                    "device_scale_factor": dsf,
                    "color_scheme": "light",
                }
                if user:
                    ctx_kw["http_credentials"] = {"username": user, "password": password or ""}
                page = browser.new_context(**ctx_kw).new_page()
                responses = {}

                def remember_image(response):
                    if response.request.resource_type == "image" and not 300 <= response.status < 400:
                        request = response.request
                        while request.redirected_from:
                            request = request.redirected_from
                        responses[request.url] = response

                page.on("response", remember_image)
                misses = []
                bundle_errors = []
                observed = {}
                page.route("**/birdnet-api.php**", _make_api_handler(small_floor, window_hours, auth, species, observed))
                page.route("**/apt.js*", _make_js_handler(
                    cluster_xbias, cluster_ybias, count_exp, cluster_pad,
                    label_min_px, auth, misses))
                if bird_names:
                    hand_font = os.path.realpath(os.path.join(
                        os.path.dirname(__file__), "..", "avian", "frontend", "fonts", "Caveat.ttf"))
                    if not os.path.isfile(hand_font):
                        raise RuntimeError("collage label font is missing")
                    page.route("**/avian/frontend/fonts/Caveat.ttf*",
                               lambda route: route.fulfill(path=hand_font))
                if cutout_base or cutout_resolver is not None:
                    page.route(
                        "**/cutout.php*",
                        _make_cutout_handler(
                            cutout_base,
                            cutout_local,
                            resolver=cutout_resolver,
                            errors=bundle_errors,
                            bundle_assets=bundle_assets,
                        ),
                    )
                if dims_path is not None:
                    page.route(
                        "**/dims.json*", lambda route: route.fulfill(path=str(dims_path))
                    )
                if masks_path is not None:
                    page.route(
                        "**/masks.json*", lambda route: route.fulfill(path=str(masks_path))
                    )
                if bundle_assets is not None:
                    page.route(
                        "**/avian/api/bundle-assets.php*",
                        _make_bundle_assets_handler(bundle_assets, bundle_errors),
                    )

                css = HIDE_CSS + _frame_css(headline_px, eyebrow_px, lowercase, pad_top, pad_side, pad_bottom, collage_vh)
                page.add_init_script(
                    "window.__avianFrameCapture=true;"
                    "document.addEventListener('DOMContentLoaded',function(){"
                    "var s=document.createElement('style');s.textContent=" + json.dumps(css) +
                    ";document.head.appendChild(s);});")

                deadline = time.monotonic() + timeout_ms / 1000

                def remaining_ms():
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise RuntimeError("collage capture deadline exceeded")
                    return max(1, int(remaining * 1000))

                resp = page.goto(_frame_url(url, bird_names), wait_until="domcontentloaded", timeout=remaining_ms())
                if resp is None or not resp.ok:
                    raise RuntimeError(f"site returned {resp.status if resp else 'no response'}")
                color = None
                # Startup completion, font/layout retries, or a poll can redraw
                # after readiness. Retry only invalidated snapshots, never asset
                # or API failures, and never extend the shared capture deadline.
                for _attempt in range(3):
                    if observed.get("error"):
                        raise RuntimeError(observed["error"])
                    if bundle_errors:
                        raise RuntimeError("active bundle failed integrity validation")
                    if bird_names:
                        page.wait_for_function(
                            "async () => { const f = await document.fonts.load('600 16px Hand');"
                            " await document.fonts.ready;"
                            " return f.length > 0 && document.fonts.check('600 16px Hand'); }",
                            timeout=remaining_ms())
                    try:
                        ready = page.wait_for_function(FRAME_READY, timeout=remaining_ms()).json_value()
                    except PWTimeout as error:
                        reason = observed.get("error") or "collage not ready; update both the mic and frame if their versions differ"
                        raise RuntimeError(reason) from error
                    if bird_names:
                        missing_labels = page.evaluate(
                            "() => [...document.querySelectorAll('#collage .gtile')]"
                            ".filter(t => !t.querySelector('.gtile-label text'))"
                            ".map(t => t.getAttribute('data-sci') || '?')")
                        if missing_labels:
                            raise RuntimeError("frame labels missing for: " + ", ".join(missing_labels))
                    if misses:
                        raise RuntimeError(f"apt.js tunables not found ({len(misses)}); refusing to ship a half-tuned frame")
                    if bundle_errors:
                        raise RuntimeError("active bundle failed integrity validation")

                    # A redraw can replace the empty-state DOM and these titles;
                    # reapply the frame overrides to each candidate snapshot.
                    if title is not None:
                        page.evaluate("t=>{const e=document.querySelector('.static-head .pre'); if(e)e.textContent=t;}", title)
                    if subtitle is not None:
                        page.evaluate("s=>{const e=document.querySelector('.static-head h1'); if(e)e.textContent=s;}", subtitle)
                    # empty_text=None hides the line: gen 3 shows the bare nest.
                    if empty_text is None:
                        page.evaluate("() => { const e = document.querySelector('.empty'); if (e) e.style.display = 'none'; }")
                    else:
                        page.evaluate("(t) => { const e = document.querySelector('.empty'); if (e) e.textContent = t; }", empty_text)
                    page.wait_for_function("""async () => {
                      await Promise.all([...document.querySelectorAll('#collage img')].map(i => i.decode()));
                      await document.fonts.ready;
                      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                      return true;
                    }""", timeout=remaining_ms())
                    ready = page.wait_for_function(FRAME_STABLE, timeout=remaining_ms()).json_value()
                    changed = "collage changed before capture"
                    unchanged = page.evaluate(FRAME_UNCHANGED, ready)
                    # Browser calls pump route callbacks. Check Python's response
                    # token and sticky failures after the JS check returns too.
                    if observed.get("error") or bundle_errors:
                        raise RuntimeError(changed)
                    if (str(observed.get("token")) != ready["token"]
                            or not unchanged):
                        continue
                    layout = page.evaluate(CAPTURE_LAYOUT)
                    expected_responses = {item["src"]: responses.get(item["src"]) for item in layout["images"]}
                    images = _composition_images(layout, responses, dsf)
                    if color is None:
                        paper = page.evaluate("() => getComputedStyle(document.body).backgroundColor")
                        color = re.fullmatch(r"rgb\((\d+), (\d+), (\d+)\)", paper)
                        if not color:
                            raise RuntimeError("unsupported frame paper color")
                    changed = "collage changed during capture"

                    def check_snapshot():
                        # A browser call can deliver an API or integrity failure
                        # after its JavaScript identity result was computed.
                        if observed.get("error") or bundle_errors:
                            raise RuntimeError(changed)
                        if str(observed.get("token")) != ready["token"]:
                            raise _CaptureChanged(changed)

                    overlay = None
                    try:
                        overlay = capture_text_overlay(
                            page, vw, vh, dsf, remaining_ms=remaining_ms, check_snapshot=check_snapshot)
                        buffers.enter_context(overlay)
                        unchanged = page.evaluate(FRAME_UNCHANGED, ready)
                        current_layout = page.evaluate(CAPTURE_LAYOUT)
                        check_snapshot()
                        if any(current_layout[key] != layout[key] for key in ("token", "revision")):
                            raise _CaptureChanged(changed)
                        if (not unchanged or current_layout != layout
                                or any(responses.get(src) is not response for src, response in expected_responses.items())):
                            raise RuntimeError(changed)
                    except _CaptureChanged:
                        if overlay is not None:
                            overlay.close()
                        continue
                    remaining_ms()
                    captured_species = [dict(row) for row in observed["species"]]
                    break
                else:
                    raise RuntimeError(changed)
            finally:
                browser.close()
        # Compose only after Chromium and its driver release their memory.
        png = capture_art.compose_capture(overlay, images, size, tuple(map(int, color.groups())))
        try:
            previous = os.stat(out, follow_symlinks=False)
        except FileNotFoundError:
            previous = None
        if previous is not None and not stat.S_ISREG(previous.st_mode):
            raise RuntimeError("capture output must be a regular file")
        with tempfile.TemporaryDirectory(dir=os.path.dirname(os.path.abspath(out))) as directory:
            pending = os.path.join(directory, "shot.png")
            with open(pending, "xb") as stream:
                stream.write(png)
                if previous is not None:
                    current = os.fstat(stream.fileno())
                    if (current.st_uid, current.st_gid) != (previous.st_uid, previous.st_gid):
                        os.fchown(stream.fileno(), previous.st_uid, previous.st_gid)
                    os.fchmod(stream.fileno(), stat.S_IMODE(previous.st_mode))
            os.replace(pending, out)
        if capture is not None:
            capture["species"] = captured_species

        return out


def shoot_birdweather(out, species, *, title=None, subtitle=None, timeout_ms=45000,
                      cutout_resolver=None, dims_path=None, masks_path=None,
                      bundle_assets=None, **look):
    """Render `species` ([{sci,com,n}]) as the BirdWeather collage into `out`.

    The mic path screenshots a live site; this builds the same page from a
    species list instead. It serves the bundled frontend on localhost, feeds it
    the species, and routes cutouts to the local clone first then GitHub, so the
    --bird-weather CLI and display.py's inline render share one setup. An empty
    list renders the page's empty-state card, the same as the mic mode. `look`
    overrides any shoot() tunable (the CLI passes its flags through)."""
    if species is None:
        raise RuntimeError("shoot_birdweather needs a species list")
    here = os.path.dirname(os.path.abspath(__file__))
    _httpd, port = _serve_frontend(os.path.join(here, "..", "avian", "frontend"))
    cutout_local = (
        None
        if cutout_resolver is not None
        else os.path.join(here, "..", "avian", "assets", "illustrations")
    )
    # BirdWeather's flat 7-day counts need a steeper exponent for the same hero
    # hierarchy; the slightly smaller titles match the mic frame's optical weight.
    # A birdless BirdWeather frame says "no recent detections", not "listening".
    for k, v in (("count_exp", 1.0), ("headline_px", 39), ("eyebrow_px", 17),
                 ("empty_text", "no recent detections")):
        look.setdefault(k, v)
    return shoot(f"http://127.0.0.1:{port}/", out,
                 title="Avian Visitors" if title is None else title,
                 subtitle="Heard Today" if subtitle is None else subtitle,
                 species=species, cutout_base=RAW_ILLUSTRATIONS, cutout_local=cutout_local,
                 cutout_resolver=cutout_resolver, dims_path=dims_path, masks_path=masks_path,
                 bundle_assets=bundle_assets,
                 timeout_ms=timeout_ms, **look)


def main():
    ap = argparse.ArgumentParser(description="Screenshot the AvianVisitors collage for the e-ink frame.")
    ap.add_argument("--url", default="http://birdnet.local")
    ap.add_argument("--out", default="frame.png")
    ap.add_argument("--title")
    ap.add_argument("--subtitle")
    ap.add_argument("--lowercase", action="store_true")
    ap.add_argument("--headline-px", type=int, default=None,
                    help="headline font px; default 42 for the mic, 39 for --bird-weather")
    ap.add_argument("--eyebrow-px", type=int, default=None,
                    help="eyebrow font px; default 18 for the mic, 17 for --bird-weather")
    ap.add_argument("--mat", type=float, default=0.04)
    ap.add_argument("--collage-vh", type=float, default=52)
    ap.add_argument("--cluster-xbias", type=float, default=1.0)
    ap.add_argument("--cluster-ybias", type=float, default=1.2)
    ap.add_argument("--count-exp", type=float, default=None,
                    help="count-to-size exponent; default 0.4 for the mic, 1.0 for --bird-weather")
    ap.add_argument("--cluster-pad", type=int, default=1)
    ap.add_argument("--small-floor", type=float, default=0.04)
    ap.add_argument("--window-hours", type=int)
    ap.add_argument("--bird-weather", action="store_true",
                    help="render from BirdWeather data for --zip or --station-id")
    ap.add_argument("--zip", help="ZIP / postal code; use one BirdWeather locator")
    ap.add_argument("--station-id", help="public numeric BirdWeather station ID")
    ap.add_argument("--bw-days", type=int, default=7, help="--bird-weather lookback window in days")
    ap.add_argument("--bw-country", default="us", help="--bird-weather geocoder country code")
    ap.add_argument("--width", type=int, default=600)
    ap.add_argument("--height", type=int, default=800)
    ap.add_argument("--dsf", type=int, default=2)
    ap.add_argument("--user")
    ap.add_argument("--password")
    ap.add_argument("--bird-names", action="store_true",
                    help="show common names along the birds")
    ap.add_argument("--timeout", type=int, default=45000)
    a = ap.parse_args()
    if (a.zip or a.station_id) and not a.bird_weather:
        print("--zip and --station-id only apply with --bird-weather", file=sys.stderr)
        sys.exit(2)
    if a.bird_weather:
        if bool(a.zip) == bool(a.station_id):
            print("--bird-weather needs exactly one of --zip or --station-id", file=sys.stderr)
            sys.exit(2)
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import birdweather
        if a.station_id:
            species = birdweather.species_for_station(a.station_id, days=a.bw_days)
            source = f"BirdWeather station {birdweather.station_id(a.station_id)}"
        else:
            species = birdweather.species_for_zip(a.zip, country=a.bw_country, days=a.bw_days)
            source = f"ZIP {a.zip}"
        if not species:
            print(f"no drawable birds for {source}; nothing to render", file=sys.stderr)
            sys.exit(3)
        # Pass the CLI's look flags through; shoot_birdweather fills the bird-weather
        # defaults (steeper count exponent, smaller titles) for anything left unset.
        look = {k: v for k, v in (("count_exp", a.count_exp), ("headline_px", a.headline_px),
                                  ("eyebrow_px", a.eyebrow_px)) if v is not None}
        look.update(vw=a.width, vh=a.height, dsf=a.dsf, mat=a.mat, collage_vh=a.collage_vh,
                    cluster_xbias=a.cluster_xbias, cluster_ybias=a.cluster_ybias,
                    cluster_pad=a.cluster_pad, small_floor=a.small_floor, lowercase=a.lowercase,
                    window_hours=a.window_hours, user=a.user, password=a.password,
                    bird_names=a.bird_names)
        try:
            shoot_birdweather(a.out, species, title=a.title, subtitle=a.subtitle,
                              timeout_ms=a.timeout, **look)
        except Exception as e:
            print(f"shoot failed: {e}", file=sys.stderr)
            sys.exit(1)
        print(f"wrote {a.out}")
        return
    # Mic path: screenshot the live AvianVisitors site at --url.
    count_exp = a.count_exp if a.count_exp is not None else 0.4
    headline_px = a.headline_px if a.headline_px is not None else 42
    eyebrow_px = a.eyebrow_px if a.eyebrow_px is not None else 18
    try:
        shoot(a.url, a.out, title=a.title, subtitle=a.subtitle, vw=a.width, vh=a.height, dsf=a.dsf,
              headline_px=headline_px, eyebrow_px=eyebrow_px, lowercase=a.lowercase,
              mat=a.mat, collage_vh=a.collage_vh, cluster_xbias=a.cluster_xbias,
              cluster_ybias=a.cluster_ybias, count_exp=count_exp, cluster_pad=a.cluster_pad,
              small_floor=a.small_floor,
              window_hours=a.window_hours, timeout_ms=a.timeout, user=a.user, password=a.password,
              bird_names=a.bird_names)
    except Exception as e:
        print(f"shoot failed: {e}", file=sys.stderr)
        sys.exit(1)
    print(f"wrote {a.out}")


if __name__ == "__main__":
    main()
