import contextlib
import importlib.util
import io
import json
import os
import pathlib
import stat
import struct
import subprocess
import sys
import tempfile
import types
import unittest
import zlib
from unittest import mock

from PIL import Image
import pytest


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPECIES = [{"sci": "Corvus brachyrhynchos", "com": "American Crow", "n": 20}]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Response:
    def __init__(self, data, status=200):
        self.data = data
        self.status = status
        self.ok = status == 200

    def json(self):
        return self.data

    def read(self, limit):
        return json.dumps(self.data).encode()[:limit]

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


class Route:
    def __init__(self, payload, status=200):
        self.request = types.SimpleNamespace(
            url="http://station/avian/api/birdnet-api.php?action=recent&hours=24&edu=saved",
            headers={},
        )
        self.response = Response(payload, status)
        self.result = None
        self.continued = False

    def fetch(self, **kwargs):
        self.fetch_args = kwargs
        return self.response

    def fulfill(self, **kwargs):
        self.result = kwargs

    def continue_(self):
        self.continued = True


class CapturePage:
    def __init__(self, mode):
        self.mode = mode
        self.routes = {}
        self.screenshots = 0
        self.events = {}
        self.visible_surfaces = []
        self.context = types.SimpleNamespace(new_cdp_session=lambda _page: types.SimpleNamespace(
            send=lambda method, params: self.visible_surfaces.append((method, params))))

    def on(self, event, handler):
        self.events[event] = handler

    def route(self, pattern, handler):
        self.routes[pattern] = handler

    def add_init_script(self, *_args):
        pass

    def add_style_tag(self, **_kwargs):
        pass

    def goto(self, *_args, **_kwargs):
        self.routes["**/birdnet-api.php**"](Route({"species": SPECIES, "hours": 24}))
        self.events["response"](types.SimpleNamespace(
            request=types.SimpleNamespace(resource_type="image", redirected_from=None, url="http://station/bird.png"),
            status=200, ok=True, header_value=lambda _name: str(len(small_png())), body=small_png))
        return Response({})

    def wait_for_selector(self, *_args, **_kwargs):
        pass

    def query_selector(self, selector):
        return object() if selector == ".gtile" else None

    def wait_for_function(self, script, **_kwargs):
        if self.mode == "broken-image" or (self.mode == "old-frontend" and "frame" in script):
            raise TimeoutError("collage not ready")
        if self.mode == "decode-timeout" and "decode" in script:
            raise TimeoutError("image decode did not finish")
        if self.mode == "font-timeout" and "fonts.load" in script:
            raise TimeoutError("label font did not finish")
        return types.SimpleNamespace(json_value=lambda: {"token": "1", "revision": "1"})

    def evaluate(self, script, *_args):
        if "__frameImageIds" in script:
            return {"images": [{"id": 1, "src": "http://station/bird.png", "box": [10, 20, 2, 1],
                                "natural": [2, 1], "fit": "fill", "position": "50% 50%", "filter": "none"}],
                    "labels": [], "token": "1", "revision": "1"}
        if "backgroundColor" in script:
            return "rgb(255, 255, 255)"
        if "fonts.load" in script:
            return True
        if "decode" in script:
            return {"token": "1", "revision": "1"}
        if "frame" in script:
            return not (self.mode == "rerender" and self.screenshots)

    def wait_for_timeout(self, *_args):
        pass

    def screenshot(self, **kwargs):
        self.screenshots += 1
        png = io.BytesIO()
        clip = kwargs["clip"]
        Image.new("RGBA", (round(clip["width"] * 2), round(clip["height"] * 2))).save(png, "PNG")
        return png.getvalue()


class FrameCaptureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        api = types.ModuleType("playwright.sync_api")
        api.TimeoutError = TimeoutError
        api.sync_playwright = lambda: None
        with mock.patch.dict(sys.modules, {"playwright.sync_api": api}):
            cls.shoot = load("capture_shoot", "frame/shoot.py")
        cls.display = load("capture_display", "frame/display.py")

    def test_recent_errors_are_not_rewritten_as_success(self):
        for payload, status in (({"error": "database unavailable"}, 503),
                                ({"error": "bad data"}, 200),
                                ({"species": None}, 200),
                                ({"species": [None]}, 200),
                                ({"species": [{"sci": "", "n": 1}]}, 200)):
            with self.subTest(payload=payload, status=status):
                route = Route(payload, status)
                self.shoot._make_api_handler(0.04, 12, None)(route)
                self.assertFalse(route.continued)
                self.assertGreaterEqual(route.result["status"], 400)

    def test_valid_empty_response_and_scope_metadata_survive(self):
        route = Route({"species": [], "hours": 12, "educator_scope": {"id": "saved"}})
        self.shoot._make_api_handler(0.04, 12, None)(route)
        self.assertEqual(route.result["status"], 200)
        body = json.loads(route.result["body"])
        self.assertEqual(body["species"], [])
        self.assertEqual(body["educator_scope"], {"id": "saved"})
        self.assertIn("hours=12", route.fetch_args["url"])
        self.assertIn("edu=saved", route.fetch_args["url"])

    def test_floor_does_not_mutate_the_species_snapshot(self):
        species = [dict(SPECIES[0]), {"sci": "Turdus migratorius", "com": "Robin", "n": 1}]
        route = Route({})
        self.shoot._make_api_handler(0.5, 24, None, species)(route)
        self.assertEqual(species[1]["n"], 1)
        self.assertEqual(json.loads(route.result["body"])["species"][1]["n"], 10)

    def test_signature_fetch_rejects_missing_species_not_as_empty(self):
        for payload in ({"error": "database unavailable"}, {"species": None}, []):
            with self.subTest(payload=payload), mock.patch.object(
                    self.display.urllib.request, "urlopen", return_value=Response(payload)):
                with self.assertRaises((ValueError, RuntimeError)):
                    self.display.fetch_recent("http://station", 24, 5)

    def test_capture_failure_preserves_panel_state_and_next_cycle_retries(self):
        cfg = dict(self.display.DEFAULTS)
        state = {"signature": "previous", "last_refresh": 1}
        panel = []
        saves = []
        with mock.patch.object(self.display, "load_state", return_value=state), \
                mock.patch.object(self.display, "fetch_species", return_value=SPECIES), \
                mock.patch.object(self.display, "obtain_image", side_effect=RuntimeError("not ready")) as capture, \
                mock.patch.object(self.display, "push_panel", side_effect=lambda *args: panel.append(args)), \
                mock.patch.object(self.display, "save_state", side_effect=lambda *args: saves.append(args)), \
                contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
            self.display.run(cfg)
            self.display.run(cfg)
        self.assertEqual(capture.call_count, 2)
        self.assertEqual(panel, [])
        self.assertEqual(saves, [])

    def test_saved_signature_describes_captured_data_not_earlier_fetch(self):
        cfg = dict(self.display.DEFAULTS, shoot=True)
        captured = [{"sci": "Turdus migratorius", "com": "Robin", "n": 2}]
        saved = []

        def obtain(_cfg, _species, *, capture=None):
            if capture is not None:
                capture["species"] = captured
            return Image.new("RGB", (20, 20))

        with mock.patch.object(self.display, "load_state", return_value={}), \
                mock.patch.object(self.display, "fetch_species", return_value=SPECIES), \
                mock.patch.object(self.display, "obtain_image", side_effect=obtain), \
                mock.patch.object(self.display, "fit_panel", side_effect=lambda image: image), \
                mock.patch.object(self.display, "mat_and_center", side_effect=lambda image, *args: image), \
                mock.patch.object(self.display, "push_panel"), \
                mock.patch.object(self.display, "save_state", side_effect=lambda _path, sig, _now: saved.append(sig)), \
                contextlib.redirect_stdout(io.StringIO()):
            self.display.run(cfg)
        self.assertEqual(saved, [self.display.signature(captured)])

    def capture_page(self, page, output, capture=None):
        browser = mock.Mock()
        browser.new_context.return_value.new_page.return_value = page
        manager = contextlib.nullcontext(types.SimpleNamespace(
            chromium=types.SimpleNamespace(launch=lambda **_kwargs: browser)))
        with mock.patch.object(self.shoot, "sync_playwright", return_value=manager):
            kwargs = {} if capture is None else {"capture": capture}
            return self.shoot.shoot("http://station", output, timeout_ms=5,
                                    bird_names=page.mode == "font-timeout", **kwargs)

    def test_incomplete_or_changed_capture_keeps_previous_png(self):
        for mode in ("broken-image", "old-frontend", "rerender", "decode-timeout", "font-timeout"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                output = pathlib.Path(directory) / "shot.png"
                output.write_bytes(b"previous capture")
                with self.assertRaises((RuntimeError, TimeoutError)):
                    self.capture_page(CapturePage(mode), str(output))
                self.assertEqual(output.read_bytes(), b"previous capture")

    def test_completed_capture_replaces_png_and_reports_its_species(self):
        with tempfile.TemporaryDirectory() as directory:
            output = pathlib.Path(directory) / "shot.png"
            output.write_bytes(b"previous capture")
            capture = {}
            self.capture_page(CapturePage("ready"), str(output), capture)
            with Image.open(output) as result:
                self.assertEqual(result.size, (1200, 1600))
                self.assertEqual(result.getpixel((20, 40)), (255, 0, 0))
            self.assertEqual(capture["species"], SPECIES)
            self.assertEqual(list(pathlib.Path(directory).iterdir()), [output])

    def test_typography_bounds_the_visible_compositor_surface(self):
        page = CapturePage("ready")
        with self.shoot.capture_text_overlay(page, 600, 800, 2):
            pass
        self.assertEqual(len(page.visible_surfaces), page.screenshots)
        self.assertGreater(len(page.visible_surfaces), 0)
        for method, metrics in page.visible_surfaces:
            self.assertEqual(method, "Emulation.setDeviceMetricsOverride")
            self.assertEqual((metrics["width"], metrics["height"], metrics["deviceScaleFactor"]), (600, 800, 2))
            view = metrics["viewport"]
            self.assertLessEqual(view["width"] * view["height"] * 4, 120000)

    def test_replacing_capture_preserves_existing_file_permissions(self):
        for mode in (0o644, 0o640, 0o600):
            with self.subTest(mode=oct(mode)), tempfile.TemporaryDirectory() as directory:
                output = pathlib.Path(directory) / "shot.png"
                output.write_bytes(b"previous capture")
                output.chmod(mode)
                before = output.stat()
                self.capture_page(CapturePage("ready"), str(output))
                after = output.stat()
                self.assertEqual(stat.S_IMODE(after.st_mode), mode)
                self.assertEqual((after.st_uid, after.st_gid), (before.st_uid, before.st_gid))

    def test_new_capture_respects_process_umask(self):
        for mask, mode in ((0o022, 0o644), (0o027, 0o640), (0o077, 0o600)):
            with self.subTest(mask=oct(mask)), tempfile.TemporaryDirectory() as directory:
                output = pathlib.Path(directory) / "shot.png"
                previous_mask = os.umask(mask)
                try:
                    self.capture_page(CapturePage("ready"), str(output))
                finally:
                    os.umask(previous_mask)
                self.assertEqual(stat.S_IMODE(output.stat().st_mode), mode)

    def test_capture_does_not_follow_an_output_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            target = pathlib.Path(directory) / "private.png"
            target.write_bytes(b"private image")
            target.chmod(0o600)
            output = pathlib.Path(directory) / "shot.png"
            output.symlink_to(target)
            with self.assertRaises(RuntimeError):
                self.capture_page(CapturePage("ready"), str(output))
            self.assertTrue(output.is_symlink())
            self.assertEqual(target.read_bytes(), b"private image")
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)


def capture_art():
    return load("capture_art_test", "frame/capture_art.py")


def png_chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


def small_png(color=(255, 0, 0, 255)):
    output = io.BytesIO()
    Image.new("RGBA", (2, 1), color).save(output, "PNG")
    return output.getvalue()


@pytest.mark.parametrize("damage", ["iend-crc", "missing-iend", "missing-crc", "trailing",
    "duplicate-ihdr", "oversized", "chunk-length", "idat-order", "bad-zlib", "short-zlib", "animation"])
def test_decoder_rejects_malformed_png(damage):
    art = capture_art()
    png = small_png()
    ihdr, idat, iend = png[8:33], png[33:-12], png[-12:]
    variants = {
        "iend-crc": png[:-1] + bytes([png[-1] ^ 1]),
        "missing-iend": png[:-12], "missing-crc": png[:-3], "trailing": png + b"extra",
        "duplicate-ihdr": png[:33] + ihdr + png[33:],
        "oversized": png[:8] + png_chunk(b"IHDR", struct.pack(">II", 8193, 1) + png[24:29]) + png[33:],
        "chunk-length": png[:33] + b"\xff\xff\xff\xff" + png[37:],
        "idat-order": png[:33] + idat + png_chunk(b"tEXt", b"key\0value") + idat + iend,
        "bad-zlib": png[:33] + png_chunk(b"IDAT", b"invalid") + iend,
        "short-zlib": png[:33] + png_chunk(b"IDAT", idat[8:-7]) + iend,
        "animation": png[:33] + png_chunk(b"acTL", struct.pack(">II", 1, 0)) + png[33:],
    }
    with pytest.raises(RuntimeError):
        art.decode_capture_image(variants[damage])


def test_decoder_accepts_png_and_full_empty_nest_webp():
    art = capture_art()
    with art.decode_capture_image(small_png()) as decoded:
        assert decoded.mode == "RGBA" and decoded.size == (2, 1)
        assert decoded.getpixel((0, 0)) == (255, 0, 0, 255)
    nest = (ROOT / "avian/frontend/nest.webp").read_bytes()
    with Image.open(io.BytesIO(nest)) as expected, art.decode_capture_image(nest) as decoded:
        expected.load()
        assert decoded.size == expected.size
        assert decoded.tobytes() == expected.convert("RGBA").tobytes()
    for bad in (nest[:-1], nest + b"x", nest[:12] + b"broken"):
        with pytest.raises(RuntimeError):
            art.decode_capture_image(bad)


@pytest.mark.parametrize("row_bytes", [17, 34, 51, 69])
def test_png_incomplete_or_excess_scanlines_reject(row_bytes):
    from tests.png_fixtures import scanline_png
    with pytest.raises(RuntimeError):
        capture_art().decode_capture_image(scanline_png(4, 4, 8, 6, bytes(row_bytes)))


def test_png_capture_limits_precede_inflation(monkeypatch):
    from tests.png_fixtures import scanline_png
    art = capture_art()
    data = scanline_png(4, 4, 8, 6, bytes(68))

    class ForbiddenInflater:
        def decompress(self, *_args):
            raise AssertionError("oversized capture PNG reached decompression")

    monkeypatch.setattr(art, "MAX_ASSET_PIXELS", 10)
    monkeypatch.setattr(art._png_validation.zlib, "decompressobj", ForbiddenInflater)
    with pytest.raises(RuntimeError, match="dimensions exceed limits"):
        art.decode_capture_image(data)


def test_capture_art_import_and_png_decode_from_frame_cwd():
    result = subprocess.run([sys.executable, "-c",
                             "import capture_art; from pathlib import Path; "
                             "data=Path('../avian/assets/illustrations/corvus-brachyrhynchos.png').read_bytes(); "
                             "image=capture_art.decode_capture_image(data); "
                             "assert image.width > 0; image.close()"],
                            cwd=ROOT / "frame", capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize("width,height,depth,color,interlace,byte_count", [
    (3, 2, 1, 0, 0, 4),  # Each packed row is one filter plus one sample byte.
    (5, 3, 2, 0, 0, 9),
    (3, 2, 4, 0, 0, 6),
    (3, 2, 1, 3, 0, 4),
    (3, 2, 16, 0, 0, 14),
    (3, 2, 16, 2, 0, 38),
    (3, 2, 16, 4, 0, 26),
    (3, 2, 16, 6, 0, 50),
    (1, 1, 8, 6, 1, 5),  # Only Adam7 pass one is nonempty.
    (1, 2, 8, 6, 1, 10),  # Passes one and seven each contain one pixel.
    (2, 1, 8, 6, 1, 10),  # Passes one and six each contain one pixel.
    (2, 2, 8, 6, 1, 19),  # 5 + 5 + 9 bytes in passes one, six, seven.
    (3, 3, 1, 0, 1, 12),  # Six rows across five nonempty packed passes.
    (8, 8, 8, 6, 1, 271),  # 256 sample bytes plus 15 filter bytes.
])
def test_png_exact_scanline_count_across_formats(width, height, depth, color, interlace, byte_count):
    from tests.png_fixtures import scanline_png
    art = capture_art()
    good = scanline_png(width, height, depth, color, bytes(byte_count), interlace)
    with art.decode_capture_image(good) as image:
        assert image.size == (width, height)
    for wrong_count in (byte_count - 1, byte_count + 1):
        with pytest.raises(RuntimeError):
            art.decode_capture_image(scanline_png(width, height, depth, color,
                                                  bytes(wrong_count), interlace))


def small_webp(kind):
    output = io.BytesIO()
    Image.new("RGB", (2, 1), (30, 60, 90)).save(output, "WEBP", lossless=kind != b"VP8 ")
    data = output.getvalue()
    assert data[12:16] == (b"VP8L" if kind == b"VP8X" else kind)
    if kind == b"VP8X":
        # Extended canvas 2x1, with the unchanged lossless bitstream following.
        chunks = b"VP8X\x0a\x00\x00\x00\x00\x00\x00\x00\x01\x00\x00\x00\x00\x00" + data[12:]
        data = b"RIFF" + struct.pack("<I", len(chunks) + 4) + b"WEBP" + chunks
    return data


@pytest.mark.parametrize("kind,offset,dimensions", [
    (b"VP8 ", 26, b"\x00\x20\x00\x20"),  # 8192x8192 exceeds pixel budget.
    (b"VP8 ", 26, b"\x01\x20\x01\x00"),  # 8193x1 exceeds edge budget.
    (b"VP8L", 21, b"\xff\xdf\xff\x07"),
    (b"VP8L", 21, b"\x00\x20\x00\x00"),
    (b"VP8X", 24, b"\xff\x1f\x00\xff\x1f\x00"),
    (b"VP8X", 24, b"\x00\x20\x00\x00\x00\x00"),
    # A small extended canvas cannot mask an oversized inner VP8L bitstream.
    (b"VP8X", 39, b"\xff\xdf\xff\x07"),
    (b"VP8X", 39, b"\x00\x20\x00\x00"),
])
def test_webp_dimensions_reject_before_decoder_entry(monkeypatch, kind, offset, dimensions):
    art = capture_art()
    data = bytearray(small_webp(kind))
    data[offset:offset + len(dimensions)] = dimensions

    def forbidden_decoder(*_args, **_kwargs):
        raise AssertionError("Pillow entered before WebP dimensions were bounded")

    monkeypatch.setattr(art.Image, "open", forbidden_decoder)
    with pytest.raises(RuntimeError, match="dimensions exceed limits"):
        art.decode_capture_image(bytes(data))


@pytest.mark.parametrize("kind", [b"VP8 ", b"VP8L", b"VP8X"])
def test_webp_bounded_headers_still_fully_decode(kind):
    art = capture_art()
    data = small_webp(kind)
    with Image.open(io.BytesIO(data)) as expected, art.decode_capture_image(data) as decoded:
        expected.load()
        assert decoded.size == (2, 1)
        assert decoded.tobytes() == expected.convert("RGBA").tobytes()


@pytest.mark.parametrize("kind,payload", [
    (b"VP8 ", b"\x00" * 9),
    (b"VP8 ", b"\x00" * 10),  # Missing keyframe start code.
    (b"VP8 ", b"\x01\x00\x00\x9d\x01\x2a\x02\x00\x01\x00"),
    (b"VP8L", b"\x2f\x00\x00\x00"),
    (b"VP8L", b"\x00\x01\x00\x00\x00"),  # Incorrect lossless signature.
    (b"VP8L", b"\x2f\x01\x00\x00\x20"),  # Unsupported version one.
    (b"VP8X", b"\x00" * 9),
    (b"VP8X", b"\x00" * 11),
])
def test_webp_invalid_headers_reject_before_decoder_entry(monkeypatch, kind, payload):
    art = capture_art()
    chunk = kind + struct.pack("<I", len(payload)) + payload + b"\x00" * (len(payload) & 1)
    data = b"RIFF" + struct.pack("<I", len(chunk) + 4) + b"WEBP" + chunk

    def forbidden_decoder(*_args, **_kwargs):
        raise AssertionError("Pillow entered with an invalid WebP header")

    monkeypatch.setattr(art.Image, "open", forbidden_decoder)
    with pytest.raises(RuntimeError, match="invalid WebP header"):
        art.decode_capture_image(data)


@pytest.mark.parametrize("kind,header_size", [(b"VP8 ", 10), (b"VP8L", 5)])
def test_webp_valid_header_without_compressed_pixels_fails_full_decode(kind, header_size):
    art = capture_art()
    payload = small_webp(kind)[20:20 + header_size]
    chunk = kind + struct.pack("<I", len(payload)) + payload + b"\x00" * (len(payload) & 1)
    data = b"RIFF" + struct.pack("<I", len(chunk) + 4) + b"WEBP" + chunk
    with pytest.raises(RuntimeError, match="could not be fully decoded"):
        art.decode_capture_image(data)


def test_decoder_rejects_unsupported_animation_and_size_limits(monkeypatch):
    art = capture_art()
    gif = io.BytesIO()
    Image.new("RGB", (1, 1)).save(gif, "GIF")
    with pytest.raises(RuntimeError):
        art.decode_capture_image(gif.getvalue())
    frames = [Image.new("RGB", (2, 2), color) for color in ("red", "blue")]
    webp = io.BytesIO()
    frames[0].save(webp, "WEBP", save_all=True, append_images=frames[1:], duration=100)
    with pytest.raises(RuntimeError):
        art.decode_capture_image(webp.getvalue())
    with monkeypatch.context() as patch:
        patch.setattr(art, "MAX_ASSET_BYTES", 10)
        with pytest.raises(RuntimeError):
            art.decode_capture_image(small_png())
    with monkeypatch.context() as patch:
        patch.setattr(art, "MAX_ASSET_PIXELS", 1)
        with pytest.raises(RuntimeError):
            art.decode_capture_image(small_png())


def test_compositor_preserves_contain_offsets_fractional_origin_and_alpha():
    art = capture_art()
    overlay = Image.new("RGBA", (10, 10))
    overlay.putpixel((3, 4), (0, 255, 0, 128))
    records = [{"body": small_png(), "rect": [1.5, 2.5, 4, 4],
                "fit": "contain", "position": [0.5, 0.5], "shadow": None, "natural": [2, 1]}]
    output = art.compose_capture(overlay, records, (10, 10), (255, 255, 255))
    expected = Image.new("RGB", (10, 10), "white")
    for y in (4, 5):
        for x in (2, 3, 4, 5):
            expected.putpixel((x, y), (255, 0, 0))
    expected.putpixel((3, 4), (127, 128, 0))
    with Image.open(io.BytesIO(output)) as result:
        assert result.mode == "RGB"
        assert result.tobytes() == expected.tobytes()
    encoded = io.BytesIO()
    expected.save(encoded, "PNG")
    assert output == encoded.getvalue()


def test_compositor_places_measured_shadow_under_art():
    art = capture_art()
    records = [{"body": small_png(), "rect": [2, 2, 2, 1], "fit": "fill", "position": [0.5, 0.5],
                "shadow": {"offset": [0, 2], "blur": 0, "color": [0, 0, 0, 64]}, "natural": [2, 1]}]
    output = art.compose_capture(Image.new("RGBA", (8, 8)), records, (8, 8), (255, 255, 255))
    with Image.open(io.BytesIO(output)) as result:
        assert result.getpixel((2, 2)) == (255, 0, 0)
        assert result.getpixel((2, 4)) == (191, 191, 191)
        assert result.getpixel((2, 5)) == (255, 255, 255)


def test_compositor_rejects_mixed_invalid_art_and_budget_overflows(monkeypatch):
    art = capture_art()
    item = {"body": small_png(), "rect": [0, 0, 2, 1], "fit": "fill", "position": [0.5, 0.5],
            "shadow": None, "natural": [2, 1]}
    overlay = Image.new("RGBA", (2, 2))
    for items in ([item, {**item, "body": small_png()[:-12]}],
                  [item] * 513, [{**item, "natural": [1, 1]}],
                  [{**item, "rect": [0, 0, float("nan"), 1]}]):
        with pytest.raises(RuntimeError):
            art.compose_capture(overlay, items, (2, 2), (255, 255, 255))
    with pytest.raises(RuntimeError):
        art.compose_capture(overlay, [item], (4000, 4000), (255, 255, 255))
    monkeypatch.setattr(art, "MAX_RETAINED_BYTES", len(item["body"]) - 1)
    with pytest.raises(RuntimeError):
        art.compose_capture(overlay, [item], (2, 2), (255, 255, 255))


def test_response_limits_reject_before_retaining_oversized_art(monkeypatch):
    shoot = load("bounded_shoot", "frame/shoot.py")
    item = {"src": "http://station/bird", "box": [0, 0, 2, 1], "natural": [2, 1],
            "fit": "fill", "position": "50% 50%", "filter": "none"}

    def forbidden_body():
        raise AssertionError("oversized Content-Length must be rejected before body()")

    response = types.SimpleNamespace(ok=True, header_value=lambda _name: "16777217", body=forbidden_body)
    with pytest.raises(RuntimeError):
        shoot._composition_images({"images": [item]}, {item["src"]: response}, 1)
    with pytest.raises(RuntimeError):
        shoot._composition_images({"images": [item]}, {}, 1)
    response.header_value = lambda _name: "1"
    response.body = small_png
    monkeypatch.setattr(shoot.capture_art, "MAX_RETAINED_BYTES", len(small_png()) - 1)
    with pytest.raises(RuntimeError):
        shoot._composition_images({"images": [item]}, {item["src"]: response}, 1)


if __name__ == "__main__":
    unittest.main()
