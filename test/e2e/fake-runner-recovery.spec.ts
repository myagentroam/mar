import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import nodePackage from '../../mar-node/package.json' with { type: 'json' };
import { expect, test } from '@playwright/test';
import { NodeConnector } from '../../mar-node/src/connector.js';
import type { CodexAppServerClient } from '../../mar-node/src/codex-app-server.js';
import { FakeRunner, type FakeRunnerStep } from '../../mar-node/src/fake-runner.js';
import { createTestServerApp as createServerApp } from '../support/create-test-server-app.js';
import { INITIAL_ADMIN_PASSWORD } from '../../packages/server-core/src/password.js';

const executeFile = promisify(execFile);

test('A fake Runner completes approvals, terminal states, cancellation, and reconnect reconciliation through a real NodeConnector', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-agent-roam-t006-e2e-'));
  const workspacePath = join(directory, 'workspace');
  const app = createServerApp({
    databasePath: join(directory, 'server.sqlite'),
    secureCookies: false
  });
  let connector: NodeConnector | undefined;
  try {
    await prepareGitWorkspace(workspacePath);
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const admin = await adminHeaders(app);
    const token = await app.inject({
      method: 'POST',
      url: '/api/node-registration-tokens',
      headers: admin.headers
    });
    connector = new NodeConnector({
      configPath: join(directory, 'node.json'),
      config: {
        serverUrl: baseUrl,
        allowedRoots: [directory],
        registrationToken: token.json<{ token: string }>().token
      },
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: process.version,
        nodeAppVersion: nodePackage.version,
        codex: { available: true },
        claudeCode: { available: true }
      },
      codexProfileClientFactory: fakeCodexProfileClient,
      fakeRunner: new FakeRunner(),
      fakeScript: scriptForMessage
    });
    await connector.start();
    const nodeId = await waitForConnectedNode(app, admin.headers.cookie);
    const metrics = await app.inject({
      method: 'GET',
      url: `/api/nodes/${nodeId}/metrics`,
      headers: { cookie: admin.headers.cookie }
    });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.json()).toMatchObject({
      metrics: {
        connectionAttempts: 1,
        heartbeats: expect.any(Number),
        activeRuns: 0,
        workspaceLeases: 0
      }
    });
    const workspace = await app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: admin.headers,
      payload: { nodeId, path: workspacePath }
    });
    expect(workspace.statusCode).toBe(201);
    const workspaceId = workspace.json<{ workspace: { id: string } }>().workspace.id;
    const profiles = await app.inject({
      method: 'GET',
      url: `/api/runner-profiles?nodeId=${nodeId}`,
      headers: admin.headers
    });
    expect(profiles.statusCode).toBe(200);
    const session = await app.inject({
      method: 'POST',
      url: '/api/agent-sessions/start',
      headers: admin.headers,
      payload: {
        nodeId,
        workspaceId,
        runner: 'codex',
        modelId: 'gpt-5.6-sol',
        cwd: workspacePath,
        clientMessageId: 'approval-approved',
        content: 'approval-approved'
      }
    });
    expect(session.statusCode).toBe(201);
    const sessionId = session.json<{ session: { id: string } }>().session.id;
    const approvedRun = session.json<{ run: { id: string } }>().run.id;
    const approvedApproval = await waitForApproval(
      app,
      admin.headers.cookie,
      nodeId,
      sessionId,
      approvedRun
    );
    const approved = await app.inject({
      method: 'POST',
      url: `/api/agent-runs/${approvedRun}/approvals/${approvedApproval}/decision`,
      headers: admin.headers,
      payload: { nodeId, decision: 'APPROVED' }
    });
    expect(approved.statusCode).toBe(200);
    await expectRunReleased(app, admin.headers.cookie, nodeId, approvedRun);
    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/agent-runs/${approvedRun}/approvals/${approvedApproval}/decision`,
      headers: admin.headers,
      payload: { nodeId, decision: 'REJECTED' }
    });
    expect(duplicate).toMatchObject({ statusCode: 404, json: expect.any(Function) });
    expect(duplicate.json()).toMatchObject({ error: { code: 'APPROVAL_NOT_FOUND' } });

    const rejectedRun = await createRun(
      app,
      admin.headers,
      nodeId,
      workspaceId,
      sessionId,
      'approval-rejected'
    );
    const rejectedApproval = await waitForApproval(
      app,
      admin.headers.cookie,
      nodeId,
      sessionId,
      rejectedRun
    );
    const rejected = await app.inject({
      method: 'POST',
      url: `/api/agent-runs/${rejectedRun}/approvals/${rejectedApproval}/decision`,
      headers: admin.headers,
      payload: { nodeId, decision: 'REJECTED' }
    });
    expect(rejected.statusCode).toBe(200);
    await expectRunReleased(app, admin.headers.cookie, nodeId, rejectedRun);

    const failedRun = await createRun(
      app,
      admin.headers,
      nodeId,
      workspaceId,
      sessionId,
      'failure'
    );
    await expectRunReleased(app, admin.headers.cookie, nodeId, failedRun);

    const cancelledRun = await createRun(
      app,
      admin.headers,
      nodeId,
      workspaceId,
      sessionId,
      'cancel'
    );
    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/agent-runs/${cancelledRun}/cancel`,
      headers: admin.headers,
      payload: { nodeId }
    });
    expect(cancelled.statusCode, cancelled.body).toBe(202);
    await expectRunReleased(app, admin.headers.cookie, nodeId, cancelledRun);

    const recoveredRun = await createRun(
      app,
      admin.headers,
      nodeId,
      workspaceId,
      sessionId,
      'disconnect'
    );
    await expect
      .poll(() => runRecoveryState(app, admin.headers.cookie, nodeId, recoveredRun), {
        timeout: 5_000
      })
      .toBe('ACTIVE');
    const stopRecovered = await app.inject({
      method: 'POST',
      url: `/api/agent-runs/${recoveredRun}/cancel`,
      headers: admin.headers,
      payload: { nodeId }
    });
    expect(stopRecovered.statusCode).toBe(202);
    await expectRunReleased(app, admin.headers.cookie, nodeId, recoveredRun);
  } finally {
    connector?.stop();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function fakeCodexProfileClient(): CodexAppServerClient {
  return {
    start: async () => undefined,
    stop: () => undefined,
    listModels: async () => ({
      data: [
        {
          modelId: 'gpt-5.6-sol',
          displayName: 'gpt-5.6-sol',
          hidden: false,
          isDefault: true,
          defaultReasoningEffort: 'high',
          supportedReasoningEfforts: [{ reasoningEffort: 'high', description: '' }]
        }
      ],
      nextCursor: null
    })
  } as unknown as CodexAppServerClient;
}

function scriptForMessage(input: unknown): readonly FakeRunnerStep[] {
  if (input === 'approval-approved') {
    return [{ type: 'text', text: 'needs approval' }, { type: 'approval' }, { type: 'success' }];
  }
  if (input === 'approval-rejected') return [{ type: 'approval' }, { type: 'success' }];
  if (input === 'failure') return [{ type: 'failure' }];
  if (input === 'cancel') return [{ type: 'long-running' }];
  if (input === 'disconnect') return [{ type: 'disconnect' }, { type: 'long-running' }];
  return [{ type: 'success' }];
}

async function prepareGitWorkspace(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await executeFile('git', ['init', path]);
  await executeFile('git', ['-C', path, 'config', 'user.email', 'test@example.invalid']);
  await executeFile('git', ['-C', path, 'config', 'user.name', 'MyAgentRoam Test']);
  await writeFile(join(path, 'README.md'), 'fake runner workspace\n');
  await executeFile('git', ['-C', path, 'add', 'README.md']);
  await executeFile('git', ['-C', path, 'commit', '-m', 'test']);
}

async function adminHeaders(app: ReturnType<typeof createServerApp>) {
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
  });
  const changed = await app.inject({
    method: 'POST',
    url: '/api/auth/change-password',
    headers: {
      cookie: cookie(login.headers['set-cookie']),
      'x-csrf-token': login.json<{ csrfToken: string }>().csrfToken
    },
    payload: { currentPassword: INITIAL_ADMIN_PASSWORD, password: INITIAL_ADMIN_PASSWORD }
  });
  return {
    headers: {
      cookie: cookie(changed.headers['set-cookie']),
      'x-csrf-token': changed.json<{ csrfToken: string }>().csrfToken
    }
  };
}

async function waitForConnectedNode(app: ReturnType<typeof createServerApp>, cookieHeader: string) {
  await expect
    .poll(async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/nodes',
        headers: { cookie: cookieHeader }
      });
      return response.json<{ nodes: { id: string; connected: boolean }[] }>().nodes;
    })
    .toEqual(expect.arrayContaining([expect.objectContaining({ connected: true })]));
  const response = await app.inject({
    method: 'GET',
    url: '/api/nodes',
    headers: { cookie: cookieHeader }
  });
  return response.json<{ nodes: { id: string }[] }>().nodes[0]?.id ?? '';
}

async function createRun(
  app: ReturnType<typeof createServerApp>,
  headers: Record<string, string>,
  nodeId: string,
  workspaceId: string,
  sessionId: string,
  content: string
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/agent-sessions/${sessionId}/messages`,
    headers,
    payload: { nodeId, workspaceId, clientMessageId: crypto.randomUUID(), content }
  });
  expect(response.statusCode, response.body).toBe(202);
  return response.json<{ run: { id: string } }>().run.id;
}

async function waitForApproval(
  app: ReturnType<typeof createServerApp>,
  cookieHeader: string,
  nodeId: string,
  sessionId: string,
  runId: string
): Promise<string> {
  let approvalId = '';
  await expect
    .poll(async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/agent-sessions/${sessionId}/events?nodeId=${nodeId}`,
        headers: { cookie: cookieHeader }
      });
      const item = response
        .json<{
          items: { runId: string; kind: string; status: string; payload?: unknown }[];
        }>()
        .items.find(
          (candidate) =>
            candidate.runId === runId &&
            candidate.kind === 'approval_request' &&
            candidate.status === 'PENDING'
        );
      const payload = item?.payload as { approvalId?: unknown } | undefined;
      approvalId = typeof payload?.approvalId === 'string' ? payload.approvalId : '';
      return approvalId;
    })
    .not.toBe('');
  return approvalId;
}

async function expectRunReleased(
  app: ReturnType<typeof createServerApp>,
  cookieHeader: string,
  nodeId: string,
  runId: string
): Promise<void> {
  await expect
    .poll(async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/agent-runs/${runId}?nodeId=${nodeId}`,
        headers: { cookie: cookieHeader }
      });
      return response.json<{ error?: { code?: string } }>().error?.code;
    })
    .toBe('RUN_NOT_FOUND');
}

async function runRecoveryState(
  app: ReturnType<typeof createServerApp>,
  cookieHeader: string,
  nodeId: string,
  runId: string
) {
  const response = await app.inject({
    method: 'GET',
    url: `/api/agent-runs/${runId}?nodeId=${nodeId}`,
    headers: { cookie: cookieHeader }
  });
  return response.json<{ run?: { recoveryState: string } }>().run?.recoveryState ?? 'UNAVAILABLE';
}

function cookie(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) throw new Error('COOKIE_MISSING');
  return raw.split(';')[0] ?? raw;
}
