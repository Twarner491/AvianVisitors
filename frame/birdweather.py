#!/usr/bin/env python3
"""Top recently-heard birds near a ZIP, from BirdWeather, for the frame's
--bird-weather mode.

Returns the shape the collage already expects, [{"sci","com","n"}], so the
existing renderer draws it unchanged. Standalone (Python stdlib only). Filtered
to species the collage can actually draw, read from the slug list bundled in
apt.js, so no network call and it tracks whatever illustrations the repo ships.
BirdWeather's public GraphQL needs no key.
"""
from __future__ import annotations

import json
import math
import os
import re
import urllib.parse
import urllib.request

BIRDWEATHER = "https://app.birdweather.com/graphql"
GEOCODER = "https://api.zippopotam.us"
EBIRD = "https://api.ebird.org/v2/data/obs/geo/recent"
APT_JS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "avian", "frontend", "apt.js")

_drawable = None
_GEO_CACHE = os.path.expanduser("~/.birdframe/geocode.json")


def _graphql(query, timeout):
    req = urllib.request.Request(
        BIRDWEATHER,
        data=json.dumps({"query": query}).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "AvianVisitors-frame/1.0"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read(2_000_000))
    except Exception:
        return {}  # a transient upstream failure degrades to the next radius or fallback


def geocode(zip_code, country="us", timeout=20):
    """ZIP / postal code to (lat, lon) via the keyless zippopotam.us gazetteer.
    A ZIP's coordinates never move, so the result is cached on disk and the
    frame geocodes once rather than on every 15-minute refresh."""
    zip_code = zip_code.strip()
    key = f"{country}/{zip_code}".lower()
    store = {}
    try:
        with open(_GEO_CACHE) as f:
            loaded = json.load(f)
        if isinstance(loaded, dict):
            store = loaded
            hit = store.get(key)
            if isinstance(hit, list) and len(hit) == 2:  # shape-guard a hand-edited / stale entry
                return float(hit[0]), float(hit[1])
    except Exception:
        store = {}
    url = f"{GEOCODER}/{country}/{urllib.parse.quote(zip_code)}"
    req = urllib.request.Request(url, headers={"User-Agent": "AvianVisitors-frame/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        place = json.loads(r.read(200_000))["places"][0]
    lat, lon = float(place["latitude"]), float(place["longitude"])
    store[key] = [lat, lon]
    try:
        os.makedirs(os.path.dirname(_GEO_CACHE), exist_ok=True)
        tmp = _GEO_CACHE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(store, f)
        os.replace(tmp, _GEO_CACHE)  # atomic, like display.py's state write
    except Exception:
        pass
    return lat, lon


def bbox(lat, lon, miles):
    """Square box `miles` to each side of the point. Returns (ne, sw) corners."""
    dlat = miles / 69.0
    dlon = miles / (69.0 * max(0.2, math.cos(math.radians(lat))))
    return (lat + dlat, lon + dlon), (lat - dlat, lon - dlon)


def top_species(lat, lon, miles, days=7, limit=60, timeout=20):
    """BirdWeather's most-detected species in the box, as [{sci,com,n}]."""
    (ne_lat, ne_lon), (sw_lat, sw_lon) = bbox(lat, lon, miles)
    query = (
        '{ topSpecies(period: {count: %d, unit: "day"}, '
        'ne: {lat: %f, lon: %f}, sw: {lat: %f, lon: %f}, limit: %d) '
        '{ count species { commonName scientificName } } }'
        % (days, ne_lat, ne_lon, sw_lat, sw_lon, limit)
    )
    rows = (_graphql(query, timeout).get("data") or {}).get("topSpecies") or []
    out = []
    for row in rows:
        sp = row.get("species") or {}
        sci = sp.get("scientificName")
        if sci:
            out.append({"sci": sci, "com": sp.get("commonName") or sci, "n": row.get("count") or 1})
    return out


def _haversine(lat1, lon1, lat2, lon2):
    """Great-circle distance between two points, in miles."""
    r = 3958.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def nearest_stations(lat, lon, n=3, boxes=(50, 150, 400), timeout=20):
    """The n closest BirdWeather stations to the point, as [(miles, id)], found
    by growing the search box until at least n are in view."""
    nodes = []
    for miles in boxes:
        (ne_lat, ne_lon), (sw_lat, sw_lon) = bbox(lat, lon, miles)
        query = ('{ stations(ne: {lat: %f, lon: %f}, sw: {lat: %f, lon: %f}, first: 200) '
                 '{ nodes { id coords { lat lon } } } }' % (ne_lat, ne_lon, sw_lat, sw_lon))
        nodes = (((_graphql(query, timeout).get("data") or {}).get("stations") or {}).get("nodes")) or []
        if len(nodes) >= n:
            break
    out = []
    for node in nodes:
        c = node.get("coords") or {}
        if c.get("lat") is not None and c.get("lon") is not None:
            out.append((_haversine(lat, lon, c["lat"], c["lon"]), node["id"]))
    out.sort()
    return out[:n]


def triangulate(lat, lon, n=3, days=7, timeout=20):
    """Estimate the birds near a point from the n closest stations, inverse-
    distance weighted so the nearest station counts most. Used where the local
    box has too few stations to fill a collage, so remote ZIPs still get birds."""
    weighted = {}
    for miles, sid in nearest_stations(lat, lon, n, timeout=timeout):
        weight = 1.0 / max(miles, 1.0)
        query = ('{ topSpecies(stationIds: [%s], period: {count: %d, unit: "day"}, limit: 40) '
                 '{ count species { commonName scientificName } } }' % (sid, days))
        for row in (((_graphql(query, timeout).get("data") or {}).get("topSpecies")) or []):
            sp = row.get("species") or {}
            sci = sp.get("scientificName")
            if not sci:
                continue
            entry = weighted.setdefault(sci, {"com": sp.get("commonName") or sci, "score": 0.0})
            entry["score"] += (row.get("count") or 0) * weight
    out = [{"sci": sci, "com": e["com"], "n": max(1, round(e["score"]))} for sci, e in weighted.items()]
    out.sort(key=lambda s: -s["n"])
    return out


def ebird_nearby(lat, lon, days=14, key=None, timeout=20):
    """Recent eBird observations near the point, as [{sci,com,n}]. The deepest
    fallback, for spots with no station in range. Needs a free eBird API key in
    EBIRD_API_KEY and returns [] without one, so keyless installs just skip it."""
    key = key or os.environ.get("EBIRD_API_KEY")
    if not key:
        return []
    url = f"{EBIRD}?lat={lat:.4f}&lng={lon:.4f}&dist=50&back={min(days, 30)}"
    req = urllib.request.Request(url, headers={"X-eBirdApiToken": key, "User-Agent": "AvianVisitors-frame/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            observations = json.loads(r.read(5_000_000))
    except Exception:
        return []
    tally = {}
    for o in observations:
        sci = o.get("sciName")
        if not sci:
            continue
        entry = tally.setdefault(sci, {"com": o.get("comName") or sci, "n": 0})
        entry["n"] += o.get("howMany") or 1
    out = [{"sci": sci, "com": e["com"], "n": e["n"]} for sci, e in tally.items()]
    out.sort(key=lambda s: -s["n"])
    return out


def slugify(sci):
    return re.sub(r"[^a-z0-9]+", "-", sci.lower()).strip("-")


def drawable_slugs(apt_js=APT_JS):
    """Base slugs we have a cutout for, parsed once from the collage's bundled
    DIMS table (perched and flight entries collapse to the base slug)."""
    global _drawable
    if _drawable is None:
        with open(apt_js, encoding="utf-8") as f:
            block = re.search(r"var DIMS = (\{.*?\});", f.read(), re.S)
        keys = re.findall(r'"([a-z0-9-]+)"\s*:', block.group(1)) if block else []
        _drawable = {re.sub(r"-2$", "", k) for k in keys}
    return _drawable


def species_for_zip(zip_code, country="us", target=10, days=7, radii=(15, 30, 50),
                    apt_js=APT_JS, timeout=20):
    """Geocode the ZIP, pull BirdWeather top species, and grow the search radius
    only until `target` drawable species are found, so it stays as local as the
    data allows. Returns the top `target` by detection count, or fewer where
    birds or stations are sparse.
    """
    lat, lon = geocode(zip_code, country, timeout)
    have = drawable_slugs(apt_js)
    found = []
    for miles in radii:
        found = [s for s in top_species(lat, lon, miles, days, 60, timeout)
                 if slugify(s["sci"]) in have]
        if len(found) >= target:
            break
    if len(found) < target:
        # box too sparse: estimate from the nearest stations so remote ZIPs still fill
        tri = [s for s in triangulate(lat, lon, 3, days, timeout) if slugify(s["sci"]) in have]
        if len(tri) > len(found):
            found = tri
    if len(found) < target:
        # no station in range at all: fall back to eBird sightings, if a key is set
        eb = [s for s in ebird_nearby(lat, lon, days * 2, timeout=timeout) if slugify(s["sci"]) in have]
        if len(eb) > len(found):
            found = eb
    found.sort(key=lambda s: -(s["n"] or 0))
    return found[:target]


def coverage_for_zip(zip_code, country="us", sample=15, days=7, radii=(15, 30, 50),
                     apt_js=APT_JS, timeout=20):
    """Split the ZIP's most-detected birds by whether the repo can draw them.

    Same gather as species_for_zip (grow the radius, then triangulate / eBird
    for sparse spots) but UNFILTERED, capped at the top `sample` by count, then
    partitioned. Returns (have, missing) as [{sci,com,n}] lists sorted by count:
    `have` are bundled today, `missing` are the local birds with no cutout yet -
    the set the installer offers to generate. `sample` sits a little above the
    render's `target` (10) so a few extra cover BirdWeather count drift without
    generating birds that never reach the collage. The split is always against
    the current bundle, so adding illustrations upstream shrinks `missing` free.
    """
    lat, lon = geocode(zip_code, country, timeout)
    top = []
    for miles in radii:
        top = top_species(lat, lon, miles, days, 60, timeout)
        if len(top) >= sample:
            break
    if len(top) < sample:
        tri = triangulate(lat, lon, 3, days, timeout)
        if len(tri) > len(top):
            top = tri
    if len(top) < sample:
        eb = ebird_nearby(lat, lon, days * 2, timeout=timeout)
        if len(eb) > len(top):
            top = eb
    top.sort(key=lambda s: -(s["n"] or 0))
    top = top[:sample]
    drawable = drawable_slugs(apt_js)
    have = [s for s in top if slugify(s["sci"]) in drawable]
    missing = [s for s in top if slugify(s["sci"]) not in drawable]
    return have, missing


if __name__ == "__main__":
    import argparse
    import sys
    ap = argparse.ArgumentParser(description="BirdWeather top species for a ZIP.")
    ap.add_argument("zip")
    ap.add_argument("--country", default="us")
    ap.add_argument("--target", type=int, default=10)
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--missing", action="store_true",
                    help="Print the ZIP's top LOCAL birds the repo can't draw yet "
                         "as Sci|Com lines (feed to pregen.py --stdin); summary to stderr.")
    ap.add_argument("--sample", type=int, default=15,
                    help="How many of the ZIP's top birds to weigh for --missing (default 15).")
    a = ap.parse_args()
    if a.missing:
        try:
            have, missing = coverage_for_zip(a.zip, a.country, a.sample, a.days)
        except Exception as e:
            # Never break the installer: no data just means no generation offer.
            print(f"coverage lookup failed: {e}", file=sys.stderr)
            sys.exit(0)
        for s in missing:
            print(f'{s["sci"]}|{s["com"]}')
        total = len(have) + len(missing)
        print(f"{len(have)} of the top {total} birds near {a.zip} are bundled; "
              f"{len(missing)} are not.", file=sys.stderr)
    else:
        for s in species_for_zip(a.zip, a.country, a.target, a.days):
            print(f'{s["n"]:>8}  {s["com"]}  ({s["sci"]})')
