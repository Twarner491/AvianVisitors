"""Image lifetimes across real-DOM collage renders."""
import os
from pathlib import Path
import time

import pytest

pw = pytest.importorskip("playwright.sync_api")
ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def collage_page():
    source = (ROOT / "avian/frontend/apt.js").read_text()
    render = source[source.index("  function finishFrameRender("):
                    source.index("  // Staggered centre-out entrance:")]
    escape = source[source.index("  function escHtml("):]
    escape = escape[:escape.index("\n  }") + 4]
    state = {"fail": False, "requests": 0, "pending": []}
    with pw.sync_playwright() as playwright:
        options = {"executable_path": os.environ["FRAME_TEST_CHROMIUM"]} if os.environ.get("FRAME_TEST_CHROMIUM") else {}
        browser = playwright.chromium.launch(**options)
        try:
            page = browser.new_page()

            def image(route):
                state["requests"] += 1
                if state.get("hold"):
                    state["pending"].append(route)
                    return
                route.fulfill(status=503 if state["fail"] else 200,
                              content_type="image/svg+xml", headers={"Cache-Control": "no-store"},
                              body='unavailable' if state["fail"] else '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="black"/></svg>')

            page.route("http://collage.test/**", image)
            page.set_content('<div id="collage" style="position:relative;width:600px;height:800px"></div>')
            page.add_script_tag(content="""
                var collage = document.getElementById('collage');
                var collageRenderRevision = 0, collagePlaced = [], collageHovered = null;
                var bird = {sci: 'Corvus brachyrhynchos', com: 'American Crow', n: 2};
                var other = {sci: 'Turdus migratorius', com: 'American Robin', n: 1};
                var DATA = {recent: {species: [bird, other], frame_capture_id: 1}};
                var tablesReady = true, labelFontReady = true, collagePose = {};
                var DIMS = {'corvus-brachyrhynchos': [40, 40], 'turdus-migratorius': [40, 40]};
                var FLY_PROB = 0, COLLAGE_PAD = 1, currentHours = 24, imageRevision = 'original';
                var EMPTY_WINDOW_COPY = 'No birds heard';
                function labelsOn() { return false; }
                function loadMask() { return {}; }
                function slugify(sci) { return sci.toLowerCase().replaceAll(' ', '-'); }
                function tuning() { return {packingBudgetFrac: 0.3, minTileAreaFrac: 0.01, countExp: 0.4}; }
                function assignLabels() {}
                function maskPack(tiles) { return tiles.map((t, i) => ({...t, x: 30 + i * 200, y: 30})); }
                function collageImageSrc(sci) { return 'http://collage.test/' + slugify(sci) + '.svg?v=' + imageRevision; }
                function educatorScopeId() { return ''; }
                function windowLabel() { return 'today'; }
                function fmtN(n) { return String(n); }
            """ + escape + render)
            yield page, state
        finally:
            browser.close()


def render(page):
    page.evaluate("renderCollage(DATA.recent.species, false)")
    page.wait_for_function("[...document.querySelectorAll('.gtile > img')].every(img => img.complete && img.naturalWidth > 0)")


def test_refresh_reuses_loaded_images_and_updates_names(collage_page):
    page, _state = collage_page
    render(page)
    page.evaluate("window.originalImages = [...document.querySelectorAll('.gtile > img')]")
    for _ in range(5):
        render(page)
        assert page.evaluate("[...document.querySelectorAll('.gtile > img')].every((img, i) => img === originalImages[i])")
    page.evaluate("bird.com = 'Crow \" onerror=\"alert(1)'; bird.n = 7")
    render(page)
    assert page.locator(".gtile > img").first.get_attribute("alt") == 'Crow " onerror="alert(1)'
    assert page.locator(".gtile > img").first.get_attribute("onerror") is None
    assert "7 calls" in page.locator(".gtile").first.get_attribute("title")


def test_removed_birds_and_empty_window_do_not_retain_images(collage_page):
    page, _state = collage_page
    render(page)
    page.evaluate("window.originalImages = [...document.querySelectorAll('.gtile > img')]; DATA.recent.species = [other]")
    render(page)
    assert page.evaluate("document.querySelector('.gtile > img') === originalImages[1]")
    assert page.evaluate("!originalImages[0].isConnected")
    page.evaluate("DATA.recent.species = []; renderCollage(DATA.recent.species, false)")
    assert page.locator(".gtile").count() == 0
    assert page.evaluate("originalImages.every(img => !img.isConnected)")
    page.evaluate("DATA.recent.species = [other]")
    render(page)
    assert page.evaluate("document.querySelector('.gtile > img') !== originalImages[1]")


def test_changed_artwork_url_gets_a_new_image(collage_page):
    page, _state = collage_page
    render(page)
    page.evaluate("window.originalImage = document.querySelector('.gtile > img'); imageRevision = 'new-artwork'")
    render(page)
    assert page.evaluate("document.querySelector('.gtile > img') !== originalImage")
    assert page.locator(".gtile > img").first.get_attribute("src").endswith("?v=new-artwork")


def test_failed_image_retries_on_refresh(collage_page):
    page, state = collage_page
    state["fail"] = True
    page.evaluate("DATA.recent.species = [bird]; renderCollage(DATA.recent.species, false)")
    page.wait_for_function("document.querySelector('.gtile > img')?.complete")
    assert page.evaluate("document.querySelector('.gtile > img').naturalWidth") == 0
    page.evaluate("window.failedImage = document.querySelector('.gtile > img')")
    state["fail"] = False
    render(page)
    assert page.evaluate("document.querySelector('.gtile > img') !== failedImage")
    assert state["requests"] >= 2


def test_pending_image_survives_refresh(collage_page):
    page, state = collage_page
    state["hold"] = True
    page.evaluate("DATA.recent.species = [bird]; renderCollage(DATA.recent.species, false)")
    deadline = time.monotonic() + 5
    while not state["pending"] and time.monotonic() < deadline:
        page.wait_for_timeout(10)
    assert len(state["pending"]) == 1
    page.evaluate("window.pendingImage = document.querySelector('.gtile > img'); renderCollage(DATA.recent.species, false)")
    assert page.evaluate("document.querySelector('.gtile > img') === pendingImage")
    assert not page.evaluate("pendingImage.complete")
    assert len(state["pending"]) == 1
    state["pending"][0].fulfill(content_type="image/svg+xml",
                                body='<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"/>')
    page.wait_for_function("pendingImage.complete && pendingImage.naturalWidth > 0")
    assert page.evaluate("document.querySelector('.gtile > img') === pendingImage")
