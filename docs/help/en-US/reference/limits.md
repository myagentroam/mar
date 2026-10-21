---
title: Versions, Capacity, and Limits
lastUpdated: 2026-10-11
---

# Versions, Capacity, and Limits

- Node.js support is `>=22.13 <25` for the current release.
- A Node must not run a MyAgentRoam version newer than Server. Use the exact supported package version.
- Community Edition does not limit the number of registered Nodes.
- Terminal limits are 10 running terminals per Node and 5 per Workspace.
- The first message accepts at most five attachments, 5 MiB each and 10 MiB total.
- File reads, directory pages, searches, diffs, history pages, replay, sources, and concurrent operations have bounded limits reported by the current Node or Server.
- Each local process in a hosted conversation is limited to 300 CPU seconds, 64 processes, 256 file descriptors, and a 1 GiB file-size limit.

Other limits protect shared hosts and browser responsiveness. Reduce the request scope or close unused work instead of bypassing checks. Pre-release, invalid, unknown, or incompatible Node versions do not receive gated capabilities.

MyAgentRoam does not add a sandbox virtual-address-space limit or a conversation-level RSS limit, avoiding false memory exhaustion for large virtual mappings with low RSS. Limits configured by the hosting Node, container, or system service still apply.
