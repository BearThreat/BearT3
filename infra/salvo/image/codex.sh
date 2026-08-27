#!/usr/bin/env bash
set -euo pipefail
exec /opt/salvo/runtime/node/bin/node /opt/salvo/runtime/codex/bin/codex.js "$@"
