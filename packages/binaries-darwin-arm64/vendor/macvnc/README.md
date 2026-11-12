# Managed macVNC

This bundle contains the fixed macVNC source, its input and pointer-coordinate
patch, LibVNCServer source, the topology helper source, and runtime dylibs.
The executable and libraries are signed ad hoc after rewriting non-system
dependencies to relative `@executable_path`/`@loader_path` locations. They
do not require Homebrew or a compiler on the Node. Actual build dependency
versions and third-party notices are recorded in each platform directory.

The bundle was built on macOS 15 GitHub-hosted runners. The native server
captures one display per process: the primary by default, or the display
selected with `-display <index>`. It does not combine active displays. The Node
uses independent per-display backends for screen selection; switching one page
does not change another page's capture. Screen Recording and Accessibility
remain subject to macOS permission settings. Physical multi-display acceptance
requires an explicit native desktop test; source and adapter tests are not a
substitute for that verification.

Build inputs: compile macVNC with CMake against Homebrew LibVNCServer, apply
`patches/macos-input-cleanup.patch`, bundle with `source/macos-bundle.py`,
and compile `source/macos-topology.c` with the ApplicationServices framework.
This records the observed build, not a claim of bit-for-bit reproducibility.
