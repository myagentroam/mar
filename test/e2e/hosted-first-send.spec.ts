import { expect, test, type Page } from '@playwright/test';
import { hostedConversationSnapshotSchema } from '../../packages/protocol/src/index.js';
import {
  fulfillMockHostedConversationWatch,
  json,
  mockConsoleApi
} from './support/web-console-api.js';

const template = {
  id: 'template-1',
  nodeId: 'node-1',
  name: 'First message template',
  description: '',
  status: 'ACTIVE',
  currentVersionId: 'version-1',
  available: true,
  createdAt: 1,
  updatedAt: 1
};
const created = hostedConversationSnapshotSchema.parse({
  conversation: {
    id: 'created',
    nodeId: 'node-1',
    sessionId: 'created-session',
    templateId: 'template-1',
    templateName: template.name,
    activeVersionId: 'version-1',
    title: 'Created draft',
    titleSource: 'AUTO',
    pinnedAt: null,
    status: 'ACTIVE',
    modelId: 'model-1',
    activity: { status: 'IDLE', updatedAt: 1, version: 1 },
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 1
  },
  template,
  run: null,
  turns: [],
  historyNextCursor: null,
  files: [],
  error: null,
  snapshotSequence: 1,
  models: [
    {
      id: 'model-1',
      name: 'Model',
      protocol: 'OPENAI_RESPONSES',
      baseUrl: 'https://model.test',
      modelId: 'model',
      contextWindowTokens: 10000,
      maxOutputTokens: 1000,
      inputCapabilities: ['TEXT'],
      outputCapabilities: ['TEXT'],
      reasoningEfforts: [],
      hostedWebSearch: false,
      responsesPreviousResponseId: false,
      enabled: true,
      sortOrder: 0,
      apiKeyConfigured: true
    }
  ]
});
const history = {
  ...created,
  conversation: {
    ...created.conversation,
    id: 'history',
    sessionId: 'history-session',
    title: 'Existing history'
  }
};

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function openDraft(
  page: Page,
  options: { failWatch?: boolean; createGate?: Promise<void>; uploadGate?: Promise<void> } = {}
) {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  let createFinished = false;
  let failWatch = options.failWatch === true;
  let receivedBytes = 0;
  let uploadSize = 0;
  const upload = (completed = false) => ({
    upload: {
      uploadId: 'first-upload',
      conversationId: 'created',
      name: 'original.txt',
      mimeType: 'text/plain',
      size: uploadSize,
      receivedBytes,
      status: completed ? 'COMPLETED' : 'UPLOADING',
      ...(completed
        ? {
            file: {
              id: 'original-file',
              conversationId: 'created',
              category: 'UPLOAD',
              relativePath: 'original.txt',
              displayName: 'original.txt',
              mimeType: 'text/plain',
              size: uploadSize,
              source: 'USER',
              createdAt: 1,
              updatedAt: 1
            }
          }
        : {})
    }
  });
  await page.route('**/api/conversation-templates', (route) =>
    json(route, { templates: [template] })
  );
  await page.route(/\/api\/hosted-conversations\?limit=20$/, (route) =>
    json(route, {
      items: createFinished ? [created.conversation, history.conversation] : [history.conversation],
      nextCursor: null
    })
  );
  await page.route(/\/api\/nodes\/node-1\/hosted-conversations(?:\/.*)?$/, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    const body =
      method === 'POST' ? (route.request().postDataJSON() as Record<string, unknown>) : {};
    if (method === 'POST') requests.push({ path, body });
    if (path.endsWith('/watch')) {
      if (path.includes('/created/') && method === 'POST' && failWatch) {
        await json(route, { error: 'NODE_OFFLINE' }, 503);
        return;
      }
      await fulfillMockHostedConversationWatch(
        page,
        route,
        path.includes('/history/') ? 'history' : 'created',
        path.includes('/history/') ? history : created
      );
    } else if (path.endsWith('/hosted-conversations') && method === 'POST') {
      await options.createGate;
      createFinished = true;
      await json(route, created);
    } else if (path.endsWith('/uploads/preflight')) {
      await json(route, { files: [{ name: 'original.txt', status: 'READY' }] });
    } else if (path.endsWith('/uploads')) {
      uploadSize = body['size'] as number;
      await json(route, upload());
    } else if (path.endsWith('/chunks')) {
      await options.uploadGate;
      receivedBytes = uploadSize;
      await json(route, upload());
    } else if (path.endsWith('/complete')) {
      await json(route, upload(true));
    } else if (path.endsWith('/messages')) {
      await json(route, {
        conversation: created.conversation,
        run: { id: 'first-run', status: 'RUNNING', startedAt: 2, completedAt: null }
      });
    } else if (path.endsWith('/files')) {
      await json(route, { files: [] });
    } else if (path.endsWith('/history')) {
      await json(route, history);
    } else if (path.endsWith('/created')) {
      await json(route, created);
    } else {
      await route.fallback();
    }
  });
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '对话', exact: true }).click();
  await page.locator('.history-create-button').click();
  const composer = page.locator('.conversation-create-panel .composer');
  await composer.locator('textarea').fill('Original first message');
  await page.locator('.conversation-create-panel input[type=file]').setInputFiles({
    name: 'original.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Original attachment bytes')
  });
  await expect(page.locator('.conversation-create-panel .hosted-attachments')).toContainText(
    'original.txt'
  );
  const send = composer.locator('.hosted-send-button');
  await send.click();
  return {
    requests,
    send,
    allowWatch: () => {
      failWatch = false;
    },
    messages: () => requests.filter((request) => request.path.endsWith('/messages')),
    writes: () => requests.filter((request) => !request.path.endsWith('/watch'))
  };
}

test('Hosted first send retains attachment bytes after initial Watch failure and explicit recovery retry', async ({
  page
}) => {
  const f = await openDraft(page, { failWatch: true });
  await expect(page.locator('.el-message')).toBeVisible();
  await expect(f.send).toBeDisabled();
  await expect(page.locator('.conversation-create-panel .hosted-model-trigger')).toBeDisabled();
  expect(f.writes()).toHaveLength(1);
  expect(f.messages()).toHaveLength(0);
  f.allowWatch();
  // Resume the same subscription through the existing page lifecycle, not a second Watch.
  await page.evaluate(() => (window.WebSocket as unknown as { closeActive(): void }).closeActive());
  await expect(f.send).toBeEnabled();
  expect(f.messages()).toHaveLength(0);
  await f.send.click();
  await expect.poll(() => f.messages().length).toBe(1);
  const writes = f.writes();
  expect(writes.map((request) => request.path.split('/').at(-1))).toEqual([
    'hosted-conversations',
    'preflight',
    'uploads',
    'chunks',
    'complete',
    'messages'
  ]);
  expect(Buffer.from(String(writes[3]!.body['dataBase64']), 'base64').toString()).toBe(
    'Original attachment bytes'
  );
  expect(f.messages()[0]!.body).toMatchObject({
    prompt: 'Original first message',
    attachmentIds: ['original-file']
  });
  await expect(page.locator('.conversation-create-panel')).toHaveCount(0);
});

for (const stage of ['create', 'upload'] as const) {
  test(`Hosted first send keeps history selection and original draft across the ${stage} gate`, async ({
    page
  }) => {
    const pending = gate();
    const f = await openDraft(
      page,
      stage === 'create' ? { createGate: pending.promise } : { uploadGate: pending.promise }
    );
    await expect
      .poll(() =>
        f
          .writes()
          .some((request) =>
            request.path.endsWith(stage === 'create' ? '/hosted-conversations' : '/chunks')
          )
      )
      .toBe(true);
    await page.locator('.history-open', { hasText: 'Existing history' }).click();
    await expect(page.locator('.history-open[aria-current=page]')).toContainText(
      'Existing history'
    );
    pending.release();
    await expect(page.locator('.el-message')).toContainText('草稿已保留');
    await expect(page.locator('.history-open[aria-current=page]')).toContainText(
      'Existing history'
    );
    expect(f.messages()).toHaveLength(0);
    expect(f.requests.some((request) => request.path.endsWith('/cancel'))).toBe(false);
    await page.locator('.history-create-button').click();
    await expect(page.locator('.conversation-create-panel textarea')).toHaveValue(
      'Original first message'
    );
    await page.locator('.conversation-create-panel .hosted-send-button').click();
    await expect.poll(() => f.messages().length).toBe(1);
    expect(
      f.writes().filter((request) => request.path.endsWith('/hosted-conversations'))
    ).toHaveLength(1);
    expect(f.writes().filter((request) => request.path.endsWith('/uploads'))).toHaveLength(1);
    expect(f.messages()[0]!.body['attachmentIds']).toEqual(['original-file']);
  });

  test(`Hosted first send does not cancel submitted writes or change routes after unmount at the ${stage} gate`, async ({
    page
  }) => {
    const pending = gate();
    const f = await openDraft(
      page,
      stage === 'create' ? { createGate: pending.promise } : { uploadGate: pending.promise }
    );
    await expect
      .poll(() =>
        f
          .writes()
          .some((request) =>
            request.path.endsWith(stage === 'create' ? '/hosted-conversations' : '/chunks')
          )
      )
      .toBe(true);
    await page.getByRole('button', { name: '工作', exact: true }).click();
    await expect(page.locator('.hosted-workspace')).toHaveCount(0);
    const route = page.url();
    pending.release();
    await expect(page.locator('.el-message')).toContainText('已提交的创建或上传不会撤销');
    await expect(page.locator('.el-message')).not.toContainText('草稿已保留');
    expect(page.url()).toBe(route);
    expect(f.messages()).toHaveLength(0);
    expect(f.requests.some((request) => request.path.endsWith('/cancel'))).toBe(false);
    if (stage === 'upload')
      expect(f.writes().some((request) => request.path.endsWith('/complete'))).toBe(true);
  });
}
