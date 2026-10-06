#!/usr/bin/env python3
from __future__ import annotations

import ast
import json
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
VALIDATE = ROOT / ".github" / "workflows" / "validate-bundle.yml"
PUBLISH = ROOT / ".github" / "workflows" / "publish-bundle.yml"
AI_REVIEW = ROOT / "avian" / "scripts" / "bundle_ai_review.py"
PUBLISHER = ROOT / "avian" / "scripts" / "bundle_publish.py"
PUBLICATION_PACKAGE = ROOT / "avian" / "scripts" / "bundle_publication_package.py"
SCRIPTS = ROOT / "avian" / "scripts"
HTTP = SCRIPTS / "bundle_http.py"
CREDENTIAL_CLIENTS = (
    SCRIPTS / "bundle_ai_review.py",
    SCRIPTS / "bundle_moderate.py",
    SCRIPTS / "bundle_review_assets.py",
    SCRIPTS / "bundle_canonical_upload.py",
    SCRIPTS / "bundle_publish.py",
)


def section(text: str, start: str, end: str | None = None) -> str:
    value = text.split(start, 1)[1]
    return value.split(end, 1)[0] if end else value


def local_import_closure(entry: Path) -> set[str]:
    """Return local modules reachable from one script without dynamic imports."""
    pending = [entry]
    visited: set[Path] = set()
    local_modules: set[str] = set()
    while pending:
        path = pending.pop()
        if path in visited:
            continue
        visited.add(path)
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported = [node.module]
            else:
                imported = []
            if any(name.split(".", 1)[0] in {"importlib", "runpy"} for name in imported):
                raise AssertionError(f"dynamic import module is forbidden in {path.name}")
            if isinstance(node, ast.Call) and (
                (
                    isinstance(node.func, ast.Name)
                    and node.func.id in {"__import__", "import_module", "exec", "eval"}
                )
                or (
                    isinstance(node.func, ast.Attribute)
                    and node.func.attr == "import_module"
                )
            ):
                raise AssertionError(f"dynamic import is forbidden in {path.name}")
            for name in imported:
                root = name.split(".", 1)[0]
                local = SCRIPTS / f"{root}.py"
                if local.is_file():
                    local_modules.add(root)
                    pending.append(local)
    return local_modules


class BundleWorkflowSecurityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.validation = VALIDATE.read_text(encoding="utf-8")
        cls.validate = section(cls.validation, "  validate:", "  report_failure:")
        cls.validation_failure = section(cls.validation, "  report_failure:")
        cls.publication = PUBLISH.read_text(encoding="utf-8")
        cls.prepare = section(cls.publication, "  prepare:", "  confirm:")
        cls.publication_failure = section(cls.publication, "  report_failure:")

    def test_raw_validation_input_is_never_an_actions_artifact_or_secret_job_input(self):
        self.assertNotIn("bundle-quarantine-", self.validation)
        self.assertIn("bundle-submission.zip", self.validate)
        self.assertNotIn("bundle-submission.zip", self.validation_failure)
        self.assertNotIn("actions/upload-artifact", self.validation)
        self.assertNotIn("actions/download-artifact", self.validation)

    def test_validation_decoder_process_is_secret_free_networkless_and_unprivileged(self):
        decoder = self.validate.split(
            "Validate and canonicalize without credentials or network", 1
        )[1].split("# The decoder process has exited", 1)[0]
        self.assertNotIn("secrets.", decoder)
        self.assertNotIn("VALIDATION_KEY", decoder)
        self.assertNotIn("OPENAI_API_KEY", decoder)
        self.assertIn("--net --pid --fork --kill-child --mount-proc -- setpriv", decoder)
        self.assertIn("--reuid=nobody --regid=nogroup --clear-groups --no-new-privs", decoder)
        self.assertIn("env -i", decoder)
        self.assertIn("chgrp -R nogroup quarantine-input", decoder)
        self.assertIn("chmod 0750 quarantine-input", decoder)
        self.assertIn("-o root -g nogroup -m 0550 decoder-source", decoder)
        self.assertIn('"$PWD/decoder-source/bundle_review_package.py"', decoder)
        install = decoder.split("sudo install -o root -g nogroup -m 0440", 1)[1].split(
            "decoder-source/", 1
        )[0]
        installed = set(re.findall(r"avian/scripts/([a-z_]+\.py)", install))
        local_modules = local_import_closure(ROOT / "avian/scripts/bundle_review_package.py")
        self.assertEqual(installed, {"bundle_review_package.py"} | {
            f"{name}.py" for name in local_modules
        })
        self.assertEqual(len(installed), 9)
        self.assertIn("bundle_http.py", installed)
        self.assertIn("bundle_preview_geometry.py", installed)
        self.assertIn("bundle_validation_contract.py", installed)
        self.assertNotIn("bundle_manager.py", installed)
        self.assertNotIn("*", install)
        self.assertIn('chown -R "$(id -u):$(id -g)" sanitized-output', decoder)
        self.assertIn("shred --remove --zero", decoder)
        self.assertIn("persist-credentials: false", self.validate)

    def test_openai_job_is_canonical_only_and_decoder_free(self):
        openai_step = self.validate.split("Run safety gate and advisory review", 1)[1].split(
            "Upload private review imagery", 1
        )[0]
        self.assertIn("OPENAI_API_KEY", openai_step)
        self.assertNotIn("bundle-submission.zip", openai_step)
        self.assertNotIn("pip install", openai_step)
        self.assertGreaterEqual(
            openai_step.count("--review-package sanitized-output/canonical-review"), 2
        )
        source = AI_REVIEW.read_text(encoding="utf-8")
        self.assertIn("import bundle_http", source)
        self.assertIn("with bundle_http.urlopen(request, timeout=90)", source)
        self.assertNotIn("urllib.request.urlopen(request", source)
        tree = ast.parse(AI_REVIEW.read_text(encoding="utf-8"))
        top_imports = [node for node in tree.body if isinstance(node, (ast.Import, ast.ImportFrom))]
        self.assertFalse(any(
            (isinstance(node, ast.ImportFrom) and (node.module or "").startswith("PIL"))
            or (isinstance(node, ast.Import) and any(alias.name.startswith("PIL") for alias in node.names))
            for node in top_imports
        ))

    def test_every_credential_client_uses_shared_reject_all_redirect_transport(self):
        helper = HTTP.read_text(encoding="utf-8")
        self.assertIn("class RejectAllRedirects", helper)
        self.assertIn("urllib.request.build_opener(RejectAllRedirects())", helper)
        self.assertIn("return _OPENER.open(request, timeout=timeout)", helper)
        expected_timeouts = {
            "bundle_ai_review.py": 90,
            "bundle_moderate.py": 45,
            "bundle_review_assets.py": 45,
            "bundle_canonical_upload.py": 90,
            "bundle_publish.py": 60,
        }
        for path in CREDENTIAL_CLIENTS:
            with self.subTest(client=path.name):
                source = path.read_text(encoding="utf-8")
                self.assertIn("import bundle_http", source)
                self.assertIn(
                    f"bundle_http.urlopen(request, timeout={expected_timeouts[path.name]})",
                    source,
                )
                self.assertNotIn("urllib.request.urlopen(", source)

    def test_validation_mutations_are_attempt_bound_and_have_failure_callback(self):
        self.assertIn("validation_attempt:", self.validation)
        self.assertGreaterEqual(self.validate.count("X-Bundle-Validation-Attempt"), 3)
        self.assertEqual(self.validate.count('--submission="$SUBMISSION_ID"'), 2)
        self.assertEqual(self.validate.count('--attempt="$VALIDATION_ATTEMPT"'), 2)
        self.assertEqual(self.validate.count("BUNDLE_VALIDATION_KEY:"), 2)
        self.assertIn("X-Bundle-Validation-Attempt", self.validation_failure)
        self.assertIn("always()", self.validation_failure)
        self.assertNotIn("actions/checkout", self.validation_failure)
        self.assertNotIn("actions/download-artifact", self.validation_failure)

    def test_sanitizer_rejections_use_the_bounded_validation_callback(self):
        decoder = self.validate.split(
            "Validate and canonicalize without credentials or network", 1
        )[1].split("# The decoder process has exited", 1)[0]
        self.assertIn("id: sanitize", self.validate)
        self.assertIn("if .ok == true", decoder)
        self.assertIn("elif .ok == false", decoder)
        self.assertIn("printf 'valid=%s\\n'", decoder)
        self.assertEqual(
            self.validate.count("if: steps.sanitize.outputs.valid == 'true'"), 3
        )
        report_step = self.validate.split("Build bounded validation report", 1)[1].split(
            "Report bounded result", 1
        )[0]
        self.assertIn("jq -e '.ok == true' validation.json", report_step)
        self.assertIn("--validation validation.json > report.json", report_step)
        self.assertNotIn("secrets.", report_step)

    def test_publication_raw_input_is_never_an_actions_artifact_or_publish_key_input(self):
        self.assertNotIn("bundle-submission.zip", self.publication)
        self.assertIn("/canonical-index", self.prepare)
        self.assertIn("/canonical-manifest", self.prepare)
        self.assertIn("/canonical-objects/$ORDINAL", self.prepare)
        self.assertNotIn("bundle-submission.zip", self.publication_failure)
        self.assertNotIn("actions/upload-artifact", self.publication)
        self.assertNotIn("actions/download-artifact", self.publication)

    def test_publication_fetch_uses_attempt_bound_canonical_read_authority(self):
        fetch = section(
            self.prepare, "      - name: Fetch immutable moderated canonical inputs\n",
            "\n      # This process gets no secret or network.",
        )
        environment, commands = fetch.split("        run: |\n", 1)
        values = {
            "inputs.submission_id": "publicationtestid000001",
            "inputs.publication_attempt": "P" * 32,
            "secrets.BUNDLE_CANONICAL_READ_KEY": "test-canonical-read-only",
            "secrets.BUNDLE_VALIDATION_KEY": "test-validator-forbidden",
        }
        bindings = re.findall(
            r"^          ([A-Z_]+): \$\{\{ ([^}]+) \}\}$", environment, re.MULTILINE
        )
        self.assertEqual(len(bindings), 3)
        jq = shutil.which("jq")
        self.assertIsNotNone(jq, "workflow execution test requires jq")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "fixture-index.json").write_text(json.dumps({
                "schema_version": 1,
                "canonicalization": "rgba-png-zero-transparent-v1",
                "input_archive_sha256": "a" * 64,
                "input_manifest_sha256": "b" * 64,
                "publish_manifest_sha256": "c" * 64,
                "object_inventory_sha256": "d" * 64,
                "objects": [{
                    "ordinal": 0, "file": "illustrations/test-bird.png",
                    "sha256": "e" * 64, "bytes": 1, "width": 1, "height": 1,
                }],
            }))
            # Only the network boundary is replaced; Bash, jq, the object loop,
            # output paths, chmod, headers and URLs all come from the workflow.
            stub = root / "record_curl.py"
            stub.write_text(textwrap.dedent("""\
                import json
                import sys
                from pathlib import Path
                arguments = sys.argv[1:]
                with Path("requests.jsonl").open("a") as output:
                    output.write(json.dumps(arguments) + "\\n")
                target = Path(arguments[arguments.index("--output") + 1])
                raw = (Path("fixture-index.json").read_bytes()
                       if target.name == "canonical-index.json" else b"fixture")
                target.write_bytes(raw)
                """))
            shell = (
                "set -euo pipefail\n"
                f"curl() {{ {shlex.quote(sys.executable)} {shlex.quote(str(stub))} \"$@\"; }}\n"
                + textwrap.dedent(commands)
            )
            result = subprocess.run(
                ["/bin/bash", "--noprofile", "--norc"], input=shell,
                cwd=root, text=True, capture_output=True, timeout=30,
                env={"PATH": f"{Path(jq).parent}:/usr/bin:/bin",
                     **{key: values[value] for key, value in bindings}},
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            requests = [json.loads(line) for line in
                        (root / "requests.jsonl").read_text().splitlines()]
            self.assertEqual(len(requests), 4)
            for arguments in requests:
                with self.subTest(url=arguments[-1]):
                    headers = [arguments[index + 1] for index, value in
                               enumerate(arguments) if value == "--header"]
                    self.assertEqual(headers, [
                        "X-Bundle-Canonical-Read-Key: test-canonical-read-only",
                        "X-Bundle-Publication-Attempt: " + "P" * 32,
                    ])
            prefix = "https://avianvisitors.com/api/bundles/publication/publicationtestid000001"
            self.assertEqual([arguments[-1] for arguments in requests], [
                f"{prefix}/canonical-index", f"{prefix}/canonical-manifest",
                f"{prefix}/context", f"{prefix}/canonical-objects/0",
            ])

    def test_publication_workflow_never_receives_validator_authority(self):
        self.assertNotIn("BUNDLE_VALIDATION_KEY", self.publication)
        self.assertNotIn("X-Bundle-Validation-Key", self.publication)
        self.assertNotIn("/api/bundles/validation/", self.publication)

    def test_publication_decoder_is_secret_free_networkless_and_unprivileged(self):
        decoder = self.prepare.split(
            "Materialize persisted canonical package without credentials or network", 1
        )[1].split("# The decoder has exited", 1)[0]
        self.assertNotIn("secrets.", decoder)
        self.assertNotIn("VALIDATION_KEY", decoder)
        self.assertNotIn("BUNDLE_PUBLISH_KEY", decoder)
        self.assertIn("unshare --net", decoder)
        self.assertIn("--reuid=nobody --regid=nogroup --clear-groups --no-new-privs", decoder)
        self.assertIn("env -i", decoder)
        self.assertIn("chgrp -R nogroup publication-input", decoder)
        self.assertIn("chmod 0750 publication-input", decoder)
        self.assertIn('chown -R "$(id -u):$(id -g)" publication-output', decoder)
        self.assertIn("shred --remove --zero", decoder)
        self.assertIn("persist-credentials: false", self.prepare)
        source = PUBLICATION_PACKAGE.read_text(encoding="utf-8")
        self.assertNotIn("import zipfile", source)
        self.assertNotIn("canonical_png(", source)
        self.assertNotIn("--archive", source)

    def test_publish_key_job_is_byte_only_and_attempt_bound(self):
        upload = self.prepare.split("Upload immutable public bytes", 1)[1]
        self.assertIn("BUNDLE_PUBLISH_KEY", upload)
        self.assertIn("publication_attempt:", self.publication)
        fetch = self.prepare.split("Fetch immutable moderated canonical inputs", 1)[1].split(
            "Materialize persisted canonical package", 1
        )[0]
        self.assertGreaterEqual(fetch.count("X-Bundle-Publication-Attempt"), 4)
        self.assertIn("--attempt \"$PUBLICATION_ATTEMPT\"", upload)
        self.assertIn("X-Bundle-Publication-Attempt", self.publication_failure)
        source = PUBLISHER.read_text(encoding="utf-8")
        tree = ast.parse(source)
        imports = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imports.extend(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                imports.append(node.module or "")
        self.assertNotIn("zipfile", imports)
        self.assertFalse(any(name.startswith("PIL") for name in imports))
        self.assertNotIn("Image.open", source)

    def test_publication_has_bounded_success_failure_lifecycle(self):
        source = PUBLISHER.read_text(encoding="utf-8")
        self.assertIn("/finish", source)
        self.assertIn("/confirm", source)
        self.assertIn("always()", self.publication_failure)
        self.assertIn("/review-failed", self.publication_failure)
        self.assertNotIn("actions/checkout", self.publication_failure)
        self.assertNotIn("actions/download-artifact", self.publication_failure)


if __name__ == "__main__":
    unittest.main()
