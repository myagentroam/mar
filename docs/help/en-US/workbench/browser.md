---
title: Use the Workspace browser
lastUpdated: 2026-11-24
---

# Use the Workspace browser

In Work mode, select **+ → Browser** at the end of the side pane’s tab strip. On desktop, you can also select **Open a website in MAR** in the Workspace toolbar. Pages run in Chromium on the Node that hosts the Workspace, not on the device running the Console. Browser data for your account is kept separately for each Workspace.

## Browse pages

- Enter an HTTP(S) address in the address bar or the centered field on a **Blank** tab and press Enter to navigate the current tab. With no scheme, normal hosts default to HTTPS; `localhost` and `127.0.0.1` default to HTTP.
- Use the toolbar to go back or forward, reload, or stop loading. Select **+** after the last webpage tab to open a new one. The external-open button opens the current page's actual URL unchanged in your device browser.
- On supported Nodes, webpages reflow to fit the Browser panel when you resize the Workbench, drag the divider, or rotate your device. This does not reload the page.
- The stream adjusts its bitrate and frame rate automatically. On a constrained connection, scrolling and animation may look less smooth, but the page layout does not change.
- Select the **Info** icon in the bottom-right corner of the browser to see the current connection, receive bitrate, drawn frame rate, viewport size, and codec. A still page may send no new frames; zero does not mean the connection has dropped.
- In MAR, `localhost` and `127.0.0.1` refer to **the Node's loopback interface**. Open an address for a service started in the Workspace terminal without registering a port. Opening the same URL externally points to **your device** instead.
- When a site asks for files, choose them on your device. Site downloads start on the Node automatically and are not saved to your device until you choose to save them. The **Downloads** button to the left of **More** signals list updates. Open it to check progress, cancel a download, or choose **Save to device**. Downloaded files remain on the Node until the MAR browser instance closes; save any files you need before closing it.
- On a touchscreen, tap to click and swipe to scroll the remote page. On Nodes with native touch support, you can also drag sliders and other page controls. To type, tap a field on the page, then use the keyboard button in the lower-right corner to show or hide the keyboard.
- Select text on the remote page and choose **Copy selected text** in the lower-right corner to copy it to your device. To paste plain text, focus a field on the remote page and use your device's paste shortcut.

## Choose where links open

Under **Personal settings → Browser**, choose where public and local links open independently. By default, public URLs in Workspace conversations and terminals open externally, Node loopback URLs open in MAR, and authorized Workspace HTML file links open an Aside preview. Ctrl-click (⌘-click on macOS) reverses the destination. These preferences are stored per account in the current Console browser. They do not apply to the address bar or links inside webpages.

## Sign-in, browsing data, and history

Opening the Browser goes directly to a blank tab or resumes the existing instance. Website sign-ins and site data are saved for your account and Workspace by default. Hiding the pane or closing the Aside tab does not immediately close Chromium; it closes after 15 minutes without an attached view. **More → Close browser** ends the instance and closes its Aside tab. The Node removes retained profile directories after 30 days without use.

Choose **More → Clear browser cache** to open the current browser's clear-data dialog without leaving the page. Check the Workspace and profile before choosing a time range and data categories. Only the cache is selected by default. Deleting cookies and site data can sign you out of websites. It does not delete Workspace files, downloaded files, your MAR sign-in, or data from your device browser.

Choose **More → Browsing history** to see pages grouped by date. Type a title or URL to search, or choose **Filter by date**. Open a result in a new MAR tab, use its menu to remove it, or select rows and choose **Delete selected**. Confirming removes all visits to the selected URLs from this profile. **More → Browser settings** goes to Personal settings and only controls where links open. Use **Work** in the main navigation to return to the Workbench.
