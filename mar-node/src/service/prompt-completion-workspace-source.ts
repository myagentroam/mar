import type { PromptCompletionContextInput } from '@myagentroam/protocol';
import type { NodeAgentSession } from '../session/contracts.js';
import type { ConversationHistoryPage } from '../session/runner-native-session-parsers.js';
import type { CompletionActor } from './prompt-completion-node-service.js';
import {
  PROMPT_COMPLETION_REFERENCE_POOL_SESSIONS,
  type CompletionReference
} from './prompt-completion-cache.js';
import { projectCompletionContext } from './prompt-completion-context.js';

interface WorkspaceSourceOptions {
  readonly requireWorkspace: (workspaceId: string) => unknown;
  readonly observesWorkspace: (
    workspaceId: string,
    actor: CompletionActor,
    connectionId: string
  ) => boolean;
  readonly observesSession: (
    workspaceId: string,
    sessionId: string,
    actor: CompletionActor,
    connectionId: string
  ) => boolean;
  readonly resolveSession: (sessionId: string) => Promise<NodeAgentSession | undefined>;
  readonly cachedSessions: (workspaceId: string) => readonly NodeAgentSession[];
  readonly readHistory: (
    session: NodeAgentSession,
    limit: number
  ) => Promise<ConversationHistoryPage>;
}

/** Uses the existing Workspace catalog and normalized history readers; never scans a second index. */
export class PromptCompletionWorkspaceSource {
  constructor(private readonly options: WorkspaceSourceOptions) {}

  observed(input: PromptCompletionContextInput, actor: CompletionActor): boolean {
    if (input.target.kind !== 'WORKSPACE') return false;
    return input.sessionId === null
      ? this.options.observesWorkspace(input.target.workspaceId, actor, input.workbenchConnectionId)
      : this.options.observesSession(
          input.target.workspaceId,
          input.sessionId,
          actor,
          input.workbenchConnectionId
        );
  }

  async readPage(input: PromptCompletionContextInput, actor: CompletionActor, signal: AbortSignal) {
    if (input.target.kind !== 'WORKSPACE' || !this.observed(input, actor))
      throw new Error('PROMPT_COMPLETION_CONTEXT_UNAVAILABLE');
    this.options.requireWorkspace(input.target.workspaceId);
    signal.throwIfAborted();
    if (input.sessionId === null) return [];
    const session = await this.options.resolveSession(input.sessionId);
    if (
      !session ||
      session.workspaceId !== input.target.workspaceId ||
      session.runner !== input.runner
    )
      throw new Error('PROMPT_COMPLETION_CONTEXT_UNAVAILABLE');
    signal.throwIfAborted();
    if (!this.observed(input, actor)) throw new Error('PROMPT_COMPLETION_CONTEXT_UNAVAILABLE');
    const page = await this.options.readHistory(session, 20);
    signal.throwIfAborted();
    if (!this.observed(input, actor)) throw new Error('PROMPT_COMPLETION_CONTEXT_UNAVAILABLE');
    return page.turns;
  }

  async references(
    workspaceId: string,
    signal: AbortSignal
  ): Promise<readonly CompletionReference[]> {
    this.options.requireWorkspace(workspaceId);
    signal.throwIfAborted();
    const sessions = this.options
      .cachedSessions(workspaceId)
      .filter(
        (session) => session.workspaceId === workspaceId && session.externalDiscovered !== false
      )
      .sort(
        (left, right) =>
          right.lastActivityAt - left.lastActivityAt || left.id.localeCompare(right.id)
      )
      .slice(0, PROMPT_COMPLETION_REFERENCE_POOL_SESSIONS);
    const messages: CompletionReference[] = [];
    for (const session of sessions) {
      signal.throwIfAborted();
      try {
        const page = await this.options.readHistory(session, 20);
        signal.throwIfAborted();
        const projection = projectCompletionContext(page.turns, 'reference');
        messages.push(
          ...projection.references
            .slice(-20)
            .map((message) => ({ ...message, sessionId: session.id }))
        );
      } catch {
        signal.throwIfAborted();
        // Reference history is optional; an unavailable source does not block the current draft.
      }
    }
    return messages;
  }
}
