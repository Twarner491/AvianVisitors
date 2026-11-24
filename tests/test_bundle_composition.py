"""Ordered region selection and atomic installation."""
import copy
import errno
import json
import unittest
from unittest import mock

from tests import test_bundle_manager as fixtures

manager = fixtures.bundle_manager


class BundleCompositionTests(unittest.TestCase):
    setUp = fixtures.BundleLifecycleTests.setUp
    tearDown = fixtures.BundleLifecycleTests.tearDown
    queued_install_job = fixtures.BundleLifecycleTests.queued_install_job

    def publish_pair(self):
        second = fixtures.BundleFixture()
        second.pack_id = 'community-second-birds'
        second.manifest['id'] = second.pack_id
        second.manifest['species'][0]['poses'] = [copy.deepcopy(second.manifest['species'][0]['poses'][0])]
        raw = fixtures.png_bytes((220, 20, 20, 255))
        second.images = {'perched': raw}
        second.manifest['species'][0]['poses'][0].update(sha256=fixtures.sha256(raw), bytes=len(raw))
        bird = copy.deepcopy(second.manifest['species'][0])
        bird['scientific_name'] = 'Corvus corax'
        bird['common_name'] = 'Common Raven'
        bird['poses'][0]['file'] = manager.pose_path('Corvus corax', 'perched')
        second.manifest['species'].append(bird)
        second.manifest_raw = manager.canonical_json(second.manifest)
        second.manifest_hash = fixtures.sha256(second.manifest_raw)
        second.pack.update(id=second.pack_id, species_count=2,
                           species=['Corvus brachyrhynchos', 'Corvus corax'],
                           archive_bytes=2 * len(raw))
        second.pack['previews'][0].update(sha256=fixtures.sha256(raw), bytes=len(raw))
        second.pack['manifest'] = {'url': manager.MANIFEST_BASE_URL + second.manifest_hash + '.json',
                                   'sha256': second.manifest_hash, 'bytes': len(second.manifest_raw)}
        second.publish(self.publication)
        self.fixture.catalog['packs'].append(second.pack)
        self.catalog_path.write_bytes(manager.canonical_json(self.fixture.catalog))
        manager.initialize()
        self.second = second
        return manager.load_catalog()

    def install(self, ids):
        job = self.queued_install_job('b' * 32)
        manager.atomic_json(self.root / 'job.json', job)
        catalog = manager.load_catalog()
        packs = [manager.catalog_pack(catalog, item) for item in ids]
        return manager.install_pack(catalog, packs[0], job['id'], all_species=True, source_packs=packs)

    def test_first_selected_owns_the_whole_bird(self):
        self.publish_pair()
        first = self.install([self.fixture.pack_id, self.second.pack_id])
        index = manager.load_index(first)['assets']
        self.assertEqual(set(index), {'corvus-brachyrhynchos', 'corvus-corax'})
        self.assertEqual(set(index['corvus-brachyrhynchos']), {'perched', 'flight'})
        self.assertEqual(index['corvus-brachyrhynchos']['perched']['sha256'], fixtures.sha256(self.fixture.images['perched']))
        second = self.install([self.second.pack_id, self.fixture.pack_id])
        reverse = manager.load_index(second)['assets']
        self.assertEqual(set(reverse['corvus-brachyrhynchos']), {'perched'})
        self.assertEqual(reverse['corvus-brachyrhynchos']['perched']['sha256'], fixtures.sha256(self.second.images['perched']))
        self.assertNotEqual(first['selection_revision'], second['selection_revision'])
        receipt = manager.load_selection(first, manager.pack_directory(first))
        self.assertEqual([item['id'] for item in receipt['sources']], [self.fixture.pack_id, self.second.pack_id])
        self.assertEqual((manager.pack_directory(first) / 'manifest.json').read_bytes(), self.fixture.manifest_raw)
        self.assertEqual(manager.validate_installed_pack(first, verify_hashes=True)['species_count'], 2)

    def test_composite_inventory_counts_follow_whole_bird_precedence(self):
        self.publish_pair()
        manifests = [manager.validate_manifest(self.fixture.manifest),
                     manager.validate_manifest(self.second.manifest)]
        first_total = sum(len(raw) for raw in self.fixture.images.values()) + len(self.second.images['perched'])
        for ordered, pose_count, total in ((manifests, 3, first_total),
                                           (manifests[::-1], 2, 2 * len(self.second.images['perched']))):
            with self.subTest(first=ordered[0]['id']):
                reference = self.install([item['id'] for item in ordered])
                manifest = manager.selection_manifest(ordered[0], reference, manager.pack_directory(reference))
                self.assertEqual((manifest['species_count'], manifest['pose_count'], manifest['total_bytes']),
                                 (2, pose_count, total))
                self.assertEqual(manager.validate_installed_pack(reference)['archive_bytes'], total)
                manager.activate_reference(reference)
                pack = next(item for item in manager.snapshot()['catalog']['packs'] if item['id'] == reference['id'])
                self.assertEqual(pack['activation_presentation']['archive_bytes'], total)

    def test_rejects_duplicate_and_mixed_style_sources(self):
        self.publish_pair()
        before = manager.load_state()
        with self.assertRaises(manager.BundleError):
            self.install([self.fixture.pack_id, self.fixture.pack_id])
        other = manager.validate_manifest(self.second.manifest)
        other['style']['id'] = 'different'
        with self.assertRaises(manager.BundleError):
            manager.ordered_species([manager.validate_manifest(self.fixture.manifest), other])
        self.assertEqual(manager.load_state(), before)

    def test_corrupt_later_source_keeps_active_and_previous(self):
        self.publish_pair()
        before = manager.load_state()
        path = self.publication / 'manifests' / (self.second.manifest_hash + '.json')
        path.write_bytes(b'bad manifest')
        with self.assertRaises(manager.BundleError):
            self.install([self.fixture.pack_id, self.second.pack_id])
        self.assertEqual(manager.load_state(), before)

    def test_tampered_source_receipt_is_rejected(self):
        self.publish_pair()
        reference = self.install([self.fixture.pack_id, self.second.pack_id])
        directory = manager.pack_directory(reference)
        receipt = json.loads((directory / 'selection.json').read_bytes())
        receipt['sources'].reverse()
        manager.atomic_json(directory / 'selection.json', receipt)
        with self.assertRaises(manager.BundleError):
            manager.validate_installed_pack(reference, verify_hashes=True)

    def test_rollback_retains_both_compositions_after_gc(self):
        self.publish_pair()
        first = self.install([self.fixture.pack_id, self.second.pack_id])
        manager.activate_reference(first)
        second = self.install([self.second.pack_id, self.fixture.pack_id])
        manager.activate_reference(second)
        manager.garbage_collect_objects()
        self.assertEqual(manager.rollback_active(), first)
        manager.validate_installed_pack(first, verify_hashes=True)
        manager.validate_installed_pack(second, verify_hashes=True)

    def test_queued_use_pins_order_and_activates_the_union(self):
        self.publish_pair()
        with mock.patch.object(manager.subprocess, 'Popen'):
            accepted = manager.enqueue('use', self.second.pack_id, '', False, all_species=True,
                                       source_ids=[self.second.pack_id, self.fixture.pack_id])
        job = manager.load_job()
        self.assertEqual([source['id'] for source in job['sources']], [self.second.pack_id, self.fixture.pack_id])
        manager.run_job(job['id'])
        self.assertEqual(manager.load_job()['state'], 'complete')
        snapshot = manager.snapshot()
        self.assertEqual(snapshot['library']['active_ids'], [self.second.pack_id, self.fixture.pack_id])
        self.assertIn('ordered-regions-v1', snapshot['capabilities'])
        active = manager.load_state()['active']
        self.assertEqual(set(manager.load_index(active)['assets']['corvus-brachyrhynchos']), {'perched'})

    def test_source_limits_and_storage_failure_preserve_state(self):
        self.publish_pair()
        before = manager.load_state()
        for ids in [[], [self.fixture.pack_id] * 2, ['a-' + str(i) for i in range(17)]]:
            with self.subTest(ids=ids), self.assertRaises(manager.BundleError):
                manager.checked_source_ids(ids)
        with mock.patch.object(manager, 'OBJECT_STORE_MAX', 1), self.assertRaises(manager.BundleError):
            self.install([self.fixture.pack_id, self.second.pack_id])
        self.assertEqual(manager.load_state(), before)

    def test_cached_sources_work_without_manifest_network(self):
        catalog = self.publish_pair()
        for pack in [self.fixture.pack, self.second.pack]:
            job = self.queued_install_job('b' * 32)
            manager.atomic_json(self.root / 'job.json', job)
            manager.install_pack(catalog, pack, job['id'], all_species=True)
        manager.update_job(job['id'], state='complete')
        with mock.patch.object(manager.subprocess, 'Popen'):
            manager.enqueue('use', self.fixture.pack_id, '', False, all_species=True,
                            source_ids=[self.fixture.pack_id, self.second.pack_id])
        job = manager.load_job()
        with mock.patch.object(manager, 'fetch_manifest', side_effect=AssertionError('network')):
            manager.run_job(job['id'])
        self.assertEqual(manager.load_job()['state'], 'complete')

    def test_composite_only_cache_can_be_reordered(self):
        self.publish_pair()
        self.install([self.fixture.pack_id, self.second.pack_id])
        manager.update_job('b' * 32, state='complete')
        with mock.patch.object(manager.subprocess, 'Popen'):
            manager.enqueue('use', self.second.pack_id, '', False, all_species=True,
                            source_ids=[self.second.pack_id, self.fixture.pack_id])
        with mock.patch.object(manager, 'fetch_manifest', side_effect=AssertionError('network')):
            manager.run_job(manager.load_job()['id'])
        self.assertEqual(manager.load_job()['state'], 'complete')

    def test_cached_included_source_can_be_reordered_offline(self):
        with mock.patch.object(manager, 'BUILTIN_ID', self.fixture.pack_id):
            self.fixture.pack['availability'] = 'included'
            self.publish_pair()
            selected = self.install([self.fixture.pack_id, self.second.pack_id])
            manager.activate_reference(selected)
            manager.update_job('b' * 32, state='complete')
            with mock.patch.object(manager.subprocess, 'Popen'):
                manager.enqueue('use', self.second.pack_id, '', False, all_species=True,
                                source_ids=[self.second.pack_id, self.fixture.pack_id])
            with mock.patch.object(manager, 'fetch_manifest', side_effect=manager.BundleError('offline')):
                manager.run_job(manager.load_job()['id'])
            self.assertEqual(manager.snapshot()['library']['active_ids'],
                             [self.second.pack_id, self.fixture.pack_id])
            with mock.patch.object(manager.subprocess, 'Popen'):
                manager.enqueue('use', self.fixture.pack_id, '', False)
            with mock.patch.object(manager, 'fetch_manifest', side_effect=manager.BundleError('offline')):
                manager.run_job(manager.load_job()['id'])
            self.assertEqual(manager.load_state()['active'], manager.builtin_ref())

    def test_removing_inactive_included_composition_preserves_rollback(self):
        with mock.patch.object(manager, 'BUILTIN_ID', self.fixture.pack_id):
            self.fixture.pack['availability'] = 'included'
            catalog = self.publish_pair()
            selected = self.install([self.fixture.pack_id, self.second.pack_id])
            job = self.queued_install_job('b' * 32)
            manager.atomic_json(self.root / 'job.json', job)
            previous = manager.install_pack(catalog, self.second.pack, job['id'], all_species=True)
            manager.save_state(manager.builtin_ref(), previous)
            manager.remove_pack(self.fixture.pack_id)
            self.assertFalse(manager.pack_directory(selected).exists())
            self.assertEqual(manager.load_state()['previous'], previous)
            self.assertEqual(manager.rollback_active(), previous)

    def test_legacy_install_and_update_create_standalone_after_composite(self):
        self.publish_pair()
        for action in ('install', 'update'):
            with self.subTest(action=action):
                selected = self.install([self.fixture.pack_id, self.second.pack_id])
                manager.update_job('b' * 32, state='complete')
                with mock.patch.object(manager.subprocess, 'Popen'):
                    manager.enqueue(action, self.fixture.pack_id, '', False, all_species=True)
                manager.run_job(manager.load_job()['id'])
                active = manager.activate_pack(self.fixture.pack_id, manager.load_catalog())
                self.assertNotEqual(active, selected)
                self.assertEqual(set(manager.load_index(active)['assets']), {'corvus-brachyrhynchos'})
                manager.remove_pack(self.fixture.pack_id)

    def test_legacy_activate_rejects_composite_before_queueing(self):
        self.publish_pair()
        self.install([self.fixture.pack_id, self.second.pack_id])
        manager.update_job('b' * 32, state='complete')
        before = manager.load_job()
        with mock.patch.object(manager.subprocess, 'Popen'), self.assertRaises(manager.BundleError) as error:
            manager.enqueue('activate', self.fixture.pack_id, self.fixture.pack['version'], False)
        self.assertEqual(error.exception.code, 'not_installed')
        self.assertEqual(manager.load_job(), before)

    def test_delisted_secondary_stays_selectable_from_verified_cache(self):
        catalog = self.publish_pair()
        selected = self.install([self.fixture.pack_id, self.second.pack_id])
        manager.activate_reference(selected)
        manager.update_job('b' * 32, state='complete')
        catalog['packs'] = [pack for pack in catalog['packs'] if pack['id'] != self.second.pack_id]
        with mock.patch.object(manager, 'load_catalog', return_value=catalog):
            packs = {pack['id']: pack for pack in manager.snapshot()['catalog']['packs']}
            self.assertIn(self.second.pack_id, packs)
            cached = packs[self.second.pack_id]
            self.assertTrue(cached['installed'])
            self.assertFalse(cached['catalog_current'])
            self.assertFalse(cached['update_available'])
            self.assertEqual(cached['availability'], 'unavailable')
            self.assertEqual(cached['activation_version'], self.second.pack['version'])
            self.assertEqual(cached['species_count'], 2)
            with mock.patch.object(manager.subprocess, 'Popen'):
                manager.enqueue('use', self.second.pack_id, '', False, all_species=True,
                                source_ids=[self.second.pack_id, self.fixture.pack_id])
            with mock.patch.object(manager, 'fetch_manifest', side_effect=manager.BundleError('offline')):
                manager.run_job(manager.load_job()['id'])
            self.assertEqual(manager.snapshot()['library']['active_ids'],
                             [self.second.pack_id, self.fixture.pack_id])

    def test_tampered_secondary_manifest_is_not_exposed_as_cached(self):
        catalog = self.publish_pair()
        selected = self.install([self.fixture.pack_id, self.second.pack_id])
        path = manager.pack_directory(selected) / (self.second.manifest_hash + '.json')
        path.write_bytes(self.fixture.manifest_raw)
        catalog['packs'] = [pack for pack in catalog['packs'] if pack['id'] != self.second.pack_id]
        with mock.patch.object(manager, 'load_catalog', return_value=catalog):
            self.assertNotIn(self.second.pack_id,
                             [pack['id'] for pack in manager.snapshot()['catalog']['packs']])

    def test_included_catalog_update_does_not_change_cached_composition_order(self):
        with mock.patch.object(manager, 'BUILTIN_ID', self.fixture.pack_id):
            self.fixture.pack['availability'] = 'included'
            catalog = self.publish_pair()
            self.install([self.fixture.pack_id, self.second.pack_id])
            manager.update_job('b' * 32, state='complete')
            newer = copy.deepcopy(catalog)
            newer['packs'][0]['version'] = '1.2.4'
            for ids in ([self.fixture.pack_id, self.second.pack_id],
                        [self.second.pack_id, self.fixture.pack_id]):
                with self.subTest(ids=ids), mock.patch.object(manager, 'load_catalog', return_value=newer):
                    with mock.patch.object(manager.subprocess, 'Popen'):
                        manager.enqueue('use', ids[0], '', False, all_species=True, source_ids=ids)
                    with mock.patch.object(manager, 'fetch_manifest', side_effect=manager.BundleError('offline')):
                        manager.run_job(manager.load_job()['id'])
                    self.assertEqual(manager.snapshot()['library']['active_ids'], ids)

    def test_delisted_secondary_prefers_newer_cache_over_older_standalone(self):
        catalog = self.publish_pair()
        manager.atomic_json(self.root / 'job.json', self.queued_install_job('b' * 32))
        manager.install_pack(catalog, self.second.pack, 'b' * 32, all_species=True)
        self.second.manifest['version'] = '1.2.4'
        self.second.manifest_raw = manager.canonical_json(self.second.manifest)
        self.second.manifest_hash = fixtures.sha256(self.second.manifest_raw)
        self.second.pack.update(version='1.2.4', manifest={
            'url': manager.MANIFEST_BASE_URL + self.second.manifest_hash + '.json',
            'sha256': self.second.manifest_hash, 'bytes': len(self.second.manifest_raw)})
        self.second.publish(self.publication)
        self.catalog_path.write_bytes(manager.canonical_json(self.fixture.catalog))
        selected = self.install([self.fixture.pack_id, self.second.pack_id])
        manager.activate_reference(selected)
        manager.update_job('b' * 32, state='complete')
        catalog = manager.load_catalog()
        listed = next(pack for pack in manager.snapshot()['catalog']['packs'] if pack['id'] == self.second.pack_id)
        self.assertEqual(listed['activation_version'], '1.2.4')
        self.assertEqual(listed['installed_versions'], ['1.2.3', '1.2.4'])
        self.assertTrue(listed['active'])
        catalog['packs'] = [pack for pack in catalog['packs'] if pack['id'] != self.second.pack_id]
        with mock.patch.object(manager, 'load_catalog', return_value=catalog):
            cached = next(pack for pack in manager.snapshot()['catalog']['packs'] if pack['id'] == self.second.pack_id)
            self.assertEqual(cached['activation_version'], '1.2.4')
            self.assertEqual(cached['installed_versions'], ['1.2.3', '1.2.4'])
            with mock.patch.object(manager.subprocess, 'Popen'):
                manager.enqueue('use', self.second.pack_id, '', False, all_species=True,
                                source_ids=[self.second.pack_id, self.fixture.pack_id])
            self.assertEqual(manager.load_job()['sources'][0]['version'], '1.2.4')
            with mock.patch.object(manager, 'fetch_manifest', side_effect=manager.BundleError('offline')):
                manager.run_job(manager.load_job()['id'])
            self.assertEqual(manager.load_state()['active']['version'], '1.2.4')

    def test_committed_selection_survives_completion_write_failure_truthfully(self):
        self.publish_pair()
        prior = self.install([self.fixture.pack_id, self.second.pack_id])
        manager.activate_reference(prior)
        manager.update_job('b' * 32, state='complete')
        with mock.patch.object(manager.subprocess, 'Popen'):
            manager.enqueue('use', self.second.pack_id, '', False, all_species=True,
                            source_ids=[self.second.pack_id, self.fixture.pack_id])
        update = manager.update_job
        def full_disk(job_id, **changes):
            if changes.get('state') == 'complete':
                raise OSError(errno.ENOSPC, 'full')
            return update(job_id, **changes)
        with mock.patch.object(manager, 'update_job', side_effect=full_disk):
            manager.run_job(manager.load_job()['id'])
        self.assertEqual(manager.load_job()['state'], 'complete')
        self.assertEqual(manager.load_state()['previous'], prior)
        self.assertEqual(manager.load_state()['active']['id'], self.second.pack_id)

    def test_legacy_activate_does_not_activate_a_composite(self):
        catalog = self.publish_pair()
        self.install([self.fixture.pack_id, self.second.pack_id])
        before = manager.load_state()
        with self.assertRaises(manager.BundleError):
            manager.activate_pack(self.fixture.pack_id, catalog)
        self.assertEqual(manager.load_state(), before)

    def test_builtin_id_downloads_can_be_removed_without_removing_builtin(self):
        self.publish_pair()
        with mock.patch.object(manager, 'BUILTIN_ID', self.fixture.pack_id):
            manager.save_state(manager.builtin_ref(), None)
            selected = self.install([self.fixture.pack_id, self.second.pack_id])
            manager.activate_reference(selected)
            manager.remove_pack(self.fixture.pack_id)
            self.assertEqual(manager.load_state()['active'], manager.builtin_ref())
            self.assertFalse(manager.pack_directory(selected).exists())

    def test_local_basis_is_applied_to_the_union_once(self):
        self.publish_pair()
        job = self.queued_install_job('b' * 32)
        manager.atomic_json(self.root / 'job.json', job)
        basis = {'species': ['Corvus corax'], 'basis_sha256': 'a' * 64}
        with mock.patch.object(manager, 'local_selection_basis', return_value=basis):
            reference = manager.install_pack(manager.load_catalog(), self.fixture.pack, job['id'],
                                             source_packs=[self.fixture.pack, self.second.pack])
        self.assertEqual(set(manager.load_index(reference)['assets']), {'corvus-corax'})

    def test_changed_queued_source_does_not_activate(self):
        self.publish_pair()
        before = manager.load_state()
        with mock.patch.object(manager.subprocess, 'Popen'):
            manager.enqueue('use', self.fixture.pack_id, '', False, all_species=True,
                            source_ids=[self.fixture.pack_id, self.second.pack_id])
        catalog = manager.load_catalog()
        for item in catalog['packs']:
            if item['id'] == self.second.pack_id:
                item['manifest']['sha256'] = 'a' * 64
        with mock.patch.object(manager, 'load_catalog', return_value=catalog), self.assertRaises(manager.BundleError):
            manager.run_job(manager.load_job()['id'])
        self.assertEqual(manager.load_job()['state'], 'failed')
        self.assertEqual(manager.load_state(), before)


if __name__ == '__main__':
    unittest.main()
