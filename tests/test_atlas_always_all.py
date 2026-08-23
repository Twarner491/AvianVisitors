import shutil
import subprocess
from pathlib import Path

import pytest


@pytest.mark.skipif(shutil.which("node") is None, reason="node is unavailable")
def test_atlas_always_all_preference_is_independent():
    smoke = Path(__file__).with_name("smoke_atlas_always_all.mjs")
    subprocess.run(["node", str(smoke)], check=True)
