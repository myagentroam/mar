---
title: Use the Workspace browser
lastUpdated: 2026-11-24
---

# Use the Workspace browser

In Work mode, open the side pane, then select **+ → Browser** at the end of its tab strip. Pages run in Chromium on the Node that hosts the Workspace, not on the device running the Console. Browser data for your account is kept separately for each Workspace.

## Let MAR Agent use the browser

**Browser Use** is on by default under **Settings → Browser**. Web checks normally run in the Node’s isolated Chromium without using your sign-ins. Ask MAR Agent to load `mar-browser-use` for a web check. The bundled `playwright-cli` command also works with the optional Playwright CLI skill; no separate CLI installation is required. Continue to run existing Playwright test suites with your project’s test commands.

If a task needs your current page, an existing sign-in, or an interactive login, the Agent can use Playwright in this Workspace’s shared browser without asking for access to each tab. It can open the sign-in page for you. Sign in yourself in the MAR browser, then tell the Agent to continue. You can leave the browser side pane after signing in; the browser stays live while the Agent holds its shared connection.

Select **More → Take control** to disconnect the Agent from the shared browser, then **Let Agent resume** when you’re ready. Turning Browser Use off also revokes shared access. Your tabs normally stay open. If MAR cannot disconnect the Agent on its own, it may close the shared browser instead. This does not undo completed actions. New Agent executions no longer receive the bundled CLI, but executions that already have it can still use their separate browsers.

If you’re still waiting to take control, select **Try again** next to the takeover status. Wait for confirmation that the Agent is disconnected before continuing on the page.

## Browse pages

- Enter an HTTP(S) address in the address bar or the centered field on a **Blank** tab and press Enter to navigate the current tab. With no scheme, normal hosts default to HTTPS; `localhost` and `127.0.0.1` default to HTTP.
- As you type, matching titles and URLs appear from the current Node browser’s history. Click a suggestion or select it with the arrow keys and press Enter to open it in the current tab. Press Esc to dismiss suggestions. MAR does not keep a separate history or read your device browser’s history.
- Use the toolbar to go back or forward, reload, or stop loading. Select **+** after the last webpage tab to open a new one. The external-open button opens the current page's actual URL unchanged in your device browser.
- You can open the same Workspace browser on multiple devices or windows with the same account. They share the active page and tabs. On supported Nodes, webpages fit the first connected Browser panel and reflow as it changes size. When that window disconnects, the next connected panel takes over without reloading the page. **More → Close browser** closes the shared instance for everyone.
- When both ends support HD, an ICE direct connection starts at up to 1080p. Quality adjusts automatically; relay connections use standard quality. Small viewports are not upscaled, and quality changes do not affect page layout.
- Select the **Info** icon in the bottom-right corner of the browser to see the current connection, receive bitrate, drawn frame rate, viewport size, and codec. A still page may send no new frames; zero does not mean the connection has dropped.
- In MAR, `localhost` and `127.0.0.1` refer to **the Node's loopback interface**. Open an address for a service started in the Workspace terminal without registering a port. Opening the same URL externally points to **your device** instead.
- When a site asks for files, choose them on your device. Site downloads start on the Node automatically and are not saved to your device until you choose to save them. The **Downloads** button to the left of **More** signals list updates. Open it to check progress, cancel a download, or choose **Save to device**. Downloaded files remain on the Node until the MAR browser instance closes; save any files you need before closing it.
- On a touchscreen, tap to click and swipe to scroll the remote page. On Nodes with native touch support, you can also drag sliders and other page controls. To type, tap a field on the page, then use the keyboard button in the lower-right corner to show or hide the keyboard.
- Select text on the remote page and choose **Copy selected text** in the lower-right corner to copy it to your device. To paste plain text, focus a field on the remote page, then choose **Paste plain text** or use your device's paste shortcut.
- On Nodes with context menu support, right-click selected text to copy it, an editable field to paste plain text, or a link to copy its address or open it in a new tab. If the page handles right-click itself, MAR does not show a second menu. To open MAR's menu anyway, select the text or focus the field, then use Shift+right-click, the Menu key, or Shift+F10. If your device browser blocks clipboard access from the menu, use the paste shortcut.

## Choose where links open

Under **Personal settings → Browser**, choose where public and local links open independently. By default, public URLs in Workspace conversations and terminals open externally, Node loopback URLs open in MAR, and authorized Workspace HTML file links open an Aside preview. Ctrl-click (⌘-click on macOS) reverses the destination. These preferences are stored per account in the current Console browser. They do not apply to the address bar or links inside webpages.

## Sign-in, browsing data, and history

Opening the Browser goes directly to a blank tab or resumes the existing instance. Website sign-ins and site data are saved for your account and Workspace by default. Hiding the pane or closing the Aside tab does not immediately close Chromium; it closes after 15 minutes without an attached view. **More → Close browser** ends the instance and closes its Aside tab. The Node removes retained profile directories after 30 days without use.

Choose **More → Clear browser cache** to open the current browser's clear-data dialog without leaving the page. Check the Workspace and profile before choosing a time range and data categories. Only the cache is selected by default. Deleting cookies and site data can sign you out of websites. It does not delete Workspace files, downloaded files, your MAR sign-in, or data from your device browser.

Choose **More → Browsing history** to see pages grouped by date. Type a title or URL to search, or choose **Filter by date**. Open a result in a new MAR tab, use its menu to remove it, or select rows and choose **Delete selected**. Confirming removes all visits to the selected URLs from this profile. **More → Browser settings** goes to Personal settings and only controls where links open. Use **Work** in the main navigation to return to the Workbench.
