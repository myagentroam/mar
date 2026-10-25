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

async function openEntry(page: Page) {
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
        : { templates: state.alternateAvailable ? [template, alternate] : [template] }
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
  await page.goto(`${fixture.url}hosted-entry.html`);
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
