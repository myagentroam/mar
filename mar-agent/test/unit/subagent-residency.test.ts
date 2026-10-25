import { describe, expect, it, vi } from 'vitest';
import { residencyFixture } from '../support/subagent-residency.js';

const task = {
  description: 'inspect',
  prompt: 'inspect',
  role: 'explore' as const,
  background: true
};

async function populate(f: Awaited<ReturnType<typeof residencyFixture>>, consume = true) {
  const ids: string[] = [];
  for (let i = 0; i < 20; i++) {
    if (i % 10 === 0) await f.begin();
    const { agentId } = await f.controller.run(task);
    ids.push(agentId);
    if (consume) await f.controller.output(agentId, { untilSettled: true });
    else
      await vi.waitFor(
        async () => {
          expect((await f.controller.inspect(agentId)).status).toBe('completed');
        },
        { interval: 1, timeout: 2000 }
      );
  }
  if (consume) for (const update of f.controller.collectModelUpdates()) update.acknowledge();
  return ids;
}

describe('Subagent detail residency', () => {
  it('keeps unread and captured updates until consumed and ignores a stale acknowledgement after reload', async () => {
    const f = await residencyFixture();
    try {
      const ids = await populate(f, false);
      const captured = f.controller.collectModelUpdates();
      expect(captured[0]!.snapshot.agentId).toBe(ids[0]);
      const before = await f.controller.inspect(ids[0]!);
      await f.controller.prepareSessionResources();
      expect(await f.controller.inspect(ids[0]!)).toEqual(before);
      expect(f.loads.size).toBe(0);
      // A cancelled/failed parent leaves candidates unacknowledged; an explicit wait can consume.
      await f.controller.output(ids[0]!, { waitMs: 1 });
      await f.controller.prepareSessionResources();
      await f.controller.inspect(ids[0]!);
      expect(f.loads.get(ids[0]!)).toBe(1);
      await f.controller.message(ids[0]!, 'new Turn');
      await vi.waitFor(
        async () => {
          expect((await f.controller.inspect(ids[0]!)).status).toBe('completed');
        },
        { interval: 1, timeout: 2000 }
      );
      for (const update of captured) update.acknowledge();
      // Automatic injection is bounded per round; consume other old candidates separately.
      for (let round = 0; round < 3; round++) {
        for (const update of f.controller.collectModelUpdates()) {
          if (update.snapshot.agentId !== ids[0]) update.acknowledge();
        }
      }
      const fresh = f.controller.collectModelUpdates();
      expect(fresh).toHaveLength(1);
      expect(fresh[0]!.snapshot.agentId).toBe(ids[0]);
      const current = await f.controller.inspect(ids[0]!);
      expect(fresh[0]!.snapshot.summary).toBe(current.summary);
      expect(fresh[0]!.snapshot.turnId).toBe(current.latestMessage?.turnId);
      expect(fresh[0]!.snapshot.turnId).not.toBe(before.latestMessage?.turnId);
      expect(fresh[0]!.snapshot).not.toHaveProperty('latestMessage');
    } finally {
      await f.close();
    }
  });

  it('does not leave detail protection behind after a cancelled full listing', async () => {
    const f = await residencyFixture();
    try {
      const ids = await populate(f);
      await f.controller.prepareSessionResources();
      const abort = new AbortController();
      f.setBeforeLoad(async () => {
        abort.abort();
      });
      await expect(f.controller.list(abort.signal)).rejects.toThrow();
      f.setBeforeLoad();
      await f.controller.prepareSessionResources();
      await f.controller.inspect(ids[0]!);
      expect(f.loads.get(ids[0]!)).toBe(2);
    } finally {
      await f.close();
    }
  });

  it('removes a deleted evicted identity and does not turn a read failure into deletion', async () => {
    const f = await residencyFixture();
    try {
      const ids = await populate(f);
      await f.controller.prepareSessionResources();
      await f.store.delete(ids[0]!);
      await expect(f.controller.inspect(ids[0]!)).rejects.toHaveProperty(
        'code',
        'MAR_AGENT_SUBAGENT_NOT_FOUND'
      );
      expect(await f.controller.list()).toHaveLength(19);
    } finally {
      await f.close();
    }
  });

  it('restores consumed durable results with the same evidence, receipt and observation positions', async () => {
    const f = await residencyFixture();
    try {
      const ids = await populate(f);
      const before = await f.controller.inspect(ids[0]!);
      await f.controller.prepareSessionResources();
      expect(await f.controller.inspect(ids[0]!)).toEqual(before);
      expect(f.loads.get(ids[0]!)).toBe(1);
      expect(f.controller.collectModelUpdates()).toEqual([]);
      const waited = await f.controller.output(ids[0]!, { waitMs: 1 });
      for (const id of ids.slice(4)) {
        expect((await f.controller.inspect(id)).summary).toBeDefined();
        expect(f.loads.has(id)).toBe(false);
      }
      expect(waited).not.toHaveProperty('summary');
      expect(waited).not.toHaveProperty('latestMessage');
      expect(await f.controller.outputAny({ waitMs: 0 })).toMatchObject({ agentId: ids.at(-1) });
      const receipt = await f.controller.message(ids[0]!, 'continue');
      await f.controller.output(ids[0]!, { untilSettled: true });
      const continued = await f.controller.inspect(ids[0]!);
      expect(continued.messageId).toBe(receipt.messageId);
      expect(continued.deliveryStatus).toBe('applied');
      expect(continued.evidence).toEqual([{ path: 'source.ts', startLine: 2, endLine: 9 }]);
    } finally {
      await f.close();
    }
  });

  it('keeps non-durable results even after a parent lifecycle notification succeeds', async () => {
    const f = await residencyFixture(128, false);
    try {
      const ids = await populate(f);
      const before = await f.controller.inspect(ids[0]!);
      await f.controller.prepareSessionResources();
      expect(await f.controller.inspect(ids[0]!)).toEqual(before);
      expect(f.loads.size).toBe(0);
    } finally {
      await f.close();
    }
  });

  it('protects a full listing across concurrent resource preparation and releases protection after failure', async () => {
    const f = await residencyFixture();
    try {
      const ids = await populate(f);
      await f.controller.prepareSessionResources();
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.setBeforeLoad(async (id) => {
        if (id === ids[0]) {
          entered();
          await gate;
        }
      });
      const listing = f.controller.list();
      await started;
      await f.controller.prepareSessionResources();
      release();
      const listed = await listing;
      expect(listed.map((s) => s.agentId)).toEqual(ids);
      expect(listed.every((s) => s.latestMessage !== undefined && s.summary !== undefined)).toBe(
        true
      );
      f.setBeforeLoad();
      await f.controller.prepareSessionResources();
      const loads = f.loads.get(ids[0]!)!;
      f.setBeforeLoad(async () => {
        throw new Error('history failed');
      });
      await expect(f.controller.list()).rejects.toThrow('history failed');
      f.setBeforeLoad();
      await f.controller.prepareSessionResources();
      await f.controller.inspect(ids[0]!);
      expect(f.loads.get(ids[0]!)).toBe(loads + 2);
    } finally {
      await f.close();
    }
  });

  it('releases failed reads and shares a later successful reload without installing stale state', async () => {
    const f = await residencyFixture();
    try {
      const ids = await populate(f);
      const before = await f.controller.inspect(ids[0]!);
      await f.controller.prepareSessionResources();
      f.setBeforeLoad(async () => {
        throw new Error('read failed');
      });
      await expect(f.controller.inspect(ids[0]!)).rejects.toThrow('read failed');
      f.setBeforeLoad();
      const values = await Promise.all([
        f.controller.inspect(ids[0]!),
        f.controller.inspect(ids[0]!)
      ]);
      expect(values).toEqual([before, before]);
      expect(f.loads.get(ids[0]!)).toBe(2);
      expect(f.controller.collectModelUpdates()).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('protects a target during shared reload, releases a cancelled waiter and preserves batch evidence consumption', async () => {
    const f = await residencyFixture();
    let release!: () => void;
    try {
      const ids = await populate(f);
      await f.controller.prepareSessionResources();
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.setBeforeLoad(async (id) => {
        if (id === ids[0]) {
          entered();
          await gate;
        }
      });
      const abort = new AbortController();
      const waiting = f.controller.output(ids[0]!, { untilSettled: true, signal: abort.signal });
      const cancelled = expect(waiting).rejects.toThrow();
      await started;
      const inspection = f.controller.inspect(ids[0]!);
      await f.controller.prepareSessionResources();
      abort.abort();
      release();
      await cancelled;
      expect((await inspection).summary).toBeDefined();
      expect(f.loads.get(ids[0]!)).toBe(1);
      f.setBeforeLoad();
      await f.controller.prepareSessionResources();
      const group = await f.controller.outputMany(ids.slice(0, 2), { mode: 'all', waitMs: 1 });
      expect(group.pendingAgentIds).toEqual([]);
      expect(group.agents.every((s) => s.status === 'completed' && !('summary' in s))).toBe(true);
      expect(f.loads.get(ids[0]!)).toBe(2);
    } finally {
      release?.();
      await f.close();
    }
  });
});
