#!/bin/sh
set -eu

runtime_uuid=/run/myagentroam/product_uuid
mkdir -p "$(dirname "$runtime_uuid")"
if [ ! -r /license-host/product_uuid ]; then
  echo 'LICENSE_HOST_UNAVAILABLE: mount the host product UUID read-only.' >&2
  exit 1
fi
install -m 0444 /license-host/product_uuid "$runtime_uuid"
export MAR_LICENSE_HOST_PATH="$runtime_uuid"
export HOME=/home/node
mkdir -p "${MAR_DATA_DIR:-/var/lib/myagentroam}"
chown node:node "${MAR_DATA_DIR:-/var/lib/myagentroam}"

exec setpriv --reuid=node --regid=node --init-groups \
  node /opt/myagentroam/dist/main.js
