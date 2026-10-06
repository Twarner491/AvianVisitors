"""Production privilege boundary smoke, only in a disposable test container."""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(os.geteuid() == 0 and Path("/.dockerenv").is_file()
                     and os.environ.get("AVIAN_SPECIES_RUNTIME_TEST") == "1",
                     "requires disposable root test container")
class BundleSpeciesRuntimeTest(unittest.TestCase):
    def test_installed_manager_uses_station_identity_and_caches_annual_model(self) -> None:
        temporary = Path(tempfile.mkdtemp(prefix="avian-species-runtime-"))
        temporary.chmod(0o755)
        station = temporary / "station"
        station.mkdir(mode=0o755)
        (station / "model").mkdir()
        for filename in ("BirdNET_GLOBAL_6K_V2.4_MData_Model_V2_FP16.tflite",
                         "BirdNET_GLOBAL_6K_V2.4_Model_FP16_Labels.txt"):
            shutil.copyfile(ROOT / "model" / filename, station / "model" / filename)
        (station / "scripts").mkdir()
        config = temporary / "birdnet.conf"
        config.write_text("LATITUDE=37.7\nLONGITUDE=-122.4\nSF_THRESH=0.03\nDATA_MODEL_VERSION=2\n")
        (station / "birdnet.conf").symlink_to(config)
        python = station / "birdnet" / "bin" / "python3"
        python.parent.mkdir(parents=True)
        identity = station / "identity.txt"
        diagnostic = station / "diagnostic.txt"
        python.write_text("#!/bin/sh\n/usr/bin/id -u > '" + str(identity) + "'\n"
                          "/bin/cat /proc/self/status >> '" + str(identity) + "'\n"
                          "exec " + sys.executable + " \"$@\" 2> '" + str(diagnostic) + "'\n")
        python.chmod(0o755)
        os.chown(station, 65534, 65534)
        for directory in (Path("/usr/share/avian-visitors/bundles"), Path("/var/lib/avian-visitors")):
            directory.mkdir(parents=True, exist_ok=True, mode=0o755)
        helper = Path("/usr/share/avian-visitors/bundles/bundle_species.py")
        shutil.copyfile(ROOT / "avian/scripts/bundle_species.py", helper)
        helper.chmod(0o644)
        manager = Path("/usr/local/sbin/avian-bundle-control")
        manager.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / "avian/scripts/bundle_manager.py", manager)
        manager.chmod(0o755)
        environment = {"PATH": "/usr/local/bin:/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1"}

        def run(*args):
            result = subprocess.run([sys.executable, str(manager), *args], env=environment,
                                    capture_output=True, text=True, timeout=60, check=False)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr
                             + (diagnostic.read_text() if diagnostic.exists() else ""))
            return json.loads(result.stdout)

        run("configure-station", "--user", "nobody", "--root", str(station), "--json")
        result = run("selection-basis", "--json")
        self.assertTrue(result["ok"])
        self.assertGreater(len(result["species"]), 200)
        self.assertIn("Corvus corax", result["species"])
        identity_text = identity.read_text()
        self.assertTrue(identity_text.startswith("65534\n"))
        self.assertIn("NoNewPrivs:\t1", identity_text)
        self.assertIn("CapEff:\t0000000000000000", identity_text)
        self.assertIn("CapBnd:\t0000000000000000", identity_text)
        stamp = identity.stat().st_mtime_ns
        self.assertEqual(run("selection-basis", "--json"), result)
        self.assertEqual(identity.stat().st_mtime_ns, stamp)
        self.assertEqual(set(result), {"ok", "schema_version", "species", "basis_sha256"})


if __name__ == "__main__":
    unittest.main()
