#!/usr/bin/env bash
# Isolated candidate build, not a release or an assertion of Linux compatibility.
set -euo pipefail

if [[ $# != 1 || $1 != /* || -e $1 || -L $1 || ! -d $(dirname "$1") ]]; then
  echo 'Usage: build-linux-bookworm-x64.sh /absolute/path/to/new-directory' >&2
  exit 2
fi
vendor=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
topology=$(cd -- "$vendor/../x11-topology" && pwd)
image='debian@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc'
mkdir -m 700 -- "$1"
output=$(cd -- "$1" && pwd)

# The image is fetched explicitly by the operator; an unavailable input must
# fail rather than silently resolve a new tag. Only the new directory is writable.
docker run --rm --init --pull=never --platform=linux/amd64 \
  --mount "type=bind,src=$vendor,dst=/vendor,readonly" \
  --mount "type=bind,src=$topology,dst=/topology,readonly" \
  --mount "type=bind,src=$output,dst=/out" \
  -e "OWNER_UID=$(id -u)" -e "OWNER_GID=$(id -g)" \
  "$image" bash /vendor/bookworm-x64-build-in-container.sh
