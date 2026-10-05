import os
import pathlib
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
REDACTOR = ROOT / "scripts" / "redact_diagnostics.py"


class DiagnosticRedactionTests(unittest.TestCase):
    def redactor_result(self, mode, text, config=None):
        command = [sys.executable, str(REDACTOR), "--mode", mode]
        if config is not None:
            command.extend(["--config", str(config)])
        return subprocess.run(
            command,
            input=text,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=10,
        )

    def run_redactor(self, mode, text, config=None):
        result = self.redactor_result(mode, text, config)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def run_path_parser(self, config, home):
        return subprocess.run(
            [
                sys.executable,
                str(REDACTOR),
                "--mode",
                "path",
                "--config",
                str(config),
                "--key",
                "RECS_DIR",
                "--home",
                str(home),
            ],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=10,
        )

    def test_config_redacts_only_known_secret_assignments(self):
        source = (
            "SITE_NAME='ordinary station'\n"
            "BIRDWEATHER_ENABLED=1\n"
            "export BIRDWEATHER_ID=station-token-123 # station note\n"
            "GEMINI_API_KEY=\"gemini-secret-value\" # key note\n"
            "ICE_PWD=shortpass\n"
            "# BIRDWEATHER_ID=documentation-example\n"
        )
        output = self.run_redactor("config", source)
        self.assertIn("SITE_NAME='ordinary station'", output)
        self.assertIn("BIRDWEATHER_ENABLED=1", output)
        self.assertIn("export BIRDWEATHER_ID=[REDACTED]", output)
        self.assertIn("GEMINI_API_KEY=[REDACTED]", output)
        self.assertIn("ICE_PWD=[REDACTED]", output)
        self.assertIn("# BIRDWEATHER_ID=[REDACTED]", output)
        for secret in ("station-token-123", "gemini-secret-value", "shortpass", "documentation-example"):
            self.assertNotIn(secret, output)

    def test_journal_redacts_current_and_historical_secret_contexts(self):
        config = self._testMethodName + ".conf"
        config_path = ROOT / "tests" / config
        try:
            config_path.write_text(
                "BIRDWEATHER_ID=current-station-token\n"
                "GEMINI_API_KEY=gemini-current-secret\n"
                "ICE_PWD=shortpass\n",
                encoding="utf-8",
            )
            source = (
                "+ BIRDWEATHER_ID=old-station-token\n"
                "+ export GEMINI_API_KEY='old-gemini-token'\n"
                "POST https://app.birdweather.com/api/v1/stations/older-token/detections\n"
                "failed gemini-current-secret while retrying\n"
                "icecast://source:shortpass@localhost:8000/stream\n"
                "BIRDWEATHER_ENABLED=1 stays diagnostic\n"
                "ordinary token wording stays intact\n"
            )
            output = self.run_redactor("journal", source, config_path)
        finally:
            config_path.unlink(missing_ok=True)
        for secret in (
            "old-station-token",
            "old-gemini-token",
            "older-token",
            "gemini-current-secret",
            "shortpass",
        ):
            self.assertNotIn(secret, output)
        self.assertIn("BIRDWEATHER_ENABLED=1 stays diagnostic", output)
        self.assertIn("ordinary token wording stays intact", output)

    def test_secret_assignment_redaction_rejects_ambiguous_shell_syntax(self):
        sources = (
            'BIRDWEATHER_ID="unterminated-secret-token\n',
            "BIRDWEATHER_ID=$'charlie-ansi-token'\n",
            'BIRDWEATHER_ID=delta"-concat-token"\n',
            'BIRDWEATHER_ID="echo-quoted"-tail-token\n',
            "BIRDWEATHER_ID=foxtrot\\ tail-token\n",
            "BIRDWEATHER_ID=$(printf golf-secret-token)\n",
            "BIRDWEATHER_ID=alpha-secret-\\\ntail-token\n",
            'BIRDWEATHER_ID="bravo-secret-\ntail-token"\n',
            "readonly BIRDWEATHER_ID=romeo-secret-token\n",
            "typeset GEMINI_API_KEY=sierra-secret-token\n",
            "declare -x EBIRD_API_KEY=tango-secret-token\n",
            "export -n ICE_PWD=uniform-secret-token\n",
            "# readonly BIRDWEATHER_ID=old-secret-token\n",
            "# old BIRDWEATHER_ID=old-secret-token\n",
            "FOO=x; BIRDWEATHER_ID=command-secret-token\n",
            "SITE_NAME='BIRDWEATHER_ID=quoted-secret-token'\n",
        )
        for source in sources:
            with self.subTest(source=source):
                result = self.redactor_result("config", source)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, "")
                for fragment in ("secret", "token", "tail"):
                    self.assertNotIn(fragment, result.stdout)

    def test_journal_redaction_rejects_an_ambiguous_config_secret(self):
        with tempfile.TemporaryDirectory() as directory:
            config = pathlib.Path(directory) / "birdnet.conf"
            config.write_text(
                "GEMINI_API_KEY=$'charlie-ansi-token'\n", encoding="utf-8"
            )
            result = self.redactor_result(
                "journal", "request failed charlie-ansi-token\n", config
            )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertNotIn("charlie-ansi-token", result.stderr)

    def test_unit_environment_quotes_are_preserved_while_values_are_redacted(self):
        with tempfile.TemporaryDirectory() as directory:
            config = pathlib.Path(directory) / "birdnet.conf"
            config.write_text("BIRDWEATHER_ID=current-token-value\n", encoding="utf-8")
            output = self.run_redactor(
                "journal",
                '[Service]\nEnvironment="BIRDWEATHER_ID=unit-token-value"\n'
                'Environment="HTTP_AUTHORIZATION=Bearer unit-bearer-value"\n'
                "Environment=GEMINI_API_KEY=unit-gemini-value\n",
                config,
            )
        self.assertIn('Environment="BIRDWEATHER_ID=[REDACTED]"', output)
        self.assertIn('Environment="HTTP_AUTHORIZATION=[REDACTED]"', output)
        self.assertIn("Environment=GEMINI_API_KEY=[REDACTED]", output)
        self.assertNotIn("unit-token-value", output)
        self.assertNotIn("unit-bearer-value", output)
        self.assertNotIn("unit-gemini-value", output)

    def test_recordings_path_parser_expands_only_a_leading_home(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            home = root / "station home"
            home.mkdir()
            config = root / "birdnet.conf"
            config.write_text(
                "RECS_DIR=/discarded/earlier/path\n"
                'export RECS_DIR="$HOME/Bird Songs" # current path\n',
                encoding="utf-8",
            )
            result = self.run_path_parser(config, home)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, str(home / "Bird Songs"))

    def test_recordings_path_parser_never_evaluates_config_syntax(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            home = root / "home"
            home.mkdir()
            marker = root / "must-not-exist"
            config = root / "birdnet.conf"
            invalid_values = (
                f'"$(touch {marker})"',
                "$OTHER/BirdSongs",
                '"$HOME/../outside"',
                "/",
                "'${HOME}/literal'",
            )
            for value in invalid_values:
                with self.subTest(value=value):
                    config.write_text(f"RECS_DIR={value}\n", encoding="utf-8")
                    result = self.run_path_parser(config, home)
                    self.assertNotEqual(result.returncode, 0, result.stdout)
                    self.assertFalse(marker.exists())

    def test_dump_script_filters_both_sources_before_archive(self):
        source = (ROOT / "scripts" / "dump_logs.sh").read_text(encoding="utf-8")
        self.assertIn("--mode journal --config", source)
        self.assertIn('--mode config < "$config_file"', source)
        self.assertNotIn("sed -e '/PWD=/d'", source)
        self.assertNotIn('source "$config_file"', source)
        self.assertNotIn("source /etc/birdnet/birdnet.conf", source)

    def test_dump_uses_a_fresh_private_source_and_excludes_stale_logs(self):
        with tempfile.TemporaryDirectory() as directory:
            home = pathlib.Path(directory) / "home"
            repo = home / "BirdNET-Pi"
            scripts = repo / "scripts"
            recordings = repo / "recordings"
            stale = repo / "logs"
            tools = pathlib.Path(directory) / "bin"
            wants = pathlib.Path(directory) / "systemd" / "multi-user.target.wants"
            units = pathlib.Path(directory) / "systemd" / "units"
            for path in (scripts, recordings, stale, tools, wants, units):
                path.mkdir(parents=True, exist_ok=True)
            shutil.copy2(REDACTOR, scripts / REDACTOR.name)
            (scripts / "install_services.sh").write_text(
                "#!/bin/sh\nsystemctl enable diagnostic-fixture.service\n",
                encoding="utf-8",
            )
            current_token = "archive-current-station-token"
            stale_token = "stale-pre-redaction-token"
            unit_token = "service-unit-station-token"
            inherited_token = "inherited-birdweather-token"
            inherited_gemini = "inherited-gemini-token"
            inherited_refresh = "inherited-refresh-token"
            (repo / "birdnet.conf").write_text(
                f'export BIRDWEATHER_ID={current_token}\n'
                'GEMINI_API_KEY="archive-gemini-secret"\n'
                f'RECS_DIR="{recordings}"\n',
                encoding="utf-8",
            )
            (stale / "old-install.log").write_text(stale_token, encoding="utf-8")
            (stale / "birdnet.conf").write_text(
                f"BIRDWEATHER_ID={stale_token}\n", encoding="utf-8"
            )
            (repo / "installation-old.txt").write_text(stale_token, encoding="utf-8")
            old_archive = repo / "logs.tar.gz"
            old_archive.write_text(stale_token, encoding="utf-8")
            old_archive.chmod(0o644)
            unit = units / "diagnostic-fixture.service"
            unit.write_text(
                "[Service]\n"
                f'Environment="BIRDWEATHER_ID={unit_token}"\n'
                "Environment=GEMINI_API_KEY=unit-gemini-token\n"
                "ExecStart=/bin/echo "
                "https://app.birdweather.com/api/v1/stations/unit-url-token/detections\n",
                encoding="utf-8",
            )
            (wants / unit.name).symlink_to(unit)
            for name in ("aplay", "script"):
                stub = tools / name
                stub.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
                stub.chmod(0o755)
            for name in ("free",):
                stub = tools / name
                stub.write_text(f"#!/bin/sh\necho {name}-fixture\n", encoding="utf-8")
                stub.chmod(0o755)
            (tools / "ifconfig").write_text("#!/bin/sh\nenv\n", encoding="utf-8")
            (tools / "ifconfig").chmod(0o755)
            (tools / "journalctl").write_text(
                "#!/bin/sh\n"
                "env\n"
                "echo '+ BIRDWEATHER_ID=historical-journal-token'\n",
                encoding="utf-8",
            )
            (tools / "journalctl").chmod(0o755)

            result = subprocess.run(
                ["bash", str(ROOT / "scripts" / "dump_logs.sh")],
                cwd=repo,
                env={
                    **os.environ,
                    "HOME": str(home),
                    "PATH": f"{tools}:{os.environ['PATH']}",
                    "AVIAN_DIAGNOSTIC_SYSTEMD_WANTS_DIR": str(wants),
                    "BIRDWEATHER_ID": inherited_token,
                    "GEMINI_API_KEY": inherited_gemini,
                    "AVIAN_DISK_REFRESH_TOKEN": inherited_refresh,
                },
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
                timeout=30,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            archive = repo / "logs.tar.gz"
            self.assertTrue(archive.is_file())
            self.assertEqual(archive.stat().st_mode & 0o777, 0o600)
            with tarfile.open(archive, "r:gz") as bundle:
                names = bundle.getnames()
                contents = b"".join(
                    bundle.extractfile(member).read()
                    for member in bundle.getmembers()
                    if member.isfile()
                ).decode("utf-8", errors="replace")
            self.assertNotIn("old-install.log", "\n".join(names))
            for secret in (
                current_token,
                stale_token,
                unit_token,
                "unit-gemini-token",
                "unit-url-token",
                "historical-journal-token",
                inherited_token,
                inherited_gemini,
                inherited_refresh,
            ):
                self.assertNotIn(secret, contents)
            self.assertIn("BIRDWEATHER_ID=[REDACTED]", contents)
            self.assertIn('Environment="BIRDWEATHER_ID=[REDACTED]"', contents)
            self.assertIn("Environment=GEMINI_API_KEY=[REDACTED]", contents)
            self.assertIn("diagnostic-fixture.service", "\n".join(names))
            self.assertTrue((stale / "old-install.log").is_file(), "ambiguous old directory is untouched")
            self.assertTrue((stale / "birdnet.conf").is_file(), "migration owns old residue cleanup")
            self.assertFalse(any(repo.glob(".avian-logs.*")), "private staging directory is cleaned")

    def test_obsolete_firstrun_copy_is_not_created_and_is_safely_removed(self):
        installer = (ROOT / "scripts" / "install_config.sh").read_text(encoding="utf-8")
        self.assertNotIn("firstrun.ini", installer)
        security = (ROOT / "scripts" / "security_refresh.sh").read_text(encoding="utf-8")
        self.assertIn('legacy_firstrun=$legacy_state_dir/firstrun.ini', security)
        self.assertIn('remove_legacy_firstrun "$legacy_firstrun"', security)
        self.assertIn('remove_exact_legacy_file "$legacy_log_archive"', security)
        self.assertIn("legacy_log_config=$legacy_log_fd_path/birdnet.conf", security)
        broad = security.index('chmod -R u+rwX,g+rX,o-w "$repo_dir"')
        quarantine = security.rindex('chmod 0700 -- "$legacy_log_fd_path"')
        self.assertGreater(quarantine, broad)


if __name__ == "__main__":
    unittest.main()
