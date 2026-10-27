import { AnthropicMessagesAdapter } from './anthropic-messages.js';
import type { AgentModelConfiguration } from './configuration.js';
import type { ModelAdapter } from './contracts.js';
import { OpenAiResponsesAdapter } from './openai-responses.js';

export interface AgentModelTransportTestResult {
  readonly completed: boolean;
  readonly response: string;
}

/** Probe a configured protocol without exposing its adapter or wire events. */
export async function testAgentModelTransport(
  configuration: AgentModelConfiguration,
  signal: AbortSignal,
  request?: { readonly system?: string; readonly prompt?: string }
): Promise<AgentModelTransportTestResult> {
  const adapter: ModelAdapter =
    configuration.protocol === 'OPENAI_RESPONSES'
      ? new OpenAiResponsesAdapter(configuration)
      : new AnthropicMessagesAdapter(configuration);
  try {
    let completed = false;
    let response = '';
    for await (const event of adapter.start(
      {
        system: request?.system ?? 'You are performing a model transport connectivity test.',
        messages: [{ role: 'user', content: request?.prompt ?? 'Reply with OK.' }],
        tools: [],
        allowTools: false
      },
      signal
    )) {
      if (event.type === 'completed') completed = true;
      if (event.type === 'text.completed') response = event.text;
    }
    return { completed, response };
  } finally {
    await adapter.close?.();
  }
}
