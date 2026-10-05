import shutil
import subprocess
import unittest
from pathlib import Path


@unittest.skipUnless(shutil.which("bash"), "bash is unavailable")
class InstallRegressionTests(unittest.TestCase):
    def test_install_and_recording_regressions(self):
        smoke = Path(__file__).with_name("smoke_install_regressions.sh")
        subprocess.run(["bash", str(smoke)], check=True)
