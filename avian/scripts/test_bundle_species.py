#!/usr/bin/env python3
from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

HELPER = Path(__file__).with_name("bundle_species.py")
sys.path.insert(0, str(HELPER.parent))
import bundle_species as species


class SeasonalInterpreter:
    def __init__(self, **options):
        self.options = options
        self.input_shape = [1, 3]
        self.output_shape = [1, 4]
        self.output_dtype = np.float32
        self.rows = {
            1: [0.1, 0.0, 0.0, 1.0],
            24: [0.0, 0.2, 0.0, 1.0],
            48: [0.0, 0.0, 0.3, 1.0],
        }

    def get_input_details(self):
        return [{"shape": np.array(self.input_shape), "index": 0, "dtype": np.float32}]

    def get_output_details(self):
        return [{"shape": np.array(self.output_shape), "index": 1, "dtype": self.output_dtype}]

    def allocate_tensors(self):
        pass

    def set_tensor(self, index, value):
        if index != 0 or value.shape != (1, 3) or value.dtype != np.float32:
            raise ValueError("invalid metadata input")
        self.week = int(value[0, 2])

    def invoke(self):
        pass

    def get_tensor(self, index):
        if index != 1:
            raise ValueError("invalid model output")
        return np.array([self.rows.get(self.week, [0.0, 0.0, 0.0, 1.0])], dtype=np.float32)


class AnnualSpeciesTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.labels = self.root / "BirdNET_GLOBAL_6K_V2.4_Model_FP16_Labels.txt"
        self.labels.write_text("Turdus migratorius\nCorvus corax\nCalypte anna\nNoise\n")
        self.model = self.root / "BirdNET_GLOBAL_6K_V2.4_MData_Model_V2_FP16.tflite"
        self.model.write_bytes(b"fixture metadata model")
        self.runtime = SeasonalInterpreter()
        self.runtime_patch = mock.patch.object(
            species, "_load_runtime", return_value=(np, lambda **options: self.runtime)
        )
        self.runtime_patch.start()
        self.addCleanup(self.runtime_patch.stop)

    def annual(self, **updates):
        args = {"latitude": 37.75, "longitude": -122.4, "model_dir": self.root}
        args.update(updates)
        return species.annual_species(**args)

    def test_unions_winter_summer_and_last_week_without_nonbird_labels(self):
        result = self.annual()
        self.assertEqual(result["species"], ["Calypte anna", "Corvus corax", "Turdus migratorius"])
        self.assertEqual(result["schema_version"], 1)
        self.assertRegex(result["basis_sha256"], r"^[0-9a-f]{64}$")

    def test_threshold_changes_the_annual_selection(self):
        self.assertEqual(self.annual(threshold=0.25)["species"], ["Calypte anna"])
        self.assertEqual(self.annual(threshold=1)["species"], [])

    def test_basis_changes_when_location_threshold_model_or_labels_change(self):
        baseline = self.annual()["basis_sha256"]
        self.assertEqual(baseline, self.annual()["basis_sha256"])
        self.assertNotEqual(baseline, self.annual(latitude=37.76)["basis_sha256"])
        self.assertNotEqual(baseline, self.annual(threshold=0.04)["basis_sha256"])
        self.model.write_bytes(b"different metadata model")
        self.assertNotEqual(baseline, self.annual()["basis_sha256"])
        self.model.write_bytes(b"fixture metadata model")
        self.labels.write_text("Turdus migratorius\nCorvus corax\nCalypte costae\nNoise\n")
        self.assertNotEqual(baseline, self.annual()["basis_sha256"])

    def test_uses_metadata_model_labels_instead_of_localized_active_model_labels(self):
        (self.root / "labels.txt").write_text("Wrong bird\n")
        self.assertEqual(len(self.annual()["species"]), 3)

    def test_model_version_one_selects_its_own_model(self):
        legacy = self.root / "BirdNET_GLOBAL_6K_V2.4_MData_Model_FP16.tflite"
        legacy.write_bytes(b"legacy metadata model")
        self.assertEqual(len(self.annual(model_version=1)["species"]), 3)
        legacy.unlink()
        with self.assertRaises(species.SpeciesError):
            self.annual(model_version=1)

    def test_rejects_bad_coordinates_thresholds_and_model_versions(self):
        cases = [
            {"latitude": 91}, {"latitude": -91}, {"latitude": float("nan")},
            {"longitude": 181}, {"longitude": float("inf")}, {"latitude": True},
            {"threshold": -0.1}, {"threshold": 1.1}, {"threshold": float("nan")},
            {"threshold": True}, {"model_version": 3}, {"model_version": True},
        ]
        for values in cases:
            with self.subTest(values=values), self.assertRaises(species.SpeciesError):
                self.annual(**values)

    def test_rejects_model_output_count_not_matching_the_label_order(self):
        self.runtime.output_shape = [1, 5]
        with self.assertRaises(species.SpeciesError):
            self.annual()

    def test_rejects_unexpected_input_shape_and_output_dtype(self):
        self.runtime.input_shape = [1, 4]
        with self.assertRaises(species.SpeciesError):
            self.annual()
        self.runtime.input_shape = [1, 3]
        self.runtime.output_dtype = np.int8
        with self.assertRaises(species.SpeciesError):
            self.annual()

    def test_rejects_nonfinite_out_of_range_and_wrong_shape_predictions(self):
        for row in ([float("nan"), 0, 0, 0], [1.1, 0, 0, 0], [-0.1, 0, 0, 0], [0, 0]):
            with self.subTest(row=row), self.assertRaises(species.SpeciesError):
                self.runtime.rows[1] = row
                self.annual()

    def test_rejects_invalid_or_duplicate_species_labels(self):
        for content in ("Turdus migratorius\n<script>\n", "Corvus corax\nCorvus corax\n", ""):
            with self.subTest(content=content), self.assertRaises(species.SpeciesError):
                self.labels.write_text(content)
                self.annual()

    def test_rejects_symlinked_and_oversized_model_files(self):
        self.model.unlink()
        self.model.symlink_to(self.labels)
        with self.assertRaises(species.SpeciesError):
            self.annual()
        self.model.unlink()
        with self.model.open("wb") as output:
            output.truncate(33 * 1024 * 1024)
        with self.assertRaises(species.SpeciesError):
            self.annual()

    def test_cli_reports_input_failure_without_partial_json_or_traceback(self):
        completed = subprocess.run([
            sys.executable, str(HELPER), "--latitude", "nan", "--longitude", "1",
            "--model-dir", str(self.root),
        ], capture_output=True, text=True, check=False)
        self.assertNotEqual(completed.returncode, 0)
        self.assertEqual(completed.stdout, "")
        self.assertIn("latitude", completed.stderr.lower())
        self.assertNotIn("Traceback", completed.stderr)


if __name__ == "__main__":
    unittest.main()
