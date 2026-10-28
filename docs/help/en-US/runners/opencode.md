---
title: Install, Configure, and Use OpenCode
lastUpdated: 2026-10-29
---

# Install, Configure, and Use OpenCode

Install OpenCode under the Node service account and verify that its command is available there. Configure providers and models explicitly in that account's global OpenCode configuration. Models configured only in a Workspace do not appear in MyAgentRoam's model picker; it does not depend on automatic gateway discovery.

Install with npm under that account, or consult the [OpenCode documentation](https://opencode.ai/docs/) for other platform options. A remote installer executes with the current account's privileges: download and inspect its source and contents before deciding to run it rather than piping an unreviewed script directly into a shell. When moving to a new Node account, copy only its required configuration and credentials, not logs, session databases, or caches; restrict access to the copied files and verify `opencode --version` in the Node service's actual HOME and PATH.

After Node reports OpenCode, create a session and select the model name shown by the UI. Provider prefixes may be hidden from display. Select only an offered reasoning level. `/plan` sends subsequent messages to OpenCode's native Plan Agent; **Implement** returns to the build Agent.

Provider credentials may come from the service account configuration or authorized MyAgentRoam environment secrets. If image input is required, confirm that the selected OpenCode model is configured with image capability.

The following global configuration illustrates a custom provider using the OpenAI-compatible **Chat Completions** API and a model with image input. Replace the example endpoint and model, configure the environment secret separately, and declare image capability only if the service supports it. Check the fields and adapter against the [OpenCode provider documentation](https://opencode.ai/docs/providers/) for your installed version; for a Responses API, use `@ai-sdk/openai` as described there rather than copying this Chat Completions configuration.

```jsonc
{
  "provider": {
    "mar": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://api.example.com/v1",
        "apiKey": "{env:MAR_PROVIDER_API_KEY}"
      },
      "models": {
        "your-model": {
          "attachment": true,
          "modalities": { "input": ["text", "image"], "output": ["text"] }
        }
      }
    }
  }
}
```

For image attachments, explicitly configure both `attachment: true` and `modalities.input` containing `image` for a model that actually supports images. Restart the OpenCode service instance after changing its global configuration. A native `opencode run --model <provider/model> --file <image-path> <prompt>` can test the attachment path, but it makes a real model request; use an authorized test image and provider. Reading an image with a tool alone does not prove attachment support.

For failures, run the same OpenCode command from the same Workspace and service account, then check model configuration, credentials, network access, and Node logs.

Image input retains a fallback file under `temp-files/` in the Node private data directory, reusing uploaded attachments directly. If OpenCode trims historical media to `[Media removed]`, the Agent can use `read` on the file identified in the message without asking you to save the image again.
