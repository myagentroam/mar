# UltraVNC Server

The Windows x64 target contains a patched UltraVNC 1.8.3.2 server and two
unmodified support DLLs from the upstream ZIP identified in the manifest.
`ultravnc.portable` selects application mode; Node supplies a private
configuration with loopback-only TCP listening and VNC authentication. No
system service or display driver is installed.

The included source snapshot is upstream's commit titled `1.8.3.2`; its
version correspondence does not establish byte-for-byte provenance of the
official executable. The upstream GPL-3.0-or-later license is included.
Direct PE imports were inspected, and the runtime was exercised on a Windows
2025 runner before the patch; this does not prove all possible dynamically
loaded dependencies.
The `licenses` directory also preserves notices for libraries listed by the
corresponding upstream source and its build inputs; that list is not a claim
about the exact build provenance of the official executable.

## MyAgentRoam modification (2026-11-28)

The upstream UDP Echo listener binds all IPv4 interfaces even when
`LoopbackOnly` is enabled. Node uses only TCP RFB and does not need UDP Echo.
The bundled server was patched without recompiling: only file offset
`0x35c10` was changed from `40` to `c3`, making `UdpEchoServer` return before
it initializes Winsock. Apply this edit only to upstream `winvnc.exe` with
SHA-256 `7ab89d79e519b31f4c972dd0d28454f430ce8ece00988d7ae2eb5c424fd7491b`.
`serverSha256` in the manifest identifies the patched executable. The edit
invalidates the original Authenticode signature; do not treat it as signed
by the upstream publisher.

For a source build, normalize `UdpEchoServer.cpp` to LF before applying the
equivalent change below, which omits the UDP Echo thread:

```diff
--- a/winvnc/winvnc/UdpEchoServer.cpp
+++ b/winvnc/winvnc/UdpEchoServer.cpp
@@ -18,5 +18,4 @@
-void StartEchoServer(int port)
+void StartEchoServer(int /*port*/)
 {
-    std::thread serverThread(UdpEchoServer, port); // Pass port number as argument
-    serverThread.detach(); // Wait for the server thread to finish
+    // Node uses only TCP RFB; do not start the non-loopback UDP listener.
 }
```
