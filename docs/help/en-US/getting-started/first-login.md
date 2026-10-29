---
title: First Sign-in and Password Change
lastUpdated: 2026-10-29
---

# First Sign-in and Password Change

A new database creates the sole administrator `admin` with initial password `EanlRffYBYYo70pigl4y`. You must change it immediately after the first sign-in; business data and operations remain unavailable until then.

1. Sign in as `admin` with the initial password.
2. Enter the current password, a new password, and its confirmation. The new password must contain 8–1024 characters.
3. Submit, then sign in again with the new password.

**Success:** the Work page opens and previous browser sessions are invalidated.

Network or server failures while checking sign-in status show an error without signing you out or clearing the current page. On first opening, neither the sign-in form nor business content appears until verification completes; refresh after connectivity recovers. The sign-in page appears only when Server explicitly confirms you are not signed in.

If the password is lost, run the administrator reset command on Server and provide the replacement through `MAR_RESET_PASSWORD`. There is no public HTTP reset endpoint.

Do not retain the initial password in password managers, scripts, or deployment notes.

Next: [Connect Your First Node](connect-node.md).
