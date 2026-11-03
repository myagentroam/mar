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
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), 'mar-conversation-observation-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
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
  let liveConnections = 0;
  const requests: Array<{ sessionId: string; method: string; position: string | undefined }> = [];
  await page.addInitScript(() => {
    const OriginalWebSocket = window.WebSocket;
    window.WebSocket = class extends OriginalWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (String(url).includes('/api/workbench/live')) {
          (window as unknown as { closeTestLiveSocket: () => void }).closeTestLiveSocket = () =>
            this.close();
        }
      }
    };
  });
  page.on('request', (request) => {
    const match = /\/api\/agent-sessions\/([^/]+)\/watch(?:\?.*)?$/.exec(request.url());
    if (!match) return;
    const body = request.postDataJSON() as { position?: string; mode?: string } | null;
    requests.push({
      sessionId: decodeURIComponent(match[1]!),
      method: request.method(),
      position: body?.position
    });
  });
  page.on('websocket', (socket) => {
    if (!socket.url().includes('/api/workbench/live')) return;
    liveConnections += 1;
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
    const database = new NodeDatabase(':memory:', 'conversation-observation-fixture');
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
      database
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
      runner.removeNative = async () => true;
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
    database.saveNativeSessionMetadata({
      runner: 'codex',
      externalSessionId: session.id,
      workspaceId,
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
    const reply = page
      .locator('.conversation-panel')
      .filter({ hasText: 'Observation handoff' })
      .locator('.conversation-item.assistant_message .agent-markdown');
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
    const asideSession = internals.runtime.createAgentSession({
      workspaceId,
      runner: 'codex',
      cwd: workspacePath,
      externalSessionId: 'observation-aside',
      nativeControl: 'MAR_MANAGED',
      customTitle: 'Observation aside'
    });
    database.saveNativeSessionMetadata({
      runner: 'codex',
      externalSessionId: asideSession.id,
      workspaceId,
      customTitle: 'Observation aside'
    });
    const asideRun = internals.runtime.createMessageRun({
      sessionId: asideSession.id,
      clientMessageId: 'aside-observation-submission',
      content: 'Observe the aside'
    }).run;
    const asideExecution = internals.runtime.createExecution(asideRun.id);
    internals.runEventService.emit(asideExecution.id, 'run.running', {}, 'RUNNING');
    internals.runEventService.emit(asideExecution.id, 'text.delta', {
      itemId: 'aside-reply',
      text: 'Aside prefix'
    });
    await page.reload();
    await expect(reply).toHaveText('Streaming prefix and tail');
    await expect(reply).toHaveCount(1);
    await expect(page.locator('.conversation-item.user_message')).toHaveCount(1);
    expect(snapshots.at(-1)?.segments[0]?.id).toBe(segmentId);
    expect(snapshots.at(-1)?.segments[0]?.turnId).toBe('native-observation-turn');

    internals.conversationHistoryService.readOfficial = async (target) => ({
      turns: target.id === session.id ? history : [],
      nextCursor: null
    });
    const connectionsBeforeAside = liveConnections;
    const asideRow = page.locator('.session-row').filter({ hasText: 'Observation aside' });
    await asideRow.hover();
    await asideRow.locator('.session-more-button').click();
    const openAside = page.getByText('在侧栏打开', { exact: true });
    await expect(openAside).toBeEnabled();
    await openAside.click();
    const aside = page.locator('.workspace-aside');
    await expect(aside.getByText('Aside prefix', { exact: true })).toBeVisible();
    expect(liveConnections).toBe(connectionsBeforeAside);
    await expect
      .poll(() =>
        requests.some(
          (item) =>
            item.sessionId === asideSession.id &&
            item.method === 'POST' &&
            item.position === 'secondary'
        )
      )
      .toBe(true);
    const mainLiveRun = internals.runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'main-live-observation-submission',
      content: 'Observe the main pane'
    }).run;
    const mainLiveExecution = internals.runtime.createExecution(mainLiveRun.id);
    internals.runEventService.emit(mainLiveExecution.id, 'run.running', {}, 'RUNNING');
    internals.runEventService.emit(mainLiveExecution.id, 'text.delta', {
      itemId: 'main-live-reply',
      text: 'Main live reply'
    });
    internals.runEventService.emit(asideExecution.id, 'text.delta', {
      itemId: 'aside-reply',
      text: ' and live tail'
    });
    await expect(aside.getByText('Aside prefix and live tail', { exact: true })).toBeVisible();
    await expect(
      page
        .locator('.conversation-panel')
        .filter({ hasText: 'Observation handoff' })
        .getByText('Main live reply', { exact: true })
    ).toBeVisible();
    const beforeReconnect = requests.length;
    await page.evaluate(() =>
      (window as unknown as { closeTestLiveSocket: () => void }).closeTestLiveSocket()
    );
    await expect.poll(() => liveConnections).toBeGreaterThan(1);
    await expect
      .poll(() =>
        requests
          .slice(beforeReconnect)
          .some(
            (item) =>
              item.sessionId === session.id && item.method === 'POST' && item.position === undefined
          )
      )
      .toBe(true);
    await expect
      .poll(() =>
        requests
          .slice(beforeReconnect)
          .some(
            (item) =>
              item.sessionId === asideSession.id &&
              item.method === 'POST' &&
              item.position === 'secondary'
          )
      )
      .toBe(true);
    internals.runEventService.emit(mainLiveExecution.id, 'text.delta', {
      itemId: 'main-live-reply',
      text: ' after reconnect'
    });
    internals.runEventService.emit(asideExecution.id, 'text.delta', {
      itemId: 'aside-reply',
      text: ' after reconnect'
    });
    await expect(
      page
        .locator('.conversation-panel')
        .filter({ hasText: 'Observation handoff' })
        .getByText('Main live reply after reconnect', { exact: true })
    ).toBeVisible();
    await expect(
      aside.getByText('Aside prefix and live tail after reconnect', { exact: true })
    ).toBeVisible();
    await aside.getByRole('tab', { name: '文件', exact: true }).click();
    await expect
      .poll(() =>
        requests.some(
          (item) =>
            item.sessionId === asideSession.id &&
            item.method === 'DELETE' &&
            item.position === 'secondary'
        )
      )
      .toBe(true);
    await expect(
      page
        .locator('.conversation-panel')
        .filter({ hasText: 'Observation handoff' })
        .getByText('Main live reply after reconnect', { exact: true })
    ).toBeVisible();
    await aside.getByRole('tab', { name: 'Observation aside', exact: true }).click();
    await expect(
      aside.getByText('Aside prefix and live tail after reconnect', { exact: true })
    ).toBeVisible();
    internals.runEventService.emit(mainLiveExecution.id, 'run.succeeded', {}, 'SUCCEEDED');
    internals.runEventService.emit(asideExecution.id, 'run.succeeded', {}, 'SUCCEEDED');
    const beforeDeletion = requests.length;
    const currentCsrf = await page.request.post('/api/auth/csrf', {
      headers: { origin: baseURL! }
    });
    expect(currentCsrf.status()).toBe(200);
    csrfToken = ((await currentCsrf.json()) as { csrfToken: string }).csrfToken;
    const deleted = await page.request.delete(
      `/api/agent-sessions/${encodeURIComponent(asideSession.id)}?nodeId=${encodeURIComponent(nodeId!)}`,
      { headers: { origin: baseURL!, 'x-csrf-token': csrfToken } }
    );
    expect(deleted.status(), await deleted.text()).toBe(200);
    await expect(aside.getByRole('tab', { name: 'Observation aside', exact: true })).toHaveCount(0);
    await expect
      .poll(() =>
        requests
          .slice(beforeDeletion)
          .some(
            (item) =>
              item.sessionId === asideSession.id &&
              item.method === 'DELETE' &&
              item.position === 'secondary'
          )
      )
      .toBe(true);
    await expect(
      page
        .locator('.conversation-panel')
        .filter({ hasText: 'Observation handoff' })
        .getByText('Main live reply after reconnect', { exact: true })
    ).toBeVisible();
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
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
