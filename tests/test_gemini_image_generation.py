"""Exercise the shared renderer at the Gemini HTTP boundary."""

import base64
import importlib
import io
import json
import sys
import urllib.error
from email.message import Message
from pathlib import Path

import pytest
from PIL import Image


@pytest.fixture
def pregen(monkeypatch):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[1] / "avian/scripts"))
    monkeypatch.delenv("GEMINI_IMAGE_MODEL", raising=False)
    return importlib.import_module("pregen")


def image_part(data=b"final image", **kwargs):
    return {"inlineData": {"mimeType": "image/png", "data": base64.b64encode(data).decode()},
            **kwargs}


def provider_response(*parts):
    return io.BytesIO(json.dumps({"candidates": [{
        "content": {"role": "model", "parts": list(parts)}, "finishReason": "STOP",
    }]}).encode())


def render(pregen, **kwargs):
    return pregen.gen_one("private-test-key", "{com_name} ({sci_name}) {pose}",
                          "Calypte anna", "Anna's Hummingbird", 2, **kwargs)


@pytest.mark.parametrize("configured,expected", [
    (None, "gemini-2.5-flash-image"),
    ("gemini-3.1-flash-lite-image", "gemini-3.1-flash-lite-image"),
])
def test_selected_model_receives_pose_and_reference_payload(pregen, tmp_path, monkeypatch,
                                                            configured, expected):
    if configured:
        monkeypatch.setenv("GEMINI_IMAGE_MODEL", configured)
    photo = tmp_path / "photo.png"
    Image.new("RGB", (480, 240), "blue").save(photo)
    anti = tmp_path / "bluejay.jpg"
    Image.new("RGB", (16, 16), "red").save(anti)
    style = tmp_path / "style.png"
    Image.new("RGB", (16, 16), "green").save(style)

    def post(req, timeout):
        assert req.full_url == (
            f"https://generativelanguage.googleapis.com/v1beta/models/{expected}:generateContent"
        )
        assert req.get_method() == "POST"
        assert req.get_header("X-goog-api-key") == "private-test-key"
        assert b"private-test-key" not in req.data
        assert timeout == 180
        payload = json.loads(req.data)
        assert payload["generationConfig"] == {"responseModalities": ["TEXT", "IMAGE"]}
        parts = payload["contents"][0]["parts"]
        assert parts[0] == {"text": "Anna's Hummingbird (Calypte anna) in flight with wings spread"}
        assert [parts[i]["text"].split()[1] for i in (1, 3, 5)] == ["1", "2", "3"]
        assert [parts[i]["inline_data"]["mime_type"] for i in (2, 4, 6)] == [
            "image/png", "image/jpeg", "image/png",
        ]
        data = base64.b64decode(parts[2]["inline_data"]["data"])
        with Image.open(io.BytesIO(data)) as image:
            assert image.size == (384, 192)
        return provider_response({"text": "illustration"}, image_part())

    monkeypatch.setattr(pregen.urllib.request, "urlopen", post)
    assert render(pregen, positive_ref=photo, anti_ref=anti, anti_ref_key="bluejay",
                  style_ref=style) == b"final image"


def test_invalid_model_stops_batch_before_starting(pregen, tmp_path, monkeypatch, capsys):
    output = tmp_path / "out"
    monkeypatch.setenv("GEMINI_IMAGE_MODEL", "secret-value?key=example")
    monkeypatch.setenv("GEMINI_API_KEY", "private-test-key")
    monkeypatch.setattr(sys, "argv", ["pregen.py", "--species", "Calypte anna|Anna",
                                    "--out", str(output), "--no-refs", "--poses", "1"])
    monkeypatch.setattr(pregen.urllib.request, "urlopen",
                        lambda *_a, **_k: pytest.fail("invalid configuration called provider"))
    assert pregen.main() == 2
    message = capsys.readouterr().err
    assert "GEMINI_IMAGE_MODEL" in message
    assert "secret-value" not in message
    assert "private-test-key" not in message
    assert not output.exists()


def test_returns_final_image_not_thinking_preview(pregen, monkeypatch):
    monkeypatch.setattr(pregen.urllib.request, "urlopen", lambda req, timeout: provider_response(
        image_part(b"interim preview", thought=True), image_part()))
    assert render(pregen) == b"final image"


def test_reports_block_reason_when_provider_returns_no_candidates(pregen, monkeypatch):
    monkeypatch.setattr(pregen.urllib.request, "urlopen", lambda req, timeout: io.BytesIO(
        b'{"candidates":[],"promptFeedback":{"blockReason":"SAFETY"}}'))
    with pytest.raises(RuntimeError, match="block=SAFETY"):
        render(pregen)


def test_retries_transient_failures_up_to_four_attempts(pregen, monkeypatch):
    attempts = []
    delays = []

    def post(req, timeout):
        attempts.append(timeout)
        headers = Message()
        if len(attempts) == 1:
            headers["Retry-After"] = "2"
        raise urllib.error.HTTPError(req.full_url, 429, "private-test-key", headers, None)

    monkeypatch.setattr(pregen.urllib.request, "urlopen", post)
    monkeypatch.setattr(pregen.time, "sleep", delays.append)
    with pytest.raises(RuntimeError, match="HTTP 429") as failure:
        render(pregen)
    assert "private-test-key" not in str(failure.value)
    assert attempts == [180, 180, 180, 180]
    assert delays == [2, 8, 16]


def test_model_not_found_is_actionable_and_not_retried(pregen, monkeypatch):
    def post(req, timeout):
        raise urllib.error.HTTPError(req.full_url, 404, "private-test-key", Message(), None)

    monkeypatch.setattr(pregen.urllib.request, "urlopen", post)
    monkeypatch.setattr(pregen.time, "sleep", lambda seconds: pytest.fail("retried model error"))
    with pytest.raises(RuntimeError, match="HTTP 404.*GEMINI_IMAGE_MODEL") as failure:
        render(pregen)
    assert "private-test-key" not in str(failure.value)


@pytest.mark.parametrize("wrapped", [False, True])
def test_timeout_does_not_reissue_paid_request(pregen, monkeypatch, wrapped):
    def post(req, timeout):
        failure = TimeoutError("private-test-key")
        if wrapped:
            raise urllib.error.URLError(failure)
        raise failure

    monkeypatch.setattr(pregen.urllib.request, "urlopen", post)
    monkeypatch.setattr(pregen.time, "sleep", lambda seconds: pytest.fail("retried read timeout"))
    with pytest.raises(RuntimeError, match="timed out") as failure:
        render(pregen)
    assert "private-test-key" not in str(failure.value)
