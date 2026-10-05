"""Validate the browser's artwork bytes and compose a bounded frame on the CPU."""
import io
import importlib.util
import math
import struct
from pathlib import Path

from PIL import Image, ImageFile, ImageFilter

_png_spec = importlib.util.spec_from_file_location(
    "avian_png_validation", Path(__file__).resolve().parents[1] / "avian/scripts/png_validation.py")
_png_validation = importlib.util.module_from_spec(_png_spec)
_png_spec.loader.exec_module(_png_validation)

MAX_ASSET_BYTES = 16 * 1024 * 1024
MAX_ASSET_PIXELS = 8_000_000
MAX_ASSET_EDGE = 8192
MAX_RETAINED_BYTES = 128 * 1024 * 1024
MAX_IMAGES = 512
MAX_OUTPUT_PIXELS = 8_000_000
MAX_STRIP_PIXELS = 120_000  # 50 CSS rows at the default 600px width / 2x scale.


def _asset_size(width, height):
    if not (0 < width <= MAX_ASSET_EDGE and 0 < height <= MAX_ASSET_EDGE
            and width * height <= MAX_ASSET_PIXELS):
        raise RuntimeError("capture artwork dimensions exceed limits")


def _validate_webp(data):
    if len(data) < 12 or struct.unpack_from("<I", data, 4)[0] + 8 != len(data):
        raise RuntimeError("incomplete WebP container")
    offset = 12
    while offset < len(data):
        if offset + 8 > len(data):
            raise RuntimeError("incomplete WebP chunk")
        kind = data[offset:offset + 4]
        length = struct.unpack_from("<I", data, offset + 4)[0]
        end = offset + 8 + length + (length & 1)
        if end > len(data):
            raise RuntimeError("incomplete WebP chunk")
        if kind in (b"ANIM", b"ANMF"):
            raise RuntimeError("animated capture artwork is unsupported")
        # Pillow constructs its native WebP decoder inside Image.open, so both
        # the extended canvas and every bitstream need bounds checked first.
        payload = memoryview(data)[offset + 8:offset + 8 + length]
        if kind == b"VP8X":
            if length != 10:
                raise RuntimeError("invalid WebP header")
            _asset_size(int.from_bytes(payload[4:7], "little") + 1,
                        int.from_bytes(payload[7:10], "little") + 1)
        elif kind == b"VP8L":
            if length < 5 or payload[0] != 0x2f:
                raise RuntimeError("invalid WebP header")
            dimensions = struct.unpack_from("<I", payload, 1)[0]
            if dimensions >> 29:
                raise RuntimeError("invalid WebP header")
            _asset_size((dimensions & 0x3fff) + 1, ((dimensions >> 14) & 0x3fff) + 1)
        elif kind == b"VP8 ":
            if length < 10 or payload[0] & 1 or payload[3:6] != b"\x9d\x01\x2a":
                raise RuntimeError("invalid WebP header")
            width, height = struct.unpack_from("<HH", payload, 6)
            _asset_size(width & 0x3fff, height & 0x3fff)
        offset = end


def decode_capture_image(data: bytes) -> Image.Image:
    """Reject incomplete, animated, oversized, or unsupported PNG/WebP artwork."""
    if not data or len(data) > MAX_ASSET_BYTES:
        raise RuntimeError("capture artwork byte limit exceeded")
    try:
        if data.startswith(b"\x89PNG\r\n\x1a\n"):
            _png_validation.validate_png(data, _asset_size)
        elif data.startswith(b"RIFF") and data[8:12] == b"WEBP":
            _validate_webp(data)
        else:
            raise RuntimeError("capture artwork must be PNG or WebP")
        if ImageFile.LOAD_TRUNCATED_IMAGES:
            raise RuntimeError("capture requires strict image decoding")
        with Image.open(io.BytesIO(data)) as image:
            _asset_size(*image.size)
            if image.format not in ("PNG", "WEBP") or getattr(image, "n_frames", 1) != 1:
                raise RuntimeError("animated capture artwork is unsupported")
            image.load()
            return image.convert("RGBA")
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError) as error:
        raise RuntimeError("capture artwork could not be fully decoded") from error


def compose_capture(overlay: Image.Image, images: list, size: tuple, paper: tuple) -> bytes:
    """Paint one verified asset at a time, then the browser's transparent type."""
    if (len(size) != 2 or any(not isinstance(n, int) or n <= 0 for n in size)
            or size[0] * size[1] > MAX_OUTPUT_PIXELS or overlay.size != size
            or overlay.mode != "RGBA" or len(images) > MAX_IMAGES
            or sum(len(item["body"]) for item in images) > MAX_RETAINED_BYTES):
        raise RuntimeError("capture composition limits exceeded")
    canvas = Image.new("RGBA", size, (*paper, 255))
    for item in images:
        x, y, width, height = item["rect"]
        if (not all(math.isfinite(n) for n in (x, y, width, height)) or min(width, height) <= 0
                or width > size[0] or height > size[1] or abs(x) > size[0] or abs(y) > size[1]):
            raise RuntimeError("invalid capture image rectangle")
        with decode_capture_image(item["body"]) as original:
            if list(original.size) != item["natural"]:
                raise RuntimeError("capture image dimensions changed")
            if item["fit"] == "contain":
                scale = min(width / original.width, height / original.height)
                target = (max(1, round(original.width * scale)), max(1, round(original.height * scale)))
            elif item["fit"] == "fill":
                target = (max(1, round(width)), max(1, round(height)))
            else:
                raise RuntimeError("unsupported capture object-fit")
            px, py = item["position"]
            if not all(math.isfinite(n) and 0 <= n <= 1 for n in (px, py)):
                raise RuntimeError("unsupported capture object-position")
            origin = (round(x + (width - target[0]) * px), round(y + (height - target[1]) * py))
            with original.resize(target, Image.Resampling.LANCZOS) as art:
                shadow = item["shadow"]
                if shadow:
                    blur = shadow["blur"]
                    sx, sy = shadow["offset"]
                    if not all(math.isfinite(n) for n in (blur, sx, sy)) or blur < 0:
                        raise RuntimeError("invalid capture shadow")
                    padding = math.ceil(blur * 3)
                    shadow_size = (art.width + 2 * padding, art.height + 2 * padding)
                    if shadow_size[0] * shadow_size[1] > MAX_OUTPUT_PIXELS:
                        raise RuntimeError("capture shadow limit exceeded")
                    alpha = Image.new("L", shadow_size)
                    alpha.paste(art.getchannel("A"), (padding, padding))
                    alpha = alpha.filter(ImageFilter.GaussianBlur(blur))
                    alpha = alpha.point(lambda value: round(value * shadow["color"][3] / 255))
                    layer = Image.new("RGBA", shadow_size, tuple(shadow["color"]))
                    layer.putalpha(alpha)
                    canvas.alpha_composite(layer, (origin[0] - padding + round(sx), origin[1] - padding + round(sy)))
                    alpha.close()
                    layer.close()
                canvas.alpha_composite(art, origin)
    canvas.alpha_composite(overlay)
    output = io.BytesIO()
    canvas.convert("RGB").save(output, "PNG")
    canvas.close()
    return output.getvalue()
