#!/usr/bin/env python3
"""Build deterministic, content-addressed catalog previews for one bundle.

The cover thumbnail and collage examples are derived from manifest-listed PNGs
inside the reviewed archive.  They are cropped to the visible alpha silhouette,
bounded, and encoded alongside the exact one-bit mask used by the browser
collage.  Nothing supplied by the browser can become a preview record.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import zipfile
from pathlib import Path


ALPHA_ON = 127
MASK_MAX = 93
STATION_DIM_MAX = 560
RENDER_MAX = 960
MAX_EXAMPLES = 6
FORMAT = "avian-bundle-preview-geometry"
FORMAT_VERSION = 1
MASK_ENCODING = "msb-first-row-major-base64"
DERIVATION = "alpha127-tightcrop-lanczos-v1"


class PreviewGeometryError(ValueError):
    pass


def _common_name(bird: dict) -> str:
    if "common_name" not in bird:
        return ""
    value = bird["common_name"]
    if (
        not isinstance(value, str)
        or len(value) > 100
        or any(
            ord(character) < 0x20
            or ord(character) == 0x7F
            or 0xD800 <= ord(character) <= 0xDFFF
            or character in "<>"
            for character in value
        )
    ):
        raise PreviewGeometryError("preview bird has an invalid common name")
    return value


def canonical_json(value: object) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode("utf-8")


def station_full_canvas_geometry(source: bytes) -> tuple[list[int], dict[str, object]]:
    """Prove the exact full-canvas station mask derivation remains nonempty."""
    try:
        from PIL import Image

        with Image.open(io.BytesIO(source)) as opened:
            if opened.format != "PNG" or getattr(opened, "n_frames", 1) != 1:
                raise PreviewGeometryError("station geometry source is not a static PNG")
            opened.load()
            image = opened.convert("RGBA")
    except PreviewGeometryError:
        raise
    except Exception as exc:
        raise PreviewGeometryError("station geometry source is not a decodable PNG") from exc

    try:
        width, height = image.size
        dimension_scale = STATION_DIM_MAX / max(width, height)
        dimensions = [
            max(1, round(width * dimension_scale)),
            max(1, round(height * dimension_scale)),
        ]
        mask_scale = MASK_MAX / max(width, height)
        mask_width = max(1, round(width * mask_scale))
        mask_height = max(1, round(height * mask_scale))
        mask_alpha = image.getchannel("A").resize(
            (mask_width, mask_height), Image.Resampling.LANCZOS
        )
        pixels = mask_alpha.load()
        packed = bytearray((mask_width * mask_height + 7) // 8)
        for y in range(mask_height):
            for x in range(mask_width):
                if pixels[x, y] > ALPHA_ON:
                    index = y * mask_width + x
                    packed[index >> 3] |= 1 << (7 - (index & 7))
        if not any(packed):
            raise PreviewGeometryError("station full-canvas mask is empty")
        return dimensions, {
            "w": mask_width,
            "h": mask_height,
            "bits": base64.b64encode(packed).decode("ascii"),
        }
    finally:
        image.close()


def _pose_for(bird: dict) -> dict:
    poses = bird.get("poses") or []
    return next((pose for pose in poses if pose.get("id") == "perched"), poses[0])


def _selected_birds(manifest: dict, cover_species: str) -> tuple[dict, list[dict]]:
    species = manifest.get("species") or []
    cover = next(
        (bird for bird in species if bird.get("scientific_name") == cover_species),
        None,
    )
    if cover is None:
        raise PreviewGeometryError("selected cover bird is not in manifest.json")

    # The cover is intentionally absent from the six examples.  Skip repeated
    # image objects too: showing the same pixels twice is not a useful sample.
    cover_digest = _pose_for(cover).get("sha256")
    examples: list[dict] = []
    seen_sources = {cover_digest}
    for bird in species:
        if bird is cover:
            continue
        digest = _pose_for(bird).get("sha256")
        if digest in seen_sources:
            continue
        seen_sources.add(digest)
        examples.append(bird)
        if len(examples) == MAX_EXAMPLES:
            break
    return cover, examples


def _render(source: bytes) -> tuple[bytes, list[int], dict[str, object]]:
    try:
        from PIL import Image

        with Image.open(io.BytesIO(source)) as opened:
            image = opened.convert("RGBA")
    except Exception as exc:
        raise PreviewGeometryError("preview source is not a decodable PNG") from exc

    alpha = image.getchannel("A")
    thresholded = alpha.point(lambda value: 255 if value > ALPHA_ON else 0)
    bbox = thresholded.getbbox()
    if bbox is None:
        raise PreviewGeometryError("preview source has no visible alpha pixels")
    image = image.crop(bbox)
    if max(image.size) > RENDER_MAX:
        scale = RENDER_MAX / max(image.size)
        image = image.resize(
            (max(1, round(image.width * scale)), max(1, round(image.height * scale))),
            Image.Resampling.LANCZOS,
        )
    width, height = image.size

    mask_scale = MASK_MAX / max(width, height)
    mask_width = max(1, round(width * mask_scale))
    mask_height = max(1, round(height * mask_scale))
    mask_alpha = image.getchannel("A").resize(
        (mask_width, mask_height), Image.Resampling.LANCZOS
    )
    packed = bytearray((mask_width * mask_height + 7) // 8)
    pixels = (
        mask_alpha.get_flattened_data()
        if hasattr(mask_alpha, "get_flattened_data")
        else mask_alpha.getdata()
    )
    on_pixels = 0
    for index, value in enumerate(pixels):
        if value > ALPHA_ON:
            packed[index >> 3] |= 1 << (7 - (index & 7))
            on_pixels += 1
    if not on_pixels:
        raise PreviewGeometryError("preview mask is empty")

    output = io.BytesIO()
    image.save(output, format="PNG", optimize=False, compress_level=9)
    render = output.getvalue()
    mask_bytes = bytes(packed)
    return render, [width, height], {
        "w": mask_width,
        "h": mask_height,
        "encoding": MASK_ENCODING,
        "bits": base64.b64encode(mask_bytes).decode("ascii"),
        "sha256": hashlib.sha256(mask_bytes).hexdigest(),
    }


def _descriptor(source_reader, bird: dict, include_mask: bool) -> tuple[dict, bytes]:
    pose = _pose_for(bird)
    try:
        source = source_reader(pose["file"])
    except (KeyError, OSError, RuntimeError) as exc:
        raise PreviewGeometryError("preview source is missing from the archive") from exc
    source_digest = hashlib.sha256(source).hexdigest()
    if source_digest != pose.get("sha256") or len(source) != pose.get("bytes"):
        raise PreviewGeometryError("preview source differs from manifest.json")
    render, dims, mask = _render(source)
    render_digest = hashlib.sha256(render).hexdigest()
    descriptor = {
        "render_url": f"/api/bundles/objects/{render_digest}.png",
        "render_sha256": render_digest,
        "render_bytes": len(render),
        "source_sha256": source_digest,
        "scientific_name": bird["scientific_name"],
        "common_name": _common_name(bird),
        "dims": dims,
    }
    if include_mask:
        descriptor["mask"] = mask
    return descriptor, render


def build_preview_package_from_reader(
    manifest: dict, manifest_raw: bytes, source_reader, cover_species: str,
) -> tuple[dict, bytes, dict[str, bytes]]:
    """Return geometry and renders from an exact manifest-bound byte reader."""
    cover_bird, example_birds = _selected_birds(manifest, cover_species)
    renders: dict[str, bytes] = {}
    cover, cover_png = _descriptor(source_reader, cover_bird, include_mask=False)
    renders[cover["render_sha256"]] = cover_png
    items: dict[str, dict] = {}
    order: list[str] = []
    for bird in example_birds:
        item, png = _descriptor(source_reader, bird, include_mask=True)
        digest = item["render_sha256"]
        if digest == cover["render_sha256"]:
            raise PreviewGeometryError(
                "cover and example species produce identical rendered artwork"
            )
        if digest in items:
            raise PreviewGeometryError("two preview species produce identical rendered artwork")
        items[digest] = item
        order.append(digest)
        renders[digest] = png
    geometry = {
        "format": FORMAT,
        "format_version": FORMAT_VERSION,
        "source_manifest_sha256": hashlib.sha256(manifest_raw).hexdigest(),
        "derivation": DERIVATION,
        "alpha_threshold": ALPHA_ON,
        "mask_max": MASK_MAX,
        "render_max": RENDER_MAX,
        "cover": cover,
        "example_order": order,
        "items": items,
    }
    raw = canonical_json(geometry)
    return geometry, raw, renders


def build_preview_package(
    archive_path: Path, manifest: dict, cover_species: str
) -> tuple[dict, bytes, dict[str, bytes]]:
    """Return geometry object, canonical bytes, and derived PNGs by digest."""
    with zipfile.ZipFile(archive_path) as archive:
        manifest_raw = archive.read("manifest.json")
        return build_preview_package_from_reader(
            manifest,
            manifest_raw,
            archive.read,
            cover_species,
        )
