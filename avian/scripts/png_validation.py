"""Strict PNG container and scanline-length validation without image dependencies."""
import struct
import zlib


def validate_png(data, check_dimensions):
    """Validate complete PNG bytes, checking caller size limits before inflation."""
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise RuntimeError("invalid PNG signature")
    offset, idat_state = 8, 0
    header = palette = False
    decoder = zlib.decompressobj()
    expanded = 0
    while offset < len(data):
        if offset + 12 > len(data):
            raise RuntimeError("incomplete PNG chunk")
        length = struct.unpack_from(">I", data, offset)[0]
        kind = data[offset + 4:offset + 8]
        end = offset + 12 + length
        if end > len(data) or not all(65 <= c <= 90 or 97 <= c <= 122 for c in kind):
            raise RuntimeError("invalid PNG chunk")
        body = memoryview(data)[offset + 8:end - 4]
        crc = zlib.crc32(body, zlib.crc32(kind))
        if crc != struct.unpack_from(">I", data, end - 4)[0]:
            raise RuntimeError("PNG chunk checksum failed")
        if not header and kind != b"IHDR":
            raise RuntimeError("PNG does not start with IHDR")
        if kind in (b"acTL", b"fcTL", b"fdAT"):
            raise RuntimeError("animated PNG artwork is unsupported")
        if kind == b"IHDR":
            if header or length != 13:
                raise RuntimeError("invalid PNG IHDR")
            width, height, depth, color, compression, filtering, interlace = struct.unpack(">IIBBBBB", body)
            if not (0 < width <= 0x7fffffff and 0 < height <= 0x7fffffff):
                raise RuntimeError("invalid PNG dimensions")
            check_dimensions(width, height)
            depths = {0: (1, 2, 4, 8, 16), 2: (8, 16), 3: (1, 2, 4, 8), 4: (8, 16), 6: (8, 16)}
            if depth not in depths.get(color, ()) or compression or filtering or interlace not in (0, 1):
                raise RuntimeError("invalid PNG image header")
            channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color]
            passes = ((0, 0, 1, 1),) if not interlace else (
                (0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4),
                (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2))
            expected = 0
            for x, y, dx, dy in passes:
                if width > x and height > y:
                    pass_width = (width - x + dx - 1) // dx
                    pass_height = (height - y + dy - 1) // dy
                    expected += pass_height * (1 + (pass_width * channels * depth + 7) // 8)
            header = True
        elif kind == b"PLTE":
            if palette or idat_state or not length or length % 3 or length > 768 or color in (0, 4):
                raise RuntimeError("invalid PNG palette")
            palette = True
        elif kind == b"IDAT":
            if idat_state == 2 or (color == 3 and not palette):
                raise RuntimeError("invalid PNG IDAT order")
            idat_state = 1
            pending = body
            while pending:
                try:
                    block = decoder.decompress(pending, min(65536, expected - expanded + 1))
                except zlib.error as error:
                    raise RuntimeError("invalid PNG compressed data") from error
                expanded += len(block)
                if expanded > expected or decoder.unused_data:
                    raise RuntimeError("invalid PNG scanline data length")
                pending = decoder.unconsumed_tail
        else:
            if idat_state:
                idat_state = 2
            if kind == b"IEND":
                if length or not idat_state or not decoder.eof or end != len(data):
                    raise RuntimeError("incomplete PNG image")
                if expanded != expected:
                    raise RuntimeError("invalid PNG scanline data length")
                return
            if not kind[0] & 32:
                raise RuntimeError("unsupported critical PNG chunk")
        offset = end
    raise RuntimeError("PNG has no terminal IEND")
