import pathlib
import shutil
import subprocess
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


class BirdWeatherArchitectureTests(unittest.TestCase):
    def read(self, path):
        return (ROOT / path).read_text(encoding="utf-8")

    def test_endpoint_is_admin_gated_and_token_reveal_requires_session_proof(self):
        source = self.read("avian/api/birdweather.php")
        self.assertIn("avian_require_admin();", source)
        self.assertIn("avian_require_json_action();", source)
        self.assertIn("avian_require_admin_proof();", source)
        self.assertIn("rawurlencode($token)", source)
        self.assertNotIn("'token' => $token", source)
        self.assertNotIn('"token" => $token', source)
        self.assertIn("CURLOPT_FOLLOWLOCATION => false", source)
        self.assertIn("CURLOPT_PROXY => ''", source)
        proof = source.index("avian_require_admin_proof();")
        reveal = source.index("$status['token']", proof)
        self.assertLess(proof, reveal)
        probe = source.index("$probeCheck = birdweather_validate_new_token")
        write = source.index("$write = birdweather_run_admin_control", probe)
        self.assertLess(probe, write)

    def test_posts_are_patch_based_and_errors_do_not_serialize_tokens(self):
        source = self.read("avian/api/birdweather.php")
        self.assertIn("if (array_key_exists('enabled', $body))", source)
        self.assertNotIn("enabled must be supplied", source)
        self.assertIn("$validation['new_token'] = null;", source)
        self.assertNotIn("'settings' => $next", source)
        self.assertNotIn("$next = $conf", source)
        restart = source.index("$restart = birdweather_run_admin_control")
        canonical = source.index("$response = birdweather_canonical_status", restart)
        respond = source.index("birdweather_response(200, $response)", canonical)
        self.assertLess(restart, canonical)
        self.assertLess(canonical, respond)

    def test_probe_requires_official_success_and_collection_shape(self):
        source = self.read("avian/api/birdweather.php")
        self.assertIn("$decoded['success'] !== true", source)
        self.assertIn("array_is_list($decoded[$collection])", source)
        self.assertIn("birdweather_http_get(string $url, string $collection)", source)

    def test_every_token_enforcement_layer_rejects_dot_segments(self):
        php = self.read("avian/api/birdweather.php")
        reporting = self.read("scripts/utils/reporting.py")
        root = self.read("scripts/admin_control.sh")
        self.assertIn("$token !== '.'", php)
        self.assertIn("$token !== '..'", php)
        self.assertIn("token not in {'.', '..'}", reporting)
        self.assertIn('[ "$value" != . ] && [ "$value" != .. ]', root)

    def test_installer_has_explicit_opt_in_defaults(self):
        source = self.read("scripts/install_config.sh")
        self.assertIn("BIRDWEATHER_ENABLED=0", source)
        self.assertIn("BIRDWEATHER_UPLOAD_AUDIO=0", source)

    def test_config_is_never_sourced_under_unconditional_xtrace(self):
        for path in (
            "scripts/install_config.sh",
            "scripts/install_birdnet.sh",
            "scripts/disk_check.sh",
            "scripts/custom_recording.sh",
        ):
            lines = self.read(path).splitlines()
            source_index = next(
                (i for i, line in enumerate(lines) if "source /etc/birdnet/birdnet.conf" in line),
                len(lines),
            )
            before = "\n".join(lines[:source_index])
            self.assertNotRegex(before, r"(?m)^\s*set\s+-x\b", path)

    def test_reporting_never_interpolates_request_errors(self):
        source = self.read("scripts/utils/reporting.py")
        self.assertNotIn("Cannot POST soundscape: %s", source)
        self.assertNotIn("Cannot POST detection: %s", source)
        self.assertNotIn("log.debug(payload)", source)
        self.assertIn("session.trust_env = False", source)
        self.assertIn("allow_redirects=False", source)

    def test_legacy_pages_never_render_or_edit_the_station_token(self):
        legacy = self.read("scripts/config.php")
        self.assertNotIn('name="birdweather_id"', legacy)
        self.assertNotIn('$_GET["birdweather_id"]', legacy)
        self.assertNotRegex(legacy, r"print\s*[(]\s*\$config\[['\"]BIRDWEATHER_ID")
        self.assertNotIn('BIRDWEATHER_ID=$birdweather_id', legacy)
        self.assertIn("For security, it is not shown here", legacy)
        self.assertIn("Full-recording audio is a separate opt-in", legacy)
        self.assertNotIn("consenting to sharing your soundscapes and detections", legacy)

    def test_legacy_privacy_copy_does_not_promise_audio_redaction(self):
        advanced = self.read("scripts/advanced.php")
        self.assertNotIn("no data will be collected", advanced)
        self.assertIn("adjacent windows are suppressed locally", advanced)
        self.assertIn("does not redact the source recording", advanced)
        self.assertIn("may still contain speech", advanced)

    @unittest.skipUnless(shutil.which("php"), "PHP CLI is unavailable")
    def test_php_runtime_contract(self):
        result = subprocess.run(
            ["php", "tests/test_birdweather_api.php"],
            cwd=ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=30,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertRegex(result.stdout, r"birdweather api tests passed [(][0-9]+ checks[)]")


if __name__ == "__main__":
    unittest.main()
