#!/usr/bin/env bash
# Keep the AvianVisitors webroot overlay identical after install and data reset.

_avian_check_link() {
  local source_path="${1:?source_path required}"
  local target_path="${2:?target_path required}"

  if [ ! -e "${source_path}" ]; then
    echo "Missing webroot source: ${source_path}" >&2
    return 1
  fi
  if [ -d "${target_path}" ] && [ ! -L "${target_path}" ]; then
    echo "Refusing to replace directory: ${target_path}" >&2
    return 1
  fi
}

_avian_link_one() {
  local run_user="${1:?run_user required}"
  local source_path="${2:?source_path required}"
  local target_path="${3:?target_path required}"

  _avian_check_link "${source_path}" "${target_path}" || return 1
  sudo -u "${run_user}" ln -sfn "${source_path}" "${target_path}"
}

link_avian_visitors_webroot() {
  local repo_dir="${1:?repo_dir required}"
  local web_root="${2:?web_root required}"
  local run_user="${3:?run_user required}"
  local frontend_dir="${repo_dir}/avian/frontend"
  local -a sources targets
  local index

  [[ "${repo_dir}" =~ ^/[A-Za-z0-9._/-]+$ ]] && [[ "${repo_dir}" != *'..'* ]] \
    || { echo "Invalid repository path" >&2; return 1; }
  [[ "${web_root}" =~ ^/[A-Za-z0-9._/-]+$ ]] && [[ "${web_root}" != *'..'* ]] \
    || { echo "Invalid webroot path" >&2; return 1; }
  [[ "${run_user}" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] && getent passwd "${run_user}" >/dev/null \
    || { echo "Invalid webroot user" >&2; return 1; }

  if [ ! -d "${repo_dir}/avian" ]; then
    _avian_link_one "${run_user}" \
      "${repo_dir}/homepage/images/favicon.ico" "${web_root}/favicon.ico"
    return
  fi

  # Production manifest. Keep the root-level links explicit. The managed
  # Caddy policy limits the avian directory link to reviewed API endpoints
  # and static artwork, so private tooling is not served from this path.
  sources=(
    "${repo_dir}/avian"
    "${frontend_dir}/index.html"
    "${frontend_dir}/styles.css"
    "${frontend_dir}/apt.js"
    "${frontend_dir}/masks.json"
    "${frontend_dir}/dims.json"
    "${frontend_dir}/nest.webp"
    "${frontend_dir}/nest-eggs.webp"
    "${frontend_dir}/stamps.css"
    "${frontend_dir}/stamps.js"
    "${frontend_dir}/stamp-batch-root.css"
    "${frontend_dir}/stamp-batch-root.js"
    "${frontend_dir}/stamp-batch-a.css"
    "${frontend_dir}/stamp-batch-a.js"
    "${frontend_dir}/stamp-batch-b.css"
    "${frontend_dir}/stamp-batch-b.js"
    "${frontend_dir}/stamp-batch-c.css"
    "${frontend_dir}/stamp-batch-c.js"
    "${frontend_dir}/grain.png"
    "${frontend_dir}/stats-press.png"
    "${frontend_dir}/fonts"
    "${frontend_dir}/assets"
    "${repo_dir}/avian/assets/favicon.png"
    "${repo_dir}/avian/assets/favicon.png"
  )
  targets=(
    "avian"
    "index.html"
    "styles.css"
    "apt.js"
    "masks.json"
    "dims.json"
    "nest.webp"
    "nest-eggs.webp"
    "stamps.css"
    "stamps.js"
    "stamp-batch-root.css"
    "stamp-batch-root.js"
    "stamp-batch-a.css"
    "stamp-batch-a.js"
    "stamp-batch-b.css"
    "stamp-batch-b.js"
    "stamp-batch-c.css"
    "stamp-batch-c.js"
    "grain.png"
    "stats-press.png"
    "fonts"
    "assets"
    "favicon.png"
    "favicon.ico"
  )

  if [ "${#sources[@]}" -ne "${#targets[@]}" ]; then
    echo "Invalid AvianVisitors webroot manifest" >&2
    return 1
  fi

  # Validate the complete manifest before changing anything. A missing release
  # asset or a real directory at a target path leaves the webroot untouched.
  for index in "${!sources[@]}"; do
    _avian_check_link "${sources[$index]}" "${web_root}/${targets[$index]}" \
      || return 1
  done
  for index in "${!sources[@]}"; do
    _avian_link_one "${run_user}" \
      "${sources[$index]}" "${web_root}/${targets[$index]}" || return 1
  done
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  if [ "$#" -eq 3 ]; then
    link_avian_visitors_webroot "$1" "$2" "$3"
    exit
  fi
  [ "$#" -eq 0 ] || { echo "Usage: $0 [repo webroot user]" >&2; exit 64; }
  conf=/etc/birdnet/birdnet.conf
  [ -r "$conf" ] || { echo "BirdNET-Pi config was not found" >&2; exit 1; }
  birdnet_user=$(awk -F= '/^[[:space:]]*BIRDNET_USER[[:space:]]*=/ {
    value=$0; sub(/^[^=]*=/, "", value); gsub(/^[[:space:]"\047 ]+|[[:space:]"\047 ]+$/, "", value); print value; exit
  }' "$conf")
  extracted=$(awk -F= '/^[[:space:]]*EXTRACTED[[:space:]]*=/ {
    value=$0; sub(/^[^=]*=/, "", value); gsub(/^[[:space:]"\047 ]+|[[:space:]"\047 ]+$/, "", value); print value; exit
  }' "$conf")
  home_dir=$(getent passwd "$birdnet_user" | cut -d: -f6)
  link_avian_visitors_webroot "$home_dir/BirdNET-Pi" "$extracted" "$birdnet_user"
fi
