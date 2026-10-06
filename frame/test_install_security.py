from __future__ import annotations

import os
import pwd
import shutil
import shlex
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock


FRAME = Path(__file__).resolve().parent
PLAYWRIGHT_VERSION = "1.62.0"
BASE_SYSTEM_PACKAGES = (
    "python3-venv",
    "python3-dev",
    "build-essential",
    "libatlas3-base",
    "util-linux",
)
PLAYWRIGHT_NATIVE_PACKAGES = (
    "xvfb",
    "fonts-noto-color-emoji",
    "fonts-unifont",
    "libfontconfig1",
    "libfreetype6",
    "xfonts-scalable",
    "fonts-liberation",
    "fonts-ipafont-gothic",
    "fonts-wqy-zenhei",
    "fonts-tlwg-loma-otf",
    "fonts-freefont-ttf",
    "libasound2",
    "libatk-bridge2.0-0",
    "libatk1.0-0",
    "libatspi2.0-0",
    "libcairo2",
    "libcups2",
    "libdbus-1-3",
    "libdrm2",
    "libgbm1",
    "libglib2.0-0",
    "libnspr4",
    "libnss3",
    "libpango-1.0-0",
    "libx11-6",
    "libxcb1",
    "libxcomposite1",
    "libxdamage1",
    "libxext6",
    "libxfixes3",
    "libxkbcommon0",
    "libxrandr2",
)
ISOLATED_ROOT = (
    os.geteuid() == 0
    and Path("/.dockerenv").is_file()
    and os.environ.get("AVIAN_BIRDFRAME_INSTALL_CONTAINER_TEST") == "1"
    and Path("/usr/bin/sudo").is_file()
)


@unittest.skipUnless(
    ISOLATED_ROOT,
    "requires an explicitly enabled disposable root container",
)
class FrameInstallerSecurityTests(unittest.TestCase):
    user = "avianframetest"
    uid = 23456

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="avian-frame-installer-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.root.chmod(0o755)
        self.home = self.root / "home" / self.user
        self.frame = self.home / "AvianVisitors" / "frame"
        self.ambient_home = self.root / "ambient-home"
        self.command_log = self.root / "command-log"
        self.home.mkdir(parents=True)
        self.ambient_home.mkdir()
        self.command_log.mkdir()
        self.command_log.chmod(0o777)
        shutil.copytree(
            FRAME,
            self.frame,
            ignore=shutil.ignore_patterns(".venv", "__pycache__"),
        )

        subprocess.run(
            [
                "/usr/sbin/useradd",
                "--no-create-home",
                "--home-dir",
                str(self.home),
                "--uid",
                str(self.uid),
                "--user-group",
                "--shell",
                "/bin/sh",
                self.user,
            ],
            check=True,
        )
        self.addCleanup(
            lambda: subprocess.run(
                ["/usr/sbin/userdel", self.user],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        )
        account = pwd.getpwnam(self.user)
        self.gid = account.pw_gid
        for parent, directories, files in os.walk(self.home):
            os.chown(parent, self.uid, self.gid)
            for name in directories + files:
                os.chown(Path(parent) / name, self.uid, self.gid)
        os.chown(self.ambient_home, self.uid, self.gid)

        self.sudoers = Path("/etc/sudoers.d/avian-birdframe-installer-test")
        self.assertFalse(self.sudoers.exists())
        self.sudoers.write_text(f"{self.user} ALL=(ALL:ALL) NOPASSWD: ALL\n")
        self.sudoers.chmod(0o440)
        self.addCleanup(self.sudoers.unlink, missing_ok=True)

        self.created_paths: list[Path] = []
        for command in ("raspi-config", "systemctl", "reboot", "sleep"):
            self._write_system_executable(
                Path("/usr/local/sbin") / command,
                "#!/bin/sh\nexit 0\n",
            )
        self.apt_get = Path("/usr/bin/apt-get")
        self.apt_get_backup = Path("/usr/bin/apt-get.avian-birdframe-test-real")
        self.assertTrue(self.apt_get.is_file())
        self.assertFalse(self.apt_get_backup.exists())
        self.apt_get.rename(self.apt_get_backup)
        self.addCleanup(self._restore_apt_get)
        self.apt_get.write_text(
            "#!/bin/sh\n"
            f"printf '%s\\n' \"$*\" >> {self.command_log}/apt-get\n"
            "exit 0\n"
        )
        self.apt_get.chmod(0o755)
        self._write_system_executable(
            Path("/usr/local/sbin/python3"),
            "#!/bin/sh\n"
            "case \" $* \" in\n"
            "  *\" -c import tomllib \"*|*\" -c import tomli \"*)\n"
            f"    [ -f {self.command_log}/config-contract-fail ] && exit 1\n"
            "    exec /usr/bin/python3 \"$@\" ;;\n"
            "  *\"config_contract.py \"*)\n"
            f"    [ -f {self.command_log}/config-contract-fail ] && exit 1\n"
            "    exec /usr/bin/python3 \"$@\" ;;\n"
            f"  *\" --check-station \"*) [ -f {self.command_log}/station-fail ] && exit 1; exit 0 ;;\n"
            "esac\n"
            "[ \"${1-}\" = -m ] && [ \"${2-}\" = venv ] || exit 1\n"
            "mkdir -p \"$3/bin\"\n"
            "cat > \"$3/bin/pip\" <<'EOF'\n"
            "#!/bin/sh\n"
            f"if [ -f {self.command_log}/rewrite-launcher ]; then\n"
            "  printf '#!/bin/sh\\nprintf compromised\\n' > "
            '"$PWD/avian-bundle-installed"\n'
            '  chmod 0755 "$PWD/avian-bundle-installed"\n'
            "  printf '[Service]\\nExecStart=+/usr/bin/id\\n' > "
            '"$PWD/systemd/birdframe.service"\n'
            "  printf '[Timer]\\nOnBootSec=1s\\n' > "
            '"$PWD/systemd/birdframe.timer"\n'
            "fi\n"
            f"if [ -f {self.command_log}/rewrite-parent-installer ]; then\n"
            "  offset=$(/usr/bin/grep -b -o "
            "'/usr/bin/sudo systemctl daemon-reload' \"$PWD/install.sh\" | "
            "/usr/bin/cut -d: -f1)\n"
            "  printf '%-37s' '/usr/bin/sudo /usr/bin/id > /tmp/pwn' | "
            "/usr/bin/dd of=\"$PWD/install.sh\" bs=1 seek=\"$offset\" "
            "conv=notrunc status=none\n"
            f"  /bin/rm -f {self.command_log}/rewrite-parent-installer\n"
            "fi\n"
            f"if [ -f {self.command_log}/append-parent-installer ]; then\n"
            "  printf '\\n/usr/bin/sudo /usr/bin/id > /tmp/pwn-append\\n' >> "
            '"$PWD/install.sh"\n'
            f"  /bin/rm -f {self.command_log}/append-parent-installer\n"
            "fi\n"
            f"if [ -f {self.command_log}/check-artifact-order ]; then\n"
            "  artifact_state=ready\n"
            "  [ \"$(/usr/bin/stat -c '%u:%g:%a' "
            "/usr/local/lib/avian-birdframe)\" = 0:0:755 ] || artifact_state=late\n"
            "  [ \"$(/usr/bin/stat -c '%u:%g:%a' "
            "/usr/local/lib/avian-birdframe/avian-bundle)\" = 0:0:755 ] || "
            "artifact_state=late\n"
            "  [ \"$(/usr/bin/stat -c '%u:%g:%a' "
            "/usr/local/lib/avian-birdframe/owner-uid)\" = 0:0:644 ] || "
            "artifact_state=late\n"
            "  [ \"$(/usr/bin/stat -c '%u:%g:%a' "
            "/etc/avian-birdframe)\" = 0:0:755 ] || artifact_state=late\n"
            "  [ \"$(/usr/bin/stat -c '%u:%g:%a' "
            "/etc/avian-birdframe/environment)\" = 0:0:600 ] || "
            "artifact_state=late\n"
            "  [ \"$(/usr/bin/stat -c '%u:%g:%a' "
            "/etc/systemd/system/birdframe.service)\" = 0:0:644 ] || "
            "artifact_state=late\n"
            "  [ \"$(/usr/bin/stat -c '%u:%g:%a' "
            "/etc/systemd/system/birdframe.timer)\" = 0:0:644 ] || "
            "artifact_state=late\n"
            "  [ \"$(/usr/bin/readlink /usr/local/bin/avian-bundle)\" = "
            "../lib/avian-birdframe/avian-bundle ] || artifact_state=late\n"
            f"  [ \"$(/usr/bin/readlink /usr/local/bin/birdframe-names)\" = "
            f"{self.frame}/birdframe-names ] || artifact_state=late\n"
            f"  [ \"$(/usr/bin/readlink /usr/local/lib/avian-birdframe/control)\" = "
            f"{self.frame}/vendor/avian-bundle-control ] || artifact_state=late\n"
            f"  printf '%s\\n' \"$artifact_state\" > {self.command_log}/artifact-order\n"
            "fi\n"
            f"if [ -f {self.command_log}/remove-config ]; then\n"
            '  /bin/rm -f "$HOME/.birdframe/config.toml"\n'
            "fi\n"
            f"/usr/bin/tr '\\000' '\\n' < /proc/$PPID/cmdline > "
            f"{self.command_log}/installer-cmdline\n"
            "uid=$(/usr/bin/id -u)\n"
            "nested=$(/usr/bin/sudo -n /usr/bin/id -u 2>/dev/null || printf blocked)\n"
            f"printf '%s:%s:%s\\n' \"$uid\" \"$nested\" \"$*\" >> {self.command_log}/pip\n"
            "exit 0\n"
            "EOF\n"
            "cat > \"$3/bin/playwright\" <<'EOF'\n"
            "#!/bin/sh\n"
            "uid=$(/usr/bin/id -u)\n"
            "nested=$(/usr/bin/sudo -n /usr/bin/id -u 2>/dev/null || printf blocked)\n"
            f"printf '%s:%s:%s\\n' \"$uid\" \"$nested\" \"$*\" > {self.command_log}/playwright-$uid\n"
            "exit 0\n"
            "EOF\n"
            "cat > \"$3/bin/python\" <<'EOF'\n"
            "#!/bin/sh\n"
            "uid=$(/usr/bin/id -u)\n"
            "nested=$(/usr/bin/sudo -n /usr/bin/id -u 2>/dev/null || printf blocked)\n"
            f"printf '%s:%s:%s\\n' \"$uid\" \"$nested\" \"$*\" > {self.command_log}/python-$uid\n"
            "exit 0\n"
            "EOF\n"
            "chmod 0755 \"$3/bin/pip\" \"$3/bin/playwright\" \"$3/bin/python\"\n",
        )

        self.boot_config = Path("/boot/config.txt")
        self.assertFalse(self.boot_config.exists())
        self.boot_config.parent.mkdir(parents=True, exist_ok=True)
        self.boot_config.write_text("")
        self.created_paths.append(self.boot_config)
        Path("/etc/systemd/system").mkdir(parents=True, exist_ok=True)
        for path in (
            Path("/usr/local/bin/birdframe-names"),
            Path("/usr/local/bin/avian-bundle"),
            Path("/usr/local/lib/avian-birdframe"),
            Path("/etc/avian-birdframe"),
            Path("/etc/systemd/system/birdframe.service"),
            Path("/etc/systemd/system/birdframe.timer"),
        ):
            self.assertFalse(path.exists() or path.is_symlink(), str(path))
        self.addCleanup(self._clean_install_paths)

    def _write_system_executable(self, path: Path, body: str) -> None:
        self.assertFalse(path.exists() or path.is_symlink(), str(path))
        path.write_text(body)
        path.chmod(0o755)
        self.created_paths.append(path)

    def _restore_apt_get(self) -> None:
        self.apt_get.unlink(missing_ok=True)
        if self.apt_get_backup.exists():
            self.apt_get_backup.rename(self.apt_get)

    def _clean_install_paths(self) -> None:
        for path in (
            Path("/usr/local/bin/birdframe-names"),
            Path("/usr/local/bin/avian-bundle"),
            Path("/usr/local/lib/avian-birdframe"),
            Path("/etc/avian-birdframe"),
            Path("/etc/systemd/system/birdframe.service"),
            Path("/etc/systemd/system/birdframe.timer"),
        ):
            if path.is_symlink() or path.is_file():
                path.unlink()
            elif path.is_dir():
                shutil.rmtree(path)
        for path in reversed(self.created_paths):
            path.unlink(missing_ok=True)

    def _assert_no_install_mutation(self) -> None:
        self.assertEqual(self.boot_config.read_text(), "")
        self.assertFalse((self.home / ".birdframe/config.toml").exists())
        self.assertEqual(self._snapshot_managed_paths(), self.managed_paths_before_run)

    @staticmethod
    def _describe_path(path: Path):
        if not path.exists() and not path.is_symlink():
            return ("missing",)
        metadata = path.lstat()
        identity = (
            metadata.st_uid,
            metadata.st_gid,
            stat.S_IMODE(metadata.st_mode),
        )
        if path.is_symlink():
            return ("symlink", identity, os.readlink(path))
        if path.is_file():
            return ("file", identity, path.read_bytes())
        if path.is_dir():
            children = tuple(
                (child.name, FrameInstallerSecurityTests._describe_path(child))
                for child in sorted(path.iterdir(), key=lambda item: item.name)
            )
            return ("directory", identity, children)
        return ("other", identity)

    def _snapshot_managed_paths(self):
        return tuple(
            (str(path), self._describe_path(path))
            for path in (
                Path("/usr/local/bin/birdframe-names"),
                Path("/usr/local/bin/avian-bundle"),
                Path("/usr/local/lib/avian-birdframe"),
                Path("/etc/avian-birdframe"),
                Path("/etc/systemd/system/birdframe.service"),
                Path("/etc/systemd/system/birdframe.timer"),
            )
        )

    def _run_installer(
        self,
        *,
        as_root: bool = False,
        image_url: str = "https://example.test/frame.png",
        arguments: tuple[str, ...] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        environment = {
            **os.environ,
            "HOME": str(self.ambient_home),
            "USER": "root",
            "LOGNAME": "root",
            "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        }

        def become_installer() -> None:
            os.setgroups([])
            os.setgid(self.gid)
            os.setuid(self.uid)

        command = [str(self.frame / "install.sh")]
        if arguments is None:
            command.extend(("--image-url", image_url))
        else:
            command.extend(arguments)
        self.managed_paths_before_run = self._snapshot_managed_paths()
        return subprocess.run(
            command,
            cwd=self.frame,
            env=environment,
            preexec_fn=None if as_root else become_installer,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_installer_rejects_root_before_installing_anything(self) -> None:
        with mock.patch.dict(
            os.environ,
            {
                "SUDO_UID": str(self.uid),
                "SUDO_USER": self.user,
                "HOME": str(self.home),
                "USER": self.user,
                "LOGNAME": self.user,
            },
        ):
            completed = self._run_installer(as_root=True)

        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("run install.sh as a regular user, without sudo", completed.stderr)
        self.assertFalse(Path("/usr/local/bin/avian-bundle").exists())
        self._assert_no_install_mutation()

    def test_installer_root_refusal_does_not_resolve_bash_from_ambient_path(self) -> None:
        attacker_bin = self.root / "attacker-bin"
        attacker_bin.mkdir()
        sentinel = self.root / "attacker-bash-ran"
        fake_bash = attacker_bin / "bash"
        fake_bash.write_text(
            "#!/bin/sh\n"
            f"/usr/bin/id -u > {sentinel}\n"
            "exit 0\n"
        )
        fake_bash.chmod(0o755)
        bash_env = self.root / "attacker-bash-env"
        bash_env.write_text(
            f"/usr/bin/id -u > {sentinel}\n"
            "exit 0\n"
        )
        bash_env.chmod(0o644)
        os.chown(attacker_bin, self.uid, self.gid)
        os.chown(fake_bash, self.uid, self.gid)
        os.chown(bash_env, self.uid, self.gid)
        completed = subprocess.run(
            [str(self.frame / "install.sh"), "--image-url", "https://example.test/x"],
            cwd=self.frame,
            env={
                **os.environ,
                "BASH_ENV": str(bash_env),
                "PATH": f"{attacker_bin}:/usr/bin:/bin",
            },
            text=True,
            capture_output=True,
            check=False,
        )

        self.assertNotEqual(completed.returncode, 0)
        self.assertFalse(sentinel.exists())
        self.assertIn("run install.sh as a regular user, without sudo", completed.stderr)

    def test_installer_uses_passwd_identity_and_migrates_managed_links(self) -> None:
        Path("/usr/local/bin/avian-bundle").symlink_to(self.frame / "avian-bundle")
        Path("/usr/local/bin/birdframe-names").symlink_to(
            self.frame / "birdframe-names"
        )

        completed = self._run_installer()

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertTrue((self.home / ".birdframe/config.toml").is_file())
        self.assertFalse((self.ambient_home / ".birdframe/config.toml").exists())
        service = Path("/etc/systemd/system/birdframe.service").read_text()
        self.assertIn(f"User={self.user}\n", service)
        self.assertIn(str(self.home / ".birdframe/config.toml"), service)
        self.assertIn(
            "EnvironmentFile=-/etc/avian-birdframe/environment\n", service
        )

        launcher_dir = Path("/usr/local/lib/avian-birdframe")
        launcher = launcher_dir / "avian-bundle"
        owner_file = launcher_dir / "owner-uid"
        launcher_dir_stat = launcher_dir.stat()
        self.assertEqual((launcher_dir_stat.st_uid, launcher_dir_stat.st_gid), (0, 0))
        self.assertEqual(stat.S_IMODE(launcher_dir_stat.st_mode), 0o755)
        self.assertTrue(launcher.is_file())
        self.assertFalse(launcher.is_symlink())
        launcher_stat = launcher.stat()
        self.assertEqual((launcher_stat.st_uid, launcher_stat.st_gid), (0, 0))
        self.assertEqual(stat.S_IMODE(launcher_stat.st_mode), 0o755)
        self.assertEqual(owner_file.read_text(), f"{self.uid}\n")
        owner_stat = owner_file.stat()
        self.assertEqual((owner_stat.st_uid, owner_stat.st_gid), (0, 0))
        self.assertEqual(stat.S_IMODE(owner_stat.st_mode), 0o644)
        environment_dir = Path("/etc/avian-birdframe")
        environment_file = environment_dir / "environment"
        environment_dir_stat = environment_dir.stat()
        self.assertEqual(
            (environment_dir_stat.st_uid, environment_dir_stat.st_gid), (0, 0)
        )
        self.assertEqual(stat.S_IMODE(environment_dir_stat.st_mode), 0o755)
        environment_stat = environment_file.stat()
        self.assertEqual((environment_stat.st_uid, environment_stat.st_gid), (0, 0))
        self.assertEqual(stat.S_IMODE(environment_stat.st_mode), 0o600)
        self.assertEqual(environment_file.read_text(), "")
        self.assertEqual(
            os.readlink("/usr/local/lib/avian-birdframe/control"),
            str(self.frame / "vendor/avian-bundle-control"),
        )
        self.assertEqual(
            os.readlink("/usr/local/bin/avian-bundle"),
            "../lib/avian-birdframe/avian-bundle",
        )

    def test_installer_does_not_replace_unmanaged_global_command(self) -> None:
        destination = Path("/usr/local/bin/avian-bundle")
        destination.write_text("unrelated command\n")
        destination.chmod(0o755)

        completed = self._run_installer()

        self.assertNotEqual(completed.returncode, 0)
        self.assertEqual(destination.read_text(), "unrelated command\n")
        self.assertFalse(destination.is_symlink())
        self._assert_no_install_mutation()

    def test_installer_does_not_replace_unmanaged_global_symlink(self) -> None:
        target = self.root / "unrelated-command"
        target.write_text("unrelated command\n")
        destination = Path("/usr/local/bin/avian-bundle")
        destination.symlink_to(target)

        completed = self._run_installer()

        self.assertNotEqual(completed.returncode, 0)
        self.assertTrue(destination.is_symlink())
        self.assertEqual(os.readlink(destination), str(target))
        self.assertEqual(target.read_text(), "unrelated command\n")
        self._assert_no_install_mutation()

    def test_installer_does_not_nest_launcher_inside_existing_directory(self) -> None:
        launcher = Path("/usr/local/lib/avian-birdframe/avian-bundle")
        launcher.mkdir(parents=True)
        sentinel = launcher / "keep"
        sentinel.write_text("keep\n")

        completed = self._run_installer()

        self.assertNotEqual(completed.returncode, 0)
        self.assertTrue(launcher.is_dir())
        self.assertEqual(sentinel.read_text(), "keep\n")
        self.assertFalse((launcher / "avian-bundle-installed").exists())
        self._assert_no_install_mutation()

    def test_installer_rejects_unsafe_managed_directory_metadata(self) -> None:
        launcher_dir = Path("/usr/local/lib/avian-birdframe")
        launcher_dir.mkdir(parents=True)
        launcher_dir.chmod(0o777)

        completed = self._run_installer()

        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("unsafe ownership or permissions", completed.stderr)
        self._assert_no_install_mutation()

    def test_installer_does_not_treat_control_directory_as_link_destination(self) -> None:
        control = Path("/usr/local/lib/avian-birdframe/control")
        control.mkdir(parents=True)
        sentinel = control / "keep"
        sentinel.write_text("keep\n")

        completed = self._run_installer()

        self.assertNotEqual(completed.returncode, 0)
        self.assertTrue(control.is_dir())
        self.assertEqual(sentinel.read_text(), "keep\n")
        self.assertFalse((control / "avian-bundle-control").exists())
        self._assert_no_install_mutation()

    def test_installer_does_not_nest_service_inside_existing_directory(self) -> None:
        service = Path("/etc/systemd/system/birdframe.service")
        service.mkdir()
        sentinel = service / "keep"
        sentinel.write_text("keep\n")

        completed = self._run_installer()

        self.assertNotEqual(completed.returncode, 0)
        self.assertTrue(service.is_dir())
        self.assertEqual(sentinel.read_text(), "keep\n")
        self._assert_no_install_mutation()

    def test_installer_does_not_replace_symlinked_timer_unit(self) -> None:
        target = self.root / "unrelated.timer"
        target.write_text("unrelated timer\n")
        timer = Path("/etc/systemd/system/birdframe.timer")
        timer.symlink_to(target)

        completed = self._run_installer()

        self.assertNotEqual(completed.returncode, 0)
        self.assertTrue(timer.is_symlink())
        self.assertEqual(os.readlink(timer), str(target))
        self.assertEqual(target.read_text(), "unrelated timer\n")
        self._assert_no_install_mutation()

    def test_installer_rejects_unsafe_control_mode_before_system_mutation(self) -> None:
        control = self.frame / "vendor" / "avian-bundle-control"
        for unsafe_mode in (0o775, 0o757, 0o111):
            with self.subTest(mode=oct(unsafe_mode)):
                control.chmod(unsafe_mode)

                completed = self._run_installer()

                self.assertNotEqual(completed.returncode, 0)
                self.assertIn("unsafe executable permissions", completed.stderr)
                self._assert_no_install_mutation()

    def test_installer_rejects_unsafe_checkout_path_before_sudo(self) -> None:
        unsafe_frame = self.home / "Birds & Bees" / "frame"
        unsafe_frame.parent.mkdir()
        self.frame.rename(unsafe_frame)
        self.frame = unsafe_frame

        completed = self._run_installer()

        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("checkout path contains unsupported characters", completed.stderr)
        self._assert_no_install_mutation()

    def test_installer_rejects_cross_uid_checkout_ancestor_before_sudo(self) -> None:
        checkout_parent = self.frame.parent
        os.chown(checkout_parent, 65534, 65534)

        completed = self._run_installer()

        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("checkout path has unsafe ownership", completed.stderr)
        self._assert_no_install_mutation()

    def test_installer_rejects_writable_checkout_ancestor_before_sudo(self) -> None:
        checkout_parent = self.frame.parent
        checkout_parent.chmod(0o777)

        completed = self._run_installer()

        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("checkout path has unsafe permissions", completed.stderr)
        self._assert_no_install_mutation()

    def test_mode_conflict_is_rejected_before_privileged_mutation(self) -> None:
        config = self.home / ".birdframe/config.toml"
        config.parent.mkdir()
        config.write_text("# birdframe-mode: local\n")

        completed = self._run_installer()

        self.assertNotEqual(completed.returncode, 0)
        self.assertIn(
            "does not select image URL https://example.test/frame.png",
            completed.stderr,
        )
        self.assertEqual(config.read_text(), "# birdframe-mode: local\n")
        self.assertEqual(self.boot_config.read_text(), "")
        self.assertEqual(self._snapshot_managed_paths(), self.managed_paths_before_run)

    def test_station_id_install_writes_exact_station_config(self) -> None:
        completed = self._run_installer(arguments=("--station-id", "314"))

        self.assertEqual(completed.returncode, 0, completed.stderr)
        config = (self.home / ".birdframe/config.toml").read_text()
        self.assertIn('species_source = "birdweather"\n', config)
        self.assertIn('bw_station_id = "314"\n', config)
        self.assertNotRegex(config, r"(?m)^zip\s*=")
        self.assertNotIn("bw_country", config)
        self.assertIn(
            "Installed for BirdWeather station 314",
            completed.stdout,
        )

    def test_station_id_equals_form_and_birdweather_flag_are_compatible(self) -> None:
        completed = self._run_installer(
            arguments=("--bird-weather", "--station-id=314")
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        config = (self.home / ".birdframe/config.toml").read_text()
        self.assertIn('bw_station_id = "314"\n', config)
        self.assertNotRegex(config, r"(?m)^zip\s*=")

    def test_station_mode_rejects_invalid_and_conflicting_arguments(self) -> None:
        invalid = ("0", "01", " 1", "token", "2147483648")
        for station_id in invalid:
            with self.subTest(station_id=station_id):
                completed = self._run_installer(
                    arguments=("--station-id", station_id)
                )
                self.assertNotEqual(completed.returncode, 0)
                self.assertIn(
                    "--station-id must be a number from 1 through 2147483647",
                    completed.stderr,
                )
                self._assert_no_install_mutation()

        conflicts = (
            ("--bird-weather", "--zip", "94107 "),
            ("--station-id", "314", "--zip", "94107"),
            ("--zip", "94107", "--station-id", "314"),
            ("--station-id", "314", "--ebird-key", "ABC"),
            (
                "--station-id",
                "314",
                "--image-url",
                "https://example.test/frame.png",
            ),
        )
        for arguments in conflicts:
            with self.subTest(arguments=arguments):
                completed = self._run_installer(arguments=arguments)
                self.assertNotEqual(completed.returncode, 0)
                self.assertNotIn("unknown argument", completed.stderr)
                self._assert_no_install_mutation()

    def test_existing_matching_station_config_is_left_untouched(self) -> None:
        config = self.home / ".birdframe/config.toml"
        config.parent.mkdir()
        original = (
            'species_source = "birdweather"\n'
            'bw_station_id = "314"\n'
            'shoot_title = ""\n'
        )
        config.write_text(original)
        (self.command_log / "station-fail").touch()

        completed = self._run_installer(arguments=("--station-id", "314"))

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(config.read_text(), original)
        self.assertNotIn("Checking public BirdWeather station", completed.stdout)

    def test_existing_station_mismatch_is_rejected_before_privilege(self) -> None:
        config = self.home / ".birdframe/config.toml"
        config.parent.mkdir()
        original = (
            '# birdframe-mode: birdweather\n'
            'species_source = "birdweather"\n'
            'bw_station_id = "313"\n'
        )
        config.write_text(original)

        completed = self._run_installer(arguments=("--station-id", "314"))

        self.assertNotEqual(completed.returncode, 0)
        self.assertIn(
            "does not select BirdWeather station 314",
            completed.stderr,
        )
        self.assertEqual(config.read_text(), original)
        self.assertEqual(self.boot_config.read_text(), "")
        self.assertEqual(self._snapshot_managed_paths(), self.managed_paths_before_run)

    def test_existing_matching_zip_config_is_left_untouched(self) -> None:
        config = self.home / ".birdframe/config.toml"
        config.parent.mkdir()
        original = (
            '# birdframe-mode: birdweather\n'
            'species_source = "birdweather"\n'
            'zip = "SW1A 1AA"\n'
            'bw_country = "gb"\n'
            'shoot_title = ""\n'
        )
        config.write_text(original)

        completed = self._run_installer(
            arguments=("--bird-weather", "--zip", "SW1A 1AA")
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(config.read_text(), original)

    def test_existing_zip_mismatch_is_rejected_before_privilege(self) -> None:
        config = self.home / ".birdframe/config.toml"
        config.parent.mkdir()
        original = (
            '# birdframe-mode: birdweather\n'
            'species_source = "birdweather"\n'
            'zip = "94107"\n'
            'bw_country = "us"\n'
        )
        config.write_text(original)

        completed = self._run_installer(
            arguments=("--bird-weather", "--zip", "10001")
        )

        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("does not select BirdWeather ZIP 10001", completed.stderr)
        self.assertEqual(config.read_text(), original)
        self.assertEqual(self.boot_config.read_text(), "")
        self.assertEqual(self._snapshot_managed_paths(), self.managed_paths_before_run)

    def test_existing_matching_image_config_is_left_untouched(self) -> None:
        config = self.home / ".birdframe/config.toml"
        config.parent.mkdir()
        original = (
            '# birdframe-mode: image\n'
            'image_url = "https://bird.example/old.png"\n'
            'shoot = false\n'
        )
        config.write_text(original)

        completed = self._run_installer(
            arguments=("--image-url", "https://bird.example/old.png")
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(config.read_text(), original)

    def test_existing_image_mismatch_is_rejected_before_privilege(self) -> None:
        config = self.home / ".birdframe/config.toml"
        config.parent.mkdir()
        original = (
            '# birdframe-mode: image\n'
            'image_url = "https://bird.example/old.png"\n'
            'shoot = false\n'
        )
        config.write_text(original)

        completed = self._run_installer(
            arguments=("--image-url", "https://bird.example/new.png")
        )

        self.assertNotEqual(completed.returncode, 0)
        self.assertIn(
            "does not select image URL https://bird.example/new.png",
            completed.stderr,
        )
        self.assertEqual(config.read_text(), original)
        self.assertEqual(self.boot_config.read_text(), "")
        self.assertEqual(self._snapshot_managed_paths(), self.managed_paths_before_run)

    def test_existing_config_never_executes_prior_venv_parser(self) -> None:
        config = self.home / ".birdframe/config.toml"
        config.parent.mkdir()
        config.write_text(
            '# birdframe-mode: birdweather\n'
            'species_source = "birdweather"\n'
            'bw_station_id = "314"\n'
        )
        prior_python = self.frame / ".venv/bin/python"
        prior_python.parent.mkdir(parents=True)
        sentinel = self.root / "prior-venv-ran"
        prior_python.write_text(
            "#!/bin/sh\n"
            f"/usr/bin/touch {sentinel}\n"
            "exit 0\n"
        )
        prior_python.chmod(0o755)
        os.chown(prior_python.parent.parent, self.uid, self.gid)
        os.chown(prior_python.parent, self.uid, self.gid)
        os.chown(prior_python, self.uid, self.gid)
        (self.command_log / "config-contract-fail").touch()

        completed = self._run_installer(arguments=("--station-id", "314"))

        self.assertNotEqual(completed.returncode, 0)
        self.assertFalse(sentinel.exists())
        self.assertIn("without Python tomllib or tomli", completed.stderr)
        self.assertEqual(self.boot_config.read_text(), "")
        self.assertEqual(self._snapshot_managed_paths(), self.managed_paths_before_run)

    def test_config_validation_ignores_ambient_python_startup_paths(self) -> None:
        config = self.home / ".birdframe/config.toml"
        config.parent.mkdir()
        config.write_text(
            '# birdframe-mode: birdweather\n'
            'species_source = "birdweather"\n'
            'bw_station_id = "314"\n'
        )
        attacker = self.home / "pythonpath"
        attacker.mkdir()
        sentinel = self.home / "python-startup-ran"
        (attacker / "sitecustomize.py").write_text(
            "from pathlib import Path\n"
            f"Path({str(sentinel)!r}).touch()\n"
        )
        os.chown(attacker, self.uid, self.gid)
        os.chown(attacker / "sitecustomize.py", self.uid, self.gid)

        with mock.patch.dict(os.environ, {"PYTHONPATH": str(attacker)}):
            completed = self._run_installer(arguments=("--station-id", "314"))

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertFalse(sentinel.exists())

    def test_unavailable_station_stops_before_privileged_mutation(self) -> None:
        (self.command_log / "station-fail").touch()

        completed = self._run_installer(arguments=("--station-id", "314"))

        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("could not be verified", completed.stderr)
        self._assert_no_install_mutation()

    def test_installer_preserves_hostile_looking_url_as_one_argument(self) -> None:
        sentinel = self.root / "should-never-exist"
        image_url = f"https://example.test/frame.png;touch$IFS{sentinel}"

        completed = self._run_installer(image_url=image_url)

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertFalse(sentinel.exists())
        config = (self.home / ".birdframe/config.toml").read_text()
        self.assertIn(f'image_url = "{image_url}"\n', config)

    def test_installer_rejects_hostile_ebird_key_before_system_mutation(self) -> None:
        completed = self._run_installer(
            arguments=(
                "--bird-weather",
                "--zip",
                "94107",
                "--ebird-key",
                "token; /usr/bin/id\nsecond-line",
            )
        )

        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("should be the alphanumeric token", completed.stderr)
        self._assert_no_install_mutation()

    def test_private_key_handoff_rejects_arbitrary_file_paths(self) -> None:
        passwd_before = Path("/etc/passwd").read_bytes()

        completed = self._run_installer(
            arguments=(
                "--bird-weather",
                "--zip",
                "94107",
                "--internal-ebird-key-file",
                "/etc/passwd",
            )
        )

        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("invalid private eBird key handoff", completed.stderr)
        self.assertEqual(Path("/etc/passwd").read_bytes(), passwd_before)
        self._assert_no_install_mutation()

    def test_browser_setup_never_executes_venv_code_with_root_available(self) -> None:
        completed = self._run_installer(arguments=())

        self.assertEqual(completed.returncode, 0, completed.stderr)
        apt_commands = (self.command_log / "apt-get").read_text().splitlines()
        install_command = next(
            command for command in apt_commands if command.startswith("install ")
        )
        self.assertEqual(
            shlex.split(install_command),
            ["install", "-y", "--no-install-recommends"]
            + list(BASE_SYSTEM_PACKAGES)
            + list(PLAYWRIGHT_NATIVE_PACKAGES),
        )
        self.assertFalse((self.command_log / "playwright-0").exists())
        self.assertEqual(
            (self.command_log / f"playwright-{self.uid}").read_text(),
            f"{self.uid}:blocked:install chromium\n",
        )
        pip_invocations = (self.command_log / "pip").read_text().splitlines()
        self.assertGreaterEqual(len(pip_invocations), 3)
        for invocation in pip_invocations:
            self.assertTrue(
                invocation.startswith(f"{self.uid}:blocked:"),
                invocation,
            )
        self.assertIn(
            f"{self.uid}:blocked:install -q playwright=={PLAYWRIGHT_VERSION}",
            pip_invocations,
        )
        self.assertEqual(
            (self.command_log / f"python-{self.uid}").read_text(),
            f"{self.uid}:blocked:-\n",
        )

    def test_dependency_code_cannot_replace_the_root_owned_launcher(self) -> None:
        trusted_launcher = (self.frame / "avian-bundle-installed").read_bytes()
        (self.command_log / "rewrite-launcher").touch()

        completed = self._run_installer()

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertNotEqual(
            (self.frame / "avian-bundle-installed").read_bytes(),
            trusted_launcher,
        )
        installed_launcher = Path("/usr/local/lib/avian-birdframe/avian-bundle")
        self.assertEqual(installed_launcher.read_bytes(), trusted_launcher)
        installed_service = Path("/etc/systemd/system/birdframe.service").read_text()
        self.assertNotIn("ExecStart=+/usr/bin/id", installed_service)

    def test_dependency_code_cannot_rewrite_future_privileged_installer_steps(self) -> None:
        sentinel = Path("/tmp/pwn")
        self.assertFalse(sentinel.exists())
        self.addCleanup(sentinel.unlink, missing_ok=True)
        (self.command_log / "rewrite-parent-installer").touch()

        completed = self._run_installer()

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertFalse(sentinel.exists())
        self.assertTrue((self.home / ".birdframe/config.toml").is_file())

    def test_dependency_code_cannot_append_privileged_installer_steps(self) -> None:
        sentinel = Path("/tmp/pwn-append")
        self.assertFalse(sentinel.exists())
        self.addCleanup(sentinel.unlink, missing_ok=True)
        (self.command_log / "append-parent-installer").touch()

        completed = self._run_installer()

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertFalse(sentinel.exists())
        self.assertTrue((self.home / ".birdframe/config.toml").is_file())

    def test_config_deleted_during_dependency_setup_is_recreated(self) -> None:
        config = self.home / ".birdframe/config.toml"
        config.parent.mkdir()
        config.write_text(
            '# birdframe-mode: image\n'
            'image_url = "https://example.test/frame.png"\n'
            'shoot = false\n'
        )
        os.chown(config.parent, self.uid, self.gid)
        os.chown(config, self.uid, self.gid)
        (self.command_log / "remove-config").touch()

        completed = self._run_installer()

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertTrue(config.is_file())
        self.assertIn(
            'image_url = "https://example.test/frame.png"\n',
            config.read_text(),
        )

    def test_privileged_artifacts_are_installed_before_dependency_code_runs(self) -> None:
        (self.command_log / "check-artifact-order").touch()

        completed = self._run_installer()

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual((self.command_log / "artifact-order").read_text(), "ready\n")

    def test_ebird_key_is_kept_out_of_public_unit_and_privileged_argv(self) -> None:
        key = "TestEBirdSecret123"

        completed = self._run_installer(
            arguments=("--bird-weather", "--zip", "94107", "--ebird-key", key)
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        service = Path("/etc/systemd/system/birdframe.service").read_text()
        self.assertNotIn(key, service)
        self.assertIn(
            "EnvironmentFile=-/etc/avian-birdframe/environment\n", service
        )
        environment_file = Path("/etc/avian-birdframe/environment")
        self.assertEqual(environment_file.read_text(), f"EBIRD_API_KEY={key}\n")
        environment_stat = environment_file.stat()
        self.assertEqual((environment_stat.st_uid, environment_stat.st_gid), (0, 0))
        self.assertEqual(stat.S_IMODE(environment_stat.st_mode), 0o600)
        config = (self.home / ".birdframe/config.toml").read_text()
        self.assertIn('zip = "94107"\n', config)
        self.assertNotIn("bw_station_id", config)
        installer = (self.frame / "install.sh").read_text()
        self.assertNotRegex(installer, r"birdframe-units[^\n]*EBIRD_KEY")
        self.assertNotIn(
            key,
            (self.command_log / "installer-cmdline").read_text(),
        )

    def test_ebird_key_survives_rerun_and_real_launcher_environment_reset(self) -> None:
        key = "PrivateTestKey123"
        arguments = ("--bird-weather", "--zip", "94107")
        first = self._run_installer(arguments=arguments + ("--ebird-key", key))
        self.assertEqual(first.returncode, 0, first.stderr)
        credential = self.home / ".birdframe/ebird-api-key"
        self.assertTrue(credential.is_file())
        self.assertEqual(credential.read_text(), key + "\n")
        metadata = credential.stat()
        self.assertEqual(metadata.st_uid, self.uid)
        self.assertEqual(stat.S_IMODE(metadata.st_mode), 0o600)
        config = (self.home / ".birdframe/config.toml").read_bytes()
        again = self._run_installer(arguments=arguments)
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertEqual(credential.read_text(), key + "\n")
        self.assertEqual(Path("/etc/avian-birdframe/environment").read_text(), "EBIRD_API_KEY=" + key + "\n")
        self.assertEqual((self.home / ".birdframe/config.toml").read_bytes(), config)
        self.assertNotIn(key, first.stdout + first.stderr + again.stdout + again.stderr + config.decode())

        control = self.frame / "vendor/avian-bundle-control"
        control.write_text(
            "#!/bin/sh\n"
            f"cd {shlex.quote(str(self.frame))}\n"
            "exec /usr/bin/python3 - <<'PY'\n"
            "import io, os, birdweather\n"
            "from unittest import mock\n"
            "assert 'EBIRD_API_KEY' not in os.environ\n"
            "def response(request, timeout):\n"
            "    assert request.get_header('X-ebirdapitoken') == 'PrivateTestKey123'\n"
            "    return io.BytesIO(b'[{\"sciName\":\"Corvus corax\",\"howMany\":5}]')\n"
            "with mock.patch.object(birdweather.urllib.request, 'urlopen', side_effect=response):\n"
            "    assert birdweather.ebird_nearby(37, -122)[0]['n'] == 5\n"
            "print('credential-loaded-after-reset')\n"
            "PY\n"
        )
        completed = subprocess.run(
            ["/usr/bin/sudo", "-u", self.user, "/usr/bin/sudo", "/usr/local/bin/avian-bundle"],
            text=True, capture_output=True, check=False,
            env={**os.environ, "EBIRD_API_KEY": "WrongAmbientKey"},
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(completed.stdout, "credential-loaded-after-reset\n")

    def test_legacy_unit_ebird_key_is_migrated_without_config_or_argv_exposure(self) -> None:
        key = "LegacyTestKey123"
        service = Path("/etc/systemd/system/birdframe.service")
        service.write_text("[Service]\nEnvironment=EBIRD_API_KEY=" + key + "\n")
        service.chmod(0o644)
        completed = self._run_installer(arguments=("--bird-weather", "--zip", "94107"))
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertTrue((self.home / ".birdframe/ebird-api-key").is_file())
        self.assertEqual((self.home / ".birdframe/ebird-api-key").read_text(), key + "\n")
        self.assertEqual(Path("/etc/avian-birdframe/environment").read_text(), "EBIRD_API_KEY=" + key + "\n")
        self.assertNotIn(key, service.read_text() + completed.stdout + completed.stderr)

    def test_installer_rejects_unsafe_private_credential_before_mutation(self) -> None:
        directory = self.home / ".birdframe"
        directory.mkdir(mode=0o700)
        os.chown(directory, self.uid, self.gid)
        credential = directory / "ebird-api-key"
        target = self.home / "untouched"
        target.write_text("untouched\n")
        os.chown(target, self.uid, self.gid)
        credential.symlink_to(target)
        completed = self._run_installer()
        self.assertNotEqual(completed.returncode, 0)
        self.assertEqual(target.read_text(), "untouched\n")
        self._assert_no_install_mutation()

    def test_installer_rejects_multiline_ebird_key_before_mutation(self) -> None:
        completed = self._run_installer(arguments=(
            "--bird-weather", "--zip", "94107", "--ebird-key", "ValidFirstLine\nOTHER=value",
        ))
        self.assertNotEqual(completed.returncode, 0)
        self._assert_no_install_mutation()

    def test_installer_rejects_malformed_stored_service_credentials(self) -> None:
        directory = Path("/etc/avian-birdframe")
        directory.mkdir(mode=0o755)
        environment_file = directory / "environment"
        for raw in (b"EBIRD_API_KEY=\n", b"\n", b"EBIRD_API_KEY=Valid\nOTHER=value\n",
                    b"EBIRD_API_KEY=First\nEBIRD_API_KEY=Second\n", b"EBIRD_API_KEY=A\x00B\n",
                    b"EBIRD_API_KEY=" + b"A" * 4096 + b"\n"):
            with self.subTest(length=len(raw)):
                environment_file.write_bytes(raw)
                environment_file.chmod(0o600)
                completed = self._run_installer(arguments=("--bird-weather", "--zip", "94107"))
                self.assertNotEqual(completed.returncode, 0)
                self._assert_no_install_mutation()

    def test_empty_service_environment_does_not_revive_legacy_key(self) -> None:
        directory = Path("/etc/avian-birdframe")
        directory.mkdir(mode=0o755)
        environment_file = directory / "environment"
        environment_file.write_bytes(b"")
        environment_file.chmod(0o600)
        service = Path("/etc/systemd/system/birdframe.service")
        service.write_text("[Service]\nEnvironment=EBIRD_API_KEY=StaleTestKey\n")
        service.chmod(0o644)
        completed = self._run_installer(arguments=("--bird-weather", "--zip", "94107"))
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(environment_file.read_bytes(), b"")
        self.assertFalse((self.home / ".birdframe/ebird-api-key").exists())

    def test_installer_generates_fixed_nonroot_systemd_units(self) -> None:
        service_template = self.frame / "systemd" / "birdframe.service"
        timer_template = self.frame / "systemd" / "birdframe.timer"
        service_template.write_text(
            "[Service]\n"
            f"ExecStart=+/usr/bin/touch {self.root}/root-service-ran\n"
        )
        timer_template.write_text(
            "[Timer]\n"
            "OnBootSec=1s\n"
            "Unit=unrelated-root.service\n"
        )

        completed = self._run_installer()

        self.assertEqual(completed.returncode, 0, completed.stderr)
        installed_service = Path("/etc/systemd/system/birdframe.service")
        service = installed_service.read_text()
        self.assertIn(f"User={self.user}\n", service)
        self.assertIn("NoNewPrivileges=true\n", service)
        self.assertIn(f"WorkingDirectory={self.frame}\n", service)
        self.assertNotIn("ExecStart=+", service)
        installed_timer = Path("/etc/systemd/system/birdframe.timer")
        self.assertEqual(
            installed_timer.read_text(),
            "[Unit]\n"
            "Description=Update the e-ink bird frame on a schedule\n\n"
            "[Timer]\n"
            "OnActiveSec=2min\n"
            "OnBootSec=2min\n"
            "OnUnitActiveSec=15min\n"
            "Persistent=true\n\n"
            "[Install]\n"
            "WantedBy=timers.target\n",
        )
        for unit in (installed_service, installed_timer):
            unit_stat = unit.stat()
            self.assertEqual((unit_stat.st_uid, unit_stat.st_gid), (0, 0))
            self.assertEqual(stat.S_IMODE(unit_stat.st_mode), 0o644)


if __name__ == "__main__":
    unittest.main()
