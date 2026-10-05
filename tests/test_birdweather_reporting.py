import logging
import datetime
import sys
import types
import unittest
from unittest.mock import Mock, patch

import requests

# Keep this focused unit suite runnable on development machines that do not
# have libsndfile. Every read/write call is mocked below.
try:
    import soundfile  # noqa: F401
except ModuleNotFoundError:
    soundfile_stub = types.ModuleType("soundfile")
    soundfile_stub.read = Mock()
    soundfile_stub.write = Mock()
    sys.modules["soundfile"] = soundfile_stub

try:
    import tzlocal  # noqa: F401
except ModuleNotFoundError:
    tzlocal_stub = types.ModuleType("tzlocal")
    tzlocal_stub.get_localzone = lambda: datetime.timezone.utc
    sys.modules["tzlocal"] = tzlocal_stub

try:
    import apprise  # noqa: F401
except ModuleNotFoundError:
    sys.modules["apprise"] = types.ModuleType("apprise")

from scripts.utils import reporting


TOKEN = "station-token-123"


class FakeResponse:
    def __init__(self, status=201, body=None):
        self.status_code = status
        self._body = {"success": True} if body is None else body

    def json(self):
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


class FakeSession:
    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.calls = []
        self.headers = {}
        self.trust_env = True
        self.closed = False

    def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    def close(self):
        self.closed = True


def settings(**updates):
    values = {
        "BIRDWEATHER_ID": "",
        "BIRDWEATHER_ENABLED": "0",
        "BIRDWEATHER_UPLOAD_AUDIO": "0",
        "LATITUDE": "34.8526",
        "LONGITUDE": "-82.3940",
        "MODEL": "BirdNET_GLOBAL_6K_V2.4_Model_FP16",
    }
    values.update(updates)
    return values


def file_fixture():
    return types.SimpleNamespace(
        file_name="/recordings/private-source.wav",
        iso8601="2026-08-27T12:34:00-07:00",
    )


def detection_fixture():
    return types.SimpleNamespace(
        iso8601="2026-08-27T12:34:03-07:00",
        start=3.0,
        stop=6.0,
        common_name="Carolina Wren",
        scientific_name="Thryothorus ludovicianus",
        confidence=0.91,
    )


class BirdWeatherReportingTests(unittest.TestCase):
    def test_clean_install_is_off_and_detections_only(self):
        policy = reporting.birdweather_config(settings())
        self.assertFalse(policy["enabled"])
        self.assertFalse(policy["upload_audio"])
        self.assertFalse(policy["enabled_implicit"])
        self.assertFalse(policy["upload_audio_implicit"])

    def test_legacy_token_preserves_enabled_audio_upload(self):
        policy = reporting.birdweather_config({"BIRDWEATHER_ID": TOKEN})
        self.assertTrue(policy["enabled"])
        self.assertTrue(policy["upload_audio"])
        self.assertTrue(policy["enabled_implicit"])
        self.assertTrue(policy["upload_audio_implicit"])

    def test_legacy_dot_segment_tokens_are_inert(self):
        for token in (".", ".."):
            with self.subTest(token=token):
                policy = reporting.birdweather_config({"BIRDWEATHER_ID": token})
                self.assertTrue(policy["token_configured"])
                self.assertFalse(policy["token_valid"])
                self.assertFalse(policy["enabled"])
                self.assertEqual(policy["token"], "")

    def test_new_enable_key_without_audio_permission_fails_closed(self):
        policy = reporting.birdweather_config({
            "BIRDWEATHER_ID": TOKEN,
            "BIRDWEATHER_ENABLED": "1",
        })
        self.assertTrue(policy["enabled"])
        self.assertFalse(policy["upload_audio"])

    @patch.object(reporting.requests, "Session")
    @patch.object(reporting, "get_settings")
    def test_disabled_station_never_opens_network_session(self, get_settings, session):
        get_settings.return_value = settings(
            BIRDWEATHER_ID=TOKEN,
            BIRDWEATHER_ENABLED="0",
            BIRDWEATHER_UPLOAD_AUDIO="1",
        )
        result = reporting.bird_weather(file_fixture(), [detection_fixture()])
        self.assertFalse(result["enabled"])
        session.assert_not_called()

    @patch.object(reporting.soundfile, "read")
    @patch.object(reporting.requests, "Session")
    @patch.object(reporting, "get_settings")
    def test_detections_only_never_reads_or_sends_audio(self, get_settings, session_factory, read):
        get_settings.return_value = settings(
            BIRDWEATHER_ID=TOKEN,
            BIRDWEATHER_ENABLED="1",
            BIRDWEATHER_UPLOAD_AUDIO="0",
        )
        session = FakeSession([FakeResponse()])
        session_factory.return_value = session

        result = reporting.bird_weather(file_fixture(), [detection_fixture()])

        self.assertEqual(result["detections_posted"], 1)
        self.assertFalse(result["soundscape_uploaded"])
        read.assert_not_called()
        self.assertFalse(session.trust_env)
        self.assertTrue(session.closed)
        self.assertEqual(len(session.calls), 1)
        url, kwargs = session.calls[0]
        self.assertEqual(url, f"{reporting._BIRDWEATHER_API}/{TOKEN}/detections")
        self.assertEqual(kwargs["timeout"], (5, 10))
        self.assertFalse(kwargs["allow_redirects"])
        self.assertNotIn("soundscapeId", kwargs["json"])
        self.assertNotIn("soundscapeStartTime", kwargs["json"])
        self.assertNotIn("soundscapeEndTime", kwargs["json"])
        self.assertEqual(kwargs["json"]["lat"], "34.8526")
        self.assertEqual(kwargs["json"]["lon"], "-82.3940")

    @patch.object(reporting.soundfile, "write")
    @patch.object(reporting.soundfile, "read")
    @patch.object(reporting.requests, "Session")
    @patch.object(reporting, "get_settings")
    def test_legacy_audio_upload_remains_full_recording_then_detection(
        self, get_settings, session_factory, read, write
    ):
        get_settings.return_value = {
            "BIRDWEATHER_ID": TOKEN,
            "LATITUDE": "34.8526",
            "LONGITUDE": "-82.3940",
            "MODEL": "BirdNET_GLOBAL_6K_V2.4_Model_FP16",
        }
        read.return_value = ([0.0, 0.1], 48000)
        write.side_effect = lambda buffer, *_args, **_kwargs: buffer.write(b"FLAC")
        session = FakeSession([
            FakeResponse(body={"success": True, "soundscape": {"id": 876}}),
            FakeResponse(),
        ])
        session_factory.return_value = session

        result = reporting.bird_weather(file_fixture(), [detection_fixture()])

        self.assertTrue(result["soundscape_uploaded"])
        self.assertEqual(result["detections_posted"], 1)
        read.assert_called_once_with("/recordings/private-source.wav")
        soundscape_url, soundscape = session.calls[0]
        self.assertEqual(soundscape_url, f"{reporting._BIRDWEATHER_API}/{TOKEN}/soundscapes")
        self.assertEqual(soundscape["params"], {"timestamp": "2026-08-27T12:34:00-07:00"})
        self.assertEqual(soundscape["data"], b"FLAC")
        self.assertEqual(soundscape["timeout"], (5, 15))
        self.assertFalse(soundscape["allow_redirects"])
        _, detection = session.calls[1]
        self.assertEqual(detection["json"]["soundscapeId"], 876)
        self.assertEqual(detection["json"]["soundscapeStartTime"], 3.0)
        self.assertEqual(detection["json"]["soundscapeEndTime"], 6.0)

    @patch.object(reporting.requests, "Session")
    @patch.object(reporting, "get_settings")
    def test_request_exception_never_logs_token_or_url(self, get_settings, session_factory):
        get_settings.return_value = settings(
            BIRDWEATHER_ID=TOKEN,
            BIRDWEATHER_ENABLED="1",
            BIRDWEATHER_UPLOAD_AUDIO="0",
        )
        secret_url = f"{reporting._BIRDWEATHER_API}/{TOKEN}/detections"
        session_factory.return_value = FakeSession([
            requests.ConnectionError("failed " + secret_url),
        ])
        with self.assertLogs(reporting.log, level=logging.ERROR) as captured:
            reporting.bird_weather(file_fixture(), [detection_fixture()])
        output = "\n".join(captured.output)
        self.assertNotIn(TOKEN, output)
        self.assertNotIn(secret_url, output)

    @patch.object(reporting.requests, "Session")
    @patch.object(reporting, "get_settings")
    def test_invalid_token_fails_before_network_without_echoing_it(self, get_settings, session_factory):
        invalid = "do/not/log-this"
        get_settings.return_value = settings(
            BIRDWEATHER_ID=invalid,
            BIRDWEATHER_ENABLED="1",
        )
        with self.assertLogs(reporting.log, level=logging.ERROR) as captured:
            result = reporting.bird_weather(file_fixture(), [detection_fixture()])
        self.assertFalse(result["enabled"])
        session_factory.assert_not_called()
        self.assertNotIn(invalid, "\n".join(captured.output))

    @patch.object(reporting.requests, "Session")
    @patch.object(reporting, "get_settings")
    def test_dot_segment_tokens_never_open_network_session(self, get_settings, session_factory):
        for token in (".", ".."):
            with self.subTest(token=token):
                get_settings.return_value = settings(
                    BIRDWEATHER_ID=token,
                    BIRDWEATHER_ENABLED="1",
                )
                with self.assertLogs(reporting.log, level=logging.ERROR):
                    result = reporting.bird_weather(file_fixture(), [detection_fixture()])
                self.assertFalse(result["enabled"])
        session_factory.assert_not_called()

    @patch.object(reporting.soundfile, "write")
    @patch.object(reporting.soundfile, "read")
    @patch.object(reporting.requests, "Session")
    @patch.object(reporting, "get_settings")
    def test_malformed_soundscape_json_fails_closed(
        self, get_settings, session_factory, read, write
    ):
        get_settings.return_value = settings(
            BIRDWEATHER_ID=TOKEN,
            BIRDWEATHER_ENABLED="1",
            BIRDWEATHER_UPLOAD_AUDIO="1",
        )
        read.return_value = ([0.0], 48000)
        write.side_effect = lambda buffer, *_args, **_kwargs: buffer.write(b"FLAC")
        session_factory.return_value = FakeSession([FakeResponse(body=[])])
        result = reporting.bird_weather(file_fixture(), [detection_fixture()])
        self.assertFalse(result["soundscape_uploaded"])
        self.assertEqual(result["detections_posted"], 0)


if __name__ == "__main__":
    unittest.main()
