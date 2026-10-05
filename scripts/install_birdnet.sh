#!/usr/bin/env bash
# Install BirdNET script
case "$#" in
  0) AVIAN_INSTALL_EDUCATORS=0 ;;
  1)
    [ "$1" = --educators ] \
      || { echo "Usage: $0 [--educators]" >&2; exit 64; }
    AVIAN_INSTALL_EDUCATORS=1
    ;;
  *) echo "Usage: $0 [--educators]" >&2; exit 64 ;;
esac
export AVIAN_INSTALL_EDUCATORS
exec > >(tee -i "installation-$(date +%F).txt") 2>&1 # Make log
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
# Keep Debian's timezone file aligned before AvianVisitors initializes the
# Educators store. Some fresh images omit it or leave it stale even though
# systemd already has the correct station timezone.
CURRENT_TIMEZONE=$(timedatectl show --value --property=Timezone)
[[ "$CURRENT_TIMEZONE" =~ ^[A-Za-z0-9._+-]+(/[A-Za-z0-9._+-]+)*$ ]] \
  && [[ "/$CURRENT_TIMEZONE/" != *'/../'* ]] \
  && [[ "/$CURRENT_TIMEZONE/" != *'/./'* ]] \
  && [ "${#CURRENT_TIMEZONE}" -le 128 ] \
  && [ -f "/usr/share/zoneinfo/$CURRENT_TIMEZONE" ] \
  || { echo "The system timezone is missing or invalid" >&2; exit 1; }
timezone_temp=$(mktemp)
printf '%s\n' "$CURRENT_TIMEZONE" >"$timezone_temp"
sudo install -o root -g root -m 0644 "$timezone_temp" /etc/timezone
rm -f -- "$timezone_temp"
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

./install_language_label.sh || exit 1

exit 0
