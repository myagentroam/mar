import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalAgentHost, type HostSessionResourceSnapshot } from '../../src/host.js';
import { SecretValue, type AgentModelConfiguration } from '../../src/index.js';
import { createAgentWithAdapter as createMarAgent } from '../../src/sdk/agent.js';
import {
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest
} from '../../src/model/contracts.js';
import { loadAgentInstructions } from '../../src/runtime/context/instructions.js';
import { JsonlSessionStore } from '../../src/session/store/index.js';
import { restoreMessages } from '../../src/runtime/context/restore.js';
import { buildCompactedHistory } from '../../src/runtime/compaction/history.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const model: AgentModelConfiguration = {
  id: 'instructions',
  name: 'Instructions',
  protocol: 'ANTHROPIC_MESSAGES',
  baseUrl: 'https://example.test',
  apiKey: new SecretValue('secret'),
  modelId: 'instructions',
  contextWindowTokens: 200_000,
  maxOutputTokens: 4096,
  inputCapabilities: ['TEXT'],
  outputCapabilities: ['TEXT'],
  reasoningEfforts: [],
  hostedWebSearch: false,
  responsesPreviousResponseId: false,
  enabled: true
};

class RecordingAdapter implements ModelAdapter {
  readonly configuration = model;
  readonly requests: ModelRequest[] = [];

  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    const compact = request.toolChoice === 'none';
    yield {
      type: 'text.completed',
      itemId: compact ? 'summary' : 'answer',
      text: compact ? 'durable summary' : 'done'
    };
    yield { type: 'completed', reason: 'completed' };
  }
}

class ResponsesRecordingAdapter implements ModelAdapter {
  readonly configuration: AgentModelConfiguration = {
    ...model,
    protocol: 'OPENAI_RESPONSES',
    responsesPreviousResponseId: true
  };
  readonly requests: ModelRequest[] = [];

  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    const sequence = this.requests.length;
    yield { type: 'response.started', responseId: `response-${sequence}` };
    yield { type: 'text.completed', itemId: `answer-${sequence}`, text: `done-${sequence}` };
    yield { type: 'completed', reason: 'completed' };
  }
}

class ChangingResourceHost extends LocalAgentHost {
  reads = 0;
  resources: HostSessionResourceSnapshot = {
    processes: [
      {
        processId: 'retained-process',
        status: 'running',
        command: 'long-running-command',
        cwd: '/workspace'
      }
    ],
    codeCells: [{ cellId: 'retained-cell', status: 'completed', executionId: 'old-execution' }]
  };

  override async listSessionResources(): Promise<HostSessionResourceSnapshot> {
    this.reads++;
    return this.resources;
  }
}

async function fixture(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  await Promise.all([mkdir(home, { recursive: true }), mkdir(workspace, { recursive: true })]);
  return { root, home, workspace };
}

describe('AGENTS instruction loading', () => {
  it('keeps the selected oversized override and truncates it instead of falling back', async () => {
    const { home, workspace } = await fixture('mar-instructions-override-');
    await writeFile(join(workspace, 'AGENTS.override.md'), `OVERRIDE:${'x'.repeat(32 * 1024)}`);
    await writeFile(join(workspace, 'AGENTS.md'), 'REGULAR_FALLBACK');

    const context = await loadAgentInstructions({ home, workspace });

    expect(context.entries).toHaveLength(1);
    expect(context.entries[0]).toMatchObject({
      kind: 'project',
      sourcePath: join(workspace, 'AGENTS.override.md'),
      displayPath: '<project>/AGENTS.override.md',
      truncated: true
    });
    expect(context.entries[0]?.content.startsWith('OVERRIDE:')).toBe(true);
    expect(Buffer.byteLength(context.entries[0]!.content)).toBe(32 * 1024);
    expect(context.entries[0]?.content).not.toContain('REGULAR_FALLBACK');
  });

  it('does not treat project .agents as an AGENTS instruction source', async () => {
    const { home, workspace } = await fixture('mar-instructions-project-root-');
    await mkdir(join(workspace, '.agents'), { recursive: true });
    await writeFile(join(workspace, '.agents', 'AGENTS.md'), 'DOT_AGENTS_MUST_NOT_LOAD');
    await writeFile(join(workspace, 'AGENTS.md'), 'PROJECT_ROOT_RULE');

    const context = await loadAgentInstructions({ home, workspace });

    expect(context.entries).toHaveLength(1);
    expect(context.entries[0]).toMatchObject({
      kind: 'project',
      sourcePath: join(workspace, 'AGENTS.md'),
      content: 'PROJECT_ROOT_RULE'
    });
  });

  it('does not load AGENTS below the selected workspace', async () => {
    const { home, workspace } = await fixture('mar-instructions-descendant-');
    const nested = join(workspace, 'nested');
    await mkdir(nested, { recursive: true });
    await writeFile(join(workspace, 'AGENTS.md'), 'PROJECT_ROOT_RULE');
    await writeFile(join(nested, 'AGENTS.md'), 'DESCENDANT_RULE');

    const context = await loadAgentInstructions({ home, workspace });

    expect(context.entries).toHaveLength(1);
    expect(context.entries[0]).toMatchObject({
      kind: 'project',
      sourcePath: join(workspace, 'AGENTS.md'),
      content: 'PROJECT_ROOT_RULE'
    });
    expect(context.entries.some((entry) => entry.content.includes('DESCENDANT_RULE'))).toBe(false);
  });

  it('shares the project budget across directories without charging user instructions', async () => {
    const { home, workspace } = await fixture('mar-instructions-budget-');
    await writeFile(join(workspace, '.git'), '');
    await mkdir(join(home, '.agents'), { recursive: true });
    await writeFile(join(home, '.agents', 'AGENTS.md'), 'u'.repeat(64 * 1024 + 1));
    const directories = [
      workspace,
      join(workspace, 'a'),
      join(workspace, 'a', 'b'),
      join(workspace, 'a', 'b', 'c'),
      join(workspace, 'a', 'b', 'c', 'd')
    ];
    await Promise.all(
      directories.slice(1).map((directory) => mkdir(directory, { recursive: true }))
    );
    await Promise.all([
      writeFile(join(directories[0]!, 'AGENTS.md'), 'a'.repeat(8 * 1024)),
      writeFile(join(directories[1]!, 'AGENTS.md'), 'b'.repeat(8 * 1024)),
      writeFile(join(directories[2]!, 'AGENTS.md'), 'c'.repeat(8 * 1024)),
      writeFile(join(directories[3]!, 'AGENTS.md'), 'd'.repeat(8 * 1024 - 3)),
      writeFile(join(directories[4]!, 'AGENTS.md'), 'abcdef')
    ]);

    const context = await loadAgentInstructions({ home, workspace: directories[4]! });

    expect(context.entries).toHaveLength(6);
    expect(context.entries[0]).toMatchObject({
      kind: 'user',
      content: 'u'.repeat(64 * 1024),
      truncated: true
    });
    expect(context.entries[1]?.kind).toBe('project');
    expect(context.entries.slice(2).every((entry) => entry.kind === 'scoped')).toBe(true);
    expect(context.entries.at(-1)).toMatchObject({
      sourcePath: join(directories[4]!, 'AGENTS.md'),
      content: 'abc',
      truncated: true
    });
    expect(
      context.entries
        .filter((entry) => entry.kind !== 'user')
        .reduce((total, entry) => total + Buffer.byteLength(entry.content), 0)
    ).toBe(32 * 1024);
  });

  it('excludes narrower rules after the project byte budget is exactly exhausted', async () => {
    const { home, workspace } = await fixture('mar-instructions-budget-exact-');
    const nested = join(workspace, 'nested');
    await mkdir(nested);
    await writeFile(join(workspace, '.git'), '');
    const content = '中'.repeat(10_000) + 'x'.repeat(32 * 1024 - 30_000);
    await writeFile(join(workspace, 'AGENTS.md'), content);
    await writeFile(join(nested, 'AGENTS.md'), 'NARROW_RULE');
    const context = await loadAgentInstructions({ home, workspace: nested });
    expect(context.entries).toHaveLength(1);
    expect(context.entries[0]).toMatchObject({ kind: 'project', content, truncated: false });
  });

  it('does not charge a whitespace-only project rule against narrower instructions', async () => {
    const { home, workspace } = await fixture('mar-instructions-budget-blank-');
    const nested = join(workspace, 'nested');
    await mkdir(nested);
    await writeFile(join(workspace, '.git'), '');
    await writeFile(join(workspace, 'AGENTS.md'), ' '.repeat(32 * 1024));
    await writeFile(join(nested, 'AGENTS.md'), 'x'.repeat(32 * 1024));

    const context = await loadAgentInstructions({ home, workspace: nested });
    expect(context.entries).toHaveLength(1);
    expect(context.entries[0]).toMatchObject({
      kind: 'scoped',
      content: 'x'.repeat(32 * 1024),
      truncated: false
    });
  });

  it('continues reading a regular file after a short read', async () => {
    const { home, workspace } = await fixture('mar-instructions-short-read-');
    const path = join(workspace, 'AGENTS.md');
    await writeFile(path, 'abcdef');
    const probe = await open(path, 'r');
    const prototype = Object.getPrototypeOf(probe) as {
      read: (...arguments_: unknown[]) => Promise<{ bytesRead: number; buffer: Buffer }>;
    };
    await probe.close();
    const originalRead = prototype.read;
    const read = vi.spyOn(prototype, 'read').mockImplementation(function (
      this: unknown,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number
    ) {
      return originalRead.call(this, buffer, offset, Math.min(length, 2), position);
    });

    try {
      const context = await loadAgentInstructions({ home, workspace });
      expect(context.entries[0]?.content).toBe('abcdef');
      expect(context.entries[0]?.truncated).toBe(false);
    } finally {
      read.mockRestore();
    }
  });

  it('marks truncation when the readable bytes exceed underreported metadata size', async () => {
    const { home, workspace } = await fixture('mar-instructions-truncation-probe-');
    const path = join(workspace, 'AGENTS.md');
    await writeFile(path, 'x'.repeat(32 * 1024 + 1));
    const probe = await open(path, 'r');
    const prototype = Object.getPrototypeOf(probe) as {
      stat: () => Promise<{ dev: number; ino: number; isFile(): boolean; size: number }>;
    };
    await probe.close();
    const originalStat = prototype.stat;
    const fileStat = vi.spyOn(prototype, 'stat').mockImplementation(async function (this: unknown) {
      const metadata = await originalStat.call(this);
      return new Proxy(metadata, {
        get(target, property, receiver) {
          if (property === 'size') return 0;
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
    });

    try {
      const context = await loadAgentInstructions({ home, workspace });
      expect(context.entries[0]).toMatchObject({
        content: 'x'.repeat(32 * 1024),
        truncated: true
      });
    } finally {
      fileStat.mockRestore();
    }
  });

  it('skips a candidate whose read fails without blocking instruction loading', async () => {
    const { home, workspace } = await fixture('mar-instructions-read-error-');
    const path = join(workspace, 'AGENTS.md');
    await writeFile(path, 'RULE');
    const probe = await open(path, 'r');
    const prototype = Object.getPrototypeOf(probe) as {
      read: (...arguments_: unknown[]) => Promise<{ bytesRead: number; buffer: Buffer }>;
    };
    await probe.close();
    const read = vi
      .spyOn(prototype, 'read')
      .mockRejectedValueOnce(Object.assign(new Error('not a directory'), { code: 'ENOTDIR' }));

    try {
      await expect(loadAgentInstructions({ home, workspace })).resolves.toMatchObject({
        entries: []
      });
    } finally {
      read.mockRestore();
    }
  });

  it.runIf(process.platform !== 'win32')(
    'loads a linked instruction whose target is outside the workspace',
    async () => {
      const { root, home, workspace } = await fixture('mar-instructions-linked-rule-');
      const targetDirectory = join(root, 'outside');
      const target = join(targetDirectory, 'rules.md');
      const source = join(workspace, 'AGENTS.md');
      await mkdir(targetDirectory, { recursive: true });
      await writeFile(target, 'LINKED_RULE');
      await symlink(target, source);

      const context = await loadAgentInstructions({ home, workspace });

      expect(context.entries).toHaveLength(1);
      expect(context.entries[0]).toMatchObject({
        sourcePath: source,
        content: 'LINKED_RULE'
      });
    }
  );

  it('falls back to AGENTS.md when the override cannot be read', async () => {
    const { home, workspace } = await fixture('mar-instructions-override-read-error-');
    await writeFile(join(workspace, 'AGENTS.override.md'), 'OVERRIDE');
    await writeFile(join(workspace, 'AGENTS.md'), 'REGULAR_RULE');
    const probe = await open(join(workspace, 'AGENTS.override.md'), 'r');
    const prototype = Object.getPrototypeOf(probe) as {
      read: (...arguments_: unknown[]) => Promise<{ bytesRead: number; buffer: Buffer }>;
    };
    await probe.close();
    const read = vi
      .spyOn(prototype, 'read')
      .mockRejectedValueOnce(Object.assign(new Error('access denied'), { code: 'EACCES' }));

    try {
      const context = await loadAgentInstructions({ home, workspace });
      expect(context.entries).toHaveLength(1);
      expect(context.entries[0]).toMatchObject({
        sourcePath: join(workspace, 'AGENTS.md'),
        content: 'REGULAR_RULE'
      });
    } finally {
      read.mockRestore();
    }
  });

  it.runIf(process.platform !== 'win32')(
    'ignores a FIFO override without waiting for a writer',
    async () => {
      const { home, workspace } = await fixture('mar-instructions-fifo-');
      const override = join(workspace, 'AGENTS.override.md');
      await execFileAsync('mkfifo', [override]);
      await writeFile(join(workspace, 'AGENTS.md'), 'REGULAR_RULE');

      const load = loadAgentInstructions({ home, workspace });
      const context = await Promise.race([
        load,
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 500))
      ]);
      if (context === undefined) {
        await writeFile(override, 'release-first-read');
        await writeFile(override, 'release-second-read');
        await load;
        throw new Error('instruction loading blocked on FIFO');
      }

      expect(context.entries).toHaveLength(1);
      expect(context.entries[0]).toMatchObject({
        sourcePath: join(workspace, 'AGENTS.md'),
        content: 'REGULAR_RULE'
      });
    }
  );

  it.runIf(process.platform !== 'win32')(
    'skips a candidate whose metadata cannot be resolved',
    async () => {
      const { home, workspace } = await fixture('mar-instructions-error-');
      await symlink('AGENTS.override.md', join(workspace, 'AGENTS.override.md'));

      await expect(loadAgentInstructions({ home, workspace })).resolves.toMatchObject({
        entries: []
      });
    }
  );
});

describe('AGENTS model context', () => {
  it('keeps base instructions stable across workspaces and injects fresh context on reopen', async () => {
    const { home, workspace } = await fixture('mar-environment-reopen-');
    const otherWorkspace = join(home, 'other-workspace');
    await mkdir(otherWorkspace);
    const adapter = new RecordingAdapter();
    const create = () =>
      createMarAgent(
        {
          mode: 'normal',
          host: new LocalAgentHost({ homeDirectory: home, workspace }),
          models: [model],
          systemInstruction: 'HOST_CONTRACT'
        },
        () => adapter
      );
    let agent = await create();
    let secondId = '';
    try {
      const first = await agent.createSession({ workspace, title: 'First workspace' });
      const second = await agent.createSession({
        workspace: otherWorkspace,
        title: 'Second workspace'
      });
      secondId = second.id;
      expect((await first.run({ prompt: 'first' }).result()).status).toBe('completed');
      expect((await second.run({ prompt: 'second' }).result()).status).toBe('completed');
    } finally {
      await agent.dispose();
    }
    agent = await create();
    try {
      expect(
        (await (await agent.openSession(secondId)).run({ prompt: 'continue' }).result()).status
      ).toBe('completed');
    } finally {
      await agent.dispose();
    }
    expect(adapter.requests).toHaveLength(3);
    expect(adapter.requests[0]?.system).toBe(adapter.requests[1]?.system);
    expect(adapter.requests[1]?.system).toBe(adapter.requests[2]?.system);
    expect(adapter.requests[0]?.system).not.toContain('HOST_CONTRACT');
    expect(
      adapter.requests[0]?.messages.some(
        (message) =>
          message.contextualBlock?.source === 'host' && message.content.includes('HOST_CONTRACT')
      )
    ).toBe(true);
    for (const [index, expectedWorkspace] of [
      workspace,
      otherWorkspace,
      otherWorkspace
    ].entries()) {
      const request = adapter.requests[index]!;
      const environment = request.messages.filter((message) =>
        message.content.startsWith('<mar_environment>')
      );
      expect(environment).toHaveLength(1);
      expect(environment[0]).toMatchObject({
        role: 'user',
        content: expect.stringContaining(`<cwd>${expectedWorkspace}</cwd>`)
      });
      expect(
        index < 2
          ? request.messages
              .filter((message) => message.contextualBlock?.authority !== 'instruction')
              .at(-2)
          : request.messages[0]
      ).toEqual(environment[0]);
      expect(request.system).not.toContain(expectedWorkspace);
    }
  });

  it('sends current AGENTS and environment as temporary user context before the request', async () => {
    const { home, workspace } = await fixture('mar-instructions-role-');
    await writeFile(join(workspace, 'AGENTS.md'), 'CURRENT_RULE');
    const adapter = new RecordingAdapter();
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [model]
      },
      () => adapter
    );
    let sessionId = '';

    try {
      const session = await agent.createSession({ workspace, title: 'Instructions' });
      sessionId = session.id;
      await session.run({ prompt: 'CURRENT_REQUEST' }).result();
    } finally {
      await agent.dispose();
    }

    expect(adapter.requests[0]?.system).not.toContain('CURRENT_RULE');
    expect(
      adapter.requests[0]?.messages.filter(
        (message) => message.contextualBlock?.authority !== 'instruction'
      )
    ).toEqual([
      expect.objectContaining({
        role: 'user',
        content: expect.stringContaining('CURRENT_RULE')
      }),
      expect.objectContaining({
        role: 'user',
        content: expect.stringContaining(`<cwd>${workspace}</cwd>`)
      }),
      expect.objectContaining({
        role: 'user',
        content: 'CURRENT_REQUEST',
        metadata: { source: 'user', recordId: expect.any(String) }
      })
    ]);
    const store = await JsonlSessionStore.open(home);
    const records = await store.read(sessionId);
    await store.close();
    expect(JSON.stringify(records)).not.toContain('CURRENT_RULE');
    expect(JSON.stringify(records)).not.toContain('<mar_environment>');
    expect(records.filter((record) => record.type === 'context.environment')).toHaveLength(1);
    expect(adapter.requests[0]?.system).not.toContain(workspace);
  });

  it('invalidates Responses continuation when the contextual AGENTS message changes', async () => {
    const { home, workspace } = await fixture('mar-instructions-responses-');
    await writeFile(join(workspace, 'AGENTS.md'), 'FIRST_RULE');
    const adapter = new ResponsesRecordingAdapter();
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [adapter.configuration]
      },
      () => adapter
    );

    try {
      const session = await agent.createSession({ workspace, title: 'Instructions' });
      await session.run({ prompt: 'first' }).result();
      await writeFile(join(workspace, 'AGENTS.md'), 'SECOND_RULE');
      await session.run({ prompt: 'second' }).result();
      await session.run({ prompt: 'third' }).result();
      await rm(join(workspace, 'AGENTS.md'));
      await session.run({ prompt: 'fourth' }).result();
      await session.run({ prompt: 'fifth' }).result();
    } finally {
      await agent.dispose();
    }

    expect(adapter.requests[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining('FIRST_RULE') }),
        expect.objectContaining({ content: expect.stringContaining('SECOND_RULE') }),
        expect.objectContaining({
          role: 'user',
          content: 'second',
          metadata: { source: 'user', recordId: expect.any(String) }
        })
      ])
    );
    expect(
      adapter.requests[3]?.messages.some((message) =>
        message.content.includes('previously provided AGENTS.md instructions no longer apply')
      )
    ).toBe(true);
  });

  it('does not inject dynamic resources or invalidation notices during ordinary executions', async () => {
    const { home, workspace } = await fixture('mar-resources-responses-');
    const adapter = new ResponsesRecordingAdapter();
    const host = new ChangingResourceHost({ homeDirectory: home, workspace });
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host,
        models: [adapter.configuration]
      },
      () => adapter
    );

    try {
      const session = await agent.createSession({ workspace, title: 'Resources' });
      await session.run({ prompt: 'first' }).result();
      host.resources = { processes: [], codeCells: [] };
      await session.run({ prompt: 'second' }).result();
      await session.run({ prompt: 'third' }).result();
    } finally {
      await agent.dispose();
    }

    expect(adapter.requests[1]?.system).toBe(adapter.requests[0]?.system);
    expect(adapter.requests[1]?.system).not.toContain('# Retained Session resources');
    expect(JSON.stringify(adapter.requests)).not.toContain('retained-process');
    expect(JSON.stringify(adapter.requests)).not.toContain('retained-cell');
    expect(JSON.stringify(adapter.requests)).not.toContain('Historical resource IDs');
    expect(host.reads).toBe(0);
  });

  it('keeps private contextual state out of manual Compact and reloads it afterward', async () => {
    const { home, workspace } = await fixture('mar-instructions-compact-');
    await writeFile(join(workspace, 'AGENTS.md'), 'RULE_MUST_NOT_ENTER_COMPACT');
    const adapter = new RecordingAdapter();
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host: new ChangingResourceHost({ homeDirectory: home, workspace }),
        models: [model]
      },
      () => adapter
    );

    let sessionId = '';
    try {
      const session = await agent.createSession({ workspace, title: 'Instructions' });
      sessionId = session.id;
      await session.run({ prompt: 'first' }).result();
      await session.compact().result();
      await session.run({ prompt: 'after compact' }).result();
    } finally {
      await agent.dispose();
    }

    const compactRequest = adapter.requests.find((request) => request.toolChoice === 'none');
    expect(compactRequest).toBeDefined();
    expect(compactRequest?.system).not.toContain('RULE_MUST_NOT_ENTER_COMPACT');
    expect(JSON.stringify(compactRequest?.messages)).not.toContain('RULE_MUST_NOT_ENTER_COMPACT');
    expect(JSON.stringify(compactRequest?.messages)).not.toContain('retained-process');
    const store = await JsonlSessionStore.open(home);
    const records = await store.read(sessionId);
    await store.close();
    expect(JSON.stringify(records)).not.toContain('RULE_MUST_NOT_ENTER_COMPACT');
    expect(JSON.stringify(records)).not.toContain('retained-process');
    expect(records.find((record) => record.type === 'compact.completed')?.payload.summary).toBe(
      'durable summary'
    );
    const postCompactRequest = adapter.requests.at(-1);
    expect(postCompactRequest?.toolChoice).not.toBe('none');
    expect(postCompactRequest?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining('durable summary') }),
        expect.objectContaining({
          content: expect.stringContaining('RULE_MUST_NOT_ENTER_COMPACT')
        }),
        expect.objectContaining({ content: expect.stringContaining('retained-process') }),
        expect.objectContaining({ content: 'after compact' })
      ])
    );
    expect(
      postCompactRequest?.messages.filter((message) =>
        message.content.includes('# Retained Session resources')
      )
    ).toHaveLength(1);
  });

  it('keeps one Compact resource snapshot across changes, expiry and restart without resync', async () => {
    const { home, workspace } = await fixture('mar-compact-resource-once-');
    const adapter = new RecordingAdapter();
    const host = new ChangingResourceHost({ homeDirectory: home, workspace });
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host,
        models: [model]
      },
      () => adapter
    );
    let sessionId = '';
    try {
      const session = await agent.createSession({ workspace, title: 'Resource baseline' });
      sessionId = session.id;
      await session.run({ prompt: 'seed' }).result();
      expect((await session.compact().result()).status).toBe('completed');
      expect(host.reads).toBe(1);
      host.resources = {
        processes: [{ processId: 'new-process', status: 'running', command: 'new', cwd: '/new' }]
      };
      await session.run({ prompt: 'after changes' }).result();
      host.resources = { processes: [] };
      await session.run({ prompt: 'after expiry' }).result();
      expect(host.reads).toBe(1);
      for (const request of adapter.requests.slice(2)) {
        expect(
          request.messages.filter((message) =>
            message.content.includes('# Retained Session resources')
          )
        ).toHaveLength(1);
        expect(JSON.stringify(request.messages)).toContain('retained-cell');
        expect(JSON.stringify(request.messages)).not.toContain('new-process');
        expect(JSON.stringify(request.messages)).not.toContain('resources no longer apply');
      }
    } finally {
      await agent.dispose();
    }
    const resumedHost = new ChangingResourceHost({ homeDirectory: home, workspace });
    const reopened = await createMarAgent(
      {
        mode: 'normal',
        host: resumedHost,
        models: [model]
      },
      () => adapter
    );
    try {
      const session = await reopened.openSession(sessionId);
      expect((await session.run({ prompt: 'restart' }).result()).status).toBe('completed');
      expect(resumedHost.reads).toBe(0);
      expect(
        adapter.requests
          .at(-1)!
          .messages.filter((message) => message.content.includes('# Retained Session resources'))
      ).toHaveLength(1);
    } finally {
      await reopened.dispose();
    }
  });

  it('does not add a resource snapshot for a failed Compact', async () => {
    const { home, workspace } = await fixture('mar-failed-compact-resource-');
    const host = new ChangingResourceHost({ homeDirectory: home, workspace });
    const requests: ModelRequest[] = [];
    const adapter: ModelAdapter = {
      configuration: model,
      async *start(request) {
        requests.push(request);
        if (request.toolChoice === 'none') throw new Error('generation failed');
        yield { type: 'text.completed', itemId: 'answer', text: 'done' };
        yield { type: 'completed', reason: 'completed' };
      }
    };
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host,
        models: [model]
      },
      () => adapter
    );
    try {
      const session = await agent.createSession({ workspace, title: 'Failed compact' });
      await session.run({ prompt: 'seed' }).result();
      expect((await session.compact().result()).status).toBe('failed');
      expect((await session.run({ prompt: 'resume' }).result()).status).toBe('completed');
      expect(host.reads).toBe(0);
      expect(JSON.stringify(requests)).not.toContain('# Retained Session resources');
    } finally {
      await agent.dispose();
    }
  });

  it.each(['manual', 'pre-turn', 'mid-turn'] as const)(
    'reinserts current rules before the real input after %s Compact and resume',
    async (mode) => {
      const { home, workspace } = await fixture('mar-compact-context-order-');
      await writeFile(join(workspace, 'AGENTS.md'), 'CURRENT_ORDER_RULE');
      await writeFile(join(workspace, 'evidence.txt'), 'verified evidence');
      const requests: ModelRequest[] = [];
      let first = true;
      const adapter: ModelAdapter = {
        configuration: model,
        async *start(request) {
          requests.push(request);
          if (request.toolChoice === 'none') {
            yield { type: 'text.completed', itemId: 'summary', text: 'durable ordered summary' };
          } else if (first && mode !== 'manual') {
            first = false;
            if (mode === 'mid-turn') {
              yield {
                type: 'client_tool.call',
                callId: 'evidence',
                name: 'read',
                arguments: { reads: [{ path: 'evidence.txt' }] }
              };
            } else yield { type: 'text.completed', itemId: 'answer', text: 'first answer' };
            yield {
              type: 'usage',
              usage: { inputTokens: 190_000, contextInputTokens: 190_000, outputTokens: 1 }
            };
            yield { type: 'completed', reason: mode === 'mid-turn' ? 'tool_use' : 'completed' };
            return;
          } else yield { type: 'text.completed', itemId: 'answer', text: 'done' };
          yield { type: 'completed', reason: 'completed' };
        }
      };
      const options = {
        mode: 'normal' as const,
        host: new ChangingResourceHost({ homeDirectory: home, workspace }),
        models: [model]
      };
      const agent = await createMarAgent(options, () => adapter);
      let sessionId = '';
      try {
        const session = await agent.createSession({ workspace, title: 'Ordered compact' });
        sessionId = session.id;
        expect((await session.run({ prompt: 'REAL_ORDER_INPUT' }).result()).status).toBe(
          'completed'
        );
        if (mode === 'manual') expect((await session.compact().result()).status).toBe('completed');
        if (mode !== 'mid-turn')
          expect((await session.run({ prompt: 'LATEST_ORDER_INPUT' }).result()).status).toBe(
            'completed'
          );
      } finally {
        await agent.dispose();
      }
      const resumed = requests.filter((request) => request.toolChoice !== 'none').at(-1)!;
      const ruleIndex = resumed.messages.findIndex((message) =>
        message.content.includes('CURRENT_ORDER_RULE')
      );
      const userIndex = resumed.messages.findLastIndex(
        (message) => message.metadata?.source === 'user'
      );
      expect(ruleIndex).toBeGreaterThanOrEqual(0);
      expect(ruleIndex).toBeLessThan(userIndex);
      expect(
        resumed.messages.filter((message) =>
          message.content.includes('# Retained Session resources')
        )
      ).toHaveLength(1);
      expect(JSON.stringify(resumed.messages)).toContain('retained-process');
      expect(JSON.stringify(resumed.messages)).toContain('retained-cell');
      expect(resumed.messages.filter((message) => message.contextKind === 'summary')).toHaveLength(
        1
      );
      expect(resumed.messages[userIndex]?.content).toBe(
        mode === 'mid-turn' ? 'REAL_ORDER_INPUT' : 'LATEST_ORDER_INPUT'
      );
      const reopenedAgent = await createMarAgent(
        { ...options, host: new LocalAgentHost({ homeDirectory: home, workspace }) },
        () => adapter
      );
      try {
        const reopened = await reopenedAgent.openSession(sessionId);
        expect((await reopened.run({ prompt: 'REOPENED_INPUT' }).result()).status).toBe(
          'completed'
        );
        const messages = requests.at(-1)!.messages;
        expect(
          messages.findIndex((message) => message.content.includes('CURRENT_ORDER_RULE'))
        ).toBeLessThan(messages.findIndex((message) => message.content === 'REOPENED_INPUT'));
        expect(
          messages.filter((message) => message.content.includes('CURRENT_ORDER_RULE'))
        ).toHaveLength(1);
      } finally {
        await reopenedAgent.dispose();
      }
    }
  );

  it('restores input provenance and model text without retaining injected contexts as user input', async () => {
    const { home, workspace } = await fixture('mar-compact-provenance-');
    const store = await JsonlSessionStore.open(home);
    try {
      const session = await store.createSession({ workspace, title: 'Provenance' });
      const user = await store.append(session.id, {
        type: 'turn.user',
        payload: {
          prompt: 'display input',
          modelText: 'MODEL_INPUT',
          context: ['ATTACHED_CONTEXT']
        }
      });
      const extension = await store.append(session.id, {
        type: 'extension.input',
        payload: { prompt: 'EXTENSION_INPUT', source: { extensionId: 'fixture' } }
      });
      await store.append(session.id, {
        type: 'input.context',
        payload: { modelContext: ['INJECTED_CONTEXT'] }
      });
      await store.append(session.id, {
        type: 'model.context',
        payload: { role: 'user', content: 'APPENDED_NOTE' }
      });
      const restored = await restoreMessages(store, session.id, await store.read(session.id), {
        includeImages: false
      });
      expect(restored.userMessages).toEqual([
        { content: 'MODEL_INPUT', metadata: { source: 'user', recordId: user.recordId } },
        {
          content: 'EXTENSION_INPUT',
          metadata: { source: 'extension', recordId: extension.recordId, extensionId: 'fixture' }
        }
      ]);
      expect(
        restored.messages
          .filter((message) => message.contextKind === 'contextual')
          .map((message) => message.content)
      ).toEqual(['ATTACHED_CONTEXT', 'INJECTED_CONTEXT', 'APPENDED_NOTE']);
      const history = buildCompactedHistory('source summary', restored.userMessages, 20_000);
      expect(history.map((message) => message.kind)).toEqual([
        'user_input',
        'extension_input',
        'summary'
      ]);
      await store.compact(session.id, { summary: 'source summary', replacementHistory: history });
      const resumed = await restoreMessages(
        store,
        session.id,
        (await store.readExecutionState(session.id)).contextRecords,
        { includeImages: false }
      );
      expect(resumed.userMessages).toEqual(restored.userMessages);
      expect(
        resumed.messages.filter((message) => message.metadata?.recordId === user.recordId)
      ).toHaveLength(1);
      expect(resumed.messages.some((message) => message.content === 'display input')).toBe(false);
    } finally {
      await store.close();
    }
  });

  it.each([
    ['replaces', 'CURRENT_RULE', 'replace all previously provided AGENTS.md instructions'],
    ['removes', undefined, 'previously provided AGENTS.md instructions no longer apply']
  ])('%s stale compacted AGENTS before the current request', async (_name, rule, notice) => {
    const { home, workspace } = await fixture('mar-instructions-resume-');
    if (rule) await writeFile(join(workspace, 'AGENTS.md'), rule);
    const store = await JsonlSessionStore.open(home);
    const stored = await store.createSession({ workspace, title: 'Instructions' });
    await store.compact(stored.id, { summary: 'OLD_RULE_FROM_COMPACT' });
    await store.close();
    const adapter = new RecordingAdapter();
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [model]
      },
      () => adapter
    );

    try {
      const session = await agent.openSession(stored.id);
      await session.run({ prompt: 'CURRENT_REQUEST' }).result();
    } finally {
      await agent.dispose();
    }

    const contents = adapter.requests[0]!.messages.map((message) => message.content);
    expect(contents[0]?.toLowerCase()).toContain(notice.toLowerCase());
    if (rule) expect(contents[0]).toContain(rule);
    expect(contents[1]).toContain('OLD_RULE_FROM_COMPACT');
    expect(contents[2]).toContain(`<cwd>${workspace}</cwd>`);
    expect(contents[3]).toBe('CURRENT_REQUEST');
  });

  it('does not append an invalidation notice for resources in a legacy Compact summary', async () => {
    const { home, workspace } = await fixture('mar-resources-compact-resume-');
    const store = await JsonlSessionStore.open(home);
    const stored = await store.createSession({ workspace, title: 'Resources' });
    await store.compact(stored.id, {
      summary: '# Retained Session resources\n- processId: stale-process; status: running'
    });
    await store.close();
    const adapter = new RecordingAdapter();
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [model]
      },
      () => adapter
    );

    try {
      const session = await agent.openSession(stored.id);
      await session.run({ prompt: 'CURRENT_REQUEST' }).result();
    } finally {
      await agent.dispose();
    }

    const contents = adapter.requests[0]!.messages.map((message) => message.content);
    expect(contents.some((content) => content.includes('stale-process'))).toBe(true);
    expect(contents.join('\n')).not.toContain(
      'The previously provided retained Session resources no longer apply.'
    );
    expect(
      adapter.requests[0]?.messages.findLast(
        (message) => message.role === 'user' && message.contextKind === undefined
      )?.content
    ).toBe('CURRENT_REQUEST');
  });
});
