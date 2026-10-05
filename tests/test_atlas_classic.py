import shutil
import subprocess
from pathlib import Path

import pytest


@pytest.mark.skipif(shutil.which("node") is None, reason="node is unavailable")
def test_classic_atlas_preference_and_renderer():
    smoke = Path(__file__).with_name("smoke_atlas_classic.mjs")
    subprocess.run(["node", str(smoke)], check=True)
