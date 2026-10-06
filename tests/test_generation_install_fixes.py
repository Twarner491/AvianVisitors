"""Behavioral coverage for public generation and installer regressions."""

import json
import os
from pathlib import Path
import re
import shutil
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[1]
PHP = shutil.which("php")


def shell_functions(path):
    return "\n".join(re.findall(
        r"^\w+\(\) \{\n.*?^\}", path.read_text(), re.M | re.S))


@pytest.mark.skipif(not PHP, reason="PHP is unavailable")
@pytest.mark.parametrize("path", [None, ""])
def test_generator_finds_nohup_without_fpm_path(path):
    function = re.search(
        r"function find_executable\(.*?^\}",
        (ROOT / "avian/api/generate.php").read_text(), re.M | re.S).group()
    env = dict(os.environ)
    env.pop("PATH", None)
    if path is not None:
        env["PATH"] = path
    result = subprocess.run(
        [PHP, "-r", function + '; echo json_encode(find_executable("nohup"));'],
        env=env, text=True, capture_output=True, check=True)
    executable = json.loads(result.stdout)
    assert executable is not None
    assert Path(executable).is_file()
    assert os.access(executable, os.X_OK)


@pytest.mark.skipif(not PHP, reason="PHP is unavailable")
def test_generator_respects_explicit_path_and_ignores_relative_entries(tmp_path):
    function = re.search(
        r"function find_executable\(.*?^\}",
        (ROOT / "avian/api/generate.php").read_text(), re.M | re.S).group()
    (tmp_path / "nohup").write_text("#!/bin/sh\nexit 0\n")
    (tmp_path / "nohup").chmod(0o755)
    for path, expected in [(str(tmp_path), str(tmp_path / "nohup")), (".:", None)]:
        result = subprocess.run(
            [PHP, "-r", function + '; echo json_encode(find_executable("nohup"));'],
            env={**os.environ, "PATH": path}, cwd=tmp_path,
            text=True, capture_output=True, check=True)
        assert json.loads(result.stdout) == expected


def run_install_functions(tmp_path, body):
    functions = shell_functions(ROOT / "scripts/install_services.sh")
    functions = functions.replace("/etc/crontab", str(tmp_path / "crontab"))
    functions = functions.replace("/etc/systemd/system", str(tmp_path / "systemd"))
    functions = functions.replace("${HOME}/phpsysinfo", str(tmp_path / "phpsysinfo"))
    functions = functions.replace(
        "https://github.com/phpsysinfo/phpsysinfo.git", str(tmp_path / "upstream"))
    script = f'''set -e
{functions}
my_dir={json.dumps(str(ROOT))}
sudo() {{ shift 2; command "$@"; }}
systemctl() {{ [ "$1" = daemon-reload ]; }}
{body}
'''
    return subprocess.run(["bash", "-c", script], text=True, capture_output=True)


def test_phpsysinfo_install_rerun_preserves_local_checkout(tmp_path):
    subprocess.run(["git", "init", "--bare", str(tmp_path / "upstream")],
                   check=True, capture_output=True)
    first = run_install_functions(tmp_path, "install_phpsysinfo")
    assert first.returncode == 0, first.stderr
    custom = tmp_path / "phpsysinfo/local.ini"
    custom.write_text("local settings\n")
    second = run_install_functions(tmp_path, "install_phpsysinfo")
    assert second.returncode == 0, second.stderr
    assert custom.read_text() == "local settings\n"


def test_caddy_timeout_rerun_preserves_operator_override(tmp_path):
    directory = tmp_path / "systemd/caddy.service.d"
    directory.mkdir(parents=True)
    custom = directory / "override.conf"
    custom.write_text("[Service]\nMemoryMax=200M\n")
    result = run_install_functions(tmp_path, "increase_caddy_timeout; increase_caddy_timeout")
    assert result.returncode == 0, result.stderr
    assert custom.read_text() == "[Service]\nMemoryMax=200M\n"
    assert any("TimeoutSec=300s" in p.read_text() for p in directory.glob("*.conf"))


def test_cron_install_rerun_preserves_unrelated_jobs_without_duplicates(tmp_path):
    crontab = tmp_path / "crontab"
    original = "# local job\n1 2 * * * root /usr/local/bin/local-job\n"
    crontab.write_text(original)
    result = run_install_functions(tmp_path, """
for repeat in 1 2; do
  install_cleanup_cron
  install_weekly_cron
  install_automatic_update_cron
done
""")
    assert result.returncode == 0, result.stderr
    contents = crontab.read_text()
    assert contents.startswith(original)
    jobs = [line for line in contents.splitlines() if line and not line.startswith("#")]
    assert len(jobs) == 7
    assert len(set(jobs)) == 7


@pytest.mark.parametrize("default,custom", [
    ("*/5 * * * * ", "*/10 * * * * "),
    ("0 3 * * 0 ", "15 8 * * 1 "),
    ("0 3 * * 0 ", "@daily "),
])
def test_cron_rerun_preserves_operator_schedule(tmp_path, default, custom):
    crontab = tmp_path / "crontab"
    crontab.write_text("# local job\n1 2 * * * root /usr/local/bin/local-job\n")
    install = "install_cleanup_cron; install_weekly_cron; install_automatic_update_cron"
    first = run_install_functions(tmp_path, install)
    assert first.returncode == 0, first.stderr
    customized = crontab.read_text().replace(default, custom)
    assert customized != crontab.read_text()
    crontab.write_text(customized)
    second = run_install_functions(tmp_path, install)
    assert second.returncode == 0, second.stderr
    assert crontab.read_text() == customized


@pytest.mark.parametrize("comment", ["#", "# ", "  #  "])
@pytest.mark.parametrize("schedule", ["*/5 * * * * ", "@reboot "])
def test_cron_rerun_preserves_disabled_managed_job(tmp_path, comment, schedule):
    crontab = tmp_path / "crontab"
    crontab.write_text("")
    first = run_install_functions(tmp_path, "install_cleanup_cron")
    assert first.returncode == 0, first.stderr
    disabled = crontab.read_text().replace(schedule, comment + schedule)
    crontab.write_text(disabled)
    second = run_install_functions(tmp_path, "install_cleanup_cron")
    assert second.returncode == 0, second.stderr
    assert crontab.read_text() == disabled


def test_unmarked_commented_job_does_not_suppress_managed_cron(tmp_path):
    crontab = tmp_path / "crontab"
    command = f"*/5 * * * * {os.environ['USER']} /usr/local/bin/disk_check.sh >/dev/null 2>&1"
    unrelated_comment = "# Example only\n# " + command + "\n"
    crontab.write_text(unrelated_comment)
    result = run_install_functions(tmp_path, "install_cleanup_cron")
    assert result.returncode == 0, result.stderr
    assert crontab.read_text().startswith(unrelated_comment)
    assert "#birdnet\n" + command + "\n" in crontab.read_text()


def test_root_runtime_smoke_refuses_execution_without_opt_in():
    env = dict(os.environ)
    env.pop("AVIAN_GENERATION_RUNTIME_TEST", None)
    result = subprocess.run(
        ["bash", str(ROOT / "tests/smoke_generation_runtime.sh")],
        env=env, text=True, capture_output=True)
    assert result.returncode != 0
    assert "refusing generation runtime smoke" in result.stderr


@pytest.mark.parametrize("value", ["/", "/tmp/../avian-invalid", "relative/path"])
def test_webroot_preparation_rejects_unsafe_paths_before_writes(tmp_path, value):
    result = run_install_functions(tmp_path, f'''
getent() {{ [ "$1 $2" = "passwd station" ]; }}
sudo() {{ echo unexpected-write >&2; return 99; }}
BIRDNET_USER=station
EXTRACTED={json.dumps(value)}
prepare_caddy_webroot
''')
    assert result.returncode != 0
    assert "Invalid BirdNET-Pi webroot" in result.stderr
    assert "unexpected-write" not in result.stderr


def test_webroot_preparation_creates_missing_directory_and_rejects_file(tmp_path):
    webroot = tmp_path / "new-webroot"
    body = f'''
getent() {{ [ "$1 $2" = "passwd station" ]; }}
BIRDNET_USER=station
EXTRACTED={json.dumps(str(webroot))}
prepare_caddy_webroot
'''
    result = run_install_functions(tmp_path, body)
    assert result.returncode == 0, result.stderr
    assert webroot.is_dir()
    webroot.rmdir()
    webroot.write_text("untouched")
    result = run_install_functions(tmp_path, body)
    assert result.returncode != 0
    assert webroot.read_text() == "untouched"
