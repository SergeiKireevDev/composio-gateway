#!/bin/sh
set -eu
mkdir -p "${DATA_DIR:-/data}"
chown node:node "${DATA_DIR:-/data}"
chmod 700 "${DATA_DIR:-/data}"
exec runuser -u node -- "$@"
