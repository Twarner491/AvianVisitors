import copy
import importlib.util
import unittest
from pathlib import Path
from unittest import mock

spec = importlib.util.spec_from_file_location("frame_composition_fixtures", Path(__file__).with_name("test_bundle_runtime.py"))
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)

canonical = fixtures.canonical
runtime = fixtures.bundle_runtime


class FrameCompositionTests(unittest.TestCase):
    setUp = fixtures.FrameBundleRuntimeTests.setUp
    tearDown = fixtures.FrameBundleRuntimeTests.tearDown

    def pair(self):
        self.fixture.add_species()
        second = copy.deepcopy(self.fixture.manifest)
        second['id'] = 'qa-second-birds'
        second['species'][0]['poses'][0]['sha256'] = second['species'][1]['poses'][0]['sha256']
        second['species'][0]['poses'][0]['bytes'] = second['species'][1]['poses'][0]['bytes']
        raw = canonical(second)
        digest = runtime._sha(raw)
        (self.fixture.dev / 'manifests' / (digest + '.json')).write_bytes(raw)
        pack = copy.deepcopy(self.fixture.pack)
        pack['id'] = second['id']
        pack['manifest'] = {'url': runtime._manifest_url(digest), 'sha256': digest, 'bytes': len(raw)}
        pack['archive_bytes'] = sum(pose['bytes'] for bird in second['species'] for pose in bird['poses'])
        pack['previews'][0].update(sha256=second['species'][0]['poses'][0]['sha256'], bytes=second['species'][0]['poses'][0]['bytes'])
        self.fixture.write_catalog(packs=[self.fixture.pack, pack])
        return [self.fixture.pack['id'], pack['id']]

    def test_order_and_rollback_keep_the_exact_artwork(self):
        ids = self.pair()
        first = runtime.use_many(ids, all_species=True)['bundle']
        self.assertEqual(runtime.active_bundle().resolve('Corvus corax', 'perched').read_bytes(), self.fixture.png)
        second = runtime.use_many(list(reversed(ids)), all_species=True)['bundle']
        self.assertNotEqual(runtime.active_bundle().resolve('Corvus corax', 'perched').read_bytes(), self.fixture.png)
        self.assertNotEqual(first['selection_revision'], second['selection_revision'])
        runtime.rollback()
        self.assertEqual(runtime.active_bundle().resolve('Corvus corax', 'perched').read_bytes(), self.fixture.png)

    def test_failed_render_restores_previous_combination(self):
        ids = self.pair()
        first = runtime.use_many(ids, all_species=True)['bundle']
        with self.assertRaises(runtime.BundleError):
            runtime.use_many(list(reversed(ids)), all_species=True, render=mock.Mock(side_effect=RuntimeError('render failed')))
        self.assertEqual(runtime.active_bundle().reference, first)

    def test_duplicate_ids_are_rejected_before_activation(self):
        ids = self.pair()
        with self.assertRaises(runtime.BundleError):
            runtime.use_many([ids[0], ids[0]], all_species=True)
        self.assertIsNone(runtime.active_bundle())

    def test_cached_composition_reorders_without_manifest_downloads(self):
        ids = self.pair()
        runtime.use_many(ids, all_species=True)
        download = runtime._download
        def no_manifests(url, *args, **kwargs):
            if '/manifests/' in url:
                raise runtime.BundleError('offline')
            return download(url, *args, **kwargs)
        with mock.patch.object(runtime, '_download', side_effect=no_manifests):
            result = runtime.use_many(list(reversed(ids)), all_species=True)
        self.assertEqual(result['bundle']['id'], ids[1])
