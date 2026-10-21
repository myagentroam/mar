import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type APIResponse, type BrowserContext, type Page } from '@playwright/test';
import type { NodeConnector } from '../../mar-node/src/connector.js';
import type { NodeCapabilities } from '../../packages/protocol/src/index.js';
import { FakeRunner } from '../../mar-node/src/fake-runner.js';
import type { CodexAppServerClient } from '../../mar-node/src/codex-app-server.js';
import { INITIAL_ADMIN_PASSWORD } from '../../packages/server-core/src/password.js';

// Real Web, MySQL, HTTP/WS and Connector; only the external model Runner is deterministic.
test('Work session shares preserve the original conversation, readonly previews and revocation', async ({
  browser,
  baseURL
}) => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), 'mar-session-sharing-'));
  const workspacePath = join(directory, 'workspace');
  const contexts: BrowserContext[] = [];
  let connector: NodeConnector | undefined;
  const previousCodexHome = process.env.CODEX_HOME;
  const previousHome = process.env.HOME;
  process.env.HOME = join(directory, 'home');
  process.env.CODEX_HOME = join(directory, 'codex-home');
  try {
    await mkdir(process.env.HOME, { recursive: true });
    await mkdir(workspacePath);
    await writeFile(join(workspacePath, 'notes.md'), '# Shared notes\n\nRead-only delivery.\n');
    await writeFile(
      join(workspacePath, 'demo.html'),
      '<h1>Shared HTML</h1><script src=app.js></script>'
    );
    await writeFile(join(workspacePath, 'app.js'), 'document.body.dataset.loaded=String(true);');
    const owner = await browser.newContext({ baseURL: baseURL!, locale: 'en-US' });
    contexts.push(owner);
    const login = await json(
      await owner.request.post('/api/auth/login', {
        data: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
      }),
      200
    );
    const changed = await json(
      await owner.request.post('/api/auth/change-password', {
        headers: { 'x-csrf-token': login.csrfToken },
        data: { currentPassword: INITIAL_ADMIN_PASSWORD, password: 'ShareTestPassword123!' }
      }),
      200
    );
    const headers = { 'x-csrf-token': changed.csrfToken };
    const registration = await json(
      await owner.request.post('/api/node-registration-tokens', {
        headers,
        data: { displayName: 'Sharing test node' }
      }),
      200
    );
    const { NodeConnector } = await import('../../mar-node/src/connector.js');
    const capabilities: NodeCapabilities = {
      platform: 'linux',
      architecture: 'x64',
      nodeAppVersion: '0.10.36',
      nodeVersion: process.version,
      codex: { available: true },
      claudeCode: { available: false }
    };
    connector = new NodeConnector({
      configPath: join(directory, 'node.json'),
      config: {
        serverUrl: baseURL!,
        allowedRoots: [directory],
        dataDirectory: join(directory, 'node-data'),
        registrationToken: registration.token
      },
      capabilities,
      capabilityDetector: () => capabilities,
      reconnect: false,
      codexProfileClientFactory: () =>
        ({
          start: async () => undefined,
          stop: () => undefined,
          listModels: async () => ({ data: [], nextCursor: null })
        }) as unknown as CodexAppServerClient,
      fakeRunner: new ConversationFakeRunner(),
      fakeScript: (input) =>
        JSON.stringify(input).includes('hold-running')
          ? [{ type: 'long-running' }]
          : [
              { type: 'text', text: 'Shared reply: [notes](notes.md) · [HTML](demo.html)' },
              { type: 'success' }
            ]
    });
    await connector.start();
    let nodeId = '';
    await expect
      .poll(async () => {
        const result = await json(await owner.request.get('/api/nodes'), 200);
        nodeId = result.nodes.find((node: { connected: boolean }) => node.connected)?.id ?? '';
        return nodeId;
      })
      .not.toBe('');
    const workspace = await json(
      await owner.request.post('/api/workspaces', {
        headers,
        data: { nodeId, path: workspacePath }
      }),
      201
    );
    const workspaceId = workspace.workspace.id as string;
    const started = await json(
      await owner.request.post('/api/agent-sessions/start', {
        headers,
        data: {
          nodeId,
          workspaceId,
          runner: 'codex',
          cwd: workspacePath,
          title: 'Sharing acceptance',
          clientMessageId: 'share-seed',
          content: 'Existing conversation'
        }
      }),
      201
    );
    const sessionId = started.session.id as string;
    const consolePage = await owner.newPage();
    await consolePage.addInitScript(
      (selection) => localStorage.setItem('mar.workbench.selection.v1', JSON.stringify(selection)),
      { workspace: { nodeId, workspaceId }, sessionId }
    );
    await consolePage.goto('/console', { waitUntil: 'domcontentloaded', timeout: 10_000 });
    const sessionRow = consolePage
      .locator('.session-row')
      .filter({ hasText: 'Sharing acceptance' });
    await sessionRow.locator('.session-link').focus();
    await sessionRow.locator('.session-more-button').click({ timeout: 10_000 });
    await consolePage
      .getByRole('menuitem', { name: 'Share conversation', exact: true })
      .click({ timeout: 10_000 });
    const managementDialog = consolePage.getByRole('dialog');
    const creation = consolePage.waitForResponse(
      (response) => response.url().endsWith('/shares') && response.request().method() === 'POST'
    );
    await managementDialog.getByRole('button', { name: 'Create share', exact: true }).click();
    const createdResponse = await creation;
    expect(createdResponse.status()).toBe(201);
    const first = await createdResponse.json();
    await expect(managementDialog.locator('.share-text')).toContainText(first.password);
    await expect(managementDialog.locator('.share-text')).toContainText(
      new URL(`/share/${first.share.id}`, baseURL!).toString()
    );
    await expect(managementDialog.locator('.el-table')).toContainText('Active');
    const secondCreation = consolePage.waitForResponse(
      (response) => response.url().endsWith('/shares') && response.request().method() === 'POST'
    );
    await managementDialog.getByRole('button', { name: 'Create share', exact: true }).click();
    const secondResponse = await secondCreation;
    expect(secondResponse.status()).toBe(201);
    const second = await secondResponse.json();
    await expect(managementDialog.locator('.el-table__row')).toHaveCount(2);
    expect(first.password).toMatch(/^[0-9]{6}$/u);
    const guest = await browser.newContext({ baseURL: baseURL!, locale: 'en-US' });
    contexts.push(guest);
    const guest2 = await browser.newContext({ baseURL: baseURL!, locale: 'en-US' });
    contexts.push(guest2);
    const a = await guest.newPage();
    const b = await guest2.newPage();
    const errors: string[] = [];
    const forbidden: string[] = [];
    for (const page of [a, b]) {
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('request', (request) => {
        const path = new URL(request.url()).pathname;
        if (
          path.startsWith('/api/') &&
          !path.startsWith('/api/session-shares/') &&
          !path.startsWith('/api/html-preview/')
        )
          forbidden.push(path);
      });
    }
    await enter(a, first.share.id, first.password);
    await enter(b, first.share.id, first.password);
    await expect(a.locator('.share-person')).toHaveCount(3);
    await expect(a.locator('.share-people')).toContainText(/Anonymous#[0-9a-f]{6}/u);
    await expect(a.locator('.conversation-scroll-region')).toContainText('Existing conversation');
    await expect(a.locator('.conversation-scroll-region')).toContainText('Shared reply:');
    await expect(a.locator('.workspace-tree')).toHaveCount(0);
    await expect(a.locator('[data-completion-action]')).toHaveCount(0);
    await expect(a.locator('.composer-model-slot')).toHaveCount(0);
    await expect(a.locator('.composer-context-button')).toHaveCount(0);
    const editor = a.locator('textarea.composer-input');
    await editor.fill('hello from Alice');
    await editor.press('Enter');
    const naming = a.getByRole('dialog');
    await expect(naming).toContainText('Choose a name');
    await naming.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(editor).toHaveValue('hello from Alice');
    await editor.press('Enter');
    await a.getByRole('dialog').getByRole('textbox').fill('Alice');
    await a.getByRole('button', { name: 'Continue sending' }).click();
    await expect(editor).toHaveValue('');
    await expect(b.locator('.conversation-scroll-region')).toContainText('hello from Alice');
    await expect(consolePage.locator('.conversation-scroll-region')).toContainText(
      'External input · Web share · Alice'
    );
    await expect(consolePage.locator('.conversation-scroll-region')).not.toContainText(
      '<mar_channel>'
    );
    await expect(b.locator('.share-people')).toContainText('Alice');
    const uploaded = a.waitForResponse((response) => response.url().endsWith('/complete'));
    await a.locator('input[type=file]').setInputFiles({
      name: 'brief.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Shared attachment body')
    });
    expect((await uploaded).status()).toBe(200);
    await editor.fill('Message with attachment');
    await editor.press('Enter');
    const attachment = b.getByRole('button', { name: 'Preview file: brief.txt', exact: true });
    await expect(attachment).toBeVisible();
    await b.locator('textarea.composer-input').fill('Preserved draft');
    await attachment.click();
    await expect(b.locator('.cm-content')).toContainText('Shared attachment body');
    await expect(b.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
    await b.getByRole('button', { name: 'Close file window', exact: true }).click();
    await expect(b.locator('textarea.composer-input')).toHaveValue('Preserved draft');
    await b.getByRole('link', { name: 'notes', exact: true }).first().click();
    await expect(b.locator('.cm-content')).toContainText('Read-only delivery.');
    await b.getByRole('button', { name: 'Close file window', exact: true }).click();
    await a.screenshot({ path: test.info().outputPath('share-desktop.png') });
    await a.setViewportSize({ width: 390, height: 844 });
    await expect(a.getByRole('button', { name: /^Participants/u })).toBeVisible();
    expect(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await a.screenshot({ path: test.info().outputPath('share-mobile.png') });
    await a.setViewportSize({ width: 1280, height: 900 });
    await guest.clearCookies();
    await a.reload();
    await expect(a.locator('textarea.composer-input')).toBeEditable();
    await expect(a.locator('.share-people')).toContainText('Alice');
    await expect(a.getByRole('button', { name: 'Open conversation', exact: true })).toHaveCount(0);
    const preview = await guest.newPage();
    const fileIntent = `/share/${first.share.id}?standaloneFile=1&path=notes.md&write=1`;
    await preview.goto(fileIntent);
    await expect(preview.locator('.cm-content')).toContainText('Read-only delivery.');
    await expect(preview.locator('textarea.composer-input')).toHaveCount(0);
    await expect(preview.locator('.file-editor')).toHaveCount(0);
    await preview.reload();
    await expect(preview.locator('.cm-content')).toContainText('Read-only delivery.');
    await preview.goto(fileIntent + '&markdownPreview=1');
    await expect(preview.locator('h1')).toContainText('Shared notes');
    await preview.goto(`/share/${first.share.id}?standaloneFile=1&htmlPreview=1&path=demo.html`);
    await expect(
      preview.frameLocator('iframe').getByRole('heading', { name: 'Shared HTML' })
    ).toBeVisible();
    await expect(preview.frameLocator('iframe').locator('body')).toHaveAttribute(
      'data-loaded',
      'true'
    );
    await a.locator('textarea.composer-input').fill('hold-running');
    await a.locator('textarea.composer-input').press('Enter');
    await expect(b.locator('.composer-working')).toBeVisible();
    const queued = a.waitForResponse(
      (response) => response.url().endsWith('/messages') && response.request().method() === 'POST'
    );
    await a.locator('textarea.composer-input').fill('queued from Alice');
    await a.locator('textarea.composer-input').press('Enter');
    expect((await queued).status()).toBe(202);
    await expect(b.locator('.composer-queue')).toContainText('queued from Alice');
    const replaced = a.waitForResponse(
      (response) => response.url().endsWith('/messages') && response.request().method() === 'POST'
    );
    await a.locator('textarea.composer-input').fill('insert from Alice');
    await a.locator('textarea.composer-input').press('Control+Enter');
    expect((await replaced).request().postDataJSON().deliveryIntent).toBe('REPLACE_CURRENT');
    await expect(a.locator('.composer-working')).toHaveCount(0);
    await a.locator('textarea.composer-input').fill('hold-running again');
    await a.locator('textarea.composer-input').press('Enter');
    await expect(b.locator('.composer-working')).toBeVisible();
    await b.locator('.composer-stop-button').click();
    await expect(a.locator('.composer-working')).toHaveCount(0);
    const other = await guest2.newPage();
    await enter(other, second.share.id, second.password);
    await expect(other.locator('.conversation-scroll-region')).toContainText('hello from Alice');
    await managementDialog
      .locator('.el-table__row')
      .filter({ hasText: first.share.id })
      .getByRole('button', { name: 'Delete', exact: true })
      .click();
    const removal = consolePage.waitForResponse(
      (response) =>
        response.url().includes('/shares/' + first.share.id) &&
        response.request().method() === 'DELETE'
    );
    await consolePage.locator('.el-message-box__btns .el-button--primary').click();
    expect((await removal).status()).toBe(204);
    await expect(
      managementDialog.locator('.el-table__row').filter({ hasText: first.share.id })
    ).toHaveCount(0);
    await expect(a.locator('.share-entry')).toContainText('no longer available');
    await expect(b.locator('.share-entry')).toContainText('no longer available');
    await expect(other.locator('textarea.composer-input')).toBeEditable();
    await preview.reload();
    await expect(preview.locator('.share-preview')).toHaveCount(0);
    await preview.getByLabel('Password', { exact: true }).fill(first.password);
    await preview.getByRole('button', { name: 'Open conversation', exact: true }).click();
    await expect(preview.locator('.share-entry')).toContainText('no longer available');
    expect(forbidden).toEqual([]);
    expect(errors).toEqual([]);
  } catch (error) {
    console.error('Sharing journey failed:', error);
    throw error;
  } finally {
    await Promise.all(contexts.map((context) => context.close().catch(() => undefined)));
    await connector?.stop();
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(directory, { recursive: true, force: true });
  }
});

// Emit the normalized stream boundary rather than FakeRunner's legacy text diagnostic.
class ConversationFakeRunner extends FakeRunner {
  override start(...[runId, script, callbacks]: Parameters<FakeRunner['start']>): Promise<void> {
    return super.start(runId, script, {
      ...callbacks,
      event: (type, payload, status) =>
        callbacks.event(type === 'text' ? 'text.delta' : type, payload, status)
    });
  }
}

async function enter(page: Page, id: string, password: string): Promise<void> {
  await page.goto(`/share/${id}`);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click();
  await expect(page.locator('.share-room')).toBeVisible();
  await expect(page.locator('textarea.composer-input')).toBeEditable();
}
async function json(response: APIResponse, status: number) {
  const body = await response.json();
  expect(response.status(), JSON.stringify(body)).toBe(status);
  return body;
}
