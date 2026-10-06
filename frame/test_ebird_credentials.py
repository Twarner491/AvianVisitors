from __future__ import annotations

import io
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import birdweather


class EbirdCredentialTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="avian-ebird-credential-")
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name)
        self.directory = self.home / ".birdframe"
        self.directory.mkdir(mode=0o700)
        self.credential = self.directory / "ebird-api-key"
        self.environment = mock.patch.dict(os.environ, {"HOME": str(self.home)}, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def _write_key(self, raw=b"PrivateTestKey123\n"):
        self.credential.write_bytes(raw)
        self.credential.chmod(0o600)

    def _observations(self, expected_key):
        def response(request, timeout):
            if request.get_header("X-ebirdapitoken") != expected_key:
                raise AssertionError("eBird request did not use the configured credential")
            return io.BytesIO(b'[{"sciName":"Corvus corax","comName":"Common Raven","howMany":5}]')
        return response

    def test_private_file_supplies_key_after_environment_reset(self):
        self._write_key()
        with mock.patch.object(birdweather.urllib.request, "urlopen", side_effect=self._observations("PrivateTestKey123")):
            rows = birdweather.ebird_nearby(37, -122)
        self.assertEqual(rows, [{"sci": "Corvus corax", "com": "Common Raven", "n": 5}])

    def test_service_environment_remains_compatible(self):
        os.environ["EBIRD_API_KEY"] = "ServiceTestKey456"
        with mock.patch.object(birdweather.urllib.request, "urlopen", side_effect=self._observations("ServiceTestKey456")):
            self.assertEqual(len(birdweather.ebird_nearby(37, -122)), 1)

    def test_private_file_accepts_a_token_without_final_newline(self):
        self._write_key(b"PrivateTestKey123")
        with mock.patch.object(birdweather.urllib.request, "urlopen", side_effect=self._observations("PrivateTestKey123")):
            self.assertEqual(len(birdweather.ebird_nearby(37, -122)), 1)

    def test_missing_private_key_is_keyless(self):
        self.assertEqual(birdweather.ebird_nearby(37, -122), [])

    def test_private_key_rejects_malformed_or_oversized_bytes(self):
        for raw in (b"", b"bad key\n", b"Key\nSecond\n", b"Key\x00", b"Key\r\n", b"A" * 4097):
            with self.subTest(raw_length=len(raw)):
                self._write_key(raw)
                with self.assertRaises(birdweather.BirdWeatherError):
                    birdweather.ebird_nearby(37, -122)

    def test_private_key_rejects_symlinks_hardlinks_and_unsafe_mode(self):
        self._write_key()
        target = self.home / "target"
        self.credential.rename(target)
        self.credential.symlink_to(target)
        with self.assertRaises(birdweather.BirdWeatherError):
            birdweather.ebird_nearby(37, -122)
        self.credential.unlink()
        os.link(target, self.credential)
        with self.assertRaises(birdweather.BirdWeatherError):
            birdweather.ebird_nearby(37, -122)
        self.credential.unlink()
        target.rename(self.credential)
        self.credential.chmod(0o644)
        with self.assertRaises(birdweather.BirdWeatherError):
            birdweather.ebird_nearby(37, -122)

    def test_private_key_rejects_unsafe_parent(self):
        self._write_key()
        self.directory.chmod(0o777)
        with self.assertRaises(birdweather.BirdWeatherError):
            birdweather.ebird_nearby(37, -122)

    def test_private_key_rejects_fifo_without_waiting_for_a_writer(self):
        os.mkfifo(self.credential, 0o600)
        completed = subprocess.run(
            [sys.executable, "-c", "import birdweather; birdweather.ebird_nearby(37, -122)"],
            cwd=Path(birdweather.__file__).parent,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
            capture_output=True, text=True, timeout=3,
        )
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("credential is unsafe", completed.stderr)

    @unittest.skipUnless(os.geteuid() == 0, "requires isolated root for real ownership changes")
    def test_private_key_rejects_wrong_owner(self):
        self._write_key()
        os.chown(self.credential, 65534, -1)
        with self.assertRaises(birdweather.BirdWeatherError):
            birdweather.ebird_nearby(37, -122)


if __name__ == "__main__":
    unittest.main()
