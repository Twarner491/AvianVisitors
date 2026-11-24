import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def media(tmp_path):
    if not shutil.which('php'):
        pytest.skip('PHP is unavailable')
    if subprocess.check_output(['php', '-r', 'echo extension_loaded("sqlite3") ? "yes" : "no";']) != b'yes':
        pytest.skip('PHP SQLite3 is unavailable')
    database = tmp_path / 'birds.db'
    with sqlite3.connect(database) as db:
        db.execute('CREATE TABLE detections (Date, Time, Sci_Name, File_Name)')
    extracted = tmp_path / 'By_Date'
    directory = extracted / '2026-11-24' / 'Common_Raven'
    directory.mkdir(parents=True)

    def lookup(filename, spectrogram=True, keep_detection=True):
        with sqlite3.connect(database) as db:
            db.execute('DELETE FROM detections')
            if keep_detection:
                db.execute('INSERT INTO detections VALUES (?, ?, ?, ?)',
                           ('2026-11-24', '12:00:00', 'Corvus corax', filename))
        script = 'require $argv[1]; require $argv[2]; echo json_encode(station_latest_media($argv[3], "Corvus corax", "Common Raven", $argv[4] === "1"));'
        result = subprocess.run(['php', '-r', script, str(ROOT / 'avian/api/educator-scope.php'),
                                 str(ROOT / 'avian/api/station-media.php'), str(extracted),
                                 '1' if spectrogram else '0'], check=True, capture_output=True,
                                env={**os.environ, 'AV_EDUCATOR_BIRDS_DB': str(database)})
        return json.loads(result.stdout)

    return directory, lookup


@pytest.mark.parametrize('extension', ['mp3', 'wav', 'flac', 'ogg', 'm4a'])
def test_spectrogram_accepts_station_audio_formats(media, extension):
    directory, lookup = media
    filename = 'raven.' + extension
    image = directory / (filename + '.png')
    image.write_bytes(b'x' * 100)
    assert lookup(filename) == str(image)


@pytest.mark.parametrize('filename', ['Colibri d’Abeillé.wav', 'Eurasian (Blackbird).flac'])
def test_spectrogram_accepts_localized_station_names(media, filename):
    directory, lookup = media
    image = directory / (filename + '.png')
    image.write_bytes(b'x' * 100)
    assert lookup(filename) == str(image)


def test_corrected_detection_cannot_return_retained_spectrogram(media):
    directory, lookup = media
    (directory / 'raven.wav.png').write_bytes(b'x' * 100)
    assert lookup('raven.wav', keep_detection=False) is None


@pytest.mark.parametrize('filename', ['../raven.wav', 'sub/raven.wav', 'raven..wav', 'raven.wav\n', 'sub\\raven.wav', 'raven\x00.wav'])
def test_spectrogram_rejects_unsafe_filename(media, filename):
    directory, lookup = media
    if '\x00' not in filename:
        candidate = directory / (filename + '.png')
        candidate.parent.mkdir(parents=True, exist_ok=True)
        candidate.write_bytes(b'x' * 100)
    assert lookup(filename) is None


def test_audio_lookup_keeps_mp3_contract(media):
    directory, lookup = media
    for filename in ['raven.wav', 'raven.mp3']:
        (directory / filename).write_bytes(b'x' * 100)
    assert lookup('raven.wav', spectrogram=False) is None
    assert lookup('raven.mp3', spectrogram=False) == str(directory / 'raven.mp3')
