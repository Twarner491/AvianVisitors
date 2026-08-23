import shutil
import subprocess
from pathlib import Path

import pytest


@pytest.mark.skipif(shutil.which("node") is None, reason="node is unavailable")
def test_reviewed_stamp_issue_assignments():
    smoke = Path(__file__).with_name("smoke_stamp_issues.sh")
    subprocess.run([str(smoke)], check=True)
