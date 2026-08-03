#!/usr/bin/env bash
# Shared web-root link helper for BirdNET-Pi plus AvianVisitors installs.
#
# The BirdNET-Pi installer and clear_all_data.sh both recreate links in
# ${EXTRACTED}. Keep the AvianVisitors overlay links here so the two paths do
# not drift: / should serve avian/frontend/index.html, while the stock UI stays
# available at /index.php.

_avian_link_one() {
  local run_user="${1:?run_user required}"
  local source_path="${2:?source_path required}"
  local target_path="${3:?target_path required}"

  if [ ! -e "${source_path}" ]; then
    echo "Missing webroot source: ${source_path}" >&2
    return 1
  fi
  if [ -d "${target_path}" ] && [ ! -L "${target_path}" ]; then
    echo "Refusing to replace directory: ${target_path}" >&2
    return 1
  fi
  sudo -u "${run_user}" ln -sfn "${source_path}" "${target_path}"
}

link_avian_visitors_webroot() {
  local repo_dir="${1:?repo_dir required}"
  local web_root="${2:?web_root required}"
  local run_user="${3:?run_user required}"

  if [ -d "${repo_dir}/avian" ]; then
    _avian_link_one "${run_user}" "${repo_dir}/avian"                     "${web_root}/avian" || return 1
    _avian_link_one "${run_user}" "${repo_dir}/avian/frontend/index.html" "${web_root}/index.html" || return 1
    _avian_link_one "${run_user}" "${repo_dir}/avian/frontend/styles.css" "${web_root}/styles.css" || return 1
    _avian_link_one "${run_user}" "${repo_dir}/avian/frontend/apt.js"     "${web_root}/apt.js" || return 1
    _avian_link_one "${run_user}" "${repo_dir}/avian/frontend/masks.json" "${web_root}/masks.json" || return 1
    _avian_link_one "${run_user}" "${repo_dir}/avian/frontend/dims.json"  "${web_root}/dims.json" || return 1
    _avian_link_one "${run_user}" "${repo_dir}/avian/frontend/nest.webp"  "${web_root}/nest.webp" || return 1
    _avian_link_one "${run_user}" "${repo_dir}/avian/assets/favicon.png"  "${web_root}/favicon.png" || return 1
    # favicon.ico -> AvianVisitors PNG when the overlay is present (modern
    # browsers accept image/png for the .ico path); fall back to the stock
    # BirdNET-Pi favicon.ico otherwise so plain installs still get an icon.
    _avian_link_one "${run_user}" "${repo_dir}/avian/assets/favicon.png" "${web_root}/favicon.ico" || return 1
  else
    _avian_link_one "${run_user}" "${repo_dir}/homepage/images/favicon.ico" "${web_root}/favicon.ico" || return 1
  fi
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  source /etc/birdnet/birdnet.conf
  link_avian_visitors_webroot "/home/${BIRDNET_USER}/BirdNET-Pi" "${EXTRACTED}" "${BIRDNET_USER}"
fi
