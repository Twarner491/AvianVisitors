"""Regression coverage for tadeongmi's reference-photo fix in PR #88."""

import importlib.util
import io
import json
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "pregen_reference_urls", ROOT / "avian/scripts/pregen.py"
)
pregen = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pregen)
JPEG = b"\xff\xd8\xffreference photo"
PNG = b"\x89PNG\r\n\x1a\nreference photo"


def wikipedia_responses(monkeypatch, original, thumbnail=None, images=None):
    """Replace only network I/O; run real URL filtering and byte detection."""
    meta = {
        "title": "Rufous hornero",
        "originalimage": {"source": original, "width": 3840, "height": 2560},
        "thumbnail": {"source": thumbnail, "width": 320, "height": 213},
    }
    images = images or {}

    def urlopen(request, timeout):
        if request.full_url.startswith(
            "https://en.wikipedia.org/api/rest_v1/page/summary/"
        ):
            return io.BytesIO(json.dumps(meta).encode())
        if request.full_url not in images:
            pytest.fail(f"Unexpected image request: {request.full_url}")
        return io.BytesIO(images[request.full_url])

    monkeypatch.setattr(pregen.urllib.request, "urlopen", urlopen)


@pytest.mark.parametrize("suffix", ["?utm_source=en.wikipedia.org", "#photo"])
@pytest.mark.parametrize("extension,data,want_ext", [
    ("jpg", JPEG, ".jpg"),
    ("JPEG", JPEG, ".jpg"),
    ("png", PNG, ".png"),
])
def test_image_path_extension_accepts_url_query_and_fragment(
    monkeypatch, suffix, extension, data, want_ext
):
    source = f"https://upload.wikimedia.org/hornero.{extension}{suffix}"
    wikipedia_responses(monkeypatch, source, images={source: data})
    assert pregen.fetch_wikipedia_thumb("Furnarius rufus", "Rufous Hornero") == (
        data, want_ext
    )


@pytest.mark.parametrize("source", [
    None, "", 42, [], {"url": "bird.jpg"}, "https://[broken/bird.jpg",
    "bird.jpg", "https://upload.wikimedia.org/bird.svg?format=.jpg",
])
def test_unusable_original_source_falls_back_to_thumbnail(monkeypatch, source):
    thumbnail = "https://upload.wikimedia.org/hornero.jpg"
    wikipedia_responses(monkeypatch, source, thumbnail, {thumbnail: JPEG})
    assert pregen.fetch_wikipedia_thumb("Furnarius rufus", "Rufous Hornero") == (
        JPEG, ".jpg"
    )


def test_image_bytes_determine_extension_not_url_hint(monkeypatch):
    source = "https://upload.wikimedia.org/hornero.jpg?utm_source=wikipedia"
    wikipedia_responses(monkeypatch, source, images={source: PNG})
    assert pregen.fetch_wikipedia_thumb("Furnarius rufus", "Rufous Hornero") == (
        PNG, ".png"
    )


def test_unrecognized_image_bytes_are_not_reference_photos(monkeypatch):
    source = "https://upload.wikimedia.org/hornero.jpg?utm_source=wikipedia"
    wikipedia_responses(monkeypatch, source, images={source: b"<html>error</html>"})
    assert pregen.fetch_wikipedia_thumb("Furnarius rufus", "Rufous Hornero") is None
