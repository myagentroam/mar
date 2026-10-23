import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkbenchSessionHistoryMutationService } from '../../src/service/WorkbenchSessionHistoryMutationService.js';
import { createWorkbenchSubmissionService } from '../../src/service/WorkbenchSubmissionService.js';
import type { ConversationItem, ConversationTurn, Session } from '../../src/model/workbench.js';

const source: Session = { id: 'source', workspaceId: 'workspace', runner: 'codex' };
const branch: Session = { ...source, id: 'branch' };
const turn = {
  id: 'display-turn',
  turnId: 'native-turn',
  status: 'SUCCEEDED',
  rewind: { before: 'previous', after: 'current' }
} as ConversationTurn;
const user = {
  kind: 'user_message',
  status: 'COMPLETED',
  payload: { text: 'Original user text' }
} as ConversationItem;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture() {
  let selected = { nodeId: 'node', session: source };
  let draft = 'Unsent source draft';
  let enabled = true;
  const submission = createWorkbenchSubmissionService();
  const confirm = vi.fn(async () => true);
  const request = vi.fn(async (_path: string, _init?: RequestInit) => ({ session: branch }));
  const open = vi.fn(async (id: string) => {
    selected = { ...selected, session: id === branch.id ? branch : source };
  });
  const replace = vi.fn();
  const invalidate = vi.fn();
  const clear = vi.fn();
  const fill = vi.fn((text: string) => {
    draft = text;
  });
  const service = createWorkbenchSessionHistoryMutationService({
    current: () => selected,
    canRewind: () => enabled,
    canRollback: () => enabled,
    confirmRewind: confirm,
    confirmRollback: confirm,
    request: request as never,
    sessionPathId: encodeURIComponent,
    beginSubmission: (context) => submission.begin(context, undefined, null),
    draft: {
      read: () => draft,
      restore: (text) => {
        draft = text;
      },
      fill
    },
    replaceSession: replace,
    openSession: open,
    invalidateDetail: invalidate,
    clearHistory: clear
  });
  return {
    service,
    submission,
    confirm,
    request,
    open,
    replace,
    invalidate,
    clear,
    fill,
    select: (session: Session, nodeId = 'node') => {
      selected = { nodeId, session };
    },
    disable: () => {
      enabled = false;
    },
    selected: () => selected,
    draft: () => draft
  };
}

afterEach(() => vi.useRealTimers());

describe('Session history mutations', () => {
  it.each(['rewind', 'rollback'] as const)(
    '%s revalidates after confirmation and cancels without POST',
    async (operation) => {
      for (const change of ['cancel', 'session', 'node', 'capability'] as const) {
        const f = fixture();
        const confirm = deferred<boolean>();
        f.confirm.mockReturnValueOnce(confirm.promise);
        const result = f.service[operation](turn, user);
        if (change === 'session') f.select({ ...source, id: 'other' });
        if (change === 'node') f.select(source, 'other-node');
        if (change === 'capability') f.disable();
        confirm.resolve(change !== 'cancel');
        await expect(result).resolves.toEqual({ status: 'SKIPPED' });
        expect(f.request).not.toHaveBeenCalled();
        expect(f.submission.pending.value).toBe(false);
      }
    }
  );

  it.each(['BEFORE', 'AFTER'] as const)(
    'creates exactly one %s branch and fills the correct draft',
    async (position) => {
      const f = fixture();
      const item = position === 'BEFORE' ? user : { ...user, kind: 'assistant_message' as const };
      await expect(f.service.rewind(turn, item)).resolves.toEqual({
        status: 'APPLIED',
        session: branch
      });
      expect(f.request).toHaveBeenCalledOnce();
      expect(JSON.parse(f.request.mock.calls[0]![1]!.body as string)).toEqual({
        nodeId: 'node',
        turnId: 'native-turn',
        position,
        boundary: position === 'BEFORE' ? 'previous' : 'current'
      });
      expect(f.selected().session.id).toBe('branch');
      expect(f.draft()).toBe(position === 'BEFORE' ? 'Original user text' : '');
      expect(f.submission.pending.value).toBe(false);
    }
  );

  it.each(['rewind', 'rollback'] as const)(
    '%s holds the shared submission through POST and navigation',
    async (operation) => {
      vi.useFakeTimers();
      const f = fixture();
      const post = deferred<{ session: Session }>();
      const open = deferred<void>();
      f.request.mockReturnValueOnce(post.promise);
      f.open.mockImplementationOnce(async (id) => {
        f.select(id === branch.id ? branch : source);
        await open.promise;
      });
      const result = f.service[operation](turn, user);
      await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
      await f.service[operation](turn, user);
      expect(f.request).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(6_000);
      expect(f.submission.begin('session:other')).toBeUndefined();
      const session = operation === 'rewind' ? branch : source;
      post.resolve({ session });
      await vi.waitFor(() => expect(f.open).toHaveBeenCalledOnce());
      expect(f.submission.pending.value).toBe(true);
      expect(f.service.pending.value).toBe(true);
      open.resolve();
      await expect(result).resolves.toEqual({ status: 'APPLIED', session });
      expect(f.submission.pending.value).toBe(false);
      expect(f.service.pending.value).toBe(false);
    }
  );

  it.each(['rewind', 'rollback'] as const)(
    '%s preserves a new selection when POST finishes late',
    async (operation) => {
      const f = fixture();
      const post = deferred<{ session: Session }>();
      f.request.mockReturnValueOnce(post.promise);
      const result = f.service[operation](turn, user);
      await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
      f.select({ ...source, id: 'other' });
      post.resolve({ session: operation === 'rewind' ? branch : source });
      await expect(result).resolves.toMatchObject({ status: 'STALE' });
      expect(f.open).not.toHaveBeenCalled();
      expect(f.fill).not.toHaveBeenCalled();
      expect(f.selected().session.id).toBe('other');
      expect(f.invalidate).toHaveBeenCalledTimes(operation === 'rollback' ? 1 : 0);
      if (operation === 'rollback') expect(f.invalidate).toHaveBeenCalledWith('node', source);
    }
  );

  it.each(['rewind', 'rollback'] as const)(
    '%s cannot fill a different conversation during navigation',
    async (operation) => {
      const f = fixture();
      const open = deferred<void>();
      f.request.mockResolvedValueOnce({ session: operation === 'rewind' ? branch : source });
      f.open.mockImplementationOnce(async () => {
        await open.promise;
      });
      const result = f.service[operation](turn, user);
      await vi.waitFor(() => expect(f.open).toHaveBeenCalledOnce());
      f.select({ ...source, id: 'other' });
      open.resolve();
      await expect(result).resolves.toMatchObject({ status: 'STALE' });
      expect(f.fill).not.toHaveBeenCalled();
      expect(f.draft()).toBe('Unsent source draft');
    }
  );

  it('restores the source draft after a created branch fails to open without creating it again', async () => {
    const f = fixture();
    f.open.mockImplementationOnce(async () => {
      f.select(branch);
      throw new Error('OPEN_FAILED');
    });
    await expect(f.service.rewind(turn, user)).resolves.toMatchObject({
      status: 'FAILED',
      phase: 'APPLY',
      session: branch,
      error: expect.any(Error)
    });
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.open.mock.calls.map(([id]) => id)).toEqual(['branch', 'source']);
    expect(f.draft()).toBe('Unsent source draft');
    expect(f.submission.pending.value).toBe(false);
  });

  it.each(['rewind', 'rollback'] as const)(
    '%s request failure preserves history and draft',
    async (operation) => {
      const f = fixture();
      f.request.mockRejectedValueOnce(new Error('POST_FAILED'));
      await expect(f.service[operation](turn, user)).resolves.toMatchObject({
        status: 'FAILED',
        phase: 'REQUEST'
      });
      expect(f.clear).not.toHaveBeenCalled();
      expect(f.replace).not.toHaveBeenCalled();
      expect(f.invalidate).not.toHaveBeenCalled();
      expect(f.draft()).toBe('Unsent source draft');
    }
  );

  it('invalidates rollback details before clearing projections and reopening, and reports reload failure as committed', async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce({ session: source });
    f.open.mockRejectedValueOnce(new Error('RELOAD_FAILED'));
    await expect(f.service.rollback(turn, user)).resolves.toMatchObject({
      status: 'FAILED',
      phase: 'APPLY',
      session: source
    });
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.invalidate.mock.invocationCallOrder[0]).toBeLessThan(
      f.clear.mock.invocationCallOrder[0]!
    );
    expect(f.clear.mock.invocationCallOrder[0]).toBeLessThan(f.open.mock.invocationCallOrder[0]!);
    expect(f.draft()).toBe('Unsent source draft');
    expect(f.submission.pending.value).toBe(false);
  });
});
