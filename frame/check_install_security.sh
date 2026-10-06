#!/bin/sh
set -eu

frame_dir=$(CDPATH='' cd -P -- "$(dirname -- "$0")" && pwd -P)
image_name=${AVIAN_INSTALL_SECURITY_IMAGE:-avian-frame-install-security:local}

docker build \
  --file "$frame_dir/Dockerfile.install-security" \
  --tag "$image_name" \
  "$frame_dir"
docker run --rm \
  "$image_name" \
  /usr/bin/apt-get -qq --simulate install --no-install-recommends \
    python3-venv \
    python3-dev \
    build-essential \
    libatlas3-base \
    util-linux \
    xvfb \
    fonts-noto-color-emoji \
    fonts-unifont \
    libfontconfig1 \
    libfreetype6 \
    xfonts-scalable \
    fonts-liberation \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-tlwg-loma-otf \
    fonts-freefont-ttf \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2
docker run --rm \
  --volume "$frame_dir/..:/source:ro" \
  "$image_name" \
  shellcheck \
    /source/frame/install.sh \
    /source/frame/avian-bundle \
    /source/frame/avian-bundle-installed \
    /source/frame/check_install_security.sh \
    /source/frame/vendor/avian-bundle-control
docker run --rm \
  --volume "$frame_dir/..:/source:ro" \
  --workdir /source/frame \
  --env AVIAN_BIRDFRAME_INSTALL_CONTAINER_TEST=1 \
  --env PYTHONDONTWRITEBYTECODE=1 \
  "$image_name" \
  python3 -m unittest -v \
    test_install_security \
    test_ebird_credentials \
    test_bundle_render_integration.FrameBundleRenderIntegrationTests.test_installed_symlink_launcher_resolves_checkout_and_preserves_argv \
    test_bundle_render_integration.FrameBundleRenderIntegrationTests.test_checkout_launcher_refuses_to_execute_control_as_root \
    test_bundle_render_integration.FrameBundleRenderIntegrationTests.test_root_owned_installed_launcher_drops_before_checkout_control \
    test_bundle_render_integration.FrameBundleRenderIntegrationTests.test_installed_launcher_forces_numeric_uid_resolution \
    test_bundle_render_integration.FrameBundleRenderIntegrationTests.test_installed_launcher_rejects_root_or_noncanonical_sudo_uid \
    test_bundle_render_integration.FrameBundleRenderIntegrationTests.test_installed_launcher_rejects_uid_other_than_control_owner \
    test_bundle_render_integration.FrameBundleRenderIntegrationTests.test_installed_launcher_rejects_control_not_owned_by_bound_user \
    test_bundle_render_integration.FrameBundleRenderIntegrationTests.test_installed_launcher_blocks_nested_sudo_from_mutable_control \
    test_bundle_render_integration.FrameBundleRenderIntegrationTests.test_nonroot_installed_launcher_blocks_nested_sudo \
    test_bundle_render_integration.FrameBundleRenderIntegrationTests.test_checkout_launcher_blocks_nested_sudo_when_setpriv_is_available \
    test_bundle_render_integration.FrameBundleRenderIntegrationTests.test_nonroot_installed_launcher_is_bound_to_persisted_owner \
    test_bundle_render_integration.FrameBundleRenderIntegrationTests.test_installed_launcher_rejects_writable_control_modes
