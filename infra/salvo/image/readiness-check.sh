#!/usr/bin/env bash
set -euo pipefail

endpoint="${SALVO_READINESS_ENDPOINT:-http://127.0.0.1:4318/ready}"
for attempt in $(seq 1 15); do
  if curl --fail --silent --show-error --max-time 2 "$endpoint" >/dev/null &&
     curl --fail --silent --show-error --max-time 2 http://127.0.0.1:49312/ready >/dev/null; then
    install -d -m 0755 /run/salvo
    printf '%s\n' ready > /run/salvo/image-ready
    exit 0
  fi
  sleep 2
done
exit 1
