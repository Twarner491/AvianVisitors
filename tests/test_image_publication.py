"""Public artwork must remain complete during failed or concurrent writes."""

import importlib
import io
import os
import socket
import shutil
import stat
import subprocess
import sys
import threading
import time
import types
import urllib.error
import urllib.request
from contextlib import contextmanager
from pathlib import Path

import pytest
from PIL import Image, ImageDraw
from tests.png_fixtures import scanline_png


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "avian/scripts"


@pytest.fixture
def modules(monkeypatch):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    return {name: importlib.import_module(name)
            for name in ("pregen", "cutout", "generate_one")}


def bird_image():
    image = Image.new("RGB", (160, 160), (240, 235, 225))
    ImageDraw.Draw(image).ellipse((55, 50, 105, 110), fill=(30, 70, 120))
    return image


def png_bytes(image):
    stream = io.BytesIO()
    image.save(stream, format="PNG")
    return stream.getvalue()


def writer(name, tmp_path, monkeypatch, modules, payload=None):
    """Mock only paid generation and model inference; leave publication real."""
    path = tmp_path / "calypte-anna.png"
    image = bird_image()
    payload = png_bytes(image) if payload is None else payload
    if name == "pregen":
        module = modules[name]
        monkeypatch.setattr(module, "gen_one", lambda *args, **kwargs: payload)
        monkeypatch.setattr(sys, "argv", ["pregen.py", "--species", "Calypte anna|Anna",
                                        "--out", str(tmp_path), "--no-refs",
                                        "--poses", "1", "--force"])
        monkeypatch.setenv("GEMINI_API_KEY", "test-key")
        return path, module.main
    if name == "cutout":
        module = modules[name]
        cut = image.convert("RGBA")
        monkeypatch.setitem(sys.modules, "rembg", types.SimpleNamespace(
            new_session=lambda model: object(), remove=lambda image, session: cut))
        monkeypatch.setattr(sys, "argv", ["cutout.py", "calypte-anna", "--force",
                                        "--dir", str(tmp_path)])
        return path, module.main
    raw = tmp_path / "raw"
    raw.mkdir()
    source = raw / path.name
    source.write_bytes(payload)
    return path, lambda: modules["generate_one"].chroma_cut(source, path)


def write_partial(target, data):
    if hasattr(target, "write"):
        target.write(data)
        target.flush()
    else:
        Path(target).write_bytes(data)


@pytest.mark.parametrize("name", ["pregen", "cutout", "generate_one"])
def test_interrupted_production_writer_preserves_previous_png(name, tmp_path, monkeypatch, modules):
    path, publish = writer(name, tmp_path, monkeypatch, modules)
    old = png_bytes(Image.new("RGB", (30, 40), "red"))
    path.write_bytes(old)

    def interrupted(image, target, *args, **kwargs):
        write_partial(target, b"partial PNG")
        raise OSError("disk full")

    monkeypatch.setattr(Image.Image, "save", interrupted)
    try:
        result = publish()
    except (OSError, RuntimeError):
        result = 1
    assert result == 1
    assert path.read_bytes() == old
    assert sorted(p.name for p in tmp_path.iterdir()) == (
        [path.name, "raw"] if name == "generate_one" else [path.name])


@pytest.mark.parametrize("name", ["pregen", "cutout", "generate_one"])
def test_readers_keep_complete_old_image_until_production_writer_finishes(
    name, tmp_path, monkeypatch, modules
):
    path, publish = writer(name, tmp_path, monkeypatch, modules)
    old = png_bytes(Image.new("RGB", (30, 40), "red"))
    path.write_bytes(old)
    started, finish = threading.Event(), threading.Event()
    original_save = Image.Image.save
    failures = []

    def slow_save(image, target, *args, **kwargs):
        buffer = io.BytesIO()
        original_save(image, buffer, format="PNG")
        encoded = buffer.getvalue()
        write_partial(target, encoded[:30])
        started.set()
        if not finish.wait(5):
            raise TimeoutError("reader did not complete")
        if hasattr(target, "write"):
            target.write(encoded[30:])
        else:
            with open(target, "ab") as stream:
                stream.write(encoded[30:])

    def run():
        try:
            publish()
        except Exception as error:
            failures.append(error)

    monkeypatch.setattr(Image.Image, "save", slow_save)
    thread = threading.Thread(target=run)
    thread.start()
    try:
        assert started.wait(2), "production path did not encode its public PNG"
        for _ in range(10):
            assert path.read_bytes() == old
            with Image.open(path) as opened:
                opened.load()
                assert opened.size == (30, 40)
    finally:
        finish.set()
        thread.join(5)
    assert not thread.is_alive()
    assert not failures
    with Image.open(path) as opened:
        opened.load()
        assert opened.size != (30, 40)


@pytest.mark.parametrize("name", ["pregen", "generate_one"])
@pytest.mark.parametrize("payload", [b"not an image", b"\x89PNG\r\n\x1a\n" + b"\0" * 2000], ids=["text", "broken-png"])
def test_invalid_generated_bytes_never_replace_public_art(name, payload, tmp_path, monkeypatch, modules):
    path, publish = writer(name, tmp_path, monkeypatch, modules, payload)
    old = png_bytes(Image.new("RGB", (30, 40), "red"))
    path.write_bytes(old)
    try:
        result = publish()
    except (OSError, RuntimeError):
        result = 1
    assert result == 1
    assert path.read_bytes() == old


@pytest.mark.parametrize("name", ["pregen", "cutout", "generate_one"])
def test_production_writer_keeps_existing_access_mode(name, tmp_path, monkeypatch, modules):
    path, publish = writer(name, tmp_path, monkeypatch, modules)
    path.write_bytes(png_bytes(bird_image()))
    path.chmod(0o664)
    publish()
    assert stat.S_IMODE(path.stat().st_mode) == 0o664
    with Image.open(path) as image:
        image.load()


@pytest.mark.parametrize("name", ["pregen", "cutout", "generate_one"])
def test_invalid_encoder_output_does_not_replace_old_image(name, tmp_path, monkeypatch, modules):
    path, publish = writer(name, tmp_path, monkeypatch, modules)
    old = png_bytes(bird_image())
    path.write_bytes(old)
    monkeypatch.setattr(Image.Image, "save", lambda image, target, **kwargs: write_partial(target, b"invalid"))
    try:
        result = publish()
    except (OSError, RuntimeError):
        result = 1
    assert result == 1
    assert path.read_bytes() == old


@pytest.mark.parametrize("name", ["pregen", "cutout", "generate_one"])
def test_missing_png_rows_in_source_are_not_normalized(name, tmp_path, monkeypatch, modules):
    pixels = bird_image().tobytes()
    # Keep the bird and 159 whole RGB rows; only the final paper row is absent.
    rows = b"".join(b"\x00" + pixels[y * 480:(y + 1) * 480] for y in range(159))
    malformed = scanline_png(160, 160, 8, 2, rows)
    path, publish = writer(name, tmp_path, monkeypatch, modules, malformed)
    old = malformed if name == "cutout" else png_bytes(bird_image())
    path.write_bytes(old)
    path.chmod(0o664)
    try:
        result = publish()
    except (OSError, RuntimeError):
        result = 1
    assert result == 1
    assert path.read_bytes() == old
    assert stat.S_IMODE(path.stat().st_mode) == 0o664


@pytest.mark.parametrize("name", ["pregen", "cutout", "generate_one"])
def test_missing_png_rows_from_encoder_preserve_previous_art(name, tmp_path, monkeypatch, modules):
    path, publish = writer(name, tmp_path, monkeypatch, modules)
    old = png_bytes(bird_image())
    path.write_bytes(old)
    path.chmod(0o664)
    malformed = scanline_png(4, 4, 8, 6, bytes(17))
    monkeypatch.setattr(Image.Image, "save", lambda image, target, **kwargs: write_partial(target, malformed))
    try:
        result = publish()
    except (OSError, RuntimeError):
        result = 1
    assert result == 1
    assert path.read_bytes() == old
    assert stat.S_IMODE(path.stat().st_mode) == 0o664
    assert not list(tmp_path.glob(".*.tmp"))


@pytest.mark.parametrize("name", ["pregen", "cutout", "generate_one"])
def test_production_writer_still_accepts_non_png_source(name, tmp_path, monkeypatch, modules):
    buffer = io.BytesIO()
    bird_image().save(buffer, "JPEG")
    path, publish = writer(name, tmp_path, monkeypatch, modules, buffer.getvalue())
    path.write_bytes(buffer.getvalue() if name == "cutout" else png_bytes(bird_image()))
    assert publish() in (None, 0)
    with Image.open(path) as image:
        image.load()
        assert image.format == "PNG"


@pytest.mark.parametrize("name", ["cutout", "generate_one"])
def test_source_validation_and_decode_use_same_buffer(name, tmp_path, monkeypatch, modules):
    import image_files
    path, publish = writer(name, tmp_path, monkeypatch, modules)
    path.write_bytes(png_bytes(bird_image()))
    source = path if name == "cutout" else tmp_path / "raw" / path.name
    validate = image_files.validate_png
    checked = False

    def change_path_after_validation(data, check_dimensions):
        nonlocal checked
        validate(data, check_dimensions)
        if not checked:
            checked = True
            source.write_bytes(b"replaced after validation")

    monkeypatch.setattr(image_files, "validate_png", change_path_after_validation)
    assert publish() in (None, 0)
    with Image.open(path) as image:
        image.load()
        assert image.width > 4 and image.height > 4


def test_generator_preserves_pillow_bomb_guard_before_png_inflation(monkeypatch, modules):
    import image_files
    import png_validation

    class ForbiddenInflater:
        def decompress(self, *_args):
            raise AssertionError("oversized PNG reached decompression")

    data = scanline_png(15, 15, 8, 6, bytes(915))
    monkeypatch.setattr(Image, "MAX_IMAGE_PIXELS", 100)
    monkeypatch.setattr(png_validation.zlib, "decompressobj", ForbiddenInflater)
    with pytest.raises(Image.DecompressionBombError):
        image_files.open_source_image(data)


def test_generator_does_not_inherit_frame_pixel_limit(modules):
    import image_files
    # Nine million gray pixels exceed the frame limit but are valid workstation input.
    data = scanline_png(3000, 3000, 8, 0, bytes(9_003_000))
    with image_files.open_source_image(data) as image:
        image.load()
        assert image.size == (3000, 3000)


def test_standalone_pregen_explains_missing_pillow(tmp_path):
    code = ("import runpy,sys,urllib.request; "
            "urllib.request.urlopen=lambda *a,**k: (_ for _ in ()).throw(RuntimeError('network disabled')); "
            "script=sys.argv.pop(1); runpy.run_path(script,run_name='__main__')")
    result = subprocess.run([sys.executable, "-S", "-c", code, str(SCRIPTS / "pregen.py"),
                             "--species", "Calypte anna|Anna", "--no-refs",
                             "--out", str(tmp_path), "--poses", "1"],
                            env={**os.environ, "GEMINI_API_KEY": "test-key", "PYTHONPATH": ""},
                            capture_output=True, text=True, timeout=10)
    assert result.returncode == 2
    assert "Pillow" in result.stderr
    assert "Traceback" not in result.stderr


def test_atomic_replace_failure_keeps_destination_and_cleans_staging(tmp_path, monkeypatch, modules):
    from image_files import save_png_atomic
    path = tmp_path / "bird.png"
    old = png_bytes(bird_image())
    path.write_bytes(old)

    def failed_replace(source, destination):
        raise OSError("replace denied")

    monkeypatch.setattr(os, "replace", failed_replace)
    with pytest.raises(OSError, match="replace denied"):
        save_png_atomic(Image.new("RGB", (9, 7), "blue"), path)
    assert path.read_bytes() == old
    assert list(tmp_path.iterdir()) == [path]


def test_new_public_png_is_readable_with_restrictive_umask(tmp_path, modules):
    from image_files import save_png_atomic
    path = tmp_path / "bird.png"
    previous_umask = os.umask(0o077)
    try:
        save_png_atomic(bird_image(), path)
    finally:
        os.umask(previous_umask)
    assert stat.S_IMODE(path.stat().st_mode) == 0o644
    with Image.open(path) as image:
        image.load()


def test_on_demand_invalid_generation_keeps_public_image_and_failure_state(tmp_path, monkeypatch, modules):
    module = modules["generate_one"]
    path = tmp_path / "calypte-anna.png"
    old = png_bytes(bird_image())
    path.write_bytes(old)
    generation_lock = tmp_path / ".lock"
    generation_lock.touch()
    monkeypatch.setattr(module, "ILLUS", tmp_path)
    monkeypatch.setattr(module, "RAW", tmp_path / "raw")
    monkeypatch.setattr(module, "CUTS", tmp_path / "cuts.json")
    monkeypatch.setattr(module, "STATE", tmp_path / "state.json")
    monkeypatch.setattr(module, "GENERATION_LOCK", generation_lock)
    monkeypatch.setattr(module.pregen, "ensure_reference", lambda *args: None)
    monkeypatch.setattr(module.pregen, "gen_one", lambda *args, **kwargs: b"invalid generated bytes")
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.setattr(sys, "argv", ["generate_one.py", "--sci", "Calypte anna",
                                    "--com", "Anna", "--force"])
    assert module.main() == 1
    assert path.read_bytes() == old
    assert (tmp_path / "raw" / path.name).read_bytes() == b"invalid generated bytes"
    import json
    state = json.loads((tmp_path / "state.json").read_text())
    assert state["ok"] is False
    assert state["running"] is False
    assert not (tmp_path / "cuts.json").exists()


@pytest.mark.parametrize("name", ["pregen", "cutout", "generate_one"])
def test_production_writer_rejects_symlink_destination(name, tmp_path, monkeypatch, modules):
    path, publish = writer(name, tmp_path, monkeypatch, modules)
    target = tmp_path / "private.png"
    old = png_bytes(bird_image())
    target.write_bytes(old)
    path.symlink_to(target)
    try:
        result = publish()
    except (OSError, ValueError):
        result = 1
    assert result == 1
    assert path.is_symlink()
    assert target.read_bytes() == old


def test_web_runtime_can_replace_station_owned_group_writable_art(tmp_path):
    if sys.platform != "linux" or os.getuid() != 0:
        pytest.skip("different-user permissions run in the disposable Linux container")
    directory = tmp_path / "shared"
    directory.mkdir()
    # Station UID 12001, web UID/GID 12002. Only group access permits this write.
    tmp_path.chmod(0o755)
    for parent in tmp_path.parents:
        if str(parent).startswith("/tmp/pytest"):
            parent.chmod(0o755)
    os.chown(directory, 12001, 12002)
    directory.chmod(0o2770)
    path = directory / "calypte-anna.png"
    path.write_bytes(png_bytes(bird_image()))
    os.chown(path, 12001, 12002)
    path.chmod(0o664)
    code = "from PIL import Image; from image_files import save_png_atomic; import sys; save_png_atomic(Image.new('RGB',(7,9),'blue'),sys.argv[1])"
    result = subprocess.run([sys.executable, "-c", code, str(path)],
                            env={**os.environ, "PYTHONPATH": str(SCRIPTS)},
                            user=12002, group=12002, extra_groups=[], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert path.stat().st_gid == 12002
    assert stat.S_IMODE(path.stat().st_mode) == 0o664
    with Image.open(path) as image:
        assert image.size == (7, 9)


def test_station_owner_outside_web_group_can_regenerate_shared_art(tmp_path):
    if sys.platform != "linux" or os.getuid() != 0:
        pytest.skip("different-user permissions run in the disposable Linux container")
    directory = tmp_path / "shared"
    directory.mkdir()
    tmp_path.chmod(0o755)
    for parent in tmp_path.parents:
        if str(parent).startswith("/tmp/pytest"):
            parent.chmod(0o755)
    os.chown(directory, 12001, 12002)
    directory.chmod(0o770)  # Installation does not set setgid on this directory.
    path = directory / "calypte-anna.png"
    path.write_bytes(png_bytes(bird_image()))
    os.chown(path, 12001, 12002)
    path.chmod(0o664)
    code = ("from PIL import Image; from image_files import save_png_atomic; import sys; "
            "Image.open(sys.argv[1]).load(); "
            "save_png_atomic(Image.new('RGB',(7,9),'blue'),sys.argv[1])")
    for uid, gid, groups in [(12001, 12001, []), (12002, 12002, [12001])]:
        result = subprocess.run([sys.executable, "-c", code, str(path)],
                                env={**os.environ, "PYTHONPATH": str(SCRIPTS)},
                                user=uid, group=gid, extra_groups=groups,
                                capture_output=True, text=True)
        assert result.returncode == 0, result.stderr
        assert stat.S_IMODE(path.stat().st_mode) == 0o664
        with Image.open(path) as image:
            image.load()
            assert image.size == (7, 9)


@contextmanager
def php_endpoint(tmp_path, prepend="", extra_env=None):
    php = shutil.which("php")
    if not php:
        pytest.skip("PHP is required for endpoint integration")
    station = tmp_path / "station"
    api = station / "avian/api"
    api.mkdir(parents=True)
    for name in ("cutout.php", "admin-auth.php", "admin-state.php", "educator-state.php"):
        shutil.copy2(ROOT / "avian/api" / name, api / name)
    (station / "avian/assets/illustrations").mkdir(parents=True)
    prepend_path = tmp_path / "prepend.php"
    prepend_path.write_text(prepend)
    with socket.socket() as reserved:
        reserved.bind(("127.0.0.1", 0))
        port = reserved.getsockname()[1]
    with (tmp_path / "php.log").open("w+") as log:
        process = subprocess.Popen([php, "-d", f"auto_prepend_file={prepend_path}",
                                    "-S", f"127.0.0.1:{port}", "-t", str(station)],
                                   env={**os.environ, **(extra_env or {})}, stdout=log, stderr=log)
        try:
            for _ in range(100):
                try:
                    with socket.create_connection(("127.0.0.1", port), timeout=.1):
                        break
                except OSError:
                    if process.poll() is not None:
                        log.seek(0)
                        pytest.fail(log.read())
                    time.sleep(.02)
            yield station, f"http://127.0.0.1:{port}/avian/api/cutout.php?sci=Calypte+anna"
        finally:
            process.terminate()
            process.wait(5)


# Swap the file when PHP opens it, after the path-size lookup. Run the actual
# endpoint unchanged so the assertion covers its real headers and response.
SWAP_ON_OPEN = r'''<?php
class PublicationFiles {
    public $context;
    private $handle;
    public function stream_open($path, $mode, $options, &$opened_path) {
        stream_wrapper_restore('file');
        if (str_ends_with($path, '/calypte-anna.png')) {
            if (getenv('FAIL_IMAGE_OPEN')) {
                stream_wrapper_unregister('file');
                stream_wrapper_register('file', self::class);
                return false;
            }
            $replacement = getenv('REPLACEMENT');
            if (is_file($replacement)) rename($replacement, $path);
        }
        $this->handle = fopen($path, $mode);
        stream_wrapper_unregister('file');
        stream_wrapper_register('file', self::class);
        return $this->handle !== false;
    }
    public function url_stat($path, $flags) {
        stream_wrapper_restore('file');
        $result = @stat($path);
        stream_wrapper_unregister('file');
        stream_wrapper_register('file', self::class);
        return $result;
    }
    public function stream_stat() {
        return getenv('FAIL_IMAGE_STAT') ? false : fstat($this->handle);
    }
    public function stream_read($count) { return fread($this->handle, $count); }
    public function stream_eof() { return feof($this->handle); }
    public function stream_seek($offset, $whence) { return fseek($this->handle, $offset, $whence) === 0; }
    public function stream_tell() { return ftell($this->handle); }
    public function stream_close() { fclose($this->handle); }
    public function stream_set_option($option, $arg1, $arg2) { return false; }
}
stream_wrapper_unregister('file');
stream_wrapper_register('file', PublicationFiles::class);
'''


def test_php_content_length_and_bytes_follow_same_opened_version(tmp_path):
    old = png_bytes(Image.effect_noise((80, 80), 50).convert("RGB"))
    new = png_bytes(Image.effect_noise((130, 120), 50).convert("RGB"))
    replacement = tmp_path / "replacement.png"
    replacement.write_bytes(new)
    with php_endpoint(tmp_path, SWAP_ON_OPEN, {"REPLACEMENT": str(replacement)}) as (station, url):
        (station / "avian/assets/illustrations/calypte-anna.png").write_bytes(old)
        with urllib.request.urlopen(url, timeout=5) as response:
            body = response.read()
            assert response.status == 200
            assert int(response.headers["Content-Length"]) == len(new)
            assert body == new
            with Image.open(io.BytesIO(body)) as image:
                image.load()
                assert image.size == (130, 120)


@pytest.mark.parametrize("failure", ["FAIL_IMAGE_OPEN", "FAIL_IMAGE_STAT"])
def test_php_failed_image_open_or_stat_is_not_successful_image_response(tmp_path, failure):
    with php_endpoint(tmp_path, SWAP_ON_OPEN, {failure: "1"}) as (station, url):
        (station / "avian/assets/illustrations/calypte-anna.png").write_bytes(
            png_bytes(Image.effect_noise((80, 80), 50)))
        with pytest.raises(urllib.error.HTTPError) as failed:
            urllib.request.urlopen(url, timeout=5)
        assert failed.value.code == 500
        assert not failed.value.headers["Content-Type"].startswith("image/")


# Only Wikipedia transport is faked. The real endpoint still applies its
# authorization and detection checks before running the supplied rembg fixture.
WIKIPEDIA_FIXTURE = r'''<?php
class WikipediaFixture {
    public $context;
    private $data;
    private $offset = 0;
    public function stream_open($path, $mode, $options, &$opened_path) {
        $this->data = str_contains($path, '/page/summary/')
            ? '{"originalimage":{"source":"https://upload.wikimedia.org/bird.png"}}'
            : file_get_contents(getenv('SOURCE_PNG'));
        return true;
    }
    public function stream_read($count) {
        $part = substr($this->data, $this->offset, $count);
        $this->offset += strlen($part);
        return $part;
    }
    public function stream_eof() { return $this->offset >= strlen($this->data); }
    public function stream_stat() { return []; }
}
stream_wrapper_unregister('https');
stream_wrapper_register('https', WikipediaFixture::class);
'''


# Fault only the final GD write. rembg still creates a valid PNG, and all
# endpoint validation/publication operations execute unchanged.
FAIL_GD_WRITE = r'''
class LimitedImageWrites {
    public $context;
    private $handle;
    private $remaining;
    public function stream_open($path, $mode, $options, &$opened_path) {
        stream_wrapper_restore('file');
        $this->handle = fopen($path, $mode);
        $this->remaining = str_contains($path, '/.rembg-out-') && str_contains($mode, 'w') ? 40 : null;
        stream_wrapper_unregister('file');
        stream_wrapper_register('file', self::class);
        return $this->handle !== false;
    }
    public function stream_write($data) {
        if ($this->remaining !== null) {
            $data = substr($data, 0, $this->remaining);
            $this->remaining -= strlen($data);
        }
        return fwrite($this->handle, $data);
    }
    public function stream_read($count) { return fread($this->handle, $count); }
    public function stream_eof() { return feof($this->handle); }
    public function stream_stat() { return fstat($this->handle); }
    public function stream_flush() { return fflush($this->handle); }
    public function stream_lock($operation) { return flock($this->handle, $operation); }
    public function stream_seek($offset, $whence) { return fseek($this->handle, $offset, $whence) === 0; }
    public function stream_tell() { return ftell($this->handle); }
    public function stream_set_option($option, $arg1, $arg2) { return false; }
    public function stream_close() { fclose($this->handle); }
    public function url_stat($path, $flags) {
        stream_wrapper_restore('file');
        $result = @stat($path);
        stream_wrapper_unregister('file');
        stream_wrapper_register('file', self::class);
        return $result;
    }
    public function unlink($path) {
        stream_wrapper_restore('file');
        $result = unlink($path);
        stream_wrapper_unregister('file');
        stream_wrapper_register('file', self::class);
        return $result;
    }
    public function rename($from, $to) {
        stream_wrapper_restore('file');
        $result = rename($from, $to);
        stream_wrapper_unregister('file');
        stream_wrapper_register('file', self::class);
        return $result;
    }
    public function stream_metadata($path, $option, $value) {
        if ($option !== STREAM_META_ACCESS) return false;
        stream_wrapper_restore('file');
        $result = chmod($path, $value);
        stream_wrapper_unregister('file');
        stream_wrapper_register('file', self::class);
        return $result;
    }
}
stream_wrapper_unregister('file');
stream_wrapper_register('file', LimitedImageWrites::class);
'''


@pytest.mark.parametrize("outcome", ["malformed", "valid", "rename-failed", "gd-write-failed"])
def test_php_dynamic_output_is_decoded_before_publication(tmp_path, outcome):
    if (not Path('/.dockerenv').is_file()
            or os.environ.get('AVIAN_PUBLICATION_CONTAINER') != '1'):
        pytest.skip("requires pre-provisioned disposable publication container")
    import sqlite3
    assert Path('/usr/local/bin/rembg-cli').is_file()
    assert Path('/var/lib/avian-visitors/admin-auth.state').is_file()
    source = tmp_path / "source.png"
    source.write_bytes(png_bytes(Image.effect_noise((100, 110), 50).convert("RGB")))
    output = tmp_path / "output.png"
    output.write_bytes(b"malformed" * 300 if outcome == "malformed" else source.read_bytes())
    location = tmp_path / "output-location"
    prepend = WIKIPEDIA_FIXTURE + (FAIL_GD_WRITE if outcome == "gd-write-failed" else "")
    with php_endpoint(tmp_path, prepend,
                      {"SOURCE_PNG": str(source), "OUTPUT_PNG": str(output),
                       "OUTPUT_LOCATION": str(location)}) as (station, url):
        scripts = station / "scripts"
        scripts.mkdir()
        with sqlite3.connect(scripts / "birds.db") as database:
            database.execute("CREATE TABLE detections (Sci_Name TEXT)")
            database.execute("INSERT INTO detections VALUES ('Calypte anna')")
        cache = tmp_path / "BirdSongs/Extracted/cutouts"
        if outcome == "rename-failed":
            (cache / "calypte-anna.png").mkdir(parents=True)
        elif outcome == "gd-write-failed":
            cache.mkdir(parents=True)
        if outcome == "valid":
            with urllib.request.urlopen(url, timeout=5) as response:
                body = response.read()
                assert response.status == 200
                assert int(response.headers["Content-Length"]) == len(body)
                with Image.open(io.BytesIO(body)) as image:
                    image.load()
                    assert image.size == (100, 110)
            assert (cache / "calypte-anna.png").read_bytes() == body
        else:
            with pytest.raises(urllib.error.HTTPError) as failed:
                urllib.request.urlopen(url, timeout=5)
            assert failed.value.code == 500, (tmp_path / "php.log").read_text()
            if outcome == "rename-failed":
                assert (cache / "calypte-anna.png").is_dir()
            else:
                assert not (cache / "calypte-anna.png").exists()
        assert Path(location.read_text()).parent == cache
        assert sorted(p.name for p in cache.iterdir()) == (
            [".cutout.lock"] if outcome in ("malformed", "gd-write-failed")
            else [".cutout.lock", "calypte-anna.png"])
