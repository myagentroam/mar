import { AnthropicMessagesAdapter } from './anthropic-messages.js';
import type { MarAgentModelConfiguration } from './configuration.js';
import type { ModelAdapter } from './contracts.js';
import { OpenAiResponsesAdapter } from './openai-responses.js';

/** Probe a configured protocol without exposing its adapter or wire events. */
export async function testMarAgentModelTransport(
  configuration: MarAgentModelConfiguration,
  signal: AbortSignal
): Promise<boolean> {
  const adapter: ModelAdapter =
    configuration.protocol === 'OPENAI_RESPONSES'
      ? new OpenAiResponsesAdapter(configuration)
      : new AnthropicMessagesAdapter(configuration);
  try {
    let completed = false;
    for await (const event of adapter.start(
      {
        system: 'You are performing a model transport connectivity test.',
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        tools: [],
        allowTools: false
      },
      signal
    ))
      if (event.type === 'completed') completed = true;
    return completed;
  } finally {
    await adapter.close?.();
  }
}
