#!/bin/sh
set -eu
umask 077

for name in bootstrap-token bootstrap-url sandbox-id user-id client-token; do
  test -s "/run/salvo/$name" || { echo "missing bootstrap input: $name" >&2; exit 1; }
done

install -d -m 0750 -o salvo -g salvo /etc/salvo /var/lib/salvo
payload=$(jq -cn \
  --arg token "$(cat /run/salvo/bootstrap-token)" \
  --arg sandboxId "$(cat /run/salvo/sandbox-id)" \
  --arg userId "$(cat /run/salvo/user-id)" \
  --arg clientToken "$(cat /run/salvo/client-token)" \
  '{token:$token,sandboxId:$sandboxId,userId:$userId,clientToken:$clientToken}')
response=$(curl --fail-with-body --silent --show-error --proto '=https' --tlsv1.2 \
  -H 'content-type: application/json' --data-binary "$payload" "$(cat /run/salvo/bootstrap-url)")
staging=$(mktemp -d /etc/salvo/.bootstrap.XXXXXX)
trap 'rm -rf "$staging"' EXIT
printf '%s' "$response" | jq -er '.controlSecret | strings | select(length >= 32)' > "$staging/control-secret"
printf '%s' "$response" | jq -er '.tunnelToken | strings | select(length >= 32)' > "$staging/tunnel-token"
printf '%s' "$response" | jq -er '.tunnelEndpoint | strings | select(startswith("https://"))' > "$staging/tunnel-endpoint"
printf '%s' "$response" | jq -er '.environment | strings' > "$staging/sandbox.env"
chown root:salvo "$staging"/*
chmod 0640 "$staging"/*
for name in control-secret tunnel-token tunnel-endpoint sandbox.env; do mv -f "$staging/$name" "/etc/salvo/$name"; done
trap - EXIT
rmdir "$staging"
find /run/salvo -type f -exec shred -u {} +
