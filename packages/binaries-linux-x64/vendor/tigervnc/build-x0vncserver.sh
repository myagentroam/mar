#!/usr/bin/env bash
# Build the pinned, patched source. This does not create a release artifact.
set -euo pipefail

if [[ $# -ne 1 || -e "$1" || -L "$1" ]]; then
  echo 'Usage: bash build-x0vncserver.sh NEW_OUTPUT_PATH' >&2
  exit 2
fi
vendor=$(cd "$(dirname "$0")" && pwd)
destination=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
work=$(mktemp -d "$(dirname "$destination")/.mar-tigervnc-build.XXXXXXXX")
trap 'rm -rf -- "$work"' EXIT
export SOURCE_DATE_EPOCH=1774516873

checks=$(python3 - "$vendor/manifest.json" <<'PY'
import json, pathlib, sys
p = pathlib.Path(sys.argv[1]); manifest = json.loads(p.read_text())
if (manifest['upstreamCommit'] != 'b555312d70d7ff017f866649a7e7167af4eb8fca'
    or manifest['source']['archive'] != 'source/tigervnc-b555312d70d7ff017f866649a7e7167af4eb8fca.tar.gz'
    or [entry['path'] for entry in manifest['patches']] != ['patches/mar-input-cleanup.patch']):
    raise ValueError('Build recipe does not match the pinned manifest.')
for entry in [manifest['source'], *manifest['patches']]:
    name = entry.get('archive', entry.get('path'))
    print(entry['sha256'] + '  ' + str(p.parent / name))
PY
)
printf '%s\n' "$checks" | sha256sum --check --status
mkdir "$work/source"
tar -xzf "$vendor/source/tigervnc-b555312d70d7ff017f866649a7e7167af4eb8fca.tar.gz" -C "$work/source" --strip-components=1
patch -d "$work/source" -p1 < "$vendor/patches/mar-input-cleanup.patch"

cmake_args=(
  -G 'Unix Makefiles' -DCMAKE_BUILD_TYPE=Release -DCMAKE_SKIP_RPATH=ON -DBUILD_TIMESTAMP=source-pinned
  "-DCMAKE_C_FLAGS=${CFLAGS:-} -ffile-prefix-map=$work=/usr/src/mar-tigervnc"
  "-DCMAKE_CXX_FLAGS=${CXXFLAGS:-} -ffile-prefix-map=$work=/usr/src/mar-tigervnc"
  -DBUILD_VIEWER=OFF -DBUILD_JAVA=OFF -DENABLE_H264=OFF -DENABLE_NLS=OFF
  -DENABLE_WAYLAND=OFF -DENABLE_GNUTLS=OFF -DENABLE_NETTLE=OFF
  -DENABLE_PWQUALITY=OFF -DENABLE_SELINUX=OFF -DENABLE_SYSTEMD=OFF
)
if [[ -n ${CMAKE_PREFIX_PATH:-} ]]; then cmake_args+=("-DCMAKE_PREFIX_PATH=$CMAKE_PREFIX_PATH"); fi
if [[ -n ${MAR_TIGERVNC_JPEG_STATIC:-} ]]; then
  if [[ ! -f $MAR_TIGERVNC_JPEG_STATIC || $MAR_TIGERVNC_JPEG_STATIC != /* ]]; then
    echo 'MAR_TIGERVNC_JPEG_STATIC must name an existing absolute archive path.' >&2
    exit 2
  fi
  cmake_args+=("-DJPEG_LIBRARY=$MAR_TIGERVNC_JPEG_STATIC")
fi
cmake -S "$work/source" -B "$work/build" "${cmake_args[@]}"
flags="$work/build/unix/x0vncserver/CMakeFiles/x0vncserver.dir/flags.make"
for feature in HAVE_XTEST HAVE_XRANDR; do
  if ! grep -q -- "-D$feature" "$flags"; then
    echo "Required X11 build capability missing: $feature" >&2
    exit 1
  fi
done
cmake --build "$work/build" --target x0vncserver --parallel "${MAR_BUILD_JOBS:-2}"
ln -- "$work/build/unix/x0vncserver/x0vncserver" "$destination"
