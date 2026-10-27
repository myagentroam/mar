import { randomUUID } from 'node:crypto';
import { AgentError } from '../error.js';
import { AnthropicMessagesAdapter } from '../model/anthropic-messages.js';
import {
  resolveModelDefaultReasoningEffort,
  type AgentModelConfiguration
} from '../model/configuration.js';
import type { ModelAdapter } from '../model/contracts.js';
import { OpenAiResponsesAdapter } from '../model/openai-responses.js';

const sessionTitlePrompt = `You are a session title generator. Output only one title and nothing else.

Create a brief title that helps the user find this conversation later.
- Use the same language as the user message.
- Output exactly one non-empty line with at most 50 characters.
- Focus on the main topic or requested outcome.
- Preserve exact technical terms, numbers, and filenames.
- Do not answer the request, explain the title, mention tools, or add quotation marks.
- For a minimal conversational message, still produce a meaningful title reflecting its intent.`;

export interface GenerateSessionTitleInput {
  readonly onModelUsage?: (
    usage: import('../model/usage-observer.js').ModelRequestUsage
  ) => Promise<void> | void;
  readonly onModelUsageFailure?: () => void;
  readonly models: readonly AgentModelConfiguration[];
  readonly currentModelId: string;
  readonly prompt: string;
  /** Used only when the user message does not establish a language. */
  readonly defaultLanguage?: string;
  readonly signal: AbortSignal;
}

/** Generate a title without a Session or Host. Credential providers remain caller-owned. */
export async function generateSessionTitle(
  input: GenerateSessionTitleInput
): Promise<string | undefined> {
  const defaultLanguage = input.defaultLanguage?.trim();
  if (input.defaultLanguage !== undefined && (!defaultLanguage || defaultLanguage.length > 128))
    throw new AgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Default title language is invalid.');
  const models = input.models.filter((model) => model.enabled);
  const model =
    models.find((candidate) => candidate.titleGeneration) ??
    models.find((candidate) => candidate.id === input.currentModelId);
  if (!model)
    throw new AgentError('MAR_AGENT_MODEL_DISABLED', 'Selected title model is unavailable.');
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(30_000)]);
  signal.throwIfAborted();
  const adapter: ModelAdapter =
    model.protocol === 'OPENAI_RESPONSES'
      ? new OpenAiResponsesAdapter(model)
      : new AnthropicMessagesAdapter(model);
  let titleInput = '';
  let characters = 0;
  for (const character of input.prompt) {
    if (characters++ >= 1000) break;
    titleInput += character;
  }
  let output = '';
  let completed = false;
  try {
    for await (const event of adapter.start(
      {
        retryState: { attempts: 0, maxAttempts: 1 },
        usageRequestId: randomUUID(),
        ...(input.onModelUsage === undefined ? {} : { onModelUsage: input.onModelUsage }),
        ...(input.onModelUsageFailure === undefined
          ? {}
          : { onModelUsageFailure: input.onModelUsageFailure }),
        system: defaultLanguage
          ? `${sessionTitlePrompt}\n- If the user message does not establish a language, use ${JSON.stringify(defaultLanguage)} as the default language.`
          : sessionTitlePrompt,
        messages: [{ role: 'user', content: titleInput }],
        tools: [],
        allowTools: false,
        reasoningEffort: resolveModelDefaultReasoningEffort(model)
      },
      signal
    )) {
      if (event.type === 'text.completed') output = event.text;
      else if (event.type === 'completed') completed = event.reason === 'completed';
    }
    signal.throwIfAborted();
    if (!completed) return undefined;
    const line = output
      .replace(/<think>[\s\S]*?<\/think>\s*/giu, '')
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .find(Boolean);
    return line ? [...line].slice(0, 50).join('') : undefined;
  } finally {
    await adapter.close?.();
  }
}
