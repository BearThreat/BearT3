#!/usr/bin/env bash
set -euo pipefail

test "$(id -u)" -eq 0
id salvo >/dev/null 2>&1 || useradd --system --create-home --shell /sbin/nologin salvo
install -d -o salvo -g salvo -m 0750 /var/lib/salvo /var/log/salvo
install -d -o root -g salvo -m 0750 /etc/salvo
install -D -m 0644 /opt/salvo/image/systemd/salvo.service /etc/systemd/system/salvo.service
install -D -m 0644 /opt/salvo/image/systemd/salvo-bootstrap.service /etc/systemd/system/salvo-bootstrap.service
install -D -m 0644 /opt/salvo/image/systemd/salvo-tunnel.service /etc/systemd/system/salvo-tunnel.service
install -D -m 0644 /opt/salvo/image/systemd/salvo-readiness.service /etc/systemd/system/salvo-readiness.service
install -D -m 0755 /opt/salvo/image/codex.sh /opt/salvo/runtime/bin/codex
install -D -m 0755 /opt/salvo/image/salvo-bootstrap.sh /usr/local/libexec/salvo-bootstrap
systemctl enable amazon-ssm-agent.service salvo-bootstrap.service salvo.service salvo-tunnel.service salvo-readiness.service
rm -rf /var/lib/cloud/instances/*
find /var/log -type f -exec truncate -s 0 {} +
rm -f /etc/ssh/ssh_host_*
systemctl daemon-reload
