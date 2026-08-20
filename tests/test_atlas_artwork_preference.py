"""Regression checks for the per-device Atlas artwork preference."""

from pathlib import Path
import unittest


FRONTEND = Path(__file__).parents[1] / "avian" / "frontend" / "apt.js"
STAMPS_CSS = Path(__file__).parents[1] / "avian" / "frontend" / "stamps.css"
INDEX = Path(__file__).parents[1] / "avian" / "frontend" / "index.html"


class AtlasArtworkPreferenceTest(unittest.TestCase):
    def test_setting_defaults_to_stamps_and_renders_cutout_cards(self):
        source = FRONTEND.read_text()

        self.assertIn("var ATLAS_ARTWORK_STORAGE_KEY = 'bird:atlasArtwork:v1';", source)
        self.assertIn("function atlasArtworkPreference()", source)
        self.assertIn("var atlasArtworkEl = document.getElementById('atlasArtwork');", source)
        self.assertIn("var atlasArtworkBtns", source)
        self.assertIn('data-atlas-artwork="cutouts"', INDEX.read_text())
        self.assertIn("saved === 'birds'", source)
        self.assertIn("writeLS(ATLAS_ARTWORK_STORAGE_KEY, 'cutouts');", source)
        self.assertIn("var artworkMode = atlasArtworkPreference();", source)
        self.assertIn("artworkMode === 'cutouts'", source)
        self.assertIn("atlas-image-card", source)
        self.assertIn("grid.dataset.artwork = artworkMode;", source)
        self.assertIn("avian/assets/illustrations", source)
        self.assertIn('.atlas-grid[data-artwork="cutouts"]', STAMPS_CSS.read_text())
        shell = INDEX.read_text()
        self.assertIn('./styles.css?v=r168', shell)
        self.assertIn('./stamps.css?v=r358', shell)
        self.assertIn('./apt.js?v=r183', shell)
        self.assertIn('class="atlas-sort atlas-artwork-toggle" id="atlasArtwork"', shell)
        self.assertNotIn('id="menuPublic"', shell)
        self.assertNotIn("function renderPublicMenu()", source)
        self.assertNotIn("function atlasArtworkRow()", source)
        self.assertLess(shell.index('id="atlasArtwork"'), shell.index('id="atlasSort"'))
