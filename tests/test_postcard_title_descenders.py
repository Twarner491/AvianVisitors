import math
import re
from pathlib import Path

from PIL import ImageFont


ROOT = Path(__file__).resolve().parents[1]
CSS = (ROOT / "avian/frontend/styles.css").read_text()
NAMES = (
    "Herring Gull",       # g
    "Steller's Jay",      # j, y
    "Purple Finch",       # p
    "Gambel's Quail",     # q
    "Yellow Warbler",     # y
)


def title_rule():
    match = re.search(r"\.postcard-heading h2\s*\{(?P<body>.*?)\n\}", CSS, re.S)
    assert match, "postcard title rule is missing"
    return match.group("body")


def serif_fonts():
    paths = [
        Path("/System/Library/Fonts/NewYork.ttf"),
        Path("/System/Library/Fonts/Supplemental/Georgia.ttf"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf"),
    ]
    available = [path for path in paths if path.is_file()]
    assert available, "no representative UI serif is installed"
    return available


def test_postcard_title_clip_clears_descenders_at_every_breakpoint_and_theme():
    body = title_rule()
    padding = float(re.search(r"padding-block-end:\s*([.\d]+)em", body).group(1))
    line_height = float(re.search(r"clamp\([^)]*\)/([.\d]+)", body).group(1))

    assert "overflow: hidden" in body
    assert "-webkit-line-clamp: 2" in body
    assert padding >= 0.16
    assert set("gjpqy") <= set("".join(NAMES).lower())

    # These are the actual desktop, tablet, phone, compact-landscape and
    # narrow-phone title ceilings in styles.css. The base padding is logical,
    # so the same allowance must clear every one in both color themes.
    responsive_sizes = (34, 36, 32, 25, 20)
    assert "font-size: clamp(27px, 5vw, 36px)" in CSS
    assert "font-size: clamp(24px, 7vw, 32px)" in CSS
    assert "font-size: clamp(20px, 3.6vw, 25px)" in CSS
    assert "font-size: 20px" in CSS
    assert not re.search(
        r':root\[data-theme="dark"\]\s+\.postcard-heading h2\s*\{', CSS
    )

    for theme in ("light", "dark"):
        for size in responsive_sizes:
            clip_bottom = size * (line_height + padding)
            for path in serif_fonts():
                font = ImageFont.truetype(str(path), size)
                ascent, descent = font.getmetrics()
                assert clip_bottom + 0.5 >= ascent + descent, (
                    theme, size, path.name, clip_bottom, ascent + descent
                )
                for name in NAMES:
                    assert font.getbbox(name)[3] <= math.ceil(clip_bottom), (
                        theme, size, path.name, name
                    )
