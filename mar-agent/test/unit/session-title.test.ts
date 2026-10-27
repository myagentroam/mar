import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentWithAdapter as createMarAgent } from '../../src/sdk/agent.js';
import { LocalAgentHost } from '../../src/host.js';
import { SecretValue, openAgentSessionCatalog } from '../../src/index.js';
import { JsonlSessionStore } from '../../src/session/store/index.js';
import { activeSessionDirectory } from '../support/jsonl-session-path.js';
import type { Agent, AgentModelConfiguration } from '../../src/index.js';

const homes: string[] = [];
const agents: Agent[] = [];
afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.dispose()));
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'mar-session-title-'));
  homes.push(home);
  const workspace = join(home, 'workspace');
  await mkdir(workspace);
  const model: AgentModelConfiguration = {
    id: 'model',
    name: 'Model',
    protocol: 'OPENAI_RESPONSES',
    baseUrl: 'https://example.test/v1',
    apiKey: new SecretValue('test-key'),
    modelId: 'model',
    contextWindowTokens: 100_000,
    maxOutputTokens: 4096,
    reasoningEfforts: ['low'],
    defaultReasoningEffort: 'low',
    inputCapabilities: ['TEXT'],
    outputCapabilities: ['TEXT'],
    hostedWebSearch: false,
    enabled: true
  };
  const agent = await createMarAgent(
    {
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model]
    },
    () => ({
      configuration: model,
      async *start() {
        yield { type: 'text.completed' as const, itemId: 'answer', text: 'Done' };
        yield { type: 'completed' as const, reason: 'completed' as const };
      }
    })
  );
  agents.push(agent);
  return { home, workspace, agent, session: await agent.createSession({ workspace }) };
}

describe('SDK session title metadata', () => {
  it('indexes the first real non-empty user message for discovery without changing the native title', async () => {
    const { agent, session, home } = await fixture();
    const store = await JsonlSessionStore.open(home);
    try {
      for (const [inputSource, prompt] of [
        ['parent_agent', 'Internal instructions'],
        ['user', '   '],
        ['user', '  去看升国旗吧\n需要五星红旗元素  '],
        ['user', 'Later message']
      ] as const) {
        await store.append(session.id, {
          type: 'turn.user',
          executionId: 'execution',
          turnId: 'turn',
          payload: { inputSource, prompt }
        });
      }
      expect((await store.list()).sessions[0]).toMatchObject({
        title: 'New session',
        firstUserMessagePreview: '去看升国旗吧 需要五星红旗元素'
      });
      await expect(agent.getSession(session.id)).resolves.toMatchObject({ title: 'New session' });
    } finally {
      await store.close();
      await agent.dispose();
    }
    const catalog = await openAgentSessionCatalog({ homeDirectory: home });
    try {
      expect((await catalog.list()).sessions[0]?.firstUserMessagePreview).toBe(
        '去看升国旗吧 需要五星红旗元素'
      );
      await catalog.clear(session.id);
      expect((await catalog.list()).sessions[0]?.firstUserMessagePreview).toBeUndefined();
    } finally {
      await catalog.close();
    }
  });

  it('backfills legacy previews once and bounds them without changing the JSONL', async () => {
    const { agent, session, home } = await fixture();
    await session.run({ prompt: 'First '.repeat(100) }).result();
    await agent.dispose();
    const indexPath = join(home, '.mar', 'agent', 'sessions', 'index.json');
    const index = JSON.parse(await readFile(indexPath, 'utf8'));
    for (const meta of index.sessions) {
      delete meta.resume.firstUserMessageIndexed;
      delete meta.resume.firstUserMessagePreview;
    }
    await writeFile(indexPath, JSON.stringify(index));
    const transcriptPath = join(
      await activeSessionDirectory(home, session.id),
      'events-000001.jsonl'
    );
    const originalTranscript = await readFile(transcriptPath, 'utf8');
    const catalog = await openAgentSessionCatalog({ homeDirectory: home });
    try {
      await expect(catalog.firstUserMessagePreview(session.id)).resolves.toBe(
        'First '.repeat(100).trim().slice(0, 160)
      );
      const summary = (await catalog.list()).sessions[0]!;
      expect(summary.firstUserMessagePreview).toBe('First '.repeat(100).trim().slice(0, 160));
      expect(summary.title).toBe('New session');
      const emptyCache = JSON.parse(await readFile(indexPath, 'utf8'));
      emptyCache.sessions[0].resume.firstUserMessageIndexed = true;
      delete emptyCache.sessions[0].resume.firstUserMessagePreview;
      await writeFile(indexPath, JSON.stringify(emptyCache));
      expect((await catalog.list()).sessions[0]).toEqual(summary);
    } finally {
      await catalog.close();
    }
    expect(await readFile(transcriptPath, 'utf8')).toBe(originalTranscript);
    const rebuilt = JSON.parse(await readFile(indexPath, 'utf8')).sessions[0].resume;
    expect(rebuilt.firstUserMessageIndexed).toBe(true);
    expect(rebuilt.firstUserMessagePreview).toHaveLength(160);
  });

  it('keeps 200-session list cursors valid while another Catalog backfills and flushes legacy previews', async () => {
    const { agent, session, home, workspace } = await fixture();
    await session.run({ prompt: 'First session input' }).result();
    const second = await agent.createSession({ workspace });
    await second.run({ prompt: 'Second session input' }).result();
    const seeder = await JsonlSessionStore.open(home);
    try {
      for (let index = 0; index < 199; index++)
        await seeder.createSession({ workspace, title: `Native title ${index}` });
    } finally {
      await seeder.close();
    }
    await agent.dispose();
    const indexPath = join(home, '.mar', 'agent', 'sessions', 'index.json');
    const index = JSON.parse(await readFile(indexPath, 'utf8'));
    for (const meta of index.sessions) {
      delete meta.resume.firstUserMessageIndexed;
      delete meta.resume.firstUserMessagePreview;
    }
    await writeFile(indexPath, JSON.stringify(index));
    const reader = await openAgentSessionCatalog({ homeDirectory: home });
    const backfiller = await openAgentSessionCatalog({ homeDirectory: home });
    try {
      const firstPage = await reader.list({ limit: 200 });
      expect(firstPage.nextCursor).toBeDefined();
      expect(firstPage.sessions).toHaveLength(200);
      expect(
        firstPage.sessions.find((item) => item.id === second.id)?.firstUserMessagePreview
      ).toBeUndefined();
      await expect(backfiller.firstUserMessagePreview(second.id)).resolves.toBe(
        'Second session input'
      );
      const flusher = await JsonlSessionStore.open(home);
      try {
        const release = await flusher.acquireSessionLease(second.id);
        await release();
      } finally {
        await flusher.close();
      }
      const nextPage = await reader.list({ limit: 200, cursor: firstPage.nextCursor });
      expect(nextPage.sessions).toHaveLength(1);
      expect(nextPage.sessions[0]?.id).toBe(session.id);
      expect(nextPage.nextCursor).toBeUndefined();
    } finally {
      await Promise.all([reader.close(), backfiller.close()]);
    }
  });

  it('does not overwrite a different process writer when flushing a legacy preview cache', async () => {
    const { agent, session, home } = await fixture();
    await agent.dispose();
    const indexPath = join(home, '.mar', 'agent', 'sessions', 'index.json');
    const index = JSON.parse(await readFile(indexPath, 'utf8'));
    delete index.sessions[0].resume.firstUserMessageIndexed;
    delete index.sessions[0].resume.firstUserMessagePreview;
    await writeFile(indexPath, JSON.stringify(index));
    const catalog = await openAgentSessionCatalog({ homeDirectory: home });
    let writtenIndex: unknown;
    try {
      await expect(catalog.firstUserMessagePreview(session.id)).resolves.toBeUndefined();
      const moduleUrl = new URL('../../src/session/store/index.ts', import.meta.url).href;
      const child = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          `import { JsonlSessionStore } from ${JSON.stringify(moduleUrl)};
         const store = await JsonlSessionStore.open(process.argv[1]);
         const release = await store.acquireSessionLease(process.argv[2]);
         try {
           await store.append(process.argv[2], {
             type: 'turn.user', executionId: 'child', turnId: 'child',
             payload: { prompt: 'First input from another process' }
           });
         } finally { await release(); await store.close(); }`,
          home,
          session.id
        ],
        { encoding: 'utf8', timeout: 10_000 }
      );
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      writtenIndex = JSON.parse(await readFile(indexPath, 'utf8'));
    } finally {
      await catalog.close();
    }
    expect(JSON.parse(await readFile(indexPath, 'utf8'))).toEqual(writtenIndex);
  });

  it('rebuilds previews from retained fork and rollback records and accepts new input after clear', async () => {
    const { session, home } = await fixture();
    const execution = session.run({ prompt: 'First user input' });
    await execution.result();
    const catalog = await openAgentSessionCatalog({ homeDirectory: home });
    try {
      const history = await catalog.history(session.id);
      const turn = history.entries.find((entry) => entry.kind === 'user');
      if (!turn || turn.kind !== 'user') throw new Error('Expected user history');
      const branch = await catalog.fork(session.id, {
        boundaryTurnId: turn.turnId,
        title: 'Branch'
      });
      await expect(catalog.firstUserMessagePreview(branch.id)).resolves.toBe('First user input');
      await catalog.rollback(session.id, { boundaryTurnId: null });
      await expect(catalog.firstUserMessagePreview(session.id)).resolves.toBeUndefined();
      await session.run({ prompt: 'New first input' }).result();
      await expect(catalog.firstUserMessagePreview(session.id)).resolves.toBe('New first input');
      await catalog.clear(session.id);
      await session.run({ prompt: 'Input after clear' }).result();
      await expect(catalog.firstUserMessagePreview(session.id)).resolves.toBe('Input after clear');
    } finally {
      await catalog.close();
    }
  });

  it('exposes first-input state without generating titles, including Plan and Compact', async () => {
    const { agent, session } = await fixture();
    await expect(agent.getSession(session.id)).resolves.toMatchObject({
      automaticTitlePending: true
    });
    await session.compact().result();
    await expect(agent.getSession(session.id)).resolves.toMatchObject({
      automaticTitlePending: true
    });
    await session.plan({ prompt: 'Inspect project' }).result();
    await expect(agent.getSession(session.id)).resolves.toMatchObject({
      title: 'New session',
      automaticTitlePending: false
    });
  });

  it('persists a caller-generated title and its source through reopen and clear', async () => {
    const { agent, session, home } = await fixture();
    const execution = session.run({ prompt: 'Inspect project' });
    await execution.result();
    await expect(
      agent.setSessionTitle(session.id, 'Project inspection', {
        automatic: true,
        expectedTitle: 'New session',
        executionId: execution.executionId
      })
    ).resolves.toBe(true);
    await agent.dispose();
    const store = await JsonlSessionStore.open(home);
    try {
      await expect(store.getSession(session.id)).resolves.toMatchObject({
        title: 'Project inspection',
        automaticTitlePending: false
      });
      expect(
        (await store.read(session.id)).findLast((record) => record.type === 'session.title.updated')
      ).toMatchObject({ payload: { title: 'Project inspection', automatic: true } });
      await store.clearSession(session.id);
      await expect(store.getSession(session.id)).resolves.toMatchObject({
        title: 'Project inspection',
        automaticTitlePending: false
      });
    } finally {
      await store.close();
    }
  });

  it('rejects stale expected titles and protects even an unchanged manual title', async () => {
    const { agent, session } = await fixture();
    const execution = session.run({ prompt: 'Inspect project' });
    await execution.result();
    await expect(
      agent.setSessionTitle(session.id, 'Stale', { expectedTitle: 'Different' })
    ).resolves.toBe(false);
    await agent.setSessionTitle(session.id, 'New session');
    await expect(
      agent.setSessionTitle(session.id, 'Automatic', {
        automatic: true,
        expectedTitle: 'New session',
        executionId: execution.executionId
      })
    ).resolves.toBe(false);
    await expect(agent.getSession(session.id)).resolves.toMatchObject({
      title: 'New session',
      automaticTitlePending: false
    });
  });

  it('rejects results from a rolled-back Execution and keeps forks explicitly named', async () => {
    const { agent, session, home } = await fixture();
    const execution = session.run({ prompt: 'Inspect project' });
    await execution.result();
    const catalog = await openAgentSessionCatalog({ homeDirectory: home });
    try {
      const branch = await catalog.fork(session.id, { boundaryTurnId: null, title: 'Branch' });
      await expect(agent.getSession(branch.id)).resolves.toMatchObject({
        title: 'Branch',
        automaticTitlePending: false
      });
      await catalog.rollback(session.id, { boundaryTurnId: null });
      await expect(
        agent.setSessionTitle(session.id, 'Late result', {
          automatic: true,
          expectedTitle: 'New session',
          executionId: execution.executionId
        })
      ).resolves.toBe(false);
    } finally {
      await catalog.close();
    }
  });

  it('rejects empty titles, deleted sessions and conflicting writers', async () => {
    const { agent, session, home } = await fixture();
    await expect(agent.setSessionTitle(session.id, ' ')).rejects.toMatchObject({
      code: 'MAR_AGENT_TOOL_INPUT_INVALID'
    });
    const store = await JsonlSessionStore.open(home);
    const release = await store.acquireSessionLease(session.id);
    try {
      await expect(agent.setSessionTitle(session.id, 'Busy')).rejects.toMatchObject({
        code: 'MAR_AGENT_SESSION_LOCKED'
      });
    } finally {
      await release();
      await store.close();
    }
    await agent.deleteSession(session.id);
    await expect(agent.setSessionTitle(session.id, 'Deleted')).rejects.toMatchObject({
      code: 'MAR_AGENT_SESSION_NOT_FOUND'
    });
  });

  it('does not overwrite an explicit creation title with an automatic result', async () => {
    const { agent, workspace } = await fixture();
    const session = await agent.createSession({ workspace, title: 'Named session' });
    const execution = session.run({ prompt: 'Inspect project' });
    await execution.result();
    await expect(
      agent.setSessionTitle(session.id, 'Automatic', {
        automatic: true,
        expectedTitle: 'Named session',
        executionId: execution.executionId
      })
    ).resolves.toBe(false);
    await expect(agent.getSession(session.id)).resolves.toMatchObject({
      title: 'Named session',
      automaticTitlePending: false
    });
  });
});
