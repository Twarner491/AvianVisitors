#!/usr/bin/env python3
"""Resolve year-round expected birds with the station's local BirdNET model."""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import math
import os
import re
import stat
import sys
from pathlib import Path

MODEL_FILES = {
    1: "BirdNET_GLOBAL_6K_V2.4_MData_Model_FP16.tflite",
    2: "BirdNET_GLOBAL_6K_V2.4_MData_Model_V2_FP16.tflite",
}
LABEL_FILE = "BirdNET_GLOBAL_6K_V2.4_Model_FP16_Labels.txt"
SCIENTIFIC_NAME = re.compile(r"[A-Z][A-Za-z-]{1,39}(?: [a-z][A-Za-z-]{1,39}){1,3}")
NONBIRD_LABELS = {"Dog", "Engine", "Environmental", "Fireworks", "Gun", "Noise", "Siren"}


class SpeciesError(ValueError):
    """The local model could not produce a trustworthy species selection."""


def _number(value: float, label: str, low: float, high: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise SpeciesError(f"{label} must be a number from {low} through {high}")
    number = float(value)
    if not math.isfinite(number) or not low <= number <= high:
        raise SpeciesError(f"{label} must be a number from {low} through {high}")
    return number if number else 0.0


def _read_regular(path: Path, maximum: int) -> bytes:
    flags = os.O_RDONLY | os.O_NONBLOCK | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
        with os.fdopen(descriptor, "rb") as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= maximum:
                raise SpeciesError(f"{path.name} is not a bounded regular file")
            raw = source.read(maximum + 1)
    except OSError as error:
        raise SpeciesError(f"could not read {path.name}") from error
    if not raw or len(raw) > maximum:
        raise SpeciesError(f"{path.name} is not a bounded regular file")
    return raw


def _load_runtime():
    os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
    os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")
    try:
        import numpy as np
        try:
            from tflite_runtime.interpreter import Interpreter
        except ImportError:
            try:
                from ai_edge_litert.interpreter import Interpreter
            except ImportError:
                from tensorflow import lite
                Interpreter = lite.Interpreter
    except ImportError as error:
        raise SpeciesError("a local TensorFlow Lite runtime and numpy are required") from error
    return np, Interpreter


def annual_species(
    latitude: float,
    longitude: float,
    model_dir: Path,
    model_version: int = 2,
    threshold: float = 0.03,
) -> dict:
    """Return annual expected species and a digest of the exact model inputs.

    Callers must run this helper without elevated privileges. Coordinates stay
    on the device; no external service or API credential is used.
    """
    latitude = _number(latitude, "latitude", -90, 90)
    longitude = _number(longitude, "longitude", -180, 180)
    threshold = _number(threshold, "threshold", 0, 1)
    if isinstance(model_version, bool) or not isinstance(model_version, int) or model_version not in MODEL_FILES:
        raise SpeciesError("model version must be 1 or 2")
    model_dir = Path(model_dir)
    if not model_dir.is_absolute() or not model_dir.is_dir() or model_dir.is_symlink():
        raise SpeciesError("model directory must be an absolute directory")
    model = _read_regular(model_dir / MODEL_FILES[model_version], 32 * 1024 * 1024)
    labels_raw = _read_regular(model_dir / LABEL_FILE, 2 * 1024 * 1024)
    try:
        labels = labels_raw.decode("utf-8").splitlines()
    except UnicodeDecodeError as error:
        raise SpeciesError("model labels must be UTF-8") from error
    if not 1 <= len(labels) <= 12000:
        raise SpeciesError("model label count is invalid")
    names: list[str | None] = []
    seen: set[str] = set()
    for label in labels:
        name = label.split("_", 1)[0].strip()
        if name in seen or (name not in NONBIRD_LABELS and SCIENTIFIC_NAME.fullmatch(name) is None):
            raise SpeciesError("model labels contain an invalid or repeated species")
        seen.add(name)
        names.append(None if name in NONBIRD_LABELS else name)

    selected: set[str] = set()
    try:
        with contextlib.redirect_stdout(sys.stderr):
            np, interpreter_type = _load_runtime()
            interpreter = interpreter_type(model_content=model, num_threads=1)
            inputs = interpreter.get_input_details()
            outputs = interpreter.get_output_details()
            if (
                len(inputs) != 1 or len(outputs) != 1
                or tuple(inputs[0]["shape"]) != (1, 3)
                or tuple(outputs[0]["shape"]) != (1, len(names))
                or inputs[0]["dtype"] != np.float32
                or outputs[0]["dtype"] != np.float32
            ):
                raise SpeciesError("metadata model dimensions do not match its labels")
            interpreter.allocate_tensors()
            for week in range(1, 49):
                sample = np.array([[latitude, longitude, week]], dtype=np.float32)
                interpreter.set_tensor(inputs[0]["index"], sample)
                interpreter.invoke()
                scores = interpreter.get_tensor(outputs[0]["index"])
                if (
                    not isinstance(scores, np.ndarray)
                    or scores.shape != (1, len(names))
                    or scores.dtype != np.float32
                    or not np.isfinite(scores).all()
                    or (scores < 0).any() or (scores > 1).any()
                ):
                    raise SpeciesError("metadata model returned invalid frequencies")
                selected.update(
                    name for name, score in zip(names, scores[0])
                    if name is not None and score >= threshold
                )
    except SpeciesError:
        raise
    except (ImportError, OSError, ValueError, RuntimeError, KeyError, TypeError, IndexError) as error:
        raise SpeciesError("local metadata model inference failed") from error

    basis = {
        "schema_version": 1,
        "latitude": latitude,
        "longitude": longitude,
        "model_version": model_version,
        "threshold": threshold,
        "model_sha256": hashlib.sha256(model).hexdigest(),
        "labels_sha256": hashlib.sha256(labels_raw).hexdigest(),
        "weeks": list(range(1, 49)),
    }
    digest = hashlib.sha256(json.dumps(
        basis, sort_keys=True, separators=(",", ":"), allow_nan=False,
    ).encode("utf-8")).hexdigest()
    return {"schema_version": 1, "species": sorted(selected), "basis_sha256": digest}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--latitude", required=True, type=float)
    parser.add_argument("--longitude", required=True, type=float)
    parser.add_argument("--model-dir", required=True, type=Path)
    parser.add_argument("--model-version", default=2, type=int, choices=(1, 2))
    parser.add_argument("--threshold", default=0.03, type=float)
    args = parser.parse_args()
    try:
        result = annual_species(
            args.latitude, args.longitude, args.model_dir, args.model_version, args.threshold,
        )
    except SpeciesError as error:
        print(f"bundle-species: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True, separators=(",", ":"), allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
