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

  pip install playwright && playwright install chromium
  python3 shoot.py --url https://bird.onethreenine.net \
      --title "onethreenine birds" --subtitle "heard today" --out frame.png
"""
from __future__ import annotations

import argparse
import base64
import http.server
import json
import os
import re
import socketserver
import sys
import threading
import urllib.parse

from playwright.sync_api import TimeoutError as PWTimeout
from playwright.sync_api import sync_playwright

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
"""


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
    """Set the frame's label preference without disturbing other URL state.

    None means follow: leave the URL alone, and the page resolves labels the
    way any new device does - from the station's COLLAGE_LABELS, carried on
    the recent payload. True/False are explicit overrides via ?labels=."""
    if bird_names is None:
        return url
    parts = urllib.parse.urlsplit(url)
    query = [(key, value) for key, value in urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
             if key != "labels"]
    query.append(("labels", "1" if bird_names else "0"))
    return urllib.parse.urlunsplit(parts._replace(query=urllib.parse.urlencode(query)))


def _make_api_handler(floor_frac, window_hours, auth, species=None, seen=None):
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
                resp = route.fetch(**kw)
                if not resp.ok:
                    # Pass a station error through as-is. Re-serving it as 200
                    # would hand the page a {"error":...} body it treats as a
                    # birdless station, and the frame would print an empty nest
                    # for a box that merely has its database locked. Untouched,
                    # the page's own !r.ok guard leaves the collage unrendered,
                    # the wait below times out, and the last good frame stays.
                    return route.fulfill(response=resp)
                data = resp.json()
            sp = data.get("species", [])
            # Tell shoot() the payload has arrived, and the station's label
            # default if it sent one. shoot() cannot infer either from the DOM:
            # the page draws the empty nest *before* it asks for the payload.
            if seen is not None:
                seen["fired"] = True
                if isinstance(data.get("labels"), bool):
                    seen["labels"] = data["labels"]
            if sp and floor_frac > 0:
                floor = max((s.get("n") or 1) for s in sp) * floor_frac
                for s in sp:
                    if (s.get("n") or 1) < floor:
                        s["n"] = max(1, round(floor))
            route.fulfill(status=200, content_type="application/json", body=json.dumps(data))
        except Exception as e:
            print(f"recent-API rewrite skipped: {e}", file=sys.stderr)
            if seen is not None:
                seen["fired"] = True   # the page got its payload, we just did not see it
            _safe_continue(route)
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


def _make_cutout_handler(base, local_dir=None):
    """Resolve each cutout.php lookup to the bird's illustration. Serve a local
    file first when `local_dir` has it - that is how cutouts you generate and copy
    into the clone render before they reach GitHub - otherwise 302 to the raw
    GitHub copy. Trusts species_for_zip to pre-filter to drawable slugs, so the
    GitHub fallback only lands on a missing file if the repo is mid-update."""
    def handler(route):
        try:
            params = urllib.parse.parse_qs(urllib.parse.urlparse(route.request.url).query)
            slug = re.sub(r"[^a-z0-9]+", "-", (params.get("sci") or [""])[0].lower()).strip("-")
            if (params.get("pose") or ["1"])[0] == "2":
                slug += "-2"
            if local_dir:
                local = os.path.join(local_dir, slug + ".png")
                if os.path.isfile(local):
                    return route.fulfill(path=local)
            route.fulfill(status=302, headers={"location": base + slug + ".png"})
        except Exception:
            _safe_continue(route)
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
          cutout_local=None, empty_text="listening for birds…", bird_names=None):
    pad_side, pad_top, pad_bottom = int(vw * mat), int(vh * mat * 0.92), int(vh * mat)
    auth = "Basic " + base64.b64encode(f"{user}:{password or ''}".encode()).decode() if user else None

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
            misses = []
            seen = {}
            page.route("**/birdnet-api.php**", _make_api_handler(small_floor, window_hours, auth, species, seen))
            page.route("**/apt.js*", _make_js_handler(
                cluster_xbias, cluster_ybias, count_exp, cluster_pad,
                label_min_px, auth, misses))
            # In follow mode labels may turn out on only after the page has the
            # recent payload, so the local font route goes in whenever they are
            # not explicitly off. It only ever answers a request for Caveat.ttf,
            # which a page without labels never makes, and a missing local copy
            # just lets the page fetch the site's; the font check below is what
            # makes a failed load fatal.
            hand_font = os.path.realpath(os.path.join(
                os.path.dirname(__file__), "..", "avian", "frontend", "fonts", "Caveat.ttf"))
            if bird_names is not False and os.path.isfile(hand_font):
                page.route("**/avian/frontend/fonts/Caveat.ttf*",
                           lambda route: route.fulfill(path=hand_font))
            if cutout_base:
                page.route("**/cutout.php*", _make_cutout_handler(cutout_base, cutout_local))

            css = HIDE_CSS + _frame_css(headline_px, eyebrow_px, lowercase, pad_top, pad_side, pad_bottom, collage_vh)
            page.add_init_script(
                "document.addEventListener('DOMContentLoaded',function(){"
                "var s=document.createElement('style');s.textContent=" + json.dumps(css) +
                ";document.head.appendChild(s);});")

            resp = page.goto(_frame_url(url, bird_names), wait_until="domcontentloaded", timeout=timeout_ms)
            if resp is None or not resp.ok:
                raise RuntimeError(f"site returned {resp.status if resp else 'no response'}")
            # Wait for the collage, or for the empty-state element the page shows
            # when the mic has heard nothing yet, so a birdless frame renders a
            # clean title card fast instead of hanging until the timeout. A page
            # with neither still times out here and stays fatal (keep last frame).
            page.wait_for_selector(".gtile, .empty", state="attached", timeout=timeout_ms)
            # That selector alone is not proof the collage is drawn: the page
            # renders the empty nest ~150ms in, *before* the recent payload
            # answers (~220ms on a LAN, far longer on a Zero 2 W over WiFi), so
            # a birdful station can satisfy ".empty" and ship a nest.
            # The page stamps the collage with where its render came from, so
            # wait for one drawn from the recent payload - then it holds tiles,
            # or the nest for a station with nothing drawable - before reading
            # anything off it. By then the handler has served the payload and
            # recorded the station's label default.
            page.wait_for_selector(
                "#collage[data-rendered='data'] .gtile, #collage[data-rendered='data'] .empty",
                state="attached", timeout=timeout_ms)
            if not seen.get("fired"):
                raise RuntimeError("the collage rendered without the recent payload passing the frame's handler")
            # Resolve labels exactly as the page does: an explicit override, else
            # the station's default as served, else the page's own on. After the
            # payload has been seen, a missing field is an older station whose
            # page really does draw names by default, so on is the true answer.
            # (Not for BirdWeather: that payload is synthesized here and has no
            # station to carry a default, so the note would print every render.)
            if bird_names is None and "labels" not in seen and species is None:
                print("station sends no label default; names follow the page default (on)", file=sys.stderr)
            want_labels = bird_names if bird_names is not None else seen.get("labels", True)
            if want_labels:
                font_loaded = page.evaluate(
                    "async () => { const f = await document.fonts.load('600 16px Hand');"
                    " await document.fonts.ready;"
                    " return f.length > 0 && document.fonts.check('600 16px Hand'); }")
                if not font_loaded:
                    raise RuntimeError("collage label font did not load")
            if page.query_selector(".gtile") is not None:
                try:
                    page.wait_for_function(
                        "() => { const t=[...document.querySelectorAll('.gtile img')];"
                        " return t.length>0 && t.every(i=>i.complete && i.naturalWidth>0); }",
                        timeout=timeout_ms)
                except PWTimeout:
                    print("some illustrations did not finish loading; capturing anyway", file=sys.stderr)
                if want_labels:
                    missing_labels = page.evaluate(
                        "() => [...document.querySelectorAll('.gtile')]"
                        ".filter(t => !t.querySelector('.gtile-label text'))"
                        ".map(t => t.getAttribute('data-sci') || '?')")
                    if missing_labels:
                        raise RuntimeError(
                            "frame labels missing for: " + ", ".join(missing_labels))
            elif page.query_selector(".nest-img") is not None:
                # Birdless empty state: wait for the nest illustration to load so
                # the frame never captures a blank collage area.
                try:
                    page.wait_for_function(
                        "() => { const n=document.querySelector('.nest-img');"
                        " return n && n.complete && n.naturalWidth>0; }",
                        timeout=timeout_ms)
                except PWTimeout:
                    print("nest illustration did not finish loading; capturing anyway", file=sys.stderr)
            if misses:
                raise RuntimeError(f"apt.js tunables not found ({len(misses)}); refusing to ship a half-tuned frame")

            if title is not None:
                page.evaluate("t=>{const e=document.querySelector('.static-head .pre'); if(e)e.textContent=t;}", title)
            if subtitle is not None:
                page.evaluate("s=>{const e=document.querySelector('.static-head h1'); if(e)e.textContent=s;}", subtitle)
            # Set the empty-state line for a birdless frame (the mic hasn't heard
            # anything yet, or BirdWeather has no recent detections nearby) and
            # darken it so it survives the e-ink dither and the matting step's ink
            # detection (a no-op once there are birds). empty_text=None hides the
            # line entirely: the gen 3 frame shows the bare nest, no words.
            if empty_text is None:
                page.evaluate("() => { const e = document.querySelector('.empty'); if (e) e.style.display = 'none'; }")
            else:
                page.evaluate("(t) => { const e = document.querySelector('.empty'); if (e) e.textContent = t; }", empty_text)
            page.wait_for_timeout(250)
            # clip is CSS px; device_scale_factor scales the PNG to vw*dsf by vh*dsf = 1200x1600
            page.screenshot(path=out, clip={"x": 0, "y": 0, "width": vw, "height": vh})
        finally:
            browser.close()
    return out


def shoot_birdweather(out, species, *, title=None, subtitle=None, timeout_ms=45000, **look):
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
    cutout_local = os.path.join(here, "..", "avian", "assets", "illustrations")
    # BirdWeather's flat 7-day counts need a steeper exponent for the same hero
    # hierarchy; the slightly smaller titles match the mic frame's optical weight.
    # A birdless BirdWeather frame says "no recent detections nearby", not "listening".
    for k, v in (("count_exp", 1.0), ("headline_px", 39), ("eyebrow_px", 17),
                 ("empty_text", "no recent detections nearby")):
        look.setdefault(k, v)
    return shoot(f"http://127.0.0.1:{port}/", out,
                 title=title or "Avian Visitors", subtitle=subtitle or "Heard Today",
                 species=species, cutout_base=RAW_ILLUSTRATIONS, cutout_local=cutout_local,
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
                    help="render from BirdWeather data for --zip instead of a local mic")
    ap.add_argument("--zip", help="ZIP / postal code, required with --bird-weather")
    ap.add_argument("--bw-days", type=int, default=7, help="--bird-weather lookback window in days")
    ap.add_argument("--bw-country", default="us", help="--bird-weather geocoder country code")
    ap.add_argument("--width", type=int, default=600)
    ap.add_argument("--height", type=int, default=800)
    ap.add_argument("--dsf", type=int, default=2)
    ap.add_argument("--user")
    ap.add_argument("--password")
    ap.add_argument("--bird-names", action=argparse.BooleanOptionalAction, default=None,
                    help="force names on (--bird-names) or off (--no-bird-names); "
                         "unset follows the station's COLLAGE_LABELS")
    ap.add_argument("--timeout", type=int, default=45000)
    a = ap.parse_args()
    if a.bird_weather:
        if not a.zip:
            print("--bird-weather needs --zip", file=sys.stderr)
            sys.exit(2)
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import birdweather
        species = birdweather.species_for_zip(a.zip, country=a.bw_country, days=a.bw_days)
        if not species:
            print(f"no drawable birds near {a.zip}; nothing to render", file=sys.stderr)
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
