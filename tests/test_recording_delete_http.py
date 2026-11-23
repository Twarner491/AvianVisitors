"""Run only in an explicitly opted-in, disposable Linux container."""

import base64
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import grp
import json
import os
from pathlib import Path
import pwd
import shutil
import socket
import sqlite3
import subprocess
import time
import unittest
import urllib.error
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
ENABLED = Path("/.dockerenv").exists() and os.environ.get("AVIAN_DELETE_HTTP_TEST") == "1" and os.geteuid() == 0


@contextmanager
def database(path):
    db = sqlite3.connect(path)
    try:
        with db:
            yield db
    finally:
        db.close()


@unittest.skipUnless(ENABLED, "requires an opted-in disposable container")
class RecordingDeleteHTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.user = "aviandeletion"
        subprocess.run(["useradd", "--create-home", cls.user], check=True)
        cls.uid = pwd.getpwnam(cls.user).pw_uid
        cls.gid = pwd.getpwnam(cls.user).pw_gid
        cls.home = Path("/home") / cls.user
        cls.repo = cls.home / "BirdNET-Pi"
        cls.audio = cls.home / "BirdSongs/Extracted/By_Date"
        cls.audio.mkdir(parents=True)
        for name in ("scripts", "avian/api"):
            (cls.repo / name).mkdir(parents=True, exist_ok=True)
        for name in ("scripts/play.php", "scripts/species_tools.php", "scripts/common.php", "scripts/recording_delete.php", "scripts/delete_recordings.py"):
            shutil.copyfile(ROOT / name, cls.repo / name)
        shutil.copytree(ROOT / "avian/api", cls.repo / "avian/api", dirs_exist_ok=True)
        (cls.repo / "play.php").symlink_to("scripts/play.php")
        Path("/etc/birdnet").mkdir(exist_ok=True)
        Path("/etc/birdnet/birdnet.conf").write_text(f"BIRDNET_USER={cls.user}\n")
        cls.state_dir = Path("/var/lib/avian-visitors")
        cls.state_dir.mkdir(exist_ok=True)
        cls.state_dir.chmod(0o755)
        os.chown(cls.state_dir, 0, 0)
        lock = cls.state_dir / "educators.lock"
        lock.touch()
        os.chown(lock, 0, grp.getgrnam("caddy").gr_gid)
        lock.chmod(0o660)
        cls.verifier = subprocess.check_output(["php", "-r", "echo password_hash('TestPassword12', PASSWORD_BCRYPT, ['cost' => 14]);"], text=True)
        cls.state = cls.state_dir / "admin-auth.state"
        cls.set_policy(0)
        shutil.copyfile(ROOT / "scripts/admin_control.sh", "/usr/local/sbin/avian-admin-control")
        Path("/usr/local/sbin/avian-admin-control").chmod(0o755)
        policy = Path("/etc/sudoers.d/avian-deletion-test")
        policy.write_text("caddy ALL=(root) NOPASSWD: /usr/local/sbin/avian-admin-control *\n")
        policy.chmod(0o440)
        cls.db = cls.repo / "scripts/birds.db"
        with database(cls.db) as db:
            db.execute("CREATE TABLE detections (Date, Time, Sci_Name, Com_Name, File_Name, Confidence REAL)")
        for directory, dirs, files in os.walk(cls.home):
            os.chown(directory, cls.uid, cls.gid)
            for name in files:
                os.chown(Path(directory) / name, cls.uid, cls.gid)
        cls.home.chmod(0o755)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        cls.base = f"http://127.0.0.1:{port}"
        cls.server = subprocess.Popen(["runuser", "-u", "caddy", "--", "php", "-S", f"127.0.0.1:{port}", "-t", str(cls.repo)], cwd=cls.repo, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cls.addClassCleanup(cls.stop_server)
        for _ in range(100):
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                    break
            except OSError:
                time.sleep(0.05)
        else:
            raise RuntimeError("PHP server failed to start")

    @classmethod
    def stop_server(cls):
        cls.server.terminate()
        cls.server.wait(timeout=10)

    @classmethod
    def set_policy(cls, required):
        cls.state.write_text(f"v1\t{required}\t1\t{cls.verifier}\n")
        cls.state.chmod(0o640)
        os.chown(cls.state, 0, grp.getgrnam("caddy").gr_gid)

    def setUp(self):
        self.set_policy(0)
        with database(self.db) as db:
            db.execute("PRAGMA journal_mode=DELETE")
            db.execute("DELETE FROM detections")
            db.execute("INSERT INTO detections VALUES ('2026-10-22', '12:00:00', 'A b', 'Bird', 'bird.wav', 0.85)")
        self.relative = "2026-10-22/Bird/bird.wav"
        self.file = self.audio / self.relative
        self.file.parent.mkdir(parents=True, exist_ok=True)
        self.file.write_bytes(b"audio")
        for item in (self.file, self.file.parent, self.file.parent.parent):
            os.chown(item, self.uid, self.gid)
        self.file.parent.chmod(0o755)

    def request(self, endpoint="/play.php?deletefile=1", body=None, method="POST", authenticated=True, headers=None):
        request_headers = {"Content-Type": "application/json", "X-Avian-Action": "1"}
        if authenticated:
            request_headers["Authorization"] = "Basic " + base64.b64encode(b"birdnet:TestPassword12").decode()
        if headers:
            request_headers.update(headers)
        data = json.dumps(body if body is not None else {"file": self.relative}).encode()
        request = urllib.request.Request(self.base + endpoint, data=data if method == "POST" else None, headers=request_headers, method=method)
        try:
            response = urllib.request.urlopen(request, timeout=15)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, response.read().decode()

    def assert_preserved(self):
        self.assertEqual(self.file.read_bytes(), b"audio")
        with database(self.db) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM detections").fetchone()[0], 1)

    correction = "/avian/api/mark-incorrect.php"

    def api(self, action):
        status, body = self.request("/avian/api/birdnet-api.php?action=" + action, method="GET")
        self.assertEqual(status, 200, body)
        return json.loads(body)

    def selection(self):
        row = self.api("species&sci=A%20b")["detections"][0]
        self.assertIn("correction_key", row, "the recording has no stale-selection guard")
        return {"id": row["detection_id"], "key": row["correction_key"]}

    def test_correction_removes_only_selected_detection_and_keeps_media(self):
        with database(self.db) as db:
            db.execute("INSERT INTO detections SELECT * FROM detections")
        selected = self.selection()
        status, body = self.request(self.correction, selected, headers={"Origin": self.base})
        self.assertEqual(status, 200, body)
        self.assertEqual(self.file.read_bytes(), b"audio")
        left = self.api("species&sci=A%20b")["detections"]
        self.assertEqual(len(left), 1)
        self.assertNotEqual(left[0]["detection_id"], selected["id"])
        self.assertEqual(self.api("stats")["totals"]["detections"], 1)
        self.assertEqual(self.api("lifelist")["species"][0]["n"], 1)
        self.assertEqual(self.request(self.correction, selected)[0], 409)

    def test_reused_row_number_cannot_correct_a_different_recording(self):
        selected = self.selection()
        with database(self.db) as db:
            db.execute("DELETE FROM detections")
            db.execute("INSERT INTO detections VALUES ('2026-10-22','12:00:01','A b','Bird','bird.wav',0.85)")
        self.assertEqual(self.selection()["id"], selected["id"])
        self.assertEqual(self.request(self.correction, selected)[0], 409)
        self.assert_preserved()

    def assert_identical_replacement_is_stale(self, recreate):
        selected = self.selection()
        with database(self.db) as db:
            db.execute("CREATE TEMP TABLE copy AS SELECT * FROM detections")
            if recreate:
                db.execute("DROP TABLE detections")
                db.execute("CREATE TABLE detections AS SELECT * FROM copy")
            else:
                db.execute("DELETE FROM detections")
                db.execute("INSERT INTO detections SELECT * FROM copy")
        self.assertEqual(self.request(self.correction, selected)[0], 409)
        self.assert_preserved()

    def test_identical_reinsertion_is_stale_on_pristine_station(self):
        self.assert_identical_replacement_is_stale(False)

    def test_pristine_clear_and_recreate_invalidates_identical_detection(self):
        self.assert_identical_replacement_is_stale(True)

    def test_species_snapshot_during_station_write_cannot_correct_after_commit(self):
        with database(self.db) as writer:
            writer.execute("BEGIN IMMEDIATE")
            writer.execute("INSERT INTO detections SELECT * FROM detections")
            selected = self.selection()
        self.assertEqual(self.request(self.correction, selected)[0], 409)
        self.assertEqual(self.api("stats")["totals"]["detections"], 2)

    def test_pristine_wal_has_no_unsafe_correction_fallback(self):
        selected = self.selection()
        db = sqlite3.connect(self.db)
        with db:
            self.assertEqual(db.execute("PRAGMA journal_mode=WAL").fetchone(), ("wal",))
            # A live WAL station has a writer and readable shared-memory files.
            db.execute("UPDATE detections SET Confidence=0.9")
        try:
            row = self.api("species&sci=A%20b")["detections"][0]
            self.assertNotIn("correction_key", row)
            self.assertEqual(self.request(self.correction, selected)[0], 409)
        finally:
            db.close()

    def test_educator_sequence_protects_even_identical_reinsertions(self):
        db = sqlite3.connect(self.db)
        with db:
            self.assertEqual(db.execute("PRAGMA journal_mode=WAL").fetchone(), ("wal",))
            db.executescript("""
                CREATE INDEX detections_Date_Time ON detections(Date DESC, Time DESC);
                CREATE TABLE avian_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
                INSERT INTO avian_metadata VALUES('educator_generation','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
                CREATE TABLE avian_detection_sequence(sequence INTEGER PRIMARY KEY AUTOINCREMENT,detection_rowid INTEGER NOT NULL UNIQUE);
                INSERT INTO avian_detection_sequence(detection_rowid) SELECT rowid FROM detections;
                CREATE TRIGGER avian_detection_sequence_insert AFTER INSERT ON detections BEGIN
                  INSERT INTO avian_detection_sequence(detection_rowid) VALUES(NEW.rowid); END;
                CREATE TRIGGER avian_detection_sequence_delete AFTER DELETE ON detections BEGIN
                  DELETE FROM avian_detection_sequence WHERE detection_rowid=OLD.rowid; END;
                CREATE TRIGGER avian_detection_sequence_update AFTER UPDATE OF rowid ON detections BEGIN
                  UPDATE avian_detection_sequence SET detection_rowid=NEW.rowid WHERE detection_rowid=OLD.rowid; END;
            """)
        try:
            selected = self.selection()
            with db:
                db.execute("CREATE TEMP TABLE copy AS SELECT * FROM detections")
                db.execute("DELETE FROM detections")
                db.execute("INSERT INTO detections SELECT * FROM copy")
            self.assertEqual(self.request(self.correction, selected)[0], 409)
            self.assert_preserved()
            self.assertEqual(self.request(self.correction, self.selection())[0], 200)
            with db:
                self.assertEqual(db.execute("SELECT COUNT(*) FROM avian_detection_sequence").fetchone()[0], 0)
                db.execute("INSERT INTO detections SELECT * FROM copy")
                db.execute("DROP TRIGGER avian_detection_sequence_delete")
            self.assertNotIn("correction_key", self.api("species&sci=A%20b")["detections"][0])
        finally:
            db.executescript("""DROP TRIGGER avian_detection_sequence_insert;
                DROP TRIGGER IF EXISTS avian_detection_sequence_delete;
                DROP TRIGGER avian_detection_sequence_update;
                DROP INDEX detections_Date_Time; DROP TABLE avian_detection_sequence; DROP TABLE avian_metadata;""")
            db.close()

    def test_station_helpers_racing_to_correct_one_row(self):
        selected = json.dumps(self.selection())
        def correct(_):
            return subprocess.run(["/usr/local/sbin/avian-admin-control", "mark-incorrect"],
                                  input=selected, text=True, capture_output=True).returncode
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sorted(pool.map(correct, range(2))), [0, 2])
        self.assertEqual(self.file.read_bytes(), b"audio")
        self.assertEqual(self.api("stats")["totals"]["detections"], 0)

    def test_copy_restored_to_same_path_invalidates_selection(self):
        selected = self.selection()
        replacement = self.db.with_suffix(".replacement")
        shutil.copyfile(self.db, replacement)
        os.chown(replacement, self.uid, self.gid)
        replacement.replace(self.db)
        self.assertEqual(self.request(self.correction, selected)[0], 409)
        self.assert_preserved()

    def test_latest_media_skips_preserved_file_and_spectrogram_after_correction(self):
        with database(self.db) as db:
            for time_of_day, name in (("13:00:00", "aaa.mp3"), ("14:00:00", "zzz.mp3")):
                db.execute("INSERT INTO detections VALUES ('2026-10-22',?,'Corvus corax','Bird',?,0.9)",
                           (time_of_day, name))
                for suffix in ("", ".png"):
                    (self.file.parent / (name + suffix)).write_text((name + suffix) * 20)
        row = self.api("species&sci=Corvus%20corax")["detections"][0]
        selected = {"id": row["detection_id"], "key": row["correction_key"]}
        self.assertEqual(self.request(self.correction, selected)[0], 200)
        for endpoint, suffix in (("recording", ""), ("spectrogram", ".png")):
            status, body = self.request(f"/avian/api/{endpoint}.php?sci=Corvus%20corax", method="GET")
            self.assertEqual(status, 200, body)
            self.assertEqual(body, ("aaa.mp3" + suffix) * 20)
            self.assertTrue((self.file.parent / ("zzz.mp3" + suffix)).is_file())

    def test_correction_write_failure_keeps_detection(self):
        with database(self.db) as db:
            db.execute("CREATE TRIGGER refuse BEFORE DELETE ON detections BEGIN SELECT RAISE(ABORT, 'refused'); END")
        try:
            selected = self.selection()
            self.assertEqual(self.request(self.correction, selected)[0], 503)
            self.assert_preserved()
        finally:
            with database(self.db) as db:
                db.execute("DROP TRIGGER refuse")

    def test_correction_gates_and_input_validation(self):
        selected = {"id": 1, "key": "a" * 64}
        self.set_policy(1)
        self.assertEqual(self.request(self.correction, selected, authenticated=False)[0], 401)
        self.set_policy(0)
        for headers, expected in (({"Origin": "https://other.test"}, 403),
                                  ({"Sec-Fetch-Site": "cross-site"}, 403),
                                  ({"X-Avian-Action": ""}, 403), ({"Content-Type": "text/plain"}, 415)):
            self.assertEqual(self.request(self.correction, selected, headers=headers)[0], expected)
        self.assertEqual(self.request(self.correction, selected, method="GET")[0], 405)
        self.assertEqual(self.request(self.correction, {"key": "x" * 600})[0], 413)
        for invalid in ({**selected, "id": "1' text"}, {**selected, "key": "../birds.db"},
                        {**selected, "species": "A b"}, {**selected, "id": True}):
            self.assertEqual(self.request(self.correction, invalid)[0], 400)
        self.assert_preserved()

    def test_authenticated_post_reaches_station_user_helper(self):
        status, body = self.request()
        self.assertEqual(status, 200, body)
        self.assertEqual(json.loads(body), {"ok": True, "lines": 1, "files": 1})
        self.assertFalse(self.file.exists())

    def test_species_authenticated_post(self):
        status, body = self.request("/scripts/species_tools.php?delete=1", {"species": "A b"})
        self.assertEqual(status, 200, body)
        self.assertEqual(json.loads(body)["lines"], 1)

    def test_unauthenticated_both_endpoints_fail_closed(self):
        for endpoint in ("/play.php?deletefile=1", "/scripts/species_tools.php?delete=1"):
            self.assertEqual(self.request(endpoint, authenticated=False)[0], 401)
            self.assert_preserved()

    def test_authenticated_get_cannot_delete(self):
        for endpoint in ("/play.php?deletefile=" + self.relative, "/scripts/species_tools.php?delete=A%20b"):
            self.assertEqual(self.request(endpoint, method="GET")[0], 405)
            self.assert_preserved()

    def test_form_post_and_missing_action_header_cannot_delete(self):
        for headers, status in (({"Content-Type": "application/x-www-form-urlencoded"}, 415), ({"X-Avian-Action": ""}, 403)):
            self.assertEqual(self.request(headers=headers)[0], status)
            self.assert_preserved()

    def test_invalid_selection_and_oversized_request(self):
        for body, expected in (({"file": []}, 400), ({"species": "A b"}, 400), ({"file": "../birds.db"}, 409), ({"file": "x" * 5000}, 413)):
            status, result = self.request(body=body)
            self.assertEqual(status, expected, result)
            self.assert_preserved()

    def test_lan_auth_required_keeps_legacy_mutations_closed(self):
        self.set_policy(1)
        self.assertEqual(self.request()[0], 401)
        self.assert_preserved()

    def test_helper_rejects_extra_arguments_and_root_execution(self):
        response = subprocess.run(["/usr/local/sbin/avian-admin-control", "delete-recordings", "/etc/passwd"], capture_output=True, text=True)
        self.assertNotEqual(response.returncode, 0)
        response = subprocess.run(["python3", str(self.repo / "scripts/delete_recordings.py"), str(self.db), str(self.audio)], input=json.dumps({"file": self.relative}), capture_output=True, text=True)
        self.assertNotEqual(response.returncode, 0)
        self.assert_preserved()

    def test_root_owned_shifted_file_is_restored_after_database_failure(self):
        shifted = self.audio / "shifted" / self.relative
        shifted.parent.mkdir(parents=True, exist_ok=True)
        for parent in (shifted.parent, shifted.parent.parent, shifted.parent.parent.parent):
            os.chown(parent, self.uid, self.gid)
        shifted.write_bytes(b"root-owned shifted audio")
        os.chown(shifted, 0, 0)
        shifted.chmod(0o644)
        with database(self.db) as db:
            db.execute("CREATE TRIGGER refuse BEFORE DELETE ON detections BEGIN SELECT RAISE(ABORT, 'refused'); END")
        try:
            status, body = self.request()
            self.assertEqual(status, 409, body)
            self.assert_preserved()
            self.assertEqual(shifted.read_bytes(), b"root-owned shifted audio")
            self.assertEqual(shifted.stat().st_uid, 0)
        finally:
            with database(self.db) as db:
                db.execute("DROP TRIGGER refuse")
            shifted.unlink()
