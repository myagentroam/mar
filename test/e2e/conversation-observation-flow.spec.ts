import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { NodeConnector } from '../../mar-node/src/connector.js';
import { NodeDatabase } from '../../mar-node/src/database.js';
import { unavailableCapabilities } from '../../mar-node/src/capabilities.js';
import type { NodeRuntimeState } from '../../mar-node/src/runtime-state.js';
import type { NodeConversationTurn } from '../../mar-node/src/runtime-model.js';
import type { RunnerRegistry } from '../../mar-node/src/runner/runner-registry.js';
import type { ConversationHistoryService } from '../../mar-node/src/service/conversation-history-service.js';
import type { RunEventService } from '../../mar-node/src/service/run-event-service.js';
import { INITIAL_ADMIN_PASSWORD } from '../../packages/server-core/src/password.js';

test('Conversation observation preserves streaming text through real Node relay history handoff and resubscription', async ({
  page,
  baseURL
}) => {
  const root = await mkdtemp(join(tmpdir(), 'mar-conversation-observation-'));
  const workspacePath = join(root, 'project');
  await mkdir(workspacePath);
  let releaseHistory!: () => void;
  const historyPending = new Promise<void>((resolve) => {
    releaseHistory = resolve;
  });
  let historyReads = 0;
  let history: NodeConversationTurn[] = [];
  let connector: NodeConnector | undefined;
  let nodeId: string | undefined;
  let csrfToken: string | undefined;
  let passwordChanged = false;
  const snapshots: Array<{ segments: Array<{ id: string; turnId: string }> }> = [];
  page.on('websocket', (socket) => {
    if (!socket.url().includes('/api/workbench/live')) return;
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as {
        type?: string;
        event?: { type?: string; payload?: { conversation?: (typeof snapshots)[number] } };
      };
      if (
        frame.type === 'watch.event' &&
        frame.event?.type === 'watch.session.snapshot' &&
        frame.event.payload?.conversation
      )
        snapshots.push(frame.event.payload.conversation);
    });
  });
  try {
    const login = await page.request.post('/api/auth/login', {
      data: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
    });
    expect(login.status()).toBe(200);
    const initial = (await login.json()) as { csrfToken: string };
    const changed = await page.request.post('/api/auth/change-password', {
      headers: { origin: baseURL!, 'x-csrf-token': initial.csrfToken },
      data: { currentPassword: INITIAL_ADMIN_PASSWORD, password: 'ConversationObservation123!' }
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
    const registration = await page.request.post('/api/node-registration-tokens', {
      headers,
      data: { displayName: 'Conversation observation fixture' }
    });
    expect(registration.status()).toBe(200);
    const serverURL = new URL(baseURL!);
    serverURL.port = process.env['MAR_E2E_SERVER_PORT'] ?? String(Number(serverURL.port) + 1);
    connector = new NodeConnector({
      configPath: join(root, 'node.json'),
      config: {
        serverUrl: serverURL.origin,
        allowedRoots: [root],
        dataDirectory: join(root, 'node-data'),
        registrationToken: ((await registration.json()) as { token: string }).token
      },
      capabilities: { ...unavailableCapabilities(), codex: { available: true } },
      reconnect: false,
      database: new NodeDatabase(':memory:', 'conversation-observation-fixture')
    });
    const internals = connector as unknown as {
      runtime: NodeRuntimeState;
      runners: RunnerRegistry;
      conversationHistoryService: ConversationHistoryService;
      runEventService: RunEventService;
    };
    for (const runner of internals.runners.advertised()) {
      runner.refreshProfile = async () => undefined;
      runner.discoverSessions = async () => [];
    }
    internals.conversationHistoryService.readNative = async () => undefined;
    internals.conversationHistoryService.readOfficial = async () => {
      historyReads += 1;
      await historyPending;
      return { turns: history, nextCursor: null };
    };
    await connector.start();
    await expect
      .poll(async () => {
        const response = await page.request.get('/api/nodes');
        const result = (await response.json()) as {
          nodes: { id: string; connected: boolean; displayName: string }[];
        };
        nodeId = result.nodes.find(
          (node) => node.connected && node.displayName === 'Conversation observation fixture'
        )?.id;
        return nodeId;
      })
      .toBeTruthy();
    const created = await page.request.post('/api/workspaces', {
      headers,
      data: { nodeId, path: workspacePath }
    });
    expect(created.status()).toBe(201);
    const workspaceId = ((await created.json()) as { workspace: { id: string } }).workspace.id;
    const session = internals.runtime.createAgentSession({
      workspaceId,
      runner: 'codex',
      cwd: workspacePath,
      externalSessionId: 'observation-session',
      nativeControl: 'MAR_MANAGED',
      customTitle: 'Observation handoff'
    });
    const run = internals.runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'observation-submission',
      content: 'Observe this reply'
    }).run;
    const execution = internals.runtime.createExecution(run.id);
    internals.runEventService.emit(execution.id, 'run.running', {}, 'RUNNING');
    internals.runEventService.emit(execution.id, 'text.delta', {
      itemId: 'reply',
      text: 'Streaming prefix'
    });
    await page.goto(`/console?node=${nodeId}&workspace=${workspaceId}&session=${session.id}`);
    const tree = page.locator('.workspace-tree');
    await tree
      .getByRole('button', { name: 'Conversation observation fixture', exact: true })
      .click();
    await tree.getByRole('button', { name: 'project', exact: true }).click();
    await page
      .locator('.session-list .session-link')
      .filter({ hasText: 'Observation handoff' })
      .click();
    const reply = page.locator('.conversation-item.assistant_message .agent-markdown');
    await expect(reply).toHaveText('Streaming prefix');
    await expect.poll(() => snapshots.length).toBe(1);
    const segmentId = snapshots[0]!.segments[0]!.id;
    await expect.poll(() => historyReads).toBe(1);
    internals.runEventService.emit(execution.id, 'text.delta', {
      itemId: 'reply',
      text: ' and tail'
    });
    await expect(reply).toHaveText('Streaming prefix and tail');
    releaseHistory();
    await expect.poll(() => snapshots.length).toBeGreaterThan(1);
    await expect(reply).toHaveText('Streaming prefix and tail');
    await expect(page.locator('.conversation-item.user_message')).toHaveCount(1);
    await expect(reply).toHaveCount(1);
    internals.runEventService.emit(execution.id, 'run.succeeded', {}, 'SUCCEEDED');
    const local = internals.runtime.conversationTurnForRun(run.id)!;
    history = [{ ...structuredClone(local), id: 'native-observation-turn', runId: null }];
    await expect.poll(() => historyReads).toBeGreaterThan(1);
    await expect(reply).toHaveText('Streaming prefix and tail');
    await expect(reply).toHaveCount(1);
    await page.reload();
    await expect(reply).toHaveText('Streaming prefix and tail');
    await expect(reply).toHaveCount(1);
    await expect(page.locator('.conversation-item.user_message')).toHaveCount(1);
    expect(snapshots.at(-1)?.segments[0]?.id).toBe(segmentId);
    expect(snapshots.at(-1)?.segments[0]?.turnId).toBe('native-observation-turn');
  } finally {
    releaseHistory();
    await page.goto('about:blank');
    await connector?.stop();
    if (passwordChanged) {
      const current = await page.request.post('/api/auth/csrf', { headers: { origin: baseURL! } });
      expect(current.status()).toBe(200);
      csrfToken = ((await current.json()) as { csrfToken: string }).csrfToken;
    }
    if (csrfToken !== undefined && nodeId !== undefined)
      await page.request.delete(`/api/nodes/${nodeId}`, {
        headers: { origin: baseURL!, 'x-csrf-token': csrfToken }
      });
    if (passwordChanged && csrfToken !== undefined) {
      const restored = await page.request.post('/api/auth/change-password', {
        headers: { origin: baseURL!, 'x-csrf-token': csrfToken },
        data: { currentPassword: 'ConversationObservation123!', password: INITIAL_ADMIN_PASSWORD }
      });
      expect(restored.status()).toBe(200);
    }
    await rm(root, { recursive: true, force: true });
  }
});
