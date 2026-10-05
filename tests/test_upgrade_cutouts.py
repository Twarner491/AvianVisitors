#!/usr/bin/env python3
"""Focused path and transport checks for the workstation cutout upgrader."""

from __future__ import annotations

import importlib.util
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "avian" / "scripts" / "upgrade_cutouts.py"
SPEC = importlib.util.spec_from_file_location("upgrade_cutouts", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


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


if __name__ == "__main__":
    unittest.main()
