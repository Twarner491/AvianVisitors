from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock
from contextlib import ExitStack


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "avian/scripts"
sys.path.insert(0, str(SCRIPTS))
SPEC = importlib.util.spec_from_file_location(
    "avian_generate_one", SCRIPTS / "generate_one.py"
)
assert SPEC is not None and SPEC.loader is not None
generate_one = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(generate_one)


class GenerateOneRevisionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="avian-generate-revision-")
        self.root = Path(self.temporary.name)
        self.illustrations = self.root / "illustrations"
        self.raw = self.illustrations / "raw"
        self.lock = self.root / "generation.lock"
        self.lock.write_text("", encoding="ascii")
        self.lock.chmod(0o600)
        self.revision_state = self.root / "content.revision"
        self.revision_state.write_text("0" * 64 + "\n", encoding="ascii")
        self.revision_state.chmod(0o600)
        self.originals = {
            "ILLUS": generate_one.ILLUS,
            "RAW": generate_one.RAW,
            "CUTS": generate_one.CUTS,
            "STATE": generate_one.STATE,
            "GENERATION_LOCK": generate_one.GENERATION_LOCK,
            "ART_REVISION_STATE": generate_one.build_masks.ART_REVISION_STATE,
        }
        generate_one.ILLUS = self.illustrations
        generate_one.RAW = self.raw
        generate_one.CUTS = self.illustrations / "cuts.json"
        generate_one.STATE = self.illustrations / ".generate.state.json"
        generate_one.GENERATION_LOCK = self.lock
        generate_one.build_masks.ART_REVISION_STATE = self.revision_state

    def tearDown(self) -> None:
        for name, value in self.originals.items():
            if name == "ART_REVISION_STATE":
                generate_one.build_masks.ART_REVISION_STATE = value
            else:
                setattr(generate_one, name, value)
        self.temporary.cleanup()

    def run_generator(self, render, subprocess_run=None) -> int:
        reference = self.root / "reference.jpg"
        reference.write_bytes(b"reference")
        patches = [
            mock.patch.dict(os.environ, {"GEMINI_API_KEY": "test-key"}),
            mock.patch.object(sys, "argv", [
                "generate_one.py", "--sci", "Testus birdus", "--com", "Test Bird",
                "--force", "--sleep", "0",
            ]),
            mock.patch.object(generate_one.pregen, "slugify", return_value="testus-birdus"),
            mock.patch.object(generate_one.pregen, "load_prompt", return_value="prompt"),
            mock.patch.object(generate_one.pregen, "load_species_notes", return_value={}),
            mock.patch.object(generate_one.pregen, "ensure_reference", return_value=reference),
            mock.patch.object(generate_one.pregen, "select_anti_ref_key", return_value=None),
            mock.patch.object(generate_one.pregen, "select_style_ref", return_value="missing.png"),
            mock.patch.object(generate_one.pregen, "gen_one", side_effect=render),
            mock.patch.object(
                generate_one, "chroma_cut",
                side_effect=lambda _source, target: target.write_bytes(b"rendered-png"),
            ),
        ]
        if subprocess_run is not None:
            patches.append(mock.patch.object(generate_one.subprocess, "run", side_effect=subprocess_run))
        with ExitStack() as stack:
            for patch in patches:
                stack.enter_context(patch)
            return generate_one.main()

    def test_partial_pose_failure_leaves_runtime_fail_closed(self) -> None:
        def render(_key, _prompt, _sci, _com, pose, **_kwargs):
            if pose == 1:
                return b"first-render"
            raise RuntimeError("second pose failed")

        self.assertEqual(self.run_generator(render), 1)
        self.assertTrue((self.illustrations / "testus-birdus.png").exists())
        self.assertEqual(
            self.revision_state.read_text(encoding="ascii"),
            generate_one.build_masks.INVALID_CONTENT_REVISION + "\n",
        )
        state = json.loads(generate_one.STATE.read_text(encoding="utf-8"))
        self.assertFalse(state["ok"])

    def test_successful_masks_child_commits_through_inherited_lock(self) -> None:
        def render(_key, _prompt, _sci, _com, pose, **_kwargs):
            return f"render-{pose}".encode("ascii")

        def finish_masks(command, **kwargs):
            self.assertIn("--add", command)
            inherited = kwargs["env"]["AVIAN_GENERATION_LOCK_FD"]
            self.assertEqual(kwargs["pass_fds"], (int(inherited),))
            with self.revision_state.open("r+", encoding="ascii") as handle:
                generate_one.build_masks.invalidate_content_revision(handle)
                generate_one.build_masks.rotate_content_revision(handle)
            return SimpleNamespace(returncode=0)

        self.assertEqual(self.run_generator(render, finish_masks), 0)
        self.assertRegex(
            self.revision_state.read_text(encoding="ascii"), r"^[0-9a-f]{64}\n$"
        )
        self.assertTrue(re.fullmatch(
            r"[0-9a-f]{64}\n", self.revision_state.read_text(encoding="ascii")
        ))


if __name__ == "__main__":
    unittest.main()
