---
title: Use the Workspace browser
lastUpdated: 2026-11-24
---

# Use the Workspace browser

In Work mode, open the side pane, then select **+ → Browser** at the end of its tab strip. Pages run in Chromium on the Node that hosts the Workspace, not on the device running the Console. Browser data for your account is kept separately for each Workspace.

## Let MAR Agent use the browser

**Browser Use** is on by default under **Settings → Browser**. Web checks normally run in the Node’s isolated Chromium without using your sign-ins. Ask MAR Agent to load `mar-browser-use` for a web check. The bundled `playwright-cli` command also works with the optional Playwright CLI skill; no separate CLI installation is required. Continue to run existing Playwright test suites with your project’s test commands.

If a task needs your current page, an existing sign-in, or an interactive login, the Agent can use Playwright in this Workspace’s shared browser. The Agent can open the sign-in page for you. Sign in directly in the MAR browser, then tell the Agent to continue. You can leave the side pane or keep using the same page alongside the Agent. A brief message shows recent Agent activity without blocking your input. Turning Browser Use off disconnects the Agent without closing your tabs.

## Browse pages

Closing the last page tab also closes the Browser tab in this side pane. It does not shut down the shared Chromium instance.

Press **Ctrl+F** (**⌘F** on macOS) inside the browser, or choose **More → Find in page**. Matches are highlighted and counted. Press **Enter** or **Shift+Enter** to cycle through them, or **Esc** to close. Find searches the remote page, not the local workbench.

- Enter an HTTP(S) address in the address bar or the centered field on a **Blank** tab and press Enter to navigate the current tab. With no scheme, normal hosts default to HTTPS; `localhost` and `127.0.0.1` default to HTTP.
- As you type, matching titles and URLs appear from the current Node browser’s history. Click a suggestion or select it with the arrow keys and press Enter to open it in the current tab. Press Esc to dismiss suggestions. MAR does not keep a separate history or read your device browser’s history.
- To search the web instead, type `? ` followed by your search terms and press Enter. Only an explicit search sends the terms to Google; other input is treated as an address.
- On supported Nodes, use **More → Reopen closed tab** to load the previous address, not the previous page state. In **More → Zoom**, use **−** and **+** to adjust the current remote tab, or click the percentage to return to 100%. This does not zoom the workbench.
- If the stream disconnects or a page change produces no picture, MAR can retry once per interruption against the same browser without replaying input. Click **Reconnect** once to resume the running browser or open a new blank one if it has ended. On supported Nodes, use **Reopen recent tabs** on the error screen or the new blank page to open the last known addresses. A page that fails to open does not block the others. Unsaved forms and back/forward history are not restored.
- Use the toolbar to go back or forward, reload, or stop loading. Select **+** after the last webpage tab to open a new one. The external-open button opens the current page's actual URL unchanged in your device browser.
- You can open the same Workspace browser on multiple devices or windows with the same account. They share the active page and tabs. On supported Nodes, webpages fit the first connected Browser panel and reflow as it changes size. When that window disconnects, the next connected panel takes over without reloading the page. **More → Close browser** closes the shared instance for everyone.
- When both ends support HD, an ICE direct connection starts at up to 1080p. Quality adjusts automatically; relay connections use standard quality. Small viewports are not upscaled, and quality changes do not affect page layout.
- Select the **Info** icon in the bottom-right corner of the browser to see the current connection, receive bitrate, drawn frame rate, CSS viewport size, decoded resolution, and codec. The decoded picture can be smaller than the viewport without changing the page layout. A still page may send no new frames; zero does not mean the connection has dropped.
- In MAR, `localhost` and `127.0.0.1` refer to **the Node's loopback interface**. Open an address for a service started in the Workspace terminal without registering a port. Opening the same URL externally points to **your device** instead.
- When a site asks for files, choose them on your device. Site downloads start automatically, show a brief message in the browser, and are stored on the Node first. Select **Save to device** to transfer a completed file to your device. The **Downloads** button to the left of **More** shows the number of active downloads. Open the list to see how much has downloaded and the total size when available, cancel a download, check failed or canceled downloads, or view and save completed files. Deleting a completed download removes the temporary file from the Node. Even while the browser is open, the Node regularly removes downloads that have been finished for 30 days. Older items may be removed sooner to free space or limit the number of records. Closing the browser instance also clears its temporary downloads. Save important files promptly; cleanup does not affect copies already saved to your device.
- Use **Page keyboard mode** in the lower-right corner to send **Tab** and **Shift+Tab** to the remote page. Press **Esc** to return focus to the workbench. On a touchscreen, tap a field and use the same button to open the device keyboard. Tap to click and swipe to scroll; on Nodes with native touch support, you can also drag sliders and other controls.
- On supported Nodes, **Save to Workspace** copies a completed download directly into the current Workspace. Enter a relative path including the filename. The folder must already exist, and an existing file will not be overwritten. This does not remove the temporary download.
- Select text on the remote page and choose **Copy selected text** in the lower-right corner to copy it to your device. To paste plain text, focus a field on the remote page, then choose **Paste plain text** or use your device's paste shortcut.
- On Nodes with context menu support, right-click selected text to copy it, an editable field to paste plain text, or a link to copy its address or open it in a new tab. If the page handles right-click itself, MAR does not show a second menu. To open MAR's menu anyway, select the text or focus the field, then use Shift+right-click, the Menu key, or Shift+F10. If your device browser blocks clipboard access from the menu, use the paste shortcut.

## Choose where links open

Under **Personal settings → Browser**, choose where public and local links open independently. By default, public URLs in Workspace conversations and terminals open externally, Node loopback URLs open in MAR, and authorized Workspace HTML file links open an Aside preview. Ctrl-click (⌘-click on macOS) reverses the destination. These preferences are stored per account in the current Console browser. They do not apply to the address bar or links inside webpages.

## Sign-in, browsing data, and history

Opening the Browser goes directly to a blank tab or resumes the existing instance. Website sign-ins and site data are saved for your account and Workspace by default. Hiding the pane or closing the Aside tab does not immediately close Chromium. On supported Nodes, a connected browser panel stays open while it is in the foreground, even without input. After you leave the panel or switch away from the Console tab, the browser closes after 15 minutes without browser actions (including Agent actions) or incoming download data. **More → Close browser** ends the instance and closes its Aside tab. The Node removes retained profile directories after 30 days without use.

Each Node runs up to 16 Workspace browser instances at a time. At the limit, only instances with no connected pane or Agent and no ongoing data operation or download can be closed to make room. The Node closes the least recently active eligible instance. If none qualify, a new browser cannot open yet.

Choose **More → Clear browser cache** to open the current browser's clear-data dialog without leaving the page. Check the Workspace and profile before choosing a time range and data categories. Only the cache is selected by default. The browser automatically evicts HTTP disk cache entries based on capacity without deleting cookies or site data. Manually deleting cookies and site data can sign you out of websites. It does not delete Workspace files, downloaded files, your MAR sign-in, or data from your device browser.

Choose **More → Browsing history** to see pages grouped by date. Type a title or URL to search, or choose **Filter by date**. Open a result in a new MAR tab or use its menu to remove it. To delete multiple entries, select rows or choose **Select all on this page**, then choose **Delete selected**. Confirming removes all visits to the selected URLs from this profile.

In **More → Browser settings**, set your account's **Cache cleanup interval** to 1–60 days (default: 30). Your saved setting takes effect the next time you open the Workspace browser. Automatic cleanup affects only the HTTP cache, not website sign-ins, history, or downloads. Use **Work** in the main navigation to return to the Workbench.
