import { describe, expect, it, vi } from 'vitest';
import { NodeRunEventBridge } from '../../src/service/node-run-event-bridge.js';

describe('Node Run event bridge', () => {
  it('forwards lifecycle events unchanged and binds usage only when execution starts', () => {
    const emit = vi.fn();
    const bindModelUsage = vi.fn();
    const modelUsage = vi.fn();
    const send = vi.fn();
    const emitWorkbench = vi.fn();
    const bridge = new NodeRunEventBridge({
      events: { emit } as never,
      queues: {} as never,
      bindModelUsage,
      modelUsage,
      send,
      emitWorkbench
    });
    bridge.emitRun('execution-1', 'run.started', { startedAt: 100 }, 'STARTING');
    bridge.emitRun('execution-1', 'run.running', {}, 'RUNNING');
    bridge.emitRun('execution-1', 'run.usage', { inputTokens: 10 });
    bridge.emitConversationItem('execution-1', { id: 'item-1' });
    bridge.emitRun('execution-1', 'run.completed', {}, 'SUCCEEDED');
    expect(bindModelUsage).toHaveBeenCalledExactlyOnceWith('execution-1');
    expect(modelUsage).toHaveBeenCalledExactlyOnceWith('execution-1', { inputTokens: 10 });
    expect(emit.mock.calls).toEqual([
      ['execution-1', 'run.started', { startedAt: 100 }, 'STARTING'],
      ['execution-1', 'run.running', {}, 'RUNNING'],
      ['execution-1', 'conversation.item', { id: 'item-1' }, undefined],
      ['execution-1', 'run.completed', {}, 'SUCCEEDED']
    ]);
    expect(send).not.toHaveBeenCalled();
    expect(emitWorkbench).not.toHaveBeenCalled();
  });

  it('keeps approval control delivery and queue snapshots on their existing paths', () => {
    const emit = vi.fn();
    const send = vi.fn();
    const emitWorkbench = vi.fn();
    const queue = { version: 3, items: [] };
    const present = vi.fn(() => queue);
    const bridge = new NodeRunEventBridge({
      events: { emit } as never,
      queues: { present } as never,
      send,
      emitWorkbench
    });
    const approval = { runId: 'run-1', approvalId: 'approval-1', payload: {}, expiresAt: 500 };
    bridge.publishApproval(approval);
    expect(send).toHaveBeenCalledExactlyOnceWith('approval.request', approval);
    expect(emit).toHaveBeenCalledExactlyOnceWith('run-1', 'approval.request', approval, undefined);
    bridge.emitQueue('workspace-1', 'session-1');
    expect(present).toHaveBeenCalledExactlyOnceWith('workspace-1', 'session-1');
    expect(emitWorkbench).toHaveBeenCalledExactlyOnceWith('queue', {
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      queue
    });
  });
});
