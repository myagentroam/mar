# Managed macVNC

This bundle contains the fixed macVNC source, its input and pointer-coordinate
patch, LibVNCServer source, the topology helper source, and runtime dylibs.
The executable and libraries are signed ad hoc after rewriting non-system
dependencies to relative `@executable_path`/`@loader_path` locations. They
do not require Homebrew or a compiler on the Node. Actual build dependency
versions and third-party notices are recorded in each platform directory.

The bundle was built on macOS 15 GitHub-hosted runners. Its native server
shares the active displays as one framebuffer. Screen Recording and
Accessibility remain subject to macOS permission settings. A two-display
framebuffer and secondary pointer were exercised on an ARM runner with a
virtual second display; this does not establish physical multi-display or
complete product-path acceptance.

Build inputs: compile macVNC with CMake against Homebrew LibVNCServer, apply
`patches/macos-input-cleanup.patch`, bundle with `source/macos-bundle.py`,
and compile `source/macos-topology.c` with the ApplicationServices framework.
This records the observed build, not a claim of bit-for-bit reproducibility.
