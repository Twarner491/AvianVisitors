#!/usr/bin/env bash
# Install the frame publisher on the BirdNET *mic* Pi: render frame.png on a
# timer and serve it from the site Caddy already hosts, so the frame Pi can run
# in image mode with no browser at all.
#
#   ./install-publish.sh                       every 5 min, default titles
#   ./install-publish.sh --interval 15min      easier on a Pi 3 or a busy box
#   ./install-publish.sh --title "..." --subtitle "..."
#   ./install-publish.sh --refresh             re-point after moving the clone
#   ./install-publish.sh --uninstall           remove everything it installed
#
# This is NOT install.sh. It touches no SPI, installs no panel driver, and never
# reboots. Run install.sh on the frame Pi and this on the mic Pi.
#
# Nothing machine-specific goes into the shipped unit files. Three generated
# pieces carry it: the launcher, a User= drop-in, and /etc/birdframe/publish.env.
set -euo pipefail

# Resolve before the cd, and through a symlink, so --help and the launcher both
# get real absolute paths however this was invoked.
SELF="$(readlink -f "$0")"
cd "$(dirname "$SELF")"
FRAME="$(pwd)"

LAUNCHER=/usr/local/bin/birdframe-publish
ENV_DIR=/etc/birdframe
ENV_FILE="$ENV_DIR/publish.env"
UNIT_DIR=/etc/systemd/system
SERVICE=birdframe-publish.service
TIMER=birdframe-publish.timer
MIN_INTERVAL_SEC=60   # see the --interval validation below

INTERVAL=""
TITLE=""; TITLE_SET=0
SUBTITLE=""; SUBTITLE_SET=0
URL=""; URL_SET=0
OUT=""; OUT_SET=0
ENABLE=1
ACTION=install
while [ $# -gt 0 ]; do
  case "$1" in
    --interval) [ $# -ge 2 ] || { echo "--interval needs a value, e.g. --interval 15min" >&2; exit 1; }
                INTERVAL="$2"; shift 2 ;;
    --interval=*) INTERVAL="${1#*=}"; shift ;;
    --title) [ $# -ge 2 ] || { echo "--title needs a value" >&2; exit 1; }
             TITLE="$2"; TITLE_SET=1; shift 2 ;;
    --title=*) TITLE="${1#*=}"; TITLE_SET=1; shift ;;
    --subtitle) [ $# -ge 2 ] || { echo "--subtitle needs a value" >&2; exit 1; }
                SUBTITLE="$2"; SUBTITLE_SET=1; shift 2 ;;
    --subtitle=*) SUBTITLE="${1#*=}"; SUBTITLE_SET=1; shift ;;
    --url) [ $# -ge 2 ] || { echo "--url needs a URL, e.g. --url http://127.0.0.1/" >&2; exit 1; }
           URL="$2"; URL_SET=1; shift 2 ;;
    --url=*) URL="${1#*=}"; URL_SET=1; shift ;;
    --out) [ $# -ge 2 ] || { echo "--out needs a path" >&2; exit 1; }
           OUT="$2"; OUT_SET=1; shift 2 ;;
    --out=*) OUT="${1#*=}"; OUT_SET=1; shift ;;
    --no-enable) ENABLE=0; shift ;;
    --refresh) ACTION=refresh; shift ;;
    --uninstall) ACTION=uninstall; shift ;;
    -h|--help) sed -n '2,16p' "$SELF" | sed 's/^# \?//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

# --- validation -------------------------------------------------------------
# Values land in an EnvironmentFile that later runs read back, and in a sed
# replacement, so the character set is deliberately narrow. Rejecting $, `, \,
# |, " and newline here is what makes both of those safe; it also rejects a flag
# accidentally passed as a value (e.g. "--title --subtitle").
# A function, not inline: the interactive prompt must apply the exact same
# rules. Validating there with systemd-analyze alone let a bare "5" through, and
# the prompt is the path a human actually uses.
check_interval() {
  local span
  # Let systemd parse its own time spans rather than guessing at a regex, so
  # 15min, 900s and 1h all work and a typo fails here instead of at daemon-reload.
  # The microseconds line is labelled with a mu, which would make a label match
  # depend on the locale and on UTF-8 surviving the pipe; take the first purely
  # numeric value instead. Empty means systemd rejected the span.
  span="$(systemd-analyze timespan "$1" 2>/dev/null \
          | awk -F': *' 'NR>1 && $2 ~ /^[0-9]+$/ {print $2; exit}' || true)"
  if [ -z "$span" ]; then
    echo "'$1' is not a systemd time span; try 15min, 900s or 1h." >&2
    return 1
  fi
  # 'infinity' parses to 2^64-1, which overflows bash's signed comparison and
  # would slip past the floor below with a raw "integer expression expected".
  if [ "${#span}" -gt 15 ]; then
    echo "'$1' is not a usable interval." >&2
    return 1
  fi
  # A bare number is seconds to systemd, so "5" would launch Chromium every five
  # seconds on a Pi that is also doing realtime tflite inference.
  if [ "$span" -lt $((MIN_INTERVAL_SEC * 1000000)) ]; then
    echo "'$1' is under ${MIN_INTERVAL_SEC}s; that renders faster than the frame can use it." >&2
    echo "Did you mean '${1}min'?" >&2
    return 1
  fi
  return 0
}
if [ -n "$INTERVAL" ] && ! check_interval "$INTERVAL"; then
  exit 1
fi
# A newline passes any `grep -qE '^...$'` check, because grep matches per line -
# so validate it separately. In the append branch of env_set an embedded newline
# would write a whole extra key.
for v in "$INTERVAL" "$URL" "$OUT" "$TITLE" "$SUBTITLE"; do
  case "$v" in
    *$'\n'*) echo "values cannot contain newlines" >&2; exit 1 ;;
    --*) echo "'$v' looks like a flag, not a value - did you leave one out?" >&2; exit 1 ;;
  esac
done
if [ "$URL_SET" = 1 ] && ! printf '%s' "$URL" | LC_ALL=C grep -qE '^https?://[A-Za-z0-9._~:/?#@!$&()*+,;=%-]+$'; then
  echo "--url should be a plain http(s) URL, e.g. http://127.0.0.1/" >&2
  exit 1
fi
if [ "$OUT_SET" = 1 ] && ! printf '%s' "$OUT" | LC_ALL=C grep -qE '^/[A-Za-z0-9._/-]*\.png$'; then
  echo "--out should be an absolute path ending in .png, with no shell metacharacters" >&2
  exit 1
fi
for v in "$TITLE" "$SUBTITLE"; do
  if [ -n "$v" ] && ! printf '%s' "$v" | LC_ALL=C grep -qE "^[A-Za-z0-9 .,'!?&()·–-]{1,60}$"; then
    echo "titles must be plain text, 60 characters or fewer: '$v'" >&2
    exit 1
  fi
done

# --- config file helpers ----------------------------------------------------
# publish.env is read with grep rather than `source`d. It is a systemd
# EnvironmentFile, not a shell script: systemd accepts unquoted interior
# whitespace that bash would try to execute, and sourcing it would also run
# anything a hand edit introduced.
env_get() {
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^${1}=//p" "$ENV_FILE" | tail -n1 | sed -e 's/^"//' -e 's/"$//'
}
# Rewrite one key in place, leaving every other key and all comments alone. The
# whole-file rewrite this replaces silently dropped FRAME_USER/FRAME_PASSWORD on
# every --refresh, which is exactly the basic-auth freeze publish.py warns about.
env_set() {
  # & in a sed replacement means "the whole match", and the title and URL
  # charsets both allow it (query strings, "Birds & Bees"). Unescaped, that
  # rewrites FRAME_TITLE="Birds & Bees" as FRAME_TITLE="Birds FRAME_TITLE="Avian
  # Visitors" Bees" and reports success. Escape it and the delimiter.
  local esc; esc="$(printf '%s' "$2" | sed 's/[&|\\]/\\&/g')"
  if sudo grep -qs "^${1}=" "$ENV_FILE"; then
    sudo sed -i "s|^${1}=.*|${1}=\"${esc}\"|" "$ENV_FILE"
  else
    printf '%s="%s"\n' "$1" "$2" | sudo tee -a "$ENV_FILE" >/dev/null
  fi
}

# --- uninstall --------------------------------------------------------------
# uninstall.sh discovers units by awk-ing install_services.sh and cannot see
# this one, so removal has to live here.
if [ "$ACTION" = uninstall ]; then
  sudo systemctl disable --now "$TIMER" 2>/dev/null || true
  sudo systemctl stop "$SERVICE" 2>/dev/null || true   # disabling the timer does not stop a render in flight
  STATE_DIR="$(env_get FRAME_STATE)"
  sudo rm -rf "$UNIT_DIR/$TIMER" "$UNIT_DIR/$SERVICE" \
              "$UNIT_DIR/$SERVICE.d" "$UNIT_DIR/$TIMER.d" \
              "$LAUNCHER" "$ENV_DIR"
  sudo systemctl daemon-reload
  rm -f "$HOME/.birdframe/publish-state.json" "$HOME/.birdframe/.publish.lock" 2>/dev/null || true
  [ -n "$STATE_DIR" ] && rm -f "$STATE_DIR" 2>/dev/null || true
  if [ -f /etc/birdnet/birdnet.conf ]; then
    # shellcheck disable=SC1091
    source /etc/birdnet/birdnet.conf
    if [ -n "${EXTRACTED:-}" ] && [ -L "$EXTRACTED/frame.png" ]; then
      sudo rm -f "$EXTRACTED/frame.png"
    fi
  fi
  echo "Removed the frame publisher. Rendered frames and $FRAME/.venv were left in place."
  exit 0
fi

# --- preflight --------------------------------------------------------------
# Run as the BirdNET user, not with sudo. Under sudo, \$USER is root: the venv,
# the Playwright browser cache and every rendered PNG land root-owned in a tree
# BirdNET-Pi's own scripts expect to own, and User= in the drop-in would be
# root. The script sudos for the handful of steps that need it.
if [ "$(id -u)" = 0 ]; then
  echo "Run this as the BirdNET user, not as root:  ./install-publish.sh" >&2
  echo "It uses sudo only for the steps that need it." >&2
  exit 1
fi
# install.sh writes this file on the frame Pi. A publisher there would be
# screenshotting a site that machine does not host.
if [ -f "$HOME/.birdframe/config.toml" ]; then
  echo "$HOME/.birdframe/config.toml exists - this looks like the frame Pi." >&2
  echo "install-publish.sh belongs on the BirdNET mic Pi; run install.sh here instead." >&2
  exit 1
fi
# The publisher screenshots the local site and writes into its web root, so a
# BirdNET-Pi install must be here. birdnet.conf is also where EXTRACTED and
# RECS_DIR come from - never hardcode ~/BirdSongs.
if [ ! -f /etc/birdnet/birdnet.conf ]; then
  echo "no /etc/birdnet/birdnet.conf - is this the BirdNET mic Pi?" >&2
  exit 1
fi
# shellcheck disable=SC1091
source /etc/birdnet/birdnet.conf
: "${RECS_DIR:?RECS_DIR missing from birdnet.conf}"
: "${EXTRACTED:?EXTRACTED missing from birdnet.conf}"
SVC_USER="$(id -un)"
# The rendered PNG has to be writable by the service user and readable by caddy,
# which is in the BirdNET user's group. A mismatch fails later with a bare
# permission error or a silent 403, so catch it here.
if [ -n "${BIRDNET_USER:-}" ] && [ "$BIRDNET_USER" != "$SVC_USER" ]; then
  echo "You are '$SVC_USER' but BirdNET runs as '$BIRDNET_USER'." >&2
  echo "Run this as $BIRDNET_USER, or the frame will not be writable or servable." >&2
  exit 1
fi
FRAME_DIR="$RECS_DIR/frame"

# Resolve the output path only now: an existing install's FRAME_OUT must win
# over the default, or --refresh would silently move the published frame and
# orphan whatever the renderer keeps writing.
if [ "$OUT_SET" = 0 ]; then
  OUT="$(env_get FRAME_OUT)"
  [ -n "$OUT" ] || OUT="$FRAME_DIR/frame.png"
fi

# Interactive only when a human is driving and gave no flags. The main
# installer's FRAME_PUBLISH path and any CI run are non-interactive and take the
# defaults silently.
if [ "$ACTION" = install ] && [ -t 0 ] && [ -z "$INTERVAL" ] \
   && [ "$TITLE_SET$SUBTITLE_SET$URL_SET$OUT_SET" = "0000" ]; then
  # `|| true` on every read: EOF (Ctrl-D) returns non-zero and would otherwise
  # abort the installer under set -e with no message.
  read -r -p "Re-check for new birds every [15min]: " ans || true
  # check_interval, not a bare systemd-analyze: the floor has to apply here too,
  # and this prompt actively invites the bare number that trips it.
  if [ -n "${ans:-}" ] && check_interval "$ans"; then INTERVAL="$ans"
  elif [ -n "${ans:-}" ]; then echo "Using the 15min default." >&2; fi
  read -r -p "Frame title [Avian Visitors]: " ans || true
  [ -n "${ans:-}" ] && { TITLE="$ans"; TITLE_SET=1; }
  read -r -p "Frame subtitle [Heard Today]: " ans || true
  [ -n "${ans:-}" ] && { SUBTITLE="$ans"; SUBTITLE_SET=1; }
  for v in "$TITLE" "$SUBTITLE"; do
    if [ -n "$v" ] && ! printf '%s' "$v" | LC_ALL=C grep -qE "^[A-Za-z0-9 .,'!?&()·–-]{1,60}$"; then
      echo "titles must be plain text, 60 characters or fewer: '$v'" >&2
      exit 1
    fi
  done
fi

# --- 1/3  venv + Chromium ---------------------------------------------------
if [ "$ACTION" = install ]; then
  echo "1/3  Installing Playwright + Chromium (~1GB, several minutes)..."
  # uv is much faster and produces a bit-for-bit ordinary .venv, so everything
  # downstream is identical either way. Use it when it is already there; never
  # install it - requiring `curl | sh` on a Pi is a worse trade than waiting.
  if command -v uv >/dev/null 2>&1; then
    uv venv .venv
    uv pip install --quiet --python .venv/bin/python -r requirements-publish.txt
  else
    sudo apt-get update -qq   # a Pi that has been up for months has a stale index
    sudo apt-get install -y python3-venv   # no build-essential: these are pure wheels
    python3 -m venv .venv
    .venv/bin/pip install -q --upgrade pip
    .venv/bin/pip install -q -r requirements-publish.txt
  fi
  sudo .venv/bin/playwright install-deps chromium
  .venv/bin/playwright install chromium
else
  echo "1/3  Refreshing an existing install (skipping Playwright)..."
  [ -x "$FRAME/.venv/bin/python" ] || { echo "no venv at $FRAME/.venv; run without --refresh" >&2; exit 1; }
fi

# --- 2/3  the generated, machine-specific pieces -----------------------------
echo "2/3  Writing the launcher, config and units..."
mkdir -p "$FRAME_DIR"

# The real PNG lives outside the web root and is symlinked in - the same shape
# spectrogram.png already uses (scripts/install_services.sh). publish.py
# os.replace()s the real path; replacing the symlink would turn it into a
# regular file and orphan the target.
if [ -d "$EXTRACTED/frame.png" ] && [ ! -L "$EXTRACTED/frame.png" ]; then
  # ln -sfn into an existing directory succeeds by creating a link *inside* it,
  # which would leave /frame.png serving a browsable listing forever.
  echo "$EXTRACTED/frame.png is a directory; move it aside and re-run." >&2
  exit 1
fi
ln -sfn "$OUT" "$EXTRACTED/frame.png"

# The one file that knows where anything lives, so the shipped unit does not.
sudo tee "$LAUNCHER" >/dev/null <<LAUNCH
#!/bin/sh
# Generated by frame/install-publish.sh. The systemd unit calls this instead of
# an absolute python path, so the shipped unit carries no machine-specific path.
# Re-run 'install-publish.sh --refresh' if you move the clone.

# Playwright's browser cache is per-user and lives in \$HOME/.cache/ms-playwright.
# Under sudo that resolves to /root, where nothing is installed, so a hand run as
# root dies with "Executable doesn't exist at /root/.cache/..." and a misleading
# "run playwright install" banner - and drops a stray lock in /root/.birdframe.
# Fail early with the actual answer instead.
if [ "\$(id -u)" = 0 ]; then
  echo "birdframe-publish runs as $SVC_USER, not root (Playwright's cache is per-user)." >&2
  echo "Use:  sudo systemctl start $SERVICE" >&2
  echo "  or: sudo -u $SVC_USER $LAUNCHER \$*" >&2
  exit 1
fi
exec "$FRAME/.venv/bin/python" "$FRAME/publish.py" "\$@"
LAUNCH
sudo chmod 755 "$LAUNCHER"

# Config the user is expected to edit. Created once with the full set of
# defaults; after that only the keys actually passed are rewritten, so hand-added
# keys, comments and credentials survive every upgrade and --refresh.
sudo mkdir -p "$ENV_DIR"
if [ ! -f "$ENV_FILE" ]; then
  sudo tee "$ENV_FILE" >/dev/null <<ENV
# Frame publisher settings. Edit, then:  sudo systemctl start $SERVICE
# Every key matches a publish.py flag; run '$LAUNCHER --help' for the full list.
# Keys you add here are preserved when install-publish.sh is re-run.
FRAME_URL="http://127.0.0.1/"
FRAME_OUT="$OUT"
FRAME_TITLE="Avian Visitors"
FRAME_SUBTITLE="Heard Today"
# If the whole site is behind basic auth, set these too - without them the
# change-detection fetch 401s every tick and the frame freezes on one image:
# FRAME_USER="..."
# FRAME_PASSWORD="..."
ENV
fi
[ "$URL_SET" = 1 ] && env_set FRAME_URL "$URL"
[ "$OUT_SET" = 1 ] && env_set FRAME_OUT "$OUT"
[ "$TITLE_SET" = 1 ] && env_set FRAME_TITLE "$TITLE"
[ "$SUBTITLE_SET" = 1 ] && env_set FRAME_SUBTITLE "$SUBTITLE"
# --refresh exists to re-point after a clone move; the launcher above is what
# actually moved, and FRAME_OUT is re-asserted in case the tree was relocated.
[ "$ACTION" = refresh ] && env_set FRAME_OUT "$OUT"

# Units go in unmodified; only the drop-ins are generated.
sudo cp "$FRAME/systemd/$SERVICE" "$UNIT_DIR/$SERVICE"
sudo cp "$FRAME/systemd/$TIMER" "$UNIT_DIR/$TIMER"
sudo mkdir -p "$UNIT_DIR/$SERVICE.d"
sudo tee "$UNIT_DIR/$SERVICE.d/10-local.conf" >/dev/null <<DROPIN
# Generated by frame/install-publish.sh. User= cannot come from an
# EnvironmentFile, so it is the one [Service] key that has to be a drop-in.
[Service]
User=$SVC_USER
DROPIN
if [ -n "$INTERVAL" ]; then
  sudo mkdir -p "$UNIT_DIR/$TIMER.d"
  sudo tee "$UNIT_DIR/$TIMER.d/10-schedule.conf" >/dev/null <<DROPIN
# Generated by frame/install-publish.sh --interval. OnUnitActiveSec= is not
# env-expandable, so the schedule is a drop-in rather than an edit to the timer.
#
# The bare assignment first is load-bearing: these are LIST-valued settings, so
# a plain OnUnitActiveSec= in a drop-in APPENDS a second trigger instead of
# replacing the shipped one. Without the reset, a longer interval would silently
# do nothing (the shipped value still elapses first) while the installer claimed
# otherwise. The reset clears the whole monotonic list, so OnActiveSec= and
# OnBootSec= have to be restated - dropping OnActiveSec here would reintroduce
# the stopped-and-restarted deadlock the shipped timer exists to avoid.
[Timer]
OnUnitActiveSec=
OnActiveSec=3min
OnBootSec=3min
OnUnitActiveSec=$INTERVAL
DROPIN
elif [ "$ACTION" != refresh ]; then
  # Drop only our own file, never the whole .d directory: `systemctl edit
  # birdframe-publish.timer` writes override.conf in there, and the shipped unit
  # tells people to do exactly that. And never on --refresh - an update runs
  # that, and it must not silently reset a schedule the user chose.
  sudo rm -f "$UNIT_DIR/$TIMER.d/10-schedule.conf"
fi
sudo systemctl daemon-reload
# enable without --now, and start the timer only after the checks below: with
# OnBootSec=3min always in the past on a running machine, activating the timer
# fires a run immediately, which would race the controlled first render.
# Not on --refresh either: an update must not re-enable a timer someone stopped.
[ "$ENABLE" = 1 ] && [ "$ACTION" != refresh ] && sudo systemctl enable "$TIMER" >/dev/null

# --- 3/3  prove it ----------------------------------------------------------
echo "3/3  Rendering the first frame..."
BEFORE="$(stat -c %Y "$OUT" 2>/dev/null || echo 0)"
# --force, and through the launcher rather than the unit. A plain service start
# exits 0 on "no change; skip", so on a re-install over existing state the
# installer would report success without this run having rendered anything -
# and the PNG check below would happily pass against a stale file. Forcing makes
# the check mean "this run produced a frame". The launcher runs as the service
# user, so it exercises the same venv, browser cache and permissions the timer
# will.
if ! "$LAUNCHER" --force; then
  echo "The first render failed. Diagnose with:  journalctl -u $SERVICE -n 40" >&2
  exit 1
fi
# Belt and braces: prove a real PNG landed, and that it landed *now*. A dangling
# symlink and a missing file both come back 200 text/html through Caddy's
# try_files, so "the file is there" is the only thing that distinguishes a
# working publisher from one that silently serves the HTML shell.
if [ ! -s "$OUT" ] || [ "$(head -c4 "$OUT" | od -An -tx1 | tr -d ' \n')" != "89504e47" ]; then
  echo "no PNG at $OUT after the first run." >&2
  echo "Diagnose with:  journalctl -u $SERVICE -n 40" >&2
  exit 1
fi
if [ "$(stat -c %Y "$OUT")" = "$BEFORE" ]; then
  echo "warning: $OUT was not updated by this run; it may be stale." >&2
fi
# Now prove the unit wiring itself, separately from the render. This one will
# normally log "no change; skip" - that is the gate working, not a failure.
if ! sudo systemctl start "$SERVICE"; then
  echo "The systemd unit failed to run. Diagnose with:  journalctl -u $SERVICE -n 40" >&2
  exit 1
fi
# Starting the timer trips OnBootSec=3min, which is always in the past on a
# running machine, so this fires one extra service run immediately. It is a
# gated tick costing a fraction of a second, and it happens after the checks
# above, so it proves rather than pre-empts them.
[ "$ENABLE" = 1 ] && [ "$ACTION" != refresh ] && sudo systemctl start "$TIMER"

# Prefer the tailnet name when there is one: it works off-LAN and has a real
# certificate. Never hardcode a tailnet - read it from the daemon.
PUB=""
if command -v tailscale >/dev/null 2>&1; then
  TS="$(tailscale status --json 2>/dev/null \
        | python3 -c 'import json,sys;print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)"
  [ -n "$TS" ] && PUB="https://$TS/frame.png"
fi
[ -n "$PUB" ] || PUB="http://$(hostname -I | awk '{print $1}')/frame.png"

cat <<DONE

Installed. This Pi re-checks for new birds every ${INTERVAL:-15min} and
re-renders only when they change. The frame is published at
  $PUB

On the frame Pi, run:
  ./install.sh --image-url $PUB

Retune titles in $ENV_FILE, then: sudo systemctl start $SERVICE
DONE
if grep -qs 'frame.png' "$FRAME/../scripts/update_caddyfile.sh"; then
  cat <<DONE
Optional: sudo $FRAME/../scripts/update_caddyfile.sh
          adds a no-cache header for /frame.png (regenerates the whole Caddyfile).
DONE
fi
