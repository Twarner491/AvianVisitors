"""Postcard corrections exercise the shipped page, not extracted handlers."""
import os
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest

pw = pytest.importorskip("playwright.sync_api")
FRONTEND = Path(__file__).resolve().parents[1] / "avian/frontend"


@pytest.fixture
def station_page():
    state = {"locked": False, "actionable": True, "fail": False, "stale": False, "present": True, "posts": []}
    sci = "Corvus corax"
    bird = {"sci": sci, "com": "Common Raven", "n": 1, "first_seen": "2026-10-22 12:00:00",
            "last_seen": "2026-10-22 12:00:00", "best_conf": 0.9}
    detection = {"detection_id": 7, "d": "2026-10-22", "t": "12:00:00", "file": "raven.mp3",
                 "conf": 0.9, "correction_key": "b" * 64}

    def respond(route):
        url = urlsplit(route.request.url)
        if url.path == "/avian/api/menu.php":
            return route.fulfill(status=401 if state["locked"] else 200, json={"items": [], "auth": {}})
        if url.path == "/avian/api/mark-incorrect.php":
            state["posts"].append(route.request.post_data_json)
            if state["stale"]:
                state["stale"] = False
                detection["correction_key"] = "c" * 64
                return route.fulfill(status=409, json={"error": "Reload the recordings."})
            if state["fail"]:
                return route.fulfill(status=503, json={"error": "Reload and try again."})
            state["present"] = False
            return route.fulfill(json={"ok": True})
        if url.path == "/avian/api/birdnet-api.php":
            action = parse_qs(url.query)["action"][0]
            data = {"species": [bird] if state["present"] else []}
            if state.get("other"):
                data["species"].append({**bird, "sci": "Corvus brachyrhynchos", "com": "American Crow"})
            if action == "species":
                row = dict(detection)
                if not state["actionable"]:
                    row.pop("correction_key")
                data.update(summary={"com": bird["com"], "total": int(state["present"])},
                            detections=[row] if state["present"] else [])
            return route.fulfill(json=data)
        if url.path.startswith("/avian/api/"):
            return route.fulfill(status=404, json={})
        file = FRONTEND / (url.path.strip("/") or "index.html")
        if file.is_file() and FRONTEND in file.resolve().parents:
            return route.fulfill(path=file)
        return route.fulfill(status=404)

    with pw.sync_playwright() as playwright:
        opts = {"executable_path": os.environ["FRAME_TEST_CHROMIUM"]} if os.getenv("FRAME_TEST_CHROMIUM") else {}
        browser = playwright.chromium.launch(**opts)
        try:
            page = browser.new_page(reduced_motion="reduce")
            page.route("**/*", respond)
            yield page, state
        finally:
            browser.close()


def open_recording(page):
    page.goto("http://station.test/#sci=Corvus%20corax")
    page.locator(".postcard-recordings > summary").click()
    page.locator(".rec-row-toggle").click()


def test_confirm_cancel_error_and_success(station_page):
    page, state = station_page
    open_recording(page)
    button = page.get_by_role("button", name="Mark incorrect")
    pw.expect(button).to_be_visible(timeout=2000)
    page.once("dialog", lambda dialog: dialog.dismiss())
    button.press("Enter")
    assert state["posts"] == []
    state["fail"] = True
    page.once("dialog", lambda dialog: dialog.accept())
    button.press("Enter")
    pw.expect(page.locator("#modalRecordings")).to_contain_text("12")
    pw.expect(page.get_by_role("status").filter(has_text="Reload and try again")).to_be_visible()
    pw.expect(button).to_be_focused(timeout=500)
    state["fail"] = False
    page.once("dialog", lambda dialog: dialog.accept())
    button.press("Enter")
    pw.expect(page.locator("#modalRecCount")).to_have_text("0 recordings")
    pw.expect(page.locator("#modalAllTime")).to_have_text("0")
    pw.expect(page.locator(".postcard-recordings > summary")).to_be_focused()
    assert state["posts"] == [{"id": 7, "key": "b" * 64}] * 2
    pw.expect(page.locator(".bird-card[data-sci='Corvus corax']")).to_have_count(0)


@pytest.mark.parametrize("locked,actionable", [(True, True), (False, False)])
def test_unavailable_correction_is_not_offered(station_page, locked, actionable):
    page, state = station_page
    state.update(locked=locked, actionable=actionable)
    open_recording(page)
    pw.expect(page.get_by_role("button", name="Mark incorrect")).to_have_count(0)


def test_stale_selection_refreshes_before_retry(station_page):
    page, state = station_page
    state["stale"] = True
    open_recording(page)
    button = page.get_by_role("button", name="Mark incorrect")
    page.once("dialog", lambda dialog: dialog.accept())
    button.press("Enter")
    pw.expect(page.locator(".rec-row-toggle")).to_have_attribute("aria-expanded", "false", timeout=1500)
    page.locator(".rec-row-toggle").click()
    page.once("dialog", lambda dialog: dialog.accept())
    button.press("Enter")
    pw.expect(page.locator("#modalRecCount")).to_have_text("0 recordings")
    assert [selection["key"] for selection in state["posts"]] == ["b" * 64, "c" * 64]


@pytest.mark.parametrize("stale", [False, True])
@pytest.mark.parametrize("recordings_open", [False, True])
def test_late_correction_refreshes_the_current_postcard(station_page, stale, recordings_open):
    page, state = station_page
    state["other"] = True
    page.add_init_script("localStorage.setItem('bird:atlasStyle:v1', 'classic')")
    held = {}
    crow = {"summary": {"com": "American Crow", "total": 1}, "detections": [
        {"detection_id": 8, "d": "2026-10-22", "t": "12:01:00", "file": "crow.mp3", "conf": 0.9}]}

    def other_species(route):
        query = parse_qs(urlsplit(route.request.url).query)
        if query.get("action") != ["species"] or query.get("sci") != ["Corvus brachyrhynchos"]:
            return route.fallback()
        if "species" not in held:
            held["species"] = route
            return
        return route.fulfill(json=crow)

    page.route("**/mark-incorrect.php", lambda route: held.update(correction=route))
    page.route("**/birdnet-api.php?*", other_species)
    open_recording(page)
    page.once("dialog", lambda dialog: dialog.accept())
    with page.expect_request("**/mark-incorrect.php"):
        page.get_by_role("button", name="Mark incorrect").click()
    page.keyboard.press("Escape")
    pw.expect(page.locator("#postcard-modal")).to_have_attribute("aria-hidden", "true")
    with page.expect_request(lambda request: "sci=Corvus%20brachyrhynchos" in request.url):
        page.locator('.classic-atlas-card[data-sci="Corvus brachyrhynchos"] h3').click()
    pw.expect(page.locator("#modalSci")).to_have_text("Corvus brachyrhynchos")
    panel = page.locator(".postcard-recordings")
    if recordings_open:
        panel.locator("summary").click()
    with page.expect_request(lambda request: parse_qs(urlsplit(request.url).query).get("action") == ["lifelist"], timeout=2000):
        held["correction"].fulfill(status=409 if stale else 200,
                                   json={"error": "Reload recordings."} if stale else {"ok": True})
    held["species"].fulfill(json=crow)
    pw.expect(page.locator("#modalRecCount")).to_have_text("1 recording")
    pw.expect(page.locator("#modalSci")).to_have_text("Corvus brachyrhynchos")
    pw.expect(page.locator("#modalRecordings")).not_to_contain_text("Failed to load")
    assert panel.evaluate("node => node.open") is recordings_open
    if recordings_open:
        pw.expect(panel.locator("summary")).to_be_focused()
    else:
        pw.expect(panel.locator("summary")).not_to_be_focused()
