"""A release-reviewed relationship composes whole birds before local selection."""
import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest

from tests.test_bundle_manager import BundleFixture, bundle_manager as station, png_bytes, sha256

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "frame"))
import bundle_runtime as frame


@pytest.fixture
def library(tmp_path, monkeypatch):
    child = BundleFixture()
    # Child has only one pose of this shared species; a flight pose from the
    # base must never appear alongside the child's perched image.
    child.manifest["species"][0]["poses"].pop()
    child.pack.pop("search_terms")
    base = copy.deepcopy(child.manifest)
    base.update(id=station.BUILTIN_ID, version="1.0.0", name="Japanese Woodblock")
    base["attribution"] = {"creator": "Base artist", "source_url": "https://example.org/base"}
    base["species"] = []
    images = {}
    for name, poses in [(child.scientific_name, ["perched", "flight"]), ("Passer domesticus", ["perched"])]:
        bird = {"scientific_name": name, "poses": []}
        for pose in poses:
            raw = png_bytes((22 + len(images), 71, 83, 255))
            bird["poses"].append({"id": pose, "file": station.pose_path(name, pose),
                                  "sha256": sha256(raw), "bytes": len(raw)})
            images[sha256(raw)] = raw
        base["species"].append(bird)
    data = station.canonical_json
    dev = tmp_path / "publication"
    child.manifest_raw = data(child.manifest)
    child.manifest_hash = sha256(child.manifest_raw)
    child.pack["manifest"] = {"sha256": child.manifest_hash, "bytes": len(child.manifest_raw),
                              "url": station.MANIFEST_BASE_URL + child.manifest_hash + ".json"}
    child.pack["archive_bytes"] = len(child.images["perched"])
    child.publish(dev)
    base_raw = data(base)
    base_sha = sha256(base_raw)
    (dev / "manifests" / (base_sha + ".json")).write_bytes(base_raw)
    base_row = {**child.pack, "id": base["id"], "version": base["version"], "name": base["name"],
                "review": "official", "availability": "included", "creator": "Base artist",
                "species": [b["scientific_name"] for b in base["species"]], "species_count": 2,
                "manifest": {"url": station.MANIFEST_BASE_URL + base_sha + ".json",
                             "sha256": base_sha, "bytes": len(base_raw)}}
    official = tmp_path / "official.json"
    official.write_bytes(data({**child.catalog, "packs": [base_row]}))
    images[sha256(child.images["perched"])] = child.images["perched"]
    for digest, raw in images.items():
        p = dev / "objects/sha256" / digest[:2] / (digest + ".png")
        p.parent.mkdir(exist_ok=True, parents=True)
        p.write_bytes(raw)
        (dev / "objects" / (digest + ".png")).write_bytes(raw)
    (dev / "catalog.json").write_bytes(data(child.catalog))
    (dev / "community-catalog-v1.json").write_bytes(data(child.catalog))
    monkeypatch.setenv("AVIAN_BUNDLE_ROOT", str(tmp_path / "station"))
    monkeypatch.setenv("AVIAN_BUNDLE_CATALOG", str(official))
    monkeypatch.setenv("AVIAN_BUNDLE_DEV_ROOT", str(dev))
    monkeypatch.setenv("AVIAN_BUNDLE_LOCK", str(tmp_path / "station.lock"))
    monkeypatch.setenv("AVIAN_BUNDLE_CONFIG", str(tmp_path / "missing.conf"))
    monkeypatch.setenv("AVIAN_BUNDLE_DB", str(tmp_path / "missing.db"))
    monkeypatch.setenv("AVIAN_FRAME_BUNDLE_DEV_ROOT", str(dev))
    monkeypatch.setenv("AVIAN_FRAME_BUNDLE_ROOT", str(tmp_path / "frame"))
    pins = {(child.pack_id, child.version, child.manifest_hash): (base_sha, len(base_raw))}
    for module in (station, frame):
        monkeypatch.setattr(module, "WOODBLOCK_EXTENSIONS", pins, raising=False)
    return child, base, base_sha, dev


def install(runtime, child):
    if runtime is frame:
        frame.use(child.pack_id, config={}, all_species=True)
        active = frame.active_bundle()
        return active.reference, active.directory, active.index["assets"]
    station.initialize()
    job_id = "a" * 32
    job = {"schema_version": 1, "id": job_id, "operation": "install", "bundle_id": child.pack_id,
           "bundle_version": child.version, "activate": True, "all_species": True, "state": "queued",
           "phase": "queued", "current": 0, "total": 0, "percent": 0, "error": "",
           "created_at": station.utc_now(), "updated_at": station.utc_now()}
    station.atomic_json(station.bundle_root() / station.CACHE_CATALOG_NAME, child.catalog)
    station.atomic_json(station.bundle_root() / "job.json", job)
    station.run_job(job_id)
    assert station.load_job()["state"] == "complete", station.load_job()["error"]
    reference = station.load_state()["active"]
    return reference, station.pack_directory(reference), station.load_index(reference)["assets"]


@pytest.mark.parametrize("runtime", [station, frame], ids=["station", "frame"])
def test_reviewed_base_restores_missing_bird_but_not_a_missing_pose(library, runtime):
    child, base, base_sha, dev = library
    ref, directory, assets = install(runtime, child)
    assert set(assets) == {"corvus-brachyrhynchos", "passer-domesticus"}
    assert set(assets["corvus-brachyrhynchos"]) == {"perched"}
    assert assets["corvus-brachyrhynchos"]["perched"]["sha256"] == sha256(child.images["perched"])
    assert assets["passer-domesticus"]["perched"]["sha256"] == base["species"][1]["poses"][0]["sha256"]
    assert set(json.loads((directory / "masks.json").read_bytes())) == set(assets)
    assert set(json.loads((directory / "dims.json").read_bytes())) == set(assets)
    assert sha256((directory / "manifest.json").read_bytes()) == ref["revision"] == child.manifest_hash
    assert sha256((directory / "base-manifest.json").read_bytes()) == base_sha
    assert json.loads((directory / "selection.json").read_bytes())["base_manifest_sha256"] == base_sha
    if runtime is station:
        response = subprocess.run(["php", str(ROOT / "avian/api/bundle-assets.php")],
                                  capture_output=True, check=True)
        assert json.loads(response.stdout)["active"]["species_count"] == 2
        assert "Base artist" in station.validate_installed_pack(ref)["creator"]
        listed = station.catalog_pack(station.snapshot()["catalog"], child.pack_id)
        assert listed["species_count"] == 2
        assert "Base artist" in listed["creator"]
    else:
        assert frame.active_bundle().resolve("Passer domesticus", "perched").read_bytes() == (
            dev / "objects" / (assets["passer-domesticus"]["perched"]["sha256"] + ".png")
        ).read_bytes()


def test_using_again_can_select_only_a_base_bird(library, monkeypatch):
    child, _, _, _ = library
    install(station, child)
    monkeypatch.setattr(station, "refresh_catalog", station.load_catalog)
    monkeypatch.setattr(station, "local_selection_basis", lambda: {
        "species": ["Passer domesticus"], "basis_sha256": "4" * 64})
    # Keep the real job, activation and selection, replacing only detachment:
    # the subprocess would not inherit the fixture's small test pin.
    monkeypatch.setattr(station.subprocess, "Popen", lambda args, **kw: station.run_job(args[-1]))
    result = station.use_selector(child.pack_id)
    assert set(station.load_index(result["bundle"])["assets"]) == {"passer-domesticus"}
    assert station.use_selector(child.pack_id)["changed"] is False


@pytest.mark.parametrize("runtime", [station, frame], ids=["station", "frame"])
def test_cached_extension_can_be_selected_without_base_download(library, runtime, monkeypatch):
    child, _, base_sha, dev = library
    reference, _, assets = install(runtime, child)
    assert 'passer-domesticus' in assets
    (dev / "manifests" / (base_sha + ".json")).unlink()
    if runtime is station:
        station.activate_reference(station.builtin_ref())
        monkeypatch.setattr(station, "refresh_catalog", station.load_catalog)
        monkeypatch.setattr(station.subprocess, "Popen", lambda args, **kw: station.run_job(args[-1]))
        result = station.use_selector(child.pack_id, all_species=True)
        assert result["bundle"] == reference
        station.validate_installed_pack(reference, verify_hashes=True)
    else:
        frame.use(child.pack_id, config={}, all_species=True)
        assert frame.active_bundle().reference == reference


@pytest.mark.parametrize("runtime", [station, frame], ids=["station", "frame"])
@pytest.mark.parametrize("child_first", [True, False])
@pytest.mark.parametrize("variants", [False, True])
def test_explicit_regions_precede_implicit_base(library, runtime, monkeypatch, child_first, variants):
    child, base, _, dev = library
    fallback = copy.deepcopy(base['species'][1])
    fallback['scientific_name'] = 'Sturnus vulgaris'
    fallback['poses'][0]['file'] = station.pose_path('Sturnus vulgaris', 'perched')
    base['species'].append(fallback)
    base_raw = station.canonical_json(base)
    base_sha = sha256(base_raw)
    (dev / 'manifests' / (base_sha + '.json')).write_bytes(base_raw)
    monkeypatch.setitem(runtime.WOODBLOCK_EXTENSIONS, (child.pack_id, child.version, child.manifest_hash),
                        (base_sha, len(base_raw)))
    other = BundleFixture()
    other.pack.pop('search_terms')
    other.pack_id = 'community-other-region'
    other.manifest.update(id=other.pack_id)
    other.manifest['species'][0]['scientific_name'] = 'Passer domesticus'
    for pose in other.manifest['species'][0]['poses']:
        pose['file'] = station.pose_path('Passer domesticus', pose['id'])
    if variants:
        other.manifest['format_version'] = 2
        for number, pose in enumerate(other.manifest['species'][0]['poses'], 1):
            pose['id'] = f'variant-{number}'
            pose['file'] = station.pose_path('Passer domesticus', pose['id'])
        other.pack['previews'][0]['pose'] = 'variant-1'
    unique = copy.deepcopy(other.manifest['species'][0])
    unique['scientific_name'] = 'Sitta europaea'
    for pose in unique['poses']:
        pose['file'] = station.pose_path('Sitta europaea', pose['id'])
    other.manifest['species'].append(unique)
    other.manifest_raw = station.canonical_json(other.manifest)
    other.manifest_hash = sha256(other.manifest_raw)
    other.pack.update(id=other.pack_id, species=['Passer domesticus', 'Sitta europaea'],
                      species_count=2, archive_bytes=other.pack['archive_bytes'] * 2)
    other.pack['previews'][0]['scientific_name'] = 'Passer domesticus'
    other.pack['manifest'] = {'sha256': other.manifest_hash, 'bytes': len(other.manifest_raw),
                              'url': station.MANIFEST_BASE_URL + other.manifest_hash + '.json'}
    other.publish(dev)
    for raw in other.images.values():
        (dev / 'objects' / (sha256(raw) + '.png')).write_bytes(raw)
    catalog = {**child.catalog, 'packs': child.catalog['packs'] + [other.pack]}
    (dev / 'catalog.json').write_bytes(station.canonical_json(catalog))
    (dev / 'community-catalog-v1.json').write_bytes(station.canonical_json(catalog))
    ids = [child.pack_id, other.pack_id] if child_first else [other.pack_id, child.pack_id]
    if runtime is station:
        station.initialize()
        station.atomic_json(station.bundle_root() / station.CACHE_CATALOG_NAME, catalog)
        monkeypatch.setattr(station, 'refresh_catalog', station.load_catalog)
        monkeypatch.setattr(station.subprocess, 'Popen', lambda args, **kw: station.run_job(args[-1]))
        result = station.use_selectors(ids, all_species=True)
        reference = result['bundle']
        assets = station.load_index(reference)['assets']
        receipt = station.load_selection(reference, station.pack_directory(reference))
        assert station.snapshot()['library']['active_ids'] == ids
        station.validate_installed_pack(reference, verify_hashes=True)
    else:
        frame.use_many(ids, config={}, all_species=True)
        active = frame.active_bundle()
        assets = active.index['assets']
        receipt = json.loads((active.directory / 'selection.json').read_bytes())
    assert [source['id'] for source in receipt['sources']] == ids
    assert receipt.get('base_manifest_sha256') == base_sha
    assert set(assets) == {'corvus-brachyrhynchos', 'passer-domesticus', 'sturnus-vulgaris', 'sitta-europaea'}
    assert assets['sturnus-vulgaris']['perched']['sha256'] == fallback['poses'][0]['sha256']
    first_pose = 'variant-1' if variants else 'perched'
    assert set(assets['passer-domesticus']) == ({'variant-1', 'variant-2'} if variants else {'perched', 'flight'})
    assert assets['passer-domesticus'][first_pose]['sha256'] == sha256(other.images['perched'])
    assert assets['passer-domesticus'][first_pose]['sha256'] != base['species'][1]['poses'][0]['sha256']
    if runtime is station:
        official = station.catalog_path()
        listed = json.loads(official.read_bytes())
        listed['packs'][0]['id'] = 'official-other-art'
        listed['packs'][0]['availability'] = 'unavailable'
        official.write_bytes(station.canonical_json(listed))
        card = station.catalog_pack(station.snapshot()['catalog'], child.pack_id)
        assert card['species_count'] == 3
        assert card['creator'] == 'Test Contributor + Base artist (base)'


@pytest.mark.parametrize("base_head", ["absent", "new-version"])
def test_catalog_turnover_does_not_hide_other_packs_or_rebind_the_base(library, monkeypatch, base_head):
    child, _, _, _ = library
    official = station.catalog_path()
    catalog = json.loads(official.read_bytes())
    original = catalog["packs"][0]
    unrelated = {**original, "id": "official-other-art", "availability": "unavailable"}
    catalog["packs"] = [unrelated]
    if base_head == "new-version":
        catalog["packs"].append({**original, "version": "2.0.0",
                                 "manifest": {**original["manifest"], "sha256": "a" * 64,
                                              "url": station.MANIFEST_BASE_URL + "a" * 64 + ".json"}})
    official.write_bytes(station.canonical_json(catalog))
    station.initialize()
    station.atomic_json(station.bundle_root() / station.CACHE_CATALOG_NAME, child.catalog)
    before = station.snapshot()["catalog"]
    assert station.catalog_pack(before, unrelated["id"])["id"] == unrelated["id"]
    assert station.catalog_pack(before, child.pack_id)["id"] == child.pack_id
    monkeypatch.setattr(station, "refresh_catalog", station.load_catalog)
    monkeypatch.setattr(station, "local_selection_basis", lambda: {
        "species": ["Passer domesticus"], "basis_sha256": "4" * 64})
    monkeypatch.setattr(station.subprocess, "Popen", lambda args, **kw: station.run_job(args[-1]))
    result = station.use_selector(child.pack_id)
    assert set(station.load_index(result["bundle"])["assets"]) == {"passer-domesticus"}
    after = station.catalog_pack(station.snapshot()["catalog"], child.pack_id)
    assert after["species_count"] == 2
    assert "Base artist" in after["creator"]


@pytest.mark.parametrize("runtime", [station, frame], ids=["station", "frame"])
def test_old_profile_remains_exact_after_upgrade_and_rollback(library, runtime, monkeypatch):
    child, _, _, _ = library
    with monkeypatch.context() as old:
        old.setattr(runtime, "WOODBLOCK_EXTENSIONS", {})
        previous, directory, assets = install(runtime, child)
    assert set(assets) == {"corvus-brachyrhynchos"}
    original = {file.name: file.read_bytes() for file in directory.iterdir()}
    changed, _, _ = install(runtime, child)
    assert changed["selection_revision"] != previous["selection_revision"]
    if runtime is station:
        # The digest-named profile directories need not enumerate newest first.
        records = sorted(station.installed_records(), key=lambda record: record["installed_at"])
        monkeypatch.setattr(station, "installed_records", lambda: records)
        pack = station.catalog_pack(station.snapshot()["catalog"], child.pack_id)
        assert pack["activation_presentation"]["species_count"] == 2
        assert pack["activation_presentation"]["creator"] == "Test Contributor + Base artist (base)"
    restored = station.rollback_active() if runtime is station else frame.rollback()["bundle"]
    assert restored == previous
    assert {file.name: file.read_bytes() for file in directory.iterdir()} == original


@pytest.mark.parametrize("runtime", [station, frame], ids=["station", "frame"])
@pytest.mark.parametrize("failure", ["missing", "changed", "self", "unknown-field", "limit", "style", "license"])
def test_invalid_or_unavailable_base_cannot_replace_active_profile(library, runtime, monkeypatch, failure):
    child, base, base_sha, dev = library
    with monkeypatch.context() as old:
        old.setattr(runtime, "WOODBLOCK_EXTENSIONS", {})
        original, _, _ = install(runtime, child)
    path = dev / "manifests" / (base_sha + ".json")
    if failure == "missing":
        path.unlink()
    elif failure == "changed":
        path.write_bytes(path.read_bytes() + b" ")
    else:
        if failure == "self":
            base["id"] = child.pack_id
        elif failure == "limit":
            # Both source inventories fit separately; the three-bird union does not.
            base["species"][0]["scientific_name"] = "Sturnus vulgaris"
            for pose in base["species"][0]["poses"]:
                pose["file"] = station.pose_path("Sturnus vulgaris", pose["id"])
            monkeypatch.setattr(runtime, "SPECIES_MAX", 2)
        elif failure == "style":
            base["style"]["id"] = "oil"
        elif failure == "license":
            base["license"]["spdx"] = "CC0-1.0"
        else:
            base["extends"] = {"id": child.pack_id}
        raw = station.canonical_json(base)
        (dev / "manifests" / (sha256(raw) + ".json")).write_bytes(raw)
        monkeypatch.setitem(runtime.WOODBLOCK_EXTENSIONS, (child.pack_id, child.version, child.manifest_hash),
                            (sha256(raw), len(raw)))
    if runtime is station:
        with pytest.raises(station.BundleError):
            install(runtime, child)
        assert station.load_state()["active"] == original
    else:
        with pytest.raises(frame.BundleError):
            frame.use(child.pack_id, config={})
        assert frame.active_bundle().reference == original


@pytest.mark.parametrize("runtime", [station, frame], ids=["station", "frame"])
def test_composite_manifest_must_fit_as_one_document(library, runtime, monkeypatch):
    child, base, _, _ = library
    base["species"][0]["scientific_name"] = "Sturnus vulgaris"
    for pose in base["species"][0]["poses"]:
        pose["file"] = station.pose_path("Sturnus vulgaris", pose["id"])
    raw = station.canonical_json(base)
    monkeypatch.setitem(runtime.WOODBLOCK_EXTENSIONS, (child.pack_id, child.version, child.manifest_hash),
                        (sha256(raw), len(raw)))
    monkeypatch.setattr(runtime, "MANIFEST_MAX", max(len(child.manifest_raw), len(raw)))
    compose = station.compose_woodblock if runtime is station else frame._compose_woodblock
    ref = {"id": child.pack_id, "version": child.version, "revision": child.manifest_hash}
    with pytest.raises(runtime.BundleError):
        compose(child.manifest_raw, raw, ref)


@pytest.mark.parametrize("runtime", [station, frame], ids=["station", "frame"])
@pytest.mark.parametrize("file", ["base-manifest.json", "selection.json"])
def test_tampering_cannot_detach_geometry_from_either_source(library, runtime, file):
    child, _, _, _ = library
    reference, directory, _ = install(runtime, child)
    target = directory / file
    contents = json.loads(target.read_bytes())
    if file == "selection.json":
        contents["base_manifest_sha256"] = "0" * 64
    else:
        contents["species"].pop()
    target.write_bytes(station.canonical_json(contents))
    with pytest.raises(runtime.BundleError):
        if runtime is station:
            station.validate_installed_pack(reference, verify_hashes=True)
        else:
            frame.active_bundle()


@pytest.mark.parametrize("runtime", [station, frame], ids=["station", "frame"])
@pytest.mark.parametrize("field", ["digest", "version", "id"])
def test_unreviewed_revision_stays_exact_even_when_style_matches(library, runtime, monkeypatch, field):
    child, _, base_sha, dev = library
    (dev / "manifests" / (base_sha + ".json")).unlink()
    key, value = next(iter(runtime.WOODBLOCK_EXTENSIONS.items()))
    altered = {"digest": (*key[:2], "f" * 64), "version": (key[0], "2.0.0", key[2]),
               "id": ("different-community-pack", *key[1:])}[field]
    monkeypatch.setattr(runtime, "WOODBLOCK_EXTENSIONS", {altered: value})
    _, _, assets = install(runtime, child)
    assert set(assets) == {"corvus-brachyrhynchos"}


def test_exact_iberian_release_with_the_nine_reported_base_birds(tmp_path, monkeypatch):
    # Optional, offline verification against unchanged public *station* manifests.
    # No object or model downloads: use only matching PNG bytes from this checkout.
    source = os.environ.get("AVIAN_TEST_WOODBLOCK_MANIFESTS")
    if not source:
        pytest.skip("set AVIAN_TEST_WOODBLOCK_MANIFESTS to the saved public inputs")
    source = Path(source)
    species = ["Passer domesticus", "Streptopelia decaocto", "Anas platyrhynchos",
               "Sturnus vulgaris", "Corvus corax", "Hirundo rustica", "Anas crecca",
               "Mareca strepera", "Anas acuta"]
    child_id = "community-roquealonso-e824a0e5dde69d4b"
    pack = station.catalog_pack(json.loads((source / "community.json").read_bytes()), child_id)
    assert not set(species).intersection(pack["species"])
    dev = tmp_path / "dev"
    (dev / "manifests").mkdir(parents=True)
    for digest in (pack["manifest"]["sha256"], "019d21f5f54b1a68a4510b089544eb7316a3db54dfd37fc129b950eeeffa591f"):
        raw = (source / (digest + ".json")).read_bytes()
        assert sha256(raw) == digest
        (dev / "manifests" / (digest + ".json")).write_bytes(raw)
    base = json.loads(raw)
    shutil.copyfile(source / "community.json", dev / "catalog.json")
    pngs = {}
    for bird in base["species"]:
        if bird["scientific_name"] not in species:
            continue
        for pose in bird["poses"]:
            image = ROOT / "avian/assets" / pose["file"]
            digest = pose["sha256"]
            assert sha256(image.read_bytes()) == digest
            target = dev / "objects/sha256" / digest[:2] / (digest + ".png")
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(image, target)
            shutil.copyfile(image, dev / "objects" / (digest + ".png"))
            pngs[bird["scientific_name"], pose["id"]] = image
    assert len(pngs) == 18
    monkeypatch.setenv("AVIAN_BUNDLE_ROOT", str(tmp_path / "station"))
    monkeypatch.setenv("AVIAN_BUNDLE_CATALOG", str(ROOT / "avian/bundles/catalog-v1.json"))
    monkeypatch.setenv("AVIAN_BUNDLE_CONFIG", str(tmp_path / "missing.conf"))
    monkeypatch.setenv("AVIAN_BUNDLE_DB", str(tmp_path / "missing.db"))
    monkeypatch.setenv("AVIAN_BUNDLE_DEV_ROOT", str(dev))
    monkeypatch.setenv("AVIAN_BUNDLE_LOCK", str(tmp_path / "lock"))
    monkeypatch.setenv("AVIAN_FRAME_BUNDLE_ROOT", str(tmp_path / "frame"))
    monkeypatch.setenv("AVIAN_FRAME_BUNDLE_DEV_ROOT", str(dev))
    monkeypatch.setattr(station, "download_live_catalog_bytes", (dev / "catalog.json").read_bytes)
    basis = {"schema_version": 1, "species": sorted(species), "basis_sha256": "e" * 64}
    monkeypatch.setattr(station, "local_selection_basis", lambda: basis)
    # Match the detached worker's location basis in-process for this offline case.
    station.initialize()
    with monkeypatch.context() as job:
        job.setattr(station.subprocess, "Popen", lambda args, **kw: station.run_job(args[-1]))
        result = station.use_selector(child_id)
    assert result["changed"]
    reference = result["bundle"]
    installed = station.validate_installed_pack(reference)
    assert (installed["species_count"], installed["archive_bytes"], installed["creator"]) == (
        9, 807172469, "RoqueAlonso + Avian Visitors (base)")
    listed = station.catalog_pack(station.snapshot()["catalog"], child_id)
    assert listed["species_count"] == 775
    monkeypatch.setattr(frame, "_resolve_selection_basis", lambda _: basis)
    frame.use(child_id, config={})
    active = frame.active_bundle()
    inventory = active.assets_response()
    assert inventory["active"]["species_count"] == 9
    assert inventory["active"]["pose_count"] == 18
    directory = station.pack_directory(reference)
    response = subprocess.run(["php", str(ROOT / "avian/api/bundle-assets.php")], capture_output=True, check=True)
    web_inventory = json.loads(response.stdout)
    for table in ("dims", "masks"):
        assert inventory[table] == web_inventory[table] == json.loads((directory / (table + ".json")).read_bytes())
    for (name, pose), path in pngs.items():
        assert active.resolve(name, pose).read_bytes() == path.read_bytes()
        cutout = subprocess.run(
            ["php", "-r", '$_GET = ["sci"=>$argv[1], "pose"=>$argv[2], "bundle"=>$argv[3], '
             '"content"=>$argv[4]]; require $argv[5];', name, "1" if pose == "perched" else "2",
             reference["revision"], reference["selection_revision"], str(ROOT / "avian/api/cutout.php")],
            check=True, capture_output=True,
        )
        assert cutout.stdout == path.read_bytes()
