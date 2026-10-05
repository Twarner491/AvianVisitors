import pathlib
import shutil
import subprocess
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]


class EducatorScopePerformanceTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("php"), "PHP CLI is unavailable")
    def test_scope_cap_and_eight_action_benchmark(self):
        result = subprocess.run(
            ["php", "tests/test_educator_scope_performance.php"],
            cwd=ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=90,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("Educator scope performance:", result.stdout)

    @unittest.skipUnless(shutil.which("node"), "Node.js is unavailable")
    def test_saved_scope_polling_runtime(self):
        result = subprocess.run(
            ["node", "tests/smoke_educator_scope_polling.mjs"],
            cwd=ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=30,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("Educator scope polling smoke: ok", result.stdout)


if __name__ == "__main__":
    unittest.main()
