#!/usr/bin/env python3
"""Verify that an existing frame config still selects the requested source.

The installer leaves existing configs untouched. Before it changes the host, it
uses this semantic TOML check so a rerun cannot claim a different source was
installed while preserving an old, malformed, or ambiguous config.
"""

import argparse
import sys
from pathlib import Path
from urllib.parse import urlsplit

try:
    import tomllib
except ModuleNotFoundError:  # Python < 3.11
    import tomli as tomllib


def _inactive(value):
    return value in (None, "", 0, False)


def _station_id(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        text = str(value)
    elif isinstance(value, str):
        text = value
    else:
        return None
    if not text.isascii() or not text.isdecimal() or text.startswith("0"):
        return None
    number = int(text)
    return text if 1 <= number <= 2147483647 else None


def _http_url(value):
    if not isinstance(value, str) or any(ch.isspace() or ord(ch) < 32 for ch in value):
        return False
    try:
        parts = urlsplit(value)
        host = parts.hostname
        parts.port
    except ValueError:
        return False
    return parts.scheme in ("http", "https") and bool(host)


def verify(path, mode, station=None, zip_code=None, image_url=None):
    try:
        raw = path.read_bytes()
        data = tomllib.loads(raw.decode("utf-8"))
    except (OSError, UnicodeError, tomllib.TOMLDecodeError):
        return False
    if not isinstance(data, dict):
        return False

    species_source = data.get("species_source", "")
    active_station = not _inactive(data.get("bw_station_id"))
    active_zip = isinstance(data.get("zip"), str) and bool(data["zip"].strip())
    image_url_value = data.get("image_url")
    image_value = data.get("image")
    active_image_url = isinstance(image_url_value, str) and bool(image_url_value)
    active_image = isinstance(image_value, str) and bool(image_value)
    valid_image_values = (
        (not image_url_value or isinstance(image_url_value, str))
        and (not image_value or isinstance(image_value, str))
    )
    selected_image = image_url_value or image_value

    if mode == "local":
        local_capture = (
            data.get("shoot") is True
            and _http_url(data.get("base_url"))
            and not active_image_url
            and not active_image
        )
        preserved_image = (
            data.get("shoot") is False
            and valid_image_values
            and isinstance(selected_image, str)
            and bool(selected_image)
        )
        return (
            species_source == ""
            and not active_station
            and not active_zip
            and (local_capture or preserved_image)
        )
    if mode == "image":
        return (
            species_source == ""
            and not active_station
            and not active_zip
            and valid_image_values
            and data.get("shoot") is False
            and image_url_value == image_url
        )
    if mode == "birdweather" and station is not None:
        return (
            species_source == "birdweather"
            and _station_id(data.get("bw_station_id")) == station
            and not active_zip
            and not active_image_url
            and not active_image
        )
    if mode == "birdweather" and zip_code is not None:
        country = data.get("bw_country", "us")
        return (
            species_source == "birdweather"
            and not active_station
            and isinstance(data.get("zip"), str)
            and data["zip"].strip() == zip_code
            and isinstance(country, str)
            and bool(country.strip())
            and not active_image_url
            and not active_image
        )
    return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("config", type=Path)
    parser.add_argument("--mode", required=True, choices=("local", "image", "birdweather"))
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--station-id")
    source.add_argument("--zip")
    source.add_argument("--image-url")
    args = parser.parse_args()
    ok = verify(args.config, args.mode, args.station_id, args.zip, args.image_url)
    if not ok:
        print("existing frame config does not select the requested source", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
