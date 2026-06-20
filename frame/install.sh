#!/usr/bin/env bash
# Install the AvianVisitors e-ink frame (display side) on a Raspberry Pi.
# Enables SPI + I2C, installs deps, makes a venv, installs the systemd timer.
#
# Default mode mirrors a local bird mic (set the image source in the config).
# Pass --bird-weather --zip <ZIP> to instead run the frame standalone from
# BirdWeather data for that ZIP: it renders on the Pi and pulls cutouts from the
# repo's raw GitHub URLs, so no mic and no local illustration folder are needed.
set -euo pipefail
cd "$(dirname "$0")"
FRAME="$(pwd)"

BIRD_WEATHER=0
ZIP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --bird-weather) BIRD_WEATHER=1 ;;
    --zip) ZIP="${2:-}"; shift ;;
    --zip=*) ZIP="${1#*=}" ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
  shift
done
if [ "$BIRD_WEATHER" = 1 ] && [ -z "$ZIP" ]; then
  echo "--bird-weather needs --zip <ZIP code>, e.g. install.sh --bird-weather --zip 94107" >&2
  exit 1
fi

CONFIG_TXT=/boot/firmware/config.txt
[ -f "$CONFIG_TXT" ] || CONFIG_TXT=/boot/config.txt

echo "1/5  Enabling SPI + I2C (Inky needs both; SPI with no chip-select)..."
sudo raspi-config nonint do_spi 0
sudo raspi-config nonint do_i2c 0
grep -q "^dtoverlay=spi0-0cs" "$CONFIG_TXT" || echo "dtoverlay=spi0-0cs" | sudo tee -a "$CONFIG_TXT" >/dev/null

echo "2/5  Installing system packages (build tools to compile spidev, libatlas3-base for numpy)..."
sudo apt-get update -qq
sudo apt-get install -y python3-venv python3-dev build-essential libatlas3-base

echo "3/5  Creating venv and installing Python deps..."
python3 -m venv .venv
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q -r requirements-frame.txt
if [ "$BIRD_WEATHER" = 1 ]; then
  echo "     BirdWeather mode: installing Playwright + Chromium for on-Pi rendering (a few minutes)..."
  .venv/bin/pip install -q playwright
  sudo .venv/bin/playwright install-deps chromium
  .venv/bin/playwright install chromium
fi

echo "4/5  Setting up config..."
mkdir -p "$HOME/.birdframe"
[ -f "$HOME/.birdframe/config.toml" ] || cp config.example.toml "$HOME/.birdframe/config.toml"

echo "5/5  Installing systemd service + timer..."
if [ "$BIRD_WEATHER" = 1 ]; then
  PY="$FRAME/.venv/bin/python"
  PNG="$HOME/.birdframe/frame.png"
  sudo tee /etc/systemd/system/birdframe.service >/dev/null <<SERVICE
[Unit]
Description=AvianVisitors frame, BirdWeather mode (ZIP $ZIP)
Documentation=https://github.com/Twarner491/AvianVisitors
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
User=$USER
WorkingDirectory=$FRAME
ExecStart=/bin/sh -c '$PY $FRAME/shoot.py --bird-weather --zip "$ZIP" --out $PNG && $PY $FRAME/display.py --config $HOME/.birdframe/config.toml --image-url $PNG --no-signature --force'
Environment=PYTHONUNBUFFERED=1
Nice=10
TimeoutStartSec=300
SERVICE
  # BirdWeather's recent-species list drifts slowly, so refresh a few times a day.
  sed 's|OnUnitActiveSec=.*|OnUnitActiveSec=6h|' systemd/birdframe.timer \
    | sudo tee /etc/systemd/system/birdframe.timer >/dev/null
else
  sed "s|/home/monalisa/AvianVisitors/frame|$FRAME|g; s|/home/monalisa|$HOME|g; s|User=monalisa|User=$USER|" \
    systemd/birdframe.service | sudo tee /etc/systemd/system/birdframe.service >/dev/null
  sudo cp systemd/birdframe.timer /etc/systemd/system/birdframe.timer
fi
sudo systemctl daemon-reload
sudo systemctl enable --now birdframe.timer  # --now starts it immediately, not only on the next boot

if [ "$BIRD_WEATHER" = 1 ]; then
  cat <<DONE

Installed in BirdWeather mode for ZIP $ZIP. The frame renders the top birds
near you on the Pi and refreshes every 6 hours. Cutouts come from the repo on
GitHub, so add illustrations there for any local birds it is missing.
DONE
else
  cat <<DONE

Installed. Set your image source in ~/.birdframe/config.toml (your /frame.png
key, or shoot = true); the panel fills itself in and refreshes every 15 min,
only when the birds change.
DONE
fi

# SPI only takes effect on a reboot, so do it for the user. Skip if SPI is
# already up (e.g. a re-run) so we don't bounce a working frame.
if [ -e /dev/spidev0.0 ]; then
  echo "SPI already active, no reboot needed."
else
  echo "Rebooting to bring SPI up (back on its own in ~1 min)..."
  sleep 4
  sudo reboot
fi
