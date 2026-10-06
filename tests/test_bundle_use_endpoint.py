"""Exercise the use endpoint with a controlled manager and authenticated caller."""
import json
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class BundleUseEndpoint(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="avian-use-api-")
        self.directory = Path(self.temp.name)
        shutil.copy2(ROOT / "avian/api/bundles.php", self.directory / "bundles.php")
        if (ROOT / "avian/api/bundle-species.php").exists():
            shutil.copy2(ROOT / "avian/api/bundle-species.php", self.directory / "bundle-species.php")
        (self.directory / "admin-auth.php").write_text(
            "<?php function avian_require_admin() {} function avian_require_json_action() {} "
            "function avian_is_direct_local_request($server) { return true; }"
        )
        (self.directory / "bundle-runtime.php").write_text("""<?php
const AVIAN_BUNDLE_INCLUDED_ID = 'official-western-us-woodblock';
function avian_bundle_id_valid($id) { return preg_match('/^[a-z0-9][a-z0-9._-]{0,79}$/D', $id) === 1; }
function avian_bundle_version_valid($v) { return $v === '1.0.0'; }
function avian_bundle_run_manager($args, $timeout) {
  if ($args[0] === 'selection-basis') return ['ok'=>true, 'result'=>[
    'ok'=>true, 'schema_version'=>1, 'species'=>['Corvus corax'], 'basis_sha256'=>str_repeat('b',64)]];
  if ($args[0] === 'snapshot') return ['ok'=>true, 'result'=>[
    'ok'=>true, 'catalog'=>['packs'=>[['id'=>'test-pack', 'version'=>'1.0.0',
    'included'=>false, 'installed'=>true, 'activation_version'=>'1.0.0',
    'installed_versions'=>['1.0.0'], 'availability'=>'installable']]],
    'library'=>['active'=>['id'=>'test-pack','version'=>'1.0.0']]]];
  file_put_contents(__DIR__.'/argv.json', json_encode($args));
  return ['ok'=>true,'result'=>['ok'=>true,'job'=>['id'=>'job-1','state'=>'running']]];
}
""")
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        self.url = f"http://127.0.0.1:{port}/bundles.php"
        self.server = subprocess.Popen(
            ["php", "-S", f"127.0.0.1:{port}", "-t", str(self.directory)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        for _ in range(50):
            try:
                urllib.request.urlopen(self.url + "?action=snapshot", timeout=1).close()
                break
            except OSError:
                time.sleep(.02)

    def tearDown(self):
        self.server.terminate()
        self.server.wait(timeout=3)
        self.temp.cleanup()

    def post(self, payload):
        request = urllib.request.Request(self.url, data=json.dumps(payload).encode(),
                                        headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=3) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, json.load(error)

    def test_already_active_bundle_rechecks_location_in_manager(self):
        status, body = self.post({"action": "use", "id": "test-pack"})
        self.assertEqual(status, 202)
        self.assertTrue(body["accepted"])
        self.assertEqual(json.loads((self.directory / "argv.json").read_text()),
                         ["enqueue", "--action", "use", "--id", "test-pack", "--json"])

    def test_empty_query_returns_snapshot(self):
        with urllib.request.urlopen(self.url, timeout=3) as response:
            self.assertTrue(json.load(response)['ok'])

    def test_browser_cannot_supply_location_or_download_authority(self):
        for field, value in [("latitude", 37), ("species", ["Corvus corax"]),
                             ("url", "https://example.com/pack.json")]:
            with self.subTest(field=field):
                self.assertEqual(self.post({"action": "use", "id": "test-pack", field: value})[0], 400)
        self.assertFalse((self.directory / "argv.json").exists())

    def test_mirror_get_receives_names_but_cross_site_requests_are_rejected(self):
        url = self.url.replace('bundles.php', 'bundle-species.php')
        with urllib.request.urlopen(url, timeout=3) as response:
            self.assertEqual(json.load(response), {
                'ok': True, 'schema_version': 1, 'species': ['Corvus corax'], 'basis_sha256': 'b' * 64,
            })
        for headers in [{'Sec-Fetch-Site': 'cross-site'}, {'Origin': 'https://example.com'}]:
            with self.subTest(headers=headers), self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=3)
            self.assertEqual(error.exception.code, 403)


if __name__ == "__main__":
    unittest.main()
