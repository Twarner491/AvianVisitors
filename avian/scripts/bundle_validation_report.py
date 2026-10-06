#!/usr/bin/env python3
"""Reduce archive-validator output to the bounded hosted result contract."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import urllib.parse
import zipfile
from pathlib import Path

import bundle_inventory_commitment
import bundle_submission_check


AI_FLAG_CODES = {
    "not_bird", "bird_uncertain", "species_mismatch", "species_uncertain",
    "style_outlier", "style_uncertain", "pose_mismatch", "text_or_logo",
    "multiple_subjects", "visual_artifact",
    "pair_mismatch",
}
SHA256 = re.compile(r"^[0-9a-f]{64}$")
ILLUSTRATION_FILE = re.compile(r"^illustrations/[a-z0-9]+(?:-[a-z0-9]+)*(?:-2)?\.png$")
MAX_ILLUSTRATION_PATH_CHARS = 183
PACK_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,79}$")
VERSION = re.compile(
    r"(?=.{1,40}\Z)"
    r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
    r"(?:-(?:"
    r"(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)"
    r")(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
)
REGION_CODE = re.compile(r"^[A-Z]{2}(?:-[A-Z0-9]{1,8}){0,3}$")
LICENSE = re.compile(r"^[A-Za-z0-9.+-]{2,80}$")
SUPPORTED_HOSTED_LICENSES = {
    "CC0-1.0", "CC-BY-4.0", "CC-BY-SA-4.0", "CC-BY-NC-SA-4.0",
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(128 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def clean_finding(value: object) -> str:
    text = " ".join(str(value or "validation failed").split())
    return "".join(
        char for char in text
        if char >= " " and ord(char) != 0x7F and char not in "<>"
    )[:240] or "validation failed"


def bounded_text(value: object, limit: int) -> str:
    text = " ".join(str(value or "").split())
    return "".join(
        char for char in text
        if char >= " " and ord(char) != 0x7F and char not in "<>"
    )[:limit]


def exact_illustration_path(value: object) -> str:
    if (
        not isinstance(value, str)
        or len(value) > MAX_ILLUSTRATION_PATH_CHARS
        or not ILLUSTRATION_FILE.fullmatch(value)
    ):
        raise ValueError("AI evidence illustration path is invalid")
    return value


def exact_public_text(value: object, limit: int, required: bool = False) -> str:
    if value is None and not required:
        return ""
    if not isinstance(value, str) or len(value) > limit or (required and not value.strip()):
        raise ValueError("public manifest text is invalid")
    if any(
        ord(char) < 0x20
        or ord(char) == 0x7F
        or 0xD800 <= ord(char) <= 0xDFFF
        or char in "<>"
        for char in value
    ):
        raise ValueError("public manifest text is invalid")
    return value


def normalize_public_manifest(value: object, validation: dict) -> dict:
    if not isinstance(value, dict) or set(value) != {
        "id", "version", "name", "description", "style", "coverage", "license",
        "attribution", "provenance",
    }:
        raise ValueError("public manifest is invalid")
    pack_id = value.get("id")
    version = value.get("version")
    if (
        not isinstance(pack_id, str) or not PACK_ID.fullmatch(pack_id)
        or pack_id.startswith("official-")
        or pack_id != validation.get("id")
        or not isinstance(version, str) or not VERSION.fullmatch(version)
        or version != validation.get("version")
    ):
        raise ValueError("public manifest identity is invalid")
    style = value.get("style")
    coverage = value.get("coverage")
    license_data = value.get("license")
    attribution = value.get("attribution")
    provenance = value.get("provenance")
    if not all(isinstance(item, dict) for item in (
        style, coverage, license_data, attribution, provenance
    )):
        raise ValueError("public manifest claims are invalid")
    if (
        set(style) != {"id", "name"}
        or set(coverage) != {"type", "label", "region_codes"}
        or set(license_data) != {"spdx"}
        or set(attribution) != {"creator", "source_url"}
        or set(provenance) != {"method", "model", "review"}
    ):
        raise ValueError("public manifest claims are invalid")
    style_id = style.get("id")
    if not isinstance(style_id, str) or not PACK_ID.fullmatch(style_id):
        raise ValueError("public manifest style is invalid")
    coverage_type = coverage.get("type")
    codes = coverage.get("region_codes")
    if coverage_type not in {"region", "global", "selection"}:
        raise ValueError("public manifest coverage is invalid")
    if (
        not isinstance(codes, list) or len(codes) > 32 or len(set(codes)) != len(codes)
        or any(not isinstance(code, str) or not REGION_CODE.fullmatch(code) for code in codes)
    ):
        raise ValueError("public manifest region codes are invalid")
    if (coverage_type == "region" and not codes) or (coverage_type == "global" and codes):
        raise ValueError("public manifest coverage is invalid")
    spdx = license_data.get("spdx")
    if (
        not isinstance(spdx, str)
        or not LICENSE.fullmatch(spdx)
        or spdx not in SUPPORTED_HOSTED_LICENSES
    ):
        raise ValueError("public manifest license is invalid")
    source_url = attribution.get("source_url")
    if source_url is not None:
        source_url = exact_public_text(source_url, 500, True)
        if "\\" in source_url:
            raise ValueError("public manifest attribution is invalid")
        try:
            parsed_source = urllib.parse.urlsplit(source_url)
        except ValueError as exc:
            raise ValueError("public manifest attribution is invalid") from exc
        if (
            parsed_source.scheme != "https"
            or not parsed_source.hostname
            or parsed_source.username is not None
            or parsed_source.password is not None
        ):
            raise ValueError("public manifest attribution is invalid")
    model = provenance.get("model")
    review = provenance.get("review")
    if model is not None:
        model = exact_public_text(model, 120, True)
    if review is not None:
        review = exact_public_text(review, 80, True)
    return {
        "id": pack_id,
        "version": version,
        "name": exact_public_text(value.get("name"), 90, True),
        "description": exact_public_text(value.get("description"), 260),
        "style": {
            "id": style_id,
            "name": exact_public_text(style.get("name"), 80, True),
        },
        "coverage": {
            "type": coverage_type,
            "label": exact_public_text(coverage.get("label"), 120, True),
            "region_codes": list(codes),
        },
        "license": {"spdx": spdx},
        "attribution": {
            "creator": exact_public_text(attribution.get("creator"), 120, True),
            "source_url": source_url,
        },
        "provenance": {
            "method": exact_public_text(provenance.get("method"), 40, True),
            "model": model,
            "review": review,
        },
    }


def preview_descriptor(value: object, sampled: bool = False) -> dict | None:
    if not isinstance(value, dict) or not SHA256.fullmatch(str(value.get("sha256", ""))):
        return None
    size = value.get("bytes")
    if not isinstance(size, int) or not 1 <= size <= 256 * 1024:
        return None
    result = {"sha256": value["sha256"], "bytes": size}
    if sampled:
        count = value.get("sampled")
        if not isinstance(count, int) or isinstance(count, bool) or not 1 <= count <= 12:
            return None
        result["sampled"] = count
    return result


def failed_ai_review(error: object = None) -> dict:
    return {
        "schema_version": 1,
        "prompt_version": "avian-bundle-triage-v2",
        "model": "gpt-5.6-luna",
        "ok": False,
        "checked": 0,
        "sampled": 0,
        "bird_assessment": {"not_bird": 0, "uncertain": 0},
        "style_assessment": {"name_fit": "uncertain", "consistency": "uncertain", "summary": ""},
        "flags": [],
        "canonical_samples": [],
        "total_flag_count": 0,
        "flags_truncated": False,
        "error": bounded_text(error or "AI advisory result could not be read", 160),
    }


def normalize_ai_review(value: object, objects: int) -> dict:
    if not isinstance(value, dict):
        return failed_ai_review()
    try:
        schema_version = value.get("schema_version")
        prompt_version = bounded_text(value.get("prompt_version"), 64)
        model = bounded_text(value.get("model"), 80)
        ok = value.get("ok")
        checked = value.get("checked")
        sampled = value.get("sampled")
        birds = value.get("bird_assessment")
        style = value.get("style_assessment")
        flags = value.get("flags")
        canonical_samples = value.get("canonical_samples")
        total_flag_count = value.get("total_flag_count")
        flags_truncated = value.get("flags_truncated")
        if schema_version != 1 or not prompt_version or not model or not isinstance(ok, bool):
            raise ValueError
        if not isinstance(checked, int) or not 0 <= checked <= objects:
            raise ValueError
        if ok and checked != objects:
            raise ValueError
        if (
            not isinstance(sampled, int)
            or isinstance(sampled, bool)
            or not 0 <= sampled <= min(6, checked)
            or (ok and sampled < 1)
        ):
            raise ValueError
        if not isinstance(birds, dict) or any(
            not isinstance(birds.get(key), int) or not 0 <= birds[key] <= checked
            for key in ("not_bird", "uncertain")
        ):
            raise ValueError
        if not isinstance(style, dict):
            raise ValueError
        name_fit = style.get("name_fit")
        consistency = style.get("consistency")
        if name_fit not in {"apt", "uncertain", "mismatch"}:
            raise ValueError
        if consistency not in {"consistent", "mixed", "uncertain"}:
            raise ValueError
        if (
            not isinstance(flags, list) or len(flags) > 40
            or not isinstance(canonical_samples, list) or len(canonical_samples) > 40
        ):
            raise ValueError
        if (
            not isinstance(total_flag_count, int) or isinstance(total_flag_count, bool)
            or not len(flags) <= total_flag_count <= objects * 8
            or not isinstance(flags_truncated, bool)
            or flags_truncated != (total_flag_count > len(flags))
        ):
            raise ValueError
        normalized_samples = []
        canonical_total = 0
        sample_files = set()
        sample_ordinals = set()
        for item in canonical_samples:
            if not isinstance(item, dict) or set(item) != {
                "object_ordinal", "file", "sha256", "bytes", "width", "height", "role",
            }:
                raise ValueError
            object_ordinal = item.get("object_ordinal")
            file = exact_illustration_path(item.get("file"))
            digest = item.get("sha256")
            size = item.get("bytes")
            width = item.get("width")
            height = item.get("height")
            role = item.get("role")
            if (
                not isinstance(object_ordinal, int) or isinstance(object_ordinal, bool)
                or not 0 <= object_ordinal < objects
                or not isinstance(digest, str) or not SHA256.fullmatch(digest)
                or not isinstance(size, int) or isinstance(size, bool) or not 1 <= size <= 4 * 1024 * 1024
                or not isinstance(width, int) or isinstance(width, bool) or not 1 <= width <= 4096
                or not isinstance(height, int) or isinstance(height, bool) or not 1 <= height <= 4096
                or role not in {"flag", "control"}
                or file in sample_files
                or object_ordinal in sample_ordinals
            ):
                raise ValueError
            sample_files.add(file)
            sample_ordinals.add(object_ordinal)
            canonical_total += size
            normalized_samples.append({
                "object_ordinal": object_ordinal,
                "file": file, "sha256": digest, "bytes": size,
                "width": width, "height": height, "role": role,
            })
        if canonical_total > 64 * 1024 * 1024:
            raise ValueError
        normalized_flags = []
        for item in flags:
            if not isinstance(item, dict):
                raise ValueError
            file = exact_illustration_path(item.get("file"))
            code = item.get("code")
            confidence = item.get("confidence")
            reason = bounded_text(item.get("reason"), 240)
            canonical_index = item.get("canonical_index")
            if code not in AI_FLAG_CODES:
                raise ValueError
            if not isinstance(confidence, (int, float)) or isinstance(confidence, bool) or not 0 <= confidence <= 1:
                raise ValueError
            if not reason:
                raise ValueError
            if (
                not isinstance(canonical_index, int) or isinstance(canonical_index, bool)
                or not 0 <= canonical_index < len(normalized_samples)
                or normalized_samples[canonical_index]["file"] != file
                or normalized_samples[canonical_index]["role"] != "flag"
            ):
                raise ValueError
            normalized = {
                "file": file,
                "code": code,
                "confidence": round(float(confidence), 3),
                "reason": reason,
                "canonical_index": canonical_index,
            }
            preview = preview_descriptor(item.get("preview"))
            if preview is not None:
                normalized["preview"] = preview
            elif ok:
                raise ValueError
            normalized_flags.append(normalized)
        result = {
            "schema_version": 1,
            "prompt_version": prompt_version,
            "model": model,
            "ok": ok,
            "checked": checked,
            "sampled": sampled,
            "bird_assessment": {"not_bird": birds["not_bird"], "uncertain": birds["uncertain"]},
            "style_assessment": {
                "name_fit": name_fit,
                "consistency": consistency,
                "summary": bounded_text(style.get("summary"), 240),
            },
            "flags": normalized_flags,
            "canonical_samples": normalized_samples,
            "total_flag_count": total_flag_count,
            "flags_truncated": flags_truncated,
        }
        contact = preview_descriptor(value.get("contact_sheet"), sampled=True)
        if ok and (
            not normalized_samples
            or contact is None
            or contact["sampled"] > min(12, checked)
        ):
            raise ValueError
        if contact is not None:
            result["contact_sheet"] = contact
        if not ok:
            result["error"] = bounded_text(value.get("error") or "AI advisory review did not complete", 160)
        return result
    except (KeyError, TypeError, ValueError):
        return failed_ai_review()


def build_report(
    archive: Path | None,
    validation: dict,
    context: dict | None = None,
    moderation: dict | None = None,
    ai_review: dict | None = None,
) -> dict:
    if not validation.get("ok"):
        return {"ok": False, "summary": {}, "findings": [clean_finding(validation.get("error"))]}
    if context is not None:
        if archive is None:
            return {"ok": False, "summary": {}, "findings": ["submission claims were not checked"]}
        try:
            bundle_submission_check.check_claims(archive, context)
        except bundle_submission_check.ClaimMismatch as exc:
            return {"ok": False, "summary": {}, "findings": [clean_finding(exc)]}
    archive_sha256 = validation.get("archive_sha256")
    manifest_sha256 = validation.get("manifest_sha256")
    publish_manifest_sha256 = validation.get("publish_manifest_sha256")
    if archive is not None and (
        not SHA256.fullmatch(str(archive_sha256 or ""))
        or not SHA256.fullmatch(str(manifest_sha256 or ""))
    ):
        with zipfile.ZipFile(archive) as bundle:
            manifest = bundle.read("manifest.json")
        archive_sha256 = sha256_file(archive)
        manifest_sha256 = hashlib.sha256(manifest).hexdigest()
    if not SHA256.fullmatch(str(archive_sha256 or "")) or not SHA256.fullmatch(str(manifest_sha256 or "")):
        return {"ok": False, "summary": {}, "findings": ["validated archive hashes are missing"]}
    if not SHA256.fullmatch(str(publish_manifest_sha256 or "")):
        return {"ok": False, "summary": {}, "findings": ["canonical publish manifest hash is missing"]}
    summary = {
        "id": validation["id"],
        "version": validation["version"],
        "species": int(validation["species"]),
        "objects": int(validation["objects"]),
        "expanded_bytes": int(validation["expanded_bytes"]),
        "archive_sha256": archive_sha256,
        "manifest_sha256": manifest_sha256,
        "publish_manifest_sha256": publish_manifest_sha256,
    }
    try:
        public_manifest = normalize_public_manifest(validation.get("public_manifest"), validation)
    except ValueError:
        return {"ok": False, "summary": summary, "findings": ["validated public manifest claims are missing"]}
    findings = []
    normalized_ai = normalize_ai_review(ai_review, int(validation["objects"])) if ai_review is not None else None
    if moderation is not None:
        summary["moderation_checked"] = int(moderation.get("checked", moderation.get("images", 0)))
        summary["moderation_flagged"] = int(moderation.get("flagged_count", 0))
        if not moderation.get("ok"):
            result = {
                "ok": False,
                "summary": summary,
                "findings": [clean_finding(moderation.get("error") or "content safety moderation did not complete")],
            }
            if normalized_ai is not None:
                result["ai_review"] = normalized_ai
            return result
        if moderation.get("metadata_checked") is not True:
            result = {
                "ok": False,
                "summary": summary,
                "findings": ["content safety moderation did not verify the public manifest"],
            }
            if normalized_ai is not None:
                result["ai_review"] = normalized_ai
            return result
        moderated_inventory_sha256 = moderation.get("object_inventory_sha256")
        try:
            expected_inventory_sha256 = bundle_inventory_commitment.inventory_sha256(
                validation.get("publish_object_inventory")
            )
        except bundle_inventory_commitment.InventoryCommitmentError:
            expected_inventory_sha256 = None
        if (
            not SHA256.fullmatch(str(moderated_inventory_sha256 or ""))
            or moderated_inventory_sha256 != expected_inventory_sha256
        ):
            result = {
                "ok": False,
                "summary": summary,
                "findings": ["moderated image inventory does not match the canonical publish inventory"],
            }
            if normalized_ai is not None:
                result["ai_review"] = normalized_ai
            return result
        summary["moderated_object_inventory_sha256"] = moderated_inventory_sha256
        expected_checks = int(validation["objects"]) + 1
        if summary["moderation_checked"] != expected_checks:
            result = {
                "ok": False,
                "summary": summary,
                "findings": ["content safety moderation did not cover every image and the public manifest"],
            }
            if normalized_ai is not None:
                result["ai_review"] = normalized_ai
            return result
        for item in moderation.get("flagged", [])[:20]:
            categories = ", ".join(item.get("categories") or []) or "flagged"
            findings.append(clean_finding(f"content safety block: {item.get('file', 'image')} ({categories})"))
        if summary["moderation_flagged"]:
            result = {
                "ok": False, "summary": summary,
                "findings": findings or ["content safety moderation blocked this submission"],
            }
            if normalized_ai is not None:
                result["ai_review"] = normalized_ai
            return result
    if normalized_ai is not None:
        if not normalized_ai["ok"]:
            findings.append(clean_finding("AI advisory incomplete: " + normalized_ai.get("error", "review unavailable")))
        else:
            style = normalized_ai["style_assessment"]
            if style["name_fit"] != "apt":
                findings.append(clean_finding(f"AI advisory: style name fit is {style['name_fit']}"))
            if style["consistency"] != "consistent":
                findings.append(clean_finding(f"AI advisory: bundle style appears {style['consistency']}"))
            if normalized_ai["flags"]:
                shown = len(normalized_ai["flags"])
                total = normalized_ai["total_flag_count"]
                findings.append(clean_finding(
                    f"AI advisory: showing {shown} of {total} review flag(s); inspect the per-image review"
                ))
    result = {
        "ok": True,
        "summary": summary,
        "public_manifest": public_manifest,
        "findings": findings,
    }
    if normalized_ai is not None:
        result["ai_review"] = normalized_ai
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path)
    parser.add_argument("--validation", required=True, type=Path)
    parser.add_argument("--context", type=Path)
    parser.add_argument("--moderation", type=Path)
    parser.add_argument("--ai-review", type=Path)
    args = parser.parse_args()
    try:
        result = json.loads(args.validation.read_text(encoding="utf-8"))
        if not isinstance(result, dict):
            raise ValueError("validator result is not an object")
        context = json.loads(args.context.read_text(encoding="utf-8")) if args.context else None
        moderation = json.loads(args.moderation.read_text(encoding="utf-8")) if args.moderation else None
        if args.ai_review:
            try:
                ai_review = json.loads(args.ai_review.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                ai_review = failed_ai_review()
        else:
            ai_review = None
        report = build_report(args.archive, result, context, moderation, ai_review)
    except Exception:
        report = {"ok": False, "summary": {}, "findings": ["validation result could not be read"]}
    print(json.dumps(report, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
