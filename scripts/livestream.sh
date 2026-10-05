#!/usr/bin/env bash
# Live Audio Stream Service Script
source /etc/birdnet/birdnet.conf

if [ "${1:-}" = '--check' ] && [ "$#" -eq 1 ]; then
  if [ -z "${RTSP_STREAM:-}" ]; then
    case "${REC_CARD:-}" in
      hw:*|plughw:*) exit 1 ;;
    esac
  fi
  exit 0
elif [ "$#" -ne 0 ]; then
  echo 'Usage: livestream.sh [--check]' >&2
  exit 64
fi

ensure_pulseaudio() {
  if ! pulseaudio --check; then
    pulseaudio --start
  fi
}

# Read the logging level from the configuration option
LOGGING_LEVEL="${LogLevel_LiveAudioStreamService}"
# If empty for some reason default to log level of error
[ -z $LOGGING_LEVEL ] && LOGGING_LEVEL='error'
# Additionally if we're at debug or info level then allow printing of script commands and variables
if [ "$LOGGING_LEVEL" == "info" ] || [ "$LOGGING_LEVEL" == "debug" ];then
  # Enable printing of commands/variables etc to terminal for debugging
  set -x
fi

FREQSHIFT_OPT=''
if [ "$ACTIVATE_FREQSHIFT_IN_LIVESTREAM" == "true" ]; then
  FREQSHIFT_OPT='-af rubberband=pitch='${FREQSHIFT_LO}'/'${FREQSHIFT_HI}
fi

if [[ -n "${RTSP_STREAM:-}" ]];then
  # Explode the RSPT steam setting into an array so we can count the number we have
  RSTP_STREAMS_EXPLODED_ARRAY=(${RTSP_STREAM//,/ })

  # If for some reason the RTSP_STREAM_TO_LIVESTREAM is not set, then init it to 0 to use the first stream
  if [[ -z ${RTSP_STREAM_TO_LIVESTREAM} ]];then
    RTSP_STREAM_TO_LIVESTREAM=0
  fi

  # Get the RSTP stream at the specified array index
  SELECTED_RSTP_STREAM=${RSTP_STREAMS_EXPLODED_ARRAY[RTSP_STREAM_TO_LIVESTREAM]}

  # If for some reason the RTSP stream url is null
  if [[ -z ${SELECTED_RSTP_STREAM} ]];then
    # Try select the first stream
    SELECTED_RSTP_STREAM=${RSTP_STREAMS_EXPLODED_ARRAY[0]}
  fi

  ffmpeg -nostdin -loglevel $LOGGING_LEVEL -ac ${CHANNELS} -i ${SELECTED_RSTP_STREAM} -acodec libmp3lame \
    -b:a 320k -ac ${CHANNELS} -content_type 'audio/mpeg' \
    ${FREQSHIFT_OPT} \
    -f mp3 icecast://source:${ICE_PWD}@localhost:8000/stream -re
else
  case "${REC_CARD:-}" in
    hw:*|plughw:*)
      echo "Live stream disabled: ${REC_CARD} is reserved for bird recording"
      exit 0
      ;;
    ''|default|pulse)
      ensure_pulseaudio
      ;;
  esac
  CAPTURE_DEVICE=${REC_CARD:-default}
	ffmpeg -nostdin -loglevel $LOGGING_LEVEL -ac ${CHANNELS} -f alsa -i "${CAPTURE_DEVICE}" -acodec libmp3lame \
    -b:a 320k -ac ${CHANNELS} -content_type 'audio/mpeg' \
    ${FREQSHIFT_OPT} \
    -f mp3 icecast://source:${ICE_PWD}@localhost:8000/stream -re
fi
