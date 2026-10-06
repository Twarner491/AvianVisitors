import importlib.util
import contextlib
import hashlib
import io
import json
import pathlib
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
        modules = {"birdweather": cls.birdweather}
        if sys.version_info < (3, 11):
            modules["tomli"] = sys.modules.get("tomli", types.SimpleNamespace(load=lambda _stream: {}))
        module_patch = mock.patch.dict(sys.modules, modules)
        module_patch.start()
        cls.addClassCleanup(module_patch.stop)
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
        module_patch = mock.patch.dict(sys.modules, {"birdweather": cls.birdweather})
        module_patch.start()
        cls.addClassCleanup(module_patch.stop)
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



class FrameConfigContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.contract = load_module(
            "frame_config_contract_test",
            FRAME / "config_contract.py",
        )

    def verify(self, text, mode, station=None, zip_code=None, image_url=None):
        with tempfile.TemporaryDirectory() as directory:
            config = pathlib.Path(directory) / "config.toml"
            config.write_text(text, encoding="utf-8")
            return self.contract.verify(
                config,
                mode,
                station,
                zip_code,
                image_url,
            )

    def test_exact_station_contract_accepts_only_the_requested_station(self):
        station = (
            '# birdframe-mode: birdweather\n'
            'species_source = "birdweather"\n'
            'bw_station_id = "314"\n'
            'shoot_title = ""\n'
        )
        self.assertTrue(self.verify(station, "birdweather", station="314"))
        self.assertFalse(self.verify(station, "birdweather", station="313"))
        self.assertFalse(
            self.verify(
                station + 'zip = "94107"\n',
                "birdweather",
                station="314",
            )
        )

    def test_zip_image_and_preserved_local_contracts_remain_supported(self):
        zip_config = (
            '# birdframe-mode: birdweather\n'
            'species_source = "birdweather"\n'
            'zip = "SW1A 1AA"\n'
            'bw_country = "gb"\n'
        )
        self.assertTrue(
            self.verify(
                zip_config,
                "birdweather",
                zip_code="SW1A 1AA",
            )
        )
        self.assertFalse(
            self.verify(
                zip_config,
                "birdweather",
                zip_code="94107",
            )
        )

        image = (
            '# birdframe-mode: image\n'
            'image_url = "https://bird.example/frame.png"\n'
            'shoot = false\n'
        )
        self.assertTrue(
            self.verify(
                image,
                "image",
                image_url="https://bird.example/frame.png",
            )
        )
        self.assertFalse(
            self.verify(
                image,
                "image",
                image_url="https://bird.example/other.png",
            )
        )

        local = (
            'base_url = "https://birds.example.test"\n'
            'shoot = true\n'
        )
        preserved_image = (
            'image = "~/.birdframe/frame.png"\n'
            'shoot = false\n'
        )
        self.assertTrue(self.verify(local, "local"))
        self.assertTrue(self.verify(preserved_image, "local"))
        for bad_url in (
            "http://",
            "https://?x=1",
            "http:// bad host",
            "https://[broken",
        ):
            with self.subTest(bad_url=bad_url):
                self.assertFalse(
                    self.verify(
                        f'base_url = "{bad_url}"\nshoot = true\n',
                        "local",
                    )
                )

    def test_malformed_or_ambiguous_sources_fail_closed(self):
        malformed_station = (
            '# birdframe-mode: birdweather\nbw_station_id = "314"\n',
            (
                '# birdframe-mode: birdweather\n'
                'species_source = "birdweather"\n'
                '[wrong]\n'
                'bw_station_id = "314"\n'
            ),
            (
                '# birdframe-mode: birdweather\n'
                'species_source = "birdweather"\n'
                'bw_station_id = "314\n'
            ),
            (
                '# birdframe-mode: birdweather\n'
                'species_source = "birdweather"\n'
                'bw_station_id = "313"\n'
                'bw_station_id = "314"\n'
            ),
            (
                '# birdframe-mode: birdweather\n'
                'notes = """\n'
                'species_source = "birdweather"\n'
                'bw_station_id = "314"\n'
                '"""\n'
            ),
            (
                '# birdframe-mode: birdweather\n'
                'species_source = "birdweather"\n'
                'bw_station_id = "314"\n'
                '"zip" = "94107"\n'
            ),
            (
                '# birdframe-mode: birdweather\n'
                'species_source = "birdweather"\n'
                'bw_station_id = "314"\n'
                'bw_station_id.extra = "x"\n'
            ),
        )
        for config in malformed_station:
            with self.subTest(config=config):
                self.assertFalse(
                    self.verify(
                        config,
                        "birdweather",
                        station="314",
                    )
                )

        malformed_zip = (
            '# birdframe-mode: birdweather\n'
            'zip = "94107"\n'
            'bw_country = "us"\n'
        )
        self.assertFalse(
            self.verify(
                malformed_zip,
                "birdweather",
                zip_code="94107",
            )
        )

        ineffective_image = (
            '# birdframe-mode: image\n'
            'image_url = "https://bird.example/frame.png"\n'
            'shoot = true\n'
        )
        self.assertFalse(
            self.verify(
                ineffective_image,
                "image",
                image_url="https://bird.example/frame.png",
            )
        )

        disguised_image = (
            '# birdframe-mode: image\n'
            'image_url = "https://bird.example/frame.png"\n'
            'shoot = false\n'
            '"species_source" = "birdweather"\n'
            '"bw_station_id" = "314"\n'
        )
        self.assertFalse(
            self.verify(
                disguised_image,
                "image",
                image_url="https://bird.example/frame.png",
            )
        )

        disguised_local = (
            '# birdframe-mode: local\n'
            'base_url = "http://birdnet.local"\n'
            'shoot = true\n'
            'species_source = "birdweather"\n'
            'bw_station_id = "314"\n'
        )
        self.assertFalse(self.verify(disguised_local, "local"))

        malformed_preserved_image = (
            'image_url = { hidden = "source" }\n'
            'image = "/tmp/frame.png"\n'
            'shoot = false\n'
        )
        self.assertFalse(self.verify(malformed_preserved_image, "local"))


class FrameInstallerSourceTests(unittest.TestCase):
    def test_hardened_installer_retains_station_and_timer_contracts(self):
        installer = (FRAME / "install.sh").read_text(encoding="utf-8")
        self.assertTrue(installer.startswith("#!/bin/bash -p\n"))
        self.assertIn("--station-id)", installer)
        self.assertIn("--station-id=*)", installer)
        self.assertIn(
            'SANITIZED_ARGS+=(--station-id "$2")',
            installer,
        )
        self.assertIn(
            'SANITIZED_ARGS+=(--station-id "$STATION_ID")',
            installer,
        )
        self.assertIn('"$FRAME/config_contract.py"', installer)
        self.assertNotIn(
            '"$FRAME/.venv/bin/python" -c \'import tomllib\'',
            installer,
        )
        self.assertIn('printf "%s\\n" "OnActiveSec=2min"', installer)
        self.assertTrue(installer.rstrip().endswith('{ main "$@"; exit; }'))


if __name__ == "__main__":
    unittest.main()
