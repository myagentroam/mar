import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { NodeConnector } from '../../mar-node/src/connector.js';
import { NodeDatabase } from '../../mar-node/src/database.js';
import { unavailableCapabilities } from '../../mar-node/src/capabilities.js';
import type { NodeRuntimeState } from '../../mar-node/src/runtime-state.js';
import type { RunnerRegistry } from '../../mar-node/src/runner/runner-registry.js';
import type { ConversationHistoryService } from '../../mar-node/src/service/conversation-history-service.js';
import type { RunEventService } from '../../mar-node/src/service/run-event-service.js';
import type { WorkspaceWatchService } from '../../mar-node/src/workspace/workspace-watch-service.js';
import { INITIAL_ADMIN_PASSWORD } from '../../packages/server-core/src/password.js';
import { createEnterpriseTestServer } from './support/enterprise-test-server.js';
import { createPlaywrightTestLicenseDocument } from './support/playwright-test-license.js';

test('Workspace revocation denies both real session Watch positions on one live connection', async ({
  page
}) => {
  test.setTimeout(90_000);
  const server = await createEnterpriseTestServer('aside-revocation');
  const root = await mkdtemp(join(tmpdir(), 'mar-aside-revocation-'));
  const workspacePath = join(root, 'project');
  await mkdir(workspacePath);
  let connector: NodeConnector | undefined;
  try {
    async function api<T>(
      headers: Record<string, string>,
      method: string,
      path: string,
      data?: unknown,
      status = 200
    ): Promise<T> {
      const response = await fetch(server.baseURL + path, {
        method,
        headers: {
          ...headers,
          ...(data === undefined ? {} : { 'content-type': 'application/json' })
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) })
      });
      const body = response.status === 204 ? undefined : await response.json();
      expect(response.status, JSON.stringify(body)).toBe(status);
      return body as T;
    }
    async function login(username: string, password: string): Promise<Record<string, string>> {
      const response = await fetch(server.baseURL + '/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      expect(response.status).toBe(200);
      const initial = (await response.json()) as { csrfToken: string };
      const changed = await fetch(server.baseURL + '/api/auth/change-password', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: response.headers.get('set-cookie')!.split(';')[0]!,
          'x-csrf-token': initial.csrfToken
        },
        body: JSON.stringify({ currentPassword: password, password: 'AsideRevocation123!' })
      });
      expect(changed.status).toBe(200);
      return {
        cookie: changed.headers.get('set-cookie')!.split(';')[0]!,
        'x-csrf-token': ((await changed.json()) as { csrfToken: string }).csrfToken
      };
    }
    const admin = await login('admin', INITIAL_ADMIN_PASSWORD);
    await api(admin, 'POST', '/api/license/import', {
      document: createPlaywrightTestLicenseDocument()
    });
    const memberRecord = await api<{ user: { id: number }; temporaryPassword: string }>(
      admin,
      'POST',
      '/api/enterprise/users',
      { username: 'aside-member', role: 'MEMBER', organizationId: 1 },
      201
    );
    const member = await login('aside-member', memberRecord.temporaryPassword);
    const registration = await api<{ token: string }>(
      admin,
      'POST',
      '/api/node-registration-tokens',
      {
        displayName: 'Aside revocation fixture',
        ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 }
      }
    );
    const database = new NodeDatabase(':memory:', 'aside-revocation');
    connector = new NodeConnector({
      configPath: join(root, 'node.json'),
      config: {
        serverUrl: server.baseURL,
        allowedRoots: [root],
        dataDirectory: join(root, 'node-data'),
        registrationToken: registration.token
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
      nativeSessionWatchService: { isWatching(sessionId: string): boolean };
      workspaceWatchService: Pick<WorkspaceWatchService, 'activeWatches'>;
    };
    for (const runner of internals.runners.advertised()) {
      runner.refreshProfile = async () => undefined;
      runner.discoverSessions = async () => [];
    }
    internals.conversationHistoryService.readNative = async () => undefined;
    internals.conversationHistoryService.readOfficial = async () => ({
      turns: [],
      nextCursor: null
    });
    await connector.start();
    let nodeId = '';
    await expect
      .poll(async () => {
        const result = await api<{
          nodes: { id: string; connected: boolean; displayName: string }[];
        }>(admin, 'GET', '/api/nodes');
        nodeId =
          result.nodes.find(
            (node) => node.connected && node.displayName === 'Aside revocation fixture'
          )?.id ?? '';
        return nodeId;
      })
      .not.toBe('');
    const { workspace } = await api<{ workspace: { id: string } }>(
      admin,
      'POST',
      '/api/workspaces',
      {
        nodeId,
        path: workspacePath,
        ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 }
      },
      201
    );
    const sessions = ['Main', 'Aside'].map((title) =>
      internals.runtime.createAgentSession({
        workspaceId: workspace.id,
        runner: 'codex',
        cwd: workspacePath,
        externalSessionId: `revocation-${title}`,
        nativeControl: 'MAR_MANAGED',
        customTitle: title
      })
    );
    const executions = sessions.map((session, index) => {
      const run = internals.runtime.createMessageRun({
        sessionId: session.id,
        clientMessageId: `revocation-run-${index}`,
        content: 'Observe'
      }).run;
      const execution = internals.runtime.createExecution(run.id);
      internals.runEventService.emit(execution.id, 'run.running', {}, 'RUNNING');
      return execution;
    });
    const grant = await api<{ id: string }>(
      admin,
      'POST',
      '/api/resource-grants',
      {
        resourceType: 'WORKSPACE',
        nodeId,
        workspaceId: workspace.id,
        targetType: 'USER',
        targetUserId: memberRecord.user.id
      },
      201
    );
    if (!member.cookie) throw new Error('Member login did not return a session cookie');
    const cookie = member.cookie.split('=');
    await page.context().addCookies([
      {
        name: cookie[0]!,
        value: decodeURIComponent(cookie.slice(1).join('=')),
        url: server.baseURL,
        httpOnly: true,
        sameSite: 'Lax'
      }
    ]);
    await page.goto(server.baseURL + '/api/auth/csrf');
    const connectionId = await page.evaluate(async (url) => {
      const socket = new WebSocket(url.replace('http', 'ws') + '/api/workbench/live');
      (window as unknown as { testLive: WebSocket }).testLive = socket;
      const messages: string[] = [];
      (window as unknown as { testMessages: string[] }).testMessages = messages;
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = () => reject(new Error('LIVE_OPEN_FAILED'));
      });
      const ready = new Promise<string>((resolve, reject) => {
        socket.onmessage = (event) => {
          messages.push(String(event.data));
          const message = JSON.parse(String(event.data));
          if (message.type === 'workbench.ready') resolve(message.workbenchConnectionId);
        };
        socket.onerror = () => reject(new Error('LIVE_READY_FAILED'));
      });
      socket.send(JSON.stringify({ type: 'resume' }));
      return ready;
    }, server.baseURL);
    const watch = (index: number, mode: 'initial' | 'renew') =>
      api(
        member,
        'POST',
        `/api/agent-sessions/${sessions[index]!.id}/watch`,
        {
          nodeId,
          workspaceId: workspace.id,
          workbenchConnectionId: connectionId,
          watchId: `revocation-watch-${index}`,
          mode,
          ...(index === 1 ? { position: 'secondary' } : {})
        },
        mode === 'renew' ? 204 : 200
      );
    const workspaceWatchId = 'workspace-revocation';
    const workspaceWatch = {
      nodeId,
      workbenchConnectionId: connectionId,
      watchId: workspaceWatchId
    };
    await api(member, 'POST', `/api/workspaces/${workspace.id}/watch`, {
      ...workspaceWatch,
      mode: 'initial',
      topics: { sessions: true }
    });
    await expect
      .poll(() => internals.workspaceWatchService.activeWatches(workspace.id).length)
      .toBe(1);
    await watch(0, 'initial');
    await watch(1, 'initial');
    for (const [index, execution] of executions.entries()) {
      internals.runEventService.emit(execution.id, 'text.delta', {
        itemId: `before-${index}`,
        text: `before-revoke-${index}`
      });
    }
    for (const index of [0, 1]) {
      await expect
        .poll(() =>
          page.evaluate(
            (needle) =>
              (window as unknown as { testMessages: string[] }).testMessages.some((message) =>
                message.includes(needle)
              ),
            `before-revoke-${index}`
          )
        )
        .toBe(true);
    }
    await api(admin, 'DELETE', `/api/resource-grants/${grant.id}`, undefined, 204);
    await api(
      member,
      'POST',
      `/api/workspaces/${workspace.id}/watch`,
      {
        ...workspaceWatch,
        mode: 'renew'
      },
      403
    );
    for (const [index, execution] of executions.entries()) {
      internals.runEventService.emit(execution.id, 'text.delta', {
        itemId: `after-${index}`,
        text: `after-revoke-${index}`
      });
    }
    for (const [index, session] of sessions.entries()) {
      const response = await fetch(`${server.baseURL}/api/agent-sessions/${session.id}/watch`, {
        method: 'POST',
        headers: { ...member, 'content-type': 'application/json' },
        body: JSON.stringify({
          nodeId,
          workspaceId: workspace.id,
          workbenchConnectionId: connectionId,
          watchId: `revocation-watch-${index}`,
          mode: 'renew',
          ...(index === 1 ? { position: 'secondary' } : {})
        })
      });
      expect(response.status).toBe(403);
    }
    await page.waitForTimeout(500);
    expect(
      await page.evaluate(() =>
        (window as unknown as { testMessages: string[] }).testMessages.some((message) =>
          message.includes('after-revoke-')
        )
      )
    ).toBe(false);
    await api(member, 'DELETE', `/api/agent-sessions/${sessions[0]!.id}/watch`, {
      nodeId,
      workspaceId: workspace.id,
      workbenchConnectionId: connectionId,
      watchId: 'stale-watch-token'
    });
    expect(internals.nativeSessionWatchService.isWatching(sessions[0]!.id)).toBe(true);
    expect(internals.nativeSessionWatchService.isWatching(sessions[1]!.id)).toBe(true);
    await api(
      member,
      'DELETE',
      `/api/agent-sessions/${sessions[1]!.id}/watch`,
      {
        nodeId,
        workspaceId: workspace.id,
        workbenchConnectionId: 'another-page',
        watchId: 'revocation-watch-1',
        position: 'secondary'
      },
      400
    );
    expect(internals.nativeSessionWatchService.isWatching(sessions[1]!.id)).toBe(true);
    for (const [index, session] of sessions.entries()) {
      await api(member, 'DELETE', `/api/agent-sessions/${session.id}/watch`, {
        nodeId,
        workspaceId: workspace.id,
        workbenchConnectionId: connectionId,
        watchId: `revocation-watch-${index}`,
        ...(index === 1 ? { position: 'secondary' } : {})
      });
      await expect
        .poll(() => internals.nativeSessionWatchService.isWatching(session.id))
        .toBe(false);
    }
    await api(member, 'DELETE', `/api/workspaces/${workspace.id}/watch`, {
      ...workspaceWatch,
      watchId: 'stale-workspace-watch'
    });
    expect(internals.workspaceWatchService.activeWatches(workspace.id)).toHaveLength(1);
    await api(
      member,
      'DELETE',
      `/api/workspaces/${workspace.id}/watch`,
      {
        ...workspaceWatch,
        workbenchConnectionId: 'another-page'
      },
      400
    );
    await api(member, 'DELETE', '/api/workspaces/not-the-watched-workspace/watch', workspaceWatch);
    expect(internals.workspaceWatchService.activeWatches(workspace.id)).toHaveLength(1);
    await api(member, 'DELETE', `/api/workspaces/${workspace.id}/watch`, workspaceWatch);
    await expect
      .poll(() => internals.workspaceWatchService.activeWatches(workspace.id).length)
      .toBe(0);
    await page.evaluate(() => (window as unknown as { testLive: WebSocket }).testLive.close());
  } finally {
    await connector?.stop();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
