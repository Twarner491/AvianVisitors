import importlib.util
import contextlib
import hashlib
import io
import json
import os
import pathlib
import shutil
import stat
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
FRAME = ROOT / "frame"


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FrameBirdWeatherTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.birdweather = load_module("frame_birdweather_test", FRAME / "birdweather.py")

    def setUp(self):
        self.birdweather._drawable = None

    def dims_fixture(self, names):
        temp = tempfile.TemporaryDirectory()
        root = pathlib.Path(temp.name)
        (root / "dims.json").write_text(json.dumps({name: {} for name in names}), encoding="utf-8")
        apt = root / "apt.js"
        apt.write_text("", encoding="utf-8")
        self.addCleanup(temp.cleanup)
        return str(apt)

    def test_station_id_accepts_only_canonical_public_ids(self):
        station_id = self.birdweather.station_id
        self.assertEqual(station_id("1"), "1")
        self.assertEqual(station_id(2147483647), "2147483647")
        for value in (None, "", 0, -1, True, 1.5, "01", " 1", "1 ",
                      "https://app.birdweather.com/stations/1", "token-1",
                      "1) { id }", "2147483648"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                station_id(value)

    def test_exact_station_query_uses_variables_and_validates_identity(self):
        seen = {}

        def fake_graphql(query, timeout, variables=None, strict=False):
            seen.update(query=query, timeout=timeout, variables=variables, strict=strict)
            return {"data": {
                "station": {"id": "314"},
                "topSpecies": [
                    {"count": 2, "species": {"commonName": "House Sparrow", "scientificName": "Passer domesticus"}},
                    {"count": 8, "species": {"commonName": "American Crow", "scientificName": "Corvus brachyrhynchos"}},
                ],
            }}

        with mock.patch.object(self.birdweather, "_graphql", side_effect=fake_graphql):
            rows = self.birdweather.top_species_for_station("314", days=7, limit=60, timeout=9)
        self.assertEqual([row["n"] for row in rows], [8, 2])
        self.assertTrue(seen["strict"])
        self.assertEqual(seen["timeout"], 9)
        self.assertEqual(seen["variables"], {
            "stationId": "314",
            "stationIds": ["314"],
            "period": {"count": 7, "unit": "day"},
            "limit": 60,
        })
        self.assertNotIn("314", seen["query"])
        self.assertNotIn("ne:", seen["query"])
        self.assertNotIn("sw:", seen["query"])

    def test_station_response_shape_is_fail_closed(self):
        cases = (
            {"data": {"station": None, "topSpecies": []}},
            {"data": {"station": {"id": "315"}, "topSpecies": []}},
            {"data": {"station": {"id": "314"}, "topSpecies": {}}},
            {"data": {"station": {"id": "314"}, "topSpecies": [None]}},
            {"data": {"station": {"id": "314"}, "topSpecies": [{"count": 0, "species": {"scientificName": "Passer domesticus"}}]}},
            {"data": {"station": {"id": "314"}, "topSpecies": [{"count": 1, "species": {"scientificName": ""}}]}},
        )
        for payload in cases:
            with self.subTest(payload=payload), \
                    mock.patch.object(self.birdweather, "_graphql", return_value=payload), \
                    self.assertRaises(self.birdweather.BirdWeatherError):
                self.birdweather.top_species_for_station("314")

    def test_valid_station_with_no_detections_is_an_empty_success(self):
        payload = {"data": {"station": {"id": 314}, "topSpecies": []}}
        with mock.patch.object(self.birdweather, "_graphql", return_value=payload):
            self.assertEqual(self.birdweather.top_species_for_station(314), [])

    def test_station_mode_filters_art_without_geographic_fallback(self):
        apt = self.dims_fixture(("passer-domesticus", "corvus-brachyrhynchos"))
        rows = [
            {"sci": "Missing bird", "com": "Missing", "n": 20},
            {"sci": "Corvus brachyrhynchos", "com": "American Crow", "n": 9},
            {"sci": "Passer domesticus", "com": "House Sparrow", "n": 4},
        ]
        forbidden = mock.Mock(side_effect=AssertionError("station mode used a fallback"))
        with mock.patch.object(self.birdweather, "top_species_for_station", return_value=rows), \
                mock.patch.object(self.birdweather, "geocode", forbidden), \
                mock.patch.object(self.birdweather, "triangulate", forbidden), \
                mock.patch.object(self.birdweather, "ebird_nearby", forbidden):
            result = self.birdweather.species_for_station("314", target=1, apt_js=apt)
        self.assertEqual(result, [rows[1]])
        forbidden.assert_not_called()

    def test_station_coverage_splits_drawable_and_missing(self):
        apt = self.dims_fixture(("passer-domesticus",))
        rows = [
            {"sci": "Passer domesticus", "com": "House Sparrow", "n": 5},
            {"sci": "Corvus brachyrhynchos", "com": "American Crow", "n": 4},
        ]
        with mock.patch.object(self.birdweather, "top_species_for_station", return_value=rows):
            have, missing = self.birdweather.coverage_for_station("314", apt_js=apt)
        self.assertEqual(have, [rows[0]])
        self.assertEqual(missing, [rows[1]])

    def test_strict_transport_rejects_errors_and_oversized_bodies(self):
        class Response:
            def __init__(self, body):
                self.body = body

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, _limit):
                return self.body

        for body in (b'{"errors":[{"message":"no"}]}', b"x" * 2_000_001):
            with self.subTest(size=len(body)), \
                    mock.patch.object(self.birdweather.urllib.request, "urlopen", return_value=Response(body)), \
                    self.assertRaises(self.birdweather.BirdWeatherError):
                self.birdweather._graphql("query Test { station(id: 1) { id } }", 1, strict=True)


class FrameDisplayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.birdweather = load_module("birdweather", FRAME / "birdweather.py")
        sys.modules["birdweather"] = cls.birdweather
        if sys.version_info < (3, 11):
            sys.modules.setdefault("tomli", types.SimpleNamespace(load=lambda _stream: {}))
        cls.display = load_module("frame_display_test", FRAME / "display.py")

    def config(self, **updates):
        cfg = dict(self.display.DEFAULTS)
        cfg.update(species_source="birdweather", **updates)
        return cfg

    def test_display_routes_station_and_preserves_zip_mode(self):
        with mock.patch.object(self.birdweather, "species_for_station", return_value=[]) as station, \
                mock.patch.object(self.birdweather, "species_for_zip", return_value=[]) as zip_mode:
            self.assertEqual(self.display.fetch_species(self.config(bw_station_id="314")), [])
            station.assert_called_once_with("314", days=7)
            zip_mode.assert_not_called()

        with mock.patch.object(self.birdweather, "species_for_station", return_value=[]) as station, \
                mock.patch.object(self.birdweather, "species_for_zip", return_value=[]) as zip_mode:
            self.assertEqual(self.display.fetch_species(self.config(zip="94107")), [])
            zip_mode.assert_called_once_with("94107", country="us", days=7)
            station.assert_not_called()

    def test_display_rejects_ambiguous_or_missing_birdweather_locator(self):
        for cfg in (self.config(), self.config(zip="94107", bw_station_id="314")):
            with self.subTest(cfg=cfg), self.assertRaises(ValueError):
                self.display.fetch_species(cfg)

    def test_station_identity_is_part_of_change_signature(self):
        species = [{"sci": "Passer domesticus", "n": 5}]
        first = self.display.signature(species, self.display.birdweather_signature_scope(
            self.config(bw_station_id="314")))
        second = self.display.signature(species, self.display.birdweather_signature_scope(
            self.config(bw_station_id="315")))
        self.assertNotEqual(first, second)

    def test_unscoped_signature_stays_compatible_with_existing_frames(self):
        species = [{"sci": "Passer domesticus", "n": 5}]
        items = [("passer-domesticus", self.display._bucket(5))]
        expected = hashlib.sha256(json.dumps(items).encode()).hexdigest()[:16]
        self.assertEqual(self.display.signature(species), expected)


class FrameShootTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        playwright = types.ModuleType("playwright")
        sync_api = types.ModuleType("playwright.sync_api")
        sync_api.TimeoutError = RuntimeError
        sync_api.sync_playwright = lambda: None
        sys.modules.setdefault("playwright", playwright)
        sys.modules.setdefault("playwright.sync_api", sync_api)
        cls.shoot = load_module("frame_shoot_test", FRAME / "shoot.py")

    def test_birdweather_title_defaults_do_not_override_empty_strings(self):
        calls = []
        with mock.patch.object(self.shoot, "_serve_frontend", return_value=(object(), 1234)), \
                mock.patch.object(self.shoot, "shoot", side_effect=lambda *args, **kwargs: calls.append(kwargs)):
            self.shoot.shoot_birdweather("out.png", [], title="", subtitle="")
            self.shoot.shoot_birdweather("out.png", [], title=None, subtitle=None)
        self.assertEqual((calls[0]["title"], calls[0]["subtitle"]), ("", ""))
        self.assertEqual((calls[1]["title"], calls[1]["subtitle"]),
                         ("Avian Visitors", "Heard Today"))


class FrameGeneratorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.birdweather = sys.modules.get("birdweather") or load_module(
            "birdweather", FRAME / "birdweather.py")
        sys.modules["birdweather"] = cls.birdweather
        cls.generator = load_module("frame_generator_test", FRAME / "generate_illustrations.py")

    def test_generator_routes_station_and_preserves_zip_mode(self):
        with mock.patch.object(self.birdweather, "coverage_for_station", return_value=([{}], [])) as station, \
                mock.patch.object(sys, "argv", ["generate_illustrations.py", "--station-id", "314"]), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(self.generator.main(), 0)
            station.assert_called_once_with("314", 15)

        with mock.patch.object(self.birdweather, "coverage_for_zip", return_value=([{}], [])) as zip_mode, \
                mock.patch.object(sys, "argv", ["generate_illustrations.py", "--zip", "94107"]), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(self.generator.main(), 0)
            zip_mode.assert_called_once_with("94107", "us", 15)

    def test_generator_requires_exactly_one_locator(self):
        for args in ([], ["--zip", "94107", "--station-id", "314"]):
            with self.subTest(args=args), mock.patch.object(
                    sys, "argv", ["generate_illustrations.py", *args]), \
                    contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as raised:
                self.generator.main()
            self.assertEqual(raised.exception.code, 2)


class FrameInstallerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        candidates = (sys.executable, shutil.which("python3.11"), shutil.which("python3"))
        cls.config_python = None
        for candidate in candidates:
            if not candidate or candidate == cls.config_python:
                continue
            probe = subprocess.run(
                [candidate, "-c", "try:\n import tomllib\nexcept ModuleNotFoundError:\n import tomli"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
            if probe.returncode == 0:
                cls.config_python = candidate
                break
        if cls.config_python is None:
            raise unittest.SkipTest("frame config tests need Python tomllib or tomli")

    def make_fixture(self):
        temp = tempfile.TemporaryDirectory()
        root = pathlib.Path(temp.name)
        frame = root / "frame"
        frame.mkdir()
        (frame / "systemd").mkdir()
        for name in ("install.sh", "requirements-frame.txt", "birdweather.py",
                     "config_contract.py", "birdframe-names"):
            shutil.copy2(FRAME / name, frame / name)
        for name in ("birdframe.service", "birdframe.timer"):
            shutil.copy2(FRAME / "systemd" / name, frame / "systemd" / name)

        bin_dir = root / "bin"
        bin_dir.mkdir()
        sudo = bin_dir / "sudo"
        sudo.write_text(
            "#!/usr/bin/env bash\n"
            "if [ \"${1:-}\" = tee ]; then cat >/dev/null; fi\n"
            "exit 0\n",
            encoding="utf-8",
        )
        python = bin_dir / "python3"
        python.write_text(
            "#!/usr/bin/env bash\n"
            "case \" $* \" in\n"
            "  *\"config_contract.py \"*) exec \"$BIRDFRAME_TEST_REAL_PYTHON\" \"$@\" ;;\n"
            "esac\n"
            "case \" $* \" in\n"
            "  *\"import tomllib\"*|*\"import tomli\"*) "
            "[ \"${BIRDFRAME_TEST_SYSTEM_TOML_FAIL:-0}\" = 1 ] && exit 1 ;;\n"
            "esac\n"
            "case \" $* \" in\n"
            "  *\" --check-station \"*) [ \"${BIRDFRAME_TEST_STATION_FAIL:-0}\" = 1 ] && exit 1 ;;\n"
            "esac\n"
            "if [ \"${1:-}\" = -m ] && [ \"${2:-}\" = venv ]; then\n"
            "  mkdir -p \"$3/bin\"\n"
            "  for tool in pip playwright python; do\n"
            "    printf '#!/usr/bin/env bash\\nexit 0\\n' > \"$3/bin/$tool\"\n"
            "    chmod +x \"$3/bin/$tool\"\n"
            "  done\n"
            "fi\n"
            "exit 0\n",
            encoding="utf-8",
        )
        sleep = bin_dir / "sleep"
        sleep.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
        for path in (sudo, python, sleep):
            path.chmod(path.stat().st_mode | stat.S_IXUSR)
        home = root / "home"
        home.mkdir()
        self.addCleanup(temp.cleanup)
        return frame, home, bin_dir

    def run_install(self, *args, existing=None, extra_env=None, existing_venv=False):
        frame, home, bin_dir = self.make_fixture()
        if existing_venv:
            venv_bin = frame / ".venv" / "bin"
            venv_bin.mkdir(parents=True)
            venv_python = venv_bin / "python"
            venv_python.write_text(
                "#!/usr/bin/env bash\nexec \"$BIRDFRAME_TEST_REAL_PYTHON\" \"$@\"\n",
                encoding="utf-8",
            )
            venv_python.chmod(venv_python.stat().st_mode | stat.S_IXUSR)
        if existing is not None:
            config_dir = home / ".birdframe"
            config_dir.mkdir()
            (config_dir / "config.toml").write_text(existing, encoding="utf-8")
        env = dict(os.environ, HOME=str(home), USER="reviewer",
                   BIRDFRAME_TEST_REAL_PYTHON=self.config_python,
                   PATH=str(bin_dir) + os.pathsep + os.environ.get("PATH", ""))
        env.update(extra_env or {})
        result = subprocess.run(
            ["bash", str(frame / "install.sh"), *args],
            cwd=frame,
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=20,
            check=False,
        )
        config = home / ".birdframe" / "config.toml"
        return result, config.read_text(encoding="utf-8") if config.exists() else ""

    def test_station_id_alone_writes_exact_station_config(self):
        result, config = self.run_install("--station-id", "314")
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn('species_source = "birdweather"', config)
        self.assertIn('bw_station_id = "314"', config)
        self.assertNotRegex(config, r"(?m)^zip\s*=")
        self.assertNotIn("bw_country", config)
        self.assertIn("Installed for BirdWeather station 314", result.stdout)

        explicit, explicit_config = self.run_install("--bird-weather", "--station-id=314")
        self.assertEqual(explicit.returncode, 0, explicit.stdout)
        self.assertEqual(config, explicit_config)

    def test_fresh_zip_and_image_modes_keep_their_configs(self):
        zip_result, zip_config = self.run_install("--bird-weather", "--zip", "94107")
        self.assertEqual(zip_result.returncode, 0, zip_result.stdout)
        self.assertIn('zip = "94107"', zip_config)
        self.assertIn('bw_country = "us"', zip_config)
        self.assertNotIn("bw_station_id", zip_config)

        image_result, image_config = self.run_install(
            "--image-url", "https://bird.example/frame.png?k=review")
        self.assertEqual(image_result.returncode, 0, image_result.stdout)
        self.assertIn('image_url = "https://bird.example/frame.png?k=review"', image_config)
        self.assertNotIn('species_source = "birdweather"', image_config)

    def test_existing_source_must_match_the_requested_zip_or_image(self):
        zip_config = ('# birdframe-mode: birdweather\n'
                      'species_source = "birdweather"\n'
                      'zip = "94107"\n'
                      'bw_country = "us"\n')
        same_zip, unchanged = self.run_install(
            "--bird-weather", "--zip", "94107", existing=zip_config)
        self.assertEqual(same_zip.returncode, 0, same_zip.stdout)
        self.assertEqual(unchanged, zip_config)

        for args in (("--bird-weather", "--zip", "10001"), ("--station-id", "314")):
            with self.subTest(args=args):
                result, unchanged = self.run_install(*args, existing=zip_config)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertNotIn("1/5", result.stdout)
                self.assertEqual(unchanged, zip_config)

        image_config = ('# birdframe-mode: image\n'
                        'image_url = "https://bird.example/old.png"\n'
                        'shoot = false\n')
        same_image, unchanged = self.run_install(
            "--image-url", "https://bird.example/old.png", existing=image_config)
        self.assertEqual(same_image.returncode, 0, same_image.stdout)
        self.assertEqual(unchanged, image_config)

        different_image, unchanged = self.run_install(
            "--image-url", "https://bird.example/new.png", existing=image_config)
        self.assertNotEqual(different_image.returncode, 0, different_image.stdout)
        self.assertNotIn("1/5", different_image.stdout)
        self.assertEqual(unchanged, image_config)

    def test_existing_supported_custom_sources_remain_upgradeable(self):
        custom_local = ('# birdframe-mode: local\n'
                        'base_url = "https://birds.example.test"\n'
                        'shoot = true\n')
        result, unchanged = self.run_install(existing=custom_local)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(unchanged, custom_local)

        for bad_url in ("http://", "https://?x=1", "http:// bad host", "https://[broken"):
            with self.subTest(bad_url=bad_url):
                invalid_local = ('base_url = "' + bad_url + '"\nshoot = true\n')
                result, unchanged = self.run_install(existing=invalid_local)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertNotIn("1/5", result.stdout)
                self.assertEqual(unchanged, invalid_local)

        local_image = ('image = "~/.birdframe/frame.png"\n'
                       'shoot = false\n')
        result, unchanged = self.run_install(existing=local_image)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(unchanged, local_image)

        international_zip = ('# birdframe-mode: birdweather\n'
                             'species_source = "birdweather"\n'
                             'zip = "SW1A 1AA"\n'
                             'bw_country = "gb"\n')
        result, unchanged = self.run_install(
            "--bird-weather", "--zip", "SW1A 1AA", existing=international_zip)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(unchanged, international_zip)

        markerless_station = ('species_source = "birdweather"\n'
                              'bw_station_id = "314"\n')
        result, unchanged = self.run_install(
            "--station-id", "314", existing=markerless_station)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(unchanged, markerless_station)

    def test_existing_config_source_must_be_unambiguous_and_effective(self):
        malformed_station_configs = (
            '# birdframe-mode: birdweather\nbw_station_id = "314"\n',
            '# birdframe-mode: birdweather\nspecies_source = "birdweather"\n[wrong]\nbw_station_id = "314"\n',
            '# birdframe-mode: birdweather\nspecies_source = "birdweather"\nbw_station_id = "314\n',
            ('# birdframe-mode: birdweather\nspecies_source = "birdweather"\n'
             'bw_station_id = "313"\nbw_station_id = "314"\n'),
            ('# birdframe-mode: birdweather\nnotes = """\n'
             'species_source = "birdweather"\nbw_station_id = "314"\n"""\n'),
            ('# birdframe-mode: birdweather\nspecies_source = "birdweather"\n'
             'bw_station_id = "314"\n"zip" = "94107"\n'),
            ('# birdframe-mode: birdweather\nspecies_source = "birdweather"\n'
             'bw_station_id = "314"\nbw_station_id.extra = "x"\n'),
        )
        for existing in malformed_station_configs:
            with self.subTest(existing=existing):
                result, unchanged = self.run_install(
                    "--station-id", "314", existing=existing)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertNotIn("1/5", result.stdout)
                self.assertEqual(unchanged, existing)

        malformed_zip = ('# birdframe-mode: birdweather\n'
                         'zip = "94107"\n'
                         'bw_country = "us"\n')
        result, unchanged = self.run_install(
            "--bird-weather", "--zip", "94107", existing=malformed_zip)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertNotIn("1/5", result.stdout)
        self.assertEqual(unchanged, malformed_zip)

        ineffective_image = ('# birdframe-mode: image\n'
                              'image_url = "https://bird.example/frame.png"\n'
                              'shoot = true\n')
        result, unchanged = self.run_install(
            "--image-url", "https://bird.example/frame.png", existing=ineffective_image)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertNotIn("1/5", result.stdout)
        self.assertEqual(unchanged, ineffective_image)

        disguised_image = ('# birdframe-mode: image\n'
                           'image_url = "https://bird.example/frame.png"\n'
                           'shoot = false\n'
                           '"species_source" = "birdweather"\n'
                           '"bw_station_id" = "314"\n')
        result, unchanged = self.run_install(
            "--image-url", "https://bird.example/frame.png", existing=disguised_image)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertNotIn("1/5", result.stdout)
        self.assertEqual(unchanged, disguised_image)

        local_config = ('# birdframe-mode: local\n'
                        'base_url = "http://birdnet.local"\n'
                        'shoot = true\n')
        same_local, unchanged = self.run_install(existing=local_config)
        self.assertEqual(same_local.returncode, 0, same_local.stdout)
        self.assertEqual(unchanged, local_config)

        disguised_local = local_config + ('species_source = "birdweather"\n'
                                          'bw_station_id = "314"\n')
        result, unchanged = self.run_install(existing=disguised_local)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertNotIn("1/5", result.stdout)
        self.assertEqual(unchanged, disguised_local)

        malformed_preserved_image = ('image_url = { hidden = "source" }\n'
                                     'image = "/tmp/frame.png"\n'
                                     'shoot = false\n')
        result, unchanged = self.run_install(existing=malformed_preserved_image)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertNotIn("1/5", result.stdout)
        self.assertEqual(unchanged, malformed_preserved_image)

    def test_station_mode_rejects_conflicts_and_invalid_ids_before_install(self):
        cases = (
            ("--station-id", "0"),
            ("--station-id", "01"),
            ("--station-id", " 1"),
            ("--station-id", "token"),
            ("--station-id", "2147483648"),
            ("--bird-weather", "--zip", "94107 "),
            ("--station-id", "314", "--zip", "94107"),
            ("--zip", "94107", "--station-id", "314"),
            ("--station-id", "314", "--ebird-key", "ABC"),
            ("--station-id", "314", "--image-url", "https://example.test/frame.png"),
        )
        for args in cases:
            with self.subTest(args=args):
                result, config = self.run_install(*args)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertEqual(config, "")
                self.assertNotIn("1/5", result.stdout)

    def test_existing_config_cannot_claim_a_different_station(self):
        existing = '# birdframe-mode: birdweather\nspecies_source = "birdweather"\nbw_station_id = "313"\n'
        result, config = self.run_install("--station-id", "314", existing=existing)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("does not select BirdWeather station 314", result.stdout)
        self.assertNotIn("1/5", result.stdout)
        self.assertEqual(config, existing)

        ambiguous = existing.replace('bw_station_id = "313"',
                                     'bw_station_id = "314"\nzip = "94107"')
        result, config = self.run_install("--station-id", "314", existing=ambiguous)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertEqual(config, ambiguous)

    def test_existing_matching_station_is_left_untouched(self):
        existing = ('# birdframe-mode: birdweather\n'
                    'species_source = "birdweather"\n'
                    'bw_station_id = "314"\n'
                    'shoot_title = "Backyard birds"\n')
        result, config = self.run_install("--station-id", "314", existing=existing)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("already exists, leaving it untouched", result.stdout)
        self.assertEqual(config, existing)

        offline, unchanged = self.run_install(
            "--station-id", "314", existing=existing,
            extra_env={"BIRDFRAME_TEST_STATION_FAIL": "1"})
        self.assertEqual(offline.returncode, 0, offline.stdout)
        self.assertNotIn("Checking public BirdWeather station", offline.stdout)
        self.assertEqual(unchanged, existing)

    def test_existing_config_uses_prior_venv_parser_or_fails_before_mutation(self):
        existing = ('# birdframe-mode: birdweather\n'
                    'species_source = "birdweather"\n'
                    'bw_station_id = "314"\n')
        no_parser, unchanged = self.run_install(
            "--station-id", "314", existing=existing,
            extra_env={"BIRDFRAME_TEST_SYSTEM_TOML_FAIL": "1"})
        self.assertNotEqual(no_parser.returncode, 0, no_parser.stdout)
        self.assertIn("without Python tomllib or tomli", no_parser.stdout)
        self.assertNotIn("1/5", no_parser.stdout)
        self.assertEqual(unchanged, existing)

        prior_venv, unchanged = self.run_install(
            "--station-id", "314", existing=existing, existing_venv=True,
            extra_env={"BIRDFRAME_TEST_SYSTEM_TOML_FAIL": "1"})
        self.assertEqual(prior_venv.returncode, 0, prior_venv.stdout)
        self.assertEqual(unchanged, existing)

    def test_unavailable_station_stops_before_host_mutation(self):
        result, config = self.run_install(
            "--station-id", "314", extra_env={"BIRDFRAME_TEST_STATION_FAIL": "1"})
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("could not be verified", result.stdout)
        self.assertNotIn("1/5", result.stdout)
        self.assertEqual(config, "")


if __name__ == "__main__":
    unittest.main()
