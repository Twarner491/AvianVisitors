#!/usr/bin/env bash
# Run as root under systemd in a privileged disposable Debian container.

set -euo pipefail
IFS=$'\n\t'

fail() { echo "FAIL: $*" >&2; exit 1; }

[ -f /.dockerenv ] \
  || fail "refusing Icecast systemd smoke outside a disposable container"
[ "${AVIAN_SYSTEMD_GUARD_TEST:-0}" = 1 ] \
  || fail "refusing Icecast systemd smoke without AVIAN_SYSTEMD_GUARD_TEST=1"
[ "${EUID:-$(id -u)}" -eq 0 ] || fail "test must run as root"
systemctl show-environment >/dev/null 2>&1 \
  || fail "test requires systemd as PID 1"

auth_dir=/var/lib/avian-visitors
admin=/usr/local/sbin/avian-admin-control
guard_dir=/etc/systemd/system/icecast2.service.d
guard=$guard_dir/zz-avian-lan-auth.conf
bird_home=/home/bird
legacy_hash='$2y$14$FJs8skDlFXw6UEyzPutTQuQBPcFdy0iyGDrL3silEC/X6CwX7aOhi'

id caddy >/dev/null 2>&1 \
  || useradd --system --no-create-home --shell /usr/sbin/nologin caddy
id icecast2 >/dev/null 2>&1 \
  || useradd --system --no-create-home --shell /usr/sbin/nologin icecast2
id bird >/dev/null 2>&1 || useradd --create-home --shell /bin/bash bird
mkdir -p "$bird_home/BirdNET-Pi/.git" /etc/birdnet "$auth_dir" "$guard_dir"
printf 'BIRDNET_USER=bird\nEXTRACTED=/srv/avian\n' >/etc/birdnet/birdnet.conf
install -o root -g root -m 0600 /dev/null "$auth_dir/admin-auth.lock"
printf 'v1\t0\t0\t%s\n' "$legacy_hash" >"$auth_dir/admin-auth.state"
chown root:caddy "$auth_dir/admin-auth.state"
chmod 0640 "$auth_dir/admin-auth.state"
printf 'v1\n' >"$auth_dir/admin-auth.initialized"
chmod 0400 "$auth_dir/admin-auth.initialized"
install -o root -g root -m 0755 /source/scripts/admin_control.sh "$admin"
printf '%s\n' \
  '[Service]' \
  'ExecCondition=+/usr/local/sbin/avian-admin-control icecast-start-allowed' \
  >"$guard"
chown root:root "$guard"
chmod 0644 "$guard"

write_policy() {
  printf 'v1\t%s\t%s\t%s\n' "$1" "$2" "$legacy_hash" \
    >"$auth_dir/admin-auth.state"
  chown root:caddy "$auth_dir/admin-auth.state"
  chmod 0640 "$auth_dir/admin-auth.state"
}

cat >/usr/local/sbin/avian-test-native-icecast <<'EOF'
#!/bin/sh
id -u >/tmp/avian-native-main-uid
EOF
chmod 0755 /usr/local/sbin/avian-test-native-icecast
cat >/etc/systemd/system/icecast2.service <<'EOF'
[Unit]
Description=Avian native Icecast guard test

[Service]
Type=oneshot
User=icecast2
ExecStart=/usr/local/sbin/avian-test-native-icecast
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable icecast2 >/dev/null
systemctl start icecast2
[ "$(cat /tmp/avian-native-main-uid)" = "$(id -u icecast2)" ] \
  || fail "native User=icecast2 unit did not run after the privileged condition"

systemctl stop icecast2
rm -f /tmp/avian-native-main-uid
write_policy 1 1
systemctl daemon-reexec
systemctl start icecast2
[ ! -e /tmp/avian-native-main-uid ] \
  || fail "required policy allowed native Icecast after a manager restart"
systemctl is-active --quiet icecast2 \
  && fail "condition-skipped native Icecast was reported active"

write_policy 0 2
systemctl start icecast2
[ "$(cat /tmp/avian-native-main-uid)" = "$(id -u icecast2)" ] \
  || fail "native Icecast did not recover when policy was disabled"
systemctl stop icecast2
systemctl disable icecast2 >/dev/null
rm -f /etc/systemd/system/icecast2.service /tmp/avian-native-main-uid

cat >/etc/init.d/icecast2 <<'EOF'
#!/bin/sh
### BEGIN INIT INFO
# Provides:          icecast2
# Required-Start:    $remote_fs $network
# Required-Stop:     $remote_fs $network
# Default-Start:     2 3 4 5
# Default-Stop:      0 1 6
# Short-Description: Avian SysV Icecast guard test
### END INIT INFO
case "${1:-}" in
  start)
    id -u >/tmp/avian-sysv-main-uid
    touch /run/avian-sysv-icecast-active
    ;;
  stop)
    rm -f /run/avian-sysv-icecast-active
    ;;
  status)
    [ -e /run/avian-sysv-icecast-active ]
    ;;
  *) exit 1 ;;
esac
EOF
chmod 0755 /etc/init.d/icecast2
write_policy 0 3
systemctl daemon-reload
systemctl cat icecast2 | grep -Fq 'SourcePath=/etc/init.d/icecast2' \
  || fail "systemd did not generate the stock SysV Icecast unit"
systemctl cat icecast2 | grep -Fq \
  'ExecCondition=+/usr/local/sbin/avian-admin-control icecast-start-allowed' \
  || fail "SysV Icecast unit lost the Avian condition drop-in"
systemctl start icecast2
[ "$(cat /tmp/avian-sysv-main-uid)" = 0 ] \
  || fail "stock SysV Icecast path did not start under policy off"

systemctl stop icecast2
rm -f /tmp/avian-sysv-main-uid
write_policy 1 4
systemctl daemon-reexec
systemctl start icecast2
[ ! -e /tmp/avian-sysv-main-uid ] \
  || fail "required policy allowed stock SysV Icecast after a manager restart"
systemctl is-active --quiet icecast2 \
  && fail "condition-skipped SysV Icecast was reported active"

echo "Icecast systemd guard smoke: ok"
