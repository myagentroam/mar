import { expect, test, type Page } from '@playwright/test';
import {
  hostedConversationSummarySchema,
  hostedConversationSnapshotSchema,
  type HostedConversationSnapshot
} from '../../packages/protocol/src/index.js';
import { resolvedColorToHex } from '../../packages/web-core/src/util/theme-palette.js';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

// @test-covers packages/web-core/src/view/conversation/HostedConversationComposer.vue
let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;

async function expectHostedReadRing(ring: ReturnType<Page['locator']>) {
  await expect(ring).toBeVisible();
  const [width, height] = await ring.evaluate((element) => {
    const { width, height } = getComputedStyle(element);
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    return [parseFloat(width) / rem, parseFloat(height) / rem];
  });
  expect(width).toBeCloseTo(0.875);
  expect(height).toBeCloseTo(0.875);
}
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

for (const [width, theme, createColors] of [
  [1280, 'daylight', ['#deeaff', '#17243a', '#b9cadf']],
  [390, 'dark', ['#323232', '#eaeaea', '#3d3d3d']]
] as const) {
  test(`Hosted directory centers its first load at ${width}px in ${theme}`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width, height: 850 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    let releaseDirectory!: () => void;
    const pendingDirectory = new Promise<void>((resolve) => {
      releaseDirectory = resolve;
    });
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/hosted-conversations') {
        await pendingDirectory;
        return route.fulfill({ json: { items: [], nextCursor: null } });
      }
      if (path === '/api/conversation-templates') return route.fulfill({ json: { templates: [] } });
      return route.abort('failed');
    });
    const list = page.locator('#hosted-pane-history .history-list');
    const ring = list.locator('.mar-read-loading-indicator');
    try {
      await page.goto(
        `${fixture.url}hosted-entry.html?workspace-page=1&history-open=1&theme=${theme}`
      );
      await expect(list).toHaveAttribute('aria-busy', 'true');
      await expectHostedReadRing(ring);
      await expect(list.locator('.mar-ui-loading__indicator')).toHaveCount(0);
      const listBounds = (await list.boundingBox())!;
      const ringBounds = (await ring.boundingBox())!;
      expect(listBounds.height).toBeGreaterThan(200);
      expect(
        Math.abs(ringBounds.x + ringBounds.width / 2 - listBounds.x - listBounds.width / 2)
      ).toBeLessThan(1);
      expect(
        Math.abs(ringBounds.y + ringBounds.height / 2 - listBounds.y - listBounds.height / 2)
      ).toBeLessThan(1);
      const search = page.getByRole('textbox', { name: 'Search chat titles' });
      await expect(search).toBeVisible();
      await search.focus();
      const searchControl = page.locator('.history-search-row .mar-ui-input');
      const focusColor = await searchControl.evaluate((element) => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--mar-ui-control-focus)';
        element.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      });
      await expect(searchControl).toHaveCSS('box-shadow', `${focusColor} 0px 0px 0px 1px inset`);
      await search.blur();
      const newChat = page.getByRole('button', { name: 'New chat', exact: true });
      await expect(newChat).toBeEnabled();
      await expect(newChat).not.toHaveClass(/\bmar-ui-button--primary\b/);
      await expect(newChat).toHaveCSS('height', '26px');
      await expect(newChat).toHaveCSS('border-top-width', '1px');
      const colors = await newChat.evaluate((button) => {
        const style = getComputedStyle(button);
        return [style.backgroundColor, style.color, style.borderTopColor];
      });
      expect(colors.map(resolvedColorToHex)).toEqual(createColors);
      await expect(list.getByText('No conversations yet.')).toHaveCount(0);
      await list.screenshot({ path: testInfo.outputPath('hosted-directory-loading.png') });
    } finally {
      releaseDirectory();
    }
    await expect(ring).toHaveCount(0);
    await expect(list.getByText('No conversations yet.')).toBeVisible();
    await list.screenshot({ path: testInfo.outputPath('hosted-directory-empty.png') });
  });
}

test('Hosted create action stays readable with a bright custom tool hover color', async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.route('**/api/hosted-conversations?limit=*', (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } })
  );
  await page.route('**/api/conversation-templates', (route) =>
    route.fulfill({ json: { templates: [] } })
  );
  await page.goto(`${fixture.url}hosted-entry.html?workspace-page=1&theme=dark`);
  const create = page.getByRole('button', { name: 'New chat', exact: true });
  await expect(create).toBeEnabled();
  await page.evaluate(async (modulePath) => {
    const { themePreferenceService } = await import(modulePath);
    const service = themePreferenceService();
    const theme = service.saveCustomTheme(
      JSON.stringify({
        version: 1,
        name: 'Custom sidebar',
        colors: {
          '--mar-fill-row-hover': '#242424',
          '--mar-fill-selection': '#353535',
          '--mar-fill-muted': '#dadada',
          '--mar-text-primary': '#eeeeee',
          '--mar-control-primary-bg': '#ff2090'
        }
      })
    );
    service.setTheme(theme.id);
  }, '/packages/web-core/src/service/theme-preference-service.ts');
  const colors = await create.evaluate((button) => {
    const style = getComputedStyle(button);
    return [style.backgroundColor, style.color];
  });
  expect(colors.map(resolvedColorToHex)).toEqual(['#2c2c2c', '#eeeeee']);
});

const template = {
  id: 'template-1',
  nodeId: 'node-1',
  name: 'First template',
  description: '',
  status: 'ACTIVE',
  currentVersionId: 'version-1',
  available: true,
  createdAt: 1,
  updatedAt: 1
};
const alternate = { ...template, id: 'template-2', name: 'Second template' };

test('Hosted history uses green dots for running and stopping, with no idle dot', async ({
  page
}) => {
  const states = [
    { status: 'RUNNING', label: 'Running', color: 'rgb(53, 213, 110)' },
    { status: 'CANCELLING', label: 'Stopping', color: 'rgb(53, 213, 110)' },
    { status: 'IDLE', label: undefined, color: undefined }
  ] as const;
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.route('**/api/hosted-conversations?limit=*', (route) =>
    route.fulfill({
      json: {
        items: states.map(({ status }, index) =>
          hostedConversationSummarySchema.parse({
            id: `conversation-${index}`,
            nodeId: template.nodeId,
            sessionId: `session-${index}`,
            templateId: template.id,
            templateName: template.name,
            activeVersionId: template.currentVersionId,
            title: `Conversation ${index + 1}`,
            titleSource: 'CUSTOM',
            pinnedAt: null,
            status: 'ACTIVE',
            modelId: 'model-1',
            createdAt: 1,
            updatedAt: 1,
            lastActivityAt: 1,
            activity: { status, version: 1, updatedAt: 1 }
          })
        ),
        nextCursor: null
      }
    })
  );
  await page.route('**/api/conversation-templates', (route) =>
    route.fulfill({ json: { templates: [] } })
  );
  await page.goto(`${fixture.url}hosted-entry.html?workspace-page=1&theme=dark`);
  for (const [index, state] of states.entries()) {
    const row = page.getByRole('button', { name: new RegExp(`Conversation ${index + 1}`) });
    await expect(row).toBeVisible();
    const marker = row.locator('.history-run-indicator');
    if (state.color) {
      await expect(marker.locator('i')).toHaveCSS('background-color', state.color);
      await expect(row).toHaveAccessibleDescription(state.label);
      await marker.hover();
      await expect(page.getByRole('tooltip')).toHaveText(state.label);
    } else {
      await expect(marker).toHaveCount(0);
    }
  }
});

test('Draft template and model reads display local failure and loading states', async ({
  page
}, info) => {
  await page.setViewportSize({ width: 390, height: 860 });
  const catalog = Promise.withResolvers<void>();
  const model = Promise.withResolvers<void>();
  const modelRetry = Promise.withResolvers<void>();
  let templates = 0;
  let models = 0;
  await page.route('**/api/conversation-templates', async (route) => {
    if (++templates === 1) {
      await catalog.promise;
      return route.fulfill({ status: 503, json: { error: 'CATALOG_UNAVAILABLE' } });
    }
    return route.fulfill({ json: { templates: [template] } });
  });
  await page.route('**/conversation-templates/*/model-options', async (route) => {
    if (++models === 1) {
      await model.promise;
      return route.fulfill({ status: 503, json: { error: 'MODELS_UNAVAILABLE' } });
    }
    await modelRetry.promise;
    return route.fulfill({ json: { models: [], defaultModelId: null } });
  });
  const capture = (name: string) =>
    page.screenshot({ path: info.outputPath(`hosted-${name}.png`), animations: 'disabled' });
  await page.goto(`${fixture.url}hosted-entry.html?theme=daylight`);
  const trigger = page.locator('.hosted-template-trigger');
  await expect(trigger.locator('[data-mar-icon="loading-action"]')).toBeVisible();
  await expect(page.locator('.hosted-entry-page .mar-ui-loading')).toHaveCount(0);
  await capture('templates-loading');
  await trigger.click();
  catalog.resolve();
  await expect(page.getByText(/Unable to load templates/)).toBeVisible();
  await expect(page.getByText(/No conversation templates/)).toHaveCount(0);
  await capture('templates-failed');
  await page.keyboard.press('Escape');
  await trigger.click();
  await expect.poll(() => models).toBe(1);
  await page.keyboard.press('Escape');
  await expect(
    page.locator('.hosted-model-trigger [data-mar-icon="loading-action"]')
  ).toBeVisible();
  await capture('models-loading');
  model.resolve();
  const retry = page.getByRole('button', { name: 'Could not load models. Retry' });
  await expect(retry).toBeVisible();
  await capture('models-failed');
  await retry.click();
  await expect.poll(() => models).toBe(2);
  await expect(
    page.locator('.hosted-model-trigger [data-mar-icon="loading-action"]')
  ).toBeVisible();
  await capture('models-retrying');
  modelRetry.resolve();
  await expect(page.locator('.hosted-model-trigger [data-mar-icon="loading-action"]')).toHaveCount(
    0
  );
});

const models = ['model-1', 'model-2'].map((id) => ({
  id,
  name: id === 'model-1' ? 'Model One' : 'Model Two',
  protocol: 'OPENAI_RESPONSES',
  baseUrl: 'https://models.example.test/v1',
  modelId: id,
  contextWindowTokens: 100000,
  maxOutputTokens: 8192,
  inputCapabilities: ['TEXT'],
  outputCapabilities: ['TEXT'],
  reasoningEfforts: ['high'],
  defaultReasoningEffort: 'high',
  titleGeneration: false,
  codeMode: false,
  conversationModel: true,
  hostedWebSearch: false,
  responsesPreviousResponseId: false,
  enabled: true,
  sortOrder: 0
}));

test.describe('Mobile hosted draft', () => {
  test.use({
    hasTouch: true,
    isMobile: async ({ browserName }, use) => use(browserName !== 'firefox'),
    deviceScaleFactor: 3
  });

  // @test-covers packages/web-core/src/view/conversation/HostedConversationEntryPage.vue
  test('centers the new conversation guidance and Composer when space allows', async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 860 });
    await page.route('**/api/hosted-conversations?limit=*', (route) =>
      route.fulfill({ json: { items: [], nextCursor: null } })
    );
    await page.route('**/api/conversation-templates', (route) =>
      route.fulfill({ json: { templates: [{ ...template, name: 'Daily work' }] } })
    );
    await page.route('**/conversation-templates/*/model-options', (route) =>
      route.fulfill({ json: { models, defaultModelId: 'model-1' } })
    );
    await page.goto(`${fixture.url}hosted-entry.html?workspace-page=1&theme=daylight`);

    const draft = page.locator('.hosted-entry-page');
    const heading = draft.getByRole('heading', { name: 'How can I help?' });
    const hint = draft.getByText(
      'Choose a template, then send a message or attachment to start the conversation.'
    );
    await expect(heading).toBeVisible();
    await expect(hint).toBeVisible();
    await expect(draft.locator('.hosted-template-trigger')).toHaveText('Daily work');
    await expect(draft.locator('.hosted-model-trigger')).toHaveText('Model One');
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 860 });
      const area = (await draft.boundingBox())!;
      const title = (await heading.boundingBox())!;
      const hintBox = (await hint.boundingBox())!;
      const composer = (await draft.locator('.composer').boundingBox())!;
      expect(hintBox.x).toBeGreaterThanOrEqual(0);
      expect(hintBox.x + hintBox.width).toBeLessThanOrEqual(width);
      const gap = composer.y - (hintBox.y + hintBox.height);
      expect(gap).toBeGreaterThan(0);
      expect(gap).toBeLessThanOrEqual(24);
      expect(
        Math.abs((title.y + composer.y + composer.height) / 2 - area.y - area.height / 2)
      ).toBeLessThan(8);
    }
    await page.screenshot({
      path: testInfo.outputPath('mobile-hosted-welcome.png'),
      animations: 'disabled'
    });

    await page.setViewportSize({ width: 320, height: 240 });
    const guidance = draft.locator('.conversation-create-heading');
    const guidanceBox = (await guidance.boundingBox())!;
    const composer = (await draft.locator('.composer').boundingBox())!;
    expect(guidanceBox.y + guidanceBox.height).toBeLessThanOrEqual(composer.y);
    await hint.scrollIntoViewIfNeeded();
    const hintBox = (await hint.boundingBox())!;
    expect(hintBox.y).toBeGreaterThanOrEqual(guidanceBox.y);
    expect(hintBox.y + hintBox.height).toBeLessThanOrEqual(guidanceBox.y + guidanceBox.height + 1);
    await heading.scrollIntoViewIfNeeded();
    const headingBox = (await heading.boundingBox())!;
    expect(headingBox.y).toBeGreaterThanOrEqual(guidanceBox.y);
    expect(headingBox.y + headingBox.height).toBeLessThanOrEqual(
      guidanceBox.y + guidanceBox.height
    );
    expect(composer.y + composer.height).toBe(240);

    await draft.locator('.hosted-file-input').setInputFiles(
      Array.from({ length: 4 }, (_, index) => ({
        name: `draft-${index}.txt`,
        mimeType: 'text/plain',
        buffer: Buffer.from('draft attachment')
      }))
    );
    await expect(draft.locator('.hosted-attachments li')).toHaveCount(4);
    const scrollArea = page.locator('.conversation-draft');
    await expect(scrollArea).toHaveCSS('overflow-y', 'auto');
    await scrollArea.evaluate((element) => element.scrollTo(0, element.scrollHeight));
    await expect(draft.locator('.hosted-send-button')).toBeInViewport({ ratio: 1 });
  });
});

async function openEntry(
  page: Page,
  templateName = template.name,
  theme = 'dark',
  availableModels = models
) {
  const state = { failCatalog: false, modelAvailable: true, alternateAvailable: false };
  const creations: Array<{ templateId: string; modelId: string; clientRequestId: string }> = [];
  let catalogReads = 0;
  let modelReads = 0;
  await page.route('**/api/conversation-templates', async (route) => {
    catalogReads += 1;
    await route.fulfill({
      status: state.failCatalog ? 503 : 200,
      json: state.failCatalog
        ? { error: 'CATALOG_UNAVAILABLE' }
        : {
            templates: state.alternateAvailable
              ? [{ ...template, name: templateName }, alternate]
              : [{ ...template, name: templateName }]
          }
    });
  });
  await page.route('**/conversation-templates/*/model-options', async (route) => {
    modelReads += 1;
    await route.fulfill({
      json: {
        models: state.modelAvailable ? availableModels : [availableModels[0]],
        defaultModelId: 'model-1'
      }
    });
  });
  await page.route('**/api/nodes/node-1/hosted-conversations', async (route) => {
    creations.push(route.request().postDataJSON() as (typeof creations)[number]);
    // Unknown create result deliberately stops before Watch/upload/send; no backend is started.
    await route.abort('failed');
  });
  await page.goto(`${fixture.url}hosted-entry.html?theme=${theme}`);
  const modelControl = page.locator('.hosted-model-slot .hosted-model-trigger');
  await expect(modelControl).toHaveText(availableModels[0].name);
  await modelControl.click();
  await page.getByRole('menuitem', { name: availableModels[1].name, exact: true }).click();
  await expect(modelControl).toHaveText(availableModels[1].name);
  return {
    state,
    creations,
    modelControl,
    catalogReads: () => catalogReads,
    modelReads: () => modelReads
  };
}

async function refreshCatalog(page: Page, f: Awaited<ReturnType<typeof openEntry>>) {
  const reads = f.catalogReads();
  const modelReads = f.modelReads();
  const trigger = page.locator('.hosted-template-trigger');
  await trigger.click();
  await expect.poll(f.catalogReads).toBe(reads + 1);
  await expect(trigger).not.toHaveAttribute('aria-busy', 'true');
  if (!f.state.failCatalog) await expect.poll(f.modelReads).toBe(modelReads + 1);
  await expect(f.modelControl).not.toHaveAttribute('aria-busy', 'true');
}

async function sendDraft(page: Page, f: Awaited<ReturnType<typeof openEntry>>) {
  await page.keyboard.press('Escape');
  await page.locator('.conversation-create-panel textarea').fill('Use the selected model');
  const count = f.creations.length;
  await page.locator('.hosted-send-button').click();
  await expect.poll(() => f.creations.length).toBe(count + 1);
  await expect(page.locator('.hosted-send-button')).toBeEnabled();
}

function hostedHistoryTurn(
  sessionId: string,
  message: string
): HostedConversationSnapshot['turns'][number] {
  return {
    id: 'turn-1',
    sessionId,
    runId: null,
    userItemId: 'user-1',
    status: 'SUCCEEDED',
    model: null,
    effort: null,
    access: null,
    startedAt: 1,
    completedAt: 1,
    items: [
      {
        id: 'user-1',
        sessionId,
        turnId: 'turn-1',
        runId: null,
        parentItemId: null,
        sourceSequence: null,
        revision: 1,
        status: 'COMPLETED',
        startedAt: 1,
        completedAt: 1,
        kind: 'user_message',
        payload: { clientMessageId: null, text: message, delivery: 'ACCEPTED', contexts: [] }
      }
    ]
  };
}

async function openHostedSend(
  page: Page,
  { theme = 'dark', historyMessage }: { theme?: string; historyMessage?: string } = {}
) {
  const snapshot = hostedConversationSnapshotSchema.parse({
    conversation: {
      id: 'conversation-1',
      nodeId: 'node-1',
      sessionId: 'session-1',
      templateId: template.id,
      templateName: template.name,
      activeVersionId: 'version-1',
      title: 'Existing conversation',
      titleSource: 'CUSTOM',
      pinnedAt: null,
      status: 'ACTIVE',
      modelId: 'model-1',
      createdAt: 1,
      updatedAt: 1,
      lastActivityAt: 1
    },
    template,
    run: null,
    turns: historyMessage ? [hostedHistoryTurn('session-1', historyMessage)] : [],
    historyNextCursor: null,
    files: [],
    models,
    error: null,
    snapshotSequence: 1
  });
  const requests: { prompt: string; clientMessageId: string }[] = [];
  const replies: ((failure: boolean) => void)[] = [];
  const run = {
    id: 'run-1',
    status: 'RUNNING',
    startedAt: Date.now() - 5_000,
    completedAt: null
  } as const;
  let watchId: string;
  let sequence = 1;
  await page.route('**/api/hosted-template-fixture/current', (route) =>
    route.fulfill({ json: snapshot })
  );
  await page.route('**/api/hosted-conversations?limit=*', (route) =>
    route.fulfill({ json: { items: [snapshot.conversation], nextCursor: null } })
  );
  await page.route('**/hosted-conversations/conversation-1/watch', (route) => {
    if (route.request().method() === 'DELETE') return route.fulfill({ json: {} });
    watchId = route.request().postDataJSON().watchId;
    return route.fulfill({
      json: {
        accepted: true,
        watchId,
        nodeGeneration: 'fixture-generation',
        expiresAt: Date.now() + 30_000
      }
    });
  });
  await page.route('**/hosted-conversations/conversation-1/messages', async (route) => {
    requests.push(route.request().postDataJSON());
    const failure = await new Promise<boolean>((resolve) => replies.push(resolve));
    if (failure) {
      return route.fulfill({
        status: 409,
        json: { error: { code: 'HOSTED_CONVERSATION_RUN_ACTIVE' } }
      });
    }
    return route.fulfill({ json: { conversation: snapshot.conversation, run } });
  });

  await page.goto(
    `${fixture.url}hosted-entry.html?existing=1&workspace-page=1&watch-events=1&theme=${theme}`
  );
  const composer = page.locator('form.composer-host');
  const input = composer.locator('textarea');
  const send = composer.locator('.hosted-send-button');
  const sending = composer.locator('.composer-submitting');
  const working = composer.locator('.composer-working');
  const elapsed = composer.locator('.composer-elapsed');
  const prompt = 'Display this only from Hosted Watch.';
  const message = page.locator('.hosted-timeline-scroll').getByText(prompt, { exact: true });

  async function emitRun(status: 'RUNNING' | 'CANCELLING' | 'SUCCEEDED' = 'RUNNING') {
    const { clientMessageId } = requests.at(-1)!;
    async function emit(payload: object) {
      await page.evaluate(
        (detail) => window.dispatchEvent(new CustomEvent('fixture-hosted-watch', { detail })),
        {
          type: 'watch.hosted-conversation.event',
          workbenchConnectionId: 'fixture-connection',
          watchId,
          nodeGeneration: 'fixture-generation',
          nodeId: snapshot.conversation.nodeId,
          conversationId: snapshot.conversation.id,
          event: {
            sequence: ++sequence,
            category: 'hosted-conversation',
            payload: { conversationId: snapshot.conversation.id, ...payload }
          }
        }
      );
    }
    await emit({
      kind: 'run',
      run: { ...run, status, completedAt: status === 'SUCCEEDED' ? Date.now() : null }
    });
    if (status === 'RUNNING')
      await emit({
        kind: 'runtime',
        runtimeEvent: {
          kind: 'ITEM',
          executionId: run.id,
          turnId: 'turn-1',
          sequence: 1,
          createdAt: run.startedAt,
          payload: {
            item: {
              itemId: 'user-1',
              kind: 'user_message',
              status: 'COMPLETED',
              payload: { clientMessageId, text: prompt, contexts: [], delivery: 'ACCEPTED' }
            }
          }
        }
      });
  }
  return {
    composer,
    input,
    send,
    sending,
    working,
    elapsed,
    prompt,
    message,
    requests,
    emitRun,
    reply(failure = false) {
      const resolve = replies.shift();
      if (resolve === undefined) throw new Error('No pending Hosted message POST');
      resolve(failure);
    },
    release() {
      for (const resolve of replies.splice(0)) resolve(false);
    }
  };
}

for (const theme of ['daylight', 'dark']) {
  test(`Hosted draft keeps its canvas and controls steady after history in ${theme}`, async ({
    page
  }) => {
    await page.setViewportSize({ width: 1280, height: 844 });
    const refreshStarted = Promise.withResolvers<void>();
    const refresh = Promise.withResolvers<void>();
    const switchModels = Promise.withResolvers<void>();
    let catalogReads = 0;
    let firstTemplateModelReads = 0;
    await page.route('**/api/conversation-templates', (route) =>
      route.fulfill({
        json: { templates: ++catalogReads === 1 ? [template] : [template, alternate] }
      })
    );
    await page.route('**/conversation-templates/*/model-options', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith(`/${alternate.id}/model-options`)) {
        await switchModels.promise;
        return route.fulfill({ json: { models: [models[1]], defaultModelId: 'model-2' } });
      }
      if (++firstTemplateModelReads > 1) {
        refreshStarted.resolve();
        await refresh.promise;
      }
      return route.fulfill({ json: { models: [models[0]], defaultModelId: 'model-1' } });
    });

    const historyMessage = 'Previously sent message';
    await openHostedSend(page, { theme, historyMessage });
    const main = page.locator('#hosted-pane-conversation');
    const history = main.locator('.conversation-scroll');
    await expect(history.getByText(historyMessage)).toBeVisible();
    const historyCanvas = await history.evaluate(
      (element) => getComputedStyle(element).backgroundColor
    );
    const newChat = page.getByRole('button', { name: 'New chat', exact: true });
    const draft = main.locator('.hosted-entry-page');
    const input = draft.locator('textarea');
    const templateControl = draft.locator('.hosted-template-trigger');
    const modelControl = draft.locator('.hosted-model-slot .hosted-model-trigger');

    await newChat.click();
    await expect(modelControl).toHaveText('Model One');
    await input.fill('Keep this draft while switching templates');
    await page.getByRole('button', { name: /Existing conversation/ }).click();
    await expect(history.getByText(historyMessage)).toBeVisible();
    await newChat.click();
    await expect(modelControl).toHaveText('Model One');
    const draftCanvas = await draft.evaluate((element) => {
      for (let parent: Element | null = element; parent; parent = parent.parentElement) {
        const color = getComputedStyle(parent).backgroundColor;
        if (color !== 'rgba(0, 0, 0, 0)') return color;
      }
    });
    expect.soft(draftCanvas).toBe(historyCanvas);

    try {
      await templateControl.click();
      await refreshStarted.promise;
      const alternateItem = page.getByRole('menuitem', { name: alternate.name, exact: true });
      await expect(alternateItem).toBeVisible();
      await expect.soft(modelControl).toBeEnabled({ timeout: 1000 });
      await expect
        .soft(modelControl.locator('[data-mar-icon="chevron-down"]'))
        .toBeVisible({ timeout: 1000 });
      await expect(modelControl).toHaveText('Model One');

      await alternateItem.click();
      await expect(templateControl).toHaveText(alternate.name);
      await expect(modelControl).toBeDisabled();
      await expect(modelControl.locator('[data-mar-icon="loading-action"]')).toBeVisible();
      switchModels.resolve();
      await expect(modelControl).toHaveText('Model Two');
      const refreshed = page.waitForResponse('**/conversation-templates/template-1/model-options');
      refresh.resolve();
      await refreshed;
      await expect(modelControl).toHaveText('Model Two');
      await expect(modelControl).toBeEnabled();

      await templateControl.click();
      await page.getByRole('menuitem', { name: template.name, exact: true }).click();
      await expect(templateControl).toHaveText(template.name);
      await expect(modelControl).toHaveText('Model One');
      await expect(input).toHaveValue('Keep this draft while switching templates');
      await expect(history).toHaveCount(0);
    } finally {
      refresh.resolve();
      switchModels.resolve();
    }
  });
}

test('A model refresh failure remains retryable after returning from history', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  const refreshStarted = Promise.withResolvers<void>();
  const refresh = Promise.withResolvers<void>();
  let modelReads = 0;
  await page.route('**/api/conversation-templates', (route) =>
    route.fulfill({ json: { templates: [template] } })
  );
  await page.route('**/conversation-templates/*/model-options', async (route) => {
    if (++modelReads === 2) {
      refreshStarted.resolve();
      await refresh.promise;
      return route.fulfill({ status: 503, json: { error: 'MODELS_UNAVAILABLE' } });
    }
    return route.fulfill({ json: { models, defaultModelId: 'model-1' } });
  });
  await openHostedSend(page);
  const newChat = page.getByRole('button', { name: 'New chat', exact: true });
  const draft = page.locator('.hosted-entry-page');
  const model = draft.locator('.hosted-model-slot .hosted-model-trigger');
  const retry = draft.getByRole('button', { name: 'Could not load models. Retry' });

  try {
    await newChat.click();
    await expect(model).toHaveText('Model One');
    await draft.locator('.hosted-template-trigger').click();
    await refreshStarted.promise;
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /Existing conversation/ }).click();
    await expect(draft).toHaveCount(0);
    await newChat.click();
    await expect(model).toBeEnabled();
    refresh.resolve();
    await expect(retry).toBeVisible();
    await expect(model).toHaveText('Model One');
    await retry.click();
    await expect.poll(() => modelReads).toBe(3);
    await expect(model.locator('[data-mar-icon="chevron-down"]')).toBeVisible();
    await expect(retry).toHaveCount(0);
  } finally {
    refresh.resolve();
  }
});

test('A late catalog refresh loads the replacement template models after returning from history', async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  const refreshStarted = Promise.withResolvers<void>();
  const refresh = Promise.withResolvers<void>();
  let catalogReads = 0;
  await page.route('**/api/conversation-templates', async (route) => {
    if (++catalogReads === 1) return route.fulfill({ json: { templates: [template] } });
    refreshStarted.resolve();
    await refresh.promise;
    return route.fulfill({ json: { templates: [alternate] } });
  });
  await page.route('**/conversation-templates/*/model-options', (route) => {
    const index = route.request().url().endsWith(`/${alternate.id}/model-options`) ? 1 : 0;
    return route.fulfill({ json: { models: [models[index]], defaultModelId: models[index]!.id } });
  });
  await openHostedSend(page);
  const newChat = page.getByRole('button', { name: 'New chat', exact: true });
  const draft = page.locator('.hosted-entry-page');
  const templateControl = draft.locator('.hosted-template-trigger');
  const model = draft.locator('.hosted-model-slot .hosted-model-trigger');
  try {
    await newChat.click();
    await expect(model).toHaveText('Model One');
    await templateControl.click();
    await refreshStarted.promise;
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /Existing conversation/ }).click();
    await expect(draft).toHaveCount(0);
    await newChat.click();
    await expect(model).toHaveText('Model One');
    refresh.resolve();
    await expect(templateControl).toHaveText(alternate.name);
    await expect(model).toHaveText('Model Two');
    await expect(model).toBeEnabled();
  } finally {
    refresh.resolve();
  }
});

for (const theme of ['daylight', 'dark']) {
  test(`Hosted Composer keeps its focus border through keyboard and mouse send in ${theme}`, async ({
    page
  }) => {
    await page.setViewportSize({ width: 1280, height: 844 });
    const f = await openHostedSend(page, { theme });
    const shell = f.composer.locator('.composer-shell');
    try {
      await expect(f.input).toBeEditable();
      const idleBorder = await shell.evaluate(
        (element) => getComputedStyle(element).borderTopColor
      );
      await f.input.fill(f.prompt);
      const focusedBorder = await shell.evaluate(
        (element) => getComputedStyle(element).borderTopColor
      );
      expect(focusedBorder).not.toBe(idleBorder);

      await f.input.press('Enter');
      await expect.poll(() => f.requests.length).toBe(1);
      await expect(f.input).toHaveAttribute('readonly', '');
      await expect(f.input).toBeFocused();
      await expect(shell).toHaveCSS('border-top-color', focusedBorder);
      f.reply(true);
      await expect(f.input).toBeEditable();
      await expect(f.input).toHaveValue(f.prompt);
      await expect(shell).toHaveCSS('border-top-color', focusedBorder);

      await f.send.hover();
      await page.mouse.down();
      await expect(f.input).toBeFocused();
      await expect(shell).toHaveCSS('border-top-color', focusedBorder);
      await page.mouse.up();
      await expect.poll(() => f.requests.length).toBe(2);
      await expect(f.input).toHaveAttribute('readonly', '');
      await expect(f.input).toBeFocused();
      await expect(shell).toHaveCSS('border-top-color', focusedBorder);
      f.reply();
      await expect(f.input).toHaveValue('');
      await expect(f.input).toBeEditable();
      await expect(shell).toHaveCSS('border-top-color', focusedBorder);
      await f.input.blur();
      await expect(shell).toHaveCSS('border-top-color', idleBorder);
    } finally {
      f.release();
    }
  });
}

test('Hosted send displays only request feedback before Watch, including after HTTP settlement', async ({
  page
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const f = await openHostedSend(page);
  try {
    await f.input.fill(f.prompt);
    await f.input.blur();
    await expect(f.send).toHaveCSS('background-color', 'rgb(36, 114, 212)');
    await expect(f.send).toHaveCSS('color', 'rgb(255, 255, 255)');
    await page.screenshot({ path: testInfo.outputPath('chat-ready-dark.png') });
    await f.send.click();
    await expect.poll(() => f.requests.length).toBe(1);
    await expect(f.sending).toBeVisible();
    await expect(f.sending).toHaveCSS('color', 'rgb(194, 194, 194)');
    await expect(f.send).toBeDisabled();
    await expect(f.input).toHaveValue(f.prompt);
    await expect(f.message).toHaveCount(0);
    await expect(f.working).toHaveCount(0);
    await expect(f.elapsed).toHaveCount(0);
    await f.composer.evaluate((form: HTMLFormElement) => form.requestSubmit());

    f.reply(true);
    const error = page.locator('.mar-message--error');
    await expect(error).toBeVisible();
    await expect(f.sending).toHaveCount(0);
    await expect(f.input).toHaveValue(f.prompt);
    await expect(f.message).toHaveCount(0);
    await expect(f.working).toHaveCount(0);
    await expect(f.elapsed).toHaveCount(0);
    expect(f.requests).toHaveLength(1);
    await error.locator('.mar-ui-message__close').click();
    await expect(error).toHaveCount(0);

    await f.send.click();
    await expect.poll(() => f.requests.length).toBe(2);
    expect(f.requests[1]?.clientMessageId).not.toBe(f.requests[0]?.clientMessageId);
    f.reply();
    await expect(f.sending).toHaveCount(0);
    await expect(f.input).toHaveValue('');
    await expect(f.message).toHaveCount(0);
    await expect(f.working).toHaveCount(0);
    await expect(f.elapsed).toHaveCount(0);

    await f.emitRun();
    await expect(f.message).toBeVisible();
    await expect(f.working).toBeVisible();
    await expect(f.working).toHaveCSS('color', 'rgb(77, 163, 255)');
    await expect(f.working.locator('.mar-busy-indicator')).toHaveCSS('color', 'rgb(77, 163, 255)');
    const stop = page.locator('.mar-composer-stop-action');
    await expect(stop).toHaveCSS('color', 'rgb(255, 98, 107)');
    await expect(stop).toHaveCSS('border-top-color', 'rgb(255, 98, 107)');
    await expect(f.elapsed).toBeVisible();
    await page.mouse.move(0, 0);
    await page.screenshot({ path: testInfo.outputPath('chat-running-dark.png') });
  } finally {
    f.release();
  }
});

test('Hosted send shows Watch activity immediately and does not revive a terminal Run on HTTP success', async ({
  page
}) => {
  const f = await openHostedSend(page);
  try {
    await f.input.fill(f.prompt);
    await f.send.click();
    await expect.poll(() => f.requests.length).toBe(1);
    const ring = f.working.locator('.mar-busy-indicator');
    const activityColor = 'rgb(77, 163, 255)';
    await f.emitRun();
    await expect(f.sending).toBeVisible();
    await expect(f.message).toBeVisible();
    await expect(f.working).toBeVisible();
    await expect(f.working.getByRole('status')).toHaveText('Running');
    await expect(f.working).toHaveCSS('color', activityColor);
    await expect(ring).toHaveCSS('color', activityColor);
    await expect(f.elapsed).toBeVisible();

    await f.emitRun('CANCELLING');
    await expect(f.working.getByRole('status')).toHaveText('Stopping');
    await expect(f.working).toHaveCSS('color', activityColor);
    await expect(ring).toHaveCSS('color', activityColor);
    await expect(f.elapsed).toBeVisible();

    await f.emitRun('SUCCEEDED');
    await expect(f.working).toHaveCount(0);
    await expect(f.elapsed).toHaveCount(0);
    await expect(f.sending).toBeVisible();
    f.reply();
    await expect(f.sending).toHaveCount(0);
    await expect(f.input).toHaveValue('');
    await expect(f.message).toHaveCount(1);
    await expect(f.working).toHaveCount(0);
    await expect(f.elapsed).toHaveCount(0);
  } finally {
    f.release();
  }
});

for (const theme of ['daylight', 'dark']) {
  test(`Restored conversation keeps the normal composer surface while syncing in ${theme}`, async ({
    page
  }, testInfo) => {
    const snapshot = {
      nodeAppVersion: '0.11.31',
      conversation: {
        id: 'conversation-1',
        nodeId: 'node-1',
        sessionId: 'session-1',
        templateId: template.id,
        templateName: template.name,
        activeVersionId: 'version-1',
        title: 'A retained conversation',
        titleSource: 'CUSTOM',
        pinnedAt: null,
        status: 'ACTIVE',
        modelId: 'model-1',
        createdAt: 1,
        updatedAt: 1,
        lastActivityAt: 1,
        activity: { status: 'IDLE', version: 0, updatedAt: 0 }
      },
      template,
      run: null,
      turns: [],
      historyNextCursor: null,
      files: [],
      models,
      error: null,
      snapshotSequence: 1
    };
    let releaseWatch!: () => void;
    const pending = new Promise<void>((resolve) => {
      releaseWatch = resolve;
    });
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/hosted-template-fixture/current') return route.fulfill({ json: snapshot });
      if (path.endsWith('/watch')) {
        await pending;
        const body = route.request().postDataJSON();
        return route.fulfill({
          json: {
            accepted: true,
            watchId: body.watchId,
            nodeGeneration: 'fixture-generation',
            expiresAt: Date.now() + 30_000
          }
        });
      }
      return route.fulfill({ status: 404, json: {} });
    });
    await page.goto(`${fixture.url}hosted-entry.html?existing=1&watch-pending=1&theme=${theme}`);
    const shell = page.locator('.composer-shell');
    const input = page.locator('.composer-input');
    const activity = page.locator('.composer-working');
    const activityColor = theme === 'daylight' ? 'rgb(0, 95, 214)' : 'rgb(77, 163, 255)';
    let before: { backgroundColor: string; borderColor: string };
    try {
      await expect(activity).toContainText('Syncing');
      await expect(activity).toHaveCSS('color', activityColor);
      await expect(page.locator('.composer-busy-indicator')).toHaveCSS('color', activityColor);
      await expect(page.locator('.hosted-syncing')).toHaveCount(1);
      await expect(input).toHaveAttribute('readonly', '');
      before = await shell.evaluate((element) => {
        const { backgroundColor, borderColor } = getComputedStyle(element);
        return { backgroundColor, borderColor };
      });
      await input.focus();
      await expect(input).toBeFocused();
      await expect(shell).toHaveCSS('border-top-color', activityColor);
      await expect(activity).toHaveCSS('border-top-color', activityColor);
      await page.locator('.composer').screenshot({
        path: testInfo.outputPath('composer-syncing.png'),
        animations: 'disabled'
      });
    } finally {
      releaseWatch();
    }
    await expect(page.locator('.hosted-syncing')).toHaveCount(0);
    await expect(input).not.toHaveAttribute('readonly', '');
    await expect(input).toBeFocused();
    await expect(shell).toHaveCSS('border-top-color', activityColor);
    await input.blur();
    await expect(shell).toHaveCSS('background-color', before.backgroundColor);
    await expect(shell).toHaveCSS('border-color', before.borderColor);
  });
}

for (const [width, theme, cached] of [
  [1280, 'daylight', false],
  [390, 'dark', true]
] as const) {
  test(`Hosted Watch centers the first load and retries inline at ${width} in ${theme}`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const conversation = {
      id: 'conversation-1',
      nodeId: 'node-1',
      sessionId: 'session-1',
      templateId: template.id,
      templateName: template.name,
      activeVersionId: 'version-1',
      title: 'Recoverable conversation',
      titleSource: 'CUSTOM',
      status: 'ACTIVE',
      modelId: 'model-1',
      createdAt: 1,
      updatedAt: 1,
      lastActivityAt: 1,
      pinnedAt: null,
      activity: { status: 'IDLE', version: 0, updatedAt: 0 }
    };
    const snapshot = {
      nodeAppVersion: '0.11.31',
      conversation,
      template,
      turns: [],
      run: null,
      historyNextCursor: null,
      files: [],
      models,
      error: null,
      snapshotSequence: 1
    };
    const message = 'The latest message remains visible';
    const recovered = hostedConversationSnapshotSchema.parse({
      ...snapshot,
      historyNextCursor: 'older-page',
      turns: [hostedHistoryTurn(conversation.sessionId, message)]
    });
    let initialRequests = 0;
    let releaseInitial!: () => void;
    const pendingInitial = new Promise<void>((resolve) => {
      releaseInitial = resolve;
    });
    let releaseRetry!: () => void;
    const retrying = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    let releaseHistory!: () => void;
    const pendingHistory = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/hosted-template-fixture/current')
        return route.fulfill({ json: initialRequests > 1 ? recovered : snapshot });
      if (path === '/api/hosted-conversations')
        return route.fulfill({ json: { items: [conversation], nextCursor: null } });
      if (path.endsWith('/watch')) {
        if (route.request().method() === 'DELETE') return route.fulfill({ json: {} });
        const body = route.request().postDataJSON();
        if (body.mode === 'initial' && ++initialRequests === 1) {
          await pendingInitial;
          return route.fulfill({
            status: 503,
            json: {
              error: {
                code: 'NODE_OFFLINE',
                message: 'Node is offline.',
                details: 'Reconnect the Node.',
                requestId: 'hosted-watch-request'
              }
            }
          });
        }
        await retrying;
        return route.fulfill({
          json: {
            accepted: true,
            watchId: body.watchId,
            nodeGeneration: 'fixture-generation',
            expiresAt: Date.now() + 30_000
          }
        });
      }
      if (path.endsWith('/history')) {
        await pendingHistory;
        return route.fulfill({ json: { turns: [], nextCursor: null } });
      }
      return route.fulfill({ json: {} });
    });
    const scroll = page.locator('.hosted-conversation-main .conversation-scroll');
    try {
      await page.goto(
        `${fixture.url}hosted-entry.html?existing=1&workspace-page=1&watch-pending=1&theme=${theme}${cached ? '' : '&initial-empty=1'}`
      );
      const loading = scroll.getByRole('status', { name: 'Loading conversation history…' });
      const indicator = loading.locator('.mar-busy-indicator');
      await expectHostedReadRing(indicator);
      const viewport = (await scroll.boundingBox())!;
      const spinner = (await indicator.boundingBox())!;
      expect(
        Math.abs(spinner.x + spinner.width / 2 - viewport.x - viewport.width / 2)
      ).toBeLessThan(1);
      expect(
        Math.abs(spinner.y + spinner.height / 2 - viewport.y - viewport.height / 2)
      ).toBeLessThan(1);
    } finally {
      releaseInitial();
    }
    const retry = page.locator('.conversation-reload');
    await expect(retry).toHaveText('Failed to load. Retry');
    await expect(retry).toHaveAttribute('aria-description', /hosted-watch-request/);
    await expect(page.locator('.mar-message')).toHaveCount(0);
    async function expectRetryCentered() {
      await expect
        .poll(() =>
          retry.evaluate((button) => {
            const { x, y, width, height } = button.getBoundingClientRect();
            const viewport = button.closest('.conversation-scroll')!.getBoundingClientRect();
            return Math.max(
              Math.abs(x + width / 2 - (viewport.x + viewport.width / 2)),
              Math.abs(y + height / 2 - (viewport.y + viewport.height / 2))
            );
          })
        )
        .toBeLessThan(2);
    }
    await expectRetryCentered();
    await page.screenshot({
      path: testInfo.outputPath(`hosted-watch-failed-${width}-${theme}.png`),
      animations: 'disabled'
    });
    try {
      await retry.click();
      await expect(retry).toHaveAttribute('aria-busy', 'true');
      await expect(retry).toBeDisabled();
      await expect(retry.locator('.mar-busy-indicator')).toBeVisible();
      await expectRetryCentered();
      await page.screenshot({
        path: testInfo.outputPath(`hosted-watch-retrying-${width}-${theme}.png`),
        animations: 'disabled'
      });
      expect(initialRequests).toBe(2);
    } finally {
      releaseRetry();
    }
    await expect(retry).toHaveCount(0);
    await expect(page.locator('.composer-input')).not.toHaveAttribute('readonly', '');
    await expect(page.locator('.mar-message')).toHaveCount(0);
    const earlier = scroll.getByRole('status', { name: 'Loading earlier messages…' });
    try {
      await expect(earlier).toBeVisible();
      await expect(scroll.getByText(message)).toBeInViewport();
      const topGap = await earlier.evaluate((row) => {
        const content = row.closest('.conversation-scroll-content')!;
        return row.getBoundingClientRect().top - content.getBoundingClientRect().top;
      });
      expect(topGap).toBeGreaterThanOrEqual(8);
    } finally {
      releaseHistory();
    }
    await expect(earlier).toHaveCount(0);
    const inset = await scroll.evaluate((element) => {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
      const style = getComputedStyle(element);
      return {
        start: parseFloat(style.paddingInlineStart),
        end: parseFloat(style.paddingInlineEnd),
        workspace: Math.min(2.5 * rem, Math.max(rem, window.innerWidth * 0.04))
      };
    });
    expect(inset.start).toBeCloseTo(inset.workspace);
    expect(inset.end).toBeCloseTo(inset.workspace);
  });
}

for (const [width, theme] of [
  [1280, 'daylight'],
  [1280, 'dark'],
  [390, 'dark']
] as const) {
  test(`Hosted model and template share neutral dropdown triggers at ${width} in ${theme}`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const availableModels =
      width < 768
        ? [
            models[0],
            { ...models[1], name: 'Model Two — Extended configuration for research and analysis' }
          ]
        : models;
    const currentModelName = availableModels[1].name;
    const { modelControl } = await openEntry(page, template.name, theme, availableModels);
    const templateControl = page.locator('.hosted-template-trigger');
    await page.mouse.move(0, 0);
    const colors = await modelControl.evaluate((element) => {
      const probe = document.createElement('span');
      element.append(probe);
      const color = (token: string) => {
        probe.style.color = `var(${token})`;
        return getComputedStyle(probe).color;
      };
      const values = {
        hover: color('--mar-action-hover-overlay'),
        focus: color('--mar-control-focus'),
        label: color('--mar-text-primary'),
        arrow: color('--mar-text-secondary'),
        selected: color('--mar-fill-selection')
      };
      probe.remove();
      return values;
    });
    for (const trigger of [templateControl, modelControl]) {
      await page.mouse.move(0, 0);
      await expect(trigger).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(trigger).toHaveCSS('color', colors.label);
      await expect(trigger.locator('[data-mar-icon="chevron-down"]')).toHaveCSS(
        'color',
        colors.arrow
      );
      await trigger.hover();
      await expect(trigger).toHaveCSS('background-color', colors.hover);
      await expect(trigger).toHaveCSS('box-shadow', 'none');
    }
    await modelControl.click();
    await page.mouse.move(0, 0);
    await expect(modelControl).toHaveAttribute('aria-expanded', 'true');
    await expect(modelControl).toHaveCSS('background-color', colors.hover);
    const current = page.getByRole('menuitem', { name: currentModelName, exact: true });
    await expect(current).toHaveAttribute('aria-current', 'true');
    await expect(current).toHaveCSS('background-color', colors.selected);
    if (width < 768) {
      const triggerLabel = modelControl.locator(':scope > span');
      expect(await triggerLabel.evaluate((label) => label.scrollWidth > label.clientWidth)).toBe(
        true
      );
      expect(
        await current.getByText(currentModelName, { exact: true }).evaluate((label) => {
          const menu = label.closest('[role="menu"]')!.getBoundingClientRect();
          const rect = label.getBoundingClientRect();
          return (
            label.scrollWidth <= label.clientWidth &&
            rect.left >= menu.left &&
            rect.right <= menu.right &&
            menu.right <= innerWidth
          );
        })
      ).toBe(true);
    }
    await page.screenshot({
      path: testInfo.outputPath('hosted-model-expanded.png'),
      animations: 'disabled'
    });
    await page.keyboard.press('Escape');
    await expect(modelControl).toHaveAttribute('aria-expanded', 'false');
    await expect(modelControl).toBeFocused();
    await expect(modelControl).toHaveText(currentModelName);
    await templateControl.click();
    await page.mouse.move(0, 0);
    await expect(templateControl).toHaveAttribute('aria-expanded', 'true');
    await expect(templateControl).toHaveCSS('background-color', colors.hover);
    await expect(templateControl).toHaveCSS('box-shadow', 'none');
    await expect(page.getByRole('menuitem', { name: template.name, exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(templateControl).toHaveAttribute('aria-expanded', 'false');
    await expect(templateControl).toBeFocused();
    // Escape returns focus after a pointer click without necessarily switching input modality.
    await page.keyboard.press('Shift+Tab');
    for (const trigger of [templateControl, modelControl]) {
      await page.keyboard.press('Tab');
      await expect(trigger).toBeFocused();
      await expect(trigger).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(trigger).toHaveCSS('outline-style', 'solid');
      await expect(trigger).toHaveCSS('outline-color', colors.focus);
      await page.keyboard.press('Enter');
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
      await page.keyboard.press('Escape');
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      await expect(trigger).toBeFocused();
      await expect(trigger).toHaveCSS('outline-color', colors.focus);
    }
    await expect(modelControl).toHaveText(currentModelName);
  });
}

for (const width of [1280, 390]) {
  for (const theme of ['daylight', 'dark']) {
    test(`Existing template switch preserves drafts and uses the same Node at ${width} in ${theme}`, async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width, height: 844 });
      const target = { ...alternate, currentVersionId: 'version-2' };
      let current = {
        nodeAppVersion: '0.11.31',
        conversation: {
          id: 'conversation-1',
          nodeId: 'node-1',
          sessionId: 'session-1',
          templateId: template.id,
          templateName: template.name,
          activeVersionId: 'version-1',
          title: 'A retained conversation',
          titleSource: 'CUSTOM',
          pinnedAt: null,
          status: 'ACTIVE',
          modelId: 'model-1',
          createdAt: 1,
          updatedAt: 1,
          lastActivityAt: 1,
          activity: { status: 'IDLE', version: 0, updatedAt: 0 }
        },
        template,
        run: null,
        turns: [],
        historyNextCursor: null,
        files: [],
        models,
        error: null,
        snapshotSequence: 1
      };
      const writes: unknown[] = [];
      let watchCount = 0;
      let rejectSwitch = false;
      await page.route('**/api/**', async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/api/hosted-template-fixture/current')
          return route.fulfill({ json: current });
        if (path === '/api/conversation-templates')
          return route.fulfill({
            json: {
              templates: [
                template,
                target,
                {
                  ...target,
                  id: 'foreign-template',
                  nodeId: 'node-other',
                  name: 'Other host template'
                }
              ]
            }
          });
        if (path.endsWith('/watch')) {
          const body = route.request().postDataJSON();
          if (route.request().method() === 'POST' && body.mode === 'initial') watchCount += 1;
          return route.fulfill({
            json: {
              accepted: true,
              watchId: body.watchId,
              nodeGeneration: 'fixture-generation',
              expiresAt: Date.now() + 30_000
            }
          });
        }
        if (path.endsWith('/template')) {
          writes.push(route.request().postDataJSON());
          if (rejectSwitch)
            return route.fulfill({
              status: 409,
              json: {
                error: {
                  code: 'HOSTED_CONVERSATION_QUOTA_EXCEEDED',
                  message: 'The target quota is too small.'
                }
              }
            });
          current = {
            ...current,
            template: target,
            snapshotSequence: 2,
            conversation: {
              ...current.conversation,
              templateId: target.id,
              templateName: target.name,
              activeVersionId: 'version-2',
              modelId: 'model-2',
              updatedAt: 2
            }
          };
          return route.fulfill({
            json: { conversation: current.conversation, template: target, models }
          });
        }
        return route.fulfill({
          status: 404,
          json: { error: { code: 'ROUTE_NOT_FOUND', message: 'Unexpected fixture route.' } }
        });
      });
      await page.goto(`${fixture.url}hosted-entry.html?existing=1&theme=${theme}`);
      const textarea = page.getByPlaceholder('Message MAR Agent');
      await expect(textarea).toBeEnabled();
      await textarea.fill('Keep this unsent draft');
      const selector = page.locator('.hosted-template-trigger');
      await expect(selector.locator('[data-mar-icon="document"]')).toHaveCSS('width', '14px');
      await expect(selector.locator('[data-mar-icon="document"]')).toHaveCSS('height', '14px');
      await selector.click();
      await expect(page.getByRole('menuitem', { name: 'Other host template' })).toHaveCount(0);
      await page.getByRole('menuitem', { name: target.name, exact: true }).click();
      await expect(page.locator('.mar-message-box')).toContainText(
        'Existing history and files will be kept'
      );
      await expect(page.locator('.mar-message-box')).toContainText('apply to the next run');
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(page.locator('.mar-message-box')).toBeHidden();
      expect(writes).toEqual([]);
      await expect(textarea).toHaveValue('Keep this unsent draft');
      await selector.click();
      await page.getByRole('menuitem', { name: target.name, exact: true }).click();
      await page.getByRole('button', { name: 'Switch template', exact: true }).click();
      await expect(selector).toContainText(target.name);
      await expect(textarea).toBeEnabled();
      await expect(textarea).toHaveValue('Keep this unsent draft');
      await expect(page.locator('.hosted-model-slot .hosted-model-trigger')).toContainText(
        'Model Two'
      );
      expect(writes).toEqual([{ expectedTemplateId: template.id, templateId: target.id }]);
      expect(watchCount).toBe(2);
      await expect(page.locator('.mar-message--success')).toHaveCount(0);
      await expect(page.locator('.mar-message-box')).toBeHidden();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width
      );
      await page
        .locator('.composer-host > .composer')
        .screenshot({ path: testInfo.outputPath('template-switched.png') });
      rejectSwitch = true;
      await selector.click();
      await page.getByRole('menuitem', { name: template.name, exact: true }).click();
      await page.getByRole('button', { name: 'Switch template', exact: true }).click();
      await expect(page.locator('.mar-message--error')).toBeVisible();
      await expect(selector).toContainText(target.name);
      await expect(textarea).toHaveValue('Keep this unsent draft');
      expect(watchCount).toBe(2);
    });
  }
}

test('Opening the real template menu preserves the selected model and submits it after refresh', async ({
  page
}) => {
  const f = await openEntry(page);
  await refreshCatalog(page, f);
  expect(f.modelReads()).toBe(2);
  await expect(f.modelControl).toHaveText('Model Two');
  await sendDraft(page, f);
  expect(f.creations[0]).toMatchObject({ templateId: template.id, modelId: 'model-2' });
});

test('A failed menu catalog refresh preserves the model and unknown create identity', async ({
  page
}) => {
  const f = await openEntry(page);
  await sendDraft(page, f);
  f.state.failCatalog = true;
  await refreshCatalog(page, f);
  expect(f.modelReads()).toBe(1);
  await expect(f.modelControl).toHaveText('Model Two');
  await expect(page.locator('.mar-message--error').last()).toContainText(
    'Hosted entry fixture request failed'
  );
  await sendDraft(page, f);
  expect(f.creations[1]).toEqual(f.creations[0]);
});

test('Menu refresh falls back for an unavailable model and a real template switch loads the default', async ({
  page
}) => {
  const f = await openEntry(page);
  await sendDraft(page, f);
  f.state.modelAvailable = false;
  await refreshCatalog(page, f);
  await expect(f.modelControl).toHaveText('Model One');
  await sendDraft(page, f);
  expect(f.creations[1]?.modelId).toBe('model-1');
  expect(f.creations[1]?.clientRequestId).not.toBe(f.creations[0]?.clientRequestId);

  f.state.modelAvailable = true;
  f.state.alternateAvailable = true;
  await refreshCatalog(page, f);
  await page.keyboard.press('Escape');
  await f.modelControl.click();
  await page.getByRole('menuitem', { name: 'Model Two', exact: true }).click();
  await expect(f.modelControl).toHaveText('Model Two');
  await refreshCatalog(page, f);
  await page.getByRole('menuitem', { name: alternate.name, exact: true }).click();
  await expect(page.locator('.hosted-template-trigger')).toHaveText(alternate.name);
  await expect(f.modelControl).toHaveText('Model One');
  await sendDraft(page, f);
  expect(f.creations[2]).toMatchObject({ templateId: alternate.id, modelId: 'model-1' });
});

for (const width of [1280, 390]) {
  for (const theme of ['daylight', 'dark']) {
    test(`Template menu does not overlap its name tooltip at ${width} in ${theme}`, async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width, height: 844 });
      const name = 'Office documents and research with a long template name';
      await openEntry(page, name, theme);
      await page.clock.install();
      const trigger = page.locator('.hosted-template-trigger');
      const tooltip = page.locator('.mar-tooltip:visible');
      await trigger.hover();
      await page.clock.fastForward(1000);
      await expect(tooltip).toContainText(name);
      await trigger.click();
      await expect(page.getByRole('menuitem', { name, exact: true })).toBeVisible();
      await page.mouse.move(0, 0);
      await trigger.hover();
      await page.clock.fastForward(1000);
      await expect(tooltip).toHaveCount(0);
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
      await page.screenshot({ path: testInfo.outputPath('template-menu-open.png') });
      await page.keyboard.press('Escape');
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      await page.mouse.move(0, 0);
      await trigger.hover();
      await page.clock.fastForward(1000);
      await expect(tooltip).toContainText(name);
      await trigger.press('Enter');
      await expect(page.getByRole('menuitem', { name, exact: true })).toBeVisible();
      await page.clock.fastForward(1000);
      await expect(tooltip).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    });

    test(`Hosted template presentation stays aligned before and after creation at ${width} in ${theme}`, async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width, height: 844 });
      const name = '日常办公 Office documents and research with a long template name';
      await openEntry(page, name, theme);
      const draftTemplate = page.locator('.hosted-template-trigger');
      await expect(draftTemplate.locator('[data-mar-icon="document"]')).toBeVisible();
      await expect(draftTemplate.locator('[data-mar-icon="document"]')).toHaveCSS('width', '14px');
      await expect(draftTemplate.locator('[data-mar-icon="document"]')).toHaveCSS('height', '14px');
      await expect(draftTemplate.locator('[data-mar-icon="chevron-down"]')).toBeVisible();
      await expect(draftTemplate).toHaveAccessibleName('Load template');
      await expect(draftTemplate).toBeEnabled();
      const draftStyle = await draftTemplate.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          background: style.backgroundColor,
          fontSize: style.fontSize,
          height: element.getBoundingClientRect().height
        };
      });

      async function assertToolbar(templateSelector: string) {
        const templateControl = page.locator(templateSelector);
        const toolbar = page.locator('.hosted-composer-toolbar');
        const attachment = (await toolbar.locator('.hosted-icon-button').boundingBox())!;
        if (width < 768) {
          const icon = toolbar.locator('.hosted-icon-button [data-mar-icon="attachment"]');
          await expect(icon).toHaveCSS('width', '16px');
          await expect(icon).toHaveCSS('height', '16px');
        }
        const templateBox = (await templateControl.boundingBox())!;
        const model = (await toolbar.locator('.hosted-model-trigger').boundingBox())!;
        const send = (await toolbar.locator('.hosted-send-button').boundingBox())!;
        expect(attachment.x + attachment.width).toBeLessThanOrEqual(templateBox.x);
        expect(templateBox.x + templateBox.width).toBeLessThanOrEqual(model.x);
        expect(model.x + model.width).toBeLessThanOrEqual(send.x);
        expect(
          Math.abs(templateBox.y + templateBox.height / 2 - model.y - model.height / 2)
        ).toBeLessThan(1);
        expect(send.x + send.width).toBeLessThanOrEqual(width);
        const label = templateControl.locator(':scope > span');
        expect((await label.boundingBox())!.width).toBeGreaterThan(20);
        await expect(label).toHaveText(name);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          width
        );
      }

      await page.mouse.move(0, 0);
      await assertToolbar('.hosted-template-trigger');
      await page
        .locator('.composer-host > .composer')
        .screenshot({ path: testInfo.outputPath('new.png') });
      await draftTemplate.click();
      await expect(page.getByRole('menuitem', { name, exact: true })).toBeVisible();
      await page.keyboard.press('Escape');

      const query = new URLSearchParams({ hosted: '1', theme, 'template-name': name });
      if (width < 768) query.set('mobile', '1');
      await page.goto(`${fixture.url}visual-alignment.html?${query}`);
      const savedTemplate = page.locator('.hosted-template-trigger');
      await expect(savedTemplate).toBeVisible();
      await expect(savedTemplate).toBeDisabled();
      await expect(savedTemplate).toHaveAccessibleName('Load template');
      await expect(savedTemplate).toHaveAccessibleDescription(name);
      const disabledColor = await savedTemplate.evaluate((element) => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--mar-text-disabled)';
        element.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      });
      await expect(savedTemplate).toHaveCSS('color', disabledColor);
      await expect(savedTemplate).toHaveCSS('background-color', draftStyle.background);
      await expect(savedTemplate).toHaveCSS('font-size', draftStyle.fontSize);
      expect((await savedTemplate.boundingBox())!.height).toBe(draftStyle.height);
      await expect(savedTemplate.locator('[data-mar-icon="document"]')).toBeVisible();
      await expect(savedTemplate.locator('[data-mar-icon="document"]')).toHaveCSS('width', '14px');
      await expect(savedTemplate.locator('[data-mar-icon="document"]')).toHaveCSS('height', '14px');
      await expect(savedTemplate.locator('[data-mar-icon="chevron-down"]')).toBeVisible();
      for (const iconName of ['document', 'chevron-down']) {
        await expect(savedTemplate.locator(`[data-mar-icon="${iconName}"]`)).toHaveCSS(
          'color',
          disabledColor
        );
      }
      await assertToolbar('.hosted-template-trigger');
      await page
        .locator('.composer-host > .composer')
        .screenshot({ path: testInfo.outputPath('existing.png') });
      await savedTemplate.hover();
      await expect(page.locator('.mar-tooltip:visible')).toContainText(name);
      await expect(savedTemplate).toHaveCSS('background-color', draftStyle.background);
      await expect(savedTemplate).toHaveCSS('box-shadow', 'none');
      const savedBox = (await savedTemplate.boundingBox())!;
      await page.mouse.click(savedBox.x + savedBox.width / 2, savedBox.y + savedBox.height / 2);
      await expect(page.getByRole('menu')).toHaveCount(0);
    });
  }
}
