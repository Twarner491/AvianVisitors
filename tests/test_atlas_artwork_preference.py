"""Regression coverage for Atlas artwork and time-window preferences."""

import shutil
import subprocess
from pathlib import Path
import unittest


class AtlasArtworkPreferenceTest(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "node is unavailable")
    def test_artwork_and_full_list_preferences_are_independent(self):
        smoke = Path(__file__).with_name("smoke_atlas_preferences.mjs")
        subprocess.run(["node", str(smoke)], check=True)
