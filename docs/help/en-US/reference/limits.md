---
title: Versions, Capacity, and Limits
lastUpdated: 2026-10-29
---

# Versions, Capacity, and Limits

- Node executor requires Node.js `>=22.13`; native Server and full-product development require `>=24.12`.
- Deploy matching Server and Node product versions; see [upgrades](../deployment/upgrade.md) for the current business baseline and eligible upgrade targets.
- Community Edition does not limit the number of registered Nodes.
- Terminal limits are 10 running terminals per Node and 5 per Workspace.
- The first message accepts at most five attachments, 5 MiB each and 10 MiB total.
- File reads, directory pages, searches, diffs, history pages, replay, sources, and concurrent operations have bounded limits reported by the current Node or Server.
- Workspace registration is limited by `allowedRoots`, but an authorized user's read-only absolute-path preview can read ordinary files accessible to the Node account. See [data and security](../concepts/data-and-security.md).
- Processes and terminals do not resume across a Node restart. Normal shutdown can conditionally continue unfinished MAR Agent work, Goals, and queues in regular Workspaces; see [session recovery](../workbench/sessions.md#automatic-continuation-after-orderly-shutdown).
- Each local process in a hosted conversation is limited to 300 CPU seconds, 64 processes, 256 file descriptors, and a 1 GiB file-size limit.

Other limits protect shared hosts and browser responsiveness. Reduce the request scope or close unused work instead of bypassing checks. A registered Node below the current business baseline is limited to the authorized upgrade path.

MyAgentRoam does not add a sandbox virtual-address-space limit or a conversation-level RSS limit, avoiding false memory exhaustion for large virtual mappings with low RSS. Limits configured by the hosting Node, container, or system service still apply.
