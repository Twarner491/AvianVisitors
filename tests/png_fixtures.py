"""CRC-correct PNG fixtures with independently supplied scanline bytes."""
import struct
import zlib


def scanline_png(width, height, depth, color, rows, interlace=0):
    def chunk(kind, body):
        return (struct.pack(">I", len(body)) + kind + body
                + struct.pack(">I", zlib.crc32(kind + body)))
    header = struct.pack(">IIBBBBB", width, height, depth, color, 0, 0, interlace)
    palette = chunk(b"PLTE", b"\x00\x00\x00\xff\xff\xff") if color == 3 else b""
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + palette
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))
