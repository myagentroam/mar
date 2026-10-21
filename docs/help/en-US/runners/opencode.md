---
title: Install, Configure, and Use OpenCode
lastUpdated: 2026-10-11
---

# Install, Configure, and Use OpenCode

Install OpenCode under the Node service account and verify that its command is available there. Configure providers and models explicitly in that account's global OpenCode configuration. Models configured only in a Workspace do not appear in MyAgentRoam's model picker; it does not depend on automatic gateway discovery.

After Node reports OpenCode, create a session and select the model name shown by the UI. Provider prefixes may be hidden from display. Select only an offered reasoning level. `/plan` sends subsequent messages to OpenCode's native Plan Agent; **Implement** returns to the build Agent.

Provider credentials may come from the service account configuration or authorized MyAgentRoam environment secrets. If image input is required, confirm that the selected OpenCode model is configured with image capability.

For failures, run the same OpenCode command from the same Workspace and service account, then check model configuration, credentials, network access, and Node logs.

Image input retains a fallback file under `temp-files/` in the Node private data directory, reusing uploaded attachments directly. If OpenCode trims historical media to `[Media removed]`, the Agent can use `read` on the file identified in the message without asking you to save the image again.
