#!/bin/sh
set -eu
# The native Fly launcher supplies FLY_APP_NAME. Derive the public origin
# without requiring a workflow or trusting the incoming Host header.
# An explicit PUBLIC_URL still wins (for custom domains).
if [ -z "${PUBLIC_URL:-}" ] && [ -n "${FLY_APP_NAME:-}" ]; then
  case "$FLY_APP_NAME" in
    *[!a-z0-9-]*|-*|*-)
      echo 'Invalid FLY_APP_NAME' >&2
      exit 1
      ;;
  esac
  export PUBLIC_URL="https://${FLY_APP_NAME}.fly.dev"
fi
mkdir -p "${DATA_DIR:-/data}"
chown node:node "${DATA_DIR:-/data}"
chmod 700 "${DATA_DIR:-/data}"
exec runuser -u node -- "$@"
