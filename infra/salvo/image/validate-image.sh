#!/usr/bin/env bash
set -euo pipefail

image_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mode="${1:---source}"
python3 "$image_dir/validate.py" "$image_dir/image-manifest.json"

if [[ "$mode" == "--installed" ]]; then
  systemctl is-enabled amazon-ssm-agent.service >/dev/null
  systemctl is-enabled salvo-bootstrap.service >/dev/null
  systemctl is-enabled salvo-tunnel.service >/dev/null
  systemctl is-enabled salvo.service >/dev/null
  systemctl is-enabled salvo-readiness.service >/dev/null
  systemctl is-enabled cloud-final.service >/dev/null
  test -x /opt/salvo/image/readiness-check.sh
  test -x /opt/salvo/runtime/cloudflared
  expected_cloudflared_sha="$(python3 -c 'import json; print(json.load(open("/opt/salvo/image/cloudflared-release.json"))["sha256"])')"
  printf '%s  %s\n' "$expected_cloudflared_sha" /opt/salvo/runtime/cloudflared | sha256sum --check --status
  /opt/salvo/runtime/cloudflared --version | grep -F "cloudflared version 2026.5.2" >/dev/null
elif [[ "$mode" != "--source" ]]; then
  echo "usage: validate-image.sh [--source|--installed]" >&2
  exit 2
fi
