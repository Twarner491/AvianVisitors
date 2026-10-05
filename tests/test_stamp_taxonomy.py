import shutil
import subprocess
from pathlib import Path

import pytest


@pytest.mark.skipif(shutil.which("node") is None, reason="node is unavailable")
def test_stamp_taxonomy():
    script = Path(__file__).with_name("stamp_taxonomy.test.js")
    subprocess.run(["node", "--test", str(script)], check=True)
