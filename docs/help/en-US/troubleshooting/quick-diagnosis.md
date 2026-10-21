---
title: Quick Diagnosis
lastUpdated: 2026-10-17
---

# Quick Diagnosis

Start at the narrowest failing boundary:

| Symptom                    | First check                                                            |
| -------------------------- | ---------------------------------------------------------------------- |
| Cannot sign in             | Server health, browser origin, password or OAuth provider              |
| Node offline               | Node service logs and outbound HTTPS/WSS                               |
| Workspace unavailable      | `allowedRoots` and service-account permissions                         |
| Agent or model missing     | MAR Agent model access or external Agent service-account configuration |
| Session stuck or read-only | Node connectivity and external Agent activity                          |
| Terminal disconnects       | Shell availability, limits, and WebSocket proxying                     |

Additional task-specific checks:

- MAR Agent has no models or authentication fails: check model enablement, grants, credential scope, and model tests in [Agent Troubleshooting](../runners/runner-troubleshooting.md).
- Hosted conversations are unavailable or history is empty: check template access, hosting Node connectivity, and hosting capability in [Hosted Conversations](../workbench/hosted-conversations.md).
- Template publication fails: check source safety, models, MCP, and capacity in [Manage Conversation Templates](../administration/conversation-templates.md).
- Skill/MCP installation fails: check target permissions, Node environment, network, and secret references in [Skill and MCP Configuration](../workbench/skills.md).

## Collect correlated diagnostic information

Before contacting an administrator, record these details and share them only through a controlled support channel:

- Time and timezone, Server/Web product version, and Node common-component version; include the external Agent CLI version when relevant.
- Whether you used Work or Chat, the affected Node/Workspace/session, minimal reproduction steps, and expected behavior.
- The displayed error code, Server request ID, Node request ID when available, and redacted details. Do not guess fields that are not shown.

Administrators can correlate request IDs with Server logs under `MAR_DATA_DIR/logs` and Node logs under `dataDirectory/logs`, or inspect service standard output. Default retention is seven days, so collect details promptly; see [Ports and Data Locations](../reference/ports-paths-data.md). Do not submit secrets, cookies, complete chats, terminal content, Agent configuration, or unredacted logs.

## Page performance

When the page becomes sluggish, hover over the performance indicator in the lower-left corner of the desktop console. A high message rate with normal processing time, long tasks, and memory usually means ordinary activity. Elevated processing P95, main-thread delay, or long-task time indicates browser-side blocking. If DOM nodes, message cards, or JS heap remain large, close unused Workspace tabs or reload the page. Active Run sessions are those observed by the current browser through realtime callbacks, not a Server-wide monitoring value.

When long tasks show “Unavailable”, the browser does not support collection or the observer failed to initialize; this does not mean there were no long tasks. Zero is shown only when collection is active and the current window has no records. Copied diagnostic details also include collection availability. The missing metric alone does not change the overall health status.

## General order

Check Server/Web access first, then Node connectivity, then Workspace permissions and Supported Agents. Change one condition at a time and verify it; restarting Server, Node, the Agent, and the browser together makes the cause harder to identify. Do not delete registrations or data as a diagnostic shortcut.
