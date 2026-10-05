import base64
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


class EducatorSecurityTests(unittest.TestCase):
    def read(self, path):
        return (ROOT / path).read_text(encoding="utf-8")

    def test_profile_and_store_authorities_are_fixed(self):
        profile = self.read("avian/api/educator-state.php")
        control = self.read("scripts/educators_control.sh")
        self.assertIn("/var/lib/avian-visitors/educators.state", profile)
        self.assertIn("v1\\t([01])\\t", profile)
        self.assertIn("root:caddy", control)
        self.assertIn("admin-auth.lock", control)
        self.assertIn("educators.lock", control)
        self.assertIn("AV_EDUCATOR_LOCK_FD=10", control)
        self.assertIn("read_profile", control)
        self.assertIn("Existing Educators state is unsafe or malformed", control)
        self.assertEqual(control.count('rm -f -- "$PROFILE_STATE"'), 1)
        import_rollback = control[
            control.index("rollback_restore()") : control.index("discard_restore_rollback()")
        ]
        self.assertIn('[ "$restore_mode" = restore-import ]', import_rollback)
        self.assertIn('[ "$PROFILE_ENABLED:$PROFILE_EPOCH" = 0:0 ]', import_rollback)

    def test_audio_proxy_is_bounded_and_session_revalidated(self):
        audio = self.read("avian/api/educator-audio.php")
        check = self.read("avian/api/educator-audio-check.php")
        self.assertIn("avian_consume_educator_audio_grant", audio)
        self.assertEqual(audio.count("educator-audio-0.lock"), 1)
        self.assertEqual(audio.count("educator-audio-1.lock"), 1)
        self.assertIn("tcp://127.0.0.1:8000", audio)
        self.assertIn("GET /stream HTTP/1.0", audio)
        self.assertIn("AVIAN_EDUCATOR_AUDIO_MAX_SECONDS = 1800", audio)
        self.assertIn("AVIAN_EDUCATOR_AUDIO_CHECK_SECONDS = 2", audio)
        self.assertIn("tcp://127.0.0.1:80", audio)
        self.assertIn("educator-audio-check.php", audio)
        self.assertIn("stream_set_timeout($socket, 1)", audio)
        self.assertIn("LOCK_EX | LOCK_NB", audio)
        self.assertIn("Cache-Control: private, no-store", audio)
        self.assertIn("Cross-Origin-Resource-Policy: same-origin", audio)
        self.assertNotIn("curl_", audio)
        self.assertNotIn("HTTP_PROXY", audio)
        self.assertIn("avian_admin_session_valid", check)
        self.assertIn("HTTP_X_AVIAN_EDUCATOR_EPOCH", check)
        self.assertIn("REMOTE_ADDR", check)
        self.assertIn("'127.0.0.1'", check)

    def test_caddy_keeps_public_stream_route_and_only_adds_reviewed_entrypoints(self):
        caddy = self.read("scripts/update_caddyfile.sh")
        stream = caddy[caddy.index("  @stream path") : caddy.index("  handle /By_Date/*")]
        self.assertIn("reverse_proxy @directLocal localhost:8000", stream)
        self.assertIn("$stream_guard", stream)
        self.assertNotIn("educator", stream.lower())
        allowlist = caddy[caddy.index("@unknownAvianApi") : caddy.index("handle @unknownAvianApi")]
        for endpoint in (
            "/avian/api/educators.php",
            "/avian/api/educator-audio.php",
            "/avian/api/educator-audio-check.php",
        ):
            self.assertIn(endpoint, allowlist)
        self.assertNotIn("/avian/api/educator-state.php", allowlist)
        self.assertNotIn("/avian/api/educator-store.php", allowlist)
        self.assertIn("icecast_recycle_check", caddy)
        self.assertIn("AVIAN_EDUCATORS_ENABLED", caddy)
        self.assertIn("finish_icecast_restore", caddy)
        self.assertIn("IPAddressDeny=any", caddy)
        self.assertIn("IPAddressAllow=127.0.0.0/8", caddy)
        self.assertIn("IPAddressAllow=::1/128", caddy)

    def test_install_update_clear_and_restore_lifecycle(self):
        installer = self.read("newinstaller.sh")
        birdnet = self.read("scripts/install_birdnet.sh")
        install = self.read("scripts/install_services.sh")
        reinstall = self.read("scripts/reinstall_services.sh")
        security = self.read("scripts/security_refresh.sh")
        clear = self.read("scripts/clear_all_data.sh")
        backup = self.read("scripts/backup_data.sh")
        control = self.read("scripts/educators_control.sh")
        self.assertIn("--educators", installer)
        self.assertIn('"${installer_args[@]}"', installer)
        self.assertIn("AVIAN_INSTALL_EDUCATORS=1", birdnet)
        self.assertIn("educators_control.sh avian-educators", install)
        self.assertIn("educator_lock=$auth_state_dir/educators.lock", install)
        self.assertIn('"0:$caddy_gid:660:1"', install)
        self.assertIn("avian-educators enable", install)
        self.assertNotIn("avian-educators status", install)
        self.assertIn("scripts/educators_control.sh", reinstall)
        self.assertIn("/usr/local/sbin/avian-educators", security)
        self.assertIn("avian-educators refresh-install", security)
        self.assertNotIn("avian-educators status", security)
        self.assertIn("exec sudo /usr/local/sbin/avian-educators clear-all", clear)
        self.assertIn("AVIAN_EDUCATOR_MAINTENANCE_FD", clear)
        self.assertNotIn("AVIAN_EDUCATOR_LOCK_FD", clear)
        self.assertIn("AV_EDUCATOR_LOCK_FD=10", control)
        self.assertIn("exec 9>&- 10>&- 11>&-", control)
        self.assertIn("MAINTENANCE_STATE=$AUTH_DIR/educators.maintenance", control)
        clear_transaction = control[
            control.index("clear_all_data()") : control.index("recover_restore_state()")
        ]
        self.assertLess(
            clear_transaction.index("write_maintenance_state clear"),
            clear_transaction.index("run_clear_phase core"),
        )
        restore_transaction = control[
            control.index("restore_staged_pair()") : control.index("run_clear_phase()")
        ]
        self.assertLess(
            restore_transaction.index('write_maintenance_state "$restore_mode"'),
            restore_transaction.index('mv -T -- "$extracted/By_Date"'),
        )
        self.assertIn("committed_mode=$restore_mode-committed", restore_transaction)
        self.assertIn("recover_restore_state", control)
        self.assertNotIn('sudo rm -rf -- "${RECS_DIR}"', clear)
        self.assertIn("avian-educators backup-snapshot", backup)
        self.assertIn("avian-educators restore-staged", backup)
        cleanup = backup[
            backup.index("cleanup_educator_pair()") : backup.index("services_stopped=0")
        ]
        self.assertIn(
            'sudo /usr/local/sbin/avian-educators discard-snapshot "$educator_pair"',
            re.sub(r"\\\n\s*", "", cleanup),
        )
        self.assertIn("cleanup_educator_pair || true", backup)
        self.assertIn("trap cleanup EXIT", backup)
        self.assertNotIn("source /etc/birdnet/birdnet.conf", backup)
        self.assertLess(
            birdnet.index("sudo install -o root -g root -m 0644"),
            birdnet.index("./install_services.sh"),
        )
        self.assertIn("timedatectl show --value --property=Timezone", birdnet)

        status_path = control[
            control.index('if [ "$action" = status ]') :
            control.index('# Updates only migrate an already-enabled profile')
        ]
        self.assertIn("inspect_profile_storage_readonly", status_path)
        self.assertNotIn("ensure_runtime_layout", status_path)
        self.assertNotIn("ensure_birds_generation", status_path)
        self.assertNotIn("run_store", status_path)

        refresh_path = control[
            control.index('if [ "$action" = refresh-install ]') :
            control.index('# Disable is also a no-op')
        ]
        self.assertLess(
            refresh_path.index('open_lock "$PROFILE_LOCK"'),
            refresh_path.index('if [ "$PROFILE_STATUS" = 2 ]'),
        )
        self.assertLess(
            refresh_path.index('if [ "$PROFILE_STATUS" = 2 ]'),
            refresh_path.index("resolve_store"),
        )

    @unittest.skipUnless(shutil.which("bash"), "Bash is unavailable")
    def test_shell_syntax(self):
        result = subprocess.run(
            [
                "bash",
                "-n",
                "newinstaller.sh",
                "scripts/educators_control.sh",
                "scripts/admin_control.sh",
                "scripts/update_caddyfile.sh",
                "scripts/install_birdnet.sh",
                "scripts/install_services.sh",
                "scripts/reinstall_services.sh",
                "scripts/security_refresh.sh",
                "scripts/clear_all_data.sh",
                "scripts/backup_data.sh",
                "tests/smoke_educators_control.sh",
                "tests/smoke_educator_backup_restore.sh",
                "tests/smoke_educators_pristine_lifecycle.sh",
                "tests/smoke_educator_audio.sh",
                "tests/smoke_caddy_generated_routes.sh",
            ],
            cwd=ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=30,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout)

    @unittest.skipUnless(shutil.which("php"), "PHP CLI is unavailable")
    def test_php_syntax(self):
        for path in (
            "avian/api/educator-state.php",
            "avian/api/educator-audio.php",
            "avian/api/educator-audio-check.php",
        ):
            with self.subTest(path=path):
                result = subprocess.run(
                    ["php", "-l", path],
                    cwd=ROOT,
                    text=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    timeout=10,
                    check=False,
                )
                self.assertEqual(result.returncode, 0, result.stdout)

    def run_endpoint(self, endpoint, server, environment, query=None):
        server64 = base64.b64encode(json.dumps(server).encode()).decode()
        query64 = base64.b64encode(json.dumps(query or {}).encode()).decode()
        path = json.dumps(str(ROOT / endpoint))
        code = (
            "register_shutdown_function(function(){fwrite(STDERR,'STATUS='"
            ".(string)http_response_code());});"
            f"$_SERVER=json_decode(base64_decode('{server64}'),true);"
            f"$_GET=json_decode(base64_decode('{query64}'),true);"
            f"require {path};"
        )
        return subprocess.run(
            ["php", "-r", code],
            cwd=ROOT,
            env=environment,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=10,
            check=False,
        )

    @unittest.skipUnless(shutil.which("php"), "PHP CLI is unavailable")
    def test_audio_request_gates_fail_before_any_socket(self):
        with tempfile.TemporaryDirectory(prefix="avian-educator-audio-") as temporary:
            state = pathlib.Path(temporary) / "educators.state"
            state.write_text("v1\t1\t7\n", encoding="utf-8")
            environment = os.environ.copy()
            environment.update(
                {
                    "AV_EDUCATOR_STATE_FILE": str(state),
                    "AV_EDUCATOR_STATE_TEST_METADATA": "1",
                    "AV_REQUIRE_AUTH": "1",
                }
            )
            direct = {
                "REQUEST_METHOD": "GET",
                "REMOTE_ADDR": "127.0.0.1",
                "HTTP_HOST": "localhost",
            }
            cases = (
                ({**direct, "REQUEST_METHOD": "HEAD"}, {}, "405"),
                ({**direct, "REQUEST_METHOD": "POST"}, {}, "405"),
                ({**direct, "HTTP_FORWARDED": "for=198.51.100.1"}, {}, "404"),
                ({**direct, "HTTP_RANGE": "bytes=0-1"}, {}, "416"),
                (direct, {}, "401"),
            )
            for server, query, status in cases:
                with self.subTest(server=server):
                    result = self.run_endpoint(
                        "avian/api/educator-audio.php", server, environment, query
                    )
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertIn("STATUS=" + status, result.stderr)

            auth_off = environment.copy()
            auth_off["AV_REQUIRE_AUTH"] = "0"
            result = self.run_endpoint(
                "avian/api/educator-audio.php", direct, auth_off
            )
            self.assertIn("STATUS=403", result.stderr)

            check_cases = (
                ({**direct, "REQUEST_METHOD": "POST"}, "405"),
                ({**direct, "REMOTE_ADDR": "192.168.1.20"}, "404"),
                (direct, "403"),
            )
            for server, status in check_cases:
                with self.subTest(check=server):
                    result = self.run_endpoint(
                        "avian/api/educator-audio-check.php", server, environment
                    )
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertIn("STATUS=" + status, result.stderr)


if __name__ == "__main__":
    unittest.main()
