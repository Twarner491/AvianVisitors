#!/usr/bin/env bash
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT

vendor_unit=$test_root/vendor-tmp.mount
target_unit=$test_root/system-tmp.mount
printf '%s\n' '[Mount]' 'What=tmpfs' >"$vendor_unit"

actions=''
mount_state='bookworm-missing'

record_action() {
  if [ -n "$actions" ]; then
    actions="$actions|$*"
  else
    actions="$*"
  fi
}

systemctl() {
  if [ "$1" = 'is-enabled' ]; then
    case "$mount_state" in
      bookworm-missing)
        printf '%s\n' \
          'Failed to get unit file state for tmp.mount: No such file or directory' >&2
        return 1
        ;;
      not-found)
        printf '%s\n' 'not-found'
        return 1
        ;;
      query-error)
        printf '%s\n' 'Failed to connect to bus: No such file or directory' >&2
        return 1
        ;;
      enabled|enabled-runtime|linked|linked-runtime|alias)
        printf '%s\n' "$mount_state"
        return 0
        ;;
      disabled|static|masked|masked-runtime|indirect|generated)
        printf '%s\n' "$mount_state"
        return 1
        ;;
      *)
        printf '%s\n' "$mount_state"
        return 1
        ;;
    esac
  fi
  record_action "systemctl $*"
  if [ "$1" = 'daemon-reload' ] \
    && { [ "$mount_state" = 'bookworm-missing' ] || [ "$mount_state" = 'not-found' ]; }; then
    mount_state='disabled'
  fi
  if [ "$1" = 'enable' ] && [ "$2" = 'tmp.mount' ]; then
    [ "$mount_state" = 'disabled' ] \
      || { printf 'tmp.mount was enabled from unexpected state: %s\n' "$mount_state" >&2; return 1; }
    mount_state='enabled'
  fi
}

source "$repo/scripts/install_helpers.sh"

install_tmp_mount "$vendor_unit" "$target_unit" >/dev/null
expected='systemctl daemon-reload|systemctl enable tmp.mount'
if [ "$actions" != "$expected" ]; then
  printf 'missing tmp.mount actions differ\nexpected: %s\nactual:   %s\n' \
    "$expected" "$actions" >&2
  exit 1
fi
cmp -s "$vendor_unit" "$target_unit" \
  || { printf '%s\n' 'vendor tmp.mount was not copied exactly' >&2; exit 1; }
[ "$mount_state" = 'enabled' ] \
  || { printf 'tmp.mount did not progress from missing to disabled to enabled: %s\n' "$mount_state" >&2; exit 1; }

actions=''
install_tmp_mount "$vendor_unit" "$target_unit" >/dev/null
[ -z "$actions" ] \
  || { printf 'enabled tmp.mount was changed: %s\n' "$actions" >&2; exit 1; }

for preserved_state in \
  enabled enabled-runtime disabled static masked masked-runtime indirect \
  generated linked linked-runtime alias; do
  mount_state=$preserved_state
  actions=''
  printf '%s\n' "sentinel-$preserved_state" >"$target_unit"
  install_tmp_mount "$vendor_unit" "$target_unit" >/dev/null
  grep -qx "sentinel-$preserved_state" "$target_unit" \
    || { printf '%s state changed tmp.mount\n' "$preserved_state" >&2; exit 1; }
  [ -z "$actions" ] \
    || { printf '%s state ran actions: %s\n' "$preserved_state" "$actions" >&2; exit 1; }
done

custom_unit=$test_root/custom.mount
printf '%s\n' 'custom unit' >"$custom_unit"
rm -f "$target_unit"
ln -s "$custom_unit" "$target_unit"
for preserved_state in linked alias masked; do
  mount_state=$preserved_state
  install_tmp_mount "$vendor_unit" "$target_unit" >/dev/null
  [ -L "$target_unit" ] && [ "$(readlink "$target_unit")" = "$custom_unit" ] \
    || { printf '%s state replaced a custom link\n' "$preserved_state" >&2; exit 1; }
done

mount_state='bookworm-missing'
if install_tmp_mount "$vendor_unit" "$target_unit" >"$test_root/target.log" 2>&1; then
  printf '%s\n' 'missing state replaced a preexisting target' >&2
  exit 1
fi
grep -q 'target already exists' "$test_root/target.log" \
  || { printf '%s\n' 'preexisting target failure was unclear' >&2; exit 1; }
[ -L "$target_unit" ] && [ "$(readlink "$target_unit")" = "$custom_unit" ] \
  || { printf '%s\n' 'preexisting target link changed' >&2; exit 1; }

rm -f "$target_unit"
mount_state='not-found'
if install_tmp_mount "$test_root/missing-vendor.mount" "$target_unit" \
  >"$test_root/source.log" 2>&1; then
  printf '%s\n' 'missing vendor unit was accepted' >&2
  exit 1
fi
grep -q 'vendor unit is missing or unsafe' "$test_root/source.log" \
  || { printf '%s\n' 'missing vendor failure was unclear' >&2; exit 1; }
[ ! -e "$target_unit" ] || { printf '%s\n' 'missing source created a target' >&2; exit 1; }

mount_state='query-error'
if install_tmp_mount "$vendor_unit" "$target_unit" >"$test_root/query.log" 2>&1; then
  printf '%s\n' 'systemctl query failure was accepted as a missing unit' >&2
  exit 1
fi
grep -q 'Failed to connect to bus' "$test_root/query.log" \
  || { printf '%s\n' 'systemctl query failure lost its diagnostic' >&2; exit 1; }
[ ! -e "$target_unit" ] || { printf '%s\n' 'query failure created a target' >&2; exit 1; }

run_recording_case() (
  source() {
    case "$recording_card_kind" in
      unset) unset REC_CARD ;;
      *) REC_CARD=$recording_card ;;
    esac
    RTSP_STREAM=''
    RECORDING_LENGTH=15
    RECS_DIR="$test_root/recordings"
    CHANNELS=1
    LogLevel_BirdnetRecordingService='error'
  }
  pulseaudio() {
    printf 'pulseaudio %s\n' "$*"
    if [ "$1" = '--check' ]; then
      [ "$pulse_running" = true ]
    fi
  }
  pgrep() { return 1; }
  mkdir() { return 0; }
  arecord() { printf 'arecord %s\n' "$*"; }
  . "$repo/scripts/birdnet_recording.sh"
)

run_livestream_case() (
  source() {
    case "$recording_card_kind" in
      unset) unset REC_CARD ;;
      *) REC_CARD=$recording_card ;;
    esac
    RTSP_STREAM=${test_rtsp_stream:-}
    RTSP_STREAM_TO_LIVESTREAM=0
    CHANNELS=1
    ICE_PWD=test
    ACTIVATE_FREQSHIFT_IN_LIVESTREAM=false
    LogLevel_LiveAudioStreamService='error'
  }
  pulseaudio() {
    printf 'pulseaudio %s\n' "$*"
    if [ "$1" = '--check' ]; then
      [ "$pulse_running" = true ]
    fi
  }
  ffmpeg() { printf 'ffmpeg %s\n' "$*"; }
  . "$repo/scripts/livestream.sh"
)

run_livestream_check() (
  source() {
    case "$recording_card_kind" in
      unset) unset REC_CARD ;;
      *) REC_CARD=$recording_card ;;
    esac
    RTSP_STREAM=${test_rtsp_stream:-}
  }
  pulseaudio() { printf '%s\n' 'condition called PulseAudio' >&2; return 1; }
  ffmpeg() { printf '%s\n' 'condition called ffmpeg' >&2; return 1; }
  . "$repo/scripts/livestream.sh" --check
)

assert_pulse_case() {
  local kind=$1 card=$2 expected_device=$3
  recording_card_kind=$kind
  recording_card=$card
  pulse_running=false
  local recording_output livestream_output output
  recording_output=$(run_recording_case)
  livestream_output=$(run_livestream_case)
  for output in "$recording_output" "$livestream_output"; do
    [[ "$output" == *'pulseaudio --check'* && "$output" == *'pulseaudio --start'* ]] \
      || { printf 'PulseAudio was not ensured for %s:\n%s\n' "$kind:$card" "$output" >&2; exit 1; }
  done
  if [ -n "$expected_device" ]; then
    [[ "$recording_output" == *"-D $expected_device"* ]] \
      || { printf 'arecord device mismatch for %s:\n%s\n' "$kind:$card" "$recording_output" >&2; exit 1; }
  else
    [[ "$recording_output" != *' -D '* ]] \
      || { printf 'unset capture unexpectedly passed -D:\n%s\n' "$recording_output" >&2; exit 1; }
  fi
  [[ "$livestream_output" == *"-i ${expected_device:-default}"* ]] \
    || { printf 'ffmpeg device mismatch for %s:\n%s\n' "$kind:$card" "$livestream_output" >&2; exit 1; }
}

assert_pulse_case unset '' ''
assert_pulse_case set '' ''
assert_pulse_case set default default
assert_pulse_case set pulse pulse

for direct_card in 'hw:CARD=Device' 'plughw:CARD=Device'; do
  recording_card_kind=set
  recording_card=$direct_card
  pulse_running=false
  direct_recording=$(run_recording_case)
  direct_livestream=$(run_livestream_case)
  [[ "$direct_recording" != *pulseaudio* && "$direct_recording" == *"-D $direct_card"* ]] \
    || { printf 'direct recorder routing failed for %s:\n%s\n' "$direct_card" "$direct_recording" >&2; exit 1; }
  [[ "$direct_livestream" != *pulseaudio* && "$direct_livestream" != *ffmpeg* ]] \
    || { printf 'direct live stream touched the PCM for %s:\n%s\n' "$direct_card" "$direct_livestream" >&2; exit 1; }
  if run_livestream_check; then
    printf 'direct live stream condition accepted %s\n' "$direct_card" >&2
    exit 1
  fi
done

recording_card_kind=set
recording_card=default
run_livestream_check \
  || { printf '%s\n' 'direct to default transition stayed blocked' >&2; exit 1; }
recording_card='plughw:CARD=Device'
test_rtsp_stream='rtsp://camera.example.test/audio'
run_livestream_check \
  || { printf '%s\n' 'RTSP live stream was blocked by direct REC_CARD' >&2; exit 1; }
unset test_rtsp_stream

for running_card in default pulse; do
  recording_card_kind=set
  recording_card=$running_card
  pulse_running=true
  for output in "$(run_recording_case)" "$(run_livestream_case)"; do
    [[ "$output" == *'pulseaudio --check'* && "$output" != *'pulseaudio --start'* ]] \
      || { printf 'running PulseAudio was restarted for %s:\n%s\n' "$running_card" "$output" >&2; exit 1; }
  done
done

recording_card_kind=set
recording_card='plughw:CARD=Device'
pulse_running=false
test_rtsp_stream='rtsp://camera.example.test/audio'
rtsp_output=$(run_livestream_case)
unset test_rtsp_stream
[[ "$rtsp_output" == *'-i rtsp://camera.example.test/audio'* ]] \
  || { printf 'RTSP live stream was disabled by direct REC_CARD:\n%s\n' "$rtsp_output" >&2; exit 1; }

exclusive=$test_root/exclusive
recordings=$test_root/exclusive-recordings
mkdir -p "$exclusive" "$recordings/StreamData"
run_exclusive_recording() (
  source() {
    REC_CARD='plughw:CARD=Device'
    RTSP_STREAM=''
    RECORDING_LENGTH=15
    RECS_DIR=$recordings
    CHANNELS=1
    LogLevel_BirdnetRecordingService='error'
  }
  pulseaudio() { printf '%s\n' 'direct recording called PulseAudio' >"$exclusive/pulse"; return 1; }
  pgrep() { return 1; }
  arecord() {
    mkdir "$exclusive/pcm"
    : >"$exclusive/recording-ready"
    while [ ! -e "$exclusive/release" ]; do sleep 0.01; done
    rmdir "$exclusive/pcm"
  }
  . "$repo/scripts/birdnet_recording.sh"
)
run_exclusive_livestream() (
  source() {
    REC_CARD='plughw:CARD=Device'
    RTSP_STREAM=''
    CHANNELS=1
    ICE_PWD=test
    ACTIVATE_FREQSHIFT_IN_LIVESTREAM=false
    LogLevel_LiveAudioStreamService='error'
  }
  pulseaudio() { : >"$exclusive/pulse"; return 1; }
  ffmpeg() {
    : >"$exclusive/ffmpeg-called"
    mkdir "$exclusive/pcm" 2>/dev/null || : >"$exclusive/collision"
  }
  . "$repo/scripts/livestream.sh"
)

run_exclusive_recording &
recording_pid=$!
for _ in $(seq 1 200); do
  [ -e "$exclusive/recording-ready" ] && break
  sleep 0.01
done
[ -e "$exclusive/recording-ready" ] \
  || { printf '%s\n' 'fake exclusive recorder did not start' >&2; exit 1; }
run_exclusive_livestream >/dev/null
: >"$exclusive/release"
wait "$recording_pid"
[ ! -e "$exclusive/ffmpeg-called" ] && [ ! -e "$exclusive/collision" ] \
  && [ ! -e "$exclusive/pulse" ] \
  || { printf '%s\n' 'live stream contended with direct recording' >&2; exit 1; }

grep -A14 '^install_livestream_service()' "$repo/scripts/install_services.sh" \
  | grep -q '^Restart=always$' \
  || { printf '%s\n' 'new live stream unit lost restart resilience' >&2; exit 1; }
grep -A14 '^install_livestream_service()' "$repo/scripts/install_services.sh" \
  | grep -q '^ExecCondition=/usr/local/bin/livestream.sh --check$' \
  || { printf '%s\n' 'new live stream unit lacks its capture condition' >&2; exit 1; }
grep -q 'systemctl stop livestream.service' "$repo/scripts/reinstall_services.sh" \
  || { printf '%s\n' 'service refresh does not stop an active direct-mode stream' >&2; exit 1; }
grep -q 'avian-service-refresh --audio-policy' "$repo/scripts/security_refresh.sh" \
  || { printf '%s\n' 'security refresh does not trigger the first-hop audio policy' >&2; exit 1; }
grep -q -- '--audio-policy) refresh_mode=audio-policy' "$repo/scripts/reinstall_services.sh" \
  || { printf '%s\n' 'service refresh does not expose the focused audio policy path' >&2; exit 1; }

printf '%s\n' 'installer, recording, and live stream regression smoke test passed'
