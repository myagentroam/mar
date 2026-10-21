import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { openSync, closeSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { expect, request, type APIResponse } from '@playwright/test';
import { createPlaywrightTestLicenseDocument } from './playwright-test-license.js';
import { makeWritable, startResponsesServer } from './hosted-conversation-flow-fixture.js';
import { INITIAL_ADMIN_PASSWORD } from '../../../packages/server-core/src/password.js';

export function terminalOutput(frames: readonly string[]): string {
  return stripVTControlCharacters(
    frames
      .map((raw) => {
        const frame = JSON.parse(raw) as { type: string; data?: string };
        return frame.type === 'output' ? (frame.data ?? '') : '';
      })
      .join('')
  );
}

export async function responseJson<T>(response: APIResponse, status = 200): Promise<T> {
  let code = '';
  if (response.status() !== status) {
    const body = (await response.json()) as { error?: { code?: string } };
    code = body.error?.code ?? 'HTTP_STATUS_UNEXPECTED';
  }
  expect(response.status(), `Request failed: ${new URL(response.url()).pathname} ${code}`).toBe(
    status
  );
  return (await response.json()) as T;
}

export async function createReleaseSmokeFixture(baseURL: string) {
  // Hosted templates cannot alias reserved sandbox roots such as /tmp.
  const root = await mkdtemp(resolve('test/runs/mar-release-smoke-'));
  const workspace = join(root, 'workspace');
  const api = await request.newContext({ baseURL, extraHTTPHeaders: { origin: baseURL } });
  let node: ChildProcess | undefined;
  let modelServer: Awaited<ReturnType<typeof startResponsesServer>> | undefined;
  let csrfToken = '';
  let changedPassword = false;
  const password = `Smoke-${randomUUID()}!`;
  const modelRequests: unknown[] = [];

  async function write<T>(path: string, data: unknown, status = 200, method = 'POST') {
    return await responseJson<T>(
      await api.fetch(path, {
        method,
        headers: { 'x-csrf-token': csrfToken },
        data
      }),
      status
    );
  }

  async function close() {
    try {
      if (node && node.exitCode === null && node.signalCode === null) {
        const closed = once(node, 'exit');
        node.kill('SIGTERM');
        const timer = setTimeout(() => node?.kill('SIGKILL'), 5_000);
        try {
          await closed;
        } finally {
          clearTimeout(timer);
        }
      }
    } finally {
      try {
        if (modelServer) {
          modelServer.server.closeAllConnections();
          await new Promise<void>((done, reject) =>
            modelServer!.server.close((error) => (error ? reject(error) : done()))
          );
        }
      } finally {
        try {
          if (changedPassword)
            await write('/api/auth/change-password', {
              currentPassword: password,
              password: INITIAL_ADMIN_PASSWORD
            });
        } finally {
          await api.dispose();
          await makeWritable(root);
          await rm(root, { recursive: true, force: true });
        }
      }
    }
  }

  try {
    await mkdir(workspace);
    await writeFile(join(workspace, 'smoke.txt'), 'release smoke file\n');
    await writeFile(join(workspace, 'AGENTS.template.md'), 'Reply briefly.\n');
    const login = await responseJson<{ csrfToken: string }>(
      await api.post('/api/auth/login', {
        data: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
      })
    );
    csrfToken = login.csrfToken;
    const changed = await write<{ csrfToken: string }>('/api/auth/change-password', {
      currentPassword: INITIAL_ADMIN_PASSWORD,
      password
    });
    changedPassword = true;
    csrfToken = changed.csrfToken;
    return {
      api,
      password,
      workspace,
      root,
      write,
      close,
      modelRequests,
      async browserCookies() {
        // Console CSRF renewal must not invalidate the API setup session.
        const browserApi = await request.newContext({ baseURL });
        try {
          await responseJson(
            await browserApi.post('/api/auth/login', {
              data: { username: 'admin', password }
            })
          );
          return (await browserApi.storageState()).cookies;
        } finally {
          await browserApi.dispose();
        }
      },
      async activateLicense() {
        await write('/api/license/import', { document: createPlaywrightTestLicenseDocument() });
      },
      async connectNode() {
        const keyPath = join(root, 'model-key.pem');
        const certPath = join(root, 'model-cert.pem');
        execFileSync(
          'openssl',
          [
            'req',
            '-x509',
            '-newkey',
            'rsa:2048',
            '-nodes',
            '-days',
            '1',
            '-keyout',
            keyPath,
            '-out',
            certPath,
            '-subj',
            '/CN=localhost',
            '-addext',
            'subjectAltName=IP:127.0.0.1'
          ],
          { stdio: 'ignore', timeout: 15_000 }
        );
        modelServer = await startResponsesServer(modelRequests, workspace, {
          key: await readFile(keyPath, 'utf8'),
          cert: await readFile(certPath, 'utf8')
        });
        const displayName = `Release smoke ${randomUUID()}`;
        const { organizations } = await responseJson<{
          organizations: { id: number; parentOrganizationId: number | null }[];
        }>(await api.get('/api/organizations'));
        const organization = organizations.find((item) => item.parentOrganizationId === null);
        expect(organization, 'Fresh enterprise database has a root organization').toBeDefined();
        const ownership = {
          ownerType: 'ORGANIZATION',
          ownerOrganizationId: organization!.id
        };
        const registration = await write<{ token: string }>('/api/node-registration-tokens', {
          displayName,
          ownership
        });
        const configPath = join(root, 'node.json');
        const serverURL = new URL(baseURL);
        serverURL.port = process.env['MAR_E2E_SERVER_PORT'] ?? String(Number(serverURL.port) + 1);
        await writeFile(
          configPath,
          JSON.stringify({
            serverUrl: serverURL.origin,
            allowedRoots: [workspace],
            dataDirectory: join(root, 'node-data'),
            registrationToken: registration.token,
            conversationHosting: {
              enabled: process.platform === 'linux',
              storeDirectory: 'hosted-conversations'
            }
          })
        );
        await mkdir(join(root, 'home'));
        const logPath = resolve(
          'test/runs',
          `release-node-${process.env['MAR_TEST_RUN_ID']}-${randomUUID()}.log`
        );
        const log = openSync(logPath, 'wx', 0o600);
        try {
          const spawned = spawn(
            process.execPath,
            ['mar-node/dist/main.js', 'run', '--config', configPath],
            {
              cwd: process.cwd(),
              env: {
                ...process.env,
                HOME: join(root, 'home'),
                USERPROFILE: join(root, 'home'),
                NODE_EXTRA_CA_CERTS: certPath
              },
              stdio: ['ignore', log, log]
            }
          );
          await once(spawned, 'spawn');
          node = spawned;
        } finally {
          closeSync(log);
        }
        let nodeId = '';
        await expect
          .poll(
            async () => {
              if (node!.exitCode !== null || node!.signalCode !== null)
                throw new Error(`SMOKE_NODE_EXITED: ${logPath}`);
              const { nodes } = await responseJson<{
                nodes: { id: string; connected: boolean; displayName: string }[];
              }>(await api.get('/api/nodes'));
              nodeId =
                nodes.find((item) => item.connected && item.displayName === displayName)?.id ?? '';
              return nodeId;
            },
            { timeout: 30_000 }
          )
          .not.toBe('');
        const created = await write<{ workspace: { id: string } }>(
          '/api/workspaces',
          {
            nodeId,
            path: workspace,
            ownership
          },
          201
        );
        const providerModelId = `release-smoke-${randomUUID()}`;
        const model = await write<{ model: { id: string } }>(
          '/api/admin/mar-agent/models',
          {
            name: `Release model ${randomUUID()}`,
            ownership,
            protocol: 'OPENAI_RESPONSES',
            baseUrl: `${modelServer.baseUrl}/v1`,
            apiKey: 'release-smoke-only',
            modelId: providerModelId,
            contextWindowTokens: 128_000,
            maxOutputTokens: 4_096,
            inputCapabilities: ['TEXT'],
            outputCapabilities: ['TEXT'],
            reasoningEfforts: ['high'],
            defaultReasoningEffort: 'high',
            hostedWebSearch: false,
            responsesPreviousResponseId: false,
            enabled: true,
            sortOrder: 0
          },
          201
        );
        await write(
          '/api/resource-grants',
          {
            resourceType: 'MODEL',
            modelId: model.model.id,
            targetType: 'ORGANIZATION',
            targetOrganizationId: organization!.id
          },
          201
        );
        return {
          nodeId,
          displayName,
          workspaceId: created.workspace.id,
          modelId: model.model.id,
          providerModelId,
          organizationId: organization!.id
        };
      }
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export type ReleaseSmokeFixture = Awaited<ReturnType<typeof createReleaseSmokeFixture>>;
