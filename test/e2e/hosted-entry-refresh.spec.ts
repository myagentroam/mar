import { expect, test, type Page } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
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
  sortOrder: 0,
  apiKeyConfigured: true
}));

async function openEntry(page: Page, templateName = template.name, theme = 'vscode-dark-2026') {
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
      json: { models: state.modelAvailable ? models : [models[0]], defaultModelId: 'model-1' }
    });
  });
  await page.route('**/api/nodes/node-1/hosted-conversations', async (route) => {
    creations.push(route.request().postDataJSON() as (typeof creations)[number]);
    // Unknown create result deliberately stops before Watch/upload/send; no backend is started.
    await route.abort('failed');
  });
  await page.goto(`${fixture.url}hosted-entry.html?theme=${theme}`);
  const modelControl = page.locator('.hosted-model-slot .hosted-model-trigger');
  await expect(modelControl).toHaveText('Model One');
  await modelControl.click();
  await page.getByRole('menuitem', { name: 'Model Two', exact: true }).click();
  await expect(modelControl).toHaveText('Model Two');
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
  await page.locator('.hosted-template-trigger').click();
  await expect.poll(f.catalogReads).toBe(reads + 1);
  await expect(page.locator('.hosted-entry-page')).toHaveAttribute('aria-busy', 'false');
}

async function sendDraft(page: Page, f: Awaited<ReturnType<typeof openEntry>>) {
  await page.keyboard.press('Escape');
  await page.locator('.conversation-create-panel textarea').fill('Use the selected model');
  const count = f.creations.length;
  await page.locator('.hosted-send-button').click();
  await expect.poll(() => f.creations.length).toBe(count + 1);
  await expect(page.locator('.hosted-send-button')).toBeEnabled();
}

for (const theme of ['daylight', 'vscode-dark-2026']) {
  test(`Restored conversation keeps the normal composer surface while syncing in ${theme}`, async ({
    page
  }) => {
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
    await expect(page.locator('.composer-working')).toContainText('Syncing');
    await expect(page.locator('.hosted-syncing')).toHaveCount(1);
    await expect(input).toHaveAttribute('readonly', '');
    const background = await shell.evaluate((element) => getComputedStyle(element).backgroundColor);
    const border = await shell.evaluate((element) => getComputedStyle(element).borderColor);
    releaseWatch();
    await expect(page.locator('.hosted-syncing')).toHaveCount(0);
    await expect(input).not.toHaveAttribute('readonly', '');
    await expect(shell).toHaveCSS('background-color', background);
    await expect(shell).toHaveCSS('border-color', border);
  });
}

for (const [width, theme] of [
  [1280, 'daylight'],
  [390, 'vscode-dark-2026']
] as const) {
  test(`Template and model controls share selector states at ${width} in ${theme}`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const { modelControl } = await openEntry(page, template.name, theme);
    const templateControl = page.locator('.hosted-template-trigger');
    await page.mouse.move(0, 0);
    await expect(templateControl).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(modelControl).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await templateControl.hover();
    const templateHover = await templateControl.evaluate((element) => ({
      background: getComputedStyle(element).backgroundColor,
      shadow: getComputedStyle(element).boxShadow
    }));
    await modelControl.hover();
    await expect(modelControl).toHaveCSS('background-color', templateHover.background);
    await expect(modelControl).toHaveCSS('box-shadow', templateHover.shadow);
    await templateControl.click();
    await expect(templateControl).toHaveAttribute('aria-expanded', 'true');
    await expect(templateControl).not.toHaveCSS('box-shadow', templateHover.shadow);
  });
}

for (const width of [1280, 390]) {
  for (const theme of ['daylight', 'vscode-dark-2026']) {
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
      await expect(page.locator('.el-message-box')).toContainText(
        'Existing history and files will be kept'
      );
      await expect(page.locator('.el-message-box')).toContainText('apply to the next run');
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
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
      await expect(page.locator('.el-message--success')).toHaveCount(0);
      await expect(page.locator('.el-message-box')).toBeHidden();
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
      await expect(page.locator('.el-message--error')).toBeVisible();
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
  await expect(page.locator('.el-message--error').last()).toContainText(
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
  for (const theme of ['daylight', 'vscode-dark-2026']) {
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
      const draftStyle = await draftTemplate.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          color: style.color,
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
        const model = (await toolbar
          .locator('.hosted-model-trigger:not(.hosted-template-trigger)')
          .boundingBox())!;
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
      const savedTemplate = page.locator('.hosted-template-name');
      await expect(savedTemplate).toBeVisible();
      await expect(savedTemplate).toHaveCSS('color', draftStyle.color);
      await expect(savedTemplate).toHaveCSS('background-color', draftStyle.background);
      await expect(savedTemplate).toHaveCSS('font-size', draftStyle.fontSize);
      expect((await savedTemplate.boundingBox())!.height).toBe(draftStyle.height);
      await expect(savedTemplate.locator('[data-mar-icon="document"]')).toBeVisible();
      await expect(savedTemplate.locator('[data-mar-icon="document"]')).toHaveCSS('width', '14px');
      await expect(savedTemplate.locator('[data-mar-icon="document"]')).toHaveCSS('height', '14px');
      await expect(savedTemplate.locator('[data-mar-icon="chevron-down"]')).toHaveCount(0);
      expect(await savedTemplate.evaluate((element) => element.tagName)).toBe('SPAN');
      await assertToolbar('.hosted-template-name');
      await page
        .locator('.composer-host > .composer')
        .screenshot({ path: testInfo.outputPath('existing.png') });
      await savedTemplate.hover();
      await expect(page.locator('.mar-tooltip:visible')).toContainText(name);
      await savedTemplate.click();
      await expect(page.getByRole('menu')).toHaveCount(0);
    });
  }
}
