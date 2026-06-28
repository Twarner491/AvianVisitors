#!/usr/bin/env python3
"""AvianVisitors - build the taxonomy map + non-bird whitelist.

BirdNET's "6K global" model classifies ~6,522 classes, ~79 of which are
non-bird animals (frogs/toads, crickets/katydids, a few mammals). They're
real, vocalizing animals we want to catalog - but BirdNET-Pi's range/season
filter (`predicted_species_list`) is bird-only, so it silently drops them
unless they're in `whitelist_species_list.txt`.

This script reads the model's label file, classifies every non-bird animal by
genus, and emits two artifacts:

  1. taxa.json   - {"<Scientific name>": "amphibian"|"insect"|"mammal"}
                   for every non-bird animal. Anything NOT in here is a bird.
                   The frontend (apt.js) and pregen.py both read this.
  2. whitelist   - the full "Scientific_Common" label lines for those same
                   species, in the format loadCustomSpeciesList() expects
                   (it splits on '_'). Deployed to ~/BirdNET-Pi/.

Birds are intentionally NOT whitelisted - they keep normal range-gating.
Noise / non-animal classes (Dog, Engine, Siren, Human*, Noise, ...) have no
mapped genus, so they're treated as "not an animal we catalog": never
whitelisted, never in taxa.json.

Usage:
    python3 build_taxa.py                 # write taxa.json + whitelist
    python3 build_taxa.py --check         # print counts only, write nothing
"""
from __future__ import annotations
import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
DEFAULT_LABELS = REPO / "model" / "BirdNET_GLOBAL_6K_V2.4_Model_FP16_Labels.txt"
DEFAULT_TAXA = HERE.parent / "frontend" / "taxa.json"
DEFAULT_WHITELIST = HERE / "whitelist_species_list.txt"

# Curated genus -> group map for the model's non-bird animal classes. If a new
# BirdNET model adds non-bird genera, extend this. (Hyla/Rana are kept though
# modern taxonomy folds them into Dryophytes/Lithobates - harmless if absent.)
GENUS_GROUP = {
    # amphibians (frogs & toads)
    "Anaxyrus": "amphibian", "Incilius": "amphibian", "Dryophytes": "amphibian",
    "Hyla": "amphibian", "Pseudacris": "amphibian", "Lithobates": "amphibian",
    "Rana": "amphibian", "Acris": "amphibian", "Gastrophryne": "amphibian",
    "Scaphiopus": "amphibian",
    # insects (crickets & katydids)
    "Gryllus": "insect", "Miogryllus": "insect", "Allonemobius": "insect",
    "Eunemobius": "insect", "Anaxipha": "insect", "Oecanthus": "insect",
    "Neoconocephalus": "insect", "Conocephalus": "insect", "Orchelimum": "insect",
    "Pterophylla": "insect", "Amblycorypha": "insect", "Microcentrum": "insect",
    "Scudderia": "insect",
    # mammals
    "Canis": "mammal", "Sciurus": "mammal", "Tamias": "mammal",
    "Tamiasciurus": "mammal",
}


def build(labels_path: Path):
    """Return (taxa, whitelist_lines). The model label file is one scientific
    name per line ('Genus species'); single-token lines are noise classes
    (Dog, Engine, Noise, ...). taxa: {sci: group}; whitelist_lines: the sci
    names for non-bird animals (loadCustomSpeciesList splits on '_', so a
    bare scientific name is parsed unchanged)."""
    taxa: dict[str, str] = {}
    whitelist: list[str] = []
    for raw in labels_path.read_text().splitlines():
        sci = raw.strip()
        if " " not in sci:
            continue  # blank or single-token noise class
        genus = sci.split(" ", 1)[0]
        group = GENUS_GROUP.get(genus)
        if group:
            taxa[sci] = group
            whitelist.append(sci)
    return dict(sorted(taxa.items())), sorted(whitelist)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--labels", type=Path, default=DEFAULT_LABELS)
    ap.add_argument("--taxa-out", type=Path, default=DEFAULT_TAXA)
    ap.add_argument("--whitelist-out", type=Path, default=DEFAULT_WHITELIST)
    ap.add_argument("--check", action="store_true", help="print counts, write nothing")
    args = ap.parse_args()

    if not args.labels.is_file():
        print(f"error: labels not found at {args.labels}", file=sys.stderr)
        return 2

    taxa, whitelist = build(args.labels)
    by_group: dict[str, int] = {}
    for g in taxa.values():
        by_group[g] = by_group.get(g, 0) + 1
    print(f"non-bird animals: {len(taxa)} total")
    for g in sorted(by_group):
        print(f"  {g}: {by_group[g]}")

    if args.check:
        return 0

    args.taxa_out.write_text(json.dumps(taxa, indent=2, ensure_ascii=False) + "\n")
    args.whitelist_out.write_text("\n".join(whitelist) + "\n")
    print(f"\nwrote {args.taxa_out}")
    print(f"wrote {args.whitelist_out}  ({len(whitelist)} species)")
    print("deploy the whitelist to ~/BirdNET-Pi/whitelist_species_list.txt on the Pi")
    return 0


if __name__ == "__main__":
    sys.exit(main())
