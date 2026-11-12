#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 1 || $1 != /* ]]; then
  echo 'Usage: build-x11-topology.sh /absolute/path/to/new-output' >&2
  exit 2
fi
output=$1
directory=$(dirname "$output")
if [[ ! -d $directory || -e $output || -L $output ]]; then
  echo 'Output directory must exist and the output must not already exist.' >&2
  exit 2
fi
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
temporary=$(mktemp "$directory/.mar-x11-topology.XXXXXXXX")
trap 'rm -f -- "$temporary"' EXIT
pkg_cflags=$(pkg-config --cflags x11 xrandr)
pkg_libraries=$(pkg-config --libs x11 xrandr)
read -r -a cflags <<< "$pkg_cflags"
read -r -a libraries <<< "$pkg_libraries"
"${CC:-cc}" -std=c11 -O2 -Wall -Wextra -Werror "${cflags[@]}" \
  "$source_dir/x11-topology.c" "${libraries[@]}" -o "$temporary"
chmod 755 "$temporary"
# A hard link publishes only into the requested previously absent path.
ln -- "$temporary" "$output"
