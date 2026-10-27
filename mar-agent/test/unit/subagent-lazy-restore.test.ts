import { describe, expect, it, vi } from 'vitest';
import {
  SubagentSessionController,
  type PersistedSubagentSession
} from '../../src/subagent/session-controller.js';

function children() {
  return Array.from({ length: 20 }, (_, i): PersistedSubagentSession => ({
    id: `child-${i}`,
    createdAt: String(i).padStart(2, '0'),
    lastActivityAt: String(i).padStart(2, '0'),
    source: {
      type: 'subagent',
      parentSessionId: 'parent',
      rootSessionId: 'parent',
      parentExecutionId: 'origin',
      role: 'explore',
      description: `Child ${i}`
    },
    records: [
      {
        recordId: `record-${i}`,
        sequence: 1,
        sessionId: `child-${i}`,
        timestamp: '2026-01-01',
        type: 'execution.completed',
        payload: { type: 'execution.completed' }
      }
    ]
  }));
}

async function fixture(sessions = children()) {
  const load = vi.fn(async (_parent: string, id: string) => sessions.find((s) => s.id === id));
  const controller = await SubagentSessionController.open({
    parentSessionId: 'parent',
    rootSessionId: 'parent',
    backend: {
      createSession: async () => ({ id: 'new' }),
      deleteSession: async () => {},
      listChildren: async () => sessions.map(({ records: _records, ...meta }) => meta),
      loadChild: load
    }
  });
  return { controller, load, sessions };
}

describe('Lazy historical subagent restoration', () => {
  it('releases old historical details and restores them without replaying consumed evidence', async () => {
    const { controller, load } = await fixture();
    try {
      await controller.prepareAll();
      await controller.output('child-0', { waitMs: 1 });
      await controller.prepareSessionResources();
      load.mockClear();
      await Promise.all([controller.inspect('child-0'), controller.inspect('child-0')]);
      expect(load).toHaveBeenCalledTimes(1);
      expect(controller.collectModelUpdates()).toEqual([]);
      expect(await controller.output('child-0', { waitMs: 1 })).not.toHaveProperty('summary');
      await controller.prepareSessionResources();
      load.mockClear();
      await controller.inspect('child-19');
      expect(load).not.toHaveBeenCalled();
    } finally {
      await controller.dispose();
    }
  });

  it('uses creation order for default wait and activity order for resources', async () => {
    const sessions = children().map((child, i) => ({
      ...child,
      lastActivityAt: String(19 - i).padStart(2, '0')
    }));
    const { controller } = await fixture(sessions);
    try {
      await controller.inspect('child-5');
      expect(await controller.outputAny({ waitMs: 0 })).toMatchObject({ agentId: 'child-19' });
      await controller.prepareSessionResources();
      expect(controller.listSessionResources().map((state) => state.agentId)).toEqual(
        Array.from({ length: 16 }, (_, i) => `child-${i}`)
      );
      await controller.prepareAll();
      expect(controller.inspectAll().map((state) => state.agentId)).toEqual(
        sessions.map((session) => session.id)
      );
    } finally {
      await controller.dispose();
    }
  });

  it('drops deleted discoveries and fills resource slots without hiding explicit missing targets', async () => {
    const { controller, load, sessions } = await fixture();
    sessions.pop();
    try {
      expect(await controller.outputAny({ waitMs: 0 })).toMatchObject({ agentId: 'child-18' });
      await controller.prepareSessionResources();
      expect(controller.listSessionResources().map((state) => state.agentId)).toEqual(
        Array.from({ length: 16 }, (_, i) => `child-${18 - i}`)
      );
      await controller.prepareAll();
      expect(controller.inspectAll()).toHaveLength(19);
      expect(load.mock.calls.filter(([, id]) => id === 'child-19')).toHaveLength(1);
      await expect(controller.inspect('child-19')).rejects.toMatchObject({
        code: 'MAR_AGENT_SUBAGENT_NOT_FOUND'
      });
    } finally {
      await controller.dispose();
    }
  });

  it('propagates real history failures and allows a later retry', async () => {
    const { controller, load } = await fixture();
    const failure = new Error('History read failed.');
    load.mockRejectedValueOnce(failure);
    try {
      await expect(controller.prepareSessionResources()).rejects.toBe(failure);
      await controller.prepareSessionResources();
      expect(controller.listSessionResources()).toHaveLength(16);
    } finally {
      await controller.dispose();
    }
  });

  it.each(['prepareAll', 'prepareSessionResources'] as const)(
    'stops %s after cancellation without loading more histories',
    async (method) => {
      const { controller, load, sessions } = await fixture();
      let ready!: () => void;
      let resume!: () => void;
      const entered = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      load.mockImplementation(async (_parent, id) => {
        ready();
        await gate;
        return sessions.find((session) => session.id === id);
      });
      const abort = new AbortController();
      const pending = controller[method](abort.signal);
      try {
        await entered;
        abort.abort(new Error('Preparation cancelled.'));
        resume();
        await expect(pending).rejects.toThrow('Preparation cancelled.');
        expect(load).toHaveBeenCalledTimes(1);
      } finally {
        resume();
        await controller.dispose();
      }
    }
  );

  it('does not load history at open and preserves default wait and resource order', async () => {
    const { controller, load } = await fixture();
    try {
      expect(load).not.toHaveBeenCalled();
      expect(await controller.inspect('child-0')).toMatchObject({
        agentId: 'child-0',
        status: 'completed'
      });
      expect(await controller.outputAny({ waitMs: 0 })).toMatchObject({ agentId: 'child-19' });
      await controller.prepareSessionResources();
      expect(controller.listSessionResources().map((s) => s.agentId)).toEqual(
        Array.from({ length: 16 }, (_, i) => `child-${19 - i}`)
      );
      expect(load.mock.calls.map((c) => c[1]).sort()).toEqual(
        ['child-0', ...Array.from({ length: 16 }, (_, i) => `child-${19 - i}`)].sort()
      );
      expect(controller.collectModelUpdates()).toEqual([]);
      await controller.prepareAll();
      expect(controller.inspectAll().map((s) => s.agentId)).toEqual(
        Array.from({ length: 20 }, (_, i) => `child-${i}`)
      );
    } finally {
      await controller.dispose();
    }
  });

  it('shares an in-flight target load and never installs a late result after dispose', async () => {
    const { controller, load, sessions } = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    load.mockImplementation(async () => {
      await gate;
      return sessions[0];
    });
    const first = controller.inspect('child-0');
    const second = controller.inspect('child-0');
    await controller.dispose();
    release();
    await expect(first).rejects.toMatchObject({ code: 'MAR_AGENT_DISPOSED' });
    await expect(second).rejects.toMatchObject({ code: 'MAR_AGENT_DISPOSED' });
    expect(load).toHaveBeenCalledTimes(1);
  });
});
