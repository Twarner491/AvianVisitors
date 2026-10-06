from __future__ import annotations

import importlib.util
import json
import os
import pwd
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image


FRAME = Path(__file__).resolve().parent
sys.path.insert(0, str(FRAME))
ISOLATED_ROOT = (
    os.geteuid() == 0
    and Path("/.dockerenv").is_file()
    and os.environ.get("AVIAN_BIRDFRAME_INSTALL_CONTAINER_TEST") == "1"
)
ISOLATED_ROOT_WITH_SUDO = ISOLATED_ROOT and Path("/usr/bin/sudo").is_file()

import display
import birdweather
import bundle_runtime


def _load_shoot_for_unit_tests():
    # Prefer the real dependency even when it has not been imported yet. A
    # missing dependency may be stubbed only while loading this private unit
    # module, never in the global import state used by real browser tests.
    spec = importlib.util.spec_from_file_location("bundle_test_shoot", FRAME / "shoot.py")
    module = importlib.util.module_from_spec(spec)
    try:
        import playwright.sync_api
    except ModuleNotFoundError as error:
        if error.name not in ("playwright", "playwright.sync_api"):
            raise
        playwright = types.ModuleType("playwright")
        sync_api = types.ModuleType("playwright.sync_api")
        sync_api.TimeoutError = type("PWTimeout", (Exception,), {})
        sync_api.sync_playwright = lambda: None
        playwright.sync_api = sync_api
        with mock.patch.dict(sys.modules, {
            "playwright": playwright, "playwright.sync_api": sync_api,
        }):
            spec.loader.exec_module(module)
    else:
        spec.loader.exec_module(module)
    return module


shoot = _load_shoot_for_unit_tests()


class FakeRoute:
    def __init__(self, url: str) -> None:
        self.request = types.SimpleNamespace(url=url)
        self.fulfilled: dict | None = None

    def fulfill(self, **kwargs) -> None:
        self.fulfilled = kwargs


class FrameBundleLocationTests(unittest.TestCase):
    def test_cutouts_are_bound_to_the_active_manifest_and_selection(self):
        active = {"revision": "a" * 64, "content_revision": "b" * 64}
        resolver = mock.Mock(return_value=Path("/verified/corvus-corax.png"))
        provider = mock.Mock(return_value={"active": active})
        prefix = "http://birdnet.local/avian/api/cutout.php?sci=Corvus%20corax&pose=1"
        handler = shoot._make_cutout_handler(resolver=resolver, bundle_assets=provider, errors=[])
        for suffix in ("", "&bundle=" + "a" * 64, "&bundle=" + "a" * 64 + "&content=" + "b" * 64):
            route = FakeRoute(prefix + suffix)
            handler(route)
            self.assertEqual(route.fulfilled["path"], "/verified/corvus-corax.png")
        resolver.reset_mock()
        for suffix in ("&bundle=" + "c" * 64, "&content=" + "c" * 64,
                       "&bundle=" + "a" * 64 + "&bundle=" + "a" * 64, "&content="):
            route = FakeRoute(prefix + suffix)
            handler(route)
            self.assertEqual(route.fulfilled["status"], 500)
        resolver.assert_not_called()

    def test_changed_selection_refreshes_unchanged_species(self):
        bundle = types.SimpleNamespace(drawable_slugs=frozenset({"corvus-corax"}),
                                       reference={"revision": "a" * 64, "selection_revision": "b" * 64})
        config = dict(display.DEFAULTS)
        rows = [{"sci": "Corvus corax", "n": 1}]
        saved = []
        with mock.patch.object(bundle_runtime, "active_bundle", return_value=bundle), \
             mock.patch.object(display, "load_state", return_value={"signature": None, "last_refresh": 0}), \
             mock.patch.object(display, "fetch_species", return_value=rows), \
             mock.patch.object(display, "obtain_image", return_value=Image.new("RGB", (2, 2))), \
             mock.patch.object(display, "fit_panel", side_effect=lambda image: image), \
             mock.patch.object(display, "mat_and_center", side_effect=lambda image, *_: image), \
             mock.patch.object(display, "push_panel"), \
             mock.patch.object(display, "save_state", side_effect=lambda _, signature, __: saved.append(signature)):
            self.assertTrue(display.run(config, force=True))
            bundle.reference["selection_revision"] = "c" * 64
            self.assertTrue(display.run(config, force=True))
        self.assertNotEqual(saved[0], saved[1])

    def test_station_location_is_bound_to_exact_public_station(self):
        payload = {"data": {"station": {"id": "42", "coords": {"lat": 0.0, "lon": 0.0}}}}
        with mock.patch.object(birdweather, "_graphql", return_value=payload) as graphql:
            self.assertEqual(birdweather.station_location("42"), (0.0, 0.0))
        self.assertEqual(graphql.call_args.kwargs["variables"], {"stationId": "42"})
        self.assertTrue(graphql.call_args.kwargs["strict"])
        for station in (None, {"id": "43", "coords": {"lat": 1, "lon": 2}},
                        {"id": "42", "coords": {"lat": float("nan"), "lon": 2}},
                        {"id": "42", "coords": {"lat": 91, "lon": 2}}):
            with mock.patch.object(birdweather, "_graphql", return_value={"data": {"station": station}}):
                with self.assertRaises(birdweather.BirdWeatherError):
                    birdweather.station_location("42")


class FrameBundleRenderIntegrationTests(unittest.TestCase):
    def _installed_launcher_fixture(
        self,
        root: Path,
        *,
        owner_uid: int,
        control_uid: int | None = None,
    ) -> Path:
        root.chmod(0o755)
        frame = root / "checkout" / "frame"
        vendor = frame / "vendor"
        binary = root / "usr" / "local" / "bin"
        installed_lib = root / "usr" / "local" / "lib" / "avian-birdframe"
        vendor.mkdir(parents=True)
        binary.mkdir(parents=True)
        installed_lib.mkdir(parents=True)
        for path in (
            frame.parent,
            frame,
            vendor,
            binary.parent,
            binary,
            installed_lib.parent,
            installed_lib,
        ):
            path.chmod(0o755)

        launcher = installed_lib / "avian-bundle"
        launcher.write_bytes((FRAME / "avian-bundle-installed").read_bytes())
        launcher.chmod(0o755)

        owner_file = installed_lib / "owner-uid"
        owner_file.write_text(f"{owner_uid}\n")
        owner_file.chmod(0o644)

        control = vendor / "avian-bundle-control"
        control.write_text(
            "#!/bin/sh\n"
            "printf 'uid=%s\\nhome=%s\\nuser=%s\\nlogname=%s\\n' "
            '"$(/usr/bin/id -u)" "$HOME" "$USER" "$LOGNAME"\n'
            'for argument do printf \'<%s>\\n\' "$argument"; done\n'
        )
        control.chmod(0o755)
        os.chown(control, owner_uid if control_uid is None else control_uid, -1)
        (installed_lib / "control").symlink_to(control)

        installed = binary / "avian-bundle"
        installed.symlink_to(Path("../lib/avian-birdframe/avian-bundle"))
        return installed

    @staticmethod
    def _sudo_environment(
        uid: int | str,
        *,
        identity_uid: int | None = None,
    ) -> dict[str, str]:
        numeric_uid = int(uid) if identity_uid is None else identity_uid
        invoking_user = pwd.getpwuid(numeric_uid)
        return {
            **os.environ,
            "HOME": "/root",
            "USER": "root",
            "LOGNAME": "root",
            "SUDO_GID": str(invoking_user.pw_gid),
            "SUDO_UID": str(uid),
            "SUDO_USER": invoking_user.pw_name,
        }

    @staticmethod
    def _become_user(uid: int):
        account = pwd.getpwuid(uid)

        def become_user() -> None:
            os.setgroups([])
            os.setgid(account.pw_gid)
            os.setuid(uid)

        return become_user

    def _allow_nobody_nested_sudo(self) -> None:
        sudoers = Path("/etc/sudoers.d/avian-bundle-nnp-test")
        self.assertFalse(sudoers.exists())
        try:
            sudoers.write_text("nobody ALL=(root) NOPASSWD: /usr/bin/id\n")
            sudoers.chmod(0o440)
        except BaseException:
            sudoers.unlink(missing_ok=True)
            raise
        self.addCleanup(sudoers.unlink, missing_ok=True)

    @staticmethod
    def _write_nested_sudo_probe(control: Path, *, owner_uid: int | None) -> None:
        control.write_text(
            "#!/bin/sh\n"
            "printf 'uid=%s\\nhome=%s\\nuser=%s\\nlogname=%s\\n' "
            '"$(/usr/bin/id -u)" "$HOME" "$USER" "$LOGNAME"\n'
            "nested=$(/usr/bin/sudo -n /usr/bin/id -u 2>/dev/null || "
            "printf blocked)\n"
            "printf 'nested=%s\\n' \"$nested\"\n"
        )
        control.chmod(0o755)
        if owner_uid is not None:
            os.chown(control, owner_uid, -1)

    @staticmethod
    def _nested_sudo_probe_output(uid: int) -> str:
        account = pwd.getpwuid(uid)
        return (
            f"uid={uid}\nhome={account.pw_dir}\nuser={account.pw_name}\n"
            f"logname={account.pw_name}\nnested=blocked\n"
        )

    def test_active_cutout_resolver_is_authoritative(self) -> None:
        illustration = FRAME / "test-bird.png"
        requested = []

        def resolver(scientific_name, pose):
            requested.append((scientific_name, pose))
            return illustration

        route = FakeRoute(
            "http://birdnet.local/avian/api/cutout.php?sci=Corvus%20corax&pose=2"
        )
        shoot._make_cutout_handler(
            "https://fallback.invalid/", "/tmp/fallback", resolver=resolver
        )(route)
        self.assertEqual(requested, [("Corvus corax", "flight")])
        self.assertEqual(route.fulfilled, {"path": str(illustration)})

        missing = FakeRoute(
            "http://birdnet.local/avian/api/cutout.php?sci=Calypte%20anna&pose=1"
        )
        shoot._make_cutout_handler(
            "https://fallback.invalid/",
            "/tmp/fallback",
            resolver=lambda *_: None,
        )(missing)
        self.assertEqual(missing.fulfilled["status"], 404)
        self.assertNotIn("location", missing.fulfilled)

    def test_active_cutout_integrity_failure_is_fatal_to_capture(self) -> None:
        errors = []
        route = FakeRoute(
            "http://birdnet.local/avian/api/cutout.php?sci=Corvus%20corax&pose=1"
        )

        def fail(*_):
            raise RuntimeError("checksum mismatch")

        shoot._make_cutout_handler(resolver=fail, errors=errors)(route)
        self.assertEqual(route.fulfilled["status"], 500)
        self.assertEqual(errors, ["checksum mismatch"])

    def test_display_passes_bundle_assets_to_both_local_render_modes(self) -> None:
        with tempfile.TemporaryDirectory(prefix="avian-frame-render-") as directory:
            bundle = types.SimpleNamespace(
                resolve=mock.Mock(),
                dims_path=Path(directory) / "dims.json",
                masks_path=Path(directory) / "masks.json",
                assets_response=mock.Mock(),
                drawable_slugs=frozenset({"corvus-corax"}),
            )
            calls = []

            def render_site(_url, out, **kwargs):
                calls.append(((_url, out), kwargs))
                Image.new("RGB", (2, 2), "white").save(out)

            def render_birdweather(out, species, **kwargs):
                calls.append(((out, species), kwargs))
                Image.new("RGB", (2, 2), "white").save(out)

            fake_shoot = types.ModuleType("shoot")
            fake_shoot.shoot = render_site
            fake_shoot.shoot_birdweather = render_birdweather
            base = dict(display.DEFAULTS)
            base.update(
                {
                    "cache": directory,
                    "state": str(Path(directory) / "state.json"),
                    "shoot": True,
                }
            )
            with mock.patch.dict(sys.modules, {"shoot": fake_shoot}):
                image = display.obtain_image(base, species=[], bundle=bundle)
                image.close()
                birdweather = dict(base, species_source="birdweather")
                image = display.obtain_image(
                    birdweather, species=[{"sci": "Corvus corax", "n": 1}], bundle=bundle
                )
                image.close()

            self.assertEqual(len(calls), 2)
            for _args, kwargs in calls:
                self.assertIs(kwargs["cutout_resolver"], bundle.resolve)
                self.assertEqual(kwargs["dims_path"], bundle.dims_path)
                self.assertEqual(kwargs["masks_path"], bundle.masks_path)
                self.assertIs(kwargs["bundle_assets"], bundle.assets_response)

    def test_image_url_mode_cannot_silently_ignore_an_active_bundle(self) -> None:
        config = dict(display.DEFAULTS)
        config.update(
            {
                "shoot": False,
                "species_source": "",
                "image": "",
                "image_url": "https://frame.example/render.png",
            }
        )
        bundle = types.SimpleNamespace(
            resolve=mock.Mock(),
            dims_path=Path("/dims"),
            masks_path=Path("/masks"),
            assets_response=mock.Mock(),
            drawable_slugs=frozenset({"corvus-corax"}),
        )
        with self.assertRaisesRegex(ValueError, "requires local or BirdWeather"):
            display.obtain_image(config, bundle=bundle)

    def test_birdweather_filters_against_active_inventory_not_builtins(self) -> None:
        rows = [
            {"sci": "Xenops minutus", "com": "Plain Xenops", "n": 9},
            {"sci": "Corvus corax", "com": "Common Raven", "n": 8},
        ]
        with mock.patch.object(birdweather, "geocode", return_value=(1.0, 2.0)), \
             mock.patch.object(birdweather, "top_species", return_value=rows), \
             mock.patch.object(birdweather, "triangulate", return_value=[]), \
             mock.patch.object(birdweather, "ebird_nearby", return_value=[]), \
             mock.patch.object(
                 birdweather, "drawable_slugs", return_value={"corvus-corax"}
             ):
            active = birdweather.species_for_zip(
                "94107", radii=(15,), drawable={"xenops-minutus"}
            )
            builtin = birdweather.species_for_zip("94107", radii=(15,))
        self.assertEqual([row["sci"] for row in active], ["Xenops minutus"])
        self.assertEqual([row["sci"] for row in builtin], ["Corvus corax"])

    def test_exact_station_display_uses_active_inventory_without_fallback(self) -> None:
        rows = [
            {"sci": "Xenops minutus", "com": "Plain Xenops", "n": 9},
            {"sci": "Corvus corax", "com": "Common Raven", "n": 8},
        ]
        config = dict(
            display.DEFAULTS,
            species_source="birdweather",
            bw_station_id="314",
        )
        with mock.patch.object(
            birdweather, "top_species_for_station", return_value=rows
        ), mock.patch.object(
            birdweather, "drawable_slugs", return_value={"corvus-corax"}
        ):
            species = display.fetch_species(
                config,
                drawable={"xenops-minutus"},
            )
        self.assertEqual([row["sci"] for row in species], ["Xenops minutus"])

    def test_birdweather_signature_and_no_signature_use_same_active_inventory(self) -> None:
        with tempfile.TemporaryDirectory(prefix="avian-frame-birdweather-") as directory:
            bundle = types.SimpleNamespace(
                resolve=mock.Mock(),
                dims_path=Path(directory) / "dims.json",
                masks_path=Path(directory) / "masks.json",
                assets_response=mock.Mock(),
                drawable_slugs=frozenset({"xenops-minutus"}),
                reference={"revision": "a" * 64},
            )
            config = dict(display.DEFAULTS)
            config.update(
                {
                    "species_source": "birdweather",
                    "zip": "94107",
                    "cache": directory,
                }
            )
            species = [{"sci": "Xenops minutus", "com": "Plain Xenops", "n": 2}]

            with mock.patch.object(bundle_runtime, "active_bundle", return_value=bundle), \
                 mock.patch.object(display, "fetch_species", return_value=species) as fetch, \
                 mock.patch.object(display, "obtain_image", return_value=Image.new("RGB", (2, 2))):
                self.assertTrue(
                    display.run(config, preview=str(Path(directory) / "signature.png"))
                )
            self.assertEqual(fetch.call_args.kwargs["drawable"], bundle.drawable_slugs)

            def render_birdweather(out, _species, **_kwargs):
                Image.new("RGB", (2, 2), "white").save(out)

            fake_shoot = types.ModuleType("shoot")
            fake_shoot.shoot_birdweather = render_birdweather
            with mock.patch.dict(sys.modules, {"shoot": fake_shoot}), \
                 mock.patch.object(display, "fetch_species", return_value=species) as fetch:
                image = display.obtain_image(config, species=None, bundle=bundle)
                image.close()
            self.assertEqual(fetch.call_args.kwargs["drawable"], bundle.drawable_slugs)

    def test_documentation_exposes_the_id_command(self) -> None:
        readme = (FRAME / "README.md").read_text()
        self.assertIn("sudo avian-bundle use '<BUNDLE_ID>'", readme)

    @unittest.skipUnless(
        Path("/usr/bin/setpriv").is_file(),
        "requires the target's no-new-privileges launcher",
    )
    def test_installed_symlink_launcher_resolves_checkout_and_preserves_argv(self) -> None:
        with tempfile.TemporaryDirectory(prefix="avian-frame-launcher-") as directory:
            root = Path(directory)
            root.chmod(0o755)
            frame = root / "checkout" / "frame"
            vendor = frame / "vendor"
            binary = root / "usr" / "local" / "bin"
            vendor.mkdir(parents=True)
            binary.mkdir(parents=True)
            launcher = frame / "avian-bundle"
            launcher.write_bytes((FRAME / "avian-bundle").read_bytes())
            launcher.chmod(0o755)
            control = vendor / "avian-bundle-control"
            control.write_text(
                "#!/bin/sh\n"
                "printf '%s\\n' \"$#\"\n"
                "for argument do printf '<%s>\\n' \"$argument\"; done\n"
            )
            control.chmod(0o755)
            installed = binary / "avian-bundle"
            installed.symlink_to(launcher)
            selector = "qa bundle; touch should-never-exist"
            run_uid = 65534 if os.geteuid() == 0 else None

            completed = subprocess.run(
                [str(installed), "use", selector],
                cwd=root,
                preexec_fn=(
                    self._become_user(run_uid) if run_uid is not None else None
                ),
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(completed.stdout, f"2\n<use>\n<{selector}>\n")
            self.assertFalse((root / "should-never-exist").exists())

            control.unlink()
            failed = subprocess.run(
                [str(installed), "use", "qa-frame-birds"],
                cwd=root,
                preexec_fn=(
                    self._become_user(run_uid) if run_uid is not None else None
                ),
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertNotEqual(failed.returncode, 0)
            self.assertEqual(
                failed.stderr,
                "avian-bundle: installed launcher could not resolve the frame checkout\n",
            )

    @unittest.skipIf(
        Path("/usr/bin/setpriv").is_file(),
        "only exercises the fail-closed path without setpriv",
    )
    def test_checkout_launcher_fails_closed_without_setpriv(self) -> None:
        completed = subprocess.run(
            [str(FRAME / "avian-bundle"), "use", "qa-frame-birds"],
            text=True,
            capture_output=True,
            check=False,
        )

        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("could not resolve the frame checkout", completed.stderr)

    @unittest.skipUnless(
        ISOLATED_ROOT_WITH_SUDO,
        "requires an explicitly enabled disposable root container",
    )
    def test_root_owned_installed_launcher_drops_before_checkout_control(self) -> None:
        with tempfile.TemporaryDirectory(prefix="avian-frame-installed-launcher-") as directory:
            root = Path(directory)
            invoking_uid = 65534
            invoking_user = pwd.getpwuid(invoking_uid)
            installed = self._installed_launcher_fixture(root, owner_uid=invoking_uid)
            selector = "qa bundle; touch should-never-exist"

            completed = subprocess.run(
                [str(installed), "use", selector],
                cwd=root,
                env=self._sudo_environment(invoking_uid),
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(
                completed.stdout,
                f"uid={invoking_uid}\nhome={invoking_user.pw_dir}\n"
                f"user={invoking_user.pw_name}\nlogname={invoking_user.pw_name}\n"
                f"<use>\n<{selector}>\n",
            )
            self.assertFalse((root / "should-never-exist").exists())

    @unittest.skipUnless(
        ISOLATED_ROOT_WITH_SUDO
        and Path("/usr/sbin/useradd").is_file(),
        "requires an explicitly enabled disposable root container",
    )
    def test_installed_launcher_forces_numeric_uid_resolution(self) -> None:
        collision_name = "65534"
        collision_uid = 23457
        subprocess.run(
            [
                "/usr/sbin/useradd",
                "--badname",
                "--no-create-home",
                "--uid",
                str(collision_uid),
                "--user-group",
                "--shell",
                "/bin/sh",
                collision_name,
            ],
            check=True,
        )
        self.addCleanup(
            lambda: subprocess.run(
                ["/usr/sbin/userdel", collision_name],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        )

        with tempfile.TemporaryDirectory(prefix="avian-frame-installed-launcher-") as directory:
            root = Path(directory)
            installed = self._installed_launcher_fixture(root, owner_uid=65534)
            control = root / "checkout" / "frame" / "vendor" / "avian-bundle-control"
            control.write_text(
                "#!/bin/sh\n"
                "printf 'uid=%s\\ngid=%s\\n' "
                '"$(/usr/bin/id -u)" "$(/usr/bin/id -g)"\n'
            )
            control.chmod(0o755)
            os.chown(control, 65534, -1)

            completed = subprocess.run(
                [str(installed), "use", "qa-frame-birds"],
                cwd=root,
                env=self._sudo_environment(65534),
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertIn("uid=65534\n", completed.stdout)
            self.assertIn("gid=65534\n", completed.stdout)
            self.assertNotIn(f"uid={collision_uid}\n", completed.stdout)
            self.assertNotIn(f"gid={collision_uid}\n", completed.stdout)

    @unittest.skipUnless(
        ISOLATED_ROOT_WITH_SUDO,
        "requires an explicitly enabled disposable root container",
    )
    def test_installed_launcher_rejects_root_or_noncanonical_sudo_uid(self) -> None:
        with tempfile.TemporaryDirectory(prefix="avian-frame-installed-launcher-") as directory:
            root = Path(directory)
            installed = self._installed_launcher_fixture(root, owner_uid=65534)

            for unsafe_uid in (
                "",
                "0",
                "00",
                "000",
                "065534",
                "+65534",
                "65534 ",
                "65534\n",
            ):
                with self.subTest(sudo_uid=unsafe_uid):
                    completed = subprocess.run(
                        [str(installed), "use", "qa-frame-birds"],
                        cwd=root,
                        env=self._sudo_environment(
                            unsafe_uid,
                            identity_uid=65534,
                        ),
                        text=True,
                        capture_output=True,
                        check=False,
                    )
                    self.assertNotEqual(completed.returncode, 0)
                    self.assertNotIn("uid=0", completed.stdout)
                    self.assertIn("invalid invoking user identity", completed.stderr)

    @unittest.skipUnless(
        ISOLATED_ROOT_WITH_SUDO,
        "requires an explicitly enabled disposable root container",
    )
    def test_installed_launcher_rejects_uid_other_than_control_owner(self) -> None:
        with tempfile.TemporaryDirectory(prefix="avian-frame-installed-launcher-") as directory:
            root = Path(directory)
            installed = self._installed_launcher_fixture(root, owner_uid=65534)

            completed = subprocess.run(
                [str(installed), "use", "qa-frame-birds"],
                cwd=root,
                env=self._sudo_environment(1),
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertNotEqual(completed.returncode, 0)
            self.assertEqual(completed.stdout, "")

    @unittest.skipUnless(
        ISOLATED_ROOT_WITH_SUDO,
        "requires an explicitly enabled disposable root container",
    )
    def test_installed_launcher_blocks_nested_sudo_from_mutable_control(self) -> None:
        with tempfile.TemporaryDirectory(prefix="avian-frame-installed-launcher-") as directory:
            root = Path(directory)
            installed = self._installed_launcher_fixture(root, owner_uid=65534)
            control = root / "checkout" / "frame" / "vendor" / "avian-bundle-control"
            self._write_nested_sudo_probe(control, owner_uid=65534)
            self._allow_nobody_nested_sudo()

            completed = subprocess.run(
                [str(installed), "use", "qa-frame-birds"],
                cwd=root,
                env=self._sudo_environment(65534),
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(completed.stdout, self._nested_sudo_probe_output(65534))

    @unittest.skipUnless(
        ISOLATED_ROOT_WITH_SUDO,
        "requires an explicitly enabled disposable root container",
    )
    def test_nonroot_installed_launcher_blocks_nested_sudo(self) -> None:
        with tempfile.TemporaryDirectory(prefix="avian-frame-installed-launcher-") as directory:
            root = Path(directory)
            installed = self._installed_launcher_fixture(root, owner_uid=65534)
            control = root / "checkout" / "frame" / "vendor" / "avian-bundle-control"
            self._write_nested_sudo_probe(control, owner_uid=65534)
            self._allow_nobody_nested_sudo()

            completed = subprocess.run(
                [str(installed), "use", "qa-frame-birds"],
                cwd=root,
                env=self._sudo_environment(65534),
                preexec_fn=self._become_user(65534),
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(completed.stdout, self._nested_sudo_probe_output(65534))

    @unittest.skipUnless(
        ISOLATED_ROOT_WITH_SUDO,
        "requires an explicitly enabled disposable root container",
    )
    def test_checkout_launcher_blocks_nested_sudo_when_setpriv_is_available(self) -> None:
        with tempfile.TemporaryDirectory(prefix="avian-frame-checkout-launcher-") as directory:
            root = Path(directory)
            root.chmod(0o755)
            frame = root / "frame"
            vendor = frame / "vendor"
            vendor.mkdir(parents=True)
            launcher = frame / "avian-bundle"
            launcher.write_bytes((FRAME / "avian-bundle").read_bytes())
            launcher.chmod(0o755)
            control = vendor / "avian-bundle-control"
            self._write_nested_sudo_probe(control, owner_uid=None)
            self._allow_nobody_nested_sudo()

            completed = subprocess.run(
                [str(launcher), "use", "qa-frame-birds"],
                cwd=root,
                env=self._sudo_environment(65534),
                preexec_fn=self._become_user(65534),
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(completed.stdout, self._nested_sudo_probe_output(65534))

    @unittest.skipUnless(
        ISOLATED_ROOT_WITH_SUDO,
        "requires an explicitly enabled disposable root container",
    )
    def test_nonroot_installed_launcher_is_bound_to_persisted_owner(self) -> None:
        with tempfile.TemporaryDirectory(prefix="avian-frame-installed-launcher-") as directory:
            root = Path(directory)
            installed = self._installed_launcher_fixture(root, owner_uid=65534)

            owner = subprocess.run(
                [str(installed), "use", "qa-frame-birds"],
                cwd=root,
                env=self._sudo_environment(65534),
                preexec_fn=self._become_user(65534),
                text=True,
                capture_output=True,
                check=False,
            )
            other = subprocess.run(
                [str(installed), "use", "qa-frame-birds"],
                cwd=root,
                env=self._sudo_environment(1),
                preexec_fn=self._become_user(1),
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(owner.returncode, 0, owner.stderr)
            self.assertIn("uid=65534\n", owner.stdout)
            self.assertNotEqual(other.returncode, 0)
            self.assertEqual(other.stdout, "")

    @unittest.skipUnless(
        ISOLATED_ROOT_WITH_SUDO,
        "requires an explicitly enabled disposable root container",
    )
    def test_installed_launcher_rejects_writable_control_modes(self) -> None:
        for unsafe_mode in (0o775, 0o757, 0o111, 0o644):
            with self.subTest(mode=oct(unsafe_mode)), tempfile.TemporaryDirectory(
                prefix="avian-frame-installed-launcher-"
            ) as directory:
                root = Path(directory)
                installed = self._installed_launcher_fixture(root, owner_uid=65534)
                control = (
                    root / "checkout" / "frame" / "vendor" / "avian-bundle-control"
                )
                control.chmod(unsafe_mode)

                completed = subprocess.run(
                    [str(installed), "use", "qa-frame-birds"],
                    cwd=root,
                    env=self._sudo_environment(65534),
                    text=True,
                    capture_output=True,
                    check=False,
                )

                self.assertNotEqual(completed.returncode, 0)
                self.assertEqual(completed.stdout, "")

    @unittest.skipUnless(
        ISOLATED_ROOT_WITH_SUDO,
        "requires an explicitly enabled disposable root container",
    )
    def test_installed_launcher_rejects_control_not_owned_by_bound_user(self) -> None:
        with tempfile.TemporaryDirectory(prefix="avian-frame-installed-launcher-") as directory:
            root = Path(directory)
            installed = self._installed_launcher_fixture(
                root, owner_uid=65534, control_uid=0
            )

            completed = subprocess.run(
                [str(installed), "use", "qa-frame-birds"],
                cwd=root,
                env=self._sudo_environment(65534),
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertNotEqual(completed.returncode, 0)
            self.assertEqual(completed.stdout, "")

    @unittest.skipUnless(
        os.geteuid() == 0,
        "requires root to exercise the checkout launcher guard",
    )
    def test_checkout_launcher_refuses_to_execute_control_as_root(self) -> None:
        with tempfile.TemporaryDirectory(prefix="avian-frame-checkout-launcher-") as directory:
            root = Path(directory)
            frame = root / "frame"
            vendor = frame / "vendor"
            vendor.mkdir(parents=True)
            launcher = frame / "avian-bundle"
            launcher.write_bytes((FRAME / "avian-bundle").read_bytes())
            launcher.chmod(0o755)
            control = vendor / "avian-bundle-control"
            control.write_text("#!/bin/sh\nprintf 'uid=%s\\n' \"$(/usr/bin/id -u)\"\n")
            control.chmod(0o755)

            completed = subprocess.run(
                [str(launcher), "use", "qa-frame-birds"],
                cwd=root,
                env={**os.environ, "HOME": "/root"},
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertNotEqual(completed.returncode, 0)
            self.assertEqual(completed.stdout, "")
            self.assertIn("refusing to run the checkout launcher as root", completed.stderr)

    def test_modern_bundle_assets_endpoint_is_served_from_one_active_revision(self) -> None:
        payload = {
            "ok": True,
            "active": {
                "id": "community-new-bird",
                "version": "1.0.0",
                "revision": "a" * 64,
                "included": False,
                "name": "New Bird",
                "content_revision": "a" * 64,
                "species_count": 1,
                "pose_count": 1,
            },
            "dims": {"xenops-minutus": [560, 420]},
            "masks": {"xenops-minutus": {"w": 93, "h": 70, "bits": "AQ=="}},
        }
        route = FakeRoute(
            "http://birdnet.local/avian/api/bundle-assets.php?v=bundle-runtime-v1"
        )
        provider = mock.Mock(return_value=payload)
        errors = []

        shoot._make_bundle_assets_handler(provider, errors)(route)

        provider.assert_called_once_with()
        self.assertEqual(errors, [])
        self.assertEqual(route.fulfilled["status"], 200)
        self.assertEqual(
            json.loads(route.fulfilled["body"]),
            payload,
        )


if __name__ == "__main__":
    unittest.main()
