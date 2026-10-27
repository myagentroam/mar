import { responsesRequestBody } from './responses-request.js';
export { openAiInput } from './responses-request.js';
import {
  ResponsesTextProjection,
  hostedWebActionInput,
  hostedWebActionSummary,
  responseCitations,
  responseEventId,
  responseItem
} from './responses-event-projection.js';
import { isRealUserMessage } from './input-images.js';
import { observeModelRequestUsage } from './usage-observer.js';
import { isDeepStrictEqual } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { describeAgentError, AgentError } from '../error.js';
import { assertInlineMediaBudget } from './inline-media-budget.js';
import {
  type AgentModelConfiguration,
  type ModelCredential,
  type ModelCredentialAcquireReason
} from './configuration.js';
import WebSocket, { type RawData } from 'ws';
import type {
  ModelAdapter,
  ModelAttemptDiagnostic,
  ModelEvent,
  ModelRequest,
  ModelTurnSession
} from './contracts.js';
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
  connectSocks5Target,
  fetchModelResponse,
  isRetryableModelHttpStatus,
  isRetryableModelTransportError,
  modelRetryMaxAttempts,
  isRetryableModelRequestError,
  modelRetryDelay,
  waitForModelRetry
} from './http.js';
import {
  acquireModelCredential,
  appendModelCredentialHeaders,
  modelCredentialSensitiveValues
} from './runtime-credential.js';
import { reportModelAttempt } from './attempt-diagnostics.js';
import { productUserAgent } from '../network/product-user-agent.js';
import {
  ResponsesSessionCache,
  clearResponsesContinuation,
  invalidateResponsesWebSocket,
  terminateWebSocket,
  type ResponsesRequestBody,
  type ResponsesSessionState
} from './responses-session-cache.js';

const WEBSOCKET_IDLE_TIMEOUT_MS = 300_000;
const WEBSOCKET_SEND_FRAME_BYTES = 1024 * 1024;
export const OPENAI_RESPONSES_EARLY_EOF_REASON = 'OPENAI_RESPONSES_EARLY_EOF';
export const OPENAI_RESPONSES_WEBSOCKET_CONNECTION_LIMIT_REASON =
  'OPENAI_RESPONSES_WEBSOCKET_CONNECTION_LIMIT';
const X_CODEX_TURN_STATE = 'x-codex-turn-state';

interface PreparedResponsesRequest {
  readonly inputItemCount: number;
  readonly fullBody: ResponsesRequestBody;
  readonly body: ResponsesRequestBody;
  readonly continuation: boolean;
}

type ResponsesWebSocketDiagnostic = Pick<
  ModelAttemptDiagnostic,
  | 'requestBytes'
  | 'imageCount'
  | 'imageBytes'
  | 'requestFrameCount'
  | 'sentFrameCount'
  | 'webSocketPhase'
  | 'webSocketCloseCode'
>;

export class OpenAiResponsesAdapter implements ModelAdapter {
  #cache = new ResponsesSessionCache();
  #configuration: AgentModelConfiguration;

  constructor(configuration: AgentModelConfiguration) {
    this.#configuration = configuration;
  }

  get configuration(): AgentModelConfiguration {
    return this.#configuration;
  }

  prepareReconfigure(configuration: AgentModelConfiguration): (() => void) | undefined {
    if (!sameResponsesAdapterConfiguration(this.#configuration, configuration)) return undefined;
    return () => {
      this.#configuration = configuration;
    };
  }

  async *start(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const turn = new OpenAiResponsesTurnSession(this, this.#cache, {}, false);
    try {
      yield* turn.start(request, signal);
    } finally {
      await turn.close();
    }
  }

  createTurnSession(): ModelTurnSession {
    const { state, lease } = this.#cache.checkout();
    return new OpenAiResponsesTurnSession(this, this.#cache, state, lease);
  }

  async close(): Promise<void> {
    this.#cache.close();
  }

  async *startTurn(
    request: ModelRequest,
    signal: AbortSignal,
    turn: OpenAiResponsesTurnSession,
    prepared: PreparedResponsesRequest
  ): AsyncIterable<ModelEvent> {
    let useContinuation = prepared.continuation;
    let requestBody = prepared.body;
    let credentialReason: ModelCredentialAcquireReason = 'REQUEST';
    let unauthorizedRetryUsed = false;
    let invalidContinuationFallbackUsed = false;
    const retryState = request.retryState ?? { attempts: 0 };
    const maxAttempts = modelRetryMaxAttempts(retryState);
    let resetOutputTiming = false;
    while (retryState.attempts < maxAttempts) {
      if (resetOutputTiming) yield { type: 'output.reset' };
      resetOutputTiming = false;
      const attempt = retryState.attempts++;
      const attemptNumber = attempt + 1;
      const attemptStartedAt = Date.now();
      const attemptContinuation = useContinuation;
      const attemptCredentialReason = credentialReason;
      const attemptTransport =
        this.configuration.responsesTransport?.transport === 'WEBSOCKET' ? 'WEBSOCKET' : 'HTTP';
      const requestPrefixDiagnostic = request.onAttemptDiagnostic
        ? {
            requestInputItems: prepared.inputItemCount
          }
        : {};
      const prelude: ModelEvent[] = [];
      let sawSemanticEvent = false;
      let firstSemanticEventType: ModelEvent['type'] | undefined;
      turn.beginAttempt();
      await reportModelAttempt(request, {
        protocol: 'OPENAI_RESPONSES',
        transport: attemptTransport,
        state: 'STARTED',
        attempt: attemptNumber,
        maxAttempts,
        continuation: attemptContinuation,
        credentialReason: attemptCredentialReason,
        ...requestPrefixDiagnostic
      });
      try {
        for await (const event of observeModelRequestUsage(
          () =>
            this.startAttempt(
              request,
              signal,
              requestBody,
              useContinuation,
              credentialReason,
              turn
            ),
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
          protocol: 'OPENAI_RESPONSES',
          transport: attemptTransport,
          state: 'SUCCEEDED',
          attempt: attemptNumber,
          maxAttempts,
          continuation: attemptContinuation,
          credentialReason: attemptCredentialReason,
          ...requestPrefixDiagnostic,
          semanticEventObserved: sawSemanticEvent,
          ...(firstSemanticEventType === undefined ? {} : { firstSemanticEventType }),
          ...turn.connectionDiagnostic(),
          durationMs: Math.max(0, Date.now() - attemptStartedAt)
        });
        return;
      } catch (error) {
        const reportFailure = async (
          willRetry: boolean,
          options: {
            readonly retryDelayMs?: number;
            readonly retryReason?: ModelAttemptDiagnostic['retryReason'];
          } = {}
        ) =>
          reportModelAttempt(request, {
            protocol: 'OPENAI_RESPONSES',
            transport: attemptTransport,
            state: 'FAILED',
            attempt: attemptNumber,
            maxAttempts,
            continuation: attemptContinuation,
            credentialReason: attemptCredentialReason,
            ...requestPrefixDiagnostic,
            semanticEventObserved: sawSemanticEvent,
            ...(firstSemanticEventType === undefined ? {} : { firstSemanticEventType }),
            ...turn.connectionDiagnostic(),
            durationMs: Math.max(0, Date.now() - attemptStartedAt),
            ...openAiResponsesAttemptError(error),
            willRetry,
            ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
            ...(options.retryReason === undefined ? {} : { retryReason: options.retryReason })
          });
        if (
          !signal.aborted &&
          !sawSemanticEvent &&
          useContinuation &&
          !invalidContinuationFallbackUsed &&
          isLocalContinuationReset(error)
        ) {
          invalidContinuationFallbackUsed = true;
          useContinuation = false;
          requestBody = prepared.fullBody;
          turn.resetContinuation();
          turn.invalidateWebSocket();
          retryState.attempts = Math.max(0, retryState.attempts - 1);
          credentialReason = 'RECONNECT';
          await reportFailure(true, {
            retryDelayMs: 0,
            retryReason: 'INVALID_CONTINUATION'
          });
          continue;
        }
        if (
          !signal.aborted &&
          attemptNumber < maxAttempts &&
          !sawSemanticEvent &&
          useContinuation &&
          !invalidContinuationFallbackUsed &&
          isInvalidPreviousResponseError(error)
        ) {
          invalidContinuationFallbackUsed = true;
          useContinuation = false;
          requestBody = prepared.fullBody;
          turn.resetContinuation();
          turn.invalidateWebSocket();
          credentialReason = 'RECONNECT';
          await reportFailure(true, {
            retryDelayMs: 0,
            retryReason: 'INVALID_CONTINUATION'
          });
          continue;
        }
        if (
          !signal.aborted &&
          attemptNumber < maxAttempts &&
          !sawSemanticEvent &&
          !unauthorizedRetryUsed &&
          this.configuration.credentialProvider !== undefined &&
          isModelAuthenticationFailure(error)
        ) {
          const revision = credentialRevision(error);
          if (revision !== undefined)
            await this.configuration.credentialProvider.invalidate(revision);
          unauthorizedRetryUsed = true;
          credentialReason = 'UNAUTHORIZED';
          await reportFailure(true, {
            retryDelayMs: 0,
            retryReason: 'UNAUTHORIZED'
          });
          continue;
        }
        const willRetry = !(
          signal.aborted ||
          (sawSemanticEvent && request.retryState === undefined) ||
          !(
            isRetryableModelRequestError(error) || isOpenAiResponsesRecoverableStreamError(error)
          ) ||
          attemptNumber >= maxAttempts
        );
        if (!willRetry) {
          await reportFailure(false);
          throw error;
        }
        const delayMs = modelRetryDelay(retryAfter(error), attempt);
        await reportFailure(true, {
          retryDelayMs: delayMs,
          retryReason: 'STREAM'
        });
        if (sawSemanticEvent) {
          retryState.retryDelayMs = delayMs;
          throw error;
        }
        credentialReason =
          error instanceof AgentError && error.details?.transport === 'WEBSOCKET'
            ? 'RECONNECT'
            : 'REQUEST';
        useContinuation = false;
        requestBody = prepared.fullBody;
        if (error instanceof AgentError && error.details?.transport === 'WEBSOCKET')
          turn.invalidateWebSocket();
        await waitForModelRetry(retryAfter(error), attempt, signal, delayMs);
      }
    }
  }

  private async *startAttempt(
    request: ModelRequest,
    signal: AbortSignal,
    body: ResponsesRequestBody,
    continuation: boolean,
    credentialReason: ModelCredentialAcquireReason,
    turn: OpenAiResponsesTurnSession
  ): AsyncIterable<ModelEvent> {
    let latestCredentialRevision: number | undefined;
    let diagnosticSecrets: readonly string[] = [];
    const fetchResponse = async (requestBody: ResponsesRequestBody) => {
      const serializedBody = JSON.stringify(requestBody);
      return await fetchModelResponse(
        responsesEndpoint(this.configuration.baseUrl),
        async () => {
          const credential = await acquireResponsesCredential(
            this.configuration,
            credentialReason,
            signal
          );
          latestCredentialRevision = credential.revision;
          diagnosticSecrets = modelCredentialSensitiveValues(credential);
          return {
            request: {
              method: 'POST',
              headers: responsesHeaders(
                credential,
                request.promptCacheKey,
                turn.currentTurnState()
              ),
              body: serializedBody,
              redirect: 'manual'
            },
            httpVersion:
              this.configuration.responsesTransport?.transport === 'HTTP'
                ? this.configuration.responsesTransport.httpVersion
                : '1.1',
            ...(credential.socks5Url === undefined
              ? {}
              : { socks5Url: credential.socks5Url.reveal() })
          };
        },
        signal,
        1
      );
    };
    let response: Response | undefined;
    let rawEvents: AsyncIterable<unknown>;
    try {
      if (this.configuration.responsesTransport?.transport === 'WEBSOCKET')
        rawEvents = webSocketResponseEvents({
          configuration: this.configuration,
          body,
          promptCacheKey: request.promptCacheKey,
          reason: credentialReason,
          signal,
          continuation,
          turn,
          credentialAcquired: (revision) => (latestCredentialRevision = revision)
        });
      else {
        response = await fetchResponse(body);
        turn.captureTurnState(response.headers.get(X_CODEX_TURN_STATE));
        rawEvents = parseOpenAiResponsesSse(response, signal, continuation, diagnosticSecrets);
      }
    } catch (error) {
      if (this.configuration.responsesTransport?.transport === 'WEBSOCKET')
        turn.invalidateWebSocket();
      throw withCredentialRevision(
        withResponsesAttemptDetails(
          error,
          continuation,
          this.configuration.responsesTransport?.transport
        ),
        latestCredentialRevision
      );
    }
    let completed = false;
    const functionCalls = new Map<string, { callId: string; name: string }>();
    const customCalls = new Map<string, { callId: string; name: string; input: string }>();
    const textProjection = new ResponsesTextProjection();
    const emittedReasoning = new Set<string>();
    const emittedFunctionCalls = new Set<string>();
    const hostedWebCalls = new Map<
      string,
      {
        kind: 'WEB_SEARCH' | 'WEB_FETCH';
        summary: Extract<ModelEvent, { type: 'hosted_tool' }>['summary'];
        input: Record<string, unknown>;
        truncated: boolean;
      }
    >();
    try {
      for await (const raw of rawEvents) {
        const event = record(raw);
        const type = text(event.type) ?? 'unknown';
        if (
          type === 'response.output_item.added' &&
          ['reasoning', 'message', 'function_call', 'custom_tool_call'].includes(
            text(record(event.item).type) ?? ''
          )
        )
          yield observeModelStreamEvent(
            { type: 'output.started' },
            modelStreamEventObservedAt(raw)
          );
        if (type === 'response.web_search_call.searching')
          yield observeModelStreamEvent({ type: 'output.paused' }, modelStreamEventObservedAt(raw));
        if (type === 'response.output_item.done') {
          const item = responseItem(event.item);
          if (item)
            yield observeModelStreamEvent(
              { type: 'response.item', provider: 'OPENAI_RESPONSES', item },
              modelStreamEventObservedAt(raw)
            );
        }
        const projectedText = textProjection.project(event, type);
        if (projectedText.handled) {
          if (projectedText.event)
            yield observeModelStreamEvent(projectedText.event, modelStreamEventObservedAt(raw));
        } else if (
          type === 'response.output_item.added' &&
          text(record(event.item).type) === 'function_call'
        ) {
          const item = record(event.item);
          const itemId = text(item.id);
          if (itemId)
            functionCalls.set(itemId, {
              callId: text(item.call_id) ?? itemId,
              name: text(item.name) ?? 'unknown'
            });
        } else if (
          type === 'response.output_item.added' &&
          text(record(event.item).type) === 'custom_tool_call'
        ) {
          const item = record(event.item);
          const itemId = text(item.id);
          if (itemId)
            customCalls.set(itemId, {
              callId: text(item.call_id) ?? itemId,
              name: text(item.name) ?? 'unknown',
              input: text(item.input) ?? ''
            });
        } else if (
          (type === 'response.output_item.added' || type === 'response.output_item.done') &&
          text(record(event.item).type) === 'reasoning'
        ) {
          // Native reasoning context is retained above; its lifecycle is not visible output.
          continue;
        } else if (type === 'response.custom_tool_call_input.delta') {
          const itemId = text(event.item_id) ?? '';
          const known = customCalls.get(itemId);
          const delta = text(event.delta) ?? '';
          if (known) known.input += delta;
          if (delta.length > 0)
            yield observeModelStreamEvent(
              { type: 'output.delta' },
              modelStreamEventObservedAt(raw)
            );
        } else if (
          type === 'response.function_call_arguments.delta' ||
          type === 'response.reasoning_text.delta' ||
          type === 'response.reasoning_summary_text.delta'
        ) {
          if ((text(event.delta)?.length ?? 0) > 0)
            yield observeModelStreamEvent(
              { type: 'output.delta' },
              modelStreamEventObservedAt(raw)
            );
        } else if (type === 'response.created')
          yield observeModelStreamEvent(
            {
              type: 'response.started',
              responseId: responseEventId(event) ?? 'unknown',
              ...(text(record(event.response).model)
                ? { modelId: text(record(event.response).model)! }
                : {})
            },
            modelStreamEventObservedAt(raw)
          );
        else if (type === 'response.reasoning_summary_text.done') {
          const itemId = JSON.stringify([
            text(event.item_id) ?? `reasoning-${event.output_index ?? 0}`,
            event.summary_index ?? 0
          ]);
          const summary = text(event.text) ?? '';
          if (!summary.trim() || emittedReasoning.has(itemId)) continue;
          emittedReasoning.add(itemId);
          yield observeModelStreamEvent(
            {
              type: 'reasoning.completed',
              itemId,
              representation: 'summary',
              text: summary
            },
            modelStreamEventObservedAt(raw)
          );
        } else if (
          type === 'response.output_item.done' &&
          text(record(event.item).type) === 'tool_search_call'
        ) {
          const item = record(event.item);
          const callId = text(item.call_id) ?? text(item.id) ?? 'unknown';
          let arguments_: unknown = item.arguments ?? {};
          let argumentError: string | undefined;
          if (typeof arguments_ === 'string')
            try {
              arguments_ = JSON.parse(arguments_);
            } catch {
              argumentError = 'Tool Search arguments are invalid JSON.';
            }
          if (!emittedFunctionCalls.has(callId)) {
            emittedFunctionCalls.add(callId);
            yield observeModelStreamEvent(
              {
                type: 'client_tool.call',
                callId,
                name: 'tool_search',
                arguments: arguments_,
                ...(argumentError ? { argumentError } : {})
              },
              modelStreamEventObservedAt(raw)
            );
          }
        } else if (
          type === 'response.function_call_arguments.done' ||
          (type === 'response.output_item.done' &&
            text(record(event.item).type) === 'function_call')
        ) {
          const item = record(event.item);
          const known = functionCalls.get(text(event.item_id) ?? text(item.id) ?? '');
          let args: unknown = {};
          let argumentError: string | undefined;
          try {
            args = JSON.parse(text(event.arguments) ?? text(item.arguments) ?? '{}');
          } catch {
            argumentError = 'Function arguments are invalid JSON.';
          }
          const callId =
            text(event.call_id) ??
            text(item.call_id) ??
            known?.callId ??
            text(event.item_id) ??
            text(item.id) ??
            'unknown';
          if (!emittedFunctionCalls.has(callId)) {
            emittedFunctionCalls.add(callId);
            yield observeModelStreamEvent(
              {
                type: 'client_tool.call',
                callId,
                name: text(event.name) ?? text(item.name) ?? known?.name ?? 'unknown',
                arguments: args,
                ...(argumentError ? { argumentError } : {})
              },
              modelStreamEventObservedAt(raw)
            );
          }
        } else if (
          type === 'response.custom_tool_call_input.done' ||
          (type === 'response.output_item.done' &&
            text(record(event.item).type) === 'custom_tool_call')
        ) {
          const item = record(event.item);
          const itemId = text(event.item_id) ?? text(item.id) ?? '';
          const known = customCalls.get(itemId);
          const callId = text(event.call_id) ?? text(item.call_id) ?? known?.callId ?? itemId;
          if (!emittedFunctionCalls.has(callId)) {
            emittedFunctionCalls.add(callId);
            yield observeModelStreamEvent(
              {
                type: 'client_tool.call',
                callId,
                name: text(event.name) ?? text(item.name) ?? known?.name ?? 'unknown',
                arguments: text(event.input) ?? text(item.input) ?? known?.input ?? '',
                inputMode: 'freeform'
              },
              modelStreamEventObservedAt(raw)
            );
          }
        } else if (
          type.includes('web_search_call') ||
          text(record(event.item).type) === 'web_search_call'
        ) {
          const item = record(event.item);
          const itemId = text(event.item_id) ?? text(item.id) ?? 'web';
          const previous = hostedWebCalls.get(itemId);
          const action = record(
            Object.keys(record(event.action)).length ? event.action : item.action
          );
          const actionType = text(action.type);
          const kind =
            actionType === 'open_page' || actionType === 'find_in_page'
              ? 'WEB_FETCH'
              : (previous?.kind ?? 'WEB_SEARCH');
          const summary = { ...previous?.summary, ...hostedWebActionSummary(action) };
          const projected = hostedWebActionInput(action);
          const input = { ...previous?.input, ...projected.input };
          const truncated = previous?.truncated === true || projected.truncated;
          hostedWebCalls.set(itemId, { kind, summary, input, truncated });
          const output = {
            ...(summary.title === undefined ? {} : { title: summary.title }),
            ...(summary.sources === undefined ? {} : { sources: summary.sources }),
            ...(summary.sourcesTruncated === undefined
              ? {}
              : { sourcesTruncated: summary.sourcesTruncated })
          };
          yield observeModelStreamEvent(
            {
              type: 'hosted_tool',
              itemId,
              kind,
              toolName: 'web_search',
              ...(Object.keys(input).length ? { input } : {}),
              ...(Object.keys(output).length ? { output } : {}),
              ...(truncated || summary.sourcesTruncated === true ? { truncated: true } : {}),
              status: type.endsWith('.failed')
                ? 'FAILED'
                : type.endsWith('.completed') || type === 'response.output_item.done'
                  ? 'COMPLETED'
                  : 'RUNNING',
              summary
            },
            modelStreamEventObservedAt(raw)
          );
        } else if (type === 'response.output_text.annotation.added') {
          const annotation = record(event.annotation);
          const url = text(annotation.url);
          if (url)
            yield observeModelStreamEvent(
              {
                type: 'citation',
                citation: {
                  id:
                    text(annotation.id) ??
                    `${text(event.item_id) ?? 'text'}-${number(event.annotation_index) ?? 0}`,
                  url,
                  ...(text(annotation.title) ? { title: text(annotation.title) } : {})
                }
              },
              modelStreamEventObservedAt(raw)
            );
        } else if (type === 'response.completed' || type === 'response.incomplete') {
          yield observeModelStreamEvent(
            { type: 'output.completed' },
            modelStreamEventObservedAt(raw)
          );
          const responseData = record(event.response);
          if (type === 'response.completed')
            turn.captureCompletedResponseId(responseEventId(event));
          for (const output of textProjection.finish())
            yield observeModelStreamEvent(output, modelStreamEventObservedAt(raw));
          for (const citation of responseCitations(responseData))
            yield observeModelStreamEvent(
              { type: 'citation', citation },
              modelStreamEventObservedAt(raw)
            );
          const usage = record(responseData.usage);
          const inputDetails = record(usage.input_tokens_details);
          const rolloutBudgetUnits = optionalRolloutBudgetUnits(usage.codex_rollout_budget_units);
          yield observeModelStreamEvent(
            {
              type: 'usage',
              final: true,
              usage: {
                inputTokens: number(usage.input_tokens),
                totalInputTokens: number(usage.input_tokens),
                reasoningTokens: number(record(usage.output_tokens_details).reasoning_tokens),
                contextInputTokens: number(usage.input_tokens),
                outputTokens: number(usage.output_tokens),
                cacheReadTokens: number(inputDetails.cached_tokens),
                cacheWriteTokens: number(inputDetails.cache_write_tokens),
                ...(rolloutBudgetUnits === undefined ? {} : { rolloutBudgetUnits })
              }
            },
            modelStreamEventObservedAt(raw)
          );
          yield observeModelStreamEvent(
            {
              type: 'completed',
              reason: type === 'response.incomplete' ? 'max_output' : 'completed'
            },
            modelStreamEventObservedAt(raw)
          );
          completed = true;
        } else if (
          type === 'error' ||
          type === 'response.failed' ||
          (event.type === undefined && event.error !== undefined)
        ) {
          const topLevel = record(event.error);
          const nested = record(record(event.response).error);
          const code = boundedError(
            text(event.code) ??
              text(topLevel.code) ??
              text(topLevel.type) ??
              text(nested.code) ??
              text(nested.type),
            80
          );
          const message = boundedError(
            text(event.message) ??
              text(topLevel.message) ??
              text(nested.message) ??
              text(event.error),
            1_000
          );
          const status = upstreamHttpStatus(
            event.status,
            topLevel.status,
            record(event.response).status,
            nested.status
          );
          const connectionLimit =
            this.configuration.responsesTransport?.transport === 'WEBSOCKET' &&
            isWebSocketConnectionLimitCode(code);
          const retryable = connectionLimit || isRetryableResponsesUpstreamError(code, message);
          throw new AgentError(
            code ?? 'MAR_AGENT_MODEL_PROTOCOL_ERROR',
            message ?? 'OpenAI Responses request failed.',
            {
              details: {
                ...(status === undefined ? {} : { status }),
                ...(connectionLimit
                  ? { reason: OPENAI_RESPONSES_WEBSOCKET_CONNECTION_LIMIT_REASON }
                  : {}),
                ...(retryable ? { retryAfter: response?.headers.get('retry-after') ?? null } : {}),
                continuation,
                ...(this.configuration.responsesTransport?.transport === 'WEBSOCKET'
                  ? { transport: 'WEBSOCKET' }
                  : {})
              },
              ...(retryable ? { retryable: true } : {})
            }
          );
        } else if (!isNonSemanticOpenAiResponsesEvent(type))
          yield observeModelStreamEvent(
            { type: 'unknown', nativeType: type },
            modelStreamEventObservedAt(raw)
          );
      }
    } catch (error) {
      if (this.configuration.responsesTransport?.transport === 'WEBSOCKET')
        turn.invalidateWebSocket();
      throw withCredentialRevision(
        withResponsesAttemptDetails(
          error,
          continuation,
          this.configuration.responsesTransport?.transport
        ),
        latestCredentialRevision
      );
    }
    if (!completed)
      throw new AgentError(
        'MAR_AGENT_MODEL_PROTOCOL_ERROR',
        'OpenAI Responses stream ended without a terminal event.',
        {
          details: {
            reason: OPENAI_RESPONSES_EARLY_EOF_REASON,
            retryAfter: response?.headers.get('retry-after') ?? null,
            continuation,
            ...(this.configuration.responsesTransport?.transport === 'WEBSOCKET'
              ? { transport: 'WEBSOCKET' }
              : {})
          },
          retryable: true
        }
      );
  }
}

function sameResponsesAdapterConfiguration(
  current: AgentModelConfiguration,
  next: AgentModelConfiguration
): boolean {
  const {
    apiKey: currentApiKey,
    credentialProvider: currentCredentialProvider,
    ...currentTransport
  } = current;
  const { apiKey: nextApiKey, credentialProvider: nextCredentialProvider, ...nextTransport } = next;
  const credentialsAreRebindable =
    (currentCredentialProvider !== undefined && nextCredentialProvider !== undefined) ||
    (currentApiKey !== undefined &&
      nextApiKey !== undefined &&
      currentApiKey.reveal() === nextApiKey.reveal());
  return credentialsAreRebindable && isDeepStrictEqual(currentTransport, nextTransport);
}

class OpenAiResponsesTurnSession implements ModelTurnSession {
  #active: AsyncGenerator<ModelEvent, void, unknown> | undefined;
  #abort: AbortController | undefined;
  #closePromise: Promise<void> | undefined;
  #closed = false;
  #turnState: string | undefined;
  #completedResponseId: string | undefined;
  #connectionDiagnostic:
    Pick<ModelAttemptDiagnostic, 'connectionId' | 'connectionReused' | 'proxyType'> | undefined;
  #webSocketDiagnostic: ResponsesWebSocketDiagnostic | undefined;

  constructor(
    private readonly adapter: OpenAiResponsesAdapter,
    private readonly cache: ResponsesSessionCache,
    private readonly state: ResponsesSessionState,
    private readonly cacheLease: boolean
  ) {}

  start(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const abort = new AbortController();
    const iterator = this.run(request, AbortSignal.any([signal, abort.signal]));
    let started = false;
    let returnedBeforeStart = false;
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          if (returnedBeforeStart) return iterator.next();
          if (!started) {
            if (this.#closed)
              return Promise.reject(
                new AgentError('MAR_AGENT_DISPOSED', 'Model turn session is disposed.')
              );
            if (this.#active !== undefined)
              return Promise.reject(
                new AgentError(
                  'MAR_AGENT_MODEL_PROTOCOL_ERROR',
                  'Model turn session already has an active request.'
                )
              );
            started = true;
            this.#active = iterator;
            this.#abort = abort;
          }
          return iterator.next();
        },
        return: () => {
          if (!started) returnedBeforeStart = true;
          return iterator.return(undefined);
        },
        throw: (error: unknown) => {
          if (!started) returnedBeforeStart = true;
          return iterator.throw(error);
        }
      })
    };
  }

  private async *run(
    request: ModelRequest,
    signal: AbortSignal
  ): AsyncGenerator<ModelEvent, void, unknown> {
    let responseId: string | undefined;
    const outputItems: Record<string, unknown>[] = [];
    let completed = false;
    let sawUnrepresentedOutput = false;
    let outputMessageCount = 0;
    let finished = false;
    try {
      const prepared = this.prepareRequest(request);
      this.#completedResponseId = undefined;
      for await (const event of this.adapter.startTurn(request, signal, this, prepared)) {
        if (
          event.type === 'response.item' ||
          event.type === 'text.completed' ||
          event.type === 'client_tool.call'
        )
          outputMessageCount++;
        if (event.type === 'response.started' && event.responseId !== 'unknown')
          responseId = event.responseId;
        else if (event.type === 'response.item')
          outputItems.push(JSON.parse(JSON.stringify(event.item)) as Record<string, unknown>);
        else if (
          event.type === 'text.delta' ||
          event.type === 'output.delta' ||
          event.type === 'text.completed' ||
          event.type === 'reasoning.completed' ||
          event.type === 'client_tool.call' ||
          event.type === 'hosted_tool' ||
          event.type === 'citation' ||
          event.type === 'unknown'
        )
          sawUnrepresentedOutput = true;
        else if (event.type === 'completed')
          completed = event.reason === 'completed' || event.reason === 'tool_use';
        yield event;
      }
      responseId = this.#completedResponseId ?? responseId;
      if (
        responsesContinuationEnabled(this.adapter.configuration) &&
        completed &&
        responseId !== undefined &&
        (outputItems.length > 0 || !sawUnrepresentedOutput)
      ) {
        this.state.lastRequest =
          this.adapter.configuration.responsesTransport?.transport === 'WEBSOCKET'
            ? { ...prepared.body, input: [] }
            : prepared.fullBody;
        this.state.lastMessageCount = request.messages.length + outputMessageCount;
        this.state.lastInputItemCount = prepared.inputItemCount;
        this.state.lastSystem = JSON.stringify([request.system, request.systemBlocks]);
        this.state.lastResponse = { responseId, outputItems };
      } else clearResponsesContinuation(this.state);
      finished = true;
    } catch (error) {
      clearResponsesContinuation(this.state);
      throw error;
    } finally {
      if (!finished) invalidateResponsesWebSocket(this.state, true);
      this.#completedResponseId = undefined;
      this.#active = undefined;
      this.#abort = undefined;
    }
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    const active = this.#active;
    const abort = this.#abort;
    this.#closePromise = Promise.resolve().then(async () => {
      try {
        if (active !== undefined) {
          abort?.abort();
          await active.return(undefined);
        }
      } finally {
        this.cache.release(this.state, this.cacheLease);
      }
    });
    return this.#closePromise;
  }

  resetContinuation(): void {
    clearResponsesContinuation(this.state);
  }

  continuationInputCount(): number {
    return this.state.lastMessageCount ?? 0;
  }

  commitContinuationInput(messageCount: number): void {
    if (this.state.lastResponse !== undefined) this.state.lastMessageCount = messageCount;
  }

  captureCompletedResponseId(responseId: string | undefined): void {
    if (responseId !== undefined) this.#completedResponseId = responseId;
  }

  prepareRequest(request: ModelRequest): PreparedResponsesRequest {
    assertInlineMediaBudget(request);
    if (
      this.adapter.configuration.responsesTransport?.transport === 'WEBSOCKET' &&
      this.state.socket !== undefined &&
      this.state.socket.readyState !== WebSocket.OPEN
    ) {
      invalidateResponsesWebSocket(this.state, false);
      clearResponsesContinuation(this.state);
    }
    // The continuation baseline must not share mutable schemas or items with callers.
    const snapshot = (body: ResponsesRequestBody) =>
      JSON.parse(JSON.stringify(body)) as ResponsesRequestBody;
    let full: ResponsesRequestBody | undefined;
    const fullBody = () =>
      (full ??= snapshot(
        responsesRequestBody(this.adapter.configuration, request, request.messages)
      ));
    if (responsesContinuationEnabled(this.adapter.configuration)) {
      const websocket = this.adapter.configuration.responsesTransport?.transport === 'WEBSOCKET';
      const suffixMessages =
        websocket && this.state.lastMessageCount !== undefined
          ? request.messages.slice(this.state.lastMessageCount)
          : undefined;
      const suffixBody =
        websocket &&
        this.state.lastResponse !== undefined &&
        suffixMessages !== undefined &&
        this.state.lastRequest !== undefined &&
        this.state.lastSystem === JSON.stringify([request.system, request.systemBlocks]) &&
        // Top-level images attach to the last real user, which must be in this suffix.
        (!request.images?.length || suffixMessages.some(isRealUserMessage))
          ? snapshot(
              responsesRequestBody(
                this.adapter.configuration,
                { ...request, system: '', systemBlocks: [] },
                suffixMessages,
                this.state.lastResponse.outputItems
              )
            )
          : undefined;
      const incremental = websocket
        ? suffixBody !== undefined &&
          responsesContinuationPropertiesMatch(this.state.lastRequest!, suffixBody)
          ? suffixBody.input
          : undefined
        : incrementalResponsesInput(this.state, fullBody());
      if (incremental !== undefined) {
        const responseId = this.state.lastResponse!.responseId;
        const inputItemCount = websocket
          ? (this.state.lastInputItemCount ?? 0) +
            this.state.lastResponse!.outputItems.length +
            incremental.length
          : fullBody().input.length;
        delete this.state.lastResponse;
        return {
          get fullBody() {
            return fullBody();
          },
          inputItemCount,
          body: {
            ...(suffixBody ?? fullBody()),
            input: incremental,
            previous_response_id: responseId
          },
          continuation: true
        };
      }
    }
    return {
      fullBody: fullBody(),
      inputItemCount: fullBody().input.length,
      body: fullBody(),
      continuation: false
    };
  }

  currentTurnState(): string | undefined {
    return this.#turnState;
  }

  beginAttempt(): void {
    this.#connectionDiagnostic = undefined;
    this.#webSocketDiagnostic = undefined;
  }

  captureWebSocketDiagnostic(diagnostic: ResponsesWebSocketDiagnostic): void {
    this.#webSocketDiagnostic = diagnostic;
  }

  connectionDiagnostic(): Pick<
    ModelAttemptDiagnostic,
    'connectionId' | 'connectionReused' | 'proxyType'
  > &
    ResponsesWebSocketDiagnostic {
    return { ...this.#connectionDiagnostic, ...this.#webSocketDiagnostic };
  }

  captureTurnState(value: unknown): void {
    if (this.#turnState !== undefined || typeof value !== 'string') return;
    const bounded = boundedError(value.trim(), 8_192);
    if (bounded) this.#turnState = bounded;
  }

  withTurnStateMetadata(body: ResponsesRequestBody): ResponsesRequestBody {
    if (this.#turnState === undefined) return body;
    return {
      ...body,
      client_metadata: {
        ...record(body.client_metadata),
        [X_CODEX_TURN_STATE]: this.#turnState
      }
    };
  }

  invalidateWebSocket(): void {
    invalidateResponsesWebSocket(this.state, true);
  }

  async webSocketForRequest(input: {
    readonly configuration: AgentModelConfiguration;
    readonly promptCacheKey: string | undefined;
    readonly reason: ModelCredentialAcquireReason;
    readonly signal: AbortSignal;
    readonly continuation: boolean;
    readonly credentialAcquired: (revision: number) => void;
  }): Promise<WebSocket> {
    const endpoint = webSocketEndpoint(input.configuration.baseUrl);
    const existingSocket = this.state.socket;
    if (
      existingSocket !== undefined &&
      (existingSocket.readyState !== WebSocket.OPEN || this.state.endpoint !== endpoint)
    ) {
      invalidateResponsesWebSocket(this.state, false);
      if (input.continuation) {
        clearResponsesContinuation(this.state);
        throw localContinuationReset();
      }
    }

    if (input.continuation && this.state.socket === undefined) {
      clearResponsesContinuation(this.state);
      throw localContinuationReset();
    }

    if (this.state.socket === undefined) {
      const handshakeCredential = await acquireResponsesCredential(
        input.configuration,
        input.reason,
        input.signal
      );
      input.credentialAcquired(handshakeCredential.revision);
      await this.connectWebSocket(
        endpoint,
        handshakeCredential,
        input.promptCacheKey,
        input.signal
      );
    }

    const requestCredential = await acquireResponsesCredential(
      input.configuration,
      input.reason,
      input.signal
    );
    input.credentialAcquired(requestCredential.revision);
    if (
      requestCredential.revision !== this.state.credentialRevision ||
      responsesCredentialFingerprint(requestCredential) !== this.state.credentialFingerprint
    ) {
      invalidateResponsesWebSocket(this.state, false);
      if (input.continuation) {
        clearResponsesContinuation(this.state);
        throw localContinuationReset();
      }
      await this.connectWebSocket(endpoint, requestCredential, input.promptCacheKey, input.signal);
    }
    if (input.signal.aborted) {
      invalidateResponsesWebSocket(this.state, true);
      throw input.signal.reason;
    }
    const socket = this.state.socket;
    if (socket?.readyState !== WebSocket.OPEN) {
      invalidateResponsesWebSocket(this.state, true);
      throw new AgentError(
        'MAR_AGENT_MODEL_CONNECTION_FAILED',
        'OpenAI Responses WebSocket connection is unavailable.',
        {
          details: {
            transport: 'WEBSOCKET',
            continuation: input.continuation,
            reason: 'MODEL_TRANSPORT_FAILURE'
          },
          retryable: true
        }
      );
    }
    if (
      this.#connectionDiagnostic === undefined &&
      this.state.connectionId !== undefined &&
      this.state.proxyType !== undefined
    )
      this.#connectionDiagnostic = {
        connectionId: this.state.connectionId,
        connectionReused: true,
        proxyType: this.state.proxyType
      };
    return socket;
  }

  private async connectWebSocket(
    endpoint: string,
    credential: ModelCredential,
    promptCacheKey: string | undefined,
    signal: AbortSignal
  ): Promise<void> {
    const parsedEndpoint = new URL(endpoint);
    const connectionId = randomUUID();
    const proxyType = credential.socks5Url === undefined ? 'DIRECT' : 'SOCKS5';
    this.#connectionDiagnostic = { connectionId, connectionReused: false, proxyType };
    const socket = new WebSocket(parsedEndpoint, {
      headers: Object.fromEntries(webSocketHeaders(credential, promptCacheKey)),
      perMessageDeflate: false,
      maxPayload: 16 * 1024 * 1024,
      handshakeTimeout: 30_000,
      ...(credential.socks5Url === undefined
        ? {}
        : {
            createConnection: socks5WebSocketConnection(
              credential.socks5Url.reveal(),
              parsedEndpoint,
              signal
            )
          })
    });
    try {
      await waitForWebSocketOpen(socket, signal);
    } catch (error) {
      terminateWebSocket(socket);
      throw error;
    }
    this.state.socket = socket;
    this.state.endpoint = endpoint;
    this.state.credentialRevision = credential.revision;
    this.state.credentialFingerprint = responsesCredentialFingerprint(credential);
    this.state.connectionId = connectionId;
    this.state.proxyType = proxyType;
  }
}

function localContinuationReset(): AgentError {
  return new AgentError(
    'MAR_AGENT_RESPONSES_CONTINUATION_RESET',
    'The Responses connection changed before the incremental request was sent.'
  );
}

function isLocalContinuationReset(error: unknown): boolean {
  return error instanceof AgentError && error.code === 'MAR_AGENT_RESPONSES_CONTINUATION_RESET';
}

function incrementalResponsesInput(
  state: ResponsesSessionState,
  current: ResponsesRequestBody
): readonly unknown[] | undefined {
  const previous = state.lastRequest;
  const completion = state.lastResponse;
  if (previous === undefined || completion === undefined) return undefined;
  if (!responsesContinuationPropertiesMatch(previous, current)) return undefined;
  const baseline = [...previous.input, ...completion.outputItems];
  if (current.input.length < baseline.length) return undefined;
  for (let index = 0; index < baseline.length; index++)
    if (JSON.stringify(baseline[index]) !== JSON.stringify(current.input[index])) return undefined;
  return current.input.slice(baseline.length);
}

function responsesContinuationPropertiesMatch(
  previous: ResponsesRequestBody,
  current: ResponsesRequestBody
): boolean {
  return (
    JSON.stringify({ ...previous, input: undefined, previous_response_id: undefined }) ===
    JSON.stringify({ ...current, input: undefined, previous_response_id: undefined })
  );
}

function hashResponsesValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function responsesContinuationEnabled(configuration: AgentModelConfiguration): boolean {
  return configuration.responsesPreviousResponseId === true;
}

function responsesCredentialFingerprint(credential: ModelCredential): string {
  return hashResponsesValue({
    bearer: credential.bearer.reveal(),
    headers: Object.fromEntries(
      Object.entries(credential.headers).map(([name, value]) => [
        name,
        typeof value === 'string' ? value : value.reveal()
      ])
    ),
    socks5Url: credential.socks5Url?.reveal()
  });
}

function turnStateFromEvent(event: Record<string, unknown>): string | undefined {
  for (const headers of [
    record(event.headers),
    record(record(event.response).headers),
    record(record(event.metadata).headers)
  ]) {
    for (const [name, value] of Object.entries(headers))
      if (name.toLowerCase() === X_CODEX_TURN_STATE && typeof value === 'string') return value;
  }
  return undefined;
}

async function* parseOpenAiResponsesSse(
  response: Response,
  signal: AbortSignal,
  continuation: boolean,
  sensitiveValues: readonly string[]
): AsyncIterable<unknown> {
  try {
    yield* parseSse(response, signal, undefined, undefined, sensitiveValues);
  } catch (cause) {
    if (response.ok && !signal.aborted && isRetryableOpenAiStreamReadError(cause))
      throw new AgentError(
        'MAR_AGENT_MODEL_PROTOCOL_ERROR',
        'OpenAI Responses stream was interrupted.',
        {
          details: {
            reason: OPENAI_RESPONSES_EARLY_EOF_REASON,
            retryAfter: response.headers.get('retry-after'),
            continuation
          },
          retryable: true,
          cause
        }
      );
    throw cause;
  }
}

async function* webSocketResponseEvents(input: {
  readonly configuration: AgentModelConfiguration;
  readonly body: ResponsesRequestBody;
  readonly promptCacheKey: string | undefined;
  readonly reason: ModelCredentialAcquireReason;
  readonly signal: AbortSignal;
  readonly continuation: boolean;
  readonly turn: OpenAiResponsesTurnSession;
  readonly credentialAcquired: (revision: number) => void;
}): AsyncIterable<unknown> {
  const body = input.turn.withTurnStateMetadata(input.body);
  const payload = Buffer.from(JSON.stringify({ type: 'response.create', ...body }), 'utf8');
  const diagnostic = webSocketRequestDiagnostic(body, payload.length);
  input.turn.captureWebSocketDiagnostic(diagnostic);
  const socket = await input.turn.webSocketForRequest({
    configuration: input.configuration,
    promptCacheKey: input.promptCacheKey,
    reason: input.reason,
    signal: input.signal,
    continuation: input.continuation,
    credentialAcquired: input.credentialAcquired
  });
  const messages = webSocketMessages(socket, input.signal, (code) => {
    diagnostic.webSocketCloseCode = code;
  });
  try {
    diagnostic.webSocketPhase = 'SEND';
    await sendWebSocketMessage(socket, payload, input.signal, () => {
      diagnostic.sentFrameCount = (diagnostic.sentFrameCount ?? 0) + 1;
    });
    diagnostic.webSocketPhase = 'RECEIVE';
    let terminal = false;
    for await (const item of messages) {
      const event = record(item);
      const type = text(event.type);
      input.turn.captureTurnState(turnStateFromEvent(event));
      if (type !== 'response.metadata' && type !== 'codex.response.metadata') yield item;
      if (
        type === 'response.completed' ||
        type === 'response.incomplete' ||
        type === 'response.failed' ||
        type === 'error'
      ) {
        terminal = true;
        return;
      }
    }
    // Intentionally treat a close without a terminal model event as retryable EOF,
    // including close code 1009. Close codes remain diagnostic evidence rather than
    // a separate model-error classification. The shared attempt budget still bounds
    // retries; this policy does not shrink the request or guarantee recovery.
    if (!terminal && !input.signal.aborted)
      throw new AgentError(
        'MAR_AGENT_MODEL_PROTOCOL_ERROR',
        'OpenAI Responses WebSocket closed before a terminal event.',
        {
          details: {
            reason: OPENAI_RESPONSES_EARLY_EOF_REASON,
            transport: 'WEBSOCKET',
            continuation: input.continuation
          },
          retryable: true
        }
      );
  } finally {
    messages.dispose();
  }
}

function webSocketRequestDiagnostic(
  body: ResponsesRequestBody,
  requestBytes: number
): ResponsesWebSocketDiagnostic {
  let imageCount = 0;
  let imageBytes = 0;
  for (const item of body.input) {
    const entry = record(item);
    const parts = Array.isArray(entry.content)
      ? entry.content
      : Array.isArray(entry.output)
        ? entry.output
        : [];
    for (const value of parts) {
      const part = record(value);
      if (part.type !== 'input_image') continue;
      imageCount++;
      const url = text(part.image_url);
      if (url === undefined) continue;
      const marker = url.indexOf(';base64,');
      if (url.startsWith('data:') && marker >= 0)
        imageBytes += Buffer.byteLength(url.slice(marker + 8), 'base64');
    }
  }
  return {
    requestBytes,
    imageCount,
    imageBytes,
    requestFrameCount: Math.ceil(requestBytes / WEBSOCKET_SEND_FRAME_BYTES),
    sentFrameCount: 0,
    webSocketPhase: 'CONNECT'
  };
}

async function waitForWebSocketOpen(socket: WebSocket, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    terminateWebSocket(socket);
    throw signal.reason;
  }
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      signal.removeEventListener('abort', abort);
      socket.off('open', open);
      socket.off('error', error);
      socket.off('close', close);
      socket.off('unexpected-response', unexpectedResponse);
    };
    const settle = (operation: () => void) => {
      cleanup();
      operation();
    };
    const abort = () =>
      settle(() => {
        terminateWebSocket(socket);
        reject(signal.reason);
      });
    const open = () => settle(resolve);
    const error = (cause: Error) =>
      settle(() =>
        reject(
          new AgentError(
            'MAR_AGENT_MODEL_CONNECTION_FAILED',
            'OpenAI Responses WebSocket connection failed.',
            {
              details: { reason: 'MODEL_TRANSPORT_FAILURE', transport: 'WEBSOCKET' },
              retryable: true,
              cause
            }
          )
        )
      );
    const close = () =>
      settle(() =>
        reject(
          new AgentError(
            'MAR_AGENT_MODEL_CONNECTION_FAILED',
            'OpenAI Responses WebSocket closed during connection.',
            {
              details: { reason: 'MODEL_TRANSPORT_FAILURE', transport: 'WEBSOCKET' },
              retryable: true
            }
          )
        )
      );
    const unexpectedResponse = (
      _request: import('node:http').ClientRequest,
      response: import('node:http').IncomingMessage
    ) =>
      settle(() => {
        const status = response.statusCode ?? 0;
        response.resume();
        terminateWebSocket(socket);
        const retryable = status !== 401 && isRetryableModelHttpStatus(status);
        const retryAfter = response.headers['retry-after'];
        const retryAfterValue = Array.isArray(retryAfter) ? retryAfter[0] : retryAfter;
        reject(
          new AgentError(
            status === 401 ? 'MAR_AGENT_MODEL_AUTH_FAILED' : 'MAR_AGENT_MODEL_CONNECTION_FAILED',
            status === 401
              ? 'OpenAI Responses WebSocket authentication failed.'
              : 'OpenAI Responses WebSocket handshake failed.',
            {
              details: {
                status,
                transport: 'WEBSOCKET',
                ...(retryAfterValue === undefined ? {} : { retryAfter: retryAfterValue })
              },
              ...(retryable ? { retryable: true } : {})
            }
          )
        );
      });
    signal.addEventListener('abort', abort, { once: true });
    socket.once('open', open);
    socket.once('error', error);
    socket.once('close', close);
    socket.once('unexpected-response', unexpectedResponse);
  });
}

async function sendWebSocketMessage(
  socket: WebSocket,
  payload: Buffer,
  signal: AbortSignal,
  frameSent: () => void
): Promise<void> {
  for (let offset = 0; offset < payload.length; offset += WEBSOCKET_SEND_FRAME_BYTES) {
    if (signal.aborted) throw signal.reason;
    const end = Math.min(payload.length, offset + WEBSOCKET_SEND_FRAME_BYTES);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        settled = true;
        signal.removeEventListener('abort', abort);
        socket.off('error', error);
        socket.off('close', close);
      };
      const abort = () => {
        cleanup();
        socket.terminate();
        reject(signal.reason);
      };
      const error = (cause: Error) => {
        cleanup();
        reject(webSocketReceiveError(cause));
      };
      const close = () => error(new Error('WebSocket closed while sending the request.'));
      signal.addEventListener('abort', abort, { once: true });
      socket.once('error', error);
      socket.once('close', close);
      try {
        socket.send(
          payload.subarray(offset, end),
          { binary: false, fin: end === payload.length },
          (cause) => {
            if (settled) return;
            cleanup();
            if (cause) reject(webSocketReceiveError(cause));
            else if (signal.aborted) reject(signal.reason);
            else {
              frameSent();
              resolve();
            }
          }
        );
      } catch (cause) {
        cleanup();
        reject(webSocketReceiveError(cause as Error));
      }
    });
  }
}

function webSocketMessages(
  socket: WebSocket,
  signal: AbortSignal,
  closed: (code: number) => void
): AsyncIterable<unknown> & { dispose(): void } {
  type QueueItem =
    | { readonly type: 'message'; readonly value: unknown; readonly observedAt: number }
    | { readonly type: 'closed' }
    | { readonly type: 'error'; readonly error: unknown };
  const queue: QueueItem[] = [];
  let resume: (() => void) | undefined;
  const push = (item: QueueItem) => {
    queue.push(item);
    resume?.();
    resume = undefined;
  };
  const message = (value: RawData) =>
    push({
      type: 'message',
      value,
      observedAt: performance.now()
    });
  const close = (code: number) => {
    closed(code);
    push({ type: 'closed' });
  };
  const error = (cause: Error) =>
    push({
      type: 'error',
      error: webSocketReceiveError(cause)
    });
  const abort = () => {
    terminateWebSocket(socket);
    push({ type: 'error', error: signal.reason });
  };
  if (signal.aborted) {
    terminateWebSocket(socket);
    throw signal.reason;
  }
  socket.on('message', message);
  socket.on('close', close);
  socket.on('error', error);
  signal.addEventListener('abort', abort, { once: true });
  const dispose = () => {
    signal.removeEventListener('abort', abort);
    socket.off('message', message);
    socket.off('close', close);
    socket.off('error', error);
  };
  return {
    dispose,
    async *[Symbol.asyncIterator]() {
      try {
        let idleDeadline = Date.now() + WEBSOCKET_IDLE_TIMEOUT_MS;
        while (true) {
          if (Date.now() >= idleDeadline) throw webSocketIdleError(socket);
          if (queue.length === 0)
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(
                () => {
                  resume = undefined;
                  reject(webSocketIdleError(socket));
                },
                Math.max(0, idleDeadline - Date.now())
              );
              resume = () => {
                clearTimeout(timer);
                resolve();
              };
            });
          const item = queue.shift();
          if (item === undefined) continue;
          if (item.type === 'closed') return;
          if (item.type === 'error') throw item.error;
          const text = await webSocketMessageText(item.value);
          if (Buffer.byteLength(text) > 16 * 1024 * 1024)
            throw new AgentError(
              'MAR_AGENT_MODEL_PROTOCOL_ERROR',
              'Model response exceeded the size limit.'
            );
          try {
            const event = JSON.parse(text);
            if (!isWebSocketNonProgressEvent(event))
              idleDeadline = Date.now() + WEBSOCKET_IDLE_TIMEOUT_MS;
            yield observeModelStreamEvent(event, item.observedAt);
          } catch (cause) {
            throw new AgentError(
              'MAR_AGENT_MODEL_PROTOCOL_ERROR',
              'Model WebSocket contained invalid JSON.',
              { cause }
            );
          }
        }
      } finally {
        dispose();
      }
    }
  };
}
function webSocketIdleError(socket: WebSocket): AgentError {
  terminateWebSocket(socket);
  return new AgentError(
    'MAR_AGENT_MODEL_TIMEOUT',
    'OpenAI Responses WebSocket was idle for too long.',
    {
      details: { reason: OPENAI_RESPONSES_EARLY_EOF_REASON, transport: 'WEBSOCKET' },
      retryable: true
    }
  );
}

function isWebSocketNonProgressEvent(value: unknown): boolean {
  const type = text(record(value).type);
  return (
    type === 'response.metadata' ||
    type === 'codex.response.metadata' ||
    type === 'responsesapi.websocket_timing' ||
    type === 'response.queued' ||
    type === 'response.in_progress'
  );
}

async function webSocketMessageText(value: unknown): Promise<string> {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString('utf8');
  if (ArrayBuffer.isView(value))
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8');
  if (Array.isArray(value) && value.every((part) => Buffer.isBuffer(part)))
    return Buffer.concat(value).toString('utf8');
  throw new AgentError(
    'MAR_AGENT_MODEL_PROTOCOL_ERROR',
    'Model WebSocket returned an unsupported frame.'
  );
}

function webSocketHeaders(
  credential: ModelCredential,
  promptCacheKey: string | undefined
): Headers {
  const headers = responsesHeaders(credential, promptCacheKey);
  headers.delete('accept');
  headers.delete('content-type');
  headers.set('openai-beta', 'responses_websockets=2026-02-06');
  return headers;
}

function webSocketEndpoint(baseUrl: string): string {
  const endpoint = new URL(responsesEndpoint(baseUrl));
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
  return endpoint.toString();
}

function socks5WebSocketConnection(
  socks5Url: string,
  endpoint: URL,
  signal: AbortSignal
): NonNullable<WebSocket.ClientOptions['createConnection']> {
  return ((_options: unknown, callback?: (error: Error | null, socket?: unknown) => void) => {
    if (callback === undefined)
      throw new AgentError(
        'MAR_AGENT_MODEL_CONNECTION_FAILED',
        'WebSocket connection callback is unavailable.'
      );
    void connectSocks5Target({
      socks5Url,
      targetHost: endpoint.hostname,
      targetPort: Number(endpoint.port || (endpoint.protocol === 'wss:' ? 443 : 80)),
      tls: endpoint.protocol === 'wss:',
      servername: endpoint.hostname,
      ...(endpoint.protocol === 'wss:' ? { alpnProtocols: ['http/1.1'] } : {}),
      signal
    }).then(
      (socket) => callback(null, socket),
      (error) =>
        callback(
          error instanceof Error
            ? error
            : new Error('SOCKS5 WebSocket connection failed.', { cause: error })
        )
    );
    return undefined;
  }) as unknown as NonNullable<WebSocket.ClientOptions['createConnection']>;
}

function webSocketReceiveError(cause: Error): AgentError {
  const code = (cause as Error & { code?: unknown }).code;
  if (typeof code === 'string' && code.startsWith('WS_ERR_'))
    return new AgentError(
      'MAR_AGENT_MODEL_PROTOCOL_ERROR',
      code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'
        ? 'Model response exceeded the size limit.'
        : 'Model WebSocket protocol is invalid.',
      { cause }
    );
  return new AgentError(
    'MAR_AGENT_MODEL_PROTOCOL_ERROR',
    'OpenAI Responses WebSocket was interrupted.',
    {
      details: {
        reason: OPENAI_RESPONSES_EARLY_EOF_REASON,
        transport: 'WEBSOCKET'
      },
      retryable: true,
      cause
    }
  );
}

function isSemanticEvent(event: ModelEvent): boolean {
  if (event.type.startsWith('output.')) return false;
  if (event.type === 'response.started' || event.type === 'usage' || event.type === 'response.item')
    return false;
  if (event.type === 'text.delta') return event.delta.length > 0;
  if (event.type === 'text.completed' || event.type === 'reasoning.completed')
    return event.text.length > 0;
  return true;
}

function isNonSemanticOpenAiResponsesEvent(type: string): boolean {
  return NON_SEMANTIC_OPENAI_RESPONSES_EVENTS.has(type);
}

const NON_SEMANTIC_OPENAI_RESPONSES_EVENTS = new Set([
  'codex.response.metadata',
  'response.content_part.added',
  'response.content_part.done',
  'response.in_progress',
  'response.metadata',
  'response.queued',
  'response.reasoning_summary_part.added',
  'response.reasoning_summary_part.done',
  'responsesapi.websocket_timing'
]);

function isRetryableResponsesUpstreamError(
  code: string | undefined,
  message: string | undefined
): boolean {
  if (isRetryableUpstreamOverloadCode(code)) return true;
  if (code !== 'invalid_request_error') return false;
  // Exact compatibility exception, not a general access/authentication retry rule.
  const summary = message?.startsWith(`${code}: `) ? message.slice(code.length + 2) : message;
  return summary === 'Unable to verify Daybreak Blue access. Please try again.';
}

export function isOpenAiResponsesRecoverableStreamError(error: unknown): error is AgentError {
  return (
    error instanceof AgentError &&
    error.retryable &&
    (error.details?.reason === OPENAI_RESPONSES_EARLY_EOF_REASON ||
      error.details?.reason === OPENAI_RESPONSES_WEBSOCKET_CONNECTION_LIMIT_REASON ||
      isRetryableResponsesUpstreamError(error.code, error.message))
  );
}

function isWebSocketConnectionLimitCode(code: string | undefined): boolean {
  return code?.trim().toLowerCase() === 'websocket_connection_limit_reached';
}

function isRetryableOpenAiStreamReadError(error: unknown): boolean {
  return (
    isRetryableModelTransportError(error) ||
    (error instanceof AgentError &&
      error.code === 'MAR_AGENT_MODEL_TIMEOUT' &&
      error.details?.reason === 'MODEL_STREAM_IDLE_TIMEOUT')
  );
}

function retryAfter(error: AgentError): string | null {
  const value = error.details?.retryAfter;
  return typeof value === 'string' ? value : null;
}

function openAiResponsesAttemptError(error: unknown) {
  const diagnostic = describeAgentError(error, 'MAR_AGENT_MODEL_ATTEMPT_FAILED');
  const causeCode = deepestCauseCode(error);
  const reason =
    error instanceof AgentError && typeof error.details?.reason === 'string'
      ? error.details.reason
      : undefined;
  return {
    errorCode: diagnostic.code,
    errorMessage: diagnostic.message,
    ...(causeCode === undefined || causeCode === diagnostic.code ? {} : { causeCode }),
    ...(reason === undefined ? {} : { reason }),
    retryable: error instanceof AgentError && error.retryable
  };
}

function deepestCauseCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current = error;
  let code: string | undefined;
  while (current !== undefined && current !== null && !seen.has(current) && seen.size < 8) {
    seen.add(current);
    const candidate =
      current instanceof AgentError
        ? current.code
        : typeof current === 'object' && 'code' in current
          ? (current as { readonly code?: unknown }).code
          : undefined;
    if (typeof candidate === 'string' && candidate.trim())
      code = boundedError(candidate, 80) ?? code;
    current =
      typeof current === 'object' && 'cause' in current
        ? (current as { readonly cause?: unknown }).cause
        : undefined;
  }
  return code;
}

function responsesEndpoint(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/$/, '');
  if (new URL(normalized).pathname.endsWith('/backend-api/codex')) return `${normalized}/responses`;
  return `${normalized.endsWith('/v1') ? normalized : `${normalized}/v1`}/responses`;
}

async function acquireResponsesCredential(
  configuration: AgentModelConfiguration,
  reason: ModelCredentialAcquireReason,
  signal: AbortSignal
): Promise<ModelCredential> {
  return acquireModelCredential(
    configuration,
    reason,
    'OpenAI Responses requires a model credential.',
    signal
  );
}

const RESERVED_CREDENTIAL_HEADERS = new Set([
  'accept',
  'authorization',
  'connection',
  'content-length',
  'content-type',
  'host',
  'openai-beta',
  'proxy-authorization',
  'sec-websocket-accept',
  'sec-websocket-extensions',
  'sec-websocket-key',
  'sec-websocket-protocol',
  'sec-websocket-version',
  'session-id',
  'thread-id',
  'transfer-encoding',
  'upgrade',
  'x-client-request-id',
  X_CODEX_TURN_STATE,
  'x-openai-internal-codex-responses-lite'
]);

function responsesHeaders(
  credential: ModelCredential,
  promptCacheKey: string | undefined,
  turnState?: string
): Headers {
  const headers = new Headers({
    authorization: `Bearer ${credential.bearer.reveal()}`,
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'user-agent': productUserAgent(),
    'x-client-request-id': randomUUID(),
    ...(promptCacheKey
      ? {
          'session-id': promptCacheKey,
          'thread-id': promptCacheKey
        }
      : {})
  });
  if (turnState) headers.set(X_CODEX_TURN_STATE, turnState);
  return appendModelCredentialHeaders(headers, credential, RESERVED_CREDENTIAL_HEADERS);
}

function withCredentialRevision(error: unknown, revision: number | undefined): unknown {
  if (!(error instanceof AgentError) || revision === undefined) return error;
  const prefix = `${error.code}: `;
  return new AgentError(
    error.code,
    error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message,
    {
      details: { ...error.details, credentialRevision: revision },
      retryable: error.retryable,
      cause: error
    }
  );
}

function withResponsesAttemptDetails(
  error: unknown,
  continuation: boolean,
  transport: 'HTTP' | 'WEBSOCKET' | undefined
): unknown {
  if (!(error instanceof AgentError)) return error;
  const prefix = `${error.code}: `;
  return new AgentError(
    error.code,
    error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message,
    {
      details: {
        ...error.details,
        continuation,
        ...(transport === 'WEBSOCKET' ? { transport: 'WEBSOCKET' } : {})
      },
      retryable: error.retryable,
      cause: error
    }
  );
}

function isModelAuthenticationFailure(error: unknown): error is AgentError {
  if (!(error instanceof AgentError)) return false;
  if (typeof error.details?.status === 'number') return error.details.status === 401;
  const code = error.code.toLowerCase();
  return code === 'unauthorized';
}

function credentialRevision(error: AgentError): number | undefined {
  const revision = error.details?.credentialRevision;
  return typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0
    ? revision
    : undefined;
}

function boundedError(value: string | undefined, maximum: number): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return [...normalized].slice(0, maximum).join('');
}

function upstreamHttpStatus(...values: readonly unknown[]): number | undefined {
  for (const value of values) {
    const candidate =
      typeof value === 'string' && /^\d{3}$/u.test(value) ? Number(value) : number(value);
    if (
      candidate !== undefined &&
      Number.isInteger(candidate) &&
      candidate >= 100 &&
      candidate <= 599
    )
      return candidate;
  }
  return undefined;
}

function optionalRolloutBudgetUnits(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const units = number(value);
  if (units !== undefined && units >= 0) return units;
  throw new AgentError(
    'MAR_AGENT_MODEL_PROTOCOL_ERROR',
    'Provider rollout budget units are invalid.'
  );
}

function isInvalidPreviousResponseError(error: unknown): error is AgentError {
  if (!(error instanceof AgentError)) return false;
  const status = error.details?.status;
  if (typeof status === 'number' && ![400, 404, 410].includes(status)) return false;
  return isInvalidPreviousResponseFields(error.code, error.message);
}

function isInvalidPreviousResponseFields(
  code: string | undefined,
  message: string | undefined
): boolean {
  const normalizedCode = code?.trim().toLowerCase();
  // OpenAI Responses and compatible providers use these missing-reference codes.
  if (
    normalizedCode === 'previous_response_not_found' ||
    normalizedCode === 'invalid_previous_response_id'
  )
    return true;
  const normalizedMessage = message?.toLowerCase().replaceAll('`', '') ?? '';
  // xAI/Grok WSS uses api_error with a gRPC prefix; HTTP may return a plain
  // error string, normalized by the SSE boundary to MAR_AGENT_MODEL_PROTOCOL_ERROR.
  // Do not treat account/model lookup failures as a missing response reference.
  if (
    (normalizedCode === 'api_error' ||
      normalizedCode === 'mar_agent_model_protocol_error' ||
      normalizedCode === undefined) &&
    /^(?:(?:mar_agent_model_protocol_error|api_error): )?(?:grpc error: )?response with id=\S+ not found[.!]?$/u.test(
      normalizedMessage
    )
  )
    return true;
  // Compatibility gateways use these unsupported-parameter discriminators.
  if (
    (normalizedCode === 'unsupported_parameter' ||
      normalizedCode === 'unsupported_previous_response_id') &&
    normalizedMessage.includes('previous_response_id')
  )
    return true;
  // OpenAI-style request errors and generic compatibility envelopes may only
  // name the rejected parameter. Explicit auth, permission, overload or other
  // error codes take precedence even when their message mentions continuation.
  if (
    normalizedCode !== undefined &&
    normalizedCode !== 'invalid_request_error' &&
    normalizedCode !== 'api_error' &&
    normalizedCode !== 'mar_agent_model_protocol_error'
  )
    return false;
  return (
    normalizedMessage.includes('previous_response_id') &&
    (normalizedMessage.includes('invalid') ||
      normalizedMessage.includes('not found') ||
      normalizedMessage.includes('does not exist') ||
      normalizedMessage.includes('expired') ||
      normalizedMessage.includes('not supported') ||
      normalizedMessage.includes('unsupported') ||
      normalizedMessage.includes('unavailable'))
  );
}
