from __future__ import annotations

import fcntl
import importlib.util
import os
from pathlib import Path
import re
import sys
import tempfile
import threading
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "avian_build_masks", ROOT / "avian/scripts/build_masks.py"
)
assert SPEC is not None and SPEC.loader is not None
build_masks = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(build_masks)


class BuildMasksTransactionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="avian-mask-transaction-")
        self.root = Path(self.temporary.name)
        self.lock = self.root / "generation.lock"
        self.lock.write_text("", encoding="ascii")
        self.lock.chmod(0o600)
        self.revision_state = self.root / "content.revision"
        self.revision_state.write_text("0" * 64 + "\n", encoding="ascii")
        self.revision_state.chmod(0o600)
        self.dims = self.root / "dims.json"
        self.masks = self.root / "masks.json"
        self.dims.write_text('{"old":[1,1]}\n', encoding="utf-8")
        self.masks.write_text('{"old":{"w":1,"h":1,"bits":"gA=="}}\n', encoding="utf-8")
        self.illustrations = self.root / "illustrations"
        self.illustrations.mkdir()
        self.previous_lock = build_masks.GENERATION_LOCK
        self.previous_revision_state = build_masks.ART_REVISION_STATE
        self.previous_included = build_masks.INCLUDED_ILLUSTRATIONS
        self.previous_inherited = os.environ.pop("AVIAN_GENERATION_LOCK_FD", None)
        build_masks.GENERATION_LOCK = self.lock
        build_masks.ART_REVISION_STATE = self.revision_state
        build_masks.INCLUDED_ILLUSTRATIONS = self.illustrations

    def tearDown(self) -> None:
        build_masks.GENERATION_LOCK = self.previous_lock
        build_masks.ART_REVISION_STATE = self.previous_revision_state
        build_masks.INCLUDED_ILLUSTRATIONS = self.previous_included
        if self.previous_inherited is not None:
            os.environ["AVIAN_GENERATION_LOCK_FD"] = self.previous_inherited
        else:
            os.environ.pop("AVIAN_GENERATION_LOCK_FD", None)
        self.temporary.cleanup()

    def revision(self) -> str:
        return self.revision_state.read_text(encoding="ascii")

    def test_pair_write_publishes_one_new_nonce(self) -> None:
        before = self.revision()
        with build_masks.table_write_transaction() as transaction:
            transaction.begin()
            self.assertEqual(
                self.revision(), build_masks.INVALID_CONTENT_REVISION + "\n"
            )
            self.dims.write_text('{"new":[2,2]}\n', encoding="utf-8")
            self.masks.write_text(
                '{"new":{"w":1,"h":1,"bits":"gA=="}}\n', encoding="utf-8"
            )
        after = self.revision()
        self.assertRegex(after, r"^[0-9a-f]{64}\n$")
        self.assertNotEqual(after, before)
        self.assertEqual(
            self.lock.read_bytes(), b"",
            "the mutex inode must never be mistaken for persistent revision state",
        )

        # Rebuilding byte-identical, same-size tables still invalidates cached
        # PNG URLs because the transaction nonce, not table hashing, advances.
        with build_masks.table_write_transaction() as transaction:
            transaction.begin()
            self.dims.write_text(self.dims.read_text(encoding="utf-8"), encoding="utf-8")
            self.masks.write_text(self.masks.read_text(encoding="utf-8"), encoding="utf-8")
        self.assertRegex(self.revision(), r"^[0-9a-f]{64}\n$")
        self.assertNotEqual(self.revision(), after)
        self.assertEqual(self.lock.read_bytes(), b"")

    def test_failed_pair_write_stays_invalid_until_complete_rebuild(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "injected"):
            with build_masks.table_write_transaction() as transaction:
                transaction.begin()
                self.dims.write_text('{"partial":[3,3]}\n', encoding="utf-8")
                raise RuntimeError("injected")
        self.assertEqual(
            self.revision(), build_masks.INVALID_CONTENT_REVISION + "\n"
        )

        with build_masks.table_write_transaction() as transaction:
            transaction.begin()
            self.masks.write_text(
                '{"partial":{"w":1,"h":1,"bits":"gA=="}}\n', encoding="utf-8"
            )
        self.assertTrue(re.fullmatch(r"[0-9a-f]{64}\n", self.revision()))

    def test_generator_can_commit_through_its_inherited_locked_descriptor(self) -> None:
        with self.lock.open("r+", encoding="ascii") as held:
            fcntl.flock(held.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            os.environ["AVIAN_GENERATION_LOCK_FD"] = str(held.fileno())
            with build_masks.table_write_transaction() as transaction:
                transaction.begin()
                self.assertEqual(
                    self.revision(), build_masks.INVALID_CONTENT_REVISION + "\n"
                )
            fcntl.flock(held.fileno(), fcntl.LOCK_UN)
        self.assertRegex(self.revision(), r"^[0-9a-f]{64}\n$")

    def test_documented_live_png_write_invalidates_before_publish(self) -> None:
        target = self.illustrations / "testus-birdus.png"
        with build_masks.included_art_write_transaction(self.illustrations):
            self.assertEqual(
                self.revision(), build_masks.INVALID_CONTENT_REVISION + "\n"
            )
            build_masks.durable_atomic_bytes(target, b"new-png")
        self.assertEqual(target.read_bytes(), b"new-png")
        self.assertEqual(
            self.revision(), build_masks.INVALID_CONTENT_REVISION + "\n"
        )
        self.assertEqual(self.lock.read_bytes(), b"")

    def test_documented_live_png_write_waits_for_generation_lock(self) -> None:
        wrote = threading.Event()

        def invoke() -> None:
            with build_masks.included_art_write_transaction(self.illustrations):
                build_masks.durable_atomic_bytes(
                    self.illustrations / "testus-birdus.png", b"new-png"
                )
                wrote.set()

        with self.lock.open("r+", encoding="ascii") as competing:
            fcntl.flock(competing.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            worker = threading.Thread(target=invoke, daemon=True)
            worker.start()
            self.assertFalse(wrote.wait(0.15), "live PNG changed outside the shared lock")
            fcntl.flock(competing.fileno(), fcntl.LOCK_UN)
            worker.join(timeout=2)
        self.assertFalse(worker.is_alive())
        self.assertTrue(wrote.is_set())

    def test_slow_writer_refuses_intervening_replacement_without_invalidating(self) -> None:
        target = self.illustrations / "testus-birdus.png"
        target.write_bytes(b"before")
        expected = build_masks.regular_file_identity(target)
        before_revision = self.revision()
        replacement = self.illustrations / ".replacement.png"
        replacement.write_bytes(b"newer-update")
        replacement.replace(target)
        with self.assertRaisesRegex(RuntimeError, "changed while"):
            with build_masks.included_art_write_transaction(
                self.illustrations, {target: expected}
            ):
                self.fail("stale writer entered its publish section")
        self.assertEqual(target.read_bytes(), b"newer-update")
        self.assertEqual(self.revision(), before_revision)

    def test_direct_rebuild_waits_for_lock_before_scanning_pngs(self) -> None:
        illustrations = self.root / "direct-illustrations"
        frontend = self.root / "frontend"
        illustrations.mkdir()
        frontend.mkdir()
        scanned = threading.Event()
        result: list[int] = []

        def fake_build(_illustrations, only=None):
            self.assertIsNone(only)
            scanned.set()
            return (
                {"testus-birdus": [10, 10]},
                {"testus-birdus": {"w": 1, "h": 1, "bits": "gA=="}},
            )

        def invoke() -> None:
            result.append(build_masks.main())

        argv = [
            "build_masks.py", "--illustrations", str(illustrations),
            "--frontend", str(frontend),
        ]
        with self.lock.open("r+", encoding="ascii") as competing, \
             mock.patch.object(sys, "argv", argv), \
             mock.patch.object(build_masks, "build_tables", side_effect=fake_build):
            fcntl.flock(competing.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            worker = threading.Thread(target=invoke, daemon=True)
            worker.start()
            self.assertFalse(
                scanned.wait(0.15),
                "a direct rebuild sampled PNGs before acquiring the generation lock",
            )
            fcntl.flock(competing.fileno(), fcntl.LOCK_UN)
            worker.join(timeout=2)

        self.assertFalse(worker.is_alive())
        self.assertEqual(result, [0])
        self.assertTrue(scanned.is_set())
        self.assertRegex(self.revision(), r"^[0-9a-f]{64}\n$")

    def test_failed_scan_never_blesses_an_existing_invalid_state(self) -> None:
        invalid = build_masks.INVALID_CONTENT_REVISION + "\n"
        self.revision_state.write_text(invalid, encoding="ascii")
        illustrations = self.root / "empty-illustrations"
        frontend = self.root / "empty-frontend"
        illustrations.mkdir()
        frontend.mkdir()
        argv = [
            "build_masks.py", "--illustrations", str(illustrations),
            "--frontend", str(frontend), "--add", "missing-bird",
        ]
        with mock.patch.object(sys, "argv", argv), \
             mock.patch.object(build_masks, "build_tables", return_value=({}, {})):
            self.assertEqual(build_masks.main(), 1)
        self.assertEqual(self.revision(), invalid)


if __name__ == "__main__":
    unittest.main()
