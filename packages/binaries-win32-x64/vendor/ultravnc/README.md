# UltraVNC Server

The Windows x64 target contains the official UltraVNC 1.8.3.2 server and its
two bundled support DLLs, extracted from the upstream ZIP identified in the
manifest. `ultravnc.portable` selects application mode; Node supplies a private
configuration with loopback-only listening and VNC authentication. No system
service or display driver is installed.

The included source snapshot is upstream's commit titled `1.8.3.2`; its
version correspondence does not establish byte-for-byte provenance of the
official executable. The upstream GPL-3.0-or-later license is included.
Direct PE imports were inspected, and the runtime was exercised on a Windows
2025 runner; this does not prove all possible dynamically loaded dependencies.
The `licenses` directory also preserves notices for libraries listed by the
corresponding upstream source and its build inputs; that list is not a claim
about the exact build provenance of the official executable.
