import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { expect, test as base } from '@playwright/test';
import type {
  ConversationSegment,
  HostedConversationSnapshot
} from '../../packages/protocol/src/index.js';
// The Server owns the runtime WebSocket dependency used by the relay client.
// @ts-expect-error The dependency exposes no declaration for its ESM wrapper.
import WsClient from '../../ee/server/node_modules/ws/wrapper.mjs';
import { smokeTestTitles } from '../../scripts/test-e2e-policy.mjs';
import {
  createReleaseSmokeFixture,
  responseJson,
  terminalOutput,
  type ReleaseSmokeFixture
} from './support/release-smoke-fixture.js';
import { templateDraft } from './support/hosted-conversation-flow-fixture.js';

const test = base.extend<{ smoke: ReleaseSmokeFixture }>({
  smoke: async ({ baseURL }, use) => {
    const fixture = await createReleaseSmokeFixture(baseURL!);
    try {
      await use(fixture);
    } finally {
      await fixture.close();
    }
  }
});

test(smokeTestTitles[0]!, async ({ page, smoke }) => {
  expect((await page.request.get('/api/auth/me')).status()).toBe(401);
  const manifest = await responseJson<{ start_url: string }>(
    await page.request.get('/manifest.webmanifest')
  );
  expect(manifest.start_url).toBe('/console');
  await page.goto('/console');
  await expect(page.getByRole('textbox', { name: '账户' })).toBeVisible();
  const license = await responseJson<{ state: string }>(await smoke.api.get('/api/license'));
  expect(license.state).toBe('COMMUNITY');
  await smoke.activateLicense();
  expect(await responseJson(await smoke.api.get('/api/license'))).toMatchObject({
    state: 'ENTERPRISE_VALID'
  });
  await page.getByRole('textbox', { name: '账户' }).fill('admin');
  await page.getByLabel('密码', { exact: true }).fill(smoke.password);
  await page.getByRole('button', { name: '进入控制台', exact: true }).click();
  await expect(page.getByTestId('workbench-brand')).toBeVisible();
  const { version } = JSON.parse(await readFile('mar-web-console/package.json', 'utf8')) as {
    version: string;
  };
  expect(await responseJson(await page.request.get('/web-version.json'))).toMatchObject({
    version
  });
});

test(smokeTestTitles[1]!, async ({ page, smoke, baseURL }) => {
  await smoke.activateLicense();
  const { nodeId, displayName, workspaceId, modelId } = await smoke.connectNode();
  const started = await smoke.write<{ session: { id: string }; run: { id: string } }>(
    '/api/agent-sessions/start',
    {
      nodeId,
      workspaceId,
      runner: 'mar-agent',
      cwd: smoke.workspace,
      clientMessageId: 'release-smoke-start',
      content: 'Reply briefly.',
      model: modelId,
      effort: 'high',
      access: 'full-access'
    },
    201
  );
  const sessionPath = `/api/agent-sessions/${started.session.id}`;
  async function expectRunSucceeded(runId: string) {
    await expect
      .poll(
        async () =>
          (
            await responseJson<{ segments: ConversationSegment[] }>(
              await smoke.api.get(`${sessionPath}/turns?nodeId=${nodeId}&unit=SEGMENT`)
            )
          ).segments.find((segment) => segment.runId === runId)?.status,
        { timeout: 30_000 }
      )
      .toBe('SUCCEEDED');
  }
  await expectRunSucceeded(started.run.id);
  await expect
    .poll(
      async () =>
        JSON.stringify(
          await responseJson(
            await smoke.api.get(`${sessionPath}/turns?nodeId=${nodeId}&unit=SEGMENT`)
          )
        ),
      { timeout: 30_000 }
    )
    .toContain('Hosted conversation');
  const continuation = await smoke.write<{ run: { id: string } }>(
    `${sessionPath}/messages`,
    {
      nodeId,
      workspaceId,
      clientMessageId: 'release-smoke-followup',
      content: 'Reply again.',
      model: modelId
    },
    202
  );
  expect(continuation.run.id).not.toBe(started.run.id);
  await expectRunSucceeded(continuation.run.id);
  await expect.poll(() => smoke.modelRequests.length).toBeGreaterThanOrEqual(2);
  const file = `/api/workspaces/${workspaceId}/files/content?nodeId=${nodeId}&path=smoke.txt`;
  const fileResponse = await smoke.api.get(file);
  expect(fileResponse.status()).toBe(200);
  const original = await fileResponse.text();
  expect(original).toBe('release smoke file\n');
  await smoke.write(
    `/api/workspaces/${workspaceId}/files/write`,
    {
      nodeId,
      path: 'smoke.txt',
      content: 'release smoke updated\n',
      expectedRevision: createHash('sha256').update(original).digest('hex')
    },
    200,
    'PUT'
  );
  expect(await (await smoke.api.get(file)).text()).toBe('release smoke updated\n');
  expect(await readFile(join(smoke.workspace, 'smoke.txt'), 'utf8')).toBe(
    'release smoke updated\n'
  );
  expect((await page.request.get(file)).status()).toBe(401);
  await page.context().addCookies(await smoke.browserCookies());
  await page.goto(`/console?node=${nodeId}&workspace=${workspaceId}`);
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: displayName, exact: true })
    .click();
  await expect(
    page.locator('.workspace-tree').getByRole('button', { name: 'workspace', exact: true })
  ).toBeVisible();

  const opened = await smoke.write<{ terminal: { id: string } }>(
    '/api/terminals',
    { nodeId, workspaceId },
    201
  );
  const terminalId = opened.terminal.id;
  const { ticket } = await smoke.write<{ ticket: string }>(
    `/api/terminals/${terminalId}/attach-ticket`,
    { nodeId },
    201
  );
  const socket = new WsClient(
    `${baseURL!.replace('http', 'ws')}/api/terminals/${terminalId}/connect?ticket=${encodeURIComponent(ticket)}`,
    [],
    {
      headers: {
        origin: baseURL!,
        cookie: (await smoke.api.storageState()).cookies
          .map((cookie) => `${cookie.name}=${cookie.value}`)
          .join('; ')
      }
    }
  );
  const frames: string[] = [];
  socket.on('message', (data: unknown) => frames.push(String(data)));
  try {
    await once(socket, 'open');
    await expect.poll(() => frames.join('\n')).toContain('"type":"attach"');
    // Node is already required on both platforms; keep the marker out of input echo.
    const command = `node -p "'RELEASE_' + 'TERMINAL_OK'"\r`;
    socket.send(JSON.stringify({ type: 'input', terminalId, data: command }));
    await expect
      .poll(() => terminalOutput(frames))
      .toMatch(/(?:^|[\r\n])RELEASE_TERMINAL_OK[ \t]*[\r\n]/u);
  } finally {
    socket.close();
    await smoke.write(`/api/terminals/${terminalId}`, { nodeId }, 200, 'DELETE');
  }
});

test(smokeTestTitles[2]!, async ({ smoke, page }) => {
  await smoke.activateLicense();
  const { nodeId, workspaceId, providerModelId, organizationId } = await smoke.connectNode();
  const { nodes } = await responseJson<{
    nodes: {
      id: string;
      capabilities: { conversationHosting: { state: string; reasonCode?: string } };
    }[];
  }>(await smoke.api.get('/api/nodes'));
  expect(nodes.find((node) => node.id === nodeId)?.capabilities.conversationHosting).toMatchObject({
    state: 'AVAILABLE'
  });
  const draft = {
    ...templateDraft(nodeId, workspaceId),
    allowedModels: [{ modelId: providerModelId, name: 'Release smoke' }],
    defaultModelId: providerModelId
  };
  const created = await smoke.write<{ template: { id: string }; draft: { revision: number } }>(
    '/api/admin/conversation-templates',
    draft,
    201
  );
  const templateId = created.template.id;
  await smoke.write(
    '/api/resource-grants',
    {
      resourceType: 'TEMPLATE',
      templateId,
      targetType: 'ORGANIZATION',
      targetOrganizationId: organizationId
    },
    201
  );
  const requestId = 'release-smoke-publish';
  await smoke.write(
    `/api/admin/conversation-templates/${templateId}/publish`,
    {
      templateId,
      draftRevision: created.draft.revision,
      requestId
    },
    202
  );
  await expect
    .poll(
      async () =>
        (
          await responseJson<{ job: { status: string } }>(
            await smoke.api.get(
              `/api/admin/conversation-templates/${templateId}/publish-jobs/${requestId}`
            )
          )
        ).job.status,
      { timeout: 30_000 }
    )
    .toBe('SUCCEEDED');
  const result = await smoke.write<{ conversation: { id: string } }>(
    `/api/nodes/${nodeId}/hosted-conversations`,
    { templateId, clientRequestId: 'release-smoke-conversation' },
    201
  );
  const path = `/api/nodes/${nodeId}/hosted-conversations/${result.conversation.id}`;
  await smoke.write(
    `${path}/messages`,
    {
      clientMessageId: 'release-smoke-message',
      prompt: 'release-smoke-tool',
      attachmentIds: [],
      modelId: providerModelId
    },
    200
  );
  await expect
    .poll(
      async () => {
        const snapshot = await responseJson<HostedConversationSnapshot>(await smoke.api.get(path));
        return {
          status: snapshot.turns.at(-1)?.status,
          activeRun: snapshot.run,
          error: snapshot.error,
          replies: snapshot.turns
            .flatMap((turn) => turn.items)
            .filter((item) => item.kind === 'assistant_message')
            .map((item) => item.payload.text)
        };
      },
      {
        timeout: 30_000
      }
    )
    .toEqual({
      status: 'SUCCEEDED',
      activeRun: null,
      error: null,
      replies: ['Hosted conversation']
    });
  const snapshot = await responseJson<HostedConversationSnapshot>(await smoke.api.get(path));
  expect(snapshot.turns.flatMap((turn) => turn.items)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: 'command_execution',
        status: 'COMPLETED',
        payload: expect.objectContaining({
          exitCode: 0,
          output: expect.objectContaining({
            blocks: expect.arrayContaining([
              expect.objectContaining({
                channel: 'STDOUT',
                text: expect.stringContaining('RELEASE_HOSTED_SANDBOX_OK')
              })
            ])
          })
        })
      })
    ])
  );
  expect((await page.request.get(path)).status()).toBe(401);
});
