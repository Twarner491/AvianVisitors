from __future__ import annotations

import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
BUILTIN_ID = "official-western-us-woodblock"
BUILTIN_REVISION = "included-woodblock-v1"


class BundlePhpEndpoints(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = Path(tempfile.mkdtemp(prefix="avian-bundle-php-"))
        self.webroot = self.temp / "www"
        for relative in [
            "avian/api/bundle-assets.php",
            "avian/api/bundle-runtime.php",
            "avian/api/cutout.php",
            "avian/frontend/dims.json",
            "avian/frontend/masks.json",
            "avian/assets/illustrations/corvus-brachyrhynchos.png",
            "avian/assets/illustrations/corvus-brachyrhynchos-2.png",
        ]:
            source = ROOT / relative
            target = self.webroot / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
        self.library = self.temp / "bundles"
        self.library.mkdir(mode=0o750)
        self.generation_lock = self.temp / "generation.lock"
        self.generation_lock.touch(mode=0o600)
        self.generation_lock.chmod(0o600)
        self.art_revision_state = self.temp / "content.revision"
        self.art_revision_state.write_text("d" * 64 + "\n", encoding="ascii")
        self.art_revision_state.chmod(0o600)
        self.revision_one = "1" * 64
        self.revision_two = "2" * 64
        self._install_fixture("test-pack", "1.0.0", self.revision_one, "corvus-brachyrhynchos")
        self._write_active("test-pack", "1.0.0", self.revision_one, "Test pack")

        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            self.port = listener.getsockname()[1]
        env = os.environ.copy()
        env["AVIAN_BUNDLE_ROOT"] = str(self.library)
        env["AVIAN_GENERATION_LOCK"] = str(self.generation_lock)
        env["AVIAN_ART_REVISION_STATE"] = str(self.art_revision_state)
        self.server = subprocess.Popen(
            ["php", "-S", f"127.0.0.1:{self.port}", "-t", str(self.webroot)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=env,
        )
        for _ in range(50):
            try:
                self.request("/avian/api/bundle-assets.php")
                break
            except OSError:
                time.sleep(0.05)
        else:
            self.fail("PHP test server did not start")

    def tearDown(self) -> None:
        self.server.terminate()
        try:
            self.server.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.server.kill()
            self.server.wait(timeout=3)
        shutil.rmtree(self.temp)

    def _json(self, path: Path, value: object) -> None:
        path.write_text(json.dumps(value, separators=(",", ":")) + "\n", encoding="utf-8")
        path.chmod(0o640)

    def _install_fixture(
        self,
        pack_id: str,
        version: str,
        revision: str,
        slug: str,
        *,
        source_slug: str | None = None,
    ) -> None:
        source = (
            ROOT
            / "avian"
            / "assets"
            / "illustrations"
            / f"{source_slug or slug}.png"
        )
        data = source.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        object_dir = self.library / "objects" / "sha256" / digest[:2]
        object_dir.mkdir(parents=True, exist_ok=True, mode=0o750)
        for parent in [self.library / "objects", self.library / "objects" / "sha256", object_dir]:
            parent.chmod(0o750)
        target = object_dir / f"{digest}.png"
        target.write_bytes(data)
        target.chmod(0o640)

        pack = self.library / "packs" / pack_id / version
        pack.mkdir(parents=True, mode=0o750)
        for parent in [self.library / "packs", self.library / "packs" / pack_id, pack]:
            parent.chmod(0o750)
        self._json(pack / "index.json", {
            "schema_version": 1,
            "id": pack_id,
            "version": version,
            "revision": revision,
            "assets": {slug: {"perched": {"sha256": digest, "bytes": len(data)}}},
        })
        self._json(pack / "meta.json", {
            "reference": {
                "id": pack_id,
                "version": version,
                "revision": revision,
                "included": False,
                "name": pack_id,
            },
            "installed_at": "2026-09-01T00:00:00Z",
        })
        self._json(pack / "dims.json", {slug: [560, 400]})
        self._json(pack / "masks.json", {
            slug: {"w": 1, "h": 1, "bits": base64.b64encode(b"\x80").decode("ascii")},
        })

    def _write_active(self, pack_id: str, version: str, revision: str, name: str) -> None:
        self._json(self.library / "active.json", {
            "schema_version": 1,
            "active": {
                "id": pack_id,
                "version": version,
                "revision": revision,
                "included": False,
                "name": name,
            },
            "previous": None,
        })

    def request(
        self, path: str, headers: dict[str, str] | None = None, *, method: str = "GET"
    ) -> tuple[int, bytes, dict[str, str]]:
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}", headers=headers or {}, method=method
        )
        try:
            with urllib.request.urlopen(request, timeout=3) as response:
                return response.status, response.read(), dict(response.headers)
        except urllib.error.HTTPError as error:
            return error.code, error.read(), dict(error.headers)

    def _assert_cutout_head_matches_get(self, path: str, expected_png: bytes) -> None:
        status, body, headers = self.request(path)
        self.assertEqual(status, 200)
        self.assertEqual(body, expected_png)
        self.assertEqual(headers["Content-Type"], "image/png")
        self.assertEqual(headers["Content-Length"], str(len(expected_png)))
        head_status, head_body, head_headers = self.request(path, method="HEAD")
        self.assertEqual(head_status, 200)
        self.assertEqual(head_body, b"")
        for header in ("Content-Type", "Content-Length", "Cache-Control", "ETag", "X-Content-Type-Options"):
            self.assertEqual(head_headers.get(header), headers.get(header), header)

    def test_included_cutout_head_matches_get_for_both_poses(self) -> None:
        self._json(self.library / "active.json", {
            "schema_version": 1,
            "active": {"id": BUILTIN_ID, "version": "1.0.0", "revision": BUILTIN_REVISION,
                       "included": True, "name": "Japanese Woodblock"},
            "previous": None,
        })
        status, body, _ = self.request("/avian/api/bundle-assets.php")
        self.assertEqual(status, 200)
        content = json.loads(body)["active"]["content_revision"]
        for pose, suffix in ((1, ""), (2, "-2")):
            with self.subTest(pose=pose):
                self._assert_cutout_head_matches_get(
                    "/avian/api/cutout.php?sci=Corvus%20brachyrhynchos&pose=" + str(pose)
                    + "&bundle=" + BUILTIN_REVISION + "&content=" + content,
                    (ROOT / ("avian/assets/illustrations/corvus-brachyrhynchos" + suffix + ".png")).read_bytes(),
                )

    def test_selected_cutout_head_matches_get_and_rejects_wrong_identity(self) -> None:
        reference = self._selection_fixture("Corvus brachyrhynchos", "corvus-brachyrhynchos")
        directory = self.library / "packs/test-pack/1.0.0/selections" / reference["selection_revision"]
        flight = (ROOT / "avian/assets/illustrations/corvus-brachyrhynchos-2.png").read_bytes()
        digest = hashlib.sha256(flight).hexdigest()
        object_dir = self.library / "objects/sha256" / digest[:2]
        object_dir.mkdir(mode=0o750, exist_ok=True)
        (object_dir / (digest + ".png")).write_bytes(flight)
        (object_dir / (digest + ".png")).chmod(0o640)
        index = json.loads((directory / "index.json").read_bytes())
        index["assets"]["corvus-brachyrhynchos"]["flight"] = {"sha256": digest, "bytes": len(flight)}
        self._json(directory / "index.json", index)
        for table in ("dims.json", "masks.json"):
            value = json.loads((directory / table).read_bytes())
            value["corvus-brachyrhynchos-2"] = value["corvus-brachyrhynchos"]
            self._json(directory / table, value)
        self._json(self.library / "active.json", {
            "schema_version": 1, "active": reference, "previous": None,
        })
        for pose, suffix in ((1, ""), (2, "-2")):
            with self.subTest(pose=pose):
                self._assert_cutout_head_matches_get(
                    "/avian/api/cutout.php?sci=Corvus%20brachyrhynchos&pose=" + str(pose)
                    + "&bundle=" + self.revision_one + "&content=" + reference["selection_revision"],
                    (ROOT / ("avian/assets/illustrations/corvus-brachyrhynchos" + suffix + ".png")).read_bytes(),
                )
        for revision, content in ((self.revision_one, "f" * 64), ("f" * 64, reference["selection_revision"])):
            status, body, _ = self.request(
                "/avian/api/cutout.php?sci=Corvus%20brachyrhynchos&bundle=" + revision + "&content=" + content,
                method="HEAD",
            )
            self.assertEqual(status, 404)
            self.assertEqual(body, b"")

    def test_assets_expose_only_exact_active_inventory(self) -> None:
        status, body, headers = self.request("/avian/api/bundle-assets.php?v=test")
        self.assertEqual(status, 200)
        payload = json.loads(body)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["active"]["revision"], self.revision_one)
        self.assertEqual(payload["active"]["content_revision"], self.revision_one)
        self.assertFalse(payload["active"]["included"])
        self.assertEqual(list(payload["dims"]), ["corvus-brachyrhynchos"])
        self.assertEqual(list(payload["masks"]), ["corvus-brachyrhynchos"])
        self.assertIn(self.revision_one, headers["ETag"])

    def _selection_fixture(self, name: str, slug: str) -> dict:
        receipt = {
            "schema_version": 1, "mode": "local",
            "manifest_sha256": self.revision_one,
            "species": [name], "basis_sha256": "b" * 64,
        }
        raw = (json.dumps(receipt, sort_keys=True, separators=(",", ":")) + "\n").encode()
        selection = hashlib.sha256(raw).hexdigest()
        version_dir = self.library / "packs/test-pack/1.0.0"
        directory = version_dir / "selections" / selection
        directory.mkdir(parents=True, mode=0o750)
        (version_dir / "selections").chmod(0o750)
        reference = {
            "id": "test-pack", "version": "1.0.0", "revision": self.revision_one,
            "included": False, "name": "Test pack", "selection_revision": selection,
        }
        for filename in ["index.json", "dims.json", "masks.json"]:
            value = json.loads((version_dir / filename).read_bytes())
            if filename == "index.json":
                value["selection_revision"] = selection
                value["assets"] = {slug: value["assets"]["corvus-brachyrhynchos"]}
            else:
                value = {slug: value["corvus-brachyrhynchos"]}
            self._json(directory / filename, value)
        (directory / "selection.json").write_bytes(raw)
        (directory / "selection.json").chmod(0o640)
        self._json(directory / "meta.json", {
            "reference": reference, "installed_at": "2026-09-09T00:00:00Z",
        })
        return reference

    def test_selection_identity_keeps_prior_geometry_and_images_addressable(self) -> None:
        first = self._selection_fixture("Corvus brachyrhynchos", "corvus-brachyrhynchos")
        second = self._selection_fixture("Corvus corax", "corvus-corax")
        self._json(self.library / "active.json", {
            "schema_version": 1, "active": first, "previous": None,
        })
        status, body, headers = self.request("/avian/api/bundle-assets.php")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["active"]["content_revision"], first["selection_revision"])
        first_etag = headers["ETag"]
        self._json(self.library / "active.json", {
            "schema_version": 1, "active": second, "previous": first,
        })
        status, body, headers = self.request("/avian/api/bundle-assets.php", {"If-None-Match": first_etag})
        self.assertEqual(status, 200)
        self.assertNotEqual(headers["ETag"], first_etag)
        self.assertEqual(list(json.loads(body)["dims"]), ["corvus-corax"])
        url = "/avian/api/cutout.php?bundle=" + self.revision_one + "&sci=Corvus%20brachyrhynchos"
        self.assertEqual(self.request(url + "&content=" + first["selection_revision"])[0], 200)
        self.assertEqual(self.request(url + "&content=" + second["selection_revision"])[0], 404)
        self.assertEqual(self.request(url + "&content=" + "f" * 64)[0], 404)

    def test_selection_receipt_tampering_fails_closed(self) -> None:
        reference = self._selection_fixture("Corvus brachyrhynchos", "corvus-brachyrhynchos")
        self._json(self.library / "active.json", {
            "schema_version": 1, "active": reference, "previous": None,
        })
        path = self.library / "packs/test-pack/1.0.0/selections" / reference["selection_revision"] / "selection.json"
        receipt = json.loads(path.read_bytes())
        receipt["species"] = ["Corvus corax"]
        self._json(path, receipt)
        self.assertEqual(self.request("/avian/api/bundle-assets.php")[0], 503)

    def test_non_builtin_cutout_never_falls_back(self) -> None:
        base = "/avian/api/cutout.php?bundle=" + self.revision_one
        status, body, _ = self.request(base + "&sci=Corvus%20brachyrhynchos")
        self.assertEqual(status, 200)
        self.assertEqual(body, (ROOT / "avian/assets/illustrations/corvus-brachyrhynchos.png").read_bytes())

        status, _, _ = self.request(base + "&sci=Corvus%20brachyrhynchos&pose=2")
        self.assertEqual(status, 404, "missing flight must not use perched or built-in flight")
        status, _, _ = self.request(base + "&sci=Calypte%20anna")
        self.assertEqual(status, 404, "missing species must not use built-in artwork")
        status, _, _ = self.request("/avian/api/cutout.php?sci=Corvus%20brachyrhynchos")
        self.assertEqual(status, 404, "custom art requires its geometry revision")
        status, _, _ = self.request("/avian/api/cutout.php?sci=Corvus%20brachyrhynchos&bundle=" + "f" * 64)
        self.assertEqual(status, 404)

    def test_maximum_scientific_name_and_hyphen_runs_resolve_exact_external_assets(self) -> None:
        scientific_name = "A" + "a" * 39 + " " + "b" * 40 + " " + "c" * 40 + " " + "d" * 40
        slug = scientific_name.lower().replace(" ", "-")
        self.assertEqual(len(scientific_name), 163)
        self.assertEqual(len(slug), 163)
        revision = "3" * 64
        self._install_fixture(
            "maximum-name-pack",
            "3.0.0",
            revision,
            slug,
            source_slug="corvus-brachyrhynchos",
        )
        unicode_name = "鳥" * 90
        self._write_active("maximum-name-pack", "3.0.0", revision, unicode_name)

        status, body, _ = self.request("/avian/api/bundle-assets.php")
        self.assertEqual(status, 200)
        inventory = json.loads(body)
        self.assertEqual(inventory["active"]["name"], unicode_name)
        self.assertEqual(list(inventory["dims"]), [slug])
        endpoint = (
            "/avian/api/cutout.php?sci="
            + urllib.parse.quote(scientific_name, safe="")
            + "&bundle="
            + revision
        )
        status, body, _ = self.request(endpoint)
        self.assertEqual(status, 200)
        self.assertEqual(
            body,
            (ROOT / "avian/assets/illustrations/corvus-brachyrhynchos.png").read_bytes(),
        )

        hyphenated_name = "Branta- canadensis--"
        hyphenated_revision = "4" * 64
        self._install_fixture(
            "hyphenated-name-pack",
            "4.0.0",
            hyphenated_revision,
            "branta-canadensis",
            source_slug="corvus-brachyrhynchos",
        )
        self._write_active(
            "hyphenated-name-pack",
            "4.0.0",
            hyphenated_revision,
            "Hyphenated name pack",
        )
        hyphenated_endpoint = (
            "/avian/api/cutout.php?sci="
            + urllib.parse.quote(hyphenated_name, safe="")
            + "&bundle="
            + hyphenated_revision
        )
        status, body, _ = self.request(hyphenated_endpoint)
        self.assertEqual(status, 200)
        self.assertEqual(
            body,
            (ROOT / "avian/assets/illustrations/corvus-brachyrhynchos.png").read_bytes(),
        )

    def test_switch_race_resolves_old_immutable_revision(self) -> None:
        self._install_fixture("second-pack", "2.0.0", self.revision_two, "calypte-anna")
        self._write_active("second-pack", "2.0.0", self.revision_two, "Second pack")

        old_url = "/avian/api/cutout.php?sci=Corvus%20brachyrhynchos&bundle=" + self.revision_one
        status, body, _ = self.request(old_url)
        self.assertEqual(status, 200)
        self.assertEqual(body, (ROOT / "avian/assets/illustrations/corvus-brachyrhynchos.png").read_bytes())

        current_missing = "/avian/api/cutout.php?sci=Corvus%20brachyrhynchos&bundle=" + self.revision_two
        status, _, _ = self.request(current_missing)
        self.assertEqual(status, 404)

    def test_corrupt_active_state_fails_closed(self) -> None:
        (self.library / "active.json").write_text("{broken\n", encoding="utf-8")
        (self.library / "active.json").chmod(0o640)
        status, body, _ = self.request("/avian/api/bundle-assets.php")
        self.assertEqual(status, 503)
        self.assertFalse(json.loads(body)["ok"])
        status, _, _ = self.request(
            "/avian/api/cutout.php?sci=Corvus%20brachyrhynchos&bundle=" + self.revision_one
        )
        self.assertEqual(status, 404)

    def test_included_active_preserves_existing_resolver(self) -> None:
        self._json(self.library / "active.json", {
            "schema_version": 1,
            "active": {
                "id": BUILTIN_ID,
                "version": "1.0.0",
                "revision": BUILTIN_REVISION,
                "included": True,
                "name": "Japanese Woodblock",
            },
            "previous": None,
        })
        dims_path = self.webroot / "avian/frontend/dims.json"
        masks_path = self.webroot / "avian/frontend/masks.json"
        dims_path.chmod(0o660)
        masks_path.chmod(0o660)

        status, body, headers = self.request("/avian/api/bundle-assets.php")
        self.assertEqual(status, 200)
        inventory = json.loads(body)
        self.assertTrue(inventory["active"]["included"])
        self.assertEqual(inventory["active"]["revision"], BUILTIN_REVISION)
        first_content_revision = inventory["active"]["content_revision"]
        self.assertRegex(first_content_revision, r"^[0-9a-f]{64}$")
        first_etag = headers["ETag"]
        self.assertIn(BUILTIN_REVISION, first_etag)
        self.assertIn(first_content_revision, first_etag)
        self.assertEqual(inventory["active"]["species_count"], 333)
        self.assertEqual(inventory["active"]["pose_count"], 666)

        status, _, headers_without_revision = self.request(
            "/avian/api/cutout.php?sci=Corvus%20brachyrhynchos&bundle=" + BUILTIN_REVISION
        )
        self.assertEqual(status, 409, "revision-bound included art requires its table content key")
        self.assertIn("no-store", headers_without_revision.get("Cache-Control", ""))

        status, _, _ = self.request(
            "/avian/api/bundle-assets.php", {"If-None-Match": first_etag}
        )
        self.assertEqual(status, 304)

        dims = json.loads(dims_path.read_text(encoding="utf-8"))
        dims["corvus-brachyrhynchos"][0] -= 1
        dims_path.write_text(json.dumps(dims, separators=(",", ":")) + "\n", encoding="utf-8")
        dims_path.chmod(0o660)
        status, changed_body, changed_headers = self.request(
            "/avian/api/bundle-assets.php", {"If-None-Match": first_etag}
        )
        self.assertEqual(status, 200)
        changed = json.loads(changed_body)
        self.assertEqual(changed["active"]["revision"], BUILTIN_REVISION)
        self.assertNotEqual(changed["active"]["content_revision"], first_content_revision)
        self.assertNotEqual(changed_headers["ETag"], first_etag)

        # A completed generator transaction advances the lock-file nonce even
        # when a forced replacement retains byte-identical table files. Two
        # same-size nonce rewrites must each advance the persistent image key.
        changed_content_revision = changed["active"]["content_revision"]
        self.art_revision_state.write_text("e" * 64 + "\n", encoding="ascii")
        self.art_revision_state.chmod(0o600)
        status, rewritten_body, rewritten_headers = self.request(
            "/avian/api/bundle-assets.php", {"If-None-Match": changed_headers["ETag"]}
        )
        self.assertEqual(status, 200)
        rewritten = json.loads(rewritten_body)
        self.assertNotEqual(rewritten["active"]["content_revision"], changed_content_revision)
        self.assertNotEqual(rewritten_headers["ETag"], changed_headers["ETag"])

        self.art_revision_state.write_text("f" * 64 + "\n", encoding="ascii")
        self.art_revision_state.chmod(0o600)
        status, recommitted_body, recommitted_headers = self.request(
            "/avian/api/bundle-assets.php", {"If-None-Match": rewritten_headers["ETag"]}
        )
        self.assertEqual(status, 200)
        recommitted = json.loads(recommitted_body)
        self.assertNotEqual(
            recommitted["active"]["content_revision"],
            rewritten["active"]["content_revision"],
        )
        self.assertNotEqual(recommitted_headers["ETag"], rewritten_headers["ETag"])

        status, _, _ = self.request(
            "/avian/api/cutout.php?sci=Corvus%20brachyrhynchos&pose=2&bundle="
            + BUILTIN_REVISION
            + "&content="
            + first_content_revision
        )
        self.assertEqual(status, 409, "an old table revision cannot cache newer included pixels")
        status, body, _ = self.request(
            "/avian/api/cutout.php?sci=Corvus%20brachyrhynchos&pose=2&bundle="
            + BUILTIN_REVISION
            + "&content="
            + recommitted["active"]["content_revision"]
        )
        self.assertEqual(status, 200)
        self.assertEqual(body, (ROOT / "avian/assets/illustrations/corvus-brachyrhynchos-2.png").read_bytes())

        self.art_revision_state.write_text(
            "invalid" + "!" * 57 + "\n", encoding="ascii"
        )
        self.art_revision_state.chmod(0o600)
        status, invalid_body, invalid_headers = self.request("/avian/api/bundle-assets.php")
        self.assertEqual(status, 503)
        self.assertFalse(json.loads(invalid_body)["ok"])
        self.assertIn("no-store", invalid_headers.get("Cache-Control", ""))

        # /run is tmpfs on the Pi. Recreating an empty lock after a simulated
        # reboot must not erase the persistent invalid transaction journal.
        self.generation_lock.unlink()
        self.generation_lock.touch(mode=0o600)
        self.generation_lock.chmod(0o600)
        status, reboot_body, _ = self.request("/avian/api/bundle-assets.php")
        self.assertEqual(status, 503)
        self.assertFalse(json.loads(reboot_body)["ok"])

    def test_included_cutout_revision_check_is_metadata_only(self) -> None:
        source = (ROOT / "avian/api/bundle-runtime.php").read_text(encoding="utf-8")
        start = source.index("function avian_bundle_content_revision(")
        end = source.index("/** @return array{0:resource,1:array}|null */", start)
        revision_helper = source[start:end]
        self.assertNotIn("file_get_contents", revision_helper)
        self.assertNotIn("hash_file", revision_helper)
        self.assertNotIn("hash_update", revision_helper)
        self.assertNotIn("avian_bundle_read_table", revision_helper)

    def test_included_tables_reject_world_writable_mode(self) -> None:
        self._json(self.library / "active.json", {
            "schema_version": 1,
            "active": {
                "id": BUILTIN_ID,
                "version": "1.0.0",
                "revision": BUILTIN_REVISION,
                "included": True,
                "name": "Japanese Woodblock",
            },
            "previous": None,
        })
        (self.webroot / "avian/frontend/dims.json").chmod(0o666)
        status, body, _ = self.request("/avian/api/bundle-assets.php")
        self.assertEqual(status, 503)
        self.assertFalse(json.loads(body)["ok"])

    def test_included_inventory_never_reads_midway_through_pair_update(self) -> None:
        self._json(self.library / "active.json", {
            "schema_version": 1,
            "active": {
                "id": BUILTIN_ID,
                "version": "1.0.0",
                "revision": BUILTIN_REVISION,
                "included": True,
                "name": "Japanese Woodblock",
            },
            "previous": None,
        })
        with self.generation_lock.open("r+b") as writer_lock:
            fcntl.flock(writer_lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            status, body, _ = self.request("/avian/api/bundle-assets.php")
            self.assertEqual(status, 503)
            self.assertEqual(json.loads(body)["error"], "active bundle inventory is changing")
            status, _, _ = self.request(
                "/avian/api/cutout.php?sci=Corvus%20brachyrhynchos&bundle="
                + BUILTIN_REVISION
                + "&content="
                + "0" * 64
            )
            self.assertEqual(status, 503, "included pixels cannot be read midway through generation")
            fcntl.flock(writer_lock.fileno(), fcntl.LOCK_UN)

        status, body, _ = self.request("/avian/api/bundle-assets.php")
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["ok"])


if __name__ == "__main__":
    unittest.main()
