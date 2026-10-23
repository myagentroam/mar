import { observeModelRequestUsage } from './usage-observer.js';
import { jsonToolInput } from './tool-input.js';
import { observationModelParts } from '../tools/code-mode/observations.js';
import { stableToolSchema } from '../tools/definition-projection.js';
import { randomUUID } from 'node:crypto';
import { MarAgentError } from '../error.js';
import {
  resolveModelDefaultReasoningEffort,
  type MarAgentModelConfiguration
} from './configuration.js';
import type { ModelAdapter, ModelEvent, ModelRequest, ModelStopReason } from './contracts.js';
import {
  isRetryableUpstreamOverloadCode,
  number,
  parseSse,
  record,
  text,
  observeModelStreamEvent,
  modelStreamEventObservedAt
} from './sse.js';
import {
  fetchModelResponse,
  modelRetryMaxAttempts,
  isRetryableModelRequestError,
  isRetryableModelTransportError,
  modelRetryDelay,
  waitForModelRetry
} from './http.js';
import { anthropicThinkingBlock, assertAnthropicThinkingBudget } from './anthropic-thinking.js';
import { resolveModelTextBlocks } from './text-blocks.js';
import { reportModelAttempt } from './attempt-diagnostics.js';
import { productUserAgent } from './product-user-agent.js';

export class AnthropicMessagesAdapter implements ModelAdapter {
  constructor(readonly configuration: MarAgentModelConfiguration) {}
  async *start(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const retryState = request.retryState ?? { attempts: 0 };
    const maxAttempts = modelRetryMaxAttempts(retryState);
    let resetOutputTiming = false;
    while (retryState.attempts < maxAttempts) {
      signal.throwIfAborted();
      if (resetOutputTiming) yield { type: 'output.reset' };
      resetOutputTiming = false;
      const attempt = retryState.attempts++;
      const startedAt = Date.now();
      const attemptDiagnostic = {
        protocol: 'ANTHROPIC_MESSAGES',
        transport: 'HTTP',
        attempt: attempt + 1,
        maxAttempts,
        continuation: false,
        credentialReason: 'REQUEST'
      } as const;
      // Buffer non-semantic events until a semantic event makes this attempt non-retryable.
      const prelude: ModelEvent[] = [];
      let sawSemanticEvent = false;
      let firstSemanticEventType: ModelEvent['type'] | undefined;
      await reportModelAttempt(request, { ...attemptDiagnostic, state: 'STARTED' });
      try {
        for await (const event of observeModelRequestUsage(
          () => this.startAttempt(request, signal),
          request,
          this.configuration,
          signal
        )) {
          if (event.type.startsWith('output.')) {
            resetOutputTiming = true;
            yield event;
            continue;
          }
          if (!sawSemanticEvent && !isSemanticEvent(event)) {
            prelude.push(event);
            continue;
          }
          if (!sawSemanticEvent) {
            sawSemanticEvent = true;
            firstSemanticEventType = event.type;
            for (const pending of prelude) yield pending;
            prelude.length = 0;
          }
          yield event;
        }
        await reportModelAttempt(request, {
          ...attemptDiagnostic,
          state: 'SUCCEEDED',
          semanticEventObserved: sawSemanticEvent,
          ...(firstSemanticEventType === undefined ? {} : { firstSemanticEventType }),
          durationMs: Math.max(0, Date.now() - startedAt)
        });
        return;
      } catch (error) {
        const retryable =
          isRetryableModelRequestError(error) || isAnthropicRecoverableStreamError(error);
        const willRetry =
          !signal.aborted && !sawSemanticEvent && retryable && attempt + 1 < maxAttempts;
        const delayMs = willRetry ? modelRetryDelay(retryAfter(error), attempt) : undefined;
        await reportModelAttempt(request, {
          ...attemptDiagnostic,
          state: 'FAILED',
          semanticEventObserved: sawSemanticEvent,
          ...(firstSemanticEventType === undefined ? {} : { firstSemanticEventType }),
          durationMs: Math.max(0, Date.now() - startedAt),
          errorCode: error instanceof MarAgentError ? error.code : 'MAR_AGENT_MODEL_ATTEMPT_FAILED',
          retryable,
          willRetry,
          ...(delayMs === undefined
            ? {}
            : { retryDelayMs: delayMs, retryReason: 'STREAM' as const })
        });
        if (!willRetry) throw error;
        await waitForModelRetry(retryAfter(error), attempt, signal, delayMs);
      }
    }
  }

  private async *startAttempt(
    request: ModelRequest,
    signal: AbortSignal
  ): AsyncIterable<ModelEvent> {
    const apiKey = this.configuration.apiKey;
    if (apiKey === undefined)
      throw new MarAgentError(
        'MAR_AGENT_MODEL_CONFIG_INVALID',
        'Anthropic Messages requires a static API key.'
      );
    const tools: unknown[] =
      request.allowTools === false
        ? []
        : request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: stableToolSchema(tool.inputSchema)
          }));
    const response = await fetchModelResponse(
      `${this.configuration.baseUrl.replace(/\/$/, '')}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'x-api-key': apiKey.reveal(),
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          'user-agent': productUserAgent(),
          accept: 'text/event-stream'
        },
        body: JSON.stringify({
          model: this.configuration.modelId,
          system:
            request.systemBlocks !== undefined
              ? anthropicTextBlocks(request.system, request.systemBlocks)
              : request.system
                ? [
                    {
                      type: 'text',
                      text: request.system,
                      cache_control: { type: 'ephemeral' }
                    }
                  ]
                : [],
          messages: anthropicMessages(
            request.messages,
            request.images,
            request.tools,
            this.configuration.id,
            request.systemBlocks === undefined &&
              request.messages.every((message) => message.textBlocks === undefined),
            request.cachePrefixMessages
          ),
          tools,
          ...(request.toolChoice === undefined
            ? {}
            : { tool_choice: { type: request.toolChoice } }),
          stream: true,
          max_tokens: Math.min(
            request.outputLimit ?? this.configuration.maxOutputTokens,
            this.configuration.maxOutputTokens
          ),
          output_config: {
            effort:
              request.reasoningEffort?.trim() ||
              resolveModelDefaultReasoningEffort(this.configuration)
          }
        })
      },
      signal,
      1
    );
    const blocks = new Map<
      number,
      {
        type: string;
        id: string;
        name?: string | undefined;
        json: string;
        text: string;
        signature: string;
        data?: unknown;
      }
    >();
    const hostedTools = new Map<
      string,
      {
        kind: 'WEB_SEARCH' | 'WEB_FETCH';
        toolName: string;
        summary: Extract<ModelEvent, { type: 'hosted_tool' }>['summary'];
      }
    >();
    // Block completion precedes the stop reason, which determines commentary vs final answer.
    const pendingTextBlocks = new Set<number>();
    let responseId = `anthropic-${randomUUID()}`;
    const completedThinking = new Set<number>();
    let terminal: ModelStopReason | undefined;
    let latestInputUsage: AnthropicInputUsage | undefined;
    let thinkingBytes = 0;
    for await (const raw of parseAnthropicSse(response, signal, apiKey.reveal())) {
      const event = record(raw);
      const type = text(event.type) ?? 'unknown';
      const index = number(event.index) ?? -1;
      if (type === 'message_start') {
        const message = record(event.message);
        responseId = text(message.id) ?? responseId;
        yield observeModelStreamEvent(
          {
            type: 'response.started',
            responseId,
            ...(text(message.model) ? { modelId: text(message.model)! } : {})
          },
          modelStreamEventObservedAt(raw)
        );
        const usage = record(message.usage);
        const inputTokens = inputTokenCount(usage.input_tokens);
        const cacheReadTokens = inputTokenCount(usage.cache_read_input_tokens);
        const cacheWriteTokens = inputTokenCount(usage.cache_creation_input_tokens);
        latestInputUsage = inputUsage(inputTokens, cacheReadTokens, cacheWriteTokens);
        yield observeModelStreamEvent(
          {
            type: 'usage',
            final: false,
            usage: {
              ...latestInputUsage
            }
          },
          modelStreamEventObservedAt(raw)
        );
      } else if (type === 'content_block_start') {
        const block = record(event.content_block);
        const blockType = text(block.type) ?? 'unknown';
        if (
          blockType === 'thinking' &&
          ((block.thinking !== undefined && typeof block.thinking !== 'string') ||
            (block.signature !== undefined && typeof block.signature !== 'string'))
        )
          throw new MarAgentError(
            'MAR_AGENT_MODEL_PROTOCOL_ERROR',
            'Anthropic returned an invalid native thinking block.'
          );
        if (['tool_use', 'server_tool_use', 'thinking', 'redacted_thinking'].includes(blockType)) {
          for (const blockIndex of pendingTextBlocks) {
            const pending = blocks.get(blockIndex);
            if (pending?.type === 'text')
              yield observeModelStreamEvent(
                {
                  type: 'text.completed',
                  itemId: pending.id,
                  phase: 'commentary',
                  text: pending.text
                },
                modelStreamEventObservedAt(raw)
              );
          }
          pendingTextBlocks.clear();
        }
        const id = text(block.id) ?? `${responseId}:content-${index}`;
        if (
          ['text', 'thinking', 'redacted_thinking', 'tool_use', 'server_tool_use'].includes(
            blockType
          )
        )
          yield observeModelStreamEvent(
            { type: 'output.started' },
            modelStreamEventObservedAt(raw)
          );
        blocks.set(index, {
          type: blockType,
          id,
          name: text(block.name),
          json: Object.keys(record(block.input)).length ? JSON.stringify(block.input) : '',
          text: text(block.text) ?? text(block.thinking) ?? '',
          signature: text(block.signature) ?? '',
          ...(blockType === 'redacted_thinking' ? { data: block.data } : {})
        });
        if (blockType === 'text' && text(block.text))
          yield observeModelStreamEvent(
            {
              type: 'text.delta',
              itemId: id,
              phase: 'commentary',
              delta: text(block.text) ?? ''
            },
            modelStreamEventObservedAt(raw)
          );
        else if (blockType === 'server_tool_use') {
          const toolName = text(block.name) ?? 'unknown';
          const kind = toolName === 'web_fetch' ? 'WEB_FETCH' : 'WEB_SEARCH';
          const summary = anthropicHostedInputSummary(record(block.input));
          hostedTools.set(id, { kind, toolName, summary });
          yield observeModelStreamEvent(
            {
              type: 'hosted_tool',
              itemId: id,
              kind,
              toolName,
              ...(Object.keys(summary).length ? { input: summary } : {}),
              status: 'RUNNING',
              summary
            },
            modelStreamEventObservedAt(raw)
          );
        } else if (
          blockType === 'web_search_tool_result' ||
          blockType === 'web_fetch_tool_result'
        ) {
          const toolId = text(block.tool_use_id);
          const hosted = toolId === undefined ? undefined : hostedTools.get(toolId);
          if (toolId !== undefined && hosted !== undefined) {
            const result = block.content;
            const sources = anthropicHostedSources(result);
            const summary = {
              ...hosted.summary,
              ...(Array.isArray(result) ? { sources } : {}),
              ...(Array.isArray(result) && result.length > 20 ? { sourcesTruncated: true } : {})
            };
            hostedTools.set(toolId, { ...hosted, summary });
            yield observeModelStreamEvent(
              {
                type: 'hosted_tool',
                itemId: toolId,
                kind: hosted.kind,
                toolName: hosted.toolName,
                ...(Object.keys(anthropicHostedInputSummary(hosted.summary)).length
                  ? { input: anthropicHostedInputSummary(hosted.summary) }
                  : {}),
                ...(sources.length
                  ? {
                      output: {
                        sources,
                        ...(summary.sourcesTruncated ? { sourcesTruncated: true } : {})
                      }
                    }
                  : {}),
                ...(summary.sourcesTruncated ? { truncated: true } : {}),
                status: anthropicHostedResultFailed(result) ? 'FAILED' : 'COMPLETED',
                summary
              },
              modelStreamEventObservedAt(raw)
            );
          }
        }
      } else if (type === 'content_block_delta') {
        const delta = record(event.delta);
        const block = blocks.get(index);
        if (block === undefined) continue;
        const deltaType = text(delta.type);
        if (deltaType === 'text_delta') {
          const value = text(delta.text) ?? '';
          block.text += value;
          yield observeModelStreamEvent(
            { type: 'text.delta', itemId: block.id, phase: 'commentary', delta: value },
            modelStreamEventObservedAt(raw)
          );
        } else if (deltaType === 'thinking_delta') {
          const value = text(delta.thinking) ?? '';
          block.text += value;
          if (value.length > 0)
            yield observeModelStreamEvent(
              { type: 'output.delta' },
              modelStreamEventObservedAt(raw)
            );
        } else if (deltaType === 'signature_delta') {
          if (block.type !== 'thinking' || typeof delta.signature !== 'string')
            throw new MarAgentError(
              'MAR_AGENT_MODEL_PROTOCOL_ERROR',
              'Anthropic returned an invalid thinking signature delta.'
            );
          block.signature += delta.signature;
        } else if (deltaType === 'input_json_delta') {
          const value = text(delta.partial_json) ?? '';
          block.json += value;
          if (value.length > 0)
            yield observeModelStreamEvent(
              { type: 'output.delta' },
              modelStreamEventObservedAt(raw)
            );
        } else if (deltaType === 'citations_delta') {
          const citation = record(delta.citation);
          const url = text(citation.url);
          if (url)
            yield observeModelStreamEvent(
              {
                type: 'citation',
                citation: { id: `${block.id}-citation`, url, title: text(citation.title) }
              },
              modelStreamEventObservedAt(raw)
            );
        }
      } else if (type === 'content_block_stop') {
        const block = blocks.get(index);
        if (block?.type === 'text') pendingTextBlocks.add(index);
        else if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
          if (completedThinking.has(index)) continue;
          completedThinking.add(index);
          if (block.type === 'redacted_thinking' || block.signature) {
            const item = anthropicThinkingBlock(
              block.type === 'thinking'
                ? { type: 'thinking', thinking: block.text, signature: block.signature }
                : { type: 'redacted_thinking', data: block.data }
            );
            if (!item)
              throw new MarAgentError(
                'MAR_AGENT_MODEL_PROTOCOL_ERROR',
                'Anthropic returned an invalid or oversized native thinking block.'
              );
            thinkingBytes += Buffer.byteLength(JSON.stringify(item));
            assertAnthropicThinkingBudget(thinkingBytes);
            yield observeModelStreamEvent(
              {
                type: 'response.item',
                provider: 'ANTHROPIC_MESSAGES',
                contextKind: 'private',
                item
              },
              modelStreamEventObservedAt(raw)
            );
          }
          if (block.type === 'thinking' && block.text.trim())
            yield observeModelStreamEvent(
              {
                type: 'reasoning.completed',
                itemId: block.id,
                representation: 'visible_thinking',
                text: block.text
              },
              modelStreamEventObservedAt(raw)
            );
        } else if (block?.type === 'server_tool_use') {
          yield observeModelStreamEvent({ type: 'output.paused' }, modelStreamEventObservedAt(raw));
          const hosted = hostedTools.get(block.id);
          if (hosted !== undefined) {
            let input: unknown;
            try {
              input = JSON.parse(block.json || '{}');
            } catch {
              input = undefined;
            }
            const summary = { ...hosted.summary, ...anthropicHostedInputSummary(record(input)) };
            if (summary.query !== hosted.summary.query || summary.url !== hosted.summary.url) {
              hostedTools.set(block.id, { ...hosted, summary });
              yield observeModelStreamEvent(
                {
                  type: 'hosted_tool',
                  itemId: block.id,
                  kind: hosted.kind,
                  toolName: hosted.toolName,
                  input: anthropicHostedInputSummary(record(input)),
                  status: 'RUNNING',
                  summary
                },
                modelStreamEventObservedAt(raw)
              );
            }
          }
        } else if (block?.type === 'tool_use') {
          let args: unknown = {};
          let argumentError: string | undefined;
          try {
            args = JSON.parse(block.json || '{}');
          } catch {
            argumentError = 'Tool arguments are invalid JSON.';
          }
          yield observeModelStreamEvent(
            {
              type: 'client_tool.call',
              callId: block.id,
              name: block.name ?? 'unknown',
              arguments: args,
              ...(argumentError ? { argumentError } : {})
            },
            modelStreamEventObservedAt(raw)
          );
        }
      } else if (type === 'message_delta') {
        const delta = record(event.delta);
        const reason = text(delta.stop_reason);
        if (reason !== undefined)
          yield observeModelStreamEvent(
            { type: 'output.completed' },
            modelStreamEventObservedAt(raw)
          );
        terminal =
          reason === 'tool_use'
            ? 'tool_use'
            : reason === 'pause_turn'
              ? 'pause'
              : reason === 'max_tokens'
                ? 'max_output'
                : 'completed';
        const phase = terminal === 'completed' ? 'final_answer' : 'commentary';
        for (const blockIndex of pendingTextBlocks) {
          const block = blocks.get(blockIndex);
          if (block?.type === 'text')
            yield observeModelStreamEvent(
              { type: 'text.completed', itemId: block.id, phase, text: block.text },
              modelStreamEventObservedAt(raw)
            );
        }
        pendingTextBlocks.clear();
        const usage = record(event.usage);
        const inputTokens = inputTokenCount(usage.input_tokens);
        const cacheReadTokens = inputTokenCount(usage.cache_read_input_tokens);
        const cacheWriteTokens = inputTokenCount(usage.cache_creation_input_tokens);
        // Some compatible gateways emit a complete all-zero input placeholder at the end.
        const zeroPlaceholder =
          inputTokens === 0 && cacheReadTokens === 0 && cacheWriteTokens === 0;
        if (!zeroPlaceholder)
          latestInputUsage = inputUsage(
            inputTokens ?? latestInputUsage?.inputTokens,
            cacheReadTokens ?? latestInputUsage?.cacheReadTokens,
            cacheWriteTokens ?? latestInputUsage?.cacheWriteTokens
          );
        yield observeModelStreamEvent(
          {
            type: 'usage',
            final: reason !== undefined,
            usage: {
              ...latestInputUsage,
              outputTokens: number(usage.output_tokens)
            }
          },
          modelStreamEventObservedAt(raw)
        );
      } else if (type === 'message_stop') {
        yield observeModelStreamEvent(
          { type: 'completed', reason: terminal ?? 'completed' },
          modelStreamEventObservedAt(raw)
        );
      } else if (type === 'error') {
        const upstream = record(event.error);
        const code = boundedError(text(upstream.code) ?? text(upstream.type), 80);
        const message = boundedError(text(upstream.message), 1_000);
        const retryable = isRetryableUpstreamOverloadCode(code);
        throw new MarAgentError(
          code ?? 'MAR_AGENT_MODEL_PROTOCOL_ERROR',
          message ?? 'Anthropic Messages request failed.',
          retryable
            ? {
                details: { retryAfter: response.headers.get('retry-after') },
                retryable: true
              }
            : {}
        );
      } else
        yield observeModelStreamEvent(
          { type: 'unknown', nativeType: type },
          modelStreamEventObservedAt(raw)
        );
    }
    if (terminal === undefined)
      throw new MarAgentError(
        'MAR_AGENT_MODEL_PROTOCOL_ERROR',
        'Anthropic Messages stream ended without a terminal event.',
        {
          retryable: true,
          details: {
            reason: 'ANTHROPIC_MESSAGES_EARLY_EOF',
            retryAfter: response.headers.get('retry-after')
          }
        }
      );
  }
}

async function* parseAnthropicSse(
  response: Response,
  signal: AbortSignal,
  apiKey: string
): AsyncIterable<unknown> {
  try {
    yield* parseSse(response, signal, undefined, undefined, [apiKey]);
  } catch (cause) {
    if (
      response.ok &&
      !signal.aborted &&
      (isRetryableModelTransportError(cause) ||
        (cause instanceof MarAgentError && cause.details?.reason === 'MODEL_STREAM_IDLE_TIMEOUT'))
    )
      throw new MarAgentError(
        'MAR_AGENT_MODEL_PROTOCOL_ERROR',
        'Anthropic Messages stream was interrupted.',
        {
          retryable: true,
          details: {
            reason: 'ANTHROPIC_MESSAGES_EARLY_EOF',
            retryAfter: response.headers.get('retry-after')
          },
          cause
        }
      );
    throw cause;
  }
}

function anthropicHostedInputSummary(
  input: Record<string, unknown>
): Extract<ModelEvent, { type: 'hosted_tool' }>['summary'] {
  const query = text(input.query);
  const url = text(input.url);
  return {
    ...(query ? { query: query.slice(0, 10_000) } : {}),
    ...(url ? { url: url.slice(0, 2_048) } : {})
  };
}

function anthropicHostedSources(
  result: unknown
): NonNullable<Extract<ModelEvent, { type: 'hosted_tool' }>['summary']['sources']> {
  if (!Array.isArray(result)) return [];
  return result
    .slice(0, 20)
    .map((entry) => {
      const source = record(entry);
      const url = text(source.url);
      if (!url) return undefined;
      const title = text(source.title);
      const snippet = text(source.snippet);
      return {
        url: url.slice(0, 2_048),
        ...(title ? { title: title.slice(0, 256) } : {}),
        ...(snippet ? { snippet: snippet.slice(0, 2000) } : {})
      };
    })
    .filter(
      (source): source is { url: string; title?: string; snippet?: string } => source !== undefined
    );
}

function anthropicHostedResultFailed(result: unknown): boolean {
  const entries = Array.isArray(result) ? result : [result];
  return entries.some((entry) => text(record(entry).type)?.endsWith('_tool_result_error'));
}

function isSemanticEvent(event: ModelEvent): boolean {
  if (event.type.startsWith('output.')) return false;
  return event.type !== 'response.started' && event.type !== 'usage';
}

export function isAnthropicRecoverableStreamError(error: unknown): error is MarAgentError {
  return (
    error instanceof MarAgentError &&
    error.retryable &&
    (isRetryableUpstreamOverloadCode(error.code) ||
      error.details?.reason === 'ANTHROPIC_MESSAGES_EARLY_EOF')
  );
}

function retryAfter(error: MarAgentError): string | null {
  const value = error.details?.retryAfter;
  return typeof value === 'string' ? value : null;
}

interface AnthropicInputUsage {
  totalInputTokens?: number | undefined;
  inputTokens?: number | undefined;
  contextInputTokens?: number | undefined;
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
}

function inputTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function inputUsage(
  inputTokens: number | undefined,
  cacheReadTokens: number | undefined,
  cacheWriteTokens: number | undefined
): AnthropicInputUsage {
  return {
    inputTokens,
    contextInputTokens: tokenSum(inputTokens, cacheReadTokens, cacheWriteTokens),
    ...(inputTokens === undefined
      ? {}
      : { totalInputTokens: tokenSum(inputTokens, cacheReadTokens, cacheWriteTokens) }),
    cacheReadTokens,
    cacheWriteTokens
  };
}

function tokenSum(...values: Array<number | undefined>): number | undefined {
  return values.some((value) => value !== undefined)
    ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    : undefined;
}

function boundedError(value: string | undefined, maximum: number): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return [...normalized].slice(0, maximum).join('');
}

function anthropicMessages(
  messages: ModelRequest['messages'],
  images?: ModelRequest['images'],
  tools: ModelRequest['tools'] = [],
  modelId?: string,
  automaticCache = true,
  cachePrefixMessages?: number
) {
  if (
    cachePrefixMessages !== undefined &&
    (!Number.isSafeInteger(cachePrefixMessages) ||
      cachePrefixMessages < 0 ||
      cachePrefixMessages > messages.length)
  )
    throw new MarAgentError(
      'MAR_AGENT_MODEL_REQUEST_INVALID',
      'The captured cache prefix is invalid.'
    );
  const imageMessage = messages.findLastIndex(isRealUserMessage);
  const toolDefinitions = new Map(tools.map((tool) => [tool.name, tool]));
  const result: { role: string; content: unknown }[] = [];
  let thinkingBytes = 0;
  for (const [index, message] of messages.entries()) {
    if (index === cachePrefixMessages)
      for (const prior of result.slice(-2)) prior.content = withCacheBreakpoint(prior.content);
    const userImages =
      message.role === 'user'
        ? uniqueModelImages(message.images, index === imageMessage ? images : undefined)
        : [];
    if (message.role === 'provider') {
      if (message.provider !== 'ANTHROPIC_MESSAGES' || message.providerModelId !== modelId)
        continue;
      const block = anthropicThinkingBlock(message.item);
      if (!block) continue;
      thinkingBytes += Buffer.byteLength(JSON.stringify(block));
      assertAnthropicThinkingBudget(thinkingBytes);
      const previous = result.at(-1);
      if (previous?.role === 'assistant' && Array.isArray(previous.content))
        previous.content.push(block);
      else result.push({ role: 'assistant', content: [block] });
      continue;
    }
    if (message.role === 'tool_call') {
      const block = {
        type: 'tool_use',
        id: message.callId,
        name: message.name,
        input: jsonToolInput(message, toolDefinitions.get(message.name ?? ''))
      };
      const previous = result.at(-1);
      if (previous?.role === 'assistant' && Array.isArray(previous.content))
        previous.content.push(block);
      else result.push({ role: 'assistant', content: [block] });
      continue;
    }
    if (message.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: message.callId,
        ...(message.isError === undefined ? {} : { is_error: message.isError }),
        content:
          observationModelParts(message)?.map((part) =>
            part.type === 'text'
              ? { type: 'text', text: part.text }
              : {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: part.image.mimeType,
                    data: part.image.dataBase64
                  }
                }
          ) ??
          (message.textBlocks !== undefined
            ? [
                ...anthropicTextBlocks(message.content, message.textBlocks),
                ...(message.images ?? []).map((image) => ({
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: image.mimeType,
                    data: image.dataBase64
                  }
                }))
              ]
            : message.images?.length
              ? [
                  { type: 'text', text: message.content },
                  ...message.images.map((image) => ({
                    type: 'image',
                    source: {
                      type: 'base64',
                      media_type: image.mimeType,
                      data: image.dataBase64
                    }
                  }))
                ]
              : message.content)
      };
      const previous = result.at(-1);
      if (previous?.role === 'user' && Array.isArray(previous.content))
        previous.content.push(block);
      else result.push({ role: 'user', content: [block] });
      continue;
    }
    if (message.role === 'assistant') {
      if (!message.content && message.textBlocks === undefined) continue;
      const blocks =
        message.textBlocks !== undefined
          ? anthropicTextBlocks(message.content, message.textBlocks)
          : [{ type: 'text', text: message.content }];
      const previous = result.at(-1);
      if (previous?.role === 'assistant' && Array.isArray(previous.content))
        previous.content.push(...blocks);
      else result.push({ role: 'assistant', content: blocks });
      continue;
    }
    result.push({
      role: message.role,
      content:
        message.textBlocks !== undefined
          ? [
              ...userImages.map((image) => ({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: image.mimeType,
                  data: image.dataBase64
                }
              })),
              ...anthropicTextBlocks(message.content, message.textBlocks)
            ]
          : userImages.length > 0
            ? [
                ...userImages.map((image) => ({
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: image.mimeType,
                    data: image.dataBase64
                  }
                })),
                { type: 'text', text: message.content }
              ]
            : message.content
    });
  }
  if (
    cachePrefixMessages === messages.length ||
    (cachePrefixMessages === undefined && automaticCache)
  )
    for (const message of result.slice(-2)) message.content = withCacheBreakpoint(message.content);
  return result;
}

function anthropicTextBlocks(text: string, blocks: NonNullable<ModelRequest['systemBlocks']>) {
  return resolveModelTextBlocks(text, blocks).map((block) => ({
    type: 'text',
    text: block.text,
    ...(block.cache ? { cache_control: { type: 'ephemeral' } } : {})
  }));
}

function isRealUserMessage(message: ModelRequest['messages'][number]): boolean {
  return (
    message.role === 'user' &&
    message.contextKind === undefined &&
    message.contextualBlock === undefined
  );
}

function uniqueModelImages(
  ...groups: Array<ModelRequest['images'] | undefined>
): Array<{ mimeType: string; dataBase64: string }> {
  const seen = new Set<string>();
  return groups.flatMap((group) =>
    (group ?? []).flatMap((image) => {
      const key = `${image.mimeType}\u0000${image.dataBase64}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [image];
    })
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function withCacheBreakpoint(content: unknown): unknown {
  if (typeof content === 'string')
    return [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }];
  if (!Array.isArray(content) || content.length === 0) return content;
  const blocks = [...content];
  const index = blocks.findLastIndex(
    (block) => isObject(block) && block.type !== 'thinking' && block.type !== 'redacted_thinking'
  );
  const last = blocks[index];
  if (!last || typeof last !== 'object') return content;
  blocks[index] = {
    ...(last as Record<string, unknown>),
    cache_control: { type: 'ephemeral' }
  };
  return blocks;
}
