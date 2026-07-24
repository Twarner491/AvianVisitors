#!/usr/bin/env bash
# Shared web-root link helper for BirdNET-Pi plus AvianVisitors installs.
#
# The BirdNET-Pi installer and clear_all_data.sh both recreate links in
# ${EXTRACTED}. Keep the AvianVisitors overlay links here so the two paths do
# not drift: / should serve avian/frontend/index.html, while the stock UI stays
# available at /index.php.

link_avian_visitors_webroot() {
  local repo_dir="${1:?repo_dir required}"
  local web_root="${2:?web_root required}"
  local run_user="${3:?run_user required}"

  if [ -d "${repo_dir}/avian" ]; then
    sudo -u "${run_user}" ln -fs "${repo_dir}/avian"                    "${web_root}/avian"
    sudo -u "${run_user}" ln -fs "${repo_dir}/avian/frontend/index.html" "${web_root}/index.html"
    sudo -u "${run_user}" ln -fs "${repo_dir}/avian/frontend/styles.css" "${web_root}/styles.css"
    sudo -u "${run_user}" ln -fs "${repo_dir}/avian/frontend/apt.js"     "${web_root}/apt.js"
    sudo -u "${run_user}" ln -fs "${repo_dir}/avian/frontend/masks.json" "${web_root}/masks.json"
    sudo -u "${run_user}" ln -fs "${repo_dir}/avian/frontend/dims.json"  "${web_root}/dims.json"
    sudo -u "${run_user}" ln -fs "${repo_dir}/avian/frontend/nest.webp"  "${web_root}/nest.webp"
    sudo -u "${run_user}" ln -fs "${repo_dir}/avian/assets/favicon.png"  "${web_root}/favicon.png"
    # favicon.ico -> AvianVisitors PNG when the overlay is present (modern
    # browsers accept image/png for the .ico path); fall back to the stock
    # BirdNET-Pi favicon.ico otherwise so plain installs still get an icon.
    sudo -u "${run_user}" ln -fs "${repo_dir}/avian/assets/favicon.png"  "${web_root}/favicon.ico"
  else
    sudo -u "${run_user}" ln -fs "${repo_dir}/homepage/images/favicon.ico" "${web_root}"
  fi
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  source /etc/birdnet/birdnet.conf
  link_avian_visitors_webroot "/home/${BIRDNET_USER}/BirdNET-Pi" "${EXTRACTED}" "${BIRDNET_USER}"
fi
