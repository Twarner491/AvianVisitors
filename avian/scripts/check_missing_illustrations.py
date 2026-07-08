#!/usr/bin/env python3
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[2]
LABELS_PATH = ROOT / "model" / "leuven-birds.txt"
ILLUSTRATIONS_DIR = ROOT / "avian" / "assets" / "illustrations"


def parse_scientific_names(path: Path) -> list[str]:
    names = []
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "|" in line:
            sci = line.split("|", 1)[0].strip()
        else:
            sci = line
        if sci:
            names.append(sci)
    return names


def existing_slugs(illustrations_dir: Path) -> set[str]:
    if not illustrations_dir.exists():
        return set()
    slugs = set()
    for path in illustrations_dir.glob("*.png"):
        name = path.name
        if name.endswith("-2.png"):
            slug = name[:-6]
        else:
            slug = name[:-4]
        slugs.add(slug)
    return slugs


def main() -> int:
    names = parse_scientific_names(LABELS_PATH)
    existing = existing_slugs(ILLUSTRATIONS_DIR)

    missing = []
    for sci in names:
        slug = re.sub(r"[^a-z0-9]+", "-", sci.lower()).strip("-")
        if slug not in existing:
            missing.append(sci)

    print(f"Total scientific names: {len(names)}")
    print(f"Illustration files found: {len(existing)}")
    print(f"Missing from illustrations: {len(missing)}")
    if missing:
        print("\nMissing names:")
        for name in missing:
            print(f"- {name}")
    else:
        print("\nAll names already have illustrations.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
