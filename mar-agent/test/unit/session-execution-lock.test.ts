import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMarAgentWithAdapter } from '../../src/agent-core/sdk/agent.js';
import { JsonlSessionStore } from '../../src/agent-core/session/store/index.js';
import {
  LocalAgentHost,
  SecretValue,
  type MarAgent,
  type MarAgentEvent,
  type MarAgentModelConfiguration
} from '../../src/index.js';

const homes: string[] = [];
const agents: MarAgent[] = [];
afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.dispose()));
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'mar-execution-lock-'));
  homes.push(home);
  const workspace = join(home, 'workspace');
  await mkdir(workspace);
  const model: MarAgentModelConfiguration = {
    id: 'fake',
    name: 'Fake',
    protocol: 'OPENAI_RESPONSES',
    baseUrl: 'https://example.test/v1',
    apiKey: new SecretValue('unused'),
    modelId: 'fake',
    contextWindowTokens: 100_000,
    maxOutputTokens: 4096,
    reasoningEfforts: ['low'],
    defaultReasoningEffort: 'low',
    inputCapabilities: ['TEXT'],
    outputCapabilities: ['TEXT'],
    hostedWebSearch: false,
    enabled: true
  };
  const host = new LocalAgentHost({ homeDirectory: home, workspace });
  const emit = vi.spyOn(host, 'emit');
  const start = vi.fn(async function* () {
    yield { type: 'text.completed' as const, itemId: 'answer', text: 'Done' };
    yield { type: 'completed' as const, reason: 'completed' as const };
  });
  const agent = await createMarAgentWithAdapter({
    mode: 'normal',
    host,
    models: [model],
    adapterFactory: () => ({ configuration: model, start })
  });
  agents.push(agent);
  const session = await agent.createSession({ workspace });
  const transcript = join(home, '.mar', 'agent', 'sessions', session.id, 'events-000001.jsonl');
  return { home, workspace, model, session, transcript, emit, start };
}

describe('Execution Session write lease', () => {
  it.each(['run', 'plan', 'compact'] as const)(
    'returns %s lock rejection to the stream and Host without appending history',
    async (mode) => {
      const { home, session, transcript, emit, start } = await fixture();
      const store = await JsonlSessionStore.open(home);
      const release = await store.acquireSessionLease(session.id);
      let rejectedExecutionId: string;
      try {
        const before = await readFile(transcript, 'utf8');
        const handle = session[mode]({ prompt: 'Rejected input' });
        rejectedExecutionId = handle.executionId;
        const events: MarAgentEvent[] = [];
        for await (const event of handle) events.push(event);
        await expect(handle.result()).resolves.toMatchObject({
          status: 'failed',
          errorCode: 'MAR_AGENT_SESSION_LOCKED'
        });
        expect(events).toEqual([
          expect.objectContaining({ type: 'execution.failed', code: 'MAR_AGENT_SESSION_LOCKED' })
        ]);
        expect(emit).toHaveBeenCalledWith(events[0]);
        expect(start).not.toHaveBeenCalled();
        expect(await readFile(transcript, 'utf8')).toBe(before);
      } finally {
        await release();
        await store.close();
      }
      const resumed = session.run({ prompt: 'Accepted input' });
      await expect(resumed.result()).resolves.toMatchObject({ status: 'completed' });
      const records = (await readFile(transcript, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(records.some((record) => record.executionId === rejectedExecutionId)).toBe(false);
      expect(records).toContainEqual(
        expect.objectContaining({ type: 'execution.completed', executionId: resumed.executionId })
      );
      expect(records.map((record) => record.sequence)).toEqual(
        records.map((_, index) => index + 1)
      );
    }
  );

  it('publishes cancellation without history writes when no write lease was acquired', async () => {
    const { home, session, transcript, emit, start } = await fixture();
    const store = await JsonlSessionStore.open(home);
    const release = await store.acquireSessionLease(session.id);
    try {
      const before = await readFile(transcript, 'utf8');
      const handle = session.run({ prompt: 'Cancelled conflicting writer' });
      handle.cancel();
      const events: MarAgentEvent[] = [];
      for await (const event of handle) events.push(event);
      await expect(handle.result()).resolves.toMatchObject({ status: 'cancelled' });
      expect(events).toEqual([expect.objectContaining({ type: 'execution.cancelled' })]);
      expect(emit).toHaveBeenCalledWith(events[0]);
      expect(start).not.toHaveBeenCalled();
      expect(await readFile(transcript, 'utf8')).toBe(before);
    } finally {
      await release();
      await store.close();
    }
  });

  it('does not let a rejected process append using an out-of-date Session index', async () => {
    const { home, workspace, model, session, transcript } = await fixture();
    const store = await JsonlSessionStore.open(home);
    const release = await store.acquireSessionLease(session.id);
    try {
      await store.append(session.id, {
        type: 'turn.user',
        executionId: 'owner',
        turnId: 'owner',
        payload: { prompt: 'Input from the lock owner' }
      });
      const before = await readFile(transcript, 'utf8');
      const { apiKey: _, ...configuration } = model;
      const agentUrl = new URL('../../src/agent-core/sdk/agent.ts', import.meta.url).href;
      const indexUrl = new URL('../../src/index.ts', import.meta.url).href;
      const child = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          `import { createMarAgentWithAdapter } from ${JSON.stringify(agentUrl)};
           import { LocalAgentHost, SecretValue } from ${JSON.stringify(indexUrl)};
           const model = { ...${JSON.stringify(configuration)}, apiKey: new SecretValue('unused') };
           const agent = await createMarAgentWithAdapter({
             mode: 'normal',
             host: new LocalAgentHost({ homeDirectory: process.argv[1], workspace: process.argv[2] }),
             models: [model],
             adapterFactory: () => ({ configuration: model, async *start() {
               throw new Error('Rejected execution must not access the model');
             } })
           });
           try {
             const session = await agent.openSession(process.argv[3]);
             const result = await session.run({ prompt: 'Conflicting writer' }).result();
             console.log(JSON.stringify({ status: result.status, code: result.errorCode }));
           } finally { await agent.dispose(); }`,
          home,
          workspace,
          session.id
        ],
        { encoding: 'utf8', timeout: 10_000 }
      );
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual({
        status: 'failed',
        code: 'MAR_AGENT_SESSION_LOCKED'
      });
      expect(await readFile(transcript, 'utf8')).toBe(before);
    } finally {
      await release();
      await store.close();
    }
  });
});
