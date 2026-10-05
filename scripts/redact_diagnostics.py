#!/usr/bin/env python3
"""Redact station credentials from diagnostic text without sourcing config."""

import argparse
import posixpath
import re
import sys


REDACTED = "[REDACTED]"
SECRET_KEYS = (
    "BIRDWEATHER_ID",
    "CADDY_PWD",
    "ICE_PWD",
    "GEMINI_API_KEY",
    "GEMINI_KEY",
    "EBIRD_API_KEY",
    "EBIRD_KEY",
    "FLICKR_API_KEY",
    "HEARTBEAT_URL",
    "RTSP_STREAM",
    "DB_PWD",
    "WMI_PASSWORD",
    "AVIAN_DISK_REFRESH_TOKEN",
    "HTTP_AUTHORIZATION",
    "REDIRECT_HTTP_AUTHORIZATION",
    "AUTHORIZATION",
)
_KEYS = "|".join(re.escape(key) for key in sorted(SECRET_KEYS, key=len, reverse=True))
_CONFIG_ASSIGNMENT = re.compile(
    rf"^(?P<prefix>\s*(?:export\s+)?(?P<key>{_KEYS})\s*=)"
)
_COMMENTED_CONFIG_ASSIGNMENT = re.compile(
    rf"^(?P<prefix>\s*#\s*(?:export\s+)?(?P<key>{_KEYS})\s*=)"
)
_JOURNAL_ASSIGNMENT = re.compile(
    rf"(?<![A-Za-z0-9_])(?P<prefix>(?P<key>{_KEYS})\s*=)"
)
_BIRDWEATHER_PATH = re.compile(
    r"(?P<prefix>/api/v1/stations/)[^/?#\s'\"]+"
)
_URL_USERINFO = re.compile(
    r"(?P<prefix>\b(?:https?|rtsp|rtsps|icecast)://)[^/@\s]+@",
    re.IGNORECASE,
)

_UNQUOTED_SECRET_VALUE = re.compile(
    r"([^\s#'\"`$\\(){};|&<>]*)(?:\s+#.*)?"
)


def _parse_secret_value(raw):
    """Parse only a deliberately small, non-evaluating shell subset."""
    raw = raw.strip()
    if not raw:
        return ""
    quote = raw[0] if raw[0] in "'\"" else ""
    if quote:
        end = raw.find(quote, 1)
        if end < 0 or re.fullmatch(r"\s*(?:#.*)?", raw[end + 1 :]) is None:
            return None
        value = raw[1:end]
        if quote == '"' and any(character in value for character in ("$", "`", "\\")):
            return None
        return value
    match = _UNQUOTED_SECRET_VALUE.fullmatch(raw)
    return match.group(1) if match else None


def _secret_assignment_is_single_line(text, match):
    """Return false when a secret value could continue on another line."""
    line = text.rstrip("\r\n")
    outer_quote = text[match.start() - 1] if match.start() > 0 else ""
    if outer_quote and outer_quote in "'\"":
        value = line[match.end() :]
        if "\\" in value:
            return False
        return outer_quote in value
    return _parse_secret_value(line[match.end() :]) is not None


def _redact_rhs(text, match):
    # A known secret assignment is not a shell grammar we should partially
    # interpret. Shell values can concatenate quoting styles, escape spaces,
    # contain substitutions, or be malformed. Redact the entire remainder of
    # the diagnostic line so an unparsed suffix can never expose credential
    # bytes. Preserve only the line ending and an outer quote used by common
    # systemd Environment="KEY=value" diagnostics.
    line_ending = ""
    if text.endswith("\r\n"):
        line_ending = "\r\n"
    elif text.endswith(("\r", "\n")):
        line_ending = text[-1]
    outer_quote = text[match.start() - 1] if match.start() > 0 else ""
    closing_quote = outer_quote if outer_quote and outer_quote in "'\"" else ""
    replacement = text[: match.end()] + REDACTED + closing_quote + line_ending
    return replacement, len(replacement)


def _redact_assignments(text, pattern):
    offset = 0
    while True:
        match = pattern.search(text, offset)
        if match is None:
            return text
        updated, offset = _redact_rhs(text, match)
        if updated == text:
            offset = max(offset, match.end() + 1)
        text = updated


def redact_config(text):
    output = []
    for line in text.splitlines(keepends=True):
        match = _CONFIG_ASSIGNMENT.search(line)
        if match is None:
            match = _COMMENTED_CONFIG_ASSIGNMENT.search(line)
        if match is None and _JOURNAL_ASSIGNMENT.search(line) is not None:
            raise ValueError("ambiguous secret assignment")
        if match is not None and not _secret_assignment_is_single_line(line, match):
            raise ValueError("ambiguous secret assignment")
        line = _redact_assignments(line, _CONFIG_ASSIGNMENT)
        line = _redact_assignments(line, _COMMENTED_CONFIG_ASSIGNMENT)
        output.append(line)
    return "".join(output)


def _parse_path_value(raw):
    """Parse a shell assignment value without evaluating shell syntax."""
    raw = raw.strip()
    if not raw:
        return None, ""
    quote = raw[0] if raw[0] in "'\"" else ""
    if quote:
        value = []
        escaped = False
        for index in range(1, len(raw)):
            character = raw[index]
            if quote == '"' and escaped:
                # Shell double quotes have several context-sensitive escape
                # rules. Refuse the ambiguity instead of approximating them.
                return None, quote
            if quote == '"' and character == "\\":
                escaped = True
                continue
            if character == quote:
                if re.fullmatch(r"\s*(?:#.*)?", raw[index + 1 :]) is None:
                    return None, quote
                return "".join(value), quote
            value.append(character)
        return None, quote
    match = re.fullmatch(r"([^\s#]*)(?:\s+#.*)?", raw)
    return (match.group(1), "") if match else (None, "")


def load_config_path(config_text, key, home):
    assignment = re.compile(
        rf"^\s*(?:export\s+)?{re.escape(key)}\s*=\s*(?P<value>.*)$"
    )
    configured = None
    quote = ""
    for line in config_text.splitlines():
        match = assignment.match(line)
        if match is None:
            continue
        value, value_quote = _parse_path_value(match.group("value"))
        if value is None:
            raise ValueError(f"invalid {key} assignment")
        configured = value
        quote = value_quote
    if configured is None or not configured:
        raise ValueError(f"missing {key} assignment")
    if len(configured) > 4096 or any(ord(character) < 32 for character in configured):
        raise ValueError(f"invalid {key} path")

    # A normal generated BirdNET-Pi config uses $HOME/BirdSongs. Expand only
    # that exact leading variable, and only where shell assignment semantics
    # would expand it. No other variable, command, tilde, or glob expansion is
    # performed.
    if quote != "'":
        for prefix in ("${HOME}", "$HOME"):
            if configured == prefix or configured.startswith(prefix + "/"):
                configured = home + configured[len(prefix) :]
                break
    if any(character in configured for character in ("$", "`", "\x00")):
        raise ValueError(f"unsupported expansion in {key}")
    if configured.startswith("~") or not configured.startswith("/"):
        raise ValueError(f"{key} must be an absolute path")
    if ".." in configured.split("/"):
        raise ValueError(f"{key} cannot contain a parent traversal")
    normalized = posixpath.normpath(configured)
    if len(normalized) > 4096:
        raise ValueError(f"invalid {key} path")
    if normalized == "/":
        raise ValueError(f"{key} cannot be the filesystem root")
    return normalized


def load_secret_values(config_text):
    values = set()
    assignment = re.compile(
        rf"^\s*(?:export\s+)?(?P<key>{_KEYS})\s*=\s*(?P<value>.*)$"
    )
    for line in config_text.splitlines():
        match = assignment.match(line)
        if match is None:
            if not line.lstrip().startswith("#") and _JOURNAL_ASSIGNMENT.search(line):
                raise ValueError("ambiguous secret assignment")
            continue
        value = _parse_secret_value(match.group("value"))
        if value is None:
            raise ValueError("ambiguous secret assignment")
        # Short values are too likely to be ordinary words elsewhere. Their
        # assignment and URL credential contexts are still redacted below.
        if value is not None and len(value) >= 12:
            values.add(value)
    return sorted(values, key=len, reverse=True)


def redact_journal(text, secret_values=()):
    for value in secret_values:
        text = text.replace(value, REDACTED)
    text = _BIRDWEATHER_PATH.sub(r"\g<prefix>" + REDACTED, text)
    text = _URL_USERINFO.sub(r"\g<prefix>" + REDACTED + "@", text)
    output = []
    for line in text.splitlines(keepends=True):
        match = _JOURNAL_ASSIGNMENT.search(line)
        if match is not None and not _secret_assignment_is_single_line(line, match):
            raise ValueError("ambiguous secret assignment")
        output.append(_redact_assignments(line, _JOURNAL_ASSIGNMENT))
    return "".join(output)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("config", "journal", "path"), required=True)
    parser.add_argument("--config")
    parser.add_argument("--key", choices=("RECS_DIR",))
    parser.add_argument("--home")
    args = parser.parse_args()
    if args.mode == "path":
        if not args.config or args.key != "RECS_DIR" or not args.home:
            parser.error("--config, --key RECS_DIR, and --home are required for path mode")
        if (
            len(args.home) > 4096
            or not args.home.startswith("/")
            or args.home == "/"
            or ".." in args.home.split("/")
            or any(ord(character) < 32 for character in args.home)
        ):
            parser.error("--home must be a safe absolute path")
        try:
            with open(args.config, encoding="utf-8", errors="replace") as handle:
                path = load_config_path(handle.read(), args.key, posixpath.normpath(args.home))
        except (OSError, ValueError) as error:
            parser.error(str(error))
        sys.stdout.write(path)
        return

    source = sys.stdin.read()
    if args.mode == "config":
        try:
            output = redact_config(source)
        except ValueError as error:
            parser.error(str(error))
        sys.stdout.write(output)
        return
    if not args.config:
        parser.error("--config is required for journal mode")
    try:
        with open(args.config, encoding="utf-8", errors="replace") as handle:
            secrets = load_secret_values(handle.read())
        output = redact_journal(source, secrets)
    except ValueError as error:
        parser.error(str(error))
    sys.stdout.write(output)


if __name__ == "__main__":
    main()
