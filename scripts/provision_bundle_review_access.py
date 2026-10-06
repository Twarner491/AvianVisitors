#!/usr/bin/env python3
"""Plan or reconcile the hosted bundle-review Cloudflare Access boundary.

Dry-run is the default and performs no network I/O. Applying requires both the
literal ``--confirm APPLY`` gate and a scoped Cloudflare API token in the
environment. The script never deploys application code or writes secrets.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import sys
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = ROOT / "ops" / "cloudflare" / "bundle-review-access.json"
API_ORIGIN = "https://api.cloudflare.com/client/v4"
EXPECTED_REVIEWER = "twarner491@gmail.com"
EXPECTED_DOMAIN = "avianvisitors.com/bundles/review"
EXPECTED_DESTINATIONS = (
    "avianvisitors.com/bundles/review",
    "avianvisitors.com/bundles/review/*",
    "avianvisitors.com/api/bundles/review",
    "avianvisitors.com/api/bundles/review/*",
)
MAX_CONFIG_BYTES = 64 * 1024
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_PAGES = 100
SAFE_RESOURCE_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
ACCOUNT_ID = re.compile(r"^[a-f0-9]{32}$")
TEAM_DOMAIN = re.compile(
    r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$"
)
AUDIENCE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class ProvisionError(RuntimeError):
    """A bounded, user-safe provisioning failure."""


def _exact_keys(value: dict[str, Any], expected: set[str], where: str) -> None:
    actual = set(value)
    if actual != expected:
        missing = sorted(expected - actual)
        extra = sorted(actual - expected)
        raise ProvisionError(
            f"invalid {where} keys (missing={missing!r}, extra={extra!r})"
        )


def load_config(path: Path) -> dict[str, Any]:
    try:
        raw = path.read_bytes()
    except OSError as error:
        raise ProvisionError(f"cannot read configuration: {error.strerror}") from None
    if not raw or len(raw) > MAX_CONFIG_BYTES:
        raise ProvisionError("configuration size is invalid")
    try:
        config = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ProvisionError("configuration must be valid UTF-8 JSON") from None
    if not isinstance(config, dict):
        raise ProvisionError("configuration root must be an object")

    _exact_keys(
        config,
        {
            "schema_version",
            "reviewer_email",
            "identity_provider",
            "application",
            "policy",
        },
        "configuration",
    )
    if config["schema_version"] != 1:
        raise ProvisionError("unsupported configuration schema")
    if config["reviewer_email"] != EXPECTED_REVIEWER:
        raise ProvisionError("reviewer_email must be the fixed reviewer identity")

    identity_provider = config["identity_provider"]
    if not isinstance(identity_provider, dict):
        raise ProvisionError("identity_provider must be an object")
    _exact_keys(identity_provider, {"name", "type"}, "identity_provider")
    if identity_provider["type"] != "onetimepin":
        raise ProvisionError("identity provider must use one-time PIN")
    _short_name(identity_provider["name"], "identity provider name")

    application = config["application"]
    if not isinstance(application, dict):
        raise ProvisionError("application must be an object")
    _exact_keys(
        application,
        {
            "name",
            "type",
            "domain",
            "destinations",
            "session_duration",
            "app_launcher_visible",
            "auto_redirect_to_identity",
            "allow_authenticate_via_warp",
            "allow_iframe",
            "options_preflight_bypass",
        },
        "application",
    )
    _short_name(application["name"], "application name")
    expected_values = {
        "type": "self_hosted",
        "domain": EXPECTED_DOMAIN,
        "session_duration": "24h",
        "app_launcher_visible": False,
        "auto_redirect_to_identity": True,
        "allow_authenticate_via_warp": False,
        "allow_iframe": False,
        "options_preflight_bypass": False,
    }
    for key, expected in expected_values.items():
        if application[key] != expected:
            raise ProvisionError(f"application.{key} must be {expected!r}")
    destinations = application["destinations"]
    if not isinstance(destinations, list) or tuple(destinations) != EXPECTED_DESTINATIONS:
        raise ProvisionError("application destinations must be the fixed review routes")
    for destination in destinations:
        _parse_scope(destination)

    policy = config["policy"]
    if not isinstance(policy, dict):
        raise ProvisionError("policy must be an object")
    _exact_keys(policy, {"name", "decision", "precedence"}, "policy")
    _short_name(policy["name"], "policy name")
    if policy["decision"] != "allow" or policy["precedence"] != 1:
        raise ProvisionError("policy must be the precedence-one Allow policy")
    return config


def _short_name(value: Any, where: str) -> str:
    if (
        not isinstance(value, str)
        or not value.strip()
        or len(value) > 120
        or any(ord(character) < 32 for character in value)
    ):
        raise ProvisionError(f"invalid {where}")
    return value


def _parse_scope(value: Any) -> tuple[str, str]:
    if not isinstance(value, str) or not value or len(value) > 512:
        raise ProvisionError("invalid Access destination")
    if "://" in value or "?" in value or "#" in value or "@" in value:
        raise ProvisionError("Access destinations must be bare public host paths")
    parsed = urlsplit("//" + value)
    host = (parsed.hostname or "").lower()
    if not host or parsed.port is not None:
        raise ProvisionError("invalid Access destination host")
    path = parsed.path or "/"
    if not path.startswith("/") or "//" in path or ".." in path.split("/"):
        raise ProvisionError("invalid Access destination path")
    if "*" in path and not path.endswith("/*"):
        raise ProvisionError("only a trailing path wildcard is supported")
    return host, path


def desired_identity_provider(config: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": config["identity_provider"]["name"],
        "type": "onetimepin",
        "config": {},
    }


def desired_application(config: dict[str, Any], identity_provider_id: str) -> dict[str, Any]:
    application = config["application"]
    return {
        "name": application["name"],
        "type": "self_hosted",
        "domain": application["domain"],
        "destinations": [
            {"type": "public", "uri": uri}
            for uri in application["destinations"]
        ],
        "session_duration": "24h",
        "app_launcher_visible": False,
        "auto_redirect_to_identity": True,
        "allowed_idps": [identity_provider_id],
        "allow_authenticate_via_warp": False,
        "allow_iframe": False,
        "options_preflight_bypass": False,
    }


def desired_policy(config: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": config["policy"]["name"],
        "decision": "allow",
        "precedence": 1,
        "include": [{"email": {"email": EXPECTED_REVIEWER}}],
        "exclude": [],
        "require": [],
    }


def environment_checklist(team_domain: str, audience: str) -> dict[str, str]:
    return {
        "BUNDLE_REVIEWER_EMAIL": EXPECTED_REVIEWER,
        "BUNDLE_REVIEW_ACCESS_TEAM_DOMAIN": team_domain,
        "BUNDLE_REVIEW_ACCESS_AUD": audience,
    }


def _verified_team_domain(client: CloudflareClient, expected: str) -> None:
    if TEAM_DOMAIN.fullmatch(expected) is None:
        raise ProvisionError("invalid Cloudflare Access team domain")
    organization = client.request("GET", "/access/organizations")
    actual = organization.get("auth_domain") if isinstance(organization, dict) else None
    if not isinstance(actual, str) or actual.strip().lower() != expected:
        raise ProvisionError(
            "CLOUDFLARE_TEAM_DOMAIN does not match the account Access organization"
        )


def dry_run_document(config: dict[str, Any]) -> dict[str, Any]:
    return {
        "mode": "dry-run",
        "network_calls": False,
        "deploys": False,
        "secrets_written": False,
        "operations": [
            {
                "action": "ensure",
                "resource": "Access one-time PIN identity provider",
                "desired": desired_identity_provider(config),
            },
            {
                "action": "ensure",
                "resource": "Access self-hosted application",
                "desired": desired_application(config, "<existing-or-created-otp-id>"),
            },
            {
                "action": "ensure-exclusive",
                "resource": "Access application policy",
                "desired": desired_policy(config),
            },
        ],
        "environment_checklist": environment_checklist(
            "<team-name>.cloudflareaccess.com",
            "<application-aud-after-apply>",
        ),
        "apply_gate": "--apply --confirm APPLY plus three environment variables",
    }


def _redact(text: Any, secrets: tuple[str, ...]) -> str:
    output = str(text)
    for secret in sorted((item for item in secrets if item), key=len, reverse=True):
        output = output.replace(secret, "[REDACTED]")
    output = re.sub(
        r"(?i)(authorization\s*[:=]\s*bearer\s+)[^\s,;]+",
        r"\1[REDACTED]",
        output,
    )
    output = re.sub(r"(?i)(bearer\s+)[A-Za-z0-9._~-]+", r"\1[REDACTED]", output)
    return output[:1000]


class CloudflareClient:
    """Small Cloudflare v4 client with fixed origin and bounded responses."""

    def __init__(self, account_id: str, token: str) -> None:
        self._account_id = account_id
        self._token = token

    def request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        query: dict[str, Any] | None = None,
    ) -> Any:
        if method not in {"GET", "POST", "PUT"} or not path.startswith("/access/"):
            raise ProvisionError("refused unexpected Cloudflare API request")
        suffix = path
        if query:
            suffix += "?" + urlencode(query)
        url = f"{API_ORIGIN}/accounts/{self._account_id}{suffix}"
        data = None
        if payload is not None:
            data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        request = Request(
            url,
            data=data,
            method=method,
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self._token}",
                "User-Agent": "avian-visitors-access-provisioner/1",
            },
        )
        try:
            with urlopen(request, timeout=20) as response:
                raw = response.read(MAX_RESPONSE_BYTES + 1)
        except HTTPError as error:
            raw = error.read(64 * 1024)
            detail = _cloudflare_error_detail(raw, (self._token,))
            raise ProvisionError(f"Cloudflare API HTTP {error.code}: {detail}") from None
        except (URLError, TimeoutError, OSError) as error:
            raise ProvisionError(
                "Cloudflare API transport failed: "
                + _redact(getattr(error, "reason", error), (self._token,))
            ) from None
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ProvisionError("Cloudflare API response exceeded the safety limit")
        try:
            envelope = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ProvisionError("Cloudflare API returned invalid JSON") from None
        if not isinstance(envelope, dict) or envelope.get("success") is not True:
            detail = _cloudflare_error_detail(raw, (self._token,))
            raise ProvisionError(f"Cloudflare API rejected the request: {detail}")
        return envelope.get("result")

    def list_all(self, path: str) -> list[dict[str, Any]]:
        output: list[dict[str, Any]] = []
        for page in range(1, MAX_PAGES + 1):
            result = self.request(
                "GET", path, query={"page": page, "per_page": 100}
            )
            if not isinstance(result, list) or any(
                not isinstance(item, dict) for item in result
            ):
                raise ProvisionError("Cloudflare API returned an invalid collection")
            output.extend(result)
            if len(result) < 100:
                return output
        raise ProvisionError("Cloudflare API pagination exceeded the safety limit")


def _cloudflare_error_detail(raw: bytes, secrets: tuple[str, ...]) -> str:
    try:
        envelope = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return "redacted non-JSON error"
    errors = envelope.get("errors", []) if isinstance(envelope, dict) else []
    messages = []
    if isinstance(errors, list):
        for item in errors[:5]:
            if not isinstance(item, dict):
                continue
            code = item.get("code")
            message = item.get("message")
            if isinstance(message, str):
                messages.append(f"{code}: {_redact(message, secrets)}")
    return "; ".join(messages)[:1000] or "unspecified error"


def _resource_id(item: dict[str, Any], where: str) -> str:
    value = item.get("id")
    if not isinstance(value, str) or SAFE_RESOURCE_ID.fullmatch(value) is None:
        raise ProvisionError(f"Cloudflare returned an invalid {where} id")
    return value


def _resource_path(identifier: str) -> str:
    if SAFE_RESOURCE_ID.fullmatch(identifier) is None:
        raise ProvisionError("refused unsafe Cloudflare resource id")
    return quote(identifier, safe="")


def _public_destinations(application: dict[str, Any]) -> tuple[str, ...]:
    destinations = application.get("destinations")
    output = []
    if isinstance(destinations, list):
        for item in destinations:
            if (
                isinstance(item, dict)
                and item.get("type", "public") == "public"
                and isinstance(item.get("uri"), str)
            ):
                output.append(item["uri"])
    if not output and isinstance(application.get("domain"), str):
        output.append(application["domain"])
    return tuple(output)


def _scope_base(value: str) -> tuple[str, str]:
    host, path = _parse_scope(value)
    if path.endswith("/*"):
        path = path[:-2] or "/"
    return host, path.rstrip("/") or "/"


def _paths_intersect(left: str, right: str) -> bool:
    if left == "/" or right == "/":
        return True
    return (
        left == right
        or left.startswith(right + "/")
        or right.startswith(left + "/")
    )


def applications_overlap(
    left: dict[str, Any], right: dict[str, Any]
) -> bool:
    for left_scope in _public_destinations(left):
        try:
            left_host, left_path = _scope_base(left_scope)
        except ProvisionError:
            raise ProvisionError("existing Access application has an unsafe destination")
        for right_scope in _public_destinations(right):
            right_host, right_path = _scope_base(right_scope)
            if left_host == right_host and _paths_intersect(left_path, right_path):
                return True
    return False


def _application_matches(current: dict[str, Any], desired: dict[str, Any]) -> bool:
    scalar_keys = (
        "name",
        "type",
        "domain",
        "session_duration",
        "app_launcher_visible",
        "auto_redirect_to_identity",
        "allow_authenticate_via_warp",
        "allow_iframe",
        "options_preflight_bypass",
    )
    if any(current.get(key) != desired[key] for key in scalar_keys):
        return False
    current_destinations = sorted(_public_destinations(current))
    desired_destinations = sorted(_public_destinations(desired))
    current_idps = current.get("allowed_idps")
    return (
        current_destinations == desired_destinations
        and isinstance(current_idps, list)
        and sorted(current_idps) == sorted(desired["allowed_idps"])
    )


def _policy_matches(current: dict[str, Any], desired: dict[str, Any]) -> bool:
    return all(current.get(key) == value for key, value in desired.items())


def _select_otp(
    client: CloudflareClient, config: dict[str, Any], actions: list[str]
) -> dict[str, Any]:
    providers = client.list_all("/access/identity_providers")
    name = config["identity_provider"]["name"]
    named = [provider for provider in providers if provider.get("name") == name]
    if len(named) > 1:
        raise ProvisionError("multiple identity providers use the configured name")
    if named:
        if named[0].get("type") != "onetimepin":
            raise ProvisionError("configured identity provider name has the wrong type")
        actions.append("identity-provider:unchanged")
        return named[0]
    otp = [provider for provider in providers if provider.get("type") == "onetimepin"]
    if len(otp) > 1:
        raise ProvisionError("multiple one-time PIN providers make selection ambiguous")
    if otp:
        actions.append("identity-provider:reused-existing-otp")
        return otp[0]
    created = client.request(
        "POST", "/access/identity_providers", desired_identity_provider(config)
    )
    if not isinstance(created, dict):
        raise ProvisionError("Cloudflare returned an invalid identity provider")
    actions.append("identity-provider:created")
    return created


def _exclusive_policy(
    client: CloudflareClient,
    config: dict[str, Any],
    application_id: str,
    actions: list[str],
    policies: list[dict[str, Any]] | None = None,
) -> None:
    base = f"/access/apps/{_resource_path(application_id)}/policies"
    if policies is None:
        policies = client.list_all(base)
    name = config["policy"]["name"]
    named = [policy for policy in policies if policy.get("name") == name]
    if len(named) > 1 or len(policies) != len(named):
        raise ProvisionError(
            "review application has additional or duplicate policies; refusing to mutate"
        )
    desired = desired_policy(config)
    if not named:
        created = client.request("POST", base, desired)
        if not isinstance(created, dict):
            raise ProvisionError("Cloudflare returned an invalid Access policy")
        actions.append("policy:created")
        return
    if _policy_matches(named[0], desired):
        actions.append("policy:unchanged")
        return
    policy_id = _resource_id(named[0], "policy")
    updated = client.request(
        "PUT", f"{base}/{_resource_path(policy_id)}", desired
    )
    if not isinstance(updated, dict):
        raise ProvisionError("Cloudflare returned an invalid Access policy")
    actions.append("policy:updated")


def reconcile(
    client: CloudflareClient,
    config: dict[str, Any],
    team_domain: str,
) -> dict[str, Any]:
    actions: list[str] = []
    _verified_team_domain(client, team_domain)
    actions.append("access-organization:verified")
    applications = client.list_all("/access/apps")
    name = config["application"]["name"]
    named = [application for application in applications if application.get("name") == name]
    if len(named) > 1:
        raise ProvisionError("multiple Access applications use the configured name")
    overlap_shape = desired_application(config, "<pending-identity-provider>")
    for application in applications:
        if application in named:
            continue
        if applications_overlap(application, overlap_shape):
            raise ProvisionError(
                "another Access application overlaps a protected review route"
            )

    existing_policies = None
    if named:
        current = named[0]
        if current.get("type") != "self_hosted":
            raise ProvisionError("configured application name has the wrong type")
        application_id = _resource_id(current, "application")
        policy_base = f"/access/apps/{_resource_path(application_id)}/policies"
        existing_policies = client.list_all(policy_base)
        policy_name = config["policy"]["name"]
        named_policies = [
            policy for policy in existing_policies
            if policy.get("name") == policy_name
        ]
        if len(named_policies) > 1 or len(existing_policies) != len(named_policies):
            raise ProvisionError(
                "review application has additional or duplicate policies; "
                "refusing to mutate"
            )

    # Only create or reuse identity resources after the complete application
    # and policy inventory has passed conflict checks.
    provider = _select_otp(client, config, actions)
    provider_id = _resource_id(provider, "identity provider")
    desired_app = desired_application(config, provider_id)

    if named:
        # Tighten or create the exact-email policy before changing route scope.
        _exclusive_policy(
            client,
            config,
            application_id,
            actions,
            existing_policies,
        )
        if _application_matches(current, desired_app):
            actions.append("application:unchanged")
        else:
            updated = client.request(
                "PUT",
                f"/access/apps/{_resource_path(application_id)}",
                desired_app,
            )
            if not isinstance(updated, dict):
                raise ProvisionError("Cloudflare returned an invalid Access application")
            actions.append("application:updated")
    else:
        created = client.request("POST", "/access/apps", desired_app)
        if not isinstance(created, dict):
            raise ProvisionError("Cloudflare returned an invalid Access application")
        application_id = _resource_id(created, "application")
        actions.append("application:created-deny-by-default")
        _exclusive_policy(client, config, application_id, actions)

    verified = client.request(
        "GET", f"/access/apps/{_resource_path(application_id)}"
    )
    if not isinstance(verified, dict) or not _application_matches(verified, desired_app):
        raise ProvisionError("post-apply Access application verification failed")
    policies = client.list_all(
        f"/access/apps/{_resource_path(application_id)}/policies"
    )
    desired_access_policy = desired_policy(config)
    if len(policies) != 1 or not _policy_matches(policies[0], desired_access_policy):
        raise ProvisionError("post-apply Access policy verification failed")
    audience = verified.get("aud")
    if not isinstance(audience, str) or AUDIENCE.fullmatch(audience) is None:
        raise ProvisionError("Cloudflare returned an invalid application audience tag")
    return {
        "mode": "apply",
        "verified": True,
        "deploys": False,
        "secrets_written": False,
        "actions": actions,
        "protected_destinations": list(EXPECTED_DESTINATIONS),
        "session_duration": "24h",
        "app_launcher_visible": False,
        "environment_checklist": environment_checklist(team_domain, audience),
    }


def _apply_credentials(environment: dict[str, str]) -> tuple[str, str, str]:
    account_id = environment.get("CLOUDFLARE_ACCOUNT_ID", "").strip().lower()
    team_domain = environment.get("CLOUDFLARE_TEAM_DOMAIN", "").strip().lower()
    token = environment.get("CLOUDFLARE_API_TOKEN", "")
    if ACCOUNT_ID.fullmatch(account_id) is None:
        raise ProvisionError("CLOUDFLARE_ACCOUNT_ID must be a 32-character hex id")
    if TEAM_DOMAIN.fullmatch(team_domain) is None:
        raise ProvisionError(
            "CLOUDFLARE_TEAM_DOMAIN must be a bare *.cloudflareaccess.com hostname"
        )
    if (
        len(token) < 20
        or len(token) > 2048
        or token != token.strip()
        or any(ord(character) < 33 or ord(character) > 126 for character in token)
        or token.lower() in {"token", "changeme", "placeholder"}
    ):
        raise ProvisionError("CLOUDFLARE_API_TOKEN is missing or invalid")
    return account_id, team_domain, token


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config",
        type=Path,
        default=DEFAULT_CONFIG,
        help="desired-state JSON (default: repository-pinned config)",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="perform Cloudflare API reconciliation (default is offline dry-run)",
    )
    parser.add_argument(
        "--confirm",
        default="",
        metavar="WORD",
        help="must be the literal APPLY when --apply is used",
    )
    return parser


def main(argv: list[str] | None = None, environment: dict[str, str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    known_secrets: tuple[str, ...] = ()
    try:
        config = load_config(args.config)
        if not args.apply:
            if args.confirm:
                raise ProvisionError("--confirm is only valid with --apply")
            print(json.dumps(dry_run_document(config), indent=2, sort_keys=True))
            return 0
        if args.confirm != "APPLY":
            raise ProvisionError("apply refused: pass the literal --confirm APPLY gate")
        values = dict(os.environ if environment is None else environment)
        account_id, team_domain, token = _apply_credentials(values)
        known_secrets = (token,)
        result = reconcile(CloudflareClient(account_id, token), config, team_domain)
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    except ProvisionError as error:
        # Do not include environment values or request objects in diagnostics.
        print(f"error: {_redact(error, known_secrets)}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
