import type { ClientToolDefinition } from '../../tools/contracts.js';
import type { SessionModelMessage as ModelMessage } from '../../session/model-request.js';
import type { SessionModelRequest as ModelRequest } from '../../session/model-request.js';
import { AgentError } from '../../error.js';
import type { ExtensionCompactResult } from './contracts.js';
import type {
  ModelEvent,
  ModelRetryState,
  ModelTurnSession,
  ModelUsage
} from '../../model/contracts.js';
import { isProviderContextOverflow, recoverModelStream } from '../../model/recovery.js';
import { normalizeMessagesForModel } from '../context/normalize.js';
import { estimatedRequestTokens } from '../context/request-budget.js';
import { shouldUseNativeCompaction, type AuthoritativeModelUsage } from '../context/usage.js';
import {
  buildCompactionInput,
  buildCompactionMessages,
  buildNativeCompactionMessages
} from './history.js';
import type { CompactionOperation } from './operation.js';
import { projectSmartCompactionMessage } from './smart.js';

interface CompactionSnapshot {
  readonly history: readonly ModelMessage[];
  readonly system: string;
  readonly systemBlocks?: ModelRequest['systemBlocks'];
  readonly tools: readonly ClientToolDefinition[];
  readonly contextWindowTokens: number;
  readonly latestUsage: AuthoritativeModelUsage | undefined;
  readonly reasoningEffort: NonNullable<ModelRequest['reasoningEffort']>;
  readonly focus?: string;
  readonly reason: 'manual' | 'automatic';
  readonly promptCacheKey: string;
}

interface CompactionGeneration {
  // Borrowed resources: the SDK owns their creation and unique finalization.
  readonly operation: CompactionOperation;
  readonly turn: ModelTurnSession;
  readonly generateExtension: (
    history: readonly ModelMessage[],
    reason: 'manual' | 'automatic',
    focus: string | undefined,
    operation: CompactionOperation
  ) => Promise<ExtensionCompactResult | undefined>;
  readonly transformRequest: (request: ModelRequest) => Promise<ModelRequest>;
  readonly stream: (
    start: (signal: AbortSignal) => AsyncIterable<ModelEvent>,
    signal: AbortSignal
  ) => AsyncIterable<ModelEvent>;
  readonly observeUsage: (usage: ModelUsage) => Promise<void>;
  readonly onAttemptDiagnostic: NonNullable<ModelRequest['onAttemptDiagnostic']>;
}

/** Generate a candidate from an isolated snapshot; never commit or adopt active context. */
export async function generateCompactionCandidate(
  snapshot: CompactionSnapshot,
  dependencies: CompactionGeneration
): Promise<ExtensionCompactResult> {
  const { operation, turn } = dependencies;
  const projectedHistory = normalizeMessagesForModel(snapshot.history, {
    supportsImages: false
  }).map(projectSmartCompactionMessage);
  const nativeMessages = buildNativeCompactionMessages(projectedHistory, {
    ...(snapshot.focus === undefined ? {} : { focus: snapshot.focus })
  });
  const overhead = estimatedRequestTokens(
    snapshot.system,
    buildCompactionMessages(''),
    snapshot.tools
  );
  const inputTokens = Math.max(0, snapshot.contextWindowTokens - overhead);
  let usingNativeMessages = shouldUseNativeCompaction({
    estimatedRequestTokens: estimatedRequestTokens(snapshot.system, nativeMessages, snapshot.tools),
    contextWindowTokens: snapshot.contextWindowTokens,
    latestUsage: snapshot.latestUsage,
    historyMessages: snapshot.history,
    appendedMessages: nativeMessages.slice(projectedHistory.length)
  });
  const fallbackMessages = () =>
    buildCompactionMessages(
      buildCompactionInput(snapshot.history, {
        ...(snapshot.focus === undefined ? {} : { focus: snapshot.focus }),
        maxTokens: Math.max(1, inputTokens)
      })
    );
  let messages = usingNativeMessages ? nativeMessages : fallbackMessages();
  const retryState: ModelRetryState = { attempts: 0 };
  const extension = await dependencies.generateExtension(
    snapshot.history,
    snapshot.reason,
    snapshot.focus,
    operation
  );
  operation.signal.throwIfAborted();
  if (extension) {
    if (extension.usage) await dependencies.observeUsage(extension.usage);
    return extension;
  }
  while (true) {
    if (inputTokens === 0)
      throw new AgentError(
        'MAR_AGENT_CONTEXT_LIMIT',
        'Compaction prompt exceeds the selected model context window.'
      );
    let summary = '';
    let usage: ModelUsage | undefined;
    try {
      const request = await dependencies.transformRequest({
        retryState,
        system: snapshot.system,
        ...(snapshot.systemBlocks === undefined ? {} : { systemBlocks: snapshot.systemBlocks }),
        messages,
        tools: snapshot.tools,
        toolChoice: 'none',
        promptCacheKey: snapshot.promptCacheKey,
        reasoningEffort: snapshot.reasoningEffort,
        onAttemptDiagnostic: dependencies.onAttemptDiagnostic
      });
      for await (const event of dependencies.stream(
        (signal) => operation.start({ start: (request) => turn.start(request, signal) }, request),
        operation.signal
      )) {
        if (event.type === 'text.completed' && (event.phase ?? 'final_answer') === 'final_answer')
          summary = event.text.trim();
        else if (event.type === 'usage') {
          usage = event.usage;
          await dependencies.observeUsage(event.usage);
        } else if (event.type === 'client_tool.call')
          throw new AgentError(
            'MAR_AGENT_MODEL_PROTOCOL_ERROR',
            'Compaction returned a tool call while tools were disabled.'
          );
      }
    } catch (error) {
      if (await recoverModelStream(error, retryState, operation.signal)) continue;
      if (isProviderContextOverflow(error) && usingNativeMessages) {
        usingNativeMessages = false;
        messages = fallbackMessages();
        retryState.attempts = 0;
        continue;
      }
      if (isProviderContextOverflow(error))
        throw new AgentError(
          'MAR_AGENT_CONTEXT_LIMIT',
          'The compaction request exceeds the model context window.',
          { cause: error }
        );
      throw error;
    }
    if (!summary) throw new AgentError('MAR_AGENT_COMPACT_FAILED', 'Automatic compact failed.');
    return { summary, ...(usage === undefined ? {} : { usage }) };
  }
}
