#!/usr/bin/env bash
# Install BirdNET script
exec > >(tee -i installation-$(date +%F).txt) 2>&1 # Make log
set -e # exit installation if anything fails

my_dir=$HOME/BirdNET-Pi
export my_dir=$my_dir

cd $my_dir/scripts || exit 1
git log -n 1 --pretty=oneline --no-color --decorate

source install_helpers.sh

if [ "$(uname -m)" != "aarch64" ] && [ "$(uname -m)" != "x86_64" ];then
  echo "BirdNET-Pi requires a 64-bit OS.
It looks like your operating system is using $(uname -m),
but would need to be aarch64."
  exit 1
fi

#Install/Configure /etc/birdnet/birdnet.conf
./install_config.sh || exit 1
sudo -E HOME=$HOME USER=$USER ./install_services.sh || exit 1
source /etc/birdnet/birdnet.conf

install_birdnet() {
  TMP_SIZE=$(df --output=avail /tmp | tail -n 1)
  if [[ $TMP_SIZE -lt 300000 ]]; then
    mkdir -p $HOME/bird_tmp
    export TMPDIR=$HOME/bird_tmp
  fi
  cd ~/BirdNET-Pi || exit 1
  echo "Establishing a python virtual environment"
  python3 -m venv birdnet
  source ./birdnet/bin/activate
  pip3 install wheel
  get_tf_whl
  LOOP_COUNT=2
  while ! pip3 install -U -r ./requirements_custom.txt
  do
    LOOP_COUNT=$(( LOOP_COUNT - 1 ))
    pip3 cache purge
    [ $LOOP_COUNT == 0 ] && exit 1
    sleep 5
  done
  rm -rf $HOME/bird_tmp
}

[ -d ${RECS_DIR} ] || mkdir -p ${RECS_DIR} &> /dev/null

install_birdnet

cd $my_dir/scripts || exit 1

# tzlocal.get_localzone() will fail if the Debian specific /etc/timezone is not in sync
CURRENT_TIMEZONE=$(timedatectl show --value --property=Timezone)
[ -f /etc/timezone ] && echo "$CURRENT_TIMEZONE" | sudo tee /etc/timezone > /dev/null

./install_language_label.sh || exit 1

# Optional: render frame.png here on a timer and publish it, so an e-ink wall
# frame can run with no browser (frame/README.md). Off by default because it
# pulls ~300MB of Chromium, so it is opt-in through the environment:
#   FRAME_PUBLISH=15min ./newinstaller.sh
# All the logic stays in frame/; this is only the hook. A failure here must not
# fail the BirdNET install - the frame is an accessory.
if [ -n "${FRAME_PUBLISH:-}" ]; then
  # The variable takes an interval, but "=1" / "=yes" / "=true" are what people
  # actually type for an opt-in flag. Treat those as "use the default" rather
  # than failing validation inside a 20-40 minute install log nobody reads.
  case "${FRAME_PUBLISH,,}" in
    1|y|yes|true|on) FRAME_INTERVAL=15min ;;
    *) FRAME_INTERVAL="$FRAME_PUBLISH" ;;
  esac
  "$HOME"/BirdNET-Pi/frame/install-publish.sh --interval "$FRAME_INTERVAL" \
    || echo "frame publisher install failed; BirdNET-Pi itself is fine. See frame/README.md" >&2
fi

exit 0
