import { createServer } from 'node:http';
import { access, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createAgent,
  openAgentSessionCatalog,
  SecretValue,
  type AgentModelConfiguration,
  type Agent
} from '../../src/index.js';
import { LocalAgentHost } from '../../src/host.js';
import { type SessionStore, type SessionStoreMaintenance } from '../../src/session-store.js';
import { createAgentWithAdapter } from '../../src/sdk/agent.js';
import { JsonlSessionStore } from '../../src/session/store/jsonl/jsonl-store.js';
import { textSessionStore } from '../support/text-session-store.js';

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'mar-store-injection-'));
  homes.push(home);
  const workspace = join(home, 'workspace');
  await mkdir(workspace);
  return {
    home,
    workspace,
    host: () => {
      const host = new LocalAgentHost({ homeDirectory: home, workspace });
      const describe = host.describe.bind(host);
      host.describe = async () => ({
        ...(await describe()),
        capabilities: [
          'workspace.read',
          'workspace.patch',
          'process.manage',
          'user-input.request',
          'event.publish'
        ]
      });
      return host;
    }
  };
}
const model: AgentModelConfiguration = {
  id: 'test',
  name: 'Test',
  protocol: 'OPENAI_RESPONSES',
  baseUrl: 'https://example.test',
  apiKey: new SecretValue('test'),
  modelId: 'test',
  contextWindowTokens: 10000,
  maxOutputTokens: 1000,
  inputCapabilities: ['TEXT'],
  outputCapabilities: ['TEXT'],
  reasoningEfforts: [],
  hostedWebSearch: false,
  titleGeneration: false,
  codeMode: false,
  enabled: true,
  responsesTransport: { transport: 'HTTP', httpVersion: '1.1' }
};

it('creates ordinary child sessions through the public API', async () => {
  const { workspace, host } = await fixture();
  const agent = await createAgent({ mode: 'normal', host: host(), models: [model] });
  try {
    const root = await agent.createSession({ workspace });
    const child = await agent.createSession({ workspace, parentSessionId: root.id });
    expect((await agent.listSessions({ parentSessionId: root.id })).sessions).toMatchObject([
      { id: child.id, source: { type: 'user', parentSessionId: root.id } }
    ]);
  } finally {
    await agent.dispose();
  }
});

it('runs and restores through an injected Store without a Host storage capability', async () => {
  const { home, workspace, host } = await fixture();
  const backend = textSessionStore();
  const requests: unknown[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      requests.push(JSON.parse(body));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(
        [
          { type: 'response.created', response: { id: `r-${requests.length}` } },
          {
            type: 'response.output_text.done',
            item_id: `m-${requests.length}`,
            phase: 'final_answer',
            text: 'Stored answer'
          },
          {
            type: 'response.completed',
            response: { usage: { input_tokens: 10, output_tokens: 2 } }
          }
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join('')
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const models = [{ ...model, baseUrl: `http://127.0.0.1:${port}` }];
  const agents: Agent[] = [];
  const catalog = await openAgentSessionCatalog({ sessionStore: backend.store });
  try {
    const first = await createAgent({
      mode: 'normal',
      host: host(),
      models,
      sessionStore: backend.store
    });
    agents.push(first);
    const session = await first.createSession({ workspace, title: 'Injected text' });
    expect(await session.run({ prompt: 'unique-first-input' }).result()).toMatchObject({
      status: 'completed',
      finalAnswer: 'Stored answer'
    });
    await first.dispose();
    expect(backend.writers.size).toBe(0);
    expect(backend.closeCount()).toBe(0);
    await expect(first.createSession({ workspace })).rejects.toMatchObject({
      code: 'MAR_AGENT_DISPOSED'
    });
    await expect(first.listSessions()).rejects.toMatchObject({ code: 'MAR_AGENT_DISPOSED' });
    await expect(first.getSession(session.id)).rejects.toMatchObject({
      code: 'MAR_AGENT_DISPOSED'
    });
    await expect(first.setSessionTitle(session.id, 'late')).rejects.toMatchObject({
      code: 'MAR_AGENT_DISPOSED'
    });
    await expect(first.openSession(session.id)).rejects.toMatchObject({
      code: 'MAR_AGENT_DISPOSED'
    });
    expect(() => session.run({ prompt: 'late' })).toThrow('MAR_AGENT_DISPOSED');
    expect(backend.sessions.size).toBe(1);
    expect((await catalog.list()).sessions.map((item) => item.id)).toEqual([session.id]);
    expect((await catalog.history(session.id)).entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'user', text: 'unique-first-input' })
      ])
    );
    const second = await createAgent({
      mode: 'normal',
      host: host(),
      models,
      sessionStore: backend.store
    });
    agents.push(second);
    expect(
      (await (await second.openSession(session.id)).run({ prompt: 'next' }).result()).status
    ).toBe('completed');
    expect(JSON.stringify(requests[1])).toContain('unique-first-input');
    expect(JSON.stringify(requests[1])).toContain('Stored answer');
    await expect(access(join(home, '.mar', 'agent', 'sessions'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
    const closure = catalog.close();
    expect(catalog.close()).toBe(closure);
    await closure;
    await expect(catalog.history(session.id)).rejects.toMatchObject({ code: 'MAR_AGENT_DISPOSED' });
    expect((await second.listSessions()).sessions).toHaveLength(1);
    expect(backend.closeCount()).toBe(0);
  } finally {
    await Promise.all(agents.map((agent) => agent.dispose()));
    await catalog.close();
    await backend.store.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

it('isolates Agent writer owners on a borrowed Store and releases leases without closing it', async () => {
  const { home, workspace, host } = await fixture();
  const store = await JsonlSessionStore.open(home);
  const close = vi.spyOn(store, 'close');
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const agents: Agent[] = [];
  for (let index = 0; index < 2; index++)
    agents.push(
      await createAgentWithAdapter(
        {
          mode: 'normal',
          host: host(),
          models: [model],
          sessionStore: store
        },
        (configuration) => ({
          configuration,
          async *start() {
            if (index === 0) {
              entered.resolve();
              await release.promise;
            }
            yield { type: 'text.completed', itemId: 'answer', text: 'done' };
            yield { type: 'completed', reason: 'completed' };
          }
        })
      )
    );
  const [first, second] = agents as [Agent, Agent];
  try {
    const session = await first.createSession({ workspace, title: 'Writer ownership' });
    const other = await second.openSession(session.id);
    const running = session.run({ prompt: 'hold writer' }).result();
    await entered.promise;
    const before = await store.read(session.id);
    expect(await other.run({ prompt: 'not admitted' }).result()).toMatchObject({
      status: 'failed',
      errorCode: 'MAR_AGENT_SESSION_LOCKED'
    });
    expect(await store.read(session.id)).toEqual(before);
    release.resolve();
    await running;
    await first.dispose();
    expect(close).not.toHaveBeenCalled();
    expect((await other.run({ prompt: 'new writer' }).result()).status).toBe('completed');
    const catalog = await openAgentSessionCatalog({ sessionStore: store });
    try {
      const png =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
      const lease = await store.acquireSessionLease(session.id, {});
      let sequence = 0;
      try {
        const images = await store.persistInputImages(session.id, [
          { name: 'pixel.png', mimeType: 'image/png', dataBase64: png }
        ]);
        sequence = (
          await store.append(session.id, {
            type: 'turn.user',
            executionId: 'image',
            turnId: 'image',
            payload: { prompt: 'image', images }
          })
        ).sequence;
      } finally {
        await lease();
      }
      expect(await catalog.readImage(session.id, { sequence, imageIndex: 0 })).toMatchObject({
        dataBase64: png
      });
    } finally {
      await catalog.close();
    }
    await second.dispose();
    const lease = await store.acquireSessionLease(session.id, {});
    await lease();
    expect(close).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await Promise.all(agents.map((agent) => agent.dispose()));
    await store.close();
  }
});

it.each(['clearSession', 'deleteSession'] as const)(
  'preserves %s error priority when an injected maintenance release throws synchronously',
  async (action) => {
    for (const cleanupFails of [false, true]) {
      const { workspace, host } = await fixture();
      const backend = textSessionStore();
      const agentHost = host();
      const primary = new Error('Host cleanup failed');
      const releaseFailure = new Error('Synchronous release failed');
      const releases: Promise<void>[] = [];
      let original!: SessionStoreMaintenance;
      const acquire = backend.store.acquireSessionMaintenance.bind(backend.store);
      const clear = backend.store.clearSession.bind(backend.store);
      const remove = backend.store.delete.bind(backend.store);
      const admission = vi
        .spyOn(backend.store, 'acquireSessionMaintenance')
        .mockImplementationOnce(async (...args) => {
          original = await acquire(...args);
          return {
            sessionIds: original.sessionIds,
            release() {
              releases.push(original.release());
              throw releaseFailure;
            }
          };
        });
      const clearing = vi
        .spyOn(backend.store, 'clearSession')
        .mockImplementation((id) => clear(id, original));
      const deleting = vi
        .spyOn(backend.store, 'delete')
        .mockImplementation((id) => remove(id, original));
      const hostCleanup = vi.spyOn(agentHost, 'disposeSessionResources');
      if (cleanupFails) hostCleanup.mockRejectedValueOnce(primary);
      const agent = await createAgentWithAdapter({
        mode: 'normal',
        host: agentHost,
        models: [model],
        sessionStore: backend.store
      });
      try {
        const session = await agent.createSession({ workspace });
        await expect(agent[action](session.id)).rejects.toBe(
          cleanupFails ? primary : releaseFailure
        );
        expect(action === 'clearSession' ? clearing : deleting).toHaveBeenCalledTimes(1);
        await Promise.all(releases);
        if (action === 'clearSession') {
          const release = await backend.store.acquireSessionLease(session.id, {});
          await release();
        } else
          await expect(backend.store.getSession(session.id)).rejects.toMatchObject({
            code: 'MAR_AGENT_SESSION_NOT_FOUND'
          });
      } finally {
        await Promise.all(releases);
        await agent.dispose();
        expect(backend.closeCount()).toBe(0);
        await backend.store.close();
        admission.mockRestore();
        clearing.mockRestore();
        deleting.mockRestore();
        hostCleanup.mockRestore();
      }
    }
  }
);

it('rejects ambiguous Catalog sources and never takes ownership on failed Host negotiation', async () => {
  const backend = textSessionStore();
  const { host } = await fixture();
  for (const input of [{}, { homeDirectory: '/unused', sessionStore: backend.store }]) {
    await expect(openAgentSessionCatalog(input as never)).rejects.toMatchObject({
      code: 'MAR_AGENT_SESSION_STORE_INVALID'
    });
  }
  await expect(
    createAgent({ mode: 'node', host: host(), models: [model], sessionStore: backend.store })
  ).rejects.toMatchObject({ code: 'MAR_AGENT_HOST_INCOMPATIBLE' });
  expect(backend.closeCount()).toBe(0);
});

it.each(['agent', 'catalog'] as const)(
  'rejects a null Store without opening default storage through the %s entry',
  async (entry) => {
    const { host } = await fixture();
    const open = vi
      .spyOn(JsonlSessionStore, 'open')
      .mockRejectedValue(new Error('Default storage must not be opened.'));
    // JavaScript callers can pass null despite the TypeScript option excluding it.
    const sessionStore = null as unknown as SessionStore;
    try {
      const result =
        entry === 'agent'
          ? createAgent({ mode: 'normal', host: host(), models: [model], sessionStore })
          : openAgentSessionCatalog({ sessionStore });
      await expect(result).rejects.toMatchObject({ code: 'MAR_AGENT_SESSION_STORE_INVALID' });
      expect(open).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
    }
  }
);

it('closes each default JSONL handle once and rejects every closed Catalog operation', async () => {
  const { home, workspace, host } = await fixture();
  const close = vi.spyOn(JsonlSessionStore.prototype, 'close');
  const agent = await createAgent({ mode: 'normal', host: host(), models: [model] });
  const catalog = await openAgentSessionCatalog({ homeDirectory: home });
  try {
    const session = await agent.createSession({ workspace, title: 'Default ownership' });
    await agent.dispose();
    expect(close).toHaveBeenCalledTimes(1);
    expect((await catalog.list()).sessions).toHaveLength(1);
    await catalog.close();
    await catalog.close();
    expect(close).toHaveBeenCalledTimes(2);
    const operations = [
      () => catalog.list(),
      () => catalog.firstUserMessagePreview(session.id),
      () => catalog.executionConfiguration(session.id),
      () => catalog.history(session.id),
      () => catalog.readImage(session.id, { sequence: 1, imageIndex: 0 }),
      () => catalog.readToolResultResource(session.id, { resourceRef: 'unused' }),
      () => catalog.contextUsage(session.id),
      () => catalog.fork(session.id, { boundaryTurnId: null, title: 'late' }),
      () => catalog.rollback(session.id, { boundaryTurnId: null }),
      () => catalog.clear(session.id),
      () => catalog.delete(session.id)
    ];
    for (const operation of operations)
      await expect(operation()).rejects.toMatchObject({ code: 'MAR_AGENT_DISPOSED' });
  } finally {
    await agent.dispose();
    await catalog.close();
    close.mockRestore();
  }
});
