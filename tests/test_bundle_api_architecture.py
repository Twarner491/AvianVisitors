from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class BundleApiArchitecture(unittest.TestCase):
    def read(self, relative: str) -> str:
        return (ROOT / relative).read_text(encoding="utf-8")

    def test_management_api_uses_v11_admin_and_action_gates(self) -> None:
        source = self.read("avian/api/bundles.php")
        self.assertIn("require_once __DIR__ . '/admin-auth.php'", source)
        self.assertIn("avian_require_admin();", source)
        self.assertIn("avian_require_json_action();", source)
        self.assertLess(source.index("avian_require_admin();"), source.index("REQUEST_METHOD"))
        self.assertLess(source.index("avian_require_json_action();"), source.index("php://input"))

    def test_mutations_bind_activation_intent_and_catalog_version(self) -> None:
        source = self.read("avian/api/bundles.php")
        self.assertIn("if ($body['activate']) $arguments[] = '--activate';", source)
        self.assertIn("['action', 'id', 'version']", source)
        self.assertIn("$arguments[] = '--version';", source)
        self.assertIn("$arguments[] = $body['version'];", source)

    def test_use_action_delegates_local_selection_without_browser_authority(self) -> None:
        source = self.read("avian/api/bundles.php")
        use_start = source.index("if ($action === 'use')")
        install_start = source.index("} elseif ($action === 'install'", use_start)
        use_source = source[use_start:install_start]
        self.assertIn("avian_bundles_exact_keys($body, ['action', 'id'])", use_source)
        self.assertIn("'enqueue', '--action', 'use'", use_source)
        self.assertNotIn("'unchanged'", use_source)
        self.assertNotIn("$body['version']", use_source)
        self.assertNotIn("$body['url']", use_source)
        self.assertNotIn("$body['sha256']", use_source)

    def test_status_read_is_bounded_and_has_no_mutation_side_effect(self) -> None:
        source = self.read("avian/api/bundles.php")
        self.assertIn("['snapshot', 'status']", source)
        self.assertIn("'job' => $snapshot['job'] ?? null", source)
        self.assertIn("'active' => $snapshot['library']['active'] ?? null", source)

    def test_started_mutation_has_an_explicit_accepted_envelope(self) -> None:
        source = self.read("avian/api/bundles.php")
        self.assertIn("$accepted['accepted'] = true;", source)
        self.assertIn("avian_bundles_respond(202, $accepted);", source)

    def test_legacy_style_ids_normalize_only_to_the_included_bundle(self) -> None:
        source = self.read("avian/api/bundles.php")
        self.assertIn("$id === 'woodblock' || $id === 'japanese-woodblock'", source)
        self.assertIn("return AVIAN_BUNDLE_INCLUDED_ID;", source)

    def test_catalog_refresh_has_no_caller_selected_url_or_bundle(self) -> None:
        source = self.read("avian/api/bundles.php")
        self.assertIn("$action === 'rollback' || $action === 'refresh'", source)
        self.assertIn("avian_bundles_exact_keys($body, ['action'])", source)
        self.assertNotIn("$body['url']", source)

    def test_api_never_builds_a_shell_command(self) -> None:
        for relative in [
            "avian/api/bundles.php",
            "avian/api/bundle-preview.php",
            "avian/api/bundle-assets.php",
            "avian/api/bundle-runtime.php",
        ]:
            source = self.read(relative)
            self.assertNotIn("shell_exec(", source, relative)
            self.assertNotIn("system(", source, relative)
            self.assertNotIn("exec(", source, relative)
        runtime = self.read("avian/api/bundle-runtime.php")
        self.assertIn("['bypass_shell' => true]", runtime)
        self.assertIn("'/usr/local/sbin/avian-bundle-control'", runtime)
        self.assertIn("[$sudo, '-n', $helper]", runtime)

    def test_root_helper_limits_the_web_process_and_rejects_path_overrides(self) -> None:
        manager = self.read("avian/scripts/bundle_manager.py")
        self.assertIn('sudo_user != "caddy"', manager)
        self.assertIn(
            'arguments.command not in {"snapshot", "enqueue", "preview", "selection-basis"}',
            manager,
        )
        self.assertIn('key.startswith("AVIAN_BUNDLE_")', manager)

    def test_preview_accepts_only_catalog_id_and_bounded_index(self) -> None:
        source = self.read("avian/api/bundle-preview.php")
        self.assertIn("array_diff(array_keys($_GET), ['id', 'index'])", source)
        self.assertNotIn("$_GET['url']", source)
        self.assertNotIn("$_GET['path']", source)
        self.assertNotIn("$_GET['sha256']", source)
        self.assertIn("avian_bundle_run_preview($_GET['id'], (int)$_GET['index'])", source)

    def test_non_builtin_branch_precedes_every_legacy_fallback(self) -> None:
        source = self.read("avian/api/cutout.php")
        exact = source.index("if (!$artBundle['included'])")
        bundled = source.index("$bundled = dirname(__DIR__)")
        photo = source.index("$cutout = dirname(__DIR__)")
        wikipedia = source.index("$wpUrl =")
        self.assertLess(exact, bundled)
        self.assertLess(exact, photo)
        self.assertLess(exact, wikipedia)
        custom_branch = source[exact:bundled]
        self.assertNotIn("fallback", custom_branch.lower().replace("does not fall back", ""))

    def test_generation_is_limited_to_included_bundle(self) -> None:
        source = self.read("avian/api/generate.php")
        self.assertIn("require_once __DIR__ . '/bundle-runtime.php'", source)
        self.assertIn("if (!$activeBundle['included'])", source)
        self.assertLess(
            source.index("if (!$activeBundle['included'])"),
            source.index("$key = conf_value($CONF, 'GEMINI_API_KEY')"),
        )

    def test_runtime_image_limits_match_the_privileged_manager(self) -> None:
        runtime = self.read("avian/api/bundle-runtime.php")
        manager = self.read("avian/scripts/bundle_manager.py")
        self.assertIn("const AVIAN_BUNDLE_MAX_OBJECT_BYTES = 4_194_304;", runtime)
        self.assertIn("const AVIAN_BUNDLE_MAX_IMAGE_SIDE = 4096;", runtime)
        self.assertIn("const AVIAN_BUNDLE_MAX_IMAGE_PIXELS = 16000000;", runtime)
        self.assertIn("IMAGE_MAX = 4 * 1024 * 1024", manager)
        self.assertIn("IMAGE_DIM_MAX = 4096", manager)
        self.assertIn("IMAGE_PIXELS_MAX = 16_000_000", manager)


if __name__ == "__main__":
    unittest.main()
