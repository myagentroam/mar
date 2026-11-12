# TigerVNC source and MAR patch

This directory contains the fixed TigerVNC source, the MAR-specific Linux
input-cleanup and managed-parent-lifetime patch, and a Debian 12 x86-64 target.
The source and patch are distributed under the upstream license; see
`LICENCE.TXT` and the source archive.

Apply `patches/mar-input-cleanup.patch` with `patch -p1` at the extracted source
root. Build `x0vncserver` with the upstream CMake build and the target system's
X11, XTest, and other required development libraries. Target artifacts must
also record their build dependencies, licenses, and verification before being
added to the manifest. Local packaging is not a release.

`bash build-x0vncserver.sh NEW_OUTPUT_PATH` checks the fixed source and patch,
builds the patched server with XTest and XRandR required, and refuses to
overwrite an existing output. `CMAKE_PREFIX_PATH` can select an isolated build
dependency prefix. This recipe does not bundle dynamic libraries or establish
target ABI compatibility; those and release licensing remain separate checks.

The private MAR registration and control channel are used only between the
owning Node and its managed backend. A successful native receipt means the
backend's cleanup requests were accepted by the X server; Node must still fence
its RFB stream and manage its own control lease.

## Debian 12 x86-64 target

`bash build-linux-bookworm-x64.sh /absolute/path/to/new-directory` builds both
the patched server and the first-party `../x11-topology` helper in an isolated
container. Pull the Debian image at the digest in the script first. The recipe
uses signed Debian snapshots at `20261111T180000Z`, a fixed image digest and
`bookworm-x64-packages.lock`; it refuses an unexpected installed package set.
It also checks the exact `libjpeg.a` and the actual accompanying license texts.
The input snapshots must remain available; a missing or changed input is a build
failure, not permission to use newer packages. Only the new output directory is
writable by the build. Outputs and diagnostic logs are candidates, not releases.

This candidate is built for Debian 12 amd64, not generic Linux. Its own direct
symbol requirements reach GLIBC_2.34 for both programs and GLIBCXX_3.4.21 for
the server. The server dynamically needs `libXtst.so.6`, `libXdamage.so.1`,
`libXfixes.so.3`, `libXrandr.so.2`, `libX11.so.6`, `libXext.so.6`, `libz.so.1`,
`libpixman-1.so.0`, `libpam.so.0`, `libstdc++.so.6`, `libgcc_s.so.1`, libc and
the system loader. The helper directly needs `libX11.so.6`, `libXrandr.so.2`
and libc. The target also needs compatible transitive system libraries; an ELF
symbol floor alone does not establish compatibility. JPEG is statically linked
from Debian `libjpeg62-turbo-dev` version `1:2.1.5-2`, not fetched or installed
at Node runtime.

The source archive, MAR patch and GPL material are under this directory; the
actual JPEG copyright and README materials from that package are under
`licenses/libjpeg-turbo-2.1.5/`. The helper source, build script and Apache
license are in `../x11-topology/`. A distribution of the generated executables
must include the applicable materials, not just these output files. The local
`linux-x64` target contains the tested Debian 12 build and requires the system
libraries above; it is neither self-contained nor a promise of compatibility
with every Linux distribution. Real physical multi-display behavior remains
unverified. An unavailable pre-lock event does not itself prevent using an
accessible X11 desktop.

When a target has passed distribution validation, its manifest entry is keyed
by Node platform and architecture (for example `linux-x64`) and contains
`server` and `topology` paths relative to this directory. Both executables and
their required license materials must be present in the package.

The generated x0vncserver is based in part on the work of the Independent JPEG
Group.
