#!/usr/bin/env bash
# Runs only in the pinned Debian image, with source mounts read-only.
set -euo pipefail
trap 'chown -R "$OWNER_UID:$OWNER_GID" /out' EXIT
[[ $(dpkg --print-architecture) == amd64 ]]
export DEBIAN_FRONTEND=noninteractive
export LC_ALL=C
export SOURCE_DATE_EPOCH=1774516873

# Snapshot archives remain signed; only their expired validity period is ignored.
cat > /etc/apt/sources.list <<'SOURCES'
deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20261111T180000Z bookworm main
deb-src [check-valid-until=no] http://snapshot.debian.org/archive/debian/20261111T180000Z bookworm main
deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/20261111T180000Z bookworm-security main
SOURCES
rm /etc/apt/sources.list.d/debian.sources
apt-get -o Acquire::Retries=0 -o Acquire::http::Timeout=20 update > /out/apt-update.log 2>&1
apt-get install -y --no-install-recommends \
  build-essential cmake patch python3 pkg-config libpixman-1-dev libx11-dev \
  libxext-dev libxtst-dev libxrandr-dev libjpeg62-turbo-dev zlib1g-dev \
  libpam0g-dev libxdamage-dev libxfixes-dev libxinerama-dev > /out/packages.log 2>&1
dpkg-query -W > /out/installed-packages.txt
diff -u /vendor/bookworm-x64-packages.lock /out/installed-packages.txt
printf '%s\n' '95c321db0af7de626802cbff36926c83c2f04d1081ded19fecd754b8982b3735  /usr/lib/x86_64-linux-gnu/libjpeg.a' | sha256sum --check
cmp /vendor/licenses/libjpeg-turbo-2.1.5/debian-copyright /usr/share/doc/libjpeg62-turbo-dev/copyright
# The base image strips installed documentation. Read the actual archive rather
# than assuming those files were installed, and compare the shipped materials.
cd /tmp
apt-get download 'libjpeg62-turbo-dev=1:2.1.5-2' > /out/jpeg-download.log 2>&1
dpkg-deb -x ./libjpeg62-turbo-dev*.deb /tmp/jpeg-package
gzip -cd /tmp/jpeg-package/usr/share/doc/libjpeg62-turbo-dev/README.ijg.gz | cmp /vendor/licenses/libjpeg-turbo-2.1.5/README.ijg -
gzip -cd /tmp/jpeg-package/usr/share/doc/libjpeg62-turbo-dev/README.md.gz | cmp /vendor/licenses/libjpeg-turbo-2.1.5/README.md -
apt-get source --download-only 'libjpeg-turbo=1:2.1.5-2' > /out/jpeg-source-download.log 2>&1
tar -xOf /tmp/libjpeg-turbo_*orig*.tar* --wildcards '*/LICENSE.md' | cmp /vendor/licenses/libjpeg-turbo-2.1.5/LICENSE.md -

MAR_TIGERVNC_JPEG_STATIC=/usr/lib/x86_64-linux-gnu/libjpeg.a \
  bash /vendor/build-x0vncserver.sh /out/x0vncserver > /out/x0vncserver-build.log 2>&1
bash /topology/build-x11-topology.sh /out/x11-topology > /out/x11-topology-build.log 2>&1
for component in x0vncserver x11-topology; do
  readelf -d "/out/$component" > "/out/$component.dynamic.txt"
  readelf --version-info "/out/$component" > "/out/$component.versions.txt"
  ldd "/out/$component" > "/out/$component.ldd.txt"
done
sha256sum /out/x0vncserver /out/x11-topology > /out/SHA256SUMS
