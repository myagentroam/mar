import { ref } from 'vue';
import type { ConversationItem, ConversationTurn, Session } from '../model/workbench.js';
import { conversationItemText } from '../util/conversation-presentation.js';
import type { WorkbenchHttpService } from './workbench-http-service.js';
import type { createWorkbenchSessionSelectionService } from './workbench-session-selection-service.js';

export type SessionHistoryMutationResult =
  | { readonly status: 'SKIPPED' }
  | { readonly status: 'APPLIED' | 'STALE'; readonly session: Session }
  | {
      readonly status: 'FAILED';
      readonly phase: 'REQUEST' | 'APPLY';
      readonly error: unknown;
      readonly session?: Session;
    };

export function createWorkbenchSessionHistoryMutationService(options: {
  readonly current: () => { readonly nodeId: string; readonly session: Session } | undefined;
  readonly canRewind: () => boolean;
  readonly canRollback: () => boolean;
  readonly confirmRewind: (before: boolean) => Promise<boolean>;
  readonly confirmRollback: () => Promise<boolean>;
  readonly request: WorkbenchHttpService['request'];
  readonly sessionPathId: (sessionId: string) => string;
  readonly beginSubmission: (context: string) => (() => void) | undefined;
  readonly draft: {
    read(): string;
    restore(text: string): void;
    fill(text: string, operation: 'rewind' | 'rollback'): void;
  };
  readonly replaceSession: (previousId: string, session: Session) => void;
  readonly openSession: ReturnType<typeof createWorkbenchSessionSelectionService>['openSession'];
  readonly invalidateDetail: (nodeId: string, session: Session) => void;
  readonly clearHistory: (sessionId: string) => void;
}) {
  const pending = ref(false);

  function isCurrent(nodeId: string, sessionId: string): boolean {
    const selected = options.current();
    return selected?.nodeId === nodeId && selected.session.id === sessionId;
  }

  async function rewind(
    turn: ConversationTurn,
    item: ConversationItem
  ): Promise<SessionHistoryMutationResult> {
    const source = options.current();
    if (source === undefined || pending.value || !options.canRewind() || turn.rewind === undefined)
      return { status: 'SKIPPED' };
    const before = item.kind === 'user_message';
    const body = {
      nodeId: source.nodeId,
      turnId: turn.turnId ?? turn.id,
      position: before ? 'BEFORE' : 'AFTER',
      boundary: before ? turn.rewind.before : turn.rewind.after
    };
    if (
      !(await options.confirmRewind(before)) ||
      !options.canRewind() ||
      !isCurrent(source.nodeId, source.session.id)
    )
      return { status: 'SKIPPED' };
    const release = options.beginSubmission('session:' + source.session.id);
    if (release === undefined) return { status: 'SKIPPED' };
    const previousDraft = options.draft.read();
    const restoredText = before ? conversationItemText(item.kind, item.payload) : '';
    let session: Session | undefined;
    pending.value = true;
    try {
      const response = await options.request<{ session: Session }>(
        '/api/agent-sessions/' + options.sessionPathId(source.session.id) + '/rewind',
        { method: 'POST', body: JSON.stringify(body) }
      );
      session = response.session;
      if (!isCurrent(source.nodeId, source.session.id)) return { status: 'STALE', session };
      options.replaceSession(session.id, session);
      await options.openSession(session.id);
      if (!isCurrent(source.nodeId, session.id)) return { status: 'STALE', session };
      options.draft.fill(restoredText, 'rewind');
      return { status: 'APPLIED', session };
    } catch (error) {
      if (session !== undefined && isCurrent(source.nodeId, session.id)) {
        try {
          await options.openSession(source.session.id, { skipSaveCurrent: true });
        } catch {
          // The branch remains committed; recovery must never repeat the POST.
        }
        if (isCurrent(source.nodeId, source.session.id)) options.draft.restore(previousDraft);
      }
      return {
        status: 'FAILED',
        phase: session === undefined ? 'REQUEST' : 'APPLY',
        error,
        ...(session === undefined ? {} : { session })
      };
    } finally {
      pending.value = false;
      release();
    }
  }

  async function rollback(
    turn: ConversationTurn,
    item: ConversationItem
  ): Promise<SessionHistoryMutationResult> {
    const source = options.current();
    if (
      source === undefined ||
      pending.value ||
      !options.canRollback() ||
      turn.rewind === undefined ||
      item.kind !== 'user_message' ||
      item.status !== 'COMPLETED' ||
      !['SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED', 'LOST'].includes(turn.status)
    )
      return { status: 'SKIPPED' };
    const body = {
      nodeId: source.nodeId,
      turnId: turn.turnId ?? turn.id,
      boundary: turn.rewind.before
    };
    if (
      !(await options.confirmRollback()) ||
      !options.canRollback() ||
      !isCurrent(source.nodeId, source.session.id)
    )
      return { status: 'SKIPPED' };
    const release = options.beginSubmission('session:' + source.session.id);
    if (release === undefined) return { status: 'SKIPPED' };
    const restoredText = conversationItemText(item.kind, item.payload);
    let session: Session | undefined;
    pending.value = true;
    try {
      const response = await options.request<{ session: Session }>(
        '/api/agent-sessions/' + options.sessionPathId(source.session.id) + '/rollback',
        { method: 'POST', body: JSON.stringify(body) }
      );
      session = response.session;
      // A committed rollback invalidates its source even when selection moved during the POST.
      options.invalidateDetail(source.nodeId, source.session);
      if (!isCurrent(source.nodeId, source.session.id)) return { status: 'STALE', session };
      options.replaceSession(source.session.id, session);
      options.clearHistory(source.session.id);
      await options.openSession(source.session.id, {
        preserveMobileWorkspaceSurface: true,
        deferInitialScroll: true,
        skipSaveCurrent: true
      });
      if (!isCurrent(source.nodeId, source.session.id)) return { status: 'STALE', session };
      options.draft.fill(restoredText, 'rollback');
      return { status: 'APPLIED', session };
    } catch (error) {
      return {
        status: 'FAILED',
        phase: session === undefined ? 'REQUEST' : 'APPLY',
        error,
        ...(session === undefined ? {} : { session })
      };
    } finally {
      pending.value = false;
      release();
    }
  }

  return { pending, rewind, rollback };
}
