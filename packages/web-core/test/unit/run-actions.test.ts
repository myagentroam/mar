import { workspaceTargetRef } from './support/workspace-fixture.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkbenchApprovalService } from '../../src/service/WorkbenchApprovalService.js';
import { createWorkspaceQueueService } from '../../src/service/WorkspaceQueueService.js';

describe('Workbench Run Actions', () => {
  afterEach(() => vi.useRealTimers());

  it('Submits only encoded approval identity and decision; does not derive business state from response data', async () => {
    const request = vi.fn<(path: string, init?: RequestInit) => void>();
    const finish = vi.fn(() => true);
    const notice = vi.fn();
    const service = createWorkbenchApprovalService({
      workspaceTarget: workspaceTargetRef({ value: 'node-1' }),
      notice,
      request: async <T>(path: string, init?: RequestInit) => {
        request(path, init);
        return undefined as T;
      },
      errorMessage: String,
      beginSubmission: () => finish
    });
    await service.decideApproval('run/1', 'approval/1', 'REJECTED');
    expect(request).toHaveBeenCalledWith(
      '/api/agent-runs/run%2F1/approvals/approval%2F1/decision',
      {
        method: 'POST',
        body: JSON.stringify({ nodeId: 'node-1', decision: 'REJECTED' })
      }
    );
    expect(finish).toHaveBeenCalledOnce();
    expect(notice).not.toHaveBeenCalled();
  });

  it('An approval timeout error does not overwrite a newer notice', async () => {
    const notice = vi.fn();
    notice('new notice', 'info');
    const service = createWorkbenchApprovalService({
      workspaceTarget: workspaceTargetRef({ value: 'node-1' }),
      notice,
      request: async () => {
        throw new Error('late failure');
      },
      errorMessage: String,
      beginSubmission: () => () => false
    });
    await service.decideApproval('run-1', 'approval-1', 'APPROVED');
    expect(notice.mock.calls).toEqual([['new notice', 'info']]);
  });

  it('On approval submission failure, shows only the error; does not proactively fetch or mutate Items', async () => {
    const notice = vi.fn();
    const requests: string[] = [];
    const error = Object.assign(new Error('The run has ended.'), { code: 'RUN_NOT_FOUND' });
    const service = createWorkbenchApprovalService({
      workspaceTarget: workspaceTargetRef({ value: 'node-1' }),
      notice,
      request: async (path) => {
        requests.push(path);
        throw error;
      },
      errorMessage: (error) => String(error),
      beginSubmission: () => () => true
    });

    await service.decideApproval('run-1', 'approval-1', 'APPROVED');

    expect(requests).toEqual(['/api/agent-runs/run-1/approvals/approval-1/decision']);
    expect(notice).toHaveBeenCalledWith(
      expect.stringContaining('The run has ended.'),
      'error',
      error
    );
  });

  it('Does not submit an approval decision twice when an existing Conversation submission is already in progress', async () => {
    const request = vi.fn();
    const service = createWorkbenchApprovalService({
      workspaceTarget: workspaceTargetRef({ value: 'node-1' }),
      notice: vi.fn(),
      request,
      errorMessage: String,
      beginSubmission: () => undefined
    });

    await service.decideApproval('run-1', 'approval-1', 'APPROVED');

    expect(request).not.toHaveBeenCalled();
  });

  it('Keeps local projection pending Watch convergence when a Run has disappeared while executing a queue item', async () => {
    const item = {
      queueItemId: 'queue-1',
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      runner: 'codex',
      clientMessageId: 'message-queued',
      sessionTitle: 'Session',
      content: 'Continue',
      createdAt: 1
    };
    const queue = { value: { version: 1, paused: false, items: [item] } };
    const selectedSessionId = { value: 'session-1' };
    let switchBeforeFailure = false;
    const notice = vi.fn();
    const service = createWorkspaceQueueService({
      queue: queue as never,
      currentSessionQueue: queue as never,
      workspaceTarget: workspaceTargetRef({ value: 'node-1' }, { value: 'workspace-1' }),
      selectedSessionId: selectedSessionId as never,
      draggingQueueItemId: { value: undefined } as never,
      editingContent: { value: '' } as never,
      request: async (path) => {
        if (path.includes('/queue-items/')) {
          if (switchBeforeFailure) selectedSessionId.value = 'session-2';
          throw Object.assign(new Error('The queue item no longer exists.'), {
            code: 'QUEUE_ITEM_INVALID'
          });
        }
        return { queue: { version: 2, paused: false, items: [] } } as never;
      },
      finishEditing: vi.fn(),
      notice,
      errorMessage: String,
      beginSubmission: () => () => true,
      missingQueueItemError: (error) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'QUEUE_ITEM_INVALID'
    });

    await service.execute(item as never);

    expect(queue.value.items).toEqual([item]);
    expect(notice).not.toHaveBeenCalled();

    queue.value = { version: 3, paused: false, items: [item] };
    switchBeforeFailure = true;
    await service.execute(item as never);
    expect(queue.value.items).toEqual([item]);
  });

  it('Does not project a successful queue operation response directly; waits for Watch convergence', async () => {
    const item = {
      queueItemId: 'queue-1',
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      runner: 'codex',
      clientMessageId: 'message-queued',
      sessionTitle: 'Session',
      content: 'Continue',
      createdAt: 1
    };
    const selectedSessionId = { value: 'session-1' };
    const queue = { value: { version: 1, paused: false, items: [item] } };
    const service = createWorkspaceQueueService({
      queue: queue as never,
      currentSessionQueue: queue as never,
      workspaceTarget: workspaceTargetRef({ value: 'node-1' }, { value: 'workspace-1' }),
      selectedSessionId: selectedSessionId as never,
      draggingQueueItemId: { value: undefined } as never,
      editingContent: { value: '' } as never,
      request: async (path) => {
        if (path.includes('/queue?'))
          return { queue: { version: 7, paused: false, items: [] } } as never;
        selectedSessionId.value = 'session-2';
        return { delivery: 'STARTED' } as never;
      },
      finishEditing: vi.fn(),
      notice: vi.fn(),
      errorMessage: String,
      beginSubmission: () => () => true,
      missingQueueItemError: () => false
    });

    await service.execute(item as never);

    expect(queue.value.items).toEqual([item]);
  });

  it('Queue reorder, edit, and delete send write requests only and wait for Watch projection updates', async () => {
    const first = {
      queueItemId: 'queue-1',
      sessionId: 'session-1',
      content: 'First item'
    };
    const second = {
      queueItemId: 'queue-2',
      sessionId: 'session-1',
      content: 'Second item'
    };
    const queue = { value: { version: 4, paused: false, items: [first, second] } };
    const requests: Array<{ path: string; method?: string }> = [];
    const finishEditing = vi.fn();
    const service = createWorkspaceQueueService({
      queue: queue as never,
      currentSessionQueue: queue as never,
      workspaceTarget: workspaceTargetRef({ value: 'node-1' }, { value: 'workspace-1' }),
      selectedSessionId: { value: 'session-1' } as never,
      draggingQueueItemId: { value: 'queue-1' } as never,
      editingContent: { value: 'Edited' } as never,
      request: async (path, init) => {
        requests.push({ path, ...(init?.method === undefined ? {} : { method: init.method }) });
        return { queue: { version: 99, paused: true, items: [] } } as never;
      },
      finishEditing,
      notice: vi.fn(),
      errorMessage: String,
      beginSubmission: () => () => true,
      missingQueueItemError: () => false
    });

    await service.reorder('queue-2');
    await service.save('queue-1');
    await service.remove('queue-2');

    expect(requests).toEqual([
      { path: '/api/workspaces/workspace-1/queue', method: 'PUT' },
      { path: '/api/queue-items/queue-1', method: 'PATCH' },
      { path: '/api/queue-items/queue-2', method: 'DELETE' }
    ]);
    expect(queue.value).toEqual({ version: 4, paused: false, items: [first, second] });
    expect(finishEditing).toHaveBeenCalledOnce();
  });

  it('When executing immediately from edit mode, saves the current body before executing the queue item', async () => {
    const item = {
      queueItemId: 'queue-1',
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      runner: 'codex',
      clientMessageId: 'message-queued',
      sessionTitle: 'Session',
      content: 'Old body',
      createdAt: 1
    };
    const queue = { value: { version: 1, paused: false, items: [item] } };
    const requests: Array<{ path: string; method?: string; body?: unknown }> = [];
    const finishEditing = vi.fn();
    const finishSubmission = vi.fn(() => true);
    const service = createWorkspaceQueueService({
      queue: queue as never,
      currentSessionQueue: queue as never,
      workspaceTarget: workspaceTargetRef({ value: 'node-1' }, { value: 'workspace-1' }),
      selectedSessionId: { value: 'session-1' } as never,
      draggingQueueItemId: { value: undefined } as never,
      editingContent: { value: 'Unused body' } as never,
      request: async (path, init) => {
        requests.push({
          path,
          ...(init?.method === undefined ? {} : { method: init.method }),
          ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) })
        });
        return {} as never;
      },
      finishEditing,
      notice: vi.fn(),
      errorMessage: String,
      beginSubmission: () => finishSubmission,
      missingQueueItemError: () => false
    });

    await service.execute(item as never, 'Current edit body');

    expect(requests).toEqual([
      {
        path: '/api/queue-items/queue-1',
        method: 'PATCH',
        body: {
          nodeId: 'node-1',
          workspaceId: 'workspace-1',
          sessionId: 'session-1',
          content: 'Current edit body'
        }
      },
      {
        path: '/api/queue-items/queue-1/execute',
        method: 'POST',
        body: { nodeId: 'node-1', workspaceId: 'workspace-1' }
      }
    ]);
    expect(finishEditing).toHaveBeenCalledOnce();
    expect(finishSubmission).toHaveBeenCalledOnce();
  });

  it('Does not execute immediately when saving the edited content fails', async () => {
    const item = {
      queueItemId: 'queue-1',
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      runner: 'codex',
      clientMessageId: 'message-queued',
      sessionTitle: 'Session',
      content: 'Old body',
      createdAt: 1
    };
    const queue = { value: { version: 1, paused: false, items: [item] } };
    const requests: string[] = [];
    const notice = vi.fn();
    const error = new Error('save failed');
    const finishEditing = vi.fn();
    const finishSubmission = vi.fn(() => true);
    const service = createWorkspaceQueueService({
      queue: queue as never,
      currentSessionQueue: queue as never,
      workspaceTarget: workspaceTargetRef({ value: 'node-1' }, { value: 'workspace-1' }),
      selectedSessionId: { value: 'session-1' } as never,
      draggingQueueItemId: { value: undefined } as never,
      editingContent: { value: 'Current edit body' } as never,
      request: async (path) => {
        requests.push(path);
        throw error;
      },
      finishEditing,
      notice,
      errorMessage: String,
      beginSubmission: () => finishSubmission,
      missingQueueItemError: () => false
    });

    await service.execute(item as never, 'Current edit body');

    expect(requests).toEqual(['/api/queue-items/queue-1']);
    expect(notice).toHaveBeenCalledWith(expect.stringContaining('save failed'), 'error', error);
    expect(finishEditing).not.toHaveBeenCalled();
    expect(finishSubmission).toHaveBeenCalledOnce();
  });
});
