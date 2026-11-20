import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalAgentHost, type HostSkill } from '../../src/host.js';
import { SecretValue } from '../../src/index.js';
import type { ModelEvent, ModelRequest } from '../../src/model/contracts.js';
import { createAgentWithAdapter } from '../../src/sdk/agent.js';
import { JsonlSessionStore } from '../../src/session/store/jsonl/jsonl-store.js';

const toolSource = `await cell.yield_control();
const result = await tools.skill_load({name: 'recovery-workflow'});
if (JSON.stringify(result.data) !== '{"success":true}' || result.content !== undefined)
  throw new Error('Expected a success-only receipt');`;
const firstBody = '## Private recovery guidance\nFirst exact version.\nKeep the complete body.';
const secondBody = '## Private recovery guidance\nSecond exact version.\nKeep this whole update.';
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mar-skill-recovery-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  await Promise.all([mkdir(home), mkdir(workspace)]);
  const open = async (
    load: HostSkill['load'],
    respond?: (request: ModelRequest) => Promise<'cancelled' | undefined>
  ) => {
    const store = await JsonlSessionStore.open(home);
    const host = new LocalAgentHost({ homeDirectory: home, workspace });
    host.bindExecutionExtensions({
      skills: [
        { name: 'recovery-workflow', description: 'A recovery workflow.', requiredTools: [], load }
      ]
    });
    const requests: ModelRequest[] = [];
    const agent = await createAgentWithAdapter(
      {
        mode: 'normal',
        host,
        sessionStore: store,
        models: [
          {
            id: 'coding',
            name: 'Coding',
            modelId: 'test',
            protocol: 'OPENAI_RESPONSES',
            baseUrl: 'https://example.test',
            apiKey: new SecretValue('unused'),
            enabled: true,
            contextWindowTokens: 200_000,
            maxOutputTokens: 4096,
            codeMode: true,
            inputCapabilities: ['TEXT'],
            outputCapabilities: ['TEXT'],
            reasoningEfforts: [],
            hostedWebSearch: false
          }
        ]
      },
      (configuration) => ({
        configuration,
        async *start(request): AsyncIterable<ModelEvent> {
          requests.push(request);
          const last = request.messages.findLast((message) => message.contextKind !== 'contextual');
          if (last?.role === 'user' && last.content.startsWith('Load background version ')) {
            yield {
              type: 'client_tool.call',
              name: 'code_exec',
              callId: last.content,
              arguments: toolSource
            };
            yield { type: 'completed', reason: 'tool_use' };
          } else if ((await respond?.(request)) === 'cancelled') {
            yield { type: 'completed', reason: 'cancelled' };
          } else {
            yield { type: 'text.completed', itemId: 'done', text: 'Done.' };
            yield { type: 'completed', reason: 'completed' };
          }
        }
      })
    );
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      try {
        await agent.dispose();
      } finally {
        await store.close();
      }
    };
    cleanups.push(close);
    return { agent, store, requests, close };
  };
  return { open, workspace };
}

function gatedLoad(...bodies: string[]) {
  const gates = bodies.map((body) => ({ body, gate: Promise.withResolvers<void>() }));
  const load = vi.fn(async () => {
    const next = gates.shift();
    if (!next) throw new Error('Unexpected Skill load');
    await next.gate.promise;
    return next.body;
  });
  const releases = gates.map(({ gate }) => gate.resolve);
  return { load, releases };
}

type Instance = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['open']>>;

async function expectCellReceipt(
  instance: Instance,
  sessionId: string,
  executionId: string,
  status: 'completed' | 'failed'
) {
  await expect
    .poll(async () =>
      (await instance.store.read(sessionId)).find(
        (record) => record.type === 'code.cell.completed' && record.executionId === executionId
      )
    )
    .toMatchObject({ payload: { cellId: expect.stringMatching(/^c_/u), status } });
}

function guidance(request: ModelRequest) {
  return request.messages
    .filter((message) => message.contextualBlock?.id === 'runtime:loaded-skill:recovery-workflow')
    .map((message) => message.content);
}

async function expectPrivateHistory(instance: Instance, sessionId: string) {
  const records = await instance.store.read(sessionId);
  const publicHistory = await instance.agent.sessionHistory(sessionId);
  for (const history of [records, publicHistory]) {
    expect(JSON.stringify(history)).not.toContain('Private recovery guidance');
  }
}

describe('background Skill load recovery', () => {
  it('restores the full accepted body when no model request followed the cell receipt', async () => {
    const { open, workspace } = await fixture();
    const { load, releases } = gatedLoad(firstBody);
    const initial = await open(load);
    try {
      const session = await initial.agent.createSession({ workspace, title: 'Skill recovery' });
      const first = session.run({ prompt: 'Load background version 1' });
      await expect(first.result()).resolves.toMatchObject({ status: 'completed' });
      const requestsBeforeLoad = initial.requests.length;
      expect(initial.requests.flatMap(guidance)).toEqual([]);
      releases[0]!();
      await expectCellReceipt(initial, session.id, first.executionId, 'completed');
      expect(initial.requests).toHaveLength(requestsBeforeLoad);
      await expectPrivateHistory(initial, session.id);
      await initial.close();

      const noReload = vi.fn(async () => 'Must not reload.');
      const reopened = await open(noReload);
      const restored = await reopened.agent.openSession(session.id);
      await expect(restored.run({ prompt: 'Continue.' }).result()).resolves.toMatchObject({
        status: 'completed'
      });
      expect(reopened.requests).toHaveLength(1);
      expect(guidance(reopened.requests[0]!)).toEqual([expect.stringContaining(firstBody)]);
      expect(noReload).not.toHaveBeenCalled();
      await expectPrivateHistory(reopened, session.id);
      await reopened.close();

      const afterConfirmation = await open(noReload);
      const confirmed = await afterConfirmation.agent.openSession(session.id);
      await expect(confirmed.run({ prompt: 'Continue again.' }).result()).resolves.toMatchObject({
        status: 'completed'
      });
      expect(guidance(afterConfirmation.requests[0]!)).toEqual([
        expect.stringContaining(firstBody)
      ]);
      await expect(confirmed.compact({}).result()).resolves.toMatchObject({ status: 'completed' });
      await expect(confirmed.run({ prompt: 'After Compact.' }).result()).resolves.toMatchObject({
        status: 'completed'
      });
      expect(guidance(afterConfirmation.requests.at(-1)!)).toEqual([]);
      expect(noReload).not.toHaveBeenCalled();
    } finally {
      releases[0]!();
    }
  });

  it('does not acknowledge a newer same-name load with an older in-flight request', async () => {
    const { open, workspace } = await fixture();
    const { load, releases } = gatedLoad(firstBody, secondBody);
    const started = Promise.withResolvers<ModelRequest>();
    const finish = Promise.withResolvers<void>();
    const initial = await open(load, async (request) => {
      if (request.messages.some((message) => message.content === 'Deliver the first version.')) {
        started.resolve(request);
        await finish.promise;
      }
      return undefined;
    });
    try {
      const session = await initial.agent.createSession({ workspace, title: 'Skill recovery' });
      const first = session.run({ prompt: 'Load background version 1' });
      await expect(first.result()).resolves.toMatchObject({ status: 'completed' });
      await expect.poll(() => load.mock.calls.length).toBe(1);
      const second = session.run({ prompt: 'Load background version 2' });
      await expect(second.result()).resolves.toMatchObject({ status: 'completed' });
      await expect.poll(() => load.mock.calls.length).toBe(2);
      releases[0]!();
      await expectCellReceipt(initial, session.id, first.executionId, 'completed');

      const delivery = session.run({ prompt: 'Deliver the first version.' });
      expect(guidance(await started.promise)).toEqual([expect.stringContaining(firstBody)]);
      releases[1]!();
      await expectCellReceipt(initial, session.id, second.executionId, 'completed');
      finish.resolve();
      await expect(delivery.result()).resolves.toMatchObject({ status: 'completed' });
      await initial.close();

      const noReload = vi.fn(async () => 'Must not reload.');
      const reopened = await open(noReload);
      const restored = await reopened.agent.openSession(session.id);
      await expect(restored.run({ prompt: 'Continue.' }).result()).resolves.toMatchObject({
        status: 'completed'
      });
      expect(guidance(reopened.requests[0]!)).toEqual([expect.stringContaining(secondBody)]);
      expect(noReload).not.toHaveBeenCalled();
      await expectPrivateHistory(reopened, session.id);
    } finally {
      releases.forEach((release) => release());
      finish.resolve();
    }
  });

  it('does not report or deliver a same-name replacement if its sidecar write fails', async () => {
    const { open, workspace } = await fixture();
    const { load, releases } = gatedLoad(firstBody, secondBody);
    const initial = await open(load);
    try {
      const session = await initial.agent.createSession({ workspace, title: 'Skill recovery' });
      const first = session.run({ prompt: 'Load background version 1' });
      await expect(first.result()).resolves.toMatchObject({ status: 'completed' });
      releases[0]!();
      await expectCellReceipt(initial, session.id, first.executionId, 'completed');

      const second = session.run({ prompt: 'Load background version 2' });
      await expect(second.result()).resolves.toMatchObject({ status: 'completed' });
      const write = vi
        .spyOn(initial.store, 'writeContextualWorldState')
        .mockRejectedValueOnce(new Error(`Store failure containing: ${secondBody}`));
      releases[1]!();
      await expectCellReceipt(initial, session.id, second.executionId, 'failed');
      expect(write).toHaveBeenCalledOnce();
      expect(await initial.store.read(session.id)).toContainEqual(
        expect.objectContaining({
          type: 'tool.failed',
          executionId: second.executionId,
          payload: expect.objectContaining({
            toolName: 'skill_load',
            code: 'MAR_AGENT_SKILL_CONTEXT_PERSIST_FAILED'
          })
        })
      );
      await expectPrivateHistory(initial, session.id);
      await initial.close();

      const noReload = vi.fn(async () => 'Must not reload.');
      const reopened = await open(noReload);
      const restored = await reopened.agent.openSession(session.id);
      await expect(restored.run({ prompt: 'Continue.' }).result()).resolves.toMatchObject({
        status: 'completed'
      });
      expect(guidance(reopened.requests[0]!)).toEqual([expect.stringContaining(firstBody)]);
      expect(noReload).not.toHaveBeenCalled();
    } finally {
      releases.forEach((release) => release());
    }
  });

  it.each(['cancelled', 'confirmation write fails'] as const)(
    'keeps the accepted version out of Compact and recovers it if %s',
    async (interruption) => {
      const { open, workspace } = await fixture();
      const { load, releases } = gatedLoad(firstBody);
      const initial = await open(load, async (request) => {
        if (!request.messages.some((message) => message.content === 'Try delivery.')) return;
        if (request.messages.at(-1)?.contextKind === 'compact_control') {
          if (interruption === 'cancelled')
            write.mockRejectedValueOnce(new Error('Injected Compact sidecar write failure'));
          return;
        }
        if (interruption === 'cancelled') return 'cancelled';
        write.mockRejectedValueOnce(new Error(`Store failure containing: ${firstBody}`));
      });
      const write = vi.spyOn(initial.store, 'writeContextualWorldState');
      try {
        const session = await initial.agent.createSession({ workspace, title: 'Skill recovery' });
        const first = session.run({ prompt: 'Load background version 1' });
        await expect(first.result()).resolves.toMatchObject({ status: 'completed' });
        releases[0]!();
        await expectCellReceipt(initial, session.id, first.executionId, 'completed');
        const attempted = await session.run({ prompt: 'Try delivery.' }).result();
        if (interruption === 'confirmation write fails') {
          expect(attempted).toMatchObject({ status: 'completed' });
          expect(initial.agent.extensionDiagnostics()).toContainEqual(
            expect.objectContaining({ code: 'MAR_AGENT_SKILL_CONTEXT_ACK_PERSIST_FAILED' })
          );
        }
        expect(guidance(initial.requests.at(-1)!)).toEqual([expect.stringContaining(firstBody)]);
        await expect(session.compact({}).result()).resolves.toMatchObject({ status: 'completed' });
        if (interruption === 'cancelled')
          expect(initial.agent.extensionDiagnostics()).toContainEqual(
            expect.objectContaining({ code: 'MAR_AGENT_COMPACT_SIDECAR_PERSIST_FAILED' })
          );
        const compact = initial.requests.at(-1)!;
        expect(compact.messages.at(-1)?.contextKind).toBe('compact_control');
        expect(guidance(compact)).toEqual([]);
        await initial.close();

        const noReload = vi.fn(async () => 'Must not reload.');
        const reopened = await open(noReload);
        const restored = await reopened.agent.openSession(session.id);
        await expect(restored.run({ prompt: 'Continue.' }).result()).resolves.toMatchObject({
          status: 'completed'
        });
        expect(guidance(reopened.requests[0]!)).toEqual([expect.stringContaining(firstBody)]);
        expect(noReload).not.toHaveBeenCalled();
        await expectPrivateHistory(reopened, session.id);
      } finally {
        releases[0]!();
      }
    }
  );
});
