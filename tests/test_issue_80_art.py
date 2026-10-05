import base64
import hashlib
import importlib.util
import json
import re
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SLUG = "aphelocoma-woodhouseii-2"
FLIGHT = ROOT / "avian/assets/illustrations" / f"{SLUG}.png"
PERCHED = ROOT / "avian/assets/illustrations/aphelocoma-woodhouseii.png"
FRONTEND = ROOT / "avian/frontend"
GOOD_RGBA_SHA256 = (
    "8f0529a8389a1254688b4ddf640694b2847658a115dfb20fddf5831dead65296"
)
BROKEN_RGBA_SHA256 = (
    "86866be86c952f0bffbb2a8c6db934d610cfd375812cf4de9feb24b15c740b82"
)
PERCHED_FILE_SHA256 = (
    "c6961952f92ba7cacc242daf95392f8f0f291767a11f3306ffe1fa37ee3851fa"
)
MASK_BITS_SHA256 = (
    "4b2da671855cef4dee9c61d71c95bb20e3e0ed9e780897ab1ce3ef1e7240a347"
)


def file_sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def rgba_sha256(path):
    with Image.open(path) as image:
        return hashlib.sha256(image.convert("RGBA").tobytes()).hexdigest()


def load_build_masks():
    path = ROOT / "avian/scripts/build_masks.py"
    spec = importlib.util.spec_from_file_location("build_masks", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_approved_two_wing_flight_pixels_and_alpha_margin():
    with Image.open(FLIGHT) as image:
        assert image.mode == "RGBA"
        assert image.size == (1238, 1215)
        alpha = image.getchannel("A")
        assert alpha.getextrema() == (0, 255)
        left, top, right, bottom = alpha.getbbox()
        margins = (left, top, image.width - right, image.height - bottom)
        assert min(margins) == 24

    pixels = rgba_sha256(FLIGHT)
    assert pixels == GOOD_RGBA_SHA256
    assert pixels != BROKEN_RGBA_SHA256
    assert FLIGHT.stat().st_size < 1_483_573


def test_approved_perched_pose_is_unchanged():
    assert file_sha256(PERCHED) == PERCHED_FILE_SHA256


def test_flight_tables_match_the_checked_in_art():
    dims = json.loads((FRONTEND / "dims.json").read_text(encoding="utf-8"))
    masks = json.loads((FRONTEND / "masks.json").read_text(encoding="utf-8"))
    assert set(dims) == set(masks)

    expected_dims, expected_masks = load_build_masks().build_tables(
        FLIGHT.parent, only={SLUG}
    )
    assert dims[SLUG] == expected_dims[SLUG] == [560, 550]
    assert masks[SLUG] == expected_masks[SLUG]
    assert masks[SLUG]["w"] == 93
    assert masks[SLUG]["h"] == 91

    bits = base64.b64decode(masks[SLUG]["bits"], validate=True)
    assert sum(bin(byte).count("1") for byte in bits) == 3330
    assert hashlib.sha256(bits).hexdigest() == MASK_BITS_SHA256


def test_cache_revision_is_narrow_and_reaches_every_image_builder():
    apt = (FRONTEND / "apt.js").read_text(encoding="utf-8")
    index = (FRONTEND / "index.html").read_text(encoding="utf-8")
    cutout = (ROOT / "avian/api/cutout.php").read_text(encoding="utf-8")

    assert re.search(r"var SKETCH_VERSION = '[^']+'", apt)
    assert re.search(r"var IMG_VERSION = '[^']+'", apt)
    assert re.search(r"var TABLE_VERSION = '[^']+'", apt)
    revisions = re.search(
        r"var ART_REVISIONS = \{(?P<body>.*?)\n  \};", apt, re.S
    )
    assert revisions
    revision_map = dict(
        re.findall(r"'([^']+)'\s*:\s*'([^']+)'", revisions.group("body"))
    )
    assert revision_map["aphelocoma-woodhouseii"] == "anatomy-1"

    assert (
        "return base + '&v=' + artRevision(sci, version || SKETCH_VERSION);"
        in apt
    )
    assert "'&v=' + artRevision(s.sci, SKETCH_VERSION);" in apt
    assert "'&v=' + artRevision(sci, SKETCH_VERSION);" in apt
    assert "var q = '?v=' + TABLE_VERSION" in apt
    assert re.search(r'<script src="\./apt\.js\?v=[^"]+"></script>', index)

    # The same versioned endpoint resolves both bundled illustration files
    # and bundled photo cutouts, so the narrow revision covers either branch.
    assert '"/assets/illustrations/{$slug}{$poseSuffix}.png"' in cutout
    assert '"/assets/cutouts/$slug.png"' in cutout
    assert "serve_png($bundled);" in cutout
    assert "serve_png($cutout);" in cutout
