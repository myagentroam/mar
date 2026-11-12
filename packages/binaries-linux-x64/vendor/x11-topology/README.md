# X11 topology helper

This first-party helper reads an existing X11 session's XRandR topology and
reports invalidations to its owning Node. It is not a screen-lock or session
safety provider, and it does not start a desktop. Its source and build script
are distributed here under the adjacent Apache-2.0 license. The Debian 12
x86-64 candidate recipe in `../tigervnc/` builds it alongside the matching
managed TigerVNC backend; Node does not compile it at runtime.
