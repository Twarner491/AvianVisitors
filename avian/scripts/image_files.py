"""Publish complete PNGs without exposing partial writes to image readers."""

import io
import os
import stat
import tempfile
from pathlib import Path

from PIL import Image
from png_validation import validate_png


def _check_dimensions(width, height):
    Image._decompression_bomb_check((width, height))


def open_source_image(data):
    """Decode the same source buffer whose PNG integrity was checked."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        validate_png(data, _check_dimensions)
    return Image.open(io.BytesIO(data))


def save_png_atomic(image, destination):
    destination = Path(destination)
    try:
        previous = destination.lstat()
    except FileNotFoundError:
        previous = None
    if previous is not None and not stat.S_ISREG(previous.st_mode):
        raise ValueError("PNG destination must be a regular file")
    image.load()
    fd, pending = tempfile.mkstemp(prefix=f".{destination.name}.", suffix=".tmp",
                                   dir=destination.parent)
    try:
        with os.fdopen(fd, "w+b") as stream:
            image.save(stream, format="PNG")
            stream.flush()
            stream.seek(0)
            validate_png(stream.read(), _check_dimensions)
            stream.seek(0)
            with Image.open(stream) as check:
                check.verify()
            stream.seek(0)
            with Image.open(stream) as check:
                check.load()
            if previous is not None and os.fstat(stream.fileno()).st_gid != previous.st_gid:
                try:
                    os.fchown(stream.fileno(), -1, previous.st_gid)
                except PermissionError:
                    if previous.st_uid != os.geteuid():
                        raise
                    # The station owner need not belong to caddy; installed
                    # web users also have access through the station group.
            os.fchmod(stream.fileno(), stat.S_IMODE(previous.st_mode) if previous else 0o644)
            os.fsync(stream.fileno())
        if destination.is_symlink():
            raise ValueError("PNG destination must not be a symlink")
        os.replace(pending, destination)
    finally:
        if os.path.exists(pending):
            os.unlink(pending)
