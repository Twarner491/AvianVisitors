# this should only contain functions and assignments, ie source install.sh should not have side effects.

get_tf_whl () {
  BASE_URL=https://github.com/Nachtzuster/BirdNET-Pi/releases/download/v0.1/

  ARCH=$(uname -m)
  PY_VERSION=$(python3 -c "import sys; print(f'{sys.version_info[0]}{sys.version_info[1]}')")
  case "${ARCH}-${PY_VERSION}" in
    aarch64-39)
      WHL=tflite_runtime-2.11.0-cp39-none-linux_aarch64.whl
      ;;
    aarch64-311)
      WHL=tflite_runtime-2.17.1-cp311-cp311-linux_aarch64.whl
      ;;
    aarch64-312)
      WHL=tflite_runtime-2.17.1-cp312-cp312-linux_aarch64.whl
      ;;
    aarch64-313)
      WHL=tflite_runtime-2.17.1-cp313-cp313-linux_aarch64.whl
      ;;
    x86_64-39)
      WHL=tflite_runtime-2.11.0-cp39-cp39-linux_x86_64.whl
      ;;
    x86_64-311)
      WHL=tflite_runtime-2.17.1-cp311-cp311-linux_x86_64.whl
      ;;
    x86_64-312)
      WHL=tflite_runtime-2.17.1-cp312-cp312-linux_x86_64.whl
      ;;
    x86_64-313)
      WHL=tflite_runtime-2.17.1-cp313-cp313-linux_x86_64.whl
      ;;
    *)
      echo "No tflite version found for ${ARCH}-${PY_VERSION}"
      WHL=''
      ;;
  esac
  if [ -n "$WHL" ]; then
    {
      curl -L -o $HOME/BirdNET-Pi/$WHL $BASE_URL$WHL
      sed "s/tensorflow.*/$WHL/" $HOME/BirdNET-Pi/requirements.txt > requirements_custom.txt
    }
  fi
}

install_birdnet_mount() {
  TMP_MOUNT=$(systemd-escape -p --suffix=mount "$RECS_DIR/StreamData")
  cat << EOF > $HOME/BirdNET-Pi/templates/$TMP_MOUNT
[Unit]
Description=Birdnet tmpfs for transient files
ConditionPathExists=$RECS_DIR/StreamData

[Mount]
What=tmpfs
Where=$RECS_DIR/StreamData
Type=tmpfs
Options=mode=1777,nosuid,nodev

[Install]
WantedBy=multi-user.target
EOF
  ln -sf $HOME/BirdNET-Pi/templates/$TMP_MOUNT /usr/lib/systemd/system
}

install_tmp_mount() {
  local source=${1:-/usr/share/systemd/tmp.mount}
  local target=${2:-/etc/systemd/system/tmp.mount}
  local state state_status

  if state=$(LC_ALL=C systemctl is-enabled tmp.mount 2>&1); then
    state_status=0
  else
    state_status=$?
  fi

  case "$state" in
    enabled|enabled-runtime|disabled|static|masked|masked-runtime|indirect|generated|linked|linked-runtime|alias)
      echo "tmp.mount is $state, skipping"
      return 0
      ;;
    not-found|'Failed to get unit file state for tmp.mount: No such file or directory')
      ;;
    *)
      printf 'Could not inspect tmp.mount (status %s): %s\n' \
        "$state_status" "${state:-no response from systemctl}" >&2
      return 1
      ;;
  esac

  if [ ! -f "$source" ] || [ -L "$source" ]; then
    printf 'Cannot install tmp.mount: vendor unit is missing or unsafe: %s\n' \
      "$source" >&2
    return 1
  fi
  if [ -e "$target" ] || [ -L "$target" ]; then
    printf 'Cannot install tmp.mount: target already exists: %s\n' \
      "$target" >&2
    return 1
  fi

  cp -- "$source" "$target"
  systemctl daemon-reload
  systemctl enable tmp.mount
}
