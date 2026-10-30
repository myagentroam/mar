import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { NodeConnector } from '../../mar-node/src/connector.js';
import { NodeDatabase } from '../../mar-node/src/database.js';
import { unavailableCapabilities } from '../../mar-node/src/capabilities.js';
import { FakeRunner } from '../../mar-node/src/fake-runner.js';
import { MarAgentConversationNormalizer } from '../../mar-node/src/runner/mar-agent/conversation-normalizer.js';
import type { RunnerRegistry } from '../../mar-node/src/runner/runner-registry.js';
import type { NodeRuntimeState } from '../../mar-node/src/runtime-state.js';
import type { AgentNetworkService } from '../../mar-node/src/service/agent-network-service.js';
import type { AgentNetworkObservations } from '../../mar-node/src/service/agent-network-observations.js';
import type { RunEventService } from '../../mar-node/src/service/run-event-service.js';
import { INITIAL_ADMIN_PASSWORD } from '../../packages/server-core/src/password.js';

test('opens a mapped child and carries user intervention back to its parent observation', async ({
  page,
  baseURL
}) => {
  const root = await mkdtemp(join(tmpdir(), 'mar-child-intervention-'));
  const workspacePath = join(root, 'project');
  const home = join(root, 'home');
  await Promise.all([mkdir(workspacePath), mkdir(home)]);
  const previousHome = process.env['HOME'];
  const previousCodexHome = process.env['CODEX_HOME'];
  process.env['HOME'] = home;
  process.env['CODEX_HOME'] = join(home, '.codex');
  const database = new NodeDatabase(':memory:', 'child-intervention');
  database.saveRunnerDefaults({
    runner: 'codex',
    model: 'gpt-5.3-codex',
    effort: 'medium',
    access: 'auto'
  });
  let connector: NodeConnector | undefined;
  let csrfToken: string | undefined;
  let passwordChanged = false;
  try {
    const login = await page.request.post('/api/auth/login', {
      data: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
    });
    expect(login.status()).toBe(200);
    const initial = (await login.json()) as { csrfToken: string };
    const changed = await page.request.post('/api/auth/change-password', {
      headers: { origin: baseURL!, 'x-csrf-token': initial.csrfToken },
      data: { currentPassword: INITIAL_ADMIN_PASSWORD, password: 'ChildIntervention123!' }
    });
    expect(changed.status()).toBe(200);
    passwordChanged = true;
    csrfToken = ((await changed.json()) as { csrfToken: string }).csrfToken;
    const cookie = changed.headers()['set-cookie']!.split(';')[0]!;
    await page.context().addCookies([
      {
        name: cookie.slice(0, cookie.indexOf('=')),
        value: decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1)),
        url: baseURL!,
        httpOnly: true,
        sameSite: 'Lax',
        secure: false
      }
    ]);
    const headers = { origin: baseURL!, 'x-csrf-token': csrfToken };
    const token = await page.request.post('/api/node-registration-tokens', {
      headers,
      data: { displayName: 'Child intervention fixture' }
    });
    expect(token.status()).toBe(200);
    const serverURL = new URL(baseURL!);
    serverURL.port = process.env['MAR_E2E_SERVER_PORT'] ?? String(Number(serverURL.port) + 1);
    connector = new NodeConnector({
      configPath: join(root, 'node.json'),
      config: {
        serverUrl: serverURL.origin,
        allowedRoots: [root],
        dataDirectory: join(root, 'data'),
        registrationToken: ((await token.json()) as { token: string }).token
      },
      capabilities: { ...unavailableCapabilities(), codex: { available: true } },
      fakeRunner: new FakeRunner(),
      fakeScript: () => [{ type: 'long-running' }],
      reconnect: false,
      database
    });
    const core = connector as unknown as {
      runtime: NodeRuntimeState;
      runners: RunnerRegistry;
      agentNetworkService: AgentNetworkService;
      agentNetworkObservations: AgentNetworkObservations;
      runEventService: RunEventService;
      sessionMessageService: {
        operations(): Record<string, (input: Record<string, unknown>) => Promise<unknown>>;
      };
    };
    for (const runner of core.runners.advertised()) {
      runner.refreshProfile = async () => undefined;
      runner.discoverSessions = async () => [];
    }
    await connector.start();
    let nodeId = '';
    await expect
      .poll(async () => {
        const response = await page.request.get('/api/nodes');
        const result = (await response.json()) as {
          nodes: { id: string; connected: boolean; displayName: string }[];
        };
        nodeId =
          result.nodes.find(
            (node) => node.connected && node.displayName === 'Child intervention fixture'
          )?.id ?? '';
        return nodeId;
      })
      .not.toBe('');
    const created = await page.request.post('/api/workspaces', {
      headers,
      data: { nodeId, path: workspacePath }
    });
    expect(created.status()).toBe(201);
    const workspaceId = ((await created.json()) as { workspace: { id: string } }).workspace.id;
    const parent = core.runtime.createAgentSession({
      workspaceId,
      runner: 'codex',
      cwd: workspacePath,
      externalSessionId: 'child-intervention-parent',
      model: 'gpt-5.3-codex',
      effort: 'medium',
      nativeControl: 'MAR_MANAGED',
      customTitle: 'Intervention parent'
    });
    const observations = core.agentNetworkObservations.attach(parent.id);
    await core.sessionMessageService.operations()['session.message']!({
      sessionId: parent.id,
      content: 'Parent task',
      clientMessageId: 'parent-message',
      __requestUserId: 1
    });
    const parentRun = core.runtime.activeSessionRun(parent.id)!;
    await expect.poll(() => core.runtime.currentExecutionId(parentRun.id)).toBeTruthy();
    const parentExecution = core.runtime.currentExecutionId(parentRun.id)!;
    const started = (await core.agentNetworkService.start(
      { sessionId: parent.id, requestUserId: 1 },
      {
        title: 'Intervention child',
        content: 'Child task',
        clientMessageId: 'child-message'
      }
    )) as { agentId: string };
    const childId = started.agentId;
    await expect.poll(() => core.runtime.activeSessionRun(childId)?.id).toBeTruthy();

    // The fixture feeds the same explicit product mapping through the real Runner normalizer.
    const normalizer = new MarAgentConversationNormalizer();
    const event = {
      eventId: 'event',
      sequence: 1,
      timestamp: new Date().toISOString(),
      sessionId: parent.id,
      executionId: parentExecution,
      turnId: 'parent-turn'
    };
    const items = [
      ...normalizer.normalize({
        ...event,
        type: 'tool.started',
        toolName: 'agent_start',
        callId: 'child-call',
        input: { title: 'Intervention child' }
      }),
      ...normalizer.normalize({
        ...event,
        type: 'tool.completed',
        toolName: 'agent_start',
        callId: 'child-call',
        summary: 'Child created',
        data: { agentId: childId, productSessionId: childId }
      })
    ];
    for (const item of items) core.runEventService.emit(parentExecution, 'conversation.item', item);
    expect(items.at(-1)?.payload.subagentSessionId).toBe(childId);
    await page.goto(`/console?node=${nodeId}&workspace=${workspaceId}&session=${parent.id}`);
    const tree = page.locator('.workspace-tree');
    await tree.getByRole('button', { name: 'Child intervention fixture', exact: true }).click();
    await tree.getByRole('button', { name: 'project', exact: true }).click();
    await page
      .locator('.session-list .session-link')
      .filter({ hasText: 'Intervention parent' })
      .click();
    const processHeading = page.locator('.conversation-process.is-group .process-heading');
    await expect(processHeading).toHaveCount(1);
    if ((await processHeading.getAttribute('aria-expanded')) === 'false')
      await processHeading.click();
    const group = page.locator('.subagent-group').first();
    await group.locator(':scope > details > summary').click();
    await group.getByRole('button', { name: '打开会话' }).click();
    const input = page.getByRole('textbox', { name: '输入消息' });
    await input.fill('User intervention in child');
    const submission = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes(`/api/agent-sessions/${childId}/messages`)
    );
    await input.press('Enter');
    expect((await submission).ok()).toBe(true);
    await expect.poll(() => core.runtime.activeSessionRun(childId)?.id).toBeTruthy();
    const childRun = core.runtime.activeSessionRun(childId)!;
    await expect.poll(() => core.runtime.currentExecutionId(childRun.id)).toBeTruthy();
    const childExecution = core.runtime.currentExecutionId(childRun.id)!;
    await page.getByRole('button', { name: '停止运行' }).click();
    await expect
      .poll(() =>
        observations
          .capture(childId, childExecution)
          ?.updates.some((update) => update.kind === 'terminal')
      )
      .toBe(true);
    observations.close();
  } finally {
    try {
      if (passwordChanged && csrfToken !== undefined) {
        const relogin = await page.request.post('/api/auth/login', {
          data: { username: 'admin', password: 'ChildIntervention123!' }
        });
        expect(relogin.status()).toBe(200);
        const resetCsrf = ((await relogin.json()) as { csrfToken: string }).csrfToken;
        const restored = await page.request.post('/api/auth/change-password', {
          headers: { origin: baseURL!, 'x-csrf-token': resetCsrf },
          data: { currentPassword: 'ChildIntervention123!', password: INITIAL_ADMIN_PASSWORD }
        });
        expect(restored.status()).toBe(200);
      }
    } finally {
      try {
        await page.goto('about:blank');
      } finally {
        try {
          await connector?.stop();
        } finally {
          if (previousHome === undefined) delete process.env['HOME'];
          else process.env['HOME'] = previousHome;
          if (previousCodexHome === undefined) delete process.env['CODEX_HOME'];
          else process.env['CODEX_HOME'] = previousCodexHome;
          await rm(root, { recursive: true, force: true });
        }
      }
    }
  }
});
