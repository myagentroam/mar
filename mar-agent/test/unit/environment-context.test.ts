import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalAgentHost } from '../../src/host.js';
import { SecretValue, type AgentModelConfiguration } from '../../src/index.js';
import { createAgentWithAdapter as createMarAgent } from '../../src/sdk/agent.js';
import {
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest
} from '../../src/model/contracts.js';
import {
  currentLocalTimeContext,
  environmentContextUpdate,
  restoreEnvironmentState
} from '../../src/runtime/context/environment.js';
import { buildCompactionInput } from '../../src/runtime/compaction/history.js';
import { JsonlSessionStore } from '../../src/session/store/index.js';
import { effectiveInstructions } from './support/model-context.js';

const state = {
  platform: 'linux',
  architecture: 'x64',
  workspace: '/work',
  shell: { name: 'bash', path: '/bin/bash' },
  guaranteedCommands: { rg: '15.1.0', node: '22' }
};
const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('environment context state', () => {
  it('emits full initial context and no update for unchanged or reordered facts', () => {
    expect(environmentContextUpdate(state)).toMatchObject({
      role: 'user',
      contextKind: 'environment',
      content: expect.stringContaining('<cwd>/work</cwd>')
    });
    expect(environmentContextUpdate(state, state)).toBeUndefined();
    expect(
      environmentContextUpdate(
        {
          ...state,
          guaranteedCommands: { node: '22', rg: '15.1.0' }
        },
        state
      )
    ).toBeUndefined();
  });

  it('renders only changed fields and explicitly removes optional facts', () => {
    const changed = environmentContextUpdate({ ...state, workspace: '/new<&>' }, state)!;
    expect(changed.content).toContain('<cwd>/new&lt;&amp;&gt;</cwd>');
    expect(changed.content).not.toContain('<shell>');
    expect(changed.content).not.toContain('<platform>');
    const removed = environmentContextUpdate({ platform: 'linux', workspace: '/work' }, state)!;
    expect(removed.content).toContain('<architecture status="unavailable" />');
    expect(removed.content).toContain('<shell status="unavailable" />');
    expect(removed.content).toContain('<shell_path status="unavailable" />');
    expect(removed.content).toContain('<available_commands status="unavailable" />');
  });

  it('groups transient execution guidance with environment updates', () => {
    const message = environmentContextUpdate(state, state, [
      '<execution_guidance stage="conserve">Converge.</execution_guidance>'
    ])!;
    expect(message).toMatchObject({ role: 'user', contextKind: 'environment' });
    expect(message.content).toBe(
      '<mar_environment>\n  <execution_guidance stage="conserve">Converge.</execution_guidance>\n</mar_environment>'
    );
  });

  it('uses the host date and timezone and only emits their changes', () => {
    const instant = new Date('2026-09-28T00:30:00.000Z');
    const local = currentLocalTimeContext(instant, 'America/Los_Angeles');
    expect(local).toEqual({ currentDate: '2026-09-27', timezone: 'America/Los_Angeles' });
    const full = environmentContextUpdate({ ...state, ...local })!;
    expect(full.content).toContain('<current_date>2026-09-27</current_date>');
    expect(full.content).toContain('<timezone>America/Los_Angeles</timezone>');
    expect(
      environmentContextUpdate({ ...state, ...local }, { ...state, ...local })
    ).toBeUndefined();
    expect(
      environmentContextUpdate(
        { ...state, currentDate: '2026-09-28', timezone: local.timezone },
        { ...state, ...local }
      )!.content
    ).toBe('<mar_environment>\n  <current_date>2026-09-28</current_date>\n</mar_environment>');
    expect(currentLocalTimeContext(instant, 'Invalid/Zone')).toEqual({
      currentDate: '2026-09-28',
      timezone: 'Etc/UTC'
    });
  });

  it('restores only bounded versioned whitelist snapshots', () => {
    expect(restoreEnvironmentState({ version: 1, state })).toEqual(state);
    for (const invalid of [
      null,
      { version: 2, state },
      { version: 1, state: { ...state, env: { SECRET: 'hidden' } } },
      { version: 1, state: { ...state, shell: { ...state.shell, token: 'hidden' } } },
      { version: 1, state: { ...state, workspace: 'x'.repeat(100_000) } }
    ])
      expect(restoreEnvironmentState(invalid)).toBeUndefined();
  });

  it('does not treat runtime environment as compaction evidence or strip user lookalikes', () => {
    const userContent = '<mar_environment>user supplied evidence</mar_environment>';
    const compact = buildCompactionInput(
      [environmentContextUpdate(state)!, { role: 'user', content: userContent }],
      { maxTokens: 2000 }
    );
    expect(compact).not.toContain('<cwd>/work</cwd>');
    expect(compact).toContain(userContent);
  });
});

const model: AgentModelConfiguration = {
  id: 'environment',
  name: 'Environment',
  protocol: 'ANTHROPIC_MESSAGES',
  baseUrl: 'https://example.test',
  apiKey: new SecretValue('test-key'),
  modelId: 'test',
  contextWindowTokens: 200_000,
  maxOutputTokens: 4096,
  inputCapabilities: ['TEXT'],
  outputCapabilities: ['TEXT'],
  reasoningEfforts: ['high'],
  defaultReasoningEffort: 'high',
  hostedWebSearch: false,
  responsesPreviousResponseId: false,
  enabled: true
};
class RecordingAdapter implements ModelAdapter {
  readonly configuration = model;
  readonly requests: ModelRequest[] = [];
  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    yield { type: 'text.completed', itemId: `answer-${this.requests.length}`, text: 'done' };
    yield { type: 'completed', reason: 'completed' };
  }
}

describe('environment context persistence', () => {
  it.each([false, true])(
    'uses Host MAR Home for worktree guidance without exposing mapped paths (mapped=%s)',
    async (mapped) => {
      const home = await mkdtemp(join(tmpdir(), 'mar-worktree-guidance-'));
      roots.push(home);
      const workspace = join(home, 'workspace');
      await mkdir(workspace);
      const adapter = new RecordingAdapter();
      const agent = await createMarAgent(
        {
          mode: 'normal',
          host: new LocalAgentHost({ homeDirectory: home, workspace }),
          models: [model],
          ...(mapped
            ? { workspaceMapping: { logicalPath: '/workspace', physicalPath: workspace } }
            : {})
        },
        () => adapter
      );
      try {
        const session = await agent.createSession({ workspace, title: 'Worktree guidance' });
        expect((await session.run({ prompt: 'Inspect the project.' }).result()).status).toBe(
          'completed'
        );
        const request = adapter.requests[0]!;
        const worktreeRoot = join(home, '.mar', 'worktrees');
        const instructions = effectiveInstructions(request);
        if (mapped) {
          expect(instructions).not.toContain(worktreeRoot);
          expect(instructions).not.toContain('When creating a Git worktree');
        } else {
          expect(instructions).toContain(
            `When creating a Git worktree, prefer a unique directory under the JSON-encoded path ${JSON.stringify(worktreeRoot)} unless the user specifies another location.`
          );
          expect(request.system).not.toContain(worktreeRoot);
        }
        await expect(access(worktreeRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await agent.dispose();
      }
    }
  );

  it('refreshes the environment date across days without adding a precise time reminder', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-28T00:30:00.000Z'));
    const home = await mkdtemp(join(tmpdir(), 'mar-environment-date-'));
    roots.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const adapter = new RecordingAdapter();
    const create = () =>
      createMarAgent(
        {
          mode: 'normal',
          host: new LocalAgentHost({ homeDirectory: home, workspace }),
          models: [model]
        },
        () => adapter
      );
    let agent = await create();
    let id = '';
    try {
      const session = await agent.createSession({ workspace, title: 'Date' });
      id = session.id;
      expect((await session.run({ prompt: 'first' }).result()).status).toBe('completed');
      expect(adapter.requests[0]?.messages[0]?.content).toContain('<current_date>');
      expect(adapter.requests[0]?.messages[0]?.content).toContain('<timezone>');
      expect(
        adapter.requests[0]?.messages
          .filter((message) => message.metadata?.source === 'user')
          .at(-1)?.content
      ).toBe('first');
      vi.setSystemTime(new Date('2026-09-29T02:30:00.000Z'));
      expect((await session.run({ prompt: 'second' }).result()).status).toBe('completed');
      expect(adapter.requests[1]?.messages.at(-2)?.content).toContain('<current_date>');
      expect(adapter.requests[1]?.messages.at(-2)?.content).not.toContain('<timezone>');
    } finally {
      await agent.dispose();
    }
    agent = await create();
    try {
      expect((await (await agent.openSession(id)).run({ prompt: 'third' }).result()).status).toBe(
        'completed'
      );
      expect(
        adapter.requests[2]?.messages.filter((message) => message.contextKind === 'environment')
      ).toHaveLength(2);
      expect(
        adapter.requests[2]?.messages.some((message) =>
          message.content.includes('<current_time_reminder>')
        )
      ).toBe(false);
      const store = await JsonlSessionStore.open(home);
      try {
        expect(
          (await store.read(id)).filter((record) => record.type === 'context.environment')
        ).toHaveLength(2);
      } finally {
        await store.close();
      }
    } finally {
      await agent.dispose();
    }
  });

  it('restores an automatic compact baseline after restart and preserves it in a fork', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-environment-compact-fork-'));
    roots.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const adapter = new RecordingAdapter();
    const create = () =>
      createMarAgent(
        {
          mode: 'normal',
          host: new LocalAgentHost({ homeDirectory: home, workspace }),
          models: [model]
        },
        () => adapter
      );
    let agent = await create();
    let id = '';
    try {
      const session = await agent.createSession({ workspace, title: 'Compact fork' });
      id = session.id;
      expect(
        (await session.run({ prompt: 'Keep TASK_7319 and do not commit.' }).result()).status
      ).toBe('completed');
      expect(adapter.requests[0]?.messages[0]?.content).toContain('<current_date>');
      expect(adapter.requests[0]?.messages[0]?.content).toContain('<timezone>');
      expect(
        adapter.requests[0]?.messages.some((message) =>
          message.content.includes('<current_time_reminder>')
        )
      ).toBe(false);
    } finally {
      await agent.dispose();
    }
    const store = await JsonlSessionStore.open(home);
    let forkId = '';
    try {
      const baseline = (await store.read(id)).find((r) => r.type === 'context.environment')!;
      const environment = restoreEnvironmentState(baseline.payload)!;
      await store.compact(id, {
        summary: 'Keep TASK_7319 and do not commit.',
        automatic: true,
        environment,
        modelId: model.id,
        turnId: 'compact-boundary'
      });
      forkId = (
        await store.forkSession(id, {
          boundaryTurnId: 'compact-boundary',
          title: 'Fork'
        })
      ).id;
    } finally {
      await store.close();
    }
    agent = await create();
    try {
      for (const sessionId of [id, forkId]) {
        expect(
          (await (await agent.openSession(sessionId)).run({ prompt: 'Continue.' }).result()).status
        ).toBe('completed');
        const messages = adapter.requests.at(-1)!.messages;
        const environments = messages.filter((m) => m.contextKind === 'environment');
        expect(environments).toHaveLength(1);
        expect(environments[0]?.content).toContain(`<cwd>${workspace}</cwd>`);
        expect(messages.map((m) => m.content).join('\n')).toContain('TASK_7319');
        expect(messages.map((m) => m.content).join('\n')).toContain('do not commit');
      }
    } finally {
      await agent.dispose();
    }
  });

  it('persists one baseline across turns and restart, appends changes, and resets after compact', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-environment-state-'));
    roots.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const adapter = new RecordingAdapter();
    const create = async (shellName: string) => {
      const host = new LocalAgentHost({ homeDirectory: home, workspace });
      const original = host.describe.bind(host);
      host.describe = async () => ({
        ...(await original()),
        shell: { name: shellName, path: `/bin/${shellName}` }
      });
      return createMarAgent(
        {
          mode: 'normal',
          host,
          models: [model]
        },
        () => adapter
      );
    };
    let agent = await create('bash');
    let id = '';
    try {
      const session = await agent.createSession({ workspace, title: 'Environment state' });
      id = session.id;
      for (const prompt of ['first', 'second'])
        expect((await session.run({ prompt }).result()).status).toBe('completed');
    } finally {
      await agent.dispose();
    }
    agent = await create('bash');
    try {
      expect((await (await agent.openSession(id)).run({ prompt: 'third' }).result()).status).toBe(
        'completed'
      );
    } finally {
      await agent.dispose();
    }
    expect(
      adapter.requests[2]?.messages.filter((m) => m.contextKind === 'environment')
    ).toHaveLength(1);
    expect(adapter.requests[2]?.messages[0]).toEqual(adapter.requests[0]?.messages[0]);
    expect(effectiveInstructions(adapter.requests[2]!)).toContain(
      JSON.stringify(join(home, '.mar', 'worktrees'))
    );
    agent = await create('sh');
    try {
      const session = await agent.openSession(id);
      expect((await session.run({ prompt: 'changed' }).result()).status).toBe('completed');
      const changed = adapter.requests.at(-1)!;
      const contexts = changed.messages.filter((m) => m.contextKind === 'environment');
      expect(contexts).toHaveLength(2);
      expect(contexts[1]?.content).toContain('<shell>sh</shell>');
      expect(contexts[1]?.content).not.toContain('<cwd>');
      expect(changed.messages.at(-2)).toEqual(contexts[1]);
      expect((await session.compact().result()).status).toBe('completed');
      expect(
        adapter.requests.at(-1)?.messages.filter((message) => message.contextKind === 'environment')
      ).toHaveLength(2);
      expect((await session.run({ prompt: 'after compact' }).result()).status).toBe('completed');
      const restored = adapter.requests
        .at(-1)!
        .messages.filter((m) => m.contextKind === 'environment');
      expect(restored).toHaveLength(1);
      expect(restored[0]?.content).toContain(`<cwd>${workspace}</cwd>`);
      expect(restored[0]?.content).toContain('<shell>sh</shell>');
      expect(effectiveInstructions(adapter.requests.at(-1)!)).toContain(
        JSON.stringify(join(home, '.mar', 'worktrees'))
      );
    } finally {
      await agent.dispose();
    }
    const store = await JsonlSessionStore.open(home);
    try {
      const records = await store.read(id);
      const environments = records.filter((r) => r.type === 'context.environment');
      expect(environments).toHaveLength(2);
      expect(
        records.find((record) => record.type === 'compact.completed')?.payload.environment
      ).toMatchObject({ workspace, shell: { name: 'sh' } });
      for (const record of environments) {
        expect(record.payload).toMatchObject({ version: 1, state: { workspace } });
      }
      expect(
        records
          .filter((r) => r.type === 'turn.user')
          .map((r) => (r.payload as { prompt: string }).prompt)
      ).toEqual(['first', 'second', 'third', 'changed', 'after compact']);
    } finally {
      await store.close();
    }
  });
});
