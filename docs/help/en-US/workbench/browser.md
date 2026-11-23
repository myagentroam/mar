---
title: Use the Workspace browser
lastUpdated: 2026-11-24
---

# Use the Workspace browser

In Work mode, select **Open a website in MAR** in the Workspace toolbar to open the **Browser** tab in the side pane. Pages run in Chromium on the Node that hosts the Workspace, not on the device running the Console. Browser data for your account is kept separately for each Workspace.

## Browse pages

- Enter an HTTP(S) address and press Enter to navigate the current tab. With no scheme, normal hosts default to HTTPS; `localhost` and `127.0.0.1` default to HTTP.
- Use the toolbar to go back or forward, reload, or stop loading. You can also open and close tabs. The external-open button opens the current page's actual URL unchanged in your device browser.
- In MAR, `localhost` and `127.0.0.1` refer to **the Node's loopback interface**. Open an address for a service started in the Workspace terminal without registering a port. Opening the same URL externally points to **your device** instead.
- When a site asks for files, choose them on your device. In the browser toolbar, choose **More → Downloads** to see current downloads, cancel one, or save a finished file to your device. Downloaded files remain on the Node until the MAR browser instance closes; save any files you need before closing it.
- On a touchscreen, tap to click and swipe to scroll the remote page. To type, tap a field on the page, then select **Show keyboard**. Select **Hide keyboard** when finished.
- Select text on the remote page and choose **More → Copy selected text** to copy it to your device. To paste plain text, focus a field on the remote page and use your device's paste shortcut.

## Choose where links open

Under **Personal settings → Browser**, choose where public and local links open independently. By default, public URLs in Workspace conversations and terminals open externally, Node loopback URLs open in MAR, and authorized Workspace HTML file links open an Aside preview. Ctrl-click (⌘-click on macOS) reverses the destination. These preferences are stored per account in the current Console browser. They do not apply to the address bar or links inside webpages.

## Sign-in, browsing data, and history

Choose whether to keep website sign-ins when you open the browser. Hiding the pane or closing the Aside tab does not immediately close Chromium; it closes after 15 minutes without an attached view. The Node removes retained profile directories after 30 days without use.

Choose **More → Clear browser cache** to open the current browser's clear-data dialog without leaving the page. Check the Workspace and profile before choosing a time range and data categories. Only the cache is selected by default. Deleting cookies and site data can sign you out of websites. It does not delete Workspace files, downloaded files, your MAR sign-in, or data from your device browser.

Choose **More → Browsing history** to search by URL, page title, or date. Open a result in a new MAR tab, or remove individual or selected entries. **More → Browser settings** goes to Personal settings and only controls where links open. Use **Work** in the main navigation to return to the Workbench.
