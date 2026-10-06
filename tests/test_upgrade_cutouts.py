#!/usr/bin/env python3
"""Focused path and transport checks for the workstation cutout upgrader."""

from __future__ import annotations

import importlib.util
import fcntl
import json
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "avian" / "scripts" / "upgrade_cutouts.py"
SPEC = importlib.util.spec_from_file_location("upgrade_cutouts", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

INSTALL_SPEC = importlib.util.spec_from_file_location(
    "install_upgraded_cutouts",
    SCRIPT.with_name("install_upgraded_cutouts.py"),
)
assert INSTALL_SPEC and INSTALL_SPEC.loader
INSTALLER = importlib.util.module_from_spec(INSTALL_SPEC)
INSTALL_SPEC.loader.exec_module(INSTALLER)


class UpgradeCutoutsTest(unittest.TestCase):
    def test_accepts_station_target_and_relative_repo(self) -> None:
        self.assertEqual(MODULE.validate_target("monalisa@birdnet.local"),
                         "monalisa@birdnet.local")
        self.assertEqual(MODULE.validate_repo("BirdNET-Pi"), "BirdNET-Pi")
        self.assertEqual(MODULE.validate_repo("stations/BirdNET-Pi/"),
                         "stations/BirdNET-Pi")

    def test_rejects_shell_and_path_injection(self) -> None:
        for value in ("birdnet.local", "bird@host;touch /tmp/pwn", "-oProxyCommand=x@host"):
            with self.subTest(target=value), self.assertRaises(ValueError):
                MODULE.validate_target(value)
        for value in ("/BirdNET-Pi", "../BirdNET-Pi", "BirdNET-Pi/../root", "BirdNET Pi"):
            with self.subTest(repo=value), self.assertRaises(ValueError):
                MODULE.validate_repo(value)
        for value in ("../secret", "bird;id", "bird name", ""):
            with self.subTest(slug=value), self.assertRaises(ValueError):
                MODULE.validate_slug(value)

    def test_reads_private_inputs_over_ssh(self) -> None:
        completed = subprocess.CompletedProcess([], 0, stdout=b'{"Bird": "chroma"}', stderr=b"")
        with mock.patch.object(MODULE.subprocess, "run", return_value=completed) as run:
            data = MODULE.read_remote(
                "bird@birdnet.local",
                "BirdNET-Pi/avian/assets/illustrations/cuts.json",
            )
        self.assertEqual(data, completed.stdout)
        argv = run.call_args.args[0]
        self.assertEqual(argv[0:2], ["ssh", "bird@birdnet.local"])
        self.assertIn("cuts.json", argv[2])
        self.assertNotIn("http://", SCRIPT.read_text())
        self.assertNotIn("urllib", SCRIPT.read_text())

    def test_ssh_read_failure_is_not_silent(self) -> None:
        completed = subprocess.CompletedProcess([], 1, stdout=b"", stderr=b"missing")
        with mock.patch.object(MODULE.subprocess, "run", return_value=completed):
            with self.assertRaisesRegex(RuntimeError, "missing"):
                MODULE.read_remote("bird@birdnet.local", "BirdNET-Pi/missing")

    def test_remote_command_delegates_every_live_move_to_locked_helper(self) -> None:
        source = SCRIPT.read_text(encoding="utf-8")
        self.assertIn("install_upgraded_cutouts.py", source)
        self.assertNotIn("&& mv -f avian/assets/illustrations/.upgrade-stage", source)


class InstallUpgradedCutoutsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="avian-upgrade-install-")
        self.root = Path(self.temporary.name)
        self.illustrations = self.root / "illustrations"
        self.stage = self.illustrations / ".upgrade-stage"
        self.stage.mkdir(parents=True)
        self.lock = self.root / "generation.lock"
        self.lock.write_text("", encoding="ascii")
        self.lock.chmod(0o600)
        self.state = self.root / "included-art.revision"
        self.state.write_text("a" * 64 + "\n", encoding="ascii")
        self.state.chmod(0o600)
        self.originals = {
            "ILLUSTRATIONS": INSTALLER.ILLUSTRATIONS,
            "STAGE": INSTALLER.STAGE,
            "GENERATION_LOCK": INSTALLER.GENERATION_LOCK,
            "ART_REVISION_STATE": INSTALLER.ART_REVISION_STATE,
            "build_lock": INSTALLER.build_masks.GENERATION_LOCK,
            "build_state": INSTALLER.build_masks.ART_REVISION_STATE,
        }
        INSTALLER.ILLUSTRATIONS = self.illustrations
        INSTALLER.STAGE = self.stage
        INSTALLER.GENERATION_LOCK = self.lock
        INSTALLER.ART_REVISION_STATE = self.state
        INSTALLER.build_masks.GENERATION_LOCK = self.lock
        INSTALLER.build_masks.ART_REVISION_STATE = self.state

    def tearDown(self) -> None:
        INSTALLER.ILLUSTRATIONS = self.originals["ILLUSTRATIONS"]
        INSTALLER.STAGE = self.originals["STAGE"]
        INSTALLER.GENERATION_LOCK = self.originals["GENERATION_LOCK"]
        INSTALLER.ART_REVISION_STATE = self.originals["ART_REVISION_STATE"]
        INSTALLER.build_masks.GENERATION_LOCK = self.originals["build_lock"]
        INSTALLER.build_masks.ART_REVISION_STATE = self.originals["build_state"]
        self.temporary.cleanup()

    def stage_files(self, slugs: list[str]) -> None:
        for slug in slugs:
            (self.stage / f"{slug}.png").write_bytes(f"new-{slug}".encode("ascii"))
        (self.stage / "cuts.json").write_text(
            json.dumps({"still-pending": "chroma"}) + "\n", encoding="utf-8"
        )

    def commit_masks(self, lock_handle, slugs) -> None:
        self.assertIsNotNone(slugs)
        with self.state.open("r+", encoding="ascii") as handle:
            self.assertEqual(
                handle.read(), INSTALLER.build_masks.INVALID_CONTENT_REVISION + "\n"
            )
            INSTALLER.build_masks.rotate_content_revision(handle)

    def test_failure_after_first_live_move_remains_fail_closed(self) -> None:
        self.stage_files(["first-bird", "second-bird"])
        publish = INSTALLER.publish_staged_file

        def fail_second(source, target, maximum):
            if target.name == "second-bird.png":
                raise OSError("injected power loss")
            publish(source, target, maximum)

        with mock.patch.object(INSTALLER, "publish_staged_file", side_effect=fail_second), \
             mock.patch.object(INSTALLER, "run_mask_builder") as builder:
            with self.assertRaisesRegex(OSError, "power loss"):
                INSTALLER.install(["first-bird", "second-bird"])
        builder.assert_not_called()
        self.assertTrue((self.illustrations / "first-bird.png").exists())
        self.assertEqual(
            self.state.read_text(encoding="ascii"),
            INSTALLER.build_masks.INVALID_CONTENT_REVISION + "\n",
        )
        self.assertEqual(self.lock.read_bytes(), b"")

    def test_live_moves_wait_for_lock_and_commit_only_after_masks(self) -> None:
        self.stage_files(["first-bird"])
        moved = threading.Event()
        result: list[BaseException | None] = []
        publish = INSTALLER.publish_staged_file

        def observed_publish(source, target, maximum):
            publish(source, target, maximum)
            if target.name.endswith(".png"):
                moved.set()

        def invoke() -> None:
            try:
                INSTALLER.install(["first-bird"])
            except BaseException as exc:  # pragma: no cover - assertion below reports it
                result.append(exc)
            else:
                result.append(None)

        with self.lock.open("r+", encoding="ascii") as held, \
             mock.patch.object(INSTALLER, "publish_staged_file", side_effect=observed_publish), \
             mock.patch.object(INSTALLER, "run_mask_builder", side_effect=self.commit_masks):
            fcntl.flock(held.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            worker = threading.Thread(target=invoke, daemon=True)
            worker.start()
            self.assertFalse(moved.wait(0.15), "live PNG moved before acquiring generation lock")
            fcntl.flock(held.fileno(), fcntl.LOCK_UN)
            worker.join(timeout=2)

        self.assertFalse(worker.is_alive())
        self.assertEqual(result, [None])
        self.assertTrue(moved.is_set())
        self.assertRegex(self.state.read_text(encoding="ascii"), r"^[0-9a-f]{64}\n$")
        self.assertEqual(self.lock.read_bytes(), b"")


if __name__ == "__main__":
    unittest.main()
