import { isDeepStrictEqual } from 'node:util';
import { restoreMessages } from '../runtime/context/restore.js';
import {
  contextualInstructionInsertIndex,
  latestContextualWorldStateGeneration,
  persistContextualWorldState,
  resetContextualWorldState,
  updateContextualWorldState,
  type ContextualWorldState
} from '../runtime/context/world-state.js';
import { environmentContextUpdate } from '../runtime/context/environment.js';
import type { EnvironmentContextState } from '../prompts/core.js';
import {
  compactedHistoryMessages,
  type buildCompactedHistory
} from '../runtime/compaction/history.js';
import { compactSummaryFromCheckpoint } from '../session/record-projection.js';
import type { CompactUserInput, SessionRecord } from '../session/record-contract.js';
import type { SessionStore } from '../session/store/contracts.js';
import type { SessionModelMessage as ModelMessage } from '../session/model-request.js';
import type { ContextGcCommitResult } from '../runtime/context/gc-runtime.js';
import type { ResourceInputProjection } from './resource-input.js';

interface ExecutionModelContextPorts {
  readonly restored: Awaited<ReturnType<typeof restoreMessages>>;
  readonly initialContextualWorldState: ContextualWorldState;
  readonly store: Parameters<typeof restoreMessages>[0] &
    Pick<SessionStore, 'append' | 'writeContextualWorldState'>;
  readonly sessionId: string;
  readonly executionId: string;
  readonly turnId: string;
  readonly mode: 'run' | 'plan' | 'compact';
  readonly contextRecords: readonly SessionRecord[];
  readonly contextualWorldStateGeneration: string | undefined;
  readonly compactMayContainAgentInstructions: boolean;
  readonly messageSources: WeakMap<ModelMessage, SessionRecord>;
  updateWorldState(state: ContextualWorldState): void;
  environment(): EnvironmentContextState;
  instructionSnapshot(): string | undefined;
  renderInstructions(previous: boolean): string | undefined;
  retainedResourceSnapshot(): Promise<string | undefined>;
  mcpNavigation(): string | undefined;
  reportSidecarFailure(): void;
  resetGc(): void;
  restoreMcp(): void;
  resetContinuation(): void;
  resetSmartContext(): void;
  replaceResources(messages: ModelMessage[]): void;
  adoptGcResources(state: Parameters<ResourceInputProjection['adoptGc']>[0]): void;
  clearAppendedMessages(): void;
  appendedAfter(boundary: number, restoredIds: ReadonlySet<string>): ModelMessage[];
}

/** Execution-owned live history and projections derived from committed Session records. */
export function createExecutionModelContext(ports: ExecutionModelContextPorts) {
  const {
    restored,
    initialContextualWorldState,
    store,
    sessionId,
    executionId,
    turnId,
    mode,
    contextRecords,
    contextualWorldStateGeneration,
    compactMayContainAgentInstructions,
    messageSources
  } = ports;

  const messages = restored.messages;
  let userMessages = [...restored.userMessages];
  let recordedEnvironment = restored.environmentState;
  let instructionInsertIndex = 0;
  let worldState = initialContextualWorldState;
  const commitWorldState = async (next: ContextualWorldState) => {
    await persistContextualWorldState(store, sessionId, next);
    worldState = next;
    ports.updateWorldState(next);
  };
  const resetCompactWorldState = async (
    generation: string,
    committed?: { readonly resources: string | undefined }
  ) => {
    instructionInsertIndex = contextualInstructionInsertIndex(messages);
    const next = resetContextualWorldState(generation, instructionInsertIndex, {
      instructionSnapshot: ports.instructionSnapshot(),
      instructionContent: ports.renderInstructions(true),
      resourceSnapshot: committed ? committed.resources : await ports.retainedResourceSnapshot()
    });
    if (!committed) await commitWorldState(next);
    else {
      // The checkpoint is authoritative; its sidecar is recoverable on restart.
      worldState = next;
      ports.updateWorldState(next);
      try {
        await persistContextualWorldState(store, sessionId, next);
      } catch {
        ports.reportSidecarFailure();
      }
    }
  };
  const recordEnvironment = async () => {
    const message = environmentContextUpdate(ports.environment(), recordedEnvironment);
    if (!message) return;
    await store.append(sessionId, {
      type: 'context.environment',
      payload: { version: 1, state: ports.environment() },
      executionId,
      turnId
    });
    messages.push(message);
    recordedEnvironment = ports.environment();
  };
  const syncMcpWorldState = async (index = instructionInsertIndex) => {
    const snapshot = ports.mcpNavigation();
    if (worldState.mcpSnapshot === snapshot) return;
    const next: ContextualWorldState = {
      ...worldState,
      mcpSnapshot: snapshot,
      entries: [
        ...worldState.entries,
        {
          index,
          kind: 'mcp',
          content: snapshot ?? '<mcp_catalog>No deferred MCP tools remain.</mcp_catalog>'
        }
      ]
    };
    await commitWorldState(next);
  };
  return {
    messages,
    get worldState(): ContextualWorldState {
      return worldState;
    },
    commitWorldState,
    recordEnvironment,
    syncMcpWorldState,
    rememberInput(input: CompactUserInput) {
      userMessages.push(input);
    },
    compactInputs(prefix: readonly ModelMessage[]) {
      return userMessages.filter((entry) =>
        prefix.some(
          (message) =>
            message.role === 'user' &&
            message.contextKind === undefined &&
            (entry.metadata?.recordId
              ? message.metadata?.recordId === entry.metadata.recordId
              : message.content === entry.content)
        )
      );
    },
    async initializeWorldState() {
      instructionInsertIndex =
        mode === 'compact' ? contextualInstructionInsertIndex(messages) : messages.length;
      // Only the latest Compact may rebuild missing sidecar resources, never a GC boundary.
      if (
        !worldState.initialized &&
        contextRecords.some(
          (record) =>
            record.recordId === contextualWorldStateGeneration &&
            compactSummaryFromCheckpoint(record) !== undefined
        )
      )
        await resetCompactWorldState(contextualWorldStateGeneration!);
      const nextInstructionWorldState = updateContextualWorldState(
        worldState,
        instructionInsertIndex,
        {
          instructionSnapshot: ports.instructionSnapshot(),
          instructionContent: ports.renderInstructions(
            compactMayContainAgentInstructions || worldState.instructionSnapshot !== undefined
          )
        }
      );
      if (!isDeepStrictEqual(worldState, nextInstructionWorldState))
        await commitWorldState(nextInstructionWorldState);
    },
    // Must run inside the existing writer/projection commit window.
    replaceCompactMessages(
      replacementHistory: ReturnType<typeof buildCompactedHistory>,
      retainedModelContext: readonly ModelMessage[]
    ) {
      messages.splice(
        0,
        messages.length,
        environmentContextUpdate(ports.environment())!,
        ...compactedHistoryMessages(replacementHistory),
        ...retainedModelContext
      );
      ports.clearAppendedMessages();
      ports.replaceResources(messages);
      ports.resetContinuation();
    },
    // Derived state follows the committed splice, never delays it past the writer window.
    async adoptCompactCheckpoint(
      recordId: string,
      replacementHistory: ReturnType<typeof buildCompactedHistory>,
      retainedModelContext: readonly ModelMessage[],
      resources: string | undefined
    ) {
      ports.resetGc();
      ports.restoreMcp();
      recordedEnvironment = ports.environment();
      userMessages = replacementHistory
        .filter((message) => message.kind !== 'summary')
        .map((message) => ({
          content: message.content,
          ...(message.metadata ? { metadata: { ...message.metadata } } : {})
        }));
      userMessages.push(
        ...retainedModelContext
          .filter((message) => message.role === 'user' && message.contextKind === undefined)
          .map((message) => ({
            content: message.content,
            ...(message.metadata ? { metadata: message.metadata } : {})
          }))
      );
      await resetCompactWorldState(recordId, { resources });
    },
    async adoptGcCheckpoint(committed: ContextGcCommitResult, appendBoundary: number) {
      ports.resetSmartContext();
      ports.resetContinuation();
      const refreshed = await restoreMessages(store, sessionId, committed.records, {
        includeImages: true,
        currentTurnId: turnId,
        messageSources,
        projection: committed.projection
      });
      const restoredIds = new Set(committed.records.map((record) => record.recordId));
      const lateMessages = ports.appendedAfter(appendBoundary, restoredIds);
      messages.splice(0, messages.length, ...refreshed.messages, ...lateMessages);
      ports.replaceResources(messages);
      ports.adoptGcResources(committed.projection.checkpoint?.inlineMedia?.state);
      ports.restoreMcp();
      recordedEnvironment = refreshed.environmentState;
      userMessages = [...refreshed.userMessages];
      instructionInsertIndex = contextualInstructionInsertIndex(messages);
      const next = resetContextualWorldState(
        latestContextualWorldStateGeneration(committed.records),
        instructionInsertIndex,
        {
          instructionSnapshot: ports.instructionSnapshot(),
          instructionContent: ports.renderInstructions(
            committed.records.some((record) => compactSummaryFromCheckpoint(record) !== undefined)
          )
        }
      );
      await commitWorldState(next);
    }
  };
}
