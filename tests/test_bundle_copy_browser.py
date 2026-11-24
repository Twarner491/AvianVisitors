"""Copy commands through the shipped catalog and real browser clipboard."""
from copy import deepcopy
import json
import os
from pathlib import Path
from urllib.parse import urlsplit

import pytest

pw = pytest.importorskip("playwright.sync_api")
CATALOG = Path(__file__).resolve().parents[1] / "avian/frontend/assets/bundle-catalog"


@pytest.fixture(params=["reduce", "no-preference"])
def catalog_page(request):
    catalog = json.loads((CATALOG / "catalog/bundles-v1.json").read_text())
    community = {**catalog, "packs": []}
    original = next(pack for pack in catalog["packs"] if pack["id"] == "official-western-us-woodblock")
    for region, code in [("Germany", "DE"), ("Iberia", "ES")]:
        pack = deepcopy(original)
        pack.update(id="community-test-" + region.lower(), review="community", contributor="test",
                    coverage={"label": region, "group": "Europe", "region_codes": [code]})
        community["packs"].append(pack)

    def respond(route):
        path = urlsplit(route.request.url).path
        if path == "/api/bundles/catalog/discovery-v1.json":
            return route.fulfill(json=community)
        if path == "/catalog/bundles-v1.json":
            return route.fulfill(json=catalog)
        file = (CATALOG / path.removeprefix("/assets/bundle-catalog/")).resolve()
        if CATALOG in file.parents and file.is_file():
            return route.fulfill(path=file)
        return route.fulfill(status=404)

    with pw.sync_playwright() as playwright:
        options = {"executable_path": os.environ["FRAME_TEST_CHROMIUM"]} if os.getenv("FRAME_TEST_CHROMIUM") else {}
        browser = playwright.chromium.launch(**options)
        try:
            page = browser.new_page(permissions=["clipboard-read", "clipboard-write"], reduced_motion=request.param)
            page.route("**/*", respond)
            page.goto("https://catalog.test/assets/bundle-catalog/index.html")
            page.get_by_role("button", name="Japanese Woodblock Official", exact=True).click()
            panel = page.locator("#style-panel-japanese-woodblock")
            pw.expect(panel.locator(".bundle-region-check")).to_have_count(3)
            yield page, panel
        finally:
            browser.close()


@pytest.mark.parametrize("keyboard", [False, True])
def test_copy_selects_region_and_opens_command(catalog_page, keyboard):
    page, panel = catalog_page
    trigger = panel.locator(".bundle-command-trigger")
    if keyboard:
        trigger.press("Enter")
    else:
        trigger.click()
    pw.expect(panel.locator(".bundle-region-menu")).to_be_visible()
    choice = panel.get_by_role("checkbox", name="Germany", exact=True)
    if keyboard:
        choice.press("Space")
    else:
        choice.check()
    popup = panel.get_by_role("dialog", name="Install command")
    pw.expect(popup).to_be_visible()
    pw.expect(panel.locator(".bundle-region-menu")).to_be_hidden()
    pw.expect(popup.locator("code")).to_have_text("sudo avian-bundle use 'community-test-germany'")
    assert page.evaluate("navigator.clipboard.readText()") == "sudo avian-bundle use 'community-test-germany'"
    pw.expect(popup.get_by_role("button")).to_be_focused()
    page.keyboard.press("Escape")
    pw.expect(popup).to_be_hidden()
    pw.expect(trigger).to_be_focused()


def test_cancel_copy_does_not_copy_later_station_selection(catalog_page):
    page, panel = catalog_page
    page.evaluate("navigator.clipboard.writeText('unchanged')")
    trigger = panel.locator(".bundle-command-trigger")
    trigger.press("Enter")
    page.keyboard.press("Escape")
    pw.expect(trigger).to_be_focused()
    panel.locator(".bundle-use").click()
    panel.get_by_role("checkbox", name="Germany", exact=True).check()
    pw.expect(panel.locator(".bundle-region-menu")).to_be_visible()
    pw.expect(panel.get_by_role("dialog", name="Install command")).to_be_hidden()
    assert page.evaluate("navigator.clipboard.readText()") == "unchanged"


def test_copy_preserves_existing_region_order(catalog_page):
    page, panel = catalog_page
    panel.locator(".bundle-use").click()
    panel.get_by_role("checkbox", name="Iberia", exact=True).check()
    panel.get_by_role("checkbox", name="Germany", exact=True).check()
    panel.locator(".bundle-command-trigger").click()
    popup = panel.get_by_role("dialog", name="Install command")
    pw.expect(popup).to_be_visible()
    expected = "sudo avian-bundle use 'community-test-iberia' 'community-test-germany'"
    pw.expect(popup.locator("code")).to_have_text(expected)
    assert page.evaluate("navigator.clipboard.readText()") == expected
