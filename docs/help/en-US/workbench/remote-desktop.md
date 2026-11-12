---
title: View a Node Remote Desktop
lastUpdated: 2026-11-12
---

# View a Node Remote Desktop

Remote Desktop shows the current interactive desktop of an authorized Node without selecting a Workspace. It does not create a new operating-system login, transfer files, or elevate privileges.

The bundled Linux x64 backend is built on Debian 12 and requires compatible system libraries and an existing accessible X11 desktop. Other platforms depend on an available managed backend.

Remote Desktop has no separate switch. Availability depends on access to a graphical desktop and the managed backend. It operates independently of Computer Use; simultaneous input to the same desktop can interfere.

Display capabilities depend on the platform backend. macOS currently shares only the primary display; multi-display selection is available only when reported by the Node. Reconnect after changing display settings on Windows or macOS.

Choose Low, Medium, or High picture quality; Medium is the default. Quality uses the VNC backend's native encoding settings and does not change the Node's display resolution. The effect depends on the backend and encoding.

## Prerequisites

- Your account can use the target Node. Permission to manage the Node or use one of its Workspaces does not by itself grant desktop use.
- The Node is online and reports Remote Desktop as available, with an accessible interactive desktop and the required operating-system permissions. Linux supports an existing X11 desktop only, not Wayland.
- Your browser can reach Server. A direct connection or Server relay may carry the desktop; both require Server authorization.

## Steps

1. In **Work**, choose **Remote Desktop** from the Node action menu. A separate same-origin browser tab opens without changing the active Workspace or borrowing the original tab's connection.
2. The native primary display opens in view-only mode. When the backend supports multiple displays, use the display selector to show one display or the entire desktop; the picture is the Node's real desktop.
3. The desktop starts in view-only mode. Select the bordered **Control desktop** button in the center of the picture (or the matching toolbar action) to operate it. Other people or programs may operate the same desktop at the same time.
4. In control mode, select **Send clipboard text** and grant browser permission when requested. Only this explicit action reads the local clipboard and sends its text to the desktop; then paste in the remote application. The clipboard is not synchronized automatically, and view-only mode cannot send it.

On a mobile device, open **Text keyboard** in control mode, compose text locally, and select **Send text**. Enter and Backspace are also available as buttons. Text is sent as remote keyboard events; the result depends on the remote application and system. Unsent text is cleared when changing mode, hiding the page, or losing control.

5. Losing window focus stops input from this tab. Hiding the tab ends its active picture in either mode. Reconnect explicitly after returning. Closing or disconnecting this tab cleans up only its own connection; it does not revoke credentials or affect other desktop windows or Agent work. Losing Node access ends the affected desktop connections when authorization is rechecked.

The bar below the picture shows the connection path (Direct or Server relay), Server RTT, frame rate, and receive/send rates. Unmeasured values show “—”; FPS can be 0 on a static desktop.

Browsers may reserve some system shortcuts. If a shortcut cannot reach the page, use the target application's controls instead. Available input methods on mobile also depend on the browser and device.

## Troubleshooting

- **Action unavailable:** Check that the Node is online, your account can use it, and it actually reports desktop availability. On Linux, check the X11 session and required system libraries; do not expose a public VNC port to bypass authorization.
- **Connection lost or cleanup unknown:** The old control may still be converging safely. Avoid repeatedly switching modes; reload when prompted and check the Node, system session, and permissions.
- **Locked or invalid session:** Restore a valid interactive session on the target system before reconnecting. Do not disable operating-system security controls to bypass the restriction.
