"""Bake stats-press.png, the mask tile used by #v1::after.

Run once. Deterministic (fixed seed), so re-running reproduces the shipped
asset byte for byte. Nothing in here runs at page time.

WHAT IT IS
  A 192 x 192 seamless PNG whose only meaningful channel is alpha. It is not
  a background image; it is a CSS mask over a flat var(--paper) fill. Colour
  therefore comes from the theme variable at paint time, one file serves both
  themes, and the source colour is bit-identical to the backdrop, which is
  what makes the lighten/darken blend a no-op on the page and an erosion on
  the ink.

WHY A STOCHASTIC SCREEN AND NOT A HALFTONE GRID
  A rotated dot grid, however worn, is still a lattice: zoom in and the rows
  are findable, and "that is still a pattern" is the objection this whole
  change exists to avoid. So the dots are placed by blue-noise dart throwing
  on a torus instead. Minimum spacing is enforced, so they never clump into
  blotches, but there is no grid at any zoom and no second frequency for the
  eye to beat the first against. This is how FM screening actually works, and
  it is also how a tired relief block actually breaks up.

  Three sources of irregularity, each with a physical job:
    position  blue noise, so no lattice
    weight    every dot gets its own radius (plate wear), modulated by a
              ~38px inking field (the block takes ink unevenly)
    tooth     anisotropic value noise under the dots (the sheet's own fibre),
              so the space between dots is not dead flat

WHY 192 BAKED AND 96 ON SCREEN
  mask-size is half the baked size, so one tile pixel lands on one device
  pixel at DPR 2 and the grain stays crisp instead of being upscaled. At DPR 1
  the browser halves it, which softens rather than aliases.

STRENGTH IS BAKED, NOT A CSS opacity
  A CSS opacity on this layer makes the compositor round through premultiplied
  8-bit, and that alone moves background pixels by 1/255. With the strength in
  the tile's alpha and no opacity property, the paper measures exactly
  unchanged. To make the texture heavier or lighter, change CAP and re-run.

ALPHA IS CAPPED
  No pixel is ever fully replaced by paper, so a 1px gridline or a 9px glyph
  stem can be worn but never cut through.
"""
import numpy as np, os, zlib, struct
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
N = 192          # baked tile size, px
LEVELS = 16      # alpha steps -> 4-bit palette indices
SEED = 7

RMIN = 4.1       # minimum dot spacing, baked px
RDOT = 1.45      # nominal dot radius, baked px
TOOTH = 0.50     # how far the sheet's fibre shows between the dots
CAP = 0.40       # peak alpha, i.e. how far the ink is lifted at a dot centre


def _lattice(n, fx, fy, rng):
    """One octave of periodic value noise: an fx x fy lattice, wrapped, then
    bicubically upsampled. Wrapping the last row/column onto the first is what
    makes the finished tile seamless."""
    g = rng.random((fy, fx))
    g = np.concatenate([g, g[:1]], 0)
    g = np.concatenate([g, g[:, :1]], 1)
    im = Image.fromarray((g * 255).astype(np.uint8))
    im = im.resize((n + n // fx, n + n // fy), Image.BICUBIC)
    return np.asarray(im, np.float64)[:n, :n] / 255.0


def _vnoise(n, fx, fy, octaves, persistence, rng):
    acc = np.zeros((n, n)); amp = 1.0; norm = 0.0
    for o in range(octaves):
        ax, ay = fx * (2 ** o), fy * (2 ** o)
        if ax > n or ay > n:
            break
        acc += _lattice(n, ax, ay, rng) * amp
        norm += amp; amp *= persistence
    acc /= norm
    return (acc - acc.min()) / (np.ptp(acc) + 1e-9)


def _poisson_torus(n, rmin, rng, k=30):
    """Bridson-style dart throwing with a toroidal distance metric, so the
    point set tiles. Blue noise: evenly spread, never on a grid."""
    cell = rmin / np.sqrt(2)
    gw = int(np.ceil(n / cell)); cell = n / gw
    grid = -np.ones((gw, gw), int)
    pts = []
    rad = int(np.ceil(rmin / cell)) + 1

    def fits(p):
        gx, gy = int(p[0] / cell), int(p[1] / cell)
        for dy in range(-rad, rad + 1):
            for dx in range(-rad, rad + 1):
                i = grid[(gy + dy) % gw, (gx + dx) % gw]
                if i < 0:
                    continue
                d = np.abs(pts[i] - p); d = np.minimum(d, n - d)
                if d[0] * d[0] + d[1] * d[1] < rmin * rmin:
                    return False
        return True

    def add(p):
        pts.append(p); grid[int(p[1] / cell), int(p[0] / cell)] = len(pts) - 1

    add(rng.random(2) * n)
    active = [0]
    while active:
        ai = int(rng.integers(len(active)))
        base = pts[active[ai]]
        placed = False
        for _ in range(k):
            ang = rng.random() * 2 * np.pi
            r = rmin * (1 + rng.random())
            p = np.mod(base + [np.cos(ang) * r, np.sin(ang) * r], n)
            if fits(p):
                add(p); active.append(len(pts) - 1); placed = True
                break
        if not placed:
            active.pop(ai)
    return np.array(pts)


def _screen(n, rmin, r_dot, rng, density, jitter=0.35, dmin=0.72, dspan=0.56):
    """Rasterise the dots. Radius varies per dot and with the inking field, so
    the screen is irregular in WEIGHT as well as in position. Weight is the
    part that matters: a field irregular only in position still reads as a
    texture with one grain size, which is what makes a screen legible."""
    pts = _poisson_torus(n, rmin, rng)
    out = np.zeros((n, n))
    rolls = rng.random(len(pts))
    pad = int(np.ceil(r_dot * 2.6)) + 2
    for i, p in enumerate(pts):
        d = density[int(p[1]) % n, int(p[0]) % n]
        r = r_dot * (1.0 - jitter + 2 * jitter * rolls[i]) * (dmin + dspan * d)
        if r <= 0.15:
            continue
        sy = np.arange(int(p[1]) - pad, int(p[1]) + pad + 1)
        sx = np.arange(int(p[0]) - pad, int(p[0]) + pad + 1)
        dy = np.abs(sy - p[1]); dy = np.minimum(dy, n - dy)
        dx = np.abs(sx - p[0]); dx = np.minimum(dx, n - dx)
        dd = np.sqrt(dy[:, None] ** 2 + dx[None, :] ** 2)
        v = np.clip((r - dd) / (0.9 * max(r, 0.4)) + 0.5, 0, 1)
        v = v * v * (3 - 2 * v)                      # smoothstep edge
        iy = np.mod(sy, n)[:, None]; ix = np.mod(sx, n)[None, :]
        out[iy, ix] = np.maximum(out[iy, ix], v)
    return out, len(pts)


def build(rmin=RMIN, r_dot=RDOT, tooth_w=TOOTH, cap=CAP, seed=SEED):
    rng = np.random.default_rng(seed)
    fibre = _vnoise(N, 20, 30, 4, 0.55, rng)      # ~9.6 x 6.4px cells, laid
    sp = _lattice(N, N // 2, N // 2, rng)          # 2px lumps, not per-px salt
    speck = (sp - sp.min()) / (np.ptp(sp) + 1e-9)
    drift = _vnoise(N, 6, 6, 3, 0.5, rng)
    tooth = 0.52 * fibre + 0.26 * speck + 0.16 * drift
    tooth = (tooth - tooth.min()) / (np.ptp(tooth) + 1e-9)
    tooth = np.clip((tooth - 0.32) / (0.90 - 0.32), 0, 1) ** 1.5

    ink = _vnoise(N, 5, 5, 3, 0.5, rng)            # ~38px inking sweep
    scr, ndots = _screen(N, rmin, r_dot, rng, ink)

    a = np.clip(np.maximum(scr, tooth * tooth_w) + 0.18 * tooth * scr, 0, 1)
    return a * cap, ndots


def write_png(path, a, levels=LEVELS):
    """Palette PNG, 4-bit indices, every entry white, alpha carried by tRNS.
    Colour is irrelevant because the file is only ever used as a mask, so
    paying for RGB would be paying for nothing. PIL will not emit 4-bit
    palette plus tRNS, hence the hand-rolled chunks."""
    h, w = a.shape
    idx = np.round(a * (levels - 1)).astype(np.uint8)
    rows = []
    for y in range(h):
        r = idx[y]
        if w % 2:
            r = np.concatenate([r, [0]])
        rows.append(b"\x00" + ((r[0::2] << 4) | r[1::2]).astype(np.uint8).tobytes())
    raw = b"".join(rows)

    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xffffffff)

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 4, 3, 0, 0, 0))
           + chunk(b"PLTE", b"\xff\xff\xff" * levels)
           + chunk(b"tRNS", bytes(int(round(i * 255 / (levels - 1))) for i in range(levels)))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    open(path, "wb").write(png)
    return len(png)


if __name__ == "__main__":
    import base64
    out = HERE + "/dist"
    os.makedirs(out, exist_ok=True)
    a, ndots = build()
    p = out + "/stats-press.png"
    n = write_png(p, a)
    b64 = base64.b64encode(open(p, "rb").read()).decode()
    open(out + "/stats-press.b64.txt", "w").write(b64)
    print("stats-press.png  %d x %d  %d alpha levels  %d dots" % (N, N, LEVELS, ndots))
    print("  on disk       %6d bytes" % n)
    print("  base64        %6d chars" % len(b64))
    print("  gzip(base64)  %6d bytes" % len(zlib.compress(b64.encode(), 9)))
    print("  alpha mean %.4f  std %.4f  max %.4f" % (a.mean(), a.std(), a.max()))
