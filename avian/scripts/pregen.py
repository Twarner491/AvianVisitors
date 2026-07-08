#!/usr/bin/env python3
"""AvianVisitors - generate kachō-e bird illustrations for a region.

Step 1 of the illustration pipeline:
    1. pregen.py       render each bird on a uniform cream ground
    2. cutout.py       remove the ground (BiRefNet) and crop to the bird
    3. build_masks.py  refresh the collage silhouette masks in apt.js

Reads a species list (BirdNET-Pi's labels.txt, eBird, or stdin),
fetches a Wikipedia reference photo for each species, and generates an
illustration via the Gemini 2.5 Flash Image API. Saves PNGs into
avian/assets/illustrations/.

The prompt renders each bird on a CREAM ground, not a transparent one:
the model can't cut transparency cleanly, but a flat known ground removes
cleanly in step 2. Each species gets two poses: <slug>.png (perched) and
<slug>-2.png (flight). Edit avian/scripts/prompt.template.md to change the
visual style - the prompt body is re-sent verbatim per request with
{sci_name}, {com_name}, and {pose} substituted.

Reference photos:
    Cached in avian/assets/references/. The auto-fetch hits the
    Wikipedia article's first image. If a reference for the species
    doesn't exist locally, pregen.py fetches one and caches it. To use
    a hand-picked reference, drop it in references/ named <slug>.jpg
    or <slug>.png BEFORE running and pregen.py will use that instead.

Contrastive anti-reference:
    For genera where Gemini's prior collapses to a more famous
    lookalike, the script attaches a photo of that lookalike as a
    negative reference and rewrites the prompt body to tell the model
    NOT to copy the lookalike's diagnostic features. Currently wired:
    Blue Jay for small blue corvids (Cyanocitta, Aphelocoma, etc.) and
    Barn Swallow for other swallows (Tachycineta, Progne, etc.). The
    anti-reference photos live at avian/assets/references/_anti_*.jpg
    and the registry (ANTI_REFS, ANTI_REF_TRIGGERS) is keyed so adding
    a new one is one entry per table.

Usage:
    # Every species BirdNET-Pi knows:
    python3 pregen.py --labels ~/BirdNET-Pi/model/labels.txt

    # Only species observed in an eBird region:
    python3 pregen.py --labels ~/BirdNET-Pi/model/labels.txt \\
                      --ebird-region US-CA --ebird-key YOUR_KEY

    # Re-render a single species (useful after editing the prompt):
    python3 pregen.py --species "Calypte anna|Anna's Hummingbird" --force

    # Re-render everything after a prompt change:
    python3 pregen.py --labels ~/BirdNET-Pi/model/labels.txt --force

Set GEMINI_API_KEY in the environment (preferred) or pass --gemini-key.
"""
from __future__ import annotations
import argparse
import base64
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from io import BytesIO
from pathlib import Path

# Gemini's image-out model. The endpoint changes occasionally; if you
# get a 404 here, check Google's model catalog and bump this.
GEMINI_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    "gemini-2.5-flash-image:generateContent"
)
OPENAI_IMAGES_GENERATIONS_URL = "https://api.openai.com/v1/images/generations"
OPENAI_IMAGES_EDITS_URL = "https://api.openai.com/v1/images/edits"
OPENAI_IMAGE_MODEL = "gpt-image-1"
POSES = {1: "perched", 2: "in flight with wings spread"}

# Genera where Gemini's prior collapses to Blue Jay markings unless we
# attach a Blue Jay anti-reference. Add to this set if you find another
# blue-songbird genus that needs the contrastive nudge.
JAY_GENERA = {
    "Cyanocitta", "Aphelocoma", "Cyanolyca", "Calocitta", "Cyanopica",
    "Garrulus", "Cyanocorax", "Gymnorhinus",
}

# Genera where Gemini's prior collapses to Barn Swallow (rufous throat,
# deeply forked tail) unless we attach a Barn Swallow anti-reference.
# Hirundo rustica is itself the Barn Swallow so it's excluded.
SWALLOW_GENERA = {
    "Tachycineta", "Riparia", "Progne", "Petrochelidon", "Stelgidopteryx",
}

# Genera where Gemini's prior collapses to American Robin (gray back,
# orange breast) for ground-foraging thrushes. Add as needed.
ROBIN_GENERA = set()  # placeholder for future use

# Anti-reference catalogue. Each entry describes one lookalike species
# that Gemini collapses to: the common/scientific names go in IMAGE 2's
# caption and the prompt-body bullet, and `do_not_copy` is the list of
# its diagnostic features the model must avoid. The key matches the
# `_anti_<key>.jpg` filename in the references directory and feeds into
# `ANTI_REF_TRIGGERS` below.
# ---- Style references ----
# Edo-period kachō-e woodblock prints by Ohara Koson and Hiroshi Yoshida,
# kept in a local directory (default avian/assets/references/styles/). Mapped by
# genus + pose. The bird in each print is irrelevant - only the painting
# technique (flat washes, confident outlines, tonal ground) is borrowed.
STYLE_REFS = {
    "small_songbird_perched": "01-sparrows-on-bamboo-Koson.jpg",
    "dark_bird_perched":      "02-cawing-crow-Koson.jpg",
    "vivid_perched":          "03-jays-on-berry-tree-Koson.jpg",
    "vibrant_perched":        "04-kingfisher-Koson.jpg",
    "owl":                    "05-owl-on-ginkgo-Koson.jpg",
    "large_flight":           "06-goose-flying-in-moonlight-Koson.jpg",
    "small_flight":           "07-swallows-in-flight-Koson.jpg",
    "wader":                  "08-crane-in-small-water-Koson.jpg",
    "pale_perched":           "09-cockatoo-Yoshida.jpg",
    "waterfowl_perched":      "10-mandarin-ducks-Yoshida.jpg",
}

# Genus → perched style category. The first match wins. Fallback is
# "small_songbird_perched" (Koson sparrows-on-bamboo) for every uncategorized
# genus - covers passer/melospiza/spizella/junco/etc.
GENUS_STYLE_PERCHED = {
    # Owls
    "Tyto":"owl","Bubo":"owl","Asio":"owl","Megascops":"owl","Athene":"owl",
    "Strix":"owl","Glaucidium":"owl","Aegolius":"owl",
    # Hummingbirds + jays + colorful crested (vibrant color anchor)
    "Calypte":"vibrant_perched","Archilochus":"vibrant_perched",
    "Selasphorus":"vibrant_perched","Calothorax":"vibrant_perched",
    "Cyanocitta":"vibrant_perched","Aphelocoma":"vibrant_perched",
    "Pica":"vibrant_perched","Nucifraga":"vibrant_perched",
    "Perisoreus":"vibrant_perched",
    # Waxwings + orioles + tanagers (vivid perching with berry-tree composition feel)
    "Bombycilla":"vivid_perched","Icterus":"vivid_perched",
    "Piranga":"vivid_perched","Pheucticus":"vivid_perched",
    "Passerina":"vivid_perched","Cardellina":"vivid_perched",
    "Setophaga":"vivid_perched","Icteria":"vivid_perched",
    # Corvids + vultures (dark perching)
    "Corvus":"dark_bird_perched","Coragyps":"dark_bird_perched",
    "Cathartes":"dark_bird_perched","Gymnogyps":"dark_bird_perched",
    # Waterfowl perched (mandarin-ducks anchor)
    "Anas":"waterfowl_perched","Aix":"waterfowl_perched","Mareca":"waterfowl_perched",
    "Spatula":"waterfowl_perched","Branta":"waterfowl_perched","Anser":"waterfowl_perched",
    "Cygnus":"waterfowl_perched","Aythya":"waterfowl_perched",
    "Bucephala":"waterfowl_perched","Lophodytes":"waterfowl_perched",
    "Mergus":"waterfowl_perched","Oxyura":"waterfowl_perched",
    "Podiceps":"waterfowl_perched","Podilymbus":"waterfowl_perched",
    "Aechmophorus":"waterfowl_perched","Gavia":"waterfowl_perched",
    "Pelecanus":"waterfowl_perched","Phalacrocorax":"waterfowl_perched",
    "Urile":"waterfowl_perched",
    # Waders + herons (crane-in-reeds anchor)
    "Ardea":"wader","Egretta":"wader","Bubulcus":"wader","Butorides":"wader",
    "Nycticorax":"wader","Plegadis":"wader","Limosa":"wader","Numenius":"wader",
    "Himantopus":"wader","Recurvirostra":"wader","Charadrius":"wader",
    "Actitis":"wader","Calidris":"wader","Tringa":"wader",
    # Pale-bodied (gulls, terns, skimmer - cockatoo anchor)
    "Larus":"pale_perched","Leucophaeus":"pale_perched","Sterna":"pale_perched",
    "Thalasseus":"pale_perched","Hydroprogne":"pale_perched","Rynchops":"pale_perched",
}

# Genera that should use large_flight (instead of small_flight) for pose 2.
LARGE_FLIGHT_GENERA = {
    "Tyto","Bubo","Asio","Megascops","Athene","Strix","Glaucidium","Aegolius",
    "Anas","Aix","Mareca","Spatula","Branta","Anser","Cygnus","Aythya",
    "Bucephala","Lophodytes","Mergus","Oxyura","Pelecanus","Phalacrocorax",
    "Urile","Ardea","Egretta","Bubulcus","Butorides","Nycticorax","Plegadis",
    "Limosa","Numenius","Himantopus","Recurvirostra",
    "Buteo","Accipiter","Aquila","Circus","Falco","Cathartes","Coragyps",
    "Haliaeetus","Pandion","Elanus","Gymnogyps","Corvus",
}


def select_style_ref(sci: str, pose: int) -> str:
    """Pick the style reference filename for a (sci, pose) pair."""
    genus = sci.split()[0]
    # Custom overrides for hard species
    if sci == "Aeronautes saxatalis":
        return STYLE_REFS["vibrant_perched"]  # Koson kingfisher (vertical aerial-feeder posture, no swallow bias)
    if pose == 2:
        return STYLE_REFS["large_flight" if genus in LARGE_FLIGHT_GENERA else "small_flight"]
    return STYLE_REFS[GENUS_STYLE_PERCHED.get(genus, "small_songbird_perched")]


ANTI_REFS = {
    "bluejay": {
        "common_name": "Blue Jay",
        "sci_name": "Cyanocitta cristata",
        "do_not_copy": (
            "its facial mask, its white wingbars, its black necklace, "
            "its crest pattern, or its white-tipped tail"
        ),
    },
    "barnswallow": {
        "common_name": "Barn Swallow",
        "sci_name": "Hirundo rustica",
        "do_not_copy": (
            "its deep rufous throat, its long deeply forked outer tail "
            "streamers, or its blue-black back"
        ),
    },
}

# Which anti-ref to attach for which genus, and the species to exclude
# (the lookalike itself - we don't want to tell a Barn Swallow generation
# not to look like a Barn Swallow). Order matters only if a genus appears
# in more than one set; first match wins.
ANTI_REF_TRIGGERS = (
    (JAY_GENERA, "bluejay", "Cyanocitta cristata"),
    (SWALLOW_GENERA, "barnswallow", "Hirundo rustica"),
)

USER_AGENT = "AvianVisitors/1.0 (https://github.com/Twarner491/AvianVisitors)"


def slugify(sci: str) -> str:
    """Match avian/frontend/apt.js slugify() exactly."""
    return re.sub(r"[^a-z0-9]+", "-", sci.lower()).strip("-")


def parse_species_line(line: str) -> tuple[tuple[str, str] | None, str | None]:
    """Accept delimited labels like 'Sci|Com' or a scientific name-only line."""
    line = line.strip()
    if not line:
        return None, "blank line"
    if line.startswith("#"):
        return None, "comment"

    for sep in ("|", "_", ","):
        if sep in line:
            sci, com = line.split(sep, 1)
            sci, com = sci.strip(), com.strip()
            if sci and com:
                return (sci, com), None
            return None, f"separator {sep!r} found but scientific/common name missing"

    if " " in line:
        return (line, line), None
    return None, "not a valid scientific-name or 'Sci|Com' entry"


def parse_species_list(lines: list[str]) -> tuple[list[tuple[str, str]], list[tuple[int, str, str]]]:
    """Returns (parsed, skipped_details)."""
    out, skipped = [], []
    for idx, line in enumerate(lines, 1):
        parsed, reason = parse_species_line(line)
        if parsed:
            out.append(parsed)
        elif line.strip() and not line.lstrip().startswith("#"):
            skipped.append((idx, line.strip(), reason or "unrecognized format"))
    return out, skipped


def load_prompt(path: Path) -> str:
    """Return everything after the `## Prompt` heading, stripped to the
    next `##` heading (so doc preamble or trailing sections don't bleed
    into the API call)."""
    text = path.read_text(encoding="utf-8", errors="replace")
    m = re.search(r"##\s*Prompt\s*\n(.+?)(?=\n##\s|\Z)", text, flags=re.DOTALL)
    return (m.group(1) if m else text).strip()


def ebird_filter(species, region: str, key: str):
    """Intersect a label set with the eBird species list for a region.
    Region codes: US-CA (state), US-CA-085 (county)."""
    url = f"https://api.ebird.org/v2/product/spplist/{region}"
    req = urllib.request.Request(url, headers={"X-eBirdApiToken": key})
    with urllib.request.urlopen(req, timeout=30) as r:
        ebird_codes = set(json.loads(r.read()))
    tax_url = "https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=json"
    req2 = urllib.request.Request(tax_url, headers={"X-eBirdApiToken": key})
    with urllib.request.urlopen(req2, timeout=60) as r:
        taxonomy = json.loads(r.read())
    code_to_sci = {t["speciesCode"]: t["sciName"] for t in taxonomy}
    allowed = {code_to_sci[c] for c in ebird_codes if c in code_to_sci}
    return [(s, c) for s, c in species if s in allowed]


# ---- Reference photo handling ----

# Extensions to scan/write for cached reference photos. .jpg first matches
# the JPEG majority of Wikipedia infoboxes and any legacy hand-placed
# plates; .png covers PNG infoboxes (range maps, some illustrations) and
# hand-placed PNG plates. Each extension here must have a matching MIME
# in _mime_for - keep the two in sync.
REF_EXTS = (".jpg", ".png")


def fetch_wikipedia_thumb(sci: str, com: str) -> tuple[bytes, str] | None:
    """Fetch the Wikipedia article's lead/infobox image bytes.

    Returns (bytes, ext) where ext is '.jpg' or '.png' sniffed from the
    magic bytes - Wikipedia's infobox image can be either, and shipping
    PNG bytes labeled as JPEG to Gemini gets the reference silently
    rejected. Returns None if no usable image. Pi-friendly: pulls a
    1024-wide thumbnail via the REST summary endpoint (a few KB to MB,
    not the original-sized image).
    """
    titles = [sci.replace(" ", "_"), com.replace(" ", "_"), com.split()[0]]
    for title in titles:
        url = (
            "https://en.wikipedia.org/api/rest_v1/page/summary/"
            + urllib.parse.quote(title)
        )
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=20) as r:
                meta = json.loads(r.read())
        except (urllib.error.HTTPError, urllib.error.URLError):
            continue
        # Prefer originalimage (higher res) over thumbnail.
        for k in ("originalimage", "thumbnail"):
            src = (meta.get(k) or {}).get("source")
            if not src or not src.lower().endswith((".jpg", ".jpeg", ".png")):
                continue
            try:
                req2 = urllib.request.Request(src, headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(req2, timeout=30) as r:
                    data = r.read()
            except (urllib.error.HTTPError, urllib.error.URLError):
                continue
            # Magic-byte sniff - URL extension is a hint, the bytes are
            # what Gemini's MIME check sees. Skip unknown formats rather
            # than mis-label them.
            if data.startswith(b"\x89PNG\r\n\x1a\n"):
                return data, ".png"
            if data.startswith(b"\xff\xd8\xff"):
                return data, ".jpg"
    return None


def ensure_reference(refs_dir: Path, slug: str, sci: str, com: str) -> Path | None:
    """Cache-or-fetch a reference photo. Returns the path if we have one,
    None if Wikipedia had no usable image. Pre-existing references (e.g.
    hand-picked Audubon plates dropped in by the user as either
    <slug>.jpg or <slug>.png) are respected; the file is saved with the
    extension that matches its actual format so _mime_for ships the
    right MIME to Gemini."""
    refs_dir.mkdir(parents=True, exist_ok=True)
    for ext in REF_EXTS:
        cached = refs_dir / f"{slug}{ext}"
        if cached.exists() and cached.stat().st_size > 1024:
            return cached
    fetched = fetch_wikipedia_thumb(sci, com)
    if not fetched:
        return None
    data, ext = fetched
    path = refs_dir / f"{slug}{ext}"
    path.write_bytes(data)
    return path


def select_anti_ref_key(sci: str) -> str | None:
    """Return the ANTI_REFS key for the lookalike that Gemini drifts
    toward for this species, or None if no anti-ref is needed. The key
    matches `_anti_<key>.jpg` in the references directory."""
    genus = sci.split()[0]
    for genera, key, exclude in ANTI_REF_TRIGGERS:
        if genus in genera and sci != exclude:
            return key
    return None


def load_species_notes(notes_path: Path) -> dict[str, str]:
    """Load per-species prompt addenda. Keys are scientific names; values
    are 1-2 sentence clarifications to inject when generating that
    species. Returns {} if the notes file doesn't exist."""
    if not notes_path.exists():
        return {}
    raw = json.loads(notes_path.read_text())
    return {k: v for k, v in raw.items()
            if not k.startswith("_") and isinstance(v, str)}


def load_anti_ref(refs_dir: Path, key: str = "bluejay") -> Path | None:
    """Return path to the bundled anti-reference for the given key,
    if present. Known keys: bluejay, barnswallow."""
    p = refs_dir / f"_anti_{key}.jpg"
    return p if p.exists() else None


# ---- Gemini call ----

def _anti_ref_line(anti_ref_key: str | None) -> str:
    """Render the `{anti_ref_line}` substitution for the prompt body.
    Returns the IMAGE 2 bullet describing which species is attached and
    which of its features the model must avoid - or an empty string
    when no anti-ref is attached for this species."""
    info = ANTI_REFS.get(anti_ref_key or "")
    if not info:
        return ""
    return (
        f"- IMAGE 2 (negative, when attached) is a {info['common_name']} "
        f"({info['sci_name']}). It is NOT what you are drawing. Do NOT "
        f"copy {info['do_not_copy']}. If your output looks more like "
        f"IMAGE 2 than IMAGE 1, the output is wrong."
    )


def write_prompt_file(out_dir: Path, sci: str, body: str, pose: int) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{sci}_{pose}.txt"
    path.write_text(body, encoding="utf-8")
    return path


def gen_one(
    api_key: str,
    prompt: str,
    sci: str,
    com: str,
    pose: int,
    positive_ref: Path | None = None,
    anti_ref: Path | None = None,
    anti_ref_key: str | None = None,
    species_note: str | None = None,
    style_ref: Path | None = None,
) -> bytes:
    """Single Gemini call with bounded retry on 429 + transient 5xx.
    Returns raw PNG bytes.

    positive_ref: Wikipedia/Audubon photo of the target species.
    anti_ref: lookalike photo to attach as IMAGE 2. The companion
              anti_ref_key (a key into ANTI_REFS) must match what's in
              the file - it drives the IMAGE 2 caption and the
              {anti_ref_line} substitution in the prompt body. Pass
              both or neither; passing the path without the key would
              caption the image as an unnamed "another species".
    species_note: optional 1-2 sentence clarifier for difficult species,
                  appended as the last paragraph before the reference
                  block.
    """
    body = (prompt
            .replace("{sci_name}", sci)
            .replace("{com_name}", com)
            .replace("{pose}", POSES[pose])
            .replace("{anti_ref_line}", _anti_ref_line(anti_ref_key)))
    if species_note:
        body = body + "\n\nSpecies-specific note: " + species_note

    parts: list[dict] = [{"text": body}]
    if positive_ref:
        # Downscale the anatomy reference to 384px on the long side
        # before encoding. Big Wikipedia photos visually dominate as a
        # style signal even though the prompt says they're anatomy-only;
        # at 384px the model still reads species/markings/colors but
        # has less photographic detail to mimic.
        try:
            from PIL import Image
            from io import BytesIO
            img = Image.open(positive_ref).convert("RGB")
            w, h = img.size
            if max(w, h) > 384:
                scale = 384 / max(w, h)
                img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
            buf = BytesIO()
            img.save(buf, format="PNG", optimize=True)
            ref_bytes = buf.getvalue()
            ref_mime = "image/png"
        except Exception:
            ref_bytes = positive_ref.read_bytes()
            ref_mime = _mime_for(positive_ref)
        parts.append({"text": "IMAGE 1 (positive, target species):"})
        parts.append({"inline_data": {
            "mime_type": ref_mime,
            "data": base64.b64encode(ref_bytes).decode(),
        }})
    if anti_ref:
        anti_name = (ANTI_REFS.get(anti_ref_key or "") or {}).get(
            "common_name", "lookalike species"
        )
        parts.append({"text": f"IMAGE 2 (negative, {anti_name}, do NOT copy):"})
        parts.append({"inline_data": {
            "mime_type": _mime_for(anti_ref),
            "data": base64.b64encode(anti_ref.read_bytes()).decode(),
        }})
    if style_ref:
        parts.append({"text": (
            "IMAGE 3 (positive STYLE reference - Edo-period kachō-e woodblock "
            "print). The species in IMAGE 3 is irrelevant; only its painting "
            "technique is borrowed (flat washes, confident outlines, tonal "
            "mineral-pigment ground). DO NOT copy any branches, leaves, water, "
            "moon, or scenery from IMAGE 3.")})
        parts.append({"inline_data": {
            "mime_type": _mime_for(style_ref),
            "data": base64.b64encode(style_ref.read_bytes()).decode(),
        }})

    payload = {
        "contents": [{"parts": parts}],
        # TEXT included so Gemini can surface safety messaging without
        # rejecting the request shape (image-only sometimes errors).
        "generationConfig": {"responseModalities": ["TEXT", "IMAGE"]},
    }
    # API key as header, NOT URL - keeps the key out of Google's
    # request logs, proxy logs, and shell history.
    req = urllib.request.Request(
        GEMINI_URL,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
        method="POST",
    )

    backoff = 4.0
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                resp = json.loads(r.read())
            break
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < 3:
                ra = e.headers.get("Retry-After")
                print(f"Gemini HTTP {e.code} - retrying after {ra or backoff:.1f}s...", file=sys.stderr)
                try:
                    retry_after = float(ra) if ra else backoff
                except (TypeError, ValueError):
                    retry_after = backoff  # HTTP-date format, fall back
                time.sleep(retry_after)
                backoff *= 2
                continue
            if e.code == 429:
                raise RuntimeError(
                    "Gemini 429 rate limit hit: the API quota was exhausted or requests were too frequent. "
                    "Try lowering the batch size, increasing --sleep, or waiting before re-running."
                ) from e
            raise RuntimeError(f"Gemini HTTP {e.code}: {e.reason}") from e
        except urllib.error.URLError as e:
            if attempt < 3:
                time.sleep(backoff)
                backoff *= 2
                continue
            raise RuntimeError(f"Gemini request failed: {e.reason}") from e

    for cand in resp.get("candidates", []):
        for part in cand.get("content", {}).get("parts", []):
            inline = part.get("inlineData") or part.get("inline_data")
            if inline and inline.get("data"):
                return base64.b64decode(inline["data"])
    # No image - surface the blocking reason so users know what to fix.
    finish = (resp.get("candidates", [{}])[0]).get("finishReason", "?")
    block = resp.get("promptFeedback", {}).get("blockReason", "")
    raise RuntimeError(f"no image (finish={finish} block={block})")


def _prepare_image_bytes(path: Path) -> bytes:
    try:
        from PIL import Image
        img = Image.open(path).convert("RGB")
        w, h = img.size
        if max(w, h) > 1024:
            scale = 1024 / max(w, h)
            img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
        buf = BytesIO()
        img.save(buf, format="PNG", optimize=True)
        return buf.getvalue()
    except Exception:
        return path.read_bytes()


def _openai_multipart_form(fields: dict[str, str], files: list[tuple[str, str, bytes, str]]) -> tuple[str, bytes]:
    boundary = f"----AvianVisitorsBoundary{int(time.time() * 1000)}"
    parts: list[bytes] = []
    for name, value in fields.items():
        parts.extend([
            f"--{boundary}".encode("utf-8"),
            f"Content-Disposition: form-data; name=\"{name}\"".encode("utf-8"),
            b"",
            value.encode("utf-8"),
        ])
    for field_name, filename, content, mime_type in files:
        parts.extend([
            f"--{boundary}".encode("utf-8"),
            f"Content-Disposition: form-data; name=\"{field_name}\"; filename=\"{filename}\"".encode("utf-8"),
            f"Content-Type: {mime_type}".encode("utf-8"),
            b"",
            content,
        ])
    parts.extend([f"--{boundary}--".encode("utf-8"), b""])
    return f"multipart/form-data; boundary={boundary}", b"\r\n".join(parts)


def gen_one_openai(
    api_key: str,
    prompt: str,
    sci: str,
    com: str,
    pose: int,
    positive_ref: Path | None = None,
    anti_ref: Path | None = None,
    anti_ref_key: str | None = None,
    species_note: str | None = None,
    style_ref: Path | None = None,
) -> bytes:
    """Single OpenAI Images API call with optional reference images.

    Returns raw PNG bytes.
    If any image references are attached, this uses the OpenAI image edits
    endpoint; otherwise it uses the text-only images generation endpoint.
    """
    body = (prompt
            .replace("{sci_name}", sci)
            .replace("{com_name}", com)
            .replace("{pose}", POSES[pose])
            .replace("{anti_ref_line}", _anti_ref_line(anti_ref_key)))
    if species_note:
        body = body + "\n\nSpecies-specific note: " + species_note
    body += "\n\n"
    if positive_ref:
        body += "The first uploaded image is the target species reference. Use it for anatomy, proportions, and coloration, but do not copy photographic artifacts.\n"
    if anti_ref:
        anti_name = (ANTI_REFS.get(anti_ref_key or {}) or {}).get("common_name", "lookalike species")
        body += (
            f"The second uploaded image is a negative reference: {anti_name}. Do not copy its diagnostic features.\n"
        )
    if style_ref:
        body += (
            "The third uploaded image is a style reference only. Copy its painting technique, not its scenery, branches, or any background elements.\n"
        )
    write_prompt_file(Path(__file__).resolve().parents[1] / "assets" / "prompts", sci, body, pose)

    fields = {
        "model": OPENAI_IMAGE_MODEL,
        "prompt": body,
        "n": "1",
        "size": "1024x1024",
        "response_format": "b64_json",
    }
    files: list[tuple[str, str, bytes, str]] = []
    if positive_ref:
        files.append(("image[]", positive_ref.name, _prepare_image_bytes(positive_ref), _mime_for(positive_ref)))
    if anti_ref:
        files.append(("image[]", anti_ref.name, anti_ref.read_bytes(), _mime_for(anti_ref)))
    if style_ref:
        files.append(("image[]", style_ref.name, style_ref.read_bytes(), _mime_for(style_ref)))

    if files:
        url = OPENAI_IMAGES_EDITS_URL
        content_type, body_bytes = _openai_multipart_form(fields, files)
    else:
        url = OPENAI_IMAGES_GENERATIONS_URL
        body_bytes = json.dumps(fields).encode("utf-8")
        content_type = "application/json"

    req = urllib.request.Request(
        url,
        data=body_bytes,
        headers={
            "Content-Type": content_type,
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            resp = json.loads(r.read())
    except urllib.error.HTTPError as e:
        if e.code == 429:
            raise RuntimeError("OpenAI 429 rate limit hit: try reducing request frequency or waiting before retrying.") from e
        raise RuntimeError(f"OpenAI HTTP {e.code}: {e.reason}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"OpenAI request failed: {e.reason}") from e

    data = resp.get("data")
    if not data or not isinstance(data, list):
        raise RuntimeError(f"OpenAI response missing image data: {resp}")
    img_b64 = data[0].get("b64_json")
    if not img_b64:
        raise RuntimeError(f"OpenAI image response had no b64_json: {resp}")
    return base64.b64decode(img_b64)


def _mime_for(p: Path) -> str:
    ext = p.suffix.lower()
    if ext in (".jpg", ".jpeg"):
        return "image/jpeg"
    if ext == ".png":
        return "image/png"
    if ext == ".webp":
        return "image/webp"
    return "application/octet-stream"


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--labels", type=Path, help="Path to BirdNET-Pi labels.txt (or any file of Sci|Com lines)")
    src.add_argument("--species", action="append", default=[],
                     help="Manual 'Sci|Com' (repeatable)")
    src.add_argument("--stdin", action="store_true", help="Read Sci|Com lines from stdin")
    ap.add_argument("--ebird-region", help="eBird region code (e.g. US-CA, US-CA-085) to filter labels")
    ap.add_argument("--ebird-key", help="eBird API key (or EBIRD_API_KEY env)")
    ap.add_argument("--gemini-key", help="Gemini API key (or GEMINI_API_KEY env)")
    ap.add_argument("--out", type=Path,
                    default=Path(__file__).resolve().parents[1] / "assets" / "illustrations",
                    help="Output directory (default: avian/assets/illustrations/)")
    ap.add_argument("--refs", type=Path,
                    default=Path(__file__).resolve().parents[1] / "assets" / "references",
                    help="Reference photo cache directory (default: avian/assets/references/)")
    ap.add_argument("--styles", type=Path,
                    default=Path(__file__).resolve().parents[1] / "assets" / "references" / "styles",
                    help="Style reference directory (default: avian/assets/references/styles/)")
    ap.add_argument("--prompt", type=Path,
                    default=Path(__file__).resolve().parent / "prompt.template.md",
                    help="Prompt template path")
    ap.add_argument("--notes", type=Path,
                    default=Path(__file__).resolve().parent / "species-notes.json",
                    help="Per-species prompt addenda for difficult cases (e.g. similar-species drift)")
    ap.add_argument("--poses", nargs="+", type=int, default=[1, 2],
                    choices=list(POSES.keys()),
                    help="Which poses to render. 1=perched, 2=flight. Default: both.")
    ap.add_argument("--force", action="store_true", help="Re-render even if file exists")
    ap.add_argument("--no-refs", action="store_true",
                    help="Skip the Wikipedia reference fetch (faster, lower-quality output)")
    ap.add_argument("--sleep", type=float, default=6.0,
                    help="Seconds between API calls (default 6 = headroom under free-tier RPM cap)")
    ap.add_argument("--limit", type=int, default=0, help="Cap species count for testing")
    args = ap.parse_args()

    gemini_key = args.gemini_key or os.environ.get("GEMINI_API_KEY", "")
    # if not gemini_key:
    #     print("error: GEMINI_API_KEY required (--gemini-key or env)", file=sys.stderr)
    #     return 2

    # Build species list
    if args.labels:
        species, skipped = parse_species_list(args.labels.read_text(encoding="utf-8", errors="replace").splitlines())
    elif args.stdin:
        species, skipped = parse_species_list(sys.stdin.read().splitlines())
    else:
        species, skipped = parse_species_list(args.species)
    if skipped:
        print(f"[parse] skipped {len(skipped)} malformed line(s)", file=sys.stderr)
        for line_no, raw, reason in skipped[:10]:
            print(f"[parse] line {line_no}: {raw!r} -> {reason}", file=sys.stderr)
        if len(skipped) > 10:
            print(f"[parse] ... and {len(skipped) - 10} more skipped line(s)", file=sys.stderr)
    if not species:
        print("error: no species resolved", file=sys.stderr)
        return 2

    if args.ebird_region:
        ek = args.ebird_key or os.environ.get("EBIRD_API_KEY", "")
        if not ek:
            print("error: --ebird-region requires --ebird-key or EBIRD_API_KEY", file=sys.stderr)
            return 2
        print(f"[ebird] filtering {len(species)} species against {args.ebird_region}...")
        species = ebird_filter(species, args.ebird_region, ek)

    if args.limit:
        species = species[:args.limit]

    prompt = load_prompt(args.prompt)
    args.out.mkdir(parents=True, exist_ok=True)
    anti_paths: dict[str, Path] = {}
    if not args.no_refs:
        for key in ANTI_REFS:
            p = load_anti_ref(args.refs, key)
            if p:
                anti_paths[key] = p
    notes = load_species_notes(args.notes)
    if notes:
        print(f"[notes] loaded per-species addenda for {len(notes)} species")

    total = len(species) * len(args.poses)
    print(f"generating up to {total} illustrations into {args.out}/")
    for key, p in anti_paths.items():
        print(f"[refs] {ANTI_REFS[key]['common_name']} anti-reference: {p.name}")

    done = skipped_existing = failed = 0
    first_fail = None
    for idx, (sci, com) in enumerate(species):
        slug = slugify(sci)
        pos_ref = None
        if not args.no_refs:
            pos_ref = ensure_reference(args.refs, slug, sci, com)
            print(pos_ref)
            if not pos_ref:
                print(f"  [warn] no Wikipedia photo for {sci} - proceeding without positive ref", file=sys.stderr)
        anti_key = select_anti_ref_key(sci)
        anti = anti_paths.get(anti_key) if anti_key else None
        # Pair the key with the path so gen_one captions IMAGE 2 with the
        # right species (the bug this fixes: stale Blue-Jay caption on
        # an attached Barn-Swallow anti-ref).
        anti_key_for_call = anti_key if anti else None

        for pose in args.poses:
            fname = f"{slug}.png" if pose == 1 else f"{slug}-{pose}.png"
            path = args.out / fname
            print(path)
            if path.exists() and not args.force:
                skipped_existing += 1
                continue
            try:
                style_ref_path = args.styles / select_style_ref(sci, pose)
                if not style_ref_path.exists():
                    style_ref_path = None
                data = gen_one(gemini_key, prompt, sci, com, pose,
                               positive_ref=pos_ref, anti_ref=anti,
                               anti_ref_key=anti_key_for_call,
                               species_note=notes.get(sci),
                               style_ref=style_ref_path)
                path.write_bytes(data)
                done += 1
                refs_tag = "+ref" if pos_ref else ""
                anti_tag = "+anti" if anti else ""
                note_tag = "+note" if notes.get(sci) else ""
                print(f"  [ok]   {fname} ({len(data)//1024} KB){refs_tag}{anti_tag}{note_tag}")
            except (urllib.error.HTTPError, urllib.error.URLError, RuntimeError) as e:
                failed += 1
                first_fail = first_fail or fname
                print(f"  [fail] {fname}: {e}", file=sys.stderr)
            # Don't sleep after the last species' last pose.
            if not (idx == len(species) - 1 and pose == args.poses[-1]):
                time.sleep(args.sleep)

    print(f"\ngenerated {done} · skipped {skipped_existing} · failed {failed}")
    if first_fail:
        print(f"first failure: {first_fail} (re-run without --force to retry only the misses)", file=sys.stderr)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
