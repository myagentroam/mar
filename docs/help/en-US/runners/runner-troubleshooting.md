---
title: Agent or Model Unavailable
lastUpdated: 2026-09-25
---

# Agent or Model Unavailable

First distinguish built-in MAR Agent from external Agents. Repeated refreshes or reinstalling an unrelated CLI will not fix model access.

## Built-in MAR Agent

1. Confirm that Node is online and **Supported Agents** includes MAR Agent. It is bundled with Node; no external Agent CLI is required.
2. Ask an administrator to check that the model exists and is enabled in **Admin → MAR Agent Models**. Regular users need a model grant; all users, including system administrators, must be within the bound credential scope.
3. For a model using Codex credentials, its credential manager should check whether sign-in is required and the proxy works. Model management does not grant access to another user's personal credentials.
4. Have an administrator **Test** the model on a compatible online Node and resolve the reported connection, authentication, model, or transport error. A credential test is not the same as a real Node model test.
5. Return to the Workspace and choose a valid model. If none is available, fix configuration or access rather than deleting history or installing the Codex CLI.

See [Configure and Use MAR Agent](mar-agent.md).

## Codex, Claude Code, and OpenCode

1. Run the Agent's version command as the **actual Node service account**, not an administrator or unrelated SSH account.
2. Compare that account's home directory, `PATH`, authentication, and provider configuration with the working foreground environment.
3. Check **Supported Agents** in Node details after one discovery cycle, or restart Node.
4. For OpenCode, explicitly configure the provider and model in the Node service account's global OpenCode configuration; Workspace-only models are not listed.
5. Verify outbound access to authentication/model services and filesystem access to the Workspace.

| Symptom                      | Likely cause                                                         | Action                                                                                   |
| ---------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| External Agent missing       | CLI, PATH, or authentication differs for the service account         | Fix service HOME/PATH and restart Node                                                   |
| MAR Agent models empty       | Model disabled, missing grant, or credential scope excludes the user | Check Server models and credentials, not Workspace CLI configuration                     |
| External Agent models empty  | Native provider configuration is missing or ineffective              | Fix that Agent's service-account configuration; OpenCode uses global model configuration |
| `SESSION_INVALID`            | Saved model configuration is no longer valid                         | Refresh and select a valid model; create a new session only if needed                    |
| Node details slow under load | Many Agents running concurrently                                     | Wait for Supported Agents to update and inspect Node load/logs                           |

Never share Agent configuration, tokens, or complete logs in public tickets. If the issue persists, collect versions, time, error codes, and request IDs using [Quick Diagnosis](../troubleshooting/quick-diagnosis.md), then contact the deployment administrator.
