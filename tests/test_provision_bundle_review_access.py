"""Offline tests for the hosted bundle-review Access provisioner."""

from __future__ import annotations

from contextlib import redirect_stderr, redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "provision_bundle_review_access.py"
CONFIG = ROOT / "ops" / "cloudflare" / "bundle-review-access.json"
RECEIPT = ROOT / "ops" / "cloudflare" / "bundle-review-access-receipt.json"
SPEC = importlib.util.spec_from_file_location("bundle_review_access_provisioner", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
provisioner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(provisioner)


class FakeClient:
    def __init__(self, providers=None, applications=None, policies=None):
        self.providers = list(providers or [])
        self.applications = list(applications or [])
        self.policies = list(policies or [])
        self.calls = []
        self.audience = "A" * 32

    def list_all(self, path):
        self.calls.append(("LIST", path, None))
        if path == "/access/identity_providers":
            return [dict(item) for item in self.providers]
        if path == "/access/apps":
            return [dict(item) for item in self.applications]
        if path.endswith("/policies"):
            return [dict(item) for item in self.policies]
        raise AssertionError(path)

    def request(self, method, path, payload=None, query=None):
        self.calls.append((method, path, payload))
        if method == "GET" and path == "/access/organizations":
            return {"auth_domain": "avianreview.cloudflareaccess.com"}
        if method == "POST" and path == "/access/identity_providers":
            item = {**payload, "id": "otp-id"}
            self.providers.append(item)
            return dict(item)
        if method == "POST" and path == "/access/apps":
            item = {**payload, "id": "app-id", "aud": self.audience}
            self.applications.append(item)
            return dict(item)
        if method == "PUT" and path == "/access/apps/app-id":
            item = {**payload, "id": "app-id", "aud": self.audience}
            self.applications = [item]
            return dict(item)
        if method == "GET" and path == "/access/apps/app-id":
            item = next(item for item in self.applications if item["id"] == "app-id")
            return {**item, "aud": self.audience}
        if method == "POST" and path == "/access/apps/app-id/policies":
            item = {**payload, "id": "policy-id"}
            self.policies.append(item)
            return dict(item)
        if method == "PUT" and path == "/access/apps/app-id/policies/policy-id":
            item = {**payload, "id": "policy-id"}
            self.policies = [item]
            return dict(item)
        raise AssertionError((method, path, payload, query))


class BundleReviewAccessProvisionerTests(unittest.TestCase):
    def setUp(self):
        self.config = provisioner.load_config(CONFIG)

    def _existing_state(self):
        provider = {**provisioner.desired_identity_provider(self.config), "id": "otp-id"}
        application = {
            **provisioner.desired_application(self.config, "otp-id"),
            "id": "app-id",
            "aud": "A" * 32,
        }
        policy = {**provisioner.desired_policy(self.config), "id": "policy-id"}
        return provider, application, policy

    def test_config_pins_exact_identity_routes_session_and_hidden_launcher(self):
        application = self.config["application"]
        self.assertEqual(self.config["reviewer_email"], "twarner491@gmail.com")
        self.assertEqual(tuple(application["destinations"]), provisioner.EXPECTED_DESTINATIONS)
        self.assertEqual(application["session_duration"], "24h")
        self.assertFalse(application["app_launcher_visible"])
        self.assertFalse(application["options_preflight_bypass"])

    def test_live_receipt_pins_verified_non_secret_access_identifiers(self):
        receipt = json.loads(RECEIPT.read_text(encoding="utf-8"))
        self.assertEqual(
            set(receipt),
            {
                "schema_version",
                "account_id",
                "team_domain",
                "reviewer_email",
                "application",
                "policy",
                "signed_out_challenge",
            },
        )
        self.assertEqual(receipt["schema_version"], 1)
        self.assertEqual(
            receipt["account_id"], "557e541291a977fc1683c53376eb56a0"
        )
        self.assertRegex(receipt["account_id"], provisioner.ACCOUNT_ID)
        self.assertEqual(receipt["team_domain"], "twarner.cloudflareaccess.com")
        self.assertRegex(receipt["team_domain"], provisioner.TEAM_DOMAIN)
        self.assertEqual(receipt["reviewer_email"], self.config["reviewer_email"])
        self.assertEqual(
            receipt["application"],
            {
                "id": "d44da5de-5e1c-4e38-9021-d4f5eccab1f9",
                "aud": "9f674c29c33e83ef8ca758ae10d611c944c09d3669734ed517df5b29e4d2ecc5",
            },
        )
        self.assertRegex(receipt["application"]["id"], provisioner.SAFE_RESOURCE_ID)
        self.assertRegex(receipt["application"]["aud"], provisioner.AUDIENCE)
        self.assertEqual(
            receipt["policy"],
            {"id": "3a50bb48-b7ae-4584-a084-81b7bfd678a2"},
        )
        self.assertRegex(receipt["policy"]["id"], provisioner.SAFE_RESOURCE_ID)
        challenge = receipt["signed_out_challenge"]
        self.assertEqual(challenge["status"], 302)
        self.assertEqual(
            tuple(challenge["verified_destinations"]),
            tuple(self.config["application"]["destinations"]),
        )
        serialized = json.dumps(receipt).lower()
        for forbidden in ("api_token", "authorization", "cookie", "secret"):
            self.assertNotIn(forbidden, serialized)

    def test_team_domain_mismatch_fails_before_any_mutation(self):
        client = FakeClient()
        with self.assertRaisesRegex(provisioner.ProvisionError, "does not match"):
            provisioner.reconcile(
                client, self.config, "wrong-team.cloudflareaccess.com"
            )
        self.assertEqual(
            [call for call in client.calls if call[0] in {"POST", "PUT"}], []
        )

    def test_default_dry_run_cannot_construct_or_call_network_client(self):
        output = io.StringIO()
        with mock.patch.object(
            provisioner.CloudflareClient,
            "__init__",
            side_effect=AssertionError("network client constructed"),
        ), redirect_stdout(output):
            status = provisioner.main([], environment={
                "CLOUDFLARE_API_TOKEN": "this-must-not-be-read-or-used"
            })
        self.assertEqual(status, 0)
        self.assertIn('"network_calls": false', output.getvalue())
        self.assertNotIn("this-must-not-be-read-or-used", output.getvalue())

    def test_apply_requires_literal_gate_before_credentials_or_client(self):
        error = io.StringIO()
        with mock.patch.object(
            provisioner,
            "_apply_credentials",
            side_effect=AssertionError("credentials read"),
        ), redirect_stderr(error):
            status = provisioner.main(["--apply"], environment={})
        self.assertEqual(status, 2)
        self.assertIn("literal --confirm APPLY", error.getvalue())

    def test_apply_requires_token_before_constructing_client(self):
        error = io.StringIO()
        environment = {
            "CLOUDFLARE_ACCOUNT_ID": "a" * 32,
            "CLOUDFLARE_TEAM_DOMAIN": "avianreview.cloudflareaccess.com",
        }
        with mock.patch.object(
            provisioner.CloudflareClient,
            "__init__",
            side_effect=AssertionError("client constructed"),
        ), redirect_stderr(error):
            status = provisioner.main(
                ["--apply", "--confirm", "APPLY"], environment=environment
            )
        self.assertEqual(status, 2)
        self.assertIn("API_TOKEN is missing or invalid", error.getvalue())

    def test_main_redacts_valid_token_if_a_failure_echoes_it(self):
        token = "secret-token-that-must-not-escape"
        environment = {
            "CLOUDFLARE_ACCOUNT_ID": "a" * 32,
            "CLOUDFLARE_TEAM_DOMAIN": "avianreview.cloudflareaccess.com",
            "CLOUDFLARE_API_TOKEN": token,
        }
        error = io.StringIO()
        with mock.patch.object(
            provisioner,
            "reconcile",
            side_effect=provisioner.ProvisionError(f"echoed {token}"),
        ), redirect_stderr(error):
            status = provisioner.main(
                ["--apply", "--confirm", "APPLY"], environment=environment
            )
        self.assertEqual(status, 2)
        self.assertNotIn(token, error.getvalue())
        self.assertIn("[REDACTED]", error.getvalue())

    def test_invalid_config_fails_closed(self):
        text = CONFIG.read_text(encoding="utf-8").replace(
            "twarner491@gmail.com", "anyone@example.com"
        )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            path.write_text(text, encoding="utf-8")
            with self.assertRaisesRegex(provisioner.ProvisionError, "fixed reviewer"):
                provisioner.load_config(path)

    def test_first_apply_creates_deny_first_app_then_exact_policy(self):
        client = FakeClient()
        result = provisioner.reconcile(
            client, self.config, "avianreview.cloudflareaccess.com"
        )
        mutations = [call[:2] for call in client.calls if call[0] in {"POST", "PUT"}]
        self.assertEqual(
            mutations,
            [
                ("POST", "/access/identity_providers"),
                ("POST", "/access/apps"),
                ("POST", "/access/apps/app-id/policies"),
            ],
        )
        self.assertTrue(result["verified"])
        self.assertEqual(
            result["environment_checklist"]["BUNDLE_REVIEWER_EMAIL"],
            "twarner491@gmail.com",
        )

    def test_second_apply_is_idempotent(self):
        provider, application, policy = self._existing_state()
        client = FakeClient([provider], [application], [policy])
        result = provisioner.reconcile(
            client, self.config, "avianreview.cloudflareaccess.com"
        )
        mutations = [call for call in client.calls if call[0] in {"POST", "PUT"}]
        self.assertEqual(mutations, [])
        self.assertIn("application:unchanged", result["actions"])
        self.assertIn("policy:unchanged", result["actions"])

    def test_application_drift_is_repaired_after_policy_is_tightened(self):
        provider, application, policy = self._existing_state()
        application["session_duration"] = "12h"
        policy["decision"] = "bypass"
        client = FakeClient([provider], [application], [policy])
        provisioner.reconcile(
            client, self.config, "avianreview.cloudflareaccess.com"
        )
        mutations = [call[:2] for call in client.calls if call[0] == "PUT"]
        self.assertEqual(
            mutations,
            [
                ("PUT", "/access/apps/app-id/policies/policy-id"),
                ("PUT", "/access/apps/app-id"),
            ],
        )

    def test_additional_policy_refuses_all_mutation(self):
        provider, application, policy = self._existing_state()
        extra = {
            "id": "bypass-policy",
            "name": "Unsafe bypass",
            "decision": "bypass",
        }
        client = FakeClient([provider], [application], [policy, extra])
        with self.assertRaisesRegex(provisioner.ProvisionError, "additional"):
            provisioner.reconcile(
                client, self.config, "avianreview.cloudflareaccess.com"
            )
        self.assertEqual(
            [call for call in client.calls if call[0] in {"POST", "PUT"}], []
        )

    def test_policy_conflict_is_preflighted_before_creating_otp(self):
        _, application, policy = self._existing_state()
        extra = {
            "id": "bypass-policy",
            "name": "Unsafe bypass",
            "decision": "bypass",
        }
        client = FakeClient([], [application], [policy, extra])
        with self.assertRaisesRegex(provisioner.ProvisionError, "additional"):
            provisioner.reconcile(
                client, self.config, "avianreview.cloudflareaccess.com"
            )
        self.assertEqual(
            [call for call in client.calls if call[0] in {"POST", "PUT"}], []
        )

    def test_overlapping_application_refuses_all_mutation(self):
        _, _, _ = self._existing_state()
        overlap = {
            "id": "other-app",
            "name": "Broad bundles app",
            "type": "self_hosted",
            "domain": "avianvisitors.com/bundles",
        }
        client = FakeClient([], [overlap], [])
        with self.assertRaisesRegex(provisioner.ProvisionError, "overlaps"):
            provisioner.reconcile(
                client, self.config, "avianreview.cloudflareaccess.com"
            )
        self.assertEqual(
            [call for call in client.calls if call[0] in {"POST", "PUT"}], []
        )

    def test_redaction_removes_token_from_transport_detail(self):
        token = "secret-token-that-must-not-escape"
        detail = provisioner._redact(
            f"Authorization: Bearer {token}; bearer {token}", (token,)
        )
        self.assertNotIn(token, detail)
        self.assertIn("[REDACTED]", detail)


if __name__ == "__main__":
    unittest.main()
