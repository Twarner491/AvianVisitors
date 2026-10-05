"""Real Chromium regression for PNGs that stall after their first rows."""
import functools
import http.server
import importlib.util
import json
import os
import re
from pathlib import Path
import threading
import time
import urllib.parse

import pytest
from PIL import Image
from tests.png_fixtures import scanline_png

pw = pytest.importorskip("playwright.sync_api")
ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def shooter(monkeypatch):
    spec = importlib.util.spec_from_file_location("browser_shoot", ROOT / "frame/shoot.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    executable = os.environ.get("FRAME_TEST_CHROMIUM")
    if executable:
        launch = pw.BrowserType.launch
        monkeypatch.setattr(pw.BrowserType, "launch", lambda self, **kw:
                            launch(self, executable_path=executable, **kw))
    return module


@pytest.fixture
def station():
    release = threading.Event()
    started = threading.Event()
    state = {"release_after": None, "malformed": False, "many": False, "requests": [],
             "auth": False, "redirect": False, "once": False, "empty": False,
             "recent_requests": 0, "stats_delay": 0, "stats_finished": False}
    bird = ROOT / "avian/assets/illustrations/corvus-brachyrhynchos.png"

    class Handler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def send(self, data, kind):
            self.send_response(200)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            url = urllib.parse.urlsplit(self.path)
            if state["auth"] and self.headers.get("Authorization") != "Basic dXNlcjpwYXNz":
                self.send_response(401)
                self.send_header("WWW-Authenticate", 'Basic realm="capture fixture"')
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if url.path == "/":
                html = (ROOT / "avian/frontend/index.html").read_text()
                seed = "let seed=73;Math.random=()=>((seed=(seed*1664525+1013904223)>>>0)/4294967296);"
                html = html.replace("</head>", "<script>" + (seed if state["many"] else
                                    "Math.random=()=>0.9;") + "</script></head>")
                return self.send(html.encode(), "text/html")
            if url.path == "/avian/api/birdnet-api.php":
                data = {}
                if urllib.parse.parse_qs(url.query).get("action") == ["stats"]:
                    time.sleep(state["stats_delay"])
                    state["stats_finished"] = True
                if urllib.parse.parse_qs(url.query).get("action") == ["recent"]:
                    state["recent_requests"] += 1
                    data = {"species": [{"sci": "Corvus brachyrhynchos",
                                         "com": "American Crow", "n": 20}], "hours": 24}
                    if state["many"]:
                        dims = json.loads((ROOT / "avian/frontend/dims.json").read_text())
                        names = [name for name in sorted(dims) if not name.endswith("-2")][:23]
                        data["species"] = [{"sci": name.replace("-", " ").capitalize(),
                                            "com": name.replace("-", " "), "n": 24 - i}
                                           for i, name in enumerate(names)]
                    if state["empty"]:
                        data["species"] = []
                return self.send(json.dumps(data).encode(), "application/json")
            if url.path == "/avian/api/cutout.php" and state["redirect"]:
                self.send_response(302)
                self.send_header("Location", "/redirect-bird.png?" + url.query)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if url.path in ("/avian/api/cutout.php", "/redirect-bird.png"):
                state["requests"].append(self.path)
                query = urllib.parse.parse_qs(url.query)
                name = re.sub("[^a-z0-9]+", "-", query["sci"][0].lower()).strip("-")
                if query.get("pose") == ["2"]:
                    name += "-2"
                data = (bird.parent / (name + ".png")).read_bytes()
                if state["malformed"] == "missing-rows":
                    return self.send(scanline_png(4, 4, 8, 6, bytes(17)), "image/png")
                if (state["malformed"] is True or state["malformed"] == "mixed" and name.removesuffix("-2") == "acanthis-flammea"
                        or state["once"] and state["requests"].count(self.path) > 1):
                    return self.send(data[:-12], "image/png")
                self.send_response(200)
                self.send_header("Content-Type", "image/png")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                split = len(data) // 12
                self.wfile.write(data[:split])
                self.wfile.flush()
                started.set()
                timer = None
                if state["release_after"] is not None:
                    timer = threading.Timer(state["release_after"], release.set)
                    timer.start()
                try:
                    if release.wait(15):
                        self.wfile.write(data[split:])
                except (BrokenPipeError, ConnectionResetError):
                    pass
                finally:
                    if timer:
                        timer.cancel()
                return
            if url.path.startswith("/fallback/"):
                state["requests"].append(self.path)
                return self.send((bird.parent / Path(url.path).name).read_bytes(), "image/png")
            if url.path.startswith("/avian/api/"):
                return self.send(b"{}", "application/json")
            self.path = self.path.removeprefix("/avian/frontend")
            return super().do_GET()

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(
        Handler, directory=str(ROOT / "avian/frontend")))
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/", started, state, bird
    finally:
        release.set()
        server.shutdown()
        server.server_close()
        worker.join()


def test_stalled_png_keeps_previous_capture(shooter, station, tmp_path, monkeypatch):
    url, started, _state, _bird = station
    output = tmp_path / "shot.png"
    previous = b"previous complete capture"
    output.write_bytes(previous)
    screenshots = []
    screenshot = pw.Page.screenshot

    def record(page, **kwargs):
        screenshots.append(True)
        return screenshot(page, **kwargs)

    monkeypatch.setattr(pw.Page, "screenshot", record)
    with pytest.raises(RuntimeError, match="collage not ready"):
        shooter.shoot(url, str(output), bird_names=True, timeout_ms=3000)
    assert started.is_set(), "the PNG must actually begin transferring"
    assert not screenshots
    assert output.read_bytes() == previous


def test_slow_png_captures_full_bird_after_transfer(shooter, station, tmp_path, monkeypatch):
    url, started, state, bird = station
    state["release_after"] = 0.75
    output = tmp_path / "shot.png"
    screenshot = pw.Page.screenshot
    captured = {}

    def record(page, **kwargs):
        captured.update(page.evaluate("""() => {
          const image = document.querySelector('#collage .gtile img');
          return {complete: image.complete, box: image.getBoundingClientRect().toJSON(),
            labels: document.querySelectorAll('#collage .gtile-label text').length};
        }"""))
        return screenshot(page, **kwargs)

    monkeypatch.setattr(pw.Page, "screenshot", record)
    shooter.shoot(url, str(output), bird_names=True, timeout_ms=10000, dsf=1)
    assert started.is_set()
    assert captured["complete"]
    assert captured["labels"] > 0
    box = captured["box"]
    with Image.open(output) as image, Image.open(bird) as source:
        assert image.size == (600, 800)
        # A partial PNG paints only its first rows. Check the lower half of the
        # actual bird, where neither that strip nor the name can satisfy this.
        width, height = round(box["width"]), round(box["height"])
        expected = source.convert("RGBA").resize((width, height))
        pixels = expected.load()
        expected_ink = sum(pixels[x, y][3] > 200 and max(pixels[x, y][:3]) < 170
                           for y in range(height // 2, height) for x in range(width))
        painted = image.convert("RGB").crop((round(box["x"]), round(box["y"]) + height // 2,
                                              round(box["x"]) + width, round(box["y"]) + height))
        pixels = painted.load()
        actual_ink = sum(max(pixels[x, y]) < 170
                         for y in range(painted.height) for x in range(painted.width))
        assert expected_ink > 100
        assert actual_ink >= expected_ink * 0.8


def test_complete_but_truncated_png_keeps_previous_capture(shooter, station, tmp_path):
    url, _started, state, _bird = station
    state["malformed"] = True
    output = tmp_path / "shot.png"
    output.write_bytes(b"last good frame")
    with pytest.raises(RuntimeError):
        shooter.shoot(url, str(output), bird_names=True, timeout_ms=3000)
    assert output.read_bytes() == b"last good frame"


@pytest.mark.parametrize("graphics_mb", [None, 4])
def test_graphics_budget_keeps_all_source_art(shooter, station, tmp_path, monkeypatch, graphics_mb):
    url, _started, state, bird = station
    state.update(many=True, release_after=0)
    launch = pw.BrowserType.launch
    if graphics_mb:
        monkeypatch.setattr(pw.BrowserType, "launch", lambda self, **kw: launch(
            self, **{**kw, "args": kw.get("args", []) + [f"--force-gpu-mem-available-mb={graphics_mb}"]}))
    screenshot = pw.Page.screenshot
    layout = []

    def record(page, **kwargs):
        clip = kwargs["clip"]
        assert round(clip["width"] * 2) * round(clip["height"] * 2) <= 120000
        if not layout:
            layout.extend(page.evaluate("""() => [...document.querySelectorAll('#collage img')].map(i => ({
              src: i.currentSrc, box: i.getBoundingClientRect().toJSON()
            }))"""))
        return screenshot(page, **kwargs)

    monkeypatch.setattr(pw.Page, "screenshot", record)
    output = tmp_path / "shot.png"
    shooter.shoot(url, str(output), bird_names=True, timeout_ms=15000)
    assert len(layout) == 23
    assert any("pose=2" in item["src"] for item in layout)
    matches = {}
    with Image.open(output) as captured:
        assert captured.size == (1200, 1600)
        for item in layout:
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(item["src"]).query)
            name = re.sub("[^a-z0-9]+", "-", query["sci"][0].lower()).strip("-")
            if query.get("pose") == ["2"]:
                name += "-2"
            box = item["box"]
            size = (round(box["width"] * 2), round(box["height"] * 2))
            with Image.open(bird.parent / (name + ".png")) as original:
                expected = original.convert("RGBA").resize(size, Image.Resampling.LANCZOS)
            actual = captured.convert("RGB").crop((round(box["x"] * 2), round(box["y"] * 2),
                round(box["x"] * 2) + size[0], round(box["y"] * 2) + size[1]))
            ep, ap = expected.load(), actual.load()
            pairs = [(ep[x, y], ap[x, y]) for y in range(size[1]) for x in range(size[0])
                     if ep[x, y][3] > 240 and max(ep[x, y][:3]) < 180]
            assert len(pairs) > 100
            matched = sum(max(abs(a[c] - b[c]) for c in range(3)) < 45 for a, b in pairs)
            matches[name] = matched / len(pairs)
    assert min(matches.values()) > 0.75, matches


@pytest.mark.parametrize("redirect", [False, True])
def test_validates_exact_authenticated_response_without_refetch(shooter, station, tmp_path, redirect):
    url, _started, state, _bird = station
    state.update(auth=True, redirect=redirect, once=True, release_after=0)
    output = tmp_path / "shot.png"
    shooter.shoot(url, str(output), user="user", password="pass", timeout_ms=10000)
    assert len(state["requests"]) == 1
    with Image.open(output) as image:
        assert image.mode == "RGB" and image.size == (1200, 1600)


def test_wrong_auth_cannot_replace_previous_capture(shooter, station, tmp_path):
    url, _started, state, _bird = station
    state.update(auth=True, release_after=0)
    output = tmp_path / "shot.png"
    output.write_bytes(b"last good")
    with pytest.raises(Exception):
        shooter.shoot(url, str(output), user="user", password="wrong", timeout_ms=3000)
    assert not state["requests"]
    assert output.read_bytes() == b"last good"


def test_missing_png_rows_preserve_previous_capture(shooter, station, tmp_path):
    url, _started, state, _bird = station
    state.update(malformed="missing-rows", release_after=0)
    output = tmp_path / "shot.png"
    output.write_bytes(b"last good")
    output.chmod(0o664)
    previous = output.stat()
    with pytest.raises(Exception):
        shooter.shoot(url, str(output), timeout_ms=3000)
    assert output.read_bytes() == b"last good"
    assert output.stat().st_mode == previous.st_mode
    assert (output.stat().st_uid, output.stat().st_gid) == (previous.st_uid, previous.st_gid)


@pytest.mark.parametrize("dsf", [1, 1.25, 1.5, 2])
@pytest.mark.parametrize("empty", [False, True])
def test_labels_off_and_empty_nest_keep_dimensions(shooter, station, tmp_path, dsf, empty):
    url, _started, state, _bird = station
    state.update(empty=empty, release_after=0)
    output = tmp_path / "shot.png"
    shooter.shoot(url, str(output), bird_names=False, dsf=dsf, timeout_ms=10000)
    with Image.open(output) as image:
        assert image.size == (round(600 * dsf), round(800 * dsf))
        assert image.mode == "RGB"


@pytest.mark.parametrize("local", [False, True])
def test_birdweather_existing_cutout_routes_are_preserved(shooter, station, tmp_path, local):
    url, _started, state, bird = station
    output = tmp_path / "shot.png"
    shooter.shoot(url, str(output), bird_names=True, timeout_ms=10000,
                  species=[{"sci": "Corvus brachyrhynchos", "com": "Crow", "n": 4}],
                  cutout_base=url + "fallback/", cutout_local=str(bird.parent) if local else str(tmp_path))
    assert not state["requests"] if local else all(path == "/fallback/corvus-brachyrhynchos.png"
                                                   for path in state["requests"])
    if not local:
        assert state["requests"]
    with Image.open(output) as image:
        assert image.mode == "RGB" and image.size == (1200, 1600)


def test_mixed_invalid_birds_preserve_last_good_metadata(shooter, station, tmp_path):
    url, _started, state, _bird = station
    state.update(many=True, malformed="mixed", release_after=0)
    output = tmp_path / "shot.png"
    output.write_bytes(b"last good")
    output.chmod(0o640)
    before = output.stat()
    capture = {}
    with pytest.raises(RuntimeError):
        shooter.shoot(url, str(output), capture=capture, timeout_ms=15000)
    after = output.stat()
    assert output.read_bytes() == b"last good"
    assert (after.st_mode, after.st_uid, after.st_gid) == (before.st_mode, before.st_uid, before.st_gid)
    assert capture == {}


@pytest.mark.parametrize("mutation", ["source", "layout", "token", "label"])
def test_mid_strip_change_preserves_last_good_frame(shooter, station, tmp_path, monkeypatch, mutation):
    url, _started, state, _bird = station
    state.update(release_after=0)
    output = tmp_path / "shot.png"
    output.write_bytes(b"last good")
    output.chmod(0o640)
    before = output.stat()
    screenshot = pw.Page.screenshot
    changed = False

    def mutate(page, **kwargs):
        nonlocal changed
        result = screenshot(page, **kwargs)
        if not changed:
            changed = True
            page.evaluate("""kind => {
              const image = document.querySelector('#collage img');
              if (kind === 'source') image.src += '&changed=1';
              if (kind === 'layout') image.style.transform = 'translateX(3px)';
              if (kind === 'token') document.getElementById('collage').dataset.frameRevision = 'changed';
              if (kind === 'label') document.querySelector('.gtile-label textPath').textContent = 'Changed';
            }""", mutation)
        return result

    monkeypatch.setattr(pw.Page, "screenshot", mutate)
    with pytest.raises(RuntimeError, match="changed"):
        shooter.shoot(url, str(output), bird_names=True, timeout_ms=10000)
    after = output.stat()
    assert changed and output.read_bytes() == b"last good"
    assert (after.st_mode, after.st_uid, after.st_gid) == (before.st_mode, before.st_uid, before.st_gid)


def test_frame_waits_for_initial_metadata_before_capture(shooter, station, tmp_path, monkeypatch):
    url, _started, state, _bird = station
    state.update(release_after=0, stats_delay=3)
    screenshot = pw.Page.screenshot

    def settled(page, **kwargs):
        assert state["stats_finished"], "capture started before initial metadata settled"
        return screenshot(page, **kwargs)

    monkeypatch.setattr(pw.Page, "screenshot", settled)
    captured = {}
    shooter.shoot(url, str(tmp_path / "shot.png"), timeout_ms=10000, capture=captured)
    assert state["recent_requests"] == 1
    assert [item["sci"] for item in captured["species"]] == ["Corvus brachyrhynchos"]


@pytest.mark.parametrize("trigger", ["timer", "visibility"])
def test_frame_capture_keeps_snapshot_during_background_refresh(shooter, station, tmp_path, monkeypatch, trigger):
    url, _started, state, _bird = station
    state.update(release_after=0)
    output = tmp_path / "shot.png"
    screenshot = pw.Page.screenshot
    triggered = False

    def delayed(page, **kwargs):
        nonlocal triggered
        if not triggered:
            triggered = True
            state["empty"] = True
            if trigger == "timer":
                page.wait_for_timeout(31000)
            else:
                page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
                page.wait_for_timeout(500)
        return screenshot(page, **kwargs)

    monkeypatch.setattr(pw.Page, "screenshot", delayed)
    captured = {}
    shooter.shoot(url, str(output), bird_names=True, timeout_ms=10000, capture=captured)
    assert triggered and state["recent_requests"] == 1
    assert [item["sci"] for item in captured["species"]] == ["Corvus brachyrhynchos"]
    with Image.open(output) as image:
        assert image.size == (1200, 1600)


def test_normal_page_still_polls_and_updates_collage(shooter, station):
    url, _started, state, _bird = station
    state.update(release_after=0)
    with pw.sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            page = browser.new_page()
            page.goto(url + "?labels=0")
            page.wait_for_function("() => document.querySelector('#collage .gtile img')?.naturalWidth > 0")
            state["empty"] = True
            page.wait_for_function("() => !!document.querySelector('#collage .nest-img')", timeout=40000)
            assert state["recent_requests"] >= 2
        finally:
            browser.close()


def test_four_mb_overlay_and_layout_match_healthy_capture(shooter, station, tmp_path, monkeypatch):
    url, _started, state, _bird = station
    state.update(many=True, release_after=0)
    capture_overlay = shooter.capture_text_overlay
    launch = pw.BrowserType.launch
    results = []

    def record(page, *args):
        layout = page.evaluate(shooter.CAPTURE_LAYOUT)
        overlay = capture_overlay(page, *args)
        saved = tmp_path / f"overlay-{len(results)}.png"
        overlay.save(saved)
        saved.with_suffix(".json").write_text(json.dumps(layout, indent=2))
        results.append((layout, saved))
        return overlay

    monkeypatch.setattr(shooter, "capture_text_overlay", record)
    for constrained in (False, True):
        if constrained:
            monkeypatch.setattr(pw.BrowserType, "launch", lambda self, **kw: launch(
                self, **{**kw, "args": kw.get("args", []) + ["--force-gpu-mem-available-mb=4"]}))
        shooter.shoot(url, str(tmp_path / f"{constrained}.png"), bird_names=True, timeout_ms=15000)
    def rendered_layout(layout):
        # Object identities and lpN IDs are local to one page/render. Compare
        # exact source, geometry, styles, paths and text across separate pages.
        ids = {}

        def path_id(match):
            key = match[2]
            if key not in ids:
                ids[key] = f"label-path-{len(ids)}"
            return match[1] + ids[key] + '"'

        return {
            "images": [{key: value for key, value in item.items() if key != "id"}
                       for item in layout["images"]],
            "labels": [{**item, "html": re.sub(r'\b(id="|href="#)(lp\d+)"', path_id, item["html"])}
                       for item in layout["labels"]],
        }

    assert rendered_layout(results[0][0]) == rendered_layout(results[1][0])
    with Image.open(results[0][1]) as healthy, Image.open(results[1][1]) as constrained:
        assert healthy.size == constrained.size
        assert healthy.tobytes() == constrained.tobytes()


def test_composition_releases_browser_and_driver_first(shooter, station, tmp_path, monkeypatch):
    url, _started, state, _bird = station
    state.update(release_after=0)
    compose = shooter.capture_art.compose_capture
    playwright = shooter.sync_playwright
    released = False
    composed = False

    class Lifecycle:
        def __enter__(self):
            self.context = playwright()
            return self.context.__enter__()

        def __exit__(self, *args):
            nonlocal released
            result = self.context.__exit__(*args)
            released = True
            return result

    def check(*args):
        nonlocal composed
        assert released, "full-frame composition must not overlap the browser/driver memory"
        composed = True
        return compose(*args)

    monkeypatch.setattr(shooter, "sync_playwright", Lifecycle)
    monkeypatch.setattr(shooter.capture_art, "compose_capture", check)
    shooter.shoot(url, str(tmp_path / "shot.png"), timeout_ms=10000)
    assert composed


def test_browser_does_not_paint_bitmap_art(shooter, station, tmp_path, monkeypatch):
    url, _started, state, _bird = station
    state.update(release_after=0)
    wait = pw.Page.wait_for_function
    checked = False

    def ready(page, expression, **kwargs):
        nonlocal checked
        result = wait(page, expression, **kwargs)
        if expression == shooter.FRAME_READY:
            checked = True
            images = page.evaluate("""() => [...document.querySelectorAll('#collage img')].map(i => ({
              visibility: getComputedStyle(i).visibility, width: i.naturalWidth
            }))""")
            assert images and all(i["visibility"] == "hidden" and i["width"] > 0 for i in images)
        return result

    monkeypatch.setattr(pw.Page, "wait_for_function", ready)
    output = tmp_path / "shot.png"
    shooter.shoot(url, str(output), timeout_ms=10000)
    assert checked and output.exists()


def test_repeated_four_mb_captures_keep_complete_identical_output(shooter, station, tmp_path, monkeypatch):
    url, _started, state, _bird = station
    state.update(many=True, release_after=0)
    launch = pw.BrowserType.launch
    monkeypatch.setattr(pw.BrowserType, "launch", lambda self, **kw: launch(
        self, **{**kw, "args": kw.get("args", []) + ["--force-gpu-mem-available-mb=4"]}))
    previous = None
    for attempt in range(4):
        output = tmp_path / f"shot-{attempt}.png"
        shooter.shoot(url, str(output), bird_names=True, timeout_ms=15000)
        current = output.read_bytes()
        if previous is not None:
            assert current == previous
        previous = current


def test_continually_changing_layout_obeys_capture_timeout(shooter, station, tmp_path, monkeypatch):
    url, _started, state, _bird = station
    state.update(release_after=0)
    output = tmp_path / "shot.png"
    output.write_bytes(b"last good")
    wait = pw.Page.wait_for_function
    entered = False

    def start_changing(page, expression, **kwargs):
        nonlocal entered
        if expression == shooter.FRAME_STABLE:
            entered = True
            page.evaluate("""() => {
              let x = 0;
              setInterval(() => document.querySelector('#collage img').style.transform =
                `translateX(${++x % 2}px)`, 16);
            }""")
        return wait(page, expression, **kwargs)

    monkeypatch.setattr(pw.Page, "wait_for_function", start_changing)
    started = time.monotonic()
    with pytest.raises(pw.TimeoutError):
        shooter.shoot(url, str(output), timeout_ms=1000)
    assert entered and time.monotonic() - started < 10
    assert output.read_bytes() == b"last good"


@pytest.mark.parametrize("failure", ["malformed", "source", "layout", "screenshot"])
def test_capture_failure_does_not_advance_real_display_state(shooter, station, tmp_path, monkeypatch, failure):
    import sys
    url, _started, state, _bird = station
    state.update(malformed=failure == "malformed", release_after=0)
    spec = importlib.util.spec_from_file_location("capture_display_browser", ROOT / "frame/display.py")
    display = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(display)
    monkeypatch.setitem(sys.modules, "shoot", shooter)
    output = tmp_path / "shot.png"
    output.write_bytes(b"last good")
    output.chmod(0o640)
    before = output.stat()
    state_file = tmp_path / "state.json"
    state_file.write_text('{"signature":"last-good","last_refresh":123}')
    original = state_file.read_bytes()
    screenshot = pw.Page.screenshot

    def interrupt(page, **kwargs):
        if failure == "screenshot":
            raise RuntimeError("injected browser screenshot failure")
        result = screenshot(page, **kwargs)
        if failure in ("source", "layout"):
            page.evaluate("""kind => {
              const image = document.querySelector('#collage img');
              if (kind === 'source') image.src += '&changed=1';
              else image.style.transform = 'translateX(3px)';
            }""", failure)
        return result

    monkeypatch.setattr(pw.Page, "screenshot", interrupt)
    cfg = dict(display.DEFAULTS, shoot=True, base_url=url, cache=str(tmp_path), state=str(state_file), timeout=3)
    display.run(cfg, force=True, use_signature=False)
    assert state_file.read_bytes() == original
    assert output.read_bytes() == b"last good"
    after = output.stat()
    assert (after.st_mode, after.st_uid, after.st_gid) == (before.st_mode, before.st_uid, before.st_gid)
