import subprocess
import shutil
import unittest
from pathlib import Path


class MidnightResetTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("php"), "PHP CLI is unavailable")
    def test_php_contract(self):
        root = Path(__file__).resolve().parents[1]
        result = subprocess.run(
            ["php", str(root / "tests" / "test_midnight_reset.php")],
            cwd=root,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("midnight reset tests passed", result.stdout)


if __name__ == "__main__":
    unittest.main()
