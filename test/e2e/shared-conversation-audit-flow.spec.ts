import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import nodePackage from '../../mar-node/package.json' with { type: 'json' };
import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
  type APIResponse
} from '@playwright/test';
import { NodeConnector } from '../../mar-node/src/connector.js';
import type { CodexAppServerClient } from '../../mar-node/src/codex-app-server.js';
import { FakeRunner } from '../../mar-node/src/fake-runner.js';
import { createPlaywrightTestLicenseDocument } from './support/playwright-test-license.js';
import {
  createEnterpriseTestServer,
  type EnterpriseTestServer
} from './support/enterprise-test-server.js';
import { INITIAL_ADMIN_PASSWORD } from '../../packages/server-core/src/password.js';
import { isolateRunnerEnvironment } from '../support/isolate-runner-environment.js';
import { cleanupSharedAuditFixture } from '../support/shared-audit-fixture-cleanup.js';
import { nativeTranscriptAdapter } from '../../mar-node/src/native-transcript-adapters.js';
import { discoverAllNativeSessions } from '../../mar-node/src/native-session-history.js';

const executeFile = promisify(execFile);
const sessionTitle = 'Shared audit session';

test('Shared organization Node conversations expose content only through audit details over a real Connector', async ({
  browserName
}) => {
  test.skip(browserName !== 'chromium', 'The Connector flow is exercised once.');
  const directory = await mkdtemp(join(tmpdir(), 'my-agent-roam-t151-e2e-'));
  const runnerHome = join(directory, 'runner-home');
  await mkdir(runnerHome);
  const restoreRunnerEnvironment = isolateRunnerEnvironment(runnerHome);
  const workspacePath = join(directory, 'workspace');
  let actor: { context: APIRequestContext; csrfToken: string } | undefined;
  let connector: NodeConnector | undefined;
  let server: EnterpriseTestServer | undefined;
  let primaryFailure: { readonly error: unknown } | undefined;
  try {
    expect(nativeTranscriptAdapter('codex')!.transcriptRoot()).toBe(
      join(runnerHome, '.codex', 'sessions')
    );
    expect(nativeTranscriptAdapter('claude-code')!.transcriptRoot()).toBe(
      join(runnerHome, '.claude', 'projects')
    );
    for (const runner of ['codex', 'claude-code'] as const) {
      const root = nativeTranscriptAdapter(runner)!.transcriptRoot();
      await mkdir(root, { recursive: true });
      expect(await readdir(root)).toEqual([]);
      expect(await discoverAllNativeSessions(runner)).toEqual([]);
    }
    server = await createEnterpriseTestServer('shared-conversation-audit-flow');
    const baseURL = server.baseURL;
    await prepareGitWorkspace(workspacePath);
    actor = await login(baseURL);
    await expectJson(
      await actor.context.post('/api/license/import', {
        headers: { 'x-csrf-token': actor.csrfToken },
        data: { document: createPlaywrightTestLicenseDocument() }
      }),
      200
    );
    const registration = await expectJson<{ token: string }>(
      await actor.context.post('/api/node-registration-tokens', {
        headers: { 'x-csrf-token': actor.csrfToken },
        data: {
          displayName: 'T151 shared audit Node',
          ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 }
        }
      }),
      200
    );
    connector = new NodeConnector({
      configPath: join(directory, 'node.json'),
      config: {
        serverUrl: baseURL,
        allowedRoots: [directory],
        dataDirectory: join(directory, 'node-data'),
        registrationToken: registration.token
      },
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeAppVersion: nodePackage.version,
        nodeVersion: process.version,
        codex: { available: true },
        claudeCode: { available: false }
      },
      reconnect: false,
      codexProfileClientFactory: fakeCodexProfileClient,
      fakeRunner: new FakeRunner(),
      fakeScript: (input) =>
        String(input).includes('follow-up') ? [{ type: 'long-running' }] : [{ type: 'success' }]
    });
    await connector.start();
    const nodeId = await connectedNode(actor.context);

    const workspace = await expectJson<{ workspace: { id: string } }>(
      await actor.context.post('/api/workspaces', {
        headers: { 'x-csrf-token': actor.csrfToken },
        data: {
          nodeId,
          path: workspacePath,
          ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 }
        }
      }),
      201
    );
    const workspaceId = workspace.workspace.id;
    await expectJson(
      await actor.context.get(
        `/api/workspaces/${workspaceId}/files/read?nodeId=${nodeId}&path=README.md`
      ),
      200
    );
    await expectJson(
      await actor.context.put(`/api/workspaces/${workspaceId}/files/write`, {
        headers: { 'x-csrf-token': actor.csrfToken },
        data: {
          nodeId,
          path: 'README.md',
          expectedRevision: createHash('sha256')
            .update(await readFile(join(workspacePath, 'README.md')))
            .digest('hex'),
          content: 'Never audit this file body.'
        }
      }),
      200
    );
    await expect
      .poll(async () =>
        (await auditEvents(actor!.context)).some(
          (event) => event.eventType === 'workspace.file.write'
        )
      )
      .toBe(true);
    const writes = await auditEvents(actor.context);
    expect(writes.some((event) => event.eventType === 'workspace.file.read')).toBe(false);
    expect(JSON.stringify(writes)).not.toContain('Never audit this file body.');

    const started = await expectJson<{
      session: { id: string };
      run: { id: string };
    }>(
      await actor.context.post('/api/agent-sessions/start', {
        headers: { 'x-csrf-token': actor.csrfToken },
        data: {
          nodeId,
          workspaceId,
          runner: 'codex',
          modelId: 'gpt-5.6-sol',
          cwd: workspacePath,
          title: sessionTitle,
          clientMessageId: 't151-start',
          content: 'Audit this accepted start input.'
        }
      }),
      201
    );
    const sessionId = started.session.id;
    const continued = await expectJson<{ run: { id: string } }>(
      await actor.context.post(`/api/agent-sessions/${sessionId}/messages`, {
        headers: { 'x-csrf-token': actor.csrfToken },
        data: {
          nodeId,
          workspaceId,
          clientMessageId: 't151-message',
          content: 'Audit this accepted follow-up input.'
        }
      }),
      202
    );
    await expect
      .poll(() => runStatus(actor!.context, sessionId, nodeId, continued.run.id))
      .toBe('RUNNING');
    const queued = await expectJson<{ run: { id: string }; queueItemId: string }>(
      await actor.context.post(`/api/agent-sessions/${sessionId}/messages`, {
        headers: { 'x-csrf-token': actor.csrfToken },
        data: {
          nodeId,
          workspaceId,
          clientMessageId: 't151-queue',
          content: 'Audit this accepted queued input.',
          deliveryIntent: 'QUEUE'
        }
      }),
      202
    );

    await expect
      .poll(
        async () =>
          (await auditEvents(actor!.context)).filter((event) =>
            ['t151-start', 't151-message', 't151-queue'].includes(event.clientMessageId ?? '')
          ).length
      )
      .toBe(3);
    const events = await auditEvents(actor.context);
    expect(JSON.stringify(events)).not.toContain('Audit this accepted');
    const startEvent = auditEvent(events, 't151-start');
    const messageEvent = auditEvent(events, 't151-message');
    const queueEvent = auditEvent(events, 't151-queue');
    expect(startEvent).toMatchObject({
      eventType: 'shared_conversation_input_accepted',
      metadata: {
        nodeName: 'T151 shared audit Node',
        workspaceName: 'workspace',
        sessionName: sessionTitle,
        organizationName: expect.any(String)
      },
      targetName: sessionTitle,
      agentSessionId: sessionId,
      runId: started.run.id,
      inputMode: 'NEW_SESSION',
      hasConversationPayload: true
    });
    expect(messageEvent).toMatchObject({
      eventType: 'shared_conversation_input_accepted',
      metadata: {
        nodeName: 'T151 shared audit Node',
        workspaceName: 'workspace',
        sessionName: sessionTitle,
        organizationName: expect.any(String)
      },
      targetName: sessionTitle,
      agentSessionId: sessionId,
      runId: continued.run.id,
      inputMode: 'SEND',
      hasConversationPayload: true
    });
    expect(queueEvent).toMatchObject({
      eventType: 'shared_conversation_input_accepted',
      metadata: {
        nodeName: 'T151 shared audit Node',
        workspaceName: 'workspace',
        sessionName: sessionTitle,
        organizationName: expect.any(String)
      },
      targetName: sessionTitle,
      agentSessionId: sessionId,
      runId: queued.run.id,
      queueItemId: queued.queueItemId,
      inputMode: 'QUEUE',
      hasConversationPayload: true
    });
    await expectJson(await actor.context.get(`/api/audit-events/${startEvent.id}`), 200).then(
      (detail) =>
        expect(detail).toMatchObject({
          id: startEvent.id,
          conversationPayload: {
            conversationId: sessionId,
            conversationTitle: sessionTitle,
            userMessage: 'Audit this accepted start input.'
          }
        })
    );
    await expectJson(await actor.context.get(`/api/audit-events/${messageEvent.id}`), 200).then(
      (detail) =>
        expect(detail).toMatchObject({
          id: messageEvent.id,
          conversationPayload: {
            conversationId: sessionId,
            conversationTitle: sessionTitle,
            userMessage: 'Audit this accepted follow-up input.'
          }
        })
    );
    await expectJson(await actor.context.get(`/api/audit-events/${queueEvent.id}`), 200).then(
      (detail) =>
        expect(detail).toMatchObject({
          id: queueEvent.id,
          queueItemId: queued.queueItemId,
          conversationPayload: {
            conversationId: sessionId,
            conversationTitle: sessionTitle,
            userMessage: 'Audit this accepted queued input.',
            queueItemId: queued.queueItemId
          }
        })
    );

    await expectJson(
      await actor.context.post(`/api/agent-runs/${continued.run.id}/cancel`, {
        headers: { 'x-csrf-token': actor.csrfToken },
        data: { nodeId }
      }),
      202
    );
    await connector.stop();
    connector = undefined;
    await expect
      .poll(async () => (await connectedNodeStatus(actor!.context, nodeId)) === false)
      .toBe(true);
    const offline = await actor.context.post(`/api/agent-sessions/${sessionId}/messages`, {
      headers: { 'x-csrf-token': actor.csrfToken },
      data: {
        nodeId,
        workspaceId,
        clientMessageId: 't151-offline',
        content: 'This rejected input must never persist.'
      }
    });
    await expectJson(offline, 409);
    await expect
      .poll(async () =>
        (await auditEvents(actor!.context)).some(
          (event) => event.clientMessageId === 't151-offline'
        )
      )
      .toBe(true);
    const rejectedEvent = auditEvent(await auditEvents(actor.context), 't151-offline');
    expect(rejectedEvent).toMatchObject({
      eventType: 'shared_conversation_input_rejected',
      result: 'FAILED',
      errorCode: 'NODE_OFFLINE',
      agentSessionId: sessionId,
      inputMode: 'SEND',
      hasConversationPayload: false
    });
    const rejectedDetail = await expectJson(
      await actor.context.get(`/api/audit-events/${rejectedEvent.id}`),
      200
    );
    expect(JSON.stringify(rejectedDetail)).not.toContain('This rejected input');
    expect(rejectedDetail).not.toHaveProperty('conversationPayload');
  } catch (error) {
    primaryFailure = { error };
  } finally {
    await cleanupSharedAuditFixture({
      stopConnector: async () => {
        await connector?.stop();
      },
      disposeActor: async () => {
        await actor?.context.dispose();
      },
      closeServer: async () => {
        await server?.close();
      },
      restoreEnvironment: restoreRunnerEnvironment,
      removeDirectory: () => rm(directory, { recursive: true, force: true }),
      ...(primaryFailure === undefined ? {} : { primaryFailure })
    });
  }
});

async function login(baseURL: string): Promise<{ context: APIRequestContext; csrfToken: string }> {
  const bootstrap = await playwrightRequest.newContext({ baseURL });
  try {
    const loginResponse = await bootstrap.post('/api/auth/login', {
      data: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
    });
    const login = await expectJson<{ csrfToken: string }>(loginResponse, 200);
    const changedResponse = await bootstrap.post('/api/auth/change-password', {
      headers: { cookie: responseCookie(loginResponse), 'x-csrf-token': login.csrfToken },
      data: { currentPassword: INITIAL_ADMIN_PASSWORD, password: 'SharedConversationAudit123!' }
    });
    const changed = await expectJson<{ csrfToken: string }>(changedResponse, 200);
    return {
      context: await playwrightRequest.newContext({
        baseURL,
        extraHTTPHeaders: { cookie: responseCookie(changedResponse) }
      }),
      csrfToken: changed.csrfToken
    };
  } finally {
    await bootstrap.dispose();
  }
}

async function connectedNode(context: APIRequestContext): Promise<string> {
  await expect.poll(async () => (await connectedNodeStatus(context)) !== undefined).toBe(true);
  const nodes = await expectJson<{ nodes: { id: string; connected: boolean }[] }>(
    await context.get('/api/nodes'),
    200
  );
  return nodes.nodes.find((node) => node.connected)?.id ?? '';
}

async function connectedNodeStatus(
  context: APIRequestContext,
  nodeId?: string
): Promise<boolean | undefined> {
  const response = await expectJson<{ nodes: { id: string; connected: boolean }[] }>(
    await context.get('/api/nodes'),
    200
  );
  const node =
    nodeId === undefined
      ? response.nodes.find((candidate) => candidate.connected)
      : response.nodes.find((candidate) => candidate.id === nodeId);
  return node?.connected;
}

async function auditEvents(context: APIRequestContext): Promise<AuditEvent[]> {
  return (
    await expectJson<{ events: AuditEvent[] }>(
      await context.get('/api/audit-events?limit=100'),
      200
    )
  ).events;
}

async function runStatus(
  context: APIRequestContext,
  sessionId: string,
  nodeId: string,
  runId: string
): Promise<string | undefined> {
  const response = await expectJson<{ runs: { id: string; status: string }[] }>(
    await context.get(`/api/agent-sessions/${sessionId}/runs?nodeId=${nodeId}`),
    200
  );
  return response.runs.find((run) => run.id === runId)?.status;
}

function auditEvent(events: readonly AuditEvent[], clientMessageId: string): AuditEvent {
  const event = events.find((candidate) => candidate.clientMessageId === clientMessageId);
  expect(event, `Missing audit event for ${clientMessageId}`).toBeDefined();
  return event!;
}

async function prepareGitWorkspace(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await executeFile('git', ['init', path]);
  await executeFile('git', ['-C', path, 'config', 'user.email', 'test@example.invalid']);
  await executeFile('git', ['-C', path, 'config', 'user.name', 'MyAgentRoam Test']);
  await writeFile(join(path, 'README.md'), 'shared audit workspace\n');
  await executeFile('git', ['-C', path, 'add', 'README.md']);
  await executeFile('git', ['-C', path, 'commit', '-m', 'test']);
}

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

async function expectJson<T>(response: APIResponse, status: number): Promise<T> {
  const body = (await response.json()) as T;
  expect(response.status(), JSON.stringify(body)).toBe(status);
  return body;
}

function responseCookie(response: APIResponse): string {
  const value = response.headers()['set-cookie'];
  if (value === undefined) throw new Error('SESSION_COOKIE_MISSING');
  return value.split(';', 1)[0]!;
}

interface AuditEvent {
  readonly id: string;
  readonly eventType: string;
  readonly result: string;
  readonly errorCode: string | null;
  readonly targetName: string | null;
  readonly agentSessionId: string | null;
  readonly runId: string | null;
  readonly clientMessageId: string | null;
  readonly queueItemId: string | null;
  readonly inputMode: string | null;
  readonly hasConversationPayload: boolean;
}
