import pathlib
import shutil
import subprocess
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which("node"), "Node.js is unavailable")
class CommentFrontendTests(unittest.TestCase):
    def test_collage_data_readiness(self):
        subprocess.run(["node", "tests/smoke_collage_readiness.mjs"], cwd=ROOT, check=True)

    def test_settings_precision_and_collage_attributes(self):
        subprocess.run(["node", "tests/smoke_comment_frontend.mjs"], cwd=ROOT, check=True)
