#!/usr/bin/env python3
"""Canonical commitment for a manifest-ordered bundle object inventory."""
from __future__ import annotations

import hashlib
import re


DOMAIN = b"avian-bundle-object-inventory-v1\0"
SHA256 = re.compile(r"^[0-9a-f]{64}$")
FILE = re.compile(r"^illustrations/[a-z0-9]+(?:-[a-z0-9]+)*(?:-2)?\.png$")


class InventoryCommitmentError(ValueError):
    pass


def inventory_sha256(items: list[dict]) -> str:
    if not isinstance(items, list) or not items:
        raise InventoryCommitmentError("object inventory is missing")
    digest = hashlib.sha256(DOMAIN)
    for item in items:
        if not isinstance(item, dict):
            raise InventoryCommitmentError("object inventory is invalid")
        file = item.get("file")
        sha = item.get("sha256")
        size = item.get("bytes")
        if not isinstance(file, str) or not FILE.fullmatch(file) or "\0" in file:
            raise InventoryCommitmentError("object inventory path is invalid")
        if not isinstance(sha, str) or not SHA256.fullmatch(sha):
            raise InventoryCommitmentError("object inventory checksum is invalid")
        if not isinstance(size, int) or isinstance(size, bool) or size < 1:
            raise InventoryCommitmentError("object inventory byte count is invalid")
        digest.update(file.encode("utf-8"))
        digest.update(b"\0")
        digest.update(sha.encode("ascii"))
        digest.update(b"\0")
        digest.update(str(size).encode("ascii"))
        digest.update(b"\0")
    return digest.hexdigest()


def manifest_inventory(manifest: dict) -> list[dict]:
    species = manifest.get("species") if isinstance(manifest, dict) else None
    if not isinstance(species, list):
        raise InventoryCommitmentError("manifest species inventory is invalid")
    result = []
    for bird in species:
        poses = bird.get("poses") if isinstance(bird, dict) else None
        if not isinstance(poses, list):
            raise InventoryCommitmentError("manifest pose inventory is invalid")
        for pose in poses:
            if not isinstance(pose, dict):
                raise InventoryCommitmentError("manifest pose inventory is invalid")
            result.append({
                "file": pose.get("file"),
                "sha256": pose.get("sha256"),
                "bytes": pose.get("bytes"),
            })
    return result


def manifest_inventory_sha256(manifest: dict) -> str:
    return inventory_sha256(manifest_inventory(manifest))
