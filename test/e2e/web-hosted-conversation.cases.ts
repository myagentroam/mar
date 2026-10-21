import { expect, test, type Page } from '@playwright/test';
import {
  hostedConversationSnapshotSchema,
  serializeComposerTag
} from '../../packages/protocol/src/index.js';
import { verifyConversationThemes } from './support/conversation-visual.js';
import {
  emitMockHostedConversationEvent,
  fulfillMockHostedConversationWatch,
  fulfillMockSessionWatch,
  json,
  mockConsoleApi,
  write
} from './support/web-console-api.js';
import { replaceActiveHostedConversationMessage } from './support/hosted-conversation-composer.js';

for (const destination of ['conversations', 'settings'] as const) {
  test(`Late draft creation respects ${destination} navigation and resumes one ordinary Watch`, async ({
    page
  }) => {
    await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
    const created = {
      id: 'session-created-late',
      workspaceId: 'workspace-1',
      runner: 'codex',
      externalSessionId: 'native-created-late',
      activity: 'IDLE',
      control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    let published = false;
    const ordinaryWatches: Record<string, unknown>[] = [];
    const hostedWatches: string[] = [];
    await page.route('**/api/agent-sessions/start', async (route) => {
      started = true;
      await gate;
      published = true;
      await json(route, {
        session: created,
        run: { id: 'run-created-late', sessionId: created.id, status: 'SUCCEEDED' }
      });
    });
    await page.route('**/api/agent-sessions?nodeId=node-1*', (route) =>
      json(route, { sessions: published ? [created] : [], nextCursor: null })
    );
    await page.route('**/api/agent-sessions/session-created-late?nodeId=node-1', (route) =>
      json(route, { session: created })
    );
    await page.route('**/api/agent-sessions/session-created-late/watch', async (route) => {
      if (route.request().method() === 'POST') {
        ordinaryWatches.push(route.request().postDataJSON() as Record<string, unknown>);
        await fulfillMockSessionWatch(page, route, created, {
          kind: 'session-watch-snapshot',
          sequence: 1,
          session: created,
          runs: [],
          queue: { version: 0, paused: false, items: [] },
          context: null,
          conversation: { unit: 'SEGMENT', segments: [], nextCursor: null }
        });
      } else await json(route, {});
    });
    await page.route(/\/api\/hosted-conversations\?limit=20$/, (route) =>
      json(route, { items: [conversation], nextCursor: null })
    );
    await page.route('**/api/conversation-templates', (route) =>
      json(route, { templates: [snapshot.template] })
    );
    await page.route(
      '**/api/nodes/node-1/hosted-conversations/conversation-1/watch',
      async (route) => {
        hostedWatches.push(route.request().method());
        if (route.request().method() === 'POST')
          await fulfillMockHostedConversationWatch(page, route, conversation.id, snapshot);
        else await json(route, {});
      }
    );

    await page.goto('/console');
    await page.getByRole('button', { name: '进入控制台' }).click();
    await page.getByRole('button', { name: '工作', exact: true }).click();
    await page
      .locator('.workspace-tree')
      .getByRole('button', { name: /node-1/ })
      .click();
    await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
    await page
      .getByRole('textbox', { name: '输入消息', exact: true })
      .fill('Late draft Watch admission');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(() => started).toBe(true);
    await page
      .getByRole('button', {
        name: destination === 'conversations' ? '对话' : '设置',
        exact: true
      })
      .click();
    if (destination === 'conversations') {
      await expect(page.locator('.hosted-timeline-scroll')).toBeVisible();
      await expect.poll(() => hostedWatches.filter((method) => method === 'POST').length).toBe(1);
    }
    const hostedBefore = [...hostedWatches];
    release();
    // Persistence is a completion barrier for the real page's response handling, not a timer.
    await expect
      .poll(() =>
        page.evaluate(
          () => JSON.parse(localStorage.getItem('mar.workbench.selection.v1') ?? '{}').sessionId
        )
      )
      .toBe(created.id);
    expect(ordinaryWatches).toHaveLength(0);
    expect(hostedWatches).toEqual(hostedBefore);
    await page.getByRole('button', { name: '工作', exact: true }).click();
    await expect(
      page.getByRole('button', { name: `复制会话 ID：${created.id}`, exact: true })
    ).toBeVisible();
    await expect
      .poll(() => ordinaryWatches.filter((watch) => watch['mode'] === 'initial').length)
      .toBe(1);
    await expect(page.getByRole('textbox', { name: '输入消息', exact: true })).toHaveValue('');
    expect(ordinaryWatches.filter((watch) => watch['mode'] === 'initial')).toHaveLength(1);
  });
}

const longHostedMessage = Array.from(
  { length: 40 },
  (_, index) => `审查明细 ${index + 1}：确认独立对话滚动区域能够容纳长内容。`
).join('\n\n');

const conversation = {
  id: 'conversation-1',
  nodeId: 'node-1',
  sessionId: 'session-hosted-1',
  templateId: 'template-1',
  templateName: '代码审查',
  activeVersionId: 'version-1',
  title: '审查发布变更',
  titleSource: 'AUTO',
  pinnedAt: Date.UTC(2026, 8, 1, 2),
  status: 'ACTIVE',
  modelId: 'model-1',
  createdAt: Date.UTC(2026, 8, 1, 1),
  updatedAt: Date.UTC(2026, 8, 1, 2),
  lastActivityAt: Date.UTC(2026, 8, 1, 2)
} as const;

const secondConversation = {
  ...conversation,
  id: 'conversation-2',
  nodeId: 'node-2',
  sessionId: 'session-hosted-2',
  templateId: 'template-2',
  templateName: '战略调研',
  activeVersionId: 'version-2',
  title: 'New conversation',
  titleSource: 'DEFAULT',
  createdAt: Date.UTC(2026, 8, 1, 0),
  updatedAt: Date.UTC(2026, 8, 1, 0),
  lastActivityAt: Date.UTC(2026, 8, 1, 0)
} as const;

const snapshot = {
  conversation,
  template: {
    id: 'template-1',
    nodeId: 'node-1',
    name: '代码审查',
    description: '在隔离环境中审查发布变更。',
    status: 'ACTIVE',
    currentVersionId: 'version-1',
    available: true,
    createdAt: Date.UTC(2026, 8, 1, 1),
    updatedAt: Date.UTC(2026, 8, 1, 1)
  },
  run: null,
  turns: [
    {
      id: 'turn-1',
      sessionId: 'session-hosted-1',
      runId: 'run-1',
      userItemId: null,
      status: 'SUCCEEDED',
      model: 'model-1',
      effort: 'high',
      access: 'full-access',
      items: [
        {
          id: 'steer-user',
          sessionId: 'session-hosted-1',
          turnId: 'turn-1',
          runId: 'run-1',
          parentItemId: null,
          sourceSequence: null,
          revision: 1,
          status: 'COMPLETED',
          startedAt: Date.UTC(2026, 8, 1, 1, 29),
          completedAt: Date.UTC(2026, 8, 1, 1, 29),
          kind: 'user_message',
          payload: {
            clientMessageId: 'steer-message',
            delivery: 'ACCEPTED',
            text: serializeComposerTag('mar_steer', { message: 'Review the resume path.' })
          }
        },
        {
          id: 'assistant-1',
          sessionId: 'session-hosted-1',
          turnId: 'turn-1',
          runId: 'run-1',
          parentItemId: null,
          sourceSequence: 1,
          revision: 1,
          status: 'COMPLETED',
          startedAt: Date.UTC(2026, 8, 1, 1, 30),
          completedAt: Date.UTC(2026, 8, 1, 1, 31),
          kind: 'assistant_message',
          payload: {
            text: '已完成隔离环境中的审查。',
            format: 'markdown',
            model: 'model-1'
          }
        },
        {
          id: 'assistant-long',
          sessionId: 'session-hosted-1',
          turnId: 'turn-1',
          runId: 'run-1',
          parentItemId: null,
          sourceSequence: 2,
          revision: 1,
          status: 'COMPLETED',
          startedAt: Date.UTC(2026, 8, 1, 1, 31),
          completedAt: Date.UTC(2026, 8, 1, 1, 32),
          kind: 'assistant_message',
          payload: {
            text: `[查看结果文件](/workspace/output/result.txt)\n\n${longHostedMessage}`,
            format: 'markdown',
            model: 'model-1'
          }
        }
      ],
      startedAt: Date.UTC(2026, 8, 1, 1, 30),
      completedAt: Date.UTC(2026, 8, 1, 1, 31)
    }
  ],
  historyNextCursor: 'hosted-history-older',
  files: [
    {
      id: 'file-1',
      conversationId: 'conversation-1',
      category: 'OUTPUT',
      relativePath: 'result.txt',
      displayName: 'result.txt',
      mimeType: 'text/plain',
      size: 6,
      source: 'AGENT',
      turnId: 'turn-1',
      itemId: 'assistant-1',
      createdAt: Date.UTC(2026, 8, 1, 1, 31),
      updatedAt: Date.UTC(2026, 8, 1, 1, 31)
    },
    {
      id: 'file-output-summary',
      conversationId: 'conversation-1',
      category: 'OUTPUT',
      relativePath: 'reports/summary.txt',
      displayName: 'summary.txt',
      mimeType: 'text/plain',
      size: 7,
      source: 'AGENT',
      createdAt: Date.UTC(2026, 8, 1, 1, 32),
      updatedAt: Date.UTC(2026, 8, 1, 1, 32)
    },
    {
      id: 'file-output-q1',
      conversationId: 'conversation-1',
      category: 'OUTPUT',
      relativePath: 'reports/2026/q1.txt',
      displayName: 'q1.txt',
      mimeType: 'text/plain',
      size: 2,
      source: 'AGENT',
      createdAt: Date.UTC(2026, 8, 1, 1, 33),
      updatedAt: Date.UTC(2026, 8, 1, 1, 33)
    },
    {
      id: 'file-upload-source',
      conversationId: 'conversation-1',
      category: 'UPLOAD',
      relativePath: 'references/source.txt',
      displayName: 'source.txt',
      mimeType: 'text/plain',
      size: 6,
      source: 'USER',
      createdAt: Date.UTC(2026, 8, 1, 1, 34),
      updatedAt: Date.UTC(2026, 8, 1, 1, 34)
    }
  ],
  nodeAppVersion: '0.9.65',
  models: [
    {
      id: 'model-1',
      name: 'Model One',
      protocol: 'OPENAI_RESPONSES',
      baseUrl: 'https://models.example.test/v1',
      modelId: 'model-one',
      contextWindowTokens: 100_000,
      maxOutputTokens: 4096,
      inputCapabilities: ['TEXT'],
      outputCapabilities: ['TEXT'],
      reasoningEfforts: ['high'],
      hostedWebSearch: false,
      responsesPreviousResponseId: false,
      enabled: true,
      sortOrder: 0,
      apiKeyConfigured: true
    }
  ],
  error: null,
  snapshotSequence: 1
} as const;
hostedConversationSnapshotSchema.parse(snapshot);

test('Touch conversation content preserves browser menus while desktop content disables them', async ({
  browser,
  browserName,
  page
}) => {
  test.skip(browserName !== 'chromium', 'Mobile pointer emulation requires Chromium');

  async function verifyConversationMenus(target: Page, nativeMenu: boolean): Promise<void> {
    await mockConsoleApi(target, 'MANAGED', ['history.read', 'turn.start'], []);
    await target.route(/\/api\/hosted-conversations\?limit=20$/, (route) =>
      json(route, { items: [conversation], nextCursor: null })
    );
    await target.route('**/api/conversation-templates', (route) =>
      json(route, { templates: [snapshot.template] })
    );
    await target.route(
      /\/api\/nodes\/node-1\/hosted-conversations\/conversation-1\/watch$/,
      (route) => fulfillMockHostedConversationWatch(target, route, conversation.id, snapshot)
    );
    await target.goto('/console');
    await target.getByRole('button', { name: '进入控制台' }).click();
    const workButton = target.getByRole('button', { name: '工作', exact: true });
    await workButton.click();
    await target
      .locator('.workspace-tree')
      .getByRole('button', { name: /node-1/ })
      .click();
    if (nativeMenu) await workButton.click();
    await target.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
    if (nativeMenu) await target.getByRole('button', { name: '打开会话列表' }).click();
    await target.locator('.session-list .session-link').first().click();

    const contextMenuPrevented = async (selector: string): Promise<boolean> => {
      const message = target.locator(selector).first();
      await expect(message).toBeVisible();
      return message.evaluate((element) => {
        const event = new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          button: 2
        });
        element.dispatchEvent(event);
        return event.defaultPrevented;
      });
    };
    expect(
      await contextMenuPrevented(
        '.conversation-panel .conversation-item.assistant_message .agent-markdown'
      )
    ).toBe(!nativeMenu);
    await target.getByRole('button', { name: '对话', exact: true }).click();
    expect(
      await contextMenuPrevented(
        '.hosted-workspace .conversation-item.assistant_message .agent-markdown'
      )
    ).toBe(!nativeMenu);
  }

  await verifyConversationMenus(page, false);
  const desktopMessage = page
    .locator('.hosted-workspace .conversation-item.assistant_message .agent-markdown')
    .first();
  const pointerMenus = await desktopMessage.evaluate((element) => {
    const prevented = (pointerType: string) => {
      const event = new PointerEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        pointerType
      });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    };
    return { mouse: prevented('mouse'), touch: prevented('touch') };
  });
  expect(pointerMenus).toEqual({ mouse: true, touch: false });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await desktopMessage.evaluate((element) => {
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    })
  ).toBe(true);
  const mobile = await browser.newContext({
    baseURL: new URL(page.url()).origin,
    locale: 'zh-CN',
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true
  });
  try {
    const mobilePage = await mobile.newPage();
    await verifyConversationMenus(mobilePage, true);
  } finally {
    await mobile.close();
  }
});

test('Returning to a selected hosted conversation reconciles only its unread notifications', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await page.route(/\/api\/hosted-conversations\?limit=20$/, (route) =>
    json(route, { items: [conversation], nextCursor: null })
  );
  await page.route('**/api/conversation-templates', (route) =>
    json(route, { templates: [snapshot.template] })
  );
  await page.route(/\/api\/nodes\/node-1\/hosted-conversations\/conversation-1\/watch$/, (route) =>
    fulfillMockHostedConversationWatch(page, route, conversation.id, snapshot)
  );
  const now = Date.now();
  let notifications: {
    id: string;
    kind: string;
    title: string;
    message: string;
    createdAt: number;
    updatedAt: number;
    expiresAt: number;
    read: boolean;
    target: {
      targetType: string;
      nodeId: string;
      conversationId: string;
      conversationName: string;
    };
  }[] = [];
  const reads: unknown[] = [];
  await page.route('**/api/notifications', (route) => json(route, { notifications }));
  await page.route('**/api/notifications/conversation/read', (route) => {
    const target = route.request().postDataJSON();
    reads.push(target);
    notifications = notifications.map((entry) => ({
      ...entry,
      read:
        entry.read ||
        (entry.target.nodeId === target.nodeId &&
          entry.target.conversationId === target.conversationId)
    }));
    return json(route, {});
  });
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '对话', exact: true }).click();
  await expect(page.locator('.hosted-timeline-scroll')).toBeVisible();
  await expect.poll(() => reads.length).toBeGreaterThan(0);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  notifications = [conversation.id, 'conversation-other'].map((conversationId) => ({
    id: conversationId,
    kind: 'run',
    title: 'Completed',
    message: 'Run completed',
    createdAt: now,
    updatedAt: now,
    expiresAt: now + 60_000,
    read: false,
    target: {
      targetType: 'HOSTED_CONVERSATION',
      nodeId: 'node-1',
      conversationId,
      conversationName: 'Review'
    }
  }));
  const center = page.getByRole('button', { name: '打开通知中心' });
  await center.click();
  await expect(center.locator('.workbench-notification-badge')).toHaveText('2');
  await center.click();
  const beforeReturn = reads.length;
  await page.getByRole('button', { name: '对话', exact: true }).click();
  await expect(page.locator('.hosted-timeline-scroll')).toBeVisible();
  await expect(center.locator('.workbench-notification-badge')).toHaveText('1');
  expect(reads.slice(beforeReturn)).toEqual([
    { nodeId: 'node-1', conversationId: conversation.id }
  ]);
  expect(notifications.find((entry) => entry.id === 'conversation-other')?.read).toBe(false);
});

test('Hosted conversation cards share visual hierarchy across themes and viewport sizes', async ({
  page
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    let clipboardText = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: async () => clipboardText,
        writeText: async (text: string) => {
          clipboardText = text;
        }
      }
    });
  });
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  const visualTurn = snapshot.turns[0];
  const visualMessage = visualTurn.items[0];
  const visualSnapshot = {
    ...snapshot,
    historyNextCursor: null,
    turns: [
      {
        ...visualTurn,
        items: [
          {
            ...visualMessage,
            id: 'hosted-visual-reasoning',
            kind: 'reasoning_summary',
            payload: { sections: [{ index: 0, text: '检查托管会话的阅读层级。' }] }
          },
          {
            ...visualMessage,
            payload: {
              ...visualMessage.payload,
              text: '## 审查结果 / Review results\n\n已完成 `theme tokens` 检查。\n\n- 正文与画布分层\n- 已完成的过程保持紧凑\n\n```ts\nconst result = "complete";\n```'
            }
          }
        ]
      }
    ]
  };
  await page.route(/\/api\/hosted-conversations\?limit=20$/, (route) =>
    json(route, { items: [conversation], nextCursor: null })
  );
  await page.route('**/api/conversation-templates', (route) =>
    json(route, { templates: [snapshot.template] })
  );
  await page.route(/\/api\/nodes\/node-1\/hosted-conversations\/conversation-1\/watch$/, (route) =>
    fulfillMockHostedConversationWatch(page, route, conversation.id, visualSnapshot)
  );
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '对话', exact: true }).click();
  await verifyConversationThemes(page, testInfo, 'hosted-desktop');
  const codeCopy = page.locator('.agent-markdown-code-copy').first();
  await codeCopy.click();
  await expect(codeCopy).toHaveAttribute('aria-label', '代码已复制');
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain('const result = "complete";');
  await expect(codeCopy).toHaveAttribute('aria-label', '复制代码', { timeout: 2000 });
  const messageCopy = page
    .locator('.conversation-item.assistant_message .conversation-message-action')
    .first();
  await messageCopy.click();
  await expect(messageCopy).toHaveAttribute('aria-label', '消息已复制');
  await expect(messageCopy).toHaveAttribute('aria-label', /复制.*消息/u, { timeout: 2000 });
  await page.setViewportSize({ width: 390, height: 844 });
  await verifyConversationThemes(page, testInfo, 'hosted-mobile');
  await expect(page.locator('.history-create-button')).toHaveCSS('height', '32px');
  await page.evaluate(() => localStorage.setItem('mar.locale.v2', 'en-US'));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
  await expect(page.getByRole('button', { name: 'Chat', exact: true })).toBeVisible();
  await verifyConversationThemes(page, testInfo, 'hosted-mobile-en');
});

test('Hosted conversation entry aligns compact controls across languages and viewport sizes', async ({
  page
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await page.route(/\/api\/hosted-conversations\?limit=20$/, (route) =>
    json(route, { items: [], nextCursor: null })
  );
  await page.route('**/api/conversation-templates', (route) =>
    json(route, { templates: [snapshot.template] })
  );
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '对话', exact: true }).click();

  for (const locale of ['zh-CN', 'en-US']) {
    await page.evaluate((value) => localStorage.setItem('mar.locale.v2', value), locale);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    const templateControl = page.locator('.template-selection-row .el-select');
    const startButton = page.locator('.create-conversation-button');
    await expect(templateControl).toBeVisible();
    await expect(startButton).toBeEnabled();

    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      if (width < 768) {
        await expect(page.locator('.hosted-conversation-history')).toHaveCSS(
          'visibility',
          'hidden'
        );
        await expect(page.locator('.hosted-conversation-files')).toHaveCSS('visibility', 'hidden');
      }
      const [templateBox, buttonBox] = await Promise.all([
        templateControl.boundingBox(),
        startButton.boundingBox()
      ]);
      expect(templateBox).not.toBeNull();
      expect(buttonBox).not.toBeNull();
      expect(Math.abs(templateBox!.x - buttonBox!.x)).toBeLessThanOrEqual(1);
      expect(buttonBox!.y).toBeGreaterThanOrEqual(templateBox!.y + templateBox!.height);
      expect(templateBox!.x + templateBox!.width).toBeLessThanOrEqual(width);
      if (width >= 768) {
        expect(templateBox!.width).toBeLessThanOrEqual(240);
        expect(buttonBox!.width).toBeLessThan(templateBox!.width);
      } else {
        expect(Math.abs(templateBox!.width - buttonBox!.width)).toBeLessThanOrEqual(1);
      }
      await page.screenshot({
        path: testInfo.outputPath(`entry-${locale}-${width}.png`),
        animations: 'disabled'
      });
    }
  }
});

test('Standalone chat reuses scrolling, Composer, and mobile history through one Hosted Watch', async ({
  page,
  browserName
}) => {
  test.setTimeout(60_000);
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  const watchRequests: Array<Record<string, unknown>> = [];
  const fileRequests: Array<{
    readonly method: string;
    readonly url: string;
    readonly body: string;
  }> = [];
  const activeUploads = new Map<
    string,
    {
      readonly uploadId: string;
      readonly name: string;
      readonly mimeType: string;
      readonly size: number;
      receivedBytes: number;
    }
  >();
  const uploadedFiles: Array<{
    readonly id: string;
    readonly conversationId: string;
    readonly category: 'UPLOAD';
    readonly relativePath: string;
    readonly displayName: string;
    readonly mimeType: string;
    readonly size: number;
    readonly source: 'USER';
    readonly createdAt: number;
    readonly updatedAt: number;
  }> = [];
  let directoryConversations: Array<typeof conversation | typeof secondConversation> = [
    conversation,
    secondConversation
  ];
  const deletedConversationRequests: Array<{
    readonly method: string;
    readonly url: string;
    readonly body: string;
  }> = [];
  let uploadSequence = 0;
  let templateDirectoryRequests = 0;
  await mockConsoleApi(
    page,
    'MANAGED',
    ['history.read', 'turn.start'],
    writes,
    'GIT_WORKSPACE',
    true,
    undefined,
    undefined,
    '0.9.27'
  );
  await page.route('**/api/nodes', (route) =>
    json(route, {
      nodes: [
        {
          id: 'node-1',
          displayName: 'Linux Node',
          registeredAddress: 'https://node.example',
          platform: 'linux',
          architecture: 'x64',
          nodeAppVersion: '0.9.27',
          nodeVersion: 'v24.15.0',
          connected: true,
          disabled: false,
          capabilities: {
            marAgent: { available: true, version: '0.9.27' },
            conversationHosting: {
              state: 'AVAILABLE',
              apiVersion: 1,
              sandboxBackend: 'BUBBLEWRAP',
              sandboxPolicyVersion: 1,
              acceptsNewConversations: true,
              supportsExistingConversations: true,
              capacity: 'AVAILABLE'
            }
          }
        },
        {
          id: 'node-2',
          displayName: 'Office Node',
          registeredAddress: 'https://office-node.example',
          platform: 'linux',
          architecture: 'x64',
          nodeAppVersion: '0.9.27',
          nodeVersion: 'v24.15.0',
          connected: true,
          disabled: false,
          capabilities: {
            marAgent: { available: true, version: '0.9.27' },
            conversationHosting: {
              state: 'AVAILABLE',
              apiVersion: 1,
              sandboxBackend: 'BUBBLEWRAP',
              sandboxPolicyVersion: 1,
              acceptsNewConversations: true,
              supportsExistingConversations: true,
              capacity: 'AVAILABLE'
            }
          }
        }
      ]
    })
  );
  await page.route(/\/api\/hosted-conversations\?limit=20$/, (route) =>
    json(route, { items: directoryConversations, nextCursor: null })
  );
  await page.route('**/api/conversation-templates', (route) => {
    templateDirectoryRequests += 1;
    return json(route, {
      templates: [
        snapshot.template,
        {
          ...snapshot.template,
          id: 'template-2',
          nodeId: 'node-2',
          name: '战略调研',
          description: '使用 Office Skills 生成战略调研文档。',
          currentVersionId: 'version-2'
        }
      ]
    });
  });
  await page.route(
    /\/api\/nodes\/node-1\/hosted-conversations\/conversation-1\/watch$/,
    async (route) => {
      watchRequests.push(JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>);
      await fulfillMockHostedConversationWatch(page, route, conversation.id, snapshot);
    }
  );
  await page.route(
    /\/api\/nodes\/node-1\/hosted-conversations\/conversation-1\/history\?limit=10&cursor=hosted-history-older$/,
    (route) =>
      json(route, {
        turns: [
          {
            id: 'turn-older',
            sessionId: 'session-hosted-1',
            runId: null,
            userItemId: null,
            status: 'SUCCEEDED',
            model: 'model-1',
            effort: 'high',
            access: 'full-access',
            items: [
              {
                id: 'assistant-older',
                sessionId: 'session-hosted-1',
                turnId: 'turn-older',
                runId: null,
                parentItemId: null,
                sourceSequence: 1,
                revision: 1,
                status: 'COMPLETED',
                startedAt: Date.UTC(2026, 8, 1, 1),
                completedAt: Date.UTC(2026, 8, 1, 1, 1),
                kind: 'assistant_message',
                payload: {
                  text: '这是按需加载的更早托管消息。',
                  format: 'markdown',
                  model: 'model-1'
                }
              }
            ],
            startedAt: Date.UTC(2026, 8, 1, 1),
            completedAt: Date.UTC(2026, 8, 1, 1, 1)
          }
        ],
        nextCursor: null
      })
  );
  await page.route(
    /\/api\/nodes\/node-1\/hosted-conversations\/conversation-1\/files\/file-1\?offset=0&limit=(?:4096|524288)$/,
    async (route) => {
      fileRequests.push({
        method: route.request().method(),
        url: route.request().url(),
        body: route.request().postData() ?? ''
      });
      await json(route, {
        file: snapshot.files[0],
        encoding: 'base64',
        content: 'cmVzdWx0',
        offset: 0,
        nextOffset: null,
        eof: true
      });
    }
  );
  await page.route(
    /\/api\/nodes\/node-1\/hosted-conversations\/conversation-1\/files\/file-1\/content\?download=1$/,
    async (route) => {
      fileRequests.push({
        method: route.request().method(),
        url: route.request().url(),
        body: route.request().postData() ?? ''
      });
      await route.fulfill({
        status: 200,
        contentType: 'text/plain',
        headers: { 'content-disposition': 'attachment; filename="result.txt"' },
        body: 'result'
      });
    }
  );
  await page.route(
    /\/api\/nodes\/node-1\/hosted-conversations\/conversation-1\/uploads\/preflight$/,
    async (route) => {
      fileRequests.push({
        method: route.request().method(),
        url: route.request().url(),
        body: route.request().postData() ?? ''
      });
      const input = JSON.parse(route.request().postData() ?? '{}') as {
        files: Array<{ name: string }>;
      };
      await json(route, {
        files: input.files.map((file) => ({ name: file.name, status: 'READY' }))
      });
    }
  );
  await page.route(
    /\/api\/nodes\/node-1\/hosted-conversations\/conversation-1\/uploads$/,
    async (route) => {
      fileRequests.push({
        method: route.request().method(),
        url: route.request().url(),
        body: route.request().postData() ?? ''
      });
      const input = JSON.parse(route.request().postData() ?? '{}') as {
        name: string;
        mimeType: string;
        size: number;
      };
      const uploadId = `drop-upload-${++uploadSequence}`;
      const upload = {
        uploadId,
        name: input.name,
        mimeType: input.mimeType,
        size: input.size,
        receivedBytes: 0
      };
      activeUploads.set(uploadId, upload);
      await json(route, {
        upload: {
          ...upload,
          conversationId: conversation.id,
          status: 'UPLOADING'
        }
      });
    }
  );
  await page.route(
    /\/api\/nodes\/node-1\/hosted-conversations\/conversation-1\/uploads\/[^/]+\/chunks$/,
    async (route) => {
      fileRequests.push({
        method: route.request().method(),
        url: route.request().url(),
        body: route.request().postData() ?? ''
      });
      const uploadId = decodeURIComponent(
        new URL(route.request().url()).pathname.split('/').at(-2)!
      );
      const upload = activeUploads.get(uploadId)!;
      const input = JSON.parse(route.request().postData() ?? '{}') as {
        offset: number;
        dataBase64: string;
      };
      upload.receivedBytes = input.offset + Buffer.from(input.dataBase64, 'base64').byteLength;
      await json(route, {
        upload: {
          ...upload,
          conversationId: conversation.id,
          status: 'UPLOADING'
        }
      });
    }
  );
  await page.route(
    /\/api\/nodes\/node-1\/hosted-conversations\/conversation-1\/uploads\/[^/]+\/complete$/,
    async (route) => {
      fileRequests.push({
        method: route.request().method(),
        url: route.request().url(),
        body: route.request().postData() ?? ''
      });
      const uploadId = decodeURIComponent(
        new URL(route.request().url()).pathname.split('/').at(-2)!
      );
      const upload = activeUploads.get(uploadId)!;
      const createdAt = Date.UTC(2026, 8, 1, 2, 10, uploadedFiles.length);
      const file = {
        id: `file-${uploadId}`,
        conversationId: conversation.id,
        category: 'UPLOAD' as const,
        relativePath: upload.name,
        displayName: upload.name,
        mimeType: upload.mimeType,
        size: upload.size,
        source: 'USER' as const,
        createdAt,
        updatedAt: createdAt
      };
      uploadedFiles.push(file);
      await json(route, {
        upload: {
          ...upload,
          conversationId: conversation.id,
          status: 'COMPLETED',
          file
        }
      });
    }
  );
  await page.route(
    /\/api\/nodes\/node-1\/hosted-conversations\/conversation-1\/files\/file-1$/,
    async (route) => {
      fileRequests.push({
        method: route.request().method(),
        url: route.request().url(),
        body: route.request().postData() ?? ''
      });
      await json(route, { deletedFileId: 'file-1', files: uploadedFiles });
    }
  );
  await page.route(
    /\/api\/nodes\/node-1\/hosted-conversations\/conversation-1\/messages$/,
    (route) =>
      write(route, writes, {
        conversation: {
          ...conversation,
          updatedAt: Date.UTC(2026, 8, 1, 3),
          lastActivityAt: Date.UTC(2026, 8, 1, 3)
        },
        run: {
          id: 'run-2',
          status: 'RUNNING',
          startedAt: Date.UTC(2026, 8, 1, 3),
          completedAt: null
        }
      })
  );
  await page.route(
    /\/api\/nodes\/node-1\/hosted-conversations\/conversation-1\/interrupt$/,
    (route) => write(route, writes, { interrupted: true })
  );
  await page.route(/\/api\/nodes\/node-1\/hosted-conversations\/conversation-1$/, async (route) => {
    if (route.request().method() !== 'DELETE') {
      await route.fallback();
      return;
    }
    deletedConversationRequests.push({
      method: route.request().method(),
      url: route.request().url(),
      body: route.request().postData() ?? ''
    });
    directoryConversations = directoryConversations.filter(
      (candidate) => candidate.id !== conversation.id
    );
    await json(route, { deletedConversationId: conversation.id });
  });

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '对话', exact: true }).click();

  await expect(page.getByRole('heading', { name: '对话历史' })).toBeVisible();
  await expect(
    page.locator('.hosted-conversation-history .history-list').getByText('新建对话', {
      exact: true
    })
  ).toBeVisible();
  const workbenchHeader = page.locator('.workbench-header');
  const workbenchBrand = page.locator('.workbench-brand');
  const breadcrumb = workbenchHeader.locator('.breadcrumb');
  await expect(breadcrumb).toContainText('对话');
  await expect(breadcrumb).toContainText('审查发布变更');
  await expect(workbenchHeader.locator('.conversation-heading')).toHaveCount(0);
  await expect(workbenchHeader.locator('.conversation-heading-subtitle')).toHaveCount(0);
  const historyHeader = page.locator('.history-header');
  const filesHeader = page.locator('.files-header');
  const historyCreateButton = page
    .locator('.hosted-conversation-history')
    .getByRole('button', { name: '新建对话', exact: true });
  const [
    headerBox,
    breadcrumbBox,
    historyHeaderBox,
    historyTitleBox,
    historyCreateButtonBox,
    workbenchBrandBox,
    headerToggleBox
  ] = await Promise.all([
    workbenchHeader.boundingBox(),
    breadcrumb.boundingBox(),
    historyHeader.boundingBox(),
    historyHeader.getByRole('heading', { name: '对话历史' }).boundingBox(),
    historyCreateButton.boundingBox(),
    workbenchBrand.boundingBox(),
    workbenchHeader.locator('.workbench-tree-toggle').boundingBox()
  ]);
  expect(breadcrumbBox?.x ?? 0).toBeGreaterThan(
    (headerToggleBox?.x ?? 0) + (headerToggleBox?.width ?? 0)
  );
  expect(breadcrumbBox?.height).toBeLessThanOrEqual(24);
  expect(historyHeaderBox?.height ?? Infinity).toBeLessThanOrEqual(48);
  expect(headerBox?.height).toBeCloseTo(
    await workbenchHeader.evaluate(() =>
      parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--mar-workbench-header-height')
      )
    ),
    0
  );
  expect(historyHeaderBox?.y).toBeCloseTo(
    (workbenchBrandBox?.y ?? 0) + (workbenchBrandBox?.height ?? 0),
    0
  );
  const historyTitleTopSpace = (historyTitleBox?.y ?? 0) - (historyHeaderBox?.y ?? 0);
  const historyTitleBottomSpace =
    (historyHeaderBox?.y ?? 0) +
    (historyHeaderBox?.height ?? 0) -
    ((historyTitleBox?.y ?? 0) + (historyTitleBox?.height ?? 0));
  expect(Math.abs(historyTitleTopSpace - historyTitleBottomSpace)).toBeLessThanOrEqual(1);
  const historyTitleToCreateButtonSpace =
    (historyCreateButtonBox?.y ?? 0) - ((historyTitleBox?.y ?? 0) + (historyTitleBox?.height ?? 0));
  expect(Math.abs(historyTitleTopSpace - historyTitleToCreateButtonSpace)).toBeLessThanOrEqual(1);
  expect((historyTitleBox?.x ?? 0) - (historyHeaderBox?.x ?? 0)).toBeCloseTo(20, 0);
  await expect(historyHeader).toHaveClass(/sidebar-heading.*session-heading.*history-header/);
  await expect(historyHeader).toHaveCSS('padding-top', '12px');
  await expect(historyHeader).toHaveCSS('padding-bottom', '12px');
  await expect(page.locator('.history-controls')).toHaveCSS('padding-top', '0px');
  await expect(historyHeader).toHaveCSS('border-bottom-width', '0px');
  await expect(filesHeader).toHaveCSS('height', '44px');
  await expect(filesHeader.locator('svg')).toHaveCount(0);
  await expect(page.locator('.workbench')).toHaveCSS('transition-duration', '0s');
  await expect(workbenchHeader.locator('.el-tag')).toHaveCount(0);
  const collapseSidebarButton = page.getByRole('button', { name: '收起侧栏' });
  await expect(collapseSidebarButton).toBeVisible();
  const hostedLayout = () =>
    page.evaluate(() => {
      const box = (selector: string) =>
        document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
      const brand = box('.workbench-brand');
      const rail = box('.activity-rail');
      const workbench = box('.workbench');
      const history = box('.hosted-conversation-history');
      const main = box('.hosted-conversation-main');
      const files = box('.hosted-conversation-files');
      const toggle = box('.workbench-tree-toggle');
      const currentBreadcrumb = box('.workbench-header .breadcrumb');
      return {
        brandWidth: brand.width,
        railWidth: rail.width,
        workbenchLeft: workbench.left,
        historyLeft: history.left,
        historyRight: history.right,
        historyWidth: history.width,
        mainLeft: main.left,
        filesRight: files.right,
        toggleLeft: toggle.left,
        toggleRight: toggle.right,
        breadcrumbLeft: currentBreadcrumb.left
      };
    });
  const expandedHostedLayout = await hostedLayout();
  expect(expandedHostedLayout.workbenchLeft).toBeCloseTo(expandedHostedLayout.brandWidth, 0);
  expect(expandedHostedLayout.historyLeft).toBeCloseTo(expandedHostedLayout.railWidth, 0);
  expect(expandedHostedLayout.historyRight).toBeCloseTo(expandedHostedLayout.workbenchLeft, 0);
  expect(expandedHostedLayout.mainLeft).toBeCloseTo(expandedHostedLayout.workbenchLeft, 0);
  expect(expandedHostedLayout.toggleLeft).toBeGreaterThanOrEqual(expandedHostedLayout.brandWidth);
  expect(expandedHostedLayout.breadcrumbLeft).toBeGreaterThan(expandedHostedLayout.toggleRight);
  await collapseSidebarButton.click();
  const expandSidebarButton = page.getByRole('button', { name: '展开侧栏' });
  await expect(expandSidebarButton).toBeVisible();
  await expect
    .poll(async () => {
      const layout = await hostedLayout();
      return Math.abs(layout.brandWidth - layout.railWidth);
    })
    .toBeLessThanOrEqual(1);
  const collapsedHostedLayout = await hostedLayout();
  expect(collapsedHostedLayout.workbenchLeft).toBeCloseTo(collapsedHostedLayout.railWidth, 0);
  expect(collapsedHostedLayout.historyWidth).toBe(0);
  expect(collapsedHostedLayout.mainLeft).toBeCloseTo(collapsedHostedLayout.railWidth, 0);
  expect(collapsedHostedLayout.mainLeft).toBeLessThan(expandedHostedLayout.mainLeft);
  expect(collapsedHostedLayout.filesRight).toBeCloseTo(expandedHostedLayout.filesRight, 0);
  expect(collapsedHostedLayout.toggleLeft - collapsedHostedLayout.workbenchLeft).toBeCloseTo(
    expandedHostedLayout.toggleLeft - expandedHostedLayout.workbenchLeft,
    0
  );
  expect(collapsedHostedLayout.breadcrumbLeft).toBeGreaterThan(collapsedHostedLayout.toggleRight);
  await expandSidebarButton.click();
  await expect(collapseSidebarButton).toBeVisible();
  await expect
    .poll(async () => {
      const layout = await hostedLayout();
      return {
        brandWidth: layout.brandWidth,
        historyWidth: layout.historyWidth,
        workbenchLeft: layout.workbenchLeft
      };
    })
    .toEqual({
      brandWidth: expandedHostedLayout.brandWidth,
      historyWidth: expandedHostedLayout.historyWidth,
      workbenchLeft: expandedHostedLayout.workbenchLeft
    });
  await expect(page.locator('#hosted-pane-conversation .conversation-header')).toHaveCount(0);
  const history = page.locator('.hosted-conversation-history');
  const historyRows = history.locator('.history-list article');
  await expect(history.locator('.history-more-button')).toHaveCount(0);
  await historyRows.first().hover();
  await expect(history.locator('.history-more-button')).toHaveCount(1);
  await expect(historyRows.first().locator('.history-pin-indicator svg')).toBeVisible();
  await historyRows.nth(1).hover();
  await expect(history.locator('.history-more-button')).toHaveCount(1);
  await expect(page.getByRole('combobox', { name: '承载 Node' })).toHaveCount(0);
  await expect(page.getByText('已完成隔离环境中的审查。', { exact: true })).toBeVisible();
  await expect(page.getByText('Review the resume path.', { exact: true })).toHaveCount(1);
  await expect(page.locator('.hosted-conversation-main')).not.toContainText('<mar_steer>');
  await expect(page.locator('.hosted-conversation-main')).not.toContainText(
    'Additional information received while you were working.'
  );
  await expect(page.getByText('MAR Agent · Full Access', { exact: true })).toHaveCount(0);
  const firstFileOpen = page.locator('.file-open').first();
  const [fileNameBox, fileSizeBox] = await Promise.all([
    firstFileOpen.locator('span').boundingBox(),
    firstFileOpen.locator('small').boundingBox()
  ]);
  expect(
    Math.abs(
      (fileNameBox?.y ?? 0) +
        (fileNameBox?.height ?? 0) / 2 -
        ((fileSizeBox?.y ?? 0) + (fileSizeBox?.height ?? 0) / 2)
    )
  ).toBeLessThanOrEqual(1);
  await expect(page.getByRole('button', { name: '模型' })).toBeVisible();
  await expect(page.locator('.hosted-conversation-history time').first()).toHaveAttribute(
    'datetime',
    '2026-09-01T02:00:00.000Z'
  );
  const conversationScroll = page.locator('.hosted-conversation-main .conversation-scroll');
  await expect
    .poll(() =>
      conversationScroll.evaluate((element) => element.scrollHeight > element.clientHeight + 28)
    )
    .toBe(true);
  await expect
    .poll(() =>
      conversationScroll.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight
      )
    )
    .toBeLessThanOrEqual(28);

  const loadEarlier = page.getByRole('button', { name: '加载更早记录' });
  await expect(loadEarlier).toBeVisible();
  await conversationScroll.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect(page.getByText('这是按需加载的更早托管消息。', { exact: true })).toBeVisible();
  await expect(loadEarlier).toHaveCount(0);
  await expect
    .poll(() => conversationScroll.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: '回到最新' })).toBeVisible();
  await page.getByRole('button', { name: '回到最新' }).click();
  await expect
    .poll(() =>
      conversationScroll.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight
      )
    )
    .toBeLessThanOrEqual(28);

  await emitMockHostedConversationEvent(page, {
    conversationId: conversation.id,
    kind: 'runtime',
    runtimeEvent: {
      kind: 'ITEM',
      executionId: 'run-1',
      turnId: 'turn-1',
      sequence: 3,
      createdAt: Date.UTC(2026, 8, 1, 1, 33),
      payload: {
        item: {
          itemId: 'assistant-following',
          kind: 'assistant_message',
          status: 'COMPLETED',
          payload: {
            text: '实时新增内容保持底部跟随。',
            format: 'markdown',
            model: 'model-1'
          }
        }
      }
    }
  });
  await expect(page.getByText('实时新增内容保持底部跟随。', { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      conversationScroll.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight
      )
    )
    .toBeLessThanOrEqual(28);

  await conversationScroll.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll'));
  });
  const latestButton = page.locator('.conversation-latest');
  await expect(latestButton).toBeVisible();
  await emitMockHostedConversationEvent(page, {
    conversationId: conversation.id,
    kind: 'runtime',
    runtimeEvent: {
      kind: 'ITEM',
      executionId: 'run-1',
      turnId: 'turn-1',
      sequence: 4,
      createdAt: Date.UTC(2026, 8, 1, 1, 34),
      payload: {
        item: {
          itemId: 'assistant-paused',
          kind: 'assistant_message',
          status: 'COMPLETED',
          payload: {
            text: '用户上滚后不应被新内容强制拉回。',
            format: 'markdown',
            model: 'model-1'
          }
        }
      }
    }
  });
  await expect(page.getByText('用户上滚后不应被新内容强制拉回。', { exact: true })).toBeVisible();
  await expect
    .poll(() => conversationScroll.evaluate((element) => element.scrollTop))
    .toBeLessThan(28);
  await expect(latestButton).toBeVisible();
  await latestButton.click();
  await expect(latestButton).toBeHidden();
  await expect
    .poll(() =>
      conversationScroll.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight
      )
    )
    .toBeLessThanOrEqual(28);

  const filesPane = page.locator('.hosted-conversation-files');
  const projectedFile = filesPane.getByRole('button', { name: /^result\.txt/u });
  await expect(projectedFile).toBeVisible();
  await expect(filesPane.getByRole('button', { name: /^source\.txt/u })).toHaveCount(0);
  await filesPane.getByRole('button', { name: '展开用户上传目录“references”' }).click();
  await expect(filesPane.getByRole('button', { name: /^source\.txt/u })).toBeVisible();
  await expect(
    filesPane.getByRole('button', { name: '收起用户上传目录“references”' })
  ).toBeVisible();
  await expect(filesPane.getByRole('button', { name: /^summary\.txt/u })).toHaveCount(0);
  await filesPane.getByRole('button', { name: '展开输出文件目录“reports”' }).click();
  await expect(filesPane.getByRole('button', { name: /^summary\.txt/u })).toBeVisible();
  await expect(filesPane.getByRole('button', { name: /^q1\.txt/u })).toHaveCount(0);
  await filesPane.getByRole('button', { name: '展开输出文件目录“reports/2026”' }).click();
  await expect(filesPane.getByRole('button', { name: /^q1\.txt/u })).toBeVisible();
  await expect(page.locator('.composer-command-picker')).toHaveCount(0);
  await expect(page.locator('.composer-file-reference-picker')).toHaveCount(0);
  await expect(page.locator('.composer-skill-picker')).toHaveCount(0);
  await expect(page.getByText(/受控投影|Controlled projection/u)).toHaveCount(0);

  const fileChooserEvent = page.waitForEvent('filechooser');
  await page.locator('.files-drop-target').click();
  const fileChooser = await fileChooserEvent;
  await fileChooser.setFiles([
    {
      name: 'picked-one.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('picked')
    },
    {
      name: 'picked-two.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{}')
    }
  ]);
  await expect(
    page.locator('.hosted-conversation-files').getByRole('button', { name: /^picked-one\.txt/u })
  ).toBeVisible();
  await expect(
    page.locator('.hosted-conversation-files').getByRole('button', { name: /^picked-two\.json/u })
  ).toBeVisible();

  await page.locator('.files-drop-target').evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['alpha'], 'drop-one.txt', { type: 'text/plain' }));
    transfer.items.add(new File(['{}'], 'drop-two.json', { type: 'application/json' }));
    element.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer
      })
    );
  });
  await expect(
    page.locator('.hosted-conversation-files').getByRole('button', { name: /^drop-one\.txt/u })
  ).toBeVisible();
  await expect(
    page.locator('.hosted-conversation-files').getByRole('button', { name: /^drop-two\.json/u })
  ).toBeVisible();
  await expect(page.locator('.hosted-attachments')).toHaveCount(0);
  expect(
    fileRequests
      .filter((request) => new URL(request.url).pathname.endsWith('/uploads'))
      .map((request) => (JSON.parse(request.body) as { name: string }).name)
  ).toEqual(['picked-one.txt', 'picked-two.json', 'drop-one.txt', 'drop-two.json']);

  const hostedComposerShell = page.locator('.composer-shell');
  const hostedComposer = page.getByRole('textbox', { name: '输入消息' });
  await hostedComposer.fill('请检查附件。');
  await hostedComposerShell.evaluate((shell) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['composer'], 'composer-drop.txt', { type: 'text/plain' }));
    shell.dispatchEvent(
      new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: transfer })
    );
  });
  await expect(hostedComposerShell).toHaveClass(/composer-drop-target/);
  await hostedComposerShell.evaluate((shell) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['composer'], 'composer-drop.txt', { type: 'text/plain' }));
    shell.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })
    );
  });
  await expect(hostedComposerShell).not.toHaveClass(/composer-drop-target/);
  const droppedAttachmentConfirmation = page.getByRole('dialog', {
    name: '上传拖放的文件？'
  });
  await expect(droppedAttachmentConfirmation).toContainText(
    '要将拖放的 1 个文件上传并附加到本条消息吗？'
  );
  await expect(page.locator('.hosted-attachments')).toHaveCount(0);
  await droppedAttachmentConfirmation.getByRole('button', { name: '上传', exact: true }).click();
  await expect(page.locator('.hosted-attachments')).toContainText('composer-drop.txt');
  if (browserName !== 'firefox') {
    await hostedComposer.evaluate((editor) => {
      const clipboardData = new DataTransfer();
      clipboardData.items.add(new File(['image'], 'pasted-image.png', { type: 'image/png' }));
      const event = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData
      });
      editor.dispatchEvent(event);
      if (!event.defaultPrevented) throw new Error('Composer did not take clipboard image');
    });
    await expect(page.locator('.hosted-attachments')).toContainText('pasted-image.png');
    await expect(page.locator('.hosted-attachments img')).toHaveCount(1);
  }
  await page.getByRole('button', { name: '移除附件“composer-drop.txt”' }).click();
  if (browserName !== 'firefox')
    await page.getByRole('button', { name: '移除附件“pasted-image.png”' }).click();
  await expect(page.locator('.hosted-attachments')).toHaveCount(0);
  await expect
    .poll(() =>
      conversationScroll.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight
      )
    )
    .toBeLessThanOrEqual(28);

  await projectedFile.click();
  await expect
    .poll(
      () =>
        fileRequests.filter(
          (request) =>
            request.method === 'GET' && new URL(request.url).pathname.endsWith('/files/file-1')
        ).length
    )
    .toBe(1);
  const previewRead = fileRequests.find(
    (request) => request.method === 'GET' && new URL(request.url).pathname.endsWith('/files/file-1')
  );
  expect(new URL(previewRead!.url).searchParams.get('limit')).toBe('4096');
  const filePreview = page.getByRole('dialog', { name: 'output/result.txt 文件预览' });
  await expect(filePreview.locator('.cm-content')).toContainText('result');
  const downloadEvent = page.waitForEvent('download');
  await filePreview.getByRole('button', { name: '下载文件' }).click();
  expect((await downloadEvent).suggestedFilename()).toBe('result.txt');
  await filePreview.getByRole('button', { name: '关闭预览' }).click();
  await expect
    .poll(() =>
      conversationScroll.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight
      )
    )
    .toBeLessThanOrEqual(28);

  await page.getByRole('link', { name: '查看结果文件' }).click();
  await expect(filePreview.locator('.cm-content')).toContainText('result');
  await filePreview.getByRole('button', { name: '关闭预览' }).click();
  await expect(latestButton).toBeVisible();
  await latestButton.click();
  await expect(latestButton).toBeHidden();
  await expect
    .poll(() =>
      conversationScroll.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight
      )
    )
    .toBeLessThanOrEqual(28);
  await page.getByRole('button', { name: '删除文件“result.txt”' }).click();
  const deleteDialog = page.locator('.el-message-box');
  await expect(deleteDialog).toContainText('删除“result.txt”后无法恢复。是否继续？');
  await deleteDialog.getByRole('button', { name: '删除文件', exact: true }).click();
  await expect(projectedFile).toHaveCount(0);
  await expect(
    page.locator('.hosted-conversation-files').getByRole('button', { name: /^drop-one\.txt/u })
  ).toBeVisible();
  expect(
    fileRequests.find(
      (request) =>
        request.method === 'DELETE' && new URL(request.url).pathname.endsWith('/files/file-1')
    )?.body
  ).toBe('{}');
  await expect
    .poll(() =>
      conversationScroll.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight
      )
    )
    .toBeLessThanOrEqual(28);

  await page.getByPlaceholder('发送消息给 MAR Agent').fill('继续检查测试结果。');
  await expect(page.getByLabel('已加载对话模板“代码审查”')).toContainText('代码审查');
  await page.getByPlaceholder('发送消息给 MAR Agent').press('Control+Enter');

  await expect
    .poll(() => writes.find((entry) => entry.url.endsWith('/messages'))?.body)
    .toBeTruthy();
  const message = JSON.parse(
    writes.find((entry) => entry.url.endsWith('/messages'))?.body ?? '{}'
  ) as Record<string, unknown>;
  expect(message).toMatchObject({
    prompt: '继续检查测试结果。',
    attachmentIds: [],
    modelId: 'model-1',
    deliveryIntent: 'REPLACE_CURRENT'
  });
  expect(message).not.toHaveProperty('runner');
  expect(message).not.toHaveProperty('access');
  expect(message).not.toHaveProperty('command');
  await replaceActiveHostedConversationMessage(page, writes);
  expect(watchRequests).toHaveLength(1);
  expect(watchRequests[0]).toMatchObject({
    mode: 'initial',
    workbenchConnectionId: 'mock-workbench-connection'
  });
  const activeWorkbenchSockets = await page.evaluate(() =>
    (
      window as unknown as {
        __consoleMockWorkbenchWebSocket: {
          instances: readonly { readonly readyState: number; readonly url: string }[];
        };
      }
    ).__consoleMockWorkbenchWebSocket.instances.filter(
      (socket) => socket.readyState === WebSocket.OPEN && socket.url.includes('/api/workbench/live')
    )
  );
  expect(activeWorkbenchSockets).toHaveLength(1);
  await expect
    .poll(() =>
      conversationScroll.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight
      )
    )
    .toBeLessThanOrEqual(28);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.mouse.move(389, 843);
  await expect(page.getByRole('alert')).toHaveCount(0);
  const [mobileHeaderBox, mobileBreadcrumbBox] = await Promise.all([
    workbenchHeader.boundingBox(),
    breadcrumb.boundingBox()
  ]);
  const hostedMobileHeaderHeight = mobileHeaderBox?.height;
  const hostedMobileBreadcrumbInset = (mobileBreadcrumbBox?.x ?? 0) - (mobileHeaderBox?.x ?? 0);
  await expect(workbenchHeader.locator('.workbench-tree-toggle')).toHaveCount(0);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.locator('.workspace-tree')).toBeVisible();
  const settingsMobileHeader = await workbenchHeader.boundingBox();
  const settingsMobileBreadcrumb = await workbenchHeader.locator('.breadcrumb').boundingBox();
  expect(hostedMobileHeaderHeight).toBe(settingsMobileHeader?.height);
  expect(hostedMobileBreadcrumbInset).toBeCloseTo(
    (settingsMobileBreadcrumb?.x ?? 0) - (settingsMobileHeader?.x ?? 0),
    0
  );
  await page.getByRole('button', { name: '对话', exact: true }).click();
  await expect(history).toBeVisible();
  await expect(page.locator('.history-refresh-button')).toBeEnabled();
  await expect(history).toBeVisible();
  const workNavigation = page.getByRole('button', { name: '工作', exact: true });
  const conversationNavigation = page.getByRole('button', { name: '对话', exact: true });
  await workNavigation.click();
  const standardDrawer = page.locator('.workspace-tree');
  const standardScrim = page.locator('.sidebar-scrim');
  await expect(standardDrawer).toBeVisible();
  await expect(standardScrim).toBeVisible();
  const standardDrawerStyle = await standardDrawer.evaluate((element) => {
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return {
      width: bounds.width,
      top: bounds.top,
      bottom: bounds.bottom,
      borderRightWidth: style.borderRightWidth,
      borderRightColor: style.borderRightColor,
      boxShadow: style.boxShadow,
      transform: style.transform,
      transitionDuration: style.transitionDuration.split(',')[0]?.trim()
    };
  });
  const standardScrimStyle = await standardScrim.evaluate((element) => {
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return {
      position: style.position,
      top: bounds.top,
      bottom: bounds.bottom,
      backgroundColor: style.backgroundColor
    };
  });
  await conversationNavigation.click();
  await expect(history).toBeVisible();
  const hostedScrim = page.locator('.hosted-conversation-scrim');
  await expect(hostedScrim).toBeVisible();
  const hostedDrawerStyle = await history.evaluate((element) => {
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return {
      width: bounds.width,
      top: bounds.top,
      bottom: bounds.bottom,
      borderRightWidth: style.borderRightWidth,
      borderRightColor: style.borderRightColor,
      boxShadow: style.boxShadow,
      transform: style.transform,
      transitionDuration: style.transitionDuration.split(',')[0]?.trim()
    };
  });
  const hostedScrimStyle = await hostedScrim.evaluate((element) => {
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return {
      position: style.position,
      top: bounds.top,
      bottom: bounds.bottom,
      backgroundColor: style.backgroundColor
    };
  });
  expect(hostedDrawerStyle).toEqual(standardDrawerStyle);
  expect(hostedScrimStyle).toEqual(standardScrimStyle);
  const initialHostedScrimBox = await hostedScrim.boundingBox();
  expect(initialHostedScrimBox).not.toBeNull();
  await page.mouse.click(
    initialHostedScrimBox!.x + initialHostedScrimBox!.width - 8,
    initialHostedScrimBox!.y + 100
  );
  await expect(history).toBeHidden();
  await expect
    .poll(() =>
      conversationScroll.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight
      )
    )
    .toBeLessThanOrEqual(28);
  await emitMockHostedConversationEvent(page, {
    conversationId: conversation.id,
    kind: 'runtime',
    runtimeEvent: {
      kind: 'ITEM',
      executionId: 'run-1',
      turnId: 'turn-1',
      sequence: 5,
      createdAt: Date.UTC(2026, 8, 1, 1, 35),
      payload: {
        item: {
          itemId: 'assistant-mobile-following',
          kind: 'assistant_message',
          status: 'COMPLETED',
          payload: {
            text: '移动端实时新增内容同样保持底部跟随。',
            format: 'markdown',
            model: 'model-1'
          }
        }
      }
    }
  });
  await expect(
    page.getByText('移动端实时新增内容同样保持底部跟随。', { exact: true })
  ).toBeVisible();
  await expect
    .poll(() =>
      conversationScroll.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight
      )
    )
    .toBeLessThanOrEqual(28);
  await expect(history).toBeHidden();
  const closedMobileHistoryLayout = await page.evaluate(() => {
    const workspace = document.querySelector<HTMLElement>('.hosted-workspace');
    const main = document.querySelector<HTMLElement>('.hosted-conversation-main');
    const drawer = document.querySelector<HTMLElement>('.hosted-conversation-history');
    if (workspace === null || main === null || drawer === null)
      throw new Error('托管对话移动布局未完整渲染');
    const drawerStyle = getComputedStyle(drawer);
    return {
      workspaceLeft: workspace.getBoundingClientRect().left,
      mainLeft: main.getBoundingClientRect().left,
      drawerRight: drawer.getBoundingClientRect().right,
      drawerVisibility: drawerStyle.visibility,
      drawerPointerEvents: drawerStyle.pointerEvents,
      drawerTransitionDuration: drawerStyle.transitionDuration
    };
  });
  expect(closedMobileHistoryLayout.workspaceLeft).toBeCloseTo(0, 0);
  expect(closedMobileHistoryLayout.mainLeft).toBeCloseTo(0, 0);
  expect(closedMobileHistoryLayout.drawerRight).toBeLessThanOrEqual(0);
  expect(closedMobileHistoryLayout.drawerVisibility).toBe('hidden');
  expect(closedMobileHistoryLayout.drawerPointerEvents).toBe('none');
  expect(closedMobileHistoryLayout.drawerTransitionDuration).toContain('0.16s');
  await page.mouse.move(389, 843);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: '对话', exact: true }).click();
  await expect(history).toBeVisible();
  await expect
    .poll(() => history.evaluate((element) => Math.abs(element.getBoundingClientRect().left)))
    .toBeLessThanOrEqual(1);
  await expect(history).toHaveCSS('pointer-events', 'auto');
  await expect(hostedScrim).toBeVisible();
  const historyScrimBox = await hostedScrim.boundingBox();
  expect(historyScrimBox).not.toBeNull();
  await page.mouse.click(historyScrimBox!.x + historyScrimBox!.width - 8, historyScrimBox!.y + 100);
  await expect(history).toBeHidden();
  await expect
    .poll(() => history.evaluate((element) => element.getBoundingClientRect().right))
    .toBeLessThanOrEqual(0);
  await expect(page.locator('.hosted-conversation-main')).toHaveCSS('width', '390px');

  await page.getByRole('button', { name: '对话', exact: true }).click();
  await expect(history).toBeVisible();
  await historyRows.first().locator('.history-open').click();
  await expect(history).toBeHidden();

  const mobileFilesButton = page.locator('.hosted-mobile-files-button');
  const mobileFiles = page.locator('.hosted-conversation-files');
  await expect(mobileFilesButton).toBeVisible();
  await mobileFilesButton.click();
  await expect(mobileFiles).toBeVisible();
  await expect
    .poll(() => mobileFiles.evaluate((element) => Math.abs(element.getBoundingClientRect().left)))
    .toBeLessThanOrEqual(1);
  await expect(mobileFiles).toHaveCSS('pointer-events', 'auto');
  await expect(mobileFiles).toHaveCSS('transition-duration', /0\.16s/u);
  await expect(hostedScrim).toBeVisible();
  const filesScrimBox = await hostedScrim.boundingBox();
  expect(filesScrimBox).not.toBeNull();
  await page.mouse.click(filesScrimBox!.x + filesScrimBox!.width - 8, filesScrimBox!.y + 100);
  await expect(mobileFiles).toBeHidden();
  await expect
    .poll(() => mobileFiles.evaluate((element) => element.getBoundingClientRect().right))
    .toBeLessThanOrEqual(0);
  await expect(mobileFiles).toHaveCSS('visibility', 'hidden');
  await expect(mobileFiles).toHaveCSS('pointer-events', 'none');
  await expect(page.getByRole('button', { name: '模型' })).toBeVisible();
  await expect(page.getByText('MAR Agent · Full Access', { exact: true })).toHaveCount(0);

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole('button', { name: '展开侧栏' }).click();
  await historyCreateButton.click();
  await expect(breadcrumb).toContainText('新建对话');
  await expect(page.getByRole('dialog', { name: '新建对话' })).toHaveCount(0);
  const templateSelect = page.getByRole('combobox', { name: '加载模板' });
  const startConversationButton = page
    .locator('#hosted-pane-conversation')
    .getByRole('button', { name: '开始对话' });
  await expect(templateSelect).toBeVisible();
  await expect(startConversationButton).toBeVisible();
  await expect(page.locator('.conversation-create-panel')).toHaveCSS('border-top-width', '0px');
  const createHeadingIcon = page.locator('.conversation-create-icon');
  await expect(createHeadingIcon).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(createHeadingIcon).toHaveCSS('border-top-width', '0px');
  const [historyCreateIcon, startConversationIcon] = await Promise.all([
    historyCreateButton.locator('svg').evaluate((element) => element.innerHTML),
    startConversationButton.locator('svg').evaluate((element) => element.innerHTML)
  ]);
  expect(startConversationIcon).toBe(historyCreateIcon);
  await expect(page.getByText('加载模板：', { exact: true })).toBeVisible();
  await expect(page.locator('.template-selection-row')).toHaveClass(/is-no-asterisk/);
  await expect(page.getByRole('button', { name: '刷新模板' })).toHaveCount(0);
  await expect(page.locator('.selected-template-summary')).toHaveCount(0);
  await templateSelect.click();
  await expect.poll(() => templateDirectoryRequests).toBeGreaterThanOrEqual(2);
  await expect(page.locator('.template-selection-row .el-select__wrapper')).toHaveCSS(
    'box-shadow',
    'none'
  );
  await expect(page.getByRole('option', { name: '战略调研', exact: true })).toBeVisible();
  await page.getByRole('option', { name: '战略调研', exact: true }).click();
  const [entryPaneBox, createPanelBox, selectBox, createButtonBox] = await Promise.all([
    page.locator('#hosted-pane-conversation').boundingBox(),
    page.locator('.conversation-create-panel').boundingBox(),
    templateSelect.boundingBox(),
    startConversationButton.boundingBox()
  ]);
  expect(createPanelBox?.width ?? 0).toBeLessThanOrEqual(400);
  expect(createPanelBox?.height ?? 0).toBeLessThanOrEqual(190);
  expect(
    Math.abs(
      (createPanelBox?.x ?? 0) +
        (createPanelBox?.width ?? 0) / 2 -
        ((entryPaneBox?.x ?? 0) + (entryPaneBox?.width ?? 0) / 2)
    )
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(
      (createPanelBox?.y ?? 0) +
        (createPanelBox?.height ?? 0) / 2 -
        ((entryPaneBox?.y ?? 0) + (entryPaneBox?.height ?? 0) / 2)
    )
  ).toBeLessThanOrEqual(1);
  expect(selectBox?.width ?? 0).toBeLessThan((entryPaneBox?.width ?? 0) * 0.7);
  expect(createButtonBox?.width ?? 0).toBeLessThan(selectBox?.width ?? 0);
  await expect(startConversationButton).toBeEnabled();

  const selectedConversationRow = history
    .locator('.history-list article')
    .filter({ hasText: '审查发布变更' });
  await selectedConversationRow.locator('.history-open').click();
  await expect(breadcrumb).toContainText('审查发布变更');
  await selectedConversationRow.hover();
  await selectedConversationRow.getByRole('button', { name: '“审查发布变更”的更多操作' }).click();
  await page.locator('.session-action-menu').getByText('删除', { exact: true }).click();
  const deleteConversationDialog = page.locator('.el-message-box');
  await expect(deleteConversationDialog).toContainText('删除“审查发布变更”后无法恢复。是否继续？');
  await deleteConversationDialog.getByRole('button', { name: '删除', exact: true }).click();
  await expect(selectedConversationRow).toHaveCount(0);
  await expect(
    history.locator('.history-list article strong').filter({ hasText: '新建对话' })
  ).toBeVisible();
  await expect(history.locator('article.selected')).toHaveCount(0);
  await expect(workbenchHeader.locator('.breadcrumb strong')).toContainText('新建对话');
  await expect(page.getByRole('menuitem', { name: '恢复', exact: true })).toHaveCount(0);
  expect(deletedConversationRequests).toEqual([
    {
      method: 'DELETE',
      url: expect.stringMatching(/\/api\/nodes\/node-1\/hosted-conversations\/conversation-1$/u),
      body: '{}'
    }
  ]);
  directoryConversations = [];
  await page.route('**/api/resources', (route) => json(route, { nodes: [], workspaces: [] }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.mouse.move(389, 843);
  await expect(page.getByRole('alert')).toHaveCount(0);
  for (const menu of ['工作', '管理', '设置']) {
    await page.getByRole('button', { name: menu, exact: true }).click();
    await expect(page.locator('.workspace-tree')).toBeVisible();
    await page.getByRole('button', { name: '对话', exact: true }).click();
    await expect(history.locator('.history-empty-text')).toBeVisible();
    await expect(history).toBeVisible();
    await expect(page.locator('.hosted-conversation-scrim')).toBeVisible();
  }
});

test('Interrupted hosted chats synchronize automatic titles and use Rollback instead of Rewind to restore input', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(
    page,
    'MANAGED',
    ['history.read', 'turn.start'],
    writes,
    'GIT_WORKSPACE',
    true,
    undefined,
    undefined,
    '0.9.55'
  );
  const retainedTurn = {
    id: 'turn-retained',
    sessionId: conversation.sessionId,
    runId: 'run-retained',
    userItemId: null,
    status: 'SUCCEEDED',
    model: 'model-1',
    effort: 'high',
    access: 'full-access',
    rewind: { before: null, after: 'turn-retained' },
    items: [
      {
        id: 'retained-assistant',
        sessionId: conversation.sessionId,
        turnId: 'turn-retained',
        runId: 'run-retained',
        parentItemId: null,
        sourceSequence: 1,
        revision: 1,
        status: 'COMPLETED',
        startedAt: 1,
        completedAt: 2,
        kind: 'assistant_message',
        payload: {
          text: '这段历史会被保留。',
          format: 'markdown',
          model: 'model-1'
        }
      }
    ],
    startedAt: 1,
    completedAt: 2
  } as const;
  const targetTurn = {
    id: 'turn-rollback',
    sessionId: conversation.sessionId,
    runId: 'run-rollback',
    userItemId: 'rollback-user',
    status: 'SUCCEEDED',
    model: 'model-1',
    effort: 'high',
    access: 'full-access',
    rewind: { before: 'turn-retained', after: 'turn-rollback' },
    items: [
      {
        id: 'rollback-user',
        sessionId: conversation.sessionId,
        turnId: 'turn-rollback',
        runId: 'run-rollback',
        parentItemId: null,
        sourceSequence: 2,
        revision: 1,
        status: 'COMPLETED',
        startedAt: 3,
        completedAt: 3,
        kind: 'user_message',
        payload: {
          clientMessageId: 'message-rollback',
          text: '请重新执行托管检查',
          contexts: [],
          delivery: 'ACCEPTED'
        }
      },
      {
        id: 'rollback-assistant',
        sessionId: conversation.sessionId,
        turnId: 'turn-rollback',
        runId: 'run-rollback',
        parentItemId: null,
        sourceSequence: 3,
        revision: 1,
        status: 'COMPLETED',
        startedAt: 3,
        completedAt: 4,
        kind: 'assistant_message',
        payload: {
          text: '这段回复会被回滚。',
          format: 'markdown',
          model: 'model-1'
        }
      }
    ],
    startedAt: 3,
    completedAt: 4
  } as const;
  const idleConversation = {
    ...conversation,
    title: '中断任务生成的标题',
    activity: { status: 'IDLE', version: 2, updatedAt: 4 }
  } as const;
  const initialSnapshot = {
    ...snapshot,
    conversation: {
      ...idleConversation,
      title: '首轮用户输入的临时标题',
      activity: { status: 'RUNNING', version: 1, updatedAt: 3 }
    },
    nodeAppVersion: '0.9.55',
    turns: [retainedTurn, targetTurn],
    snapshotSequence: 1
  };
  const rolledBackSnapshot = {
    ...initialSnapshot,
    conversation: idleConversation,
    turns: [retainedTurn],
    historyNextCursor: null,
    snapshotSequence: 2
  };
  let rollbackBody: Record<string, unknown> | undefined;
  const watchRequests: Array<Record<string, unknown>> = [];

  await page.route(/\/api\/hosted-conversations\?limit=20$/, (route) =>
    json(route, { items: [initialSnapshot.conversation], nextCursor: null })
  );
  await page.route('**/api/conversation-templates', (route) =>
    json(route, { templates: [snapshot.template] })
  );
  await page.route(
    /\/api\/nodes\/node-1\/hosted-conversations\/conversation-1\/watch$/,
    (route) => {
      watchRequests.push(route.request().postDataJSON() as Record<string, unknown>);
      return fulfillMockHostedConversationWatch(page, route, conversation.id, initialSnapshot);
    }
  );
  await page.route(
    /\/api\/nodes\/node-1\/hosted-conversations\/conversation-1\/rollback$/,
    (route) => {
      rollbackBody = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
      return json(route, rolledBackSnapshot);
    }
  );

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '对话', exact: true }).click();

  const breadcrumb = page.locator('.workbench-header .breadcrumb');
  const history = page.locator('.hosted-conversation-history .history-list');
  await expect(breadcrumb).toContainText('首轮用户输入的临时标题');
  await expect(history.getByText('首轮用户输入的临时标题', { exact: true })).toBeVisible();
  const userMessage = page.locator('.conversation-item.user_message', {
    hasText: '请重新执行托管检查'
  });
  await expect(userMessage).toBeVisible();
  await expect(userMessage.getByRole('button', { name: '从此消息之前创建回退分支' })).toHaveCount(
    0
  );
  const rollbackButton = userMessage.getByRole('button', {
    name: '永久删除此用户消息及其后的对话记录'
  });
  await expect(rollbackButton).toHaveCount(0);
  expect(rollbackBody).toBeUndefined();
  await emitMockHostedConversationEvent(page, {
    kind: 'run',
    conversationId: conversation.id,
    run: { id: 'run-rollback', status: 'INTERRUPTED', startedAt: 3, completedAt: 4 }
  });
  await emitMockHostedConversationEvent(page, {
    kind: 'conversation',
    conversationId: conversation.id,
    conversation: idleConversation
  });
  await expect(breadcrumb).toContainText('中断任务生成的标题');
  await expect(history.getByText('中断任务生成的标题', { exact: true })).toBeVisible();
  await expect(history.getByText('首轮用户输入的临时标题', { exact: true })).toHaveCount(0);
  expect(watchRequests.filter((request) => request['mode'] === 'initial')).toHaveLength(1);
  await expect(rollbackButton).toBeVisible();
  const composer = page.getByPlaceholder('发送消息给 MAR Agent');
  await composer.fill('未发送草稿');

  await rollbackButton.click();
  const cancelled = page.locator('.el-message-box');
  await expect(cancelled).toContainText('回滚会永久移除此消息及其后的对话历史');
  await cancelled.getByRole('button', { name: '取消', exact: true }).click();
  await expect(userMessage).toBeVisible();
  await expect(composer).toHaveValue('未发送草稿');
  expect(rollbackBody).toBeUndefined();

  await rollbackButton.click();
  const confirmed = page.locator('.el-message-box');
  await confirmed.getByRole('button', { name: '回滚', exact: true }).click();

  await expect(page.getByText('请重新执行托管检查', { exact: true })).toHaveCount(0);
  await expect(page.getByText('这段回复会被回滚。', { exact: true })).toHaveCount(0);
  await expect(page.getByText('这段历史会被保留。', { exact: true })).toBeVisible();
  await expect(composer).toHaveValue('请重新执行托管检查');
  await expect(composer).toBeFocused();
  await expect(breadcrumb).toContainText('中断任务生成的标题');
  await expect(history.getByText('中断任务生成的标题', { exact: true })).toBeVisible();
  expect(rollbackBody).toEqual({
    turnId: 'turn-rollback',
    boundary: 'turn-retained'
  });
});
