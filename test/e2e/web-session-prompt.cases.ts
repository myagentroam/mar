import { expect, test } from '@playwright/test';
import { json, mockConsoleApi } from './support/web-console-api.js';

for (const gate of ['node-version', 'session-capability'] as const) {
  test('Session Prompt menu respects ' + gate, async ({ page }) => {
    await mockConsoleApi(
      page,
      'MANAGED',
      ['history.read', 'turn.start'],
      [],
      'GIT_WORKSPACE',
      true,
      undefined,
      undefined,
      gate === 'node-version' ? '0.10.32' : '0.10.33'
    );
    await page.route('**/api/agent-sessions?nodeId=node-1*', (route) =>
      json(route, {
        sessions: [
          {
            id: 'session-1',
            workspaceId: 'workspace-1',
            runner: 'codex',
            externalSessionId: 'session-1',
            runnerTitle: 'Gated session',
            activity: 'IDLE',
            runtime: {
              level: 'MANAGED',
              capabilities: [
                'history.read',
                'turn.start',
                ...(gate === 'node-version' ? ['session.prompt'] : [])
              ]
            }
          }
        ]
      })
    );
    await page.goto('/console');
    await page.getByRole('button', { name: '进入控制台' }).click();
    await page.getByRole('button', { name: '工作', exact: true }).click();
    await page
      .locator('.workspace-tree')
      .getByRole('button', { name: /node-1/ })
      .click();
    await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
    const row = page.locator('.session-row').filter({ hasText: 'Gated session' });
    await row.hover();
    await row.getByRole('button', { name: /更多会话操作/ }).click();
    const menu = page.locator('.el-dropdown__popper:visible');
    await expect(menu.getByRole('menuitem', { name: '重命名', exact: true })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: '会话提示词', exact: true })).toHaveCount(0);
  });
}

for (const [locale, theme] of [
  ['zh-CN', 'daylight'],
  ['zh-CN', 'vscode-dark-2026'],
  ['en-US', 'daylight'],
  ['en-US', 'vscode-dark-2026']
] as const) {
  test(`Session Prompt edits persist, clear, and retain failed input (${locale}, ${theme})`, async ({
    page
  }) => {
    const writes: { url: string; csrf: string | undefined; body: string }[] = [];
    await mockConsoleApi(
      page,
      'MANAGED',
      ['history.read', 'turn.start'],
      writes,
      'GIT_WORKSPACE',
      true,
      undefined,
      undefined,
      '0.10.33'
    );
    await page.addInitScript((language) => localStorage.setItem('mar.locale.v2', language), locale);
    const english = locale === 'en-US';
    await page.addInitScript((value) => localStorage.setItem('mar.theme', value), theme);
    if (english) await page.setViewportSize({ width: 1100, height: 800 });
    const title = english ? 'Session Prompt' : '会话提示词';
    let prompt: string | null = 'Existing session instructions';
    let failWrite = false;
    let failRead = false;
    let readCount = 0;
    let writeCount = 0;
    const session = () => ({
      id: 'session-1',
      workspaceId: 'workspace-1',
      runner: 'codex',
      externalSessionId: 'session-1',
      nativeControl: 'EXTERNAL',
      runnerTitle: 'Prompt session',
      customTitle: null,
      sessionPrompt: prompt,
      activity: 'IDLE',
      runtime: {
        level: 'MANAGED',
        capabilities: ['history.read', 'turn.start', 'session.prompt']
      }
    });
    await page.route('**/api/agent-sessions?nodeId=node-1*', (route) =>
      json(route, { sessions: [session()] })
    );
    await page.route('**/api/agent-sessions/session-1?nodeId=node-1', (route) => {
      readCount += 1;
      return failRead
        ? json(route, { error: { code: 'INTERNAL_ERROR', message: 'Prompt unavailable' } }, 500)
        : json(route, { session: session() });
    });
    await page.route('**/api/agent-sessions/session-1/metadata', (route) => {
      writeCount += 1;
      const body = JSON.parse(route.request().postData() ?? '{}');
      expect(Object.keys(body).sort()).toEqual(['nodeId', 'sessionPrompt']);
      expect(body.nodeId).toBe('node-1');
      expect(route.request().headers()['x-csrf-token']).toBe('csrf-1');
      if (failWrite)
        return json(route, { error: { code: 'INTERNAL_ERROR', message: 'Save failed' } }, 500);
      prompt = body.sessionPrompt;
      return json(route, { session: session() });
    });
    await page.goto('/console');
    await page.getByRole('button', { name: english ? 'Open console' : '进入控制台' }).click();
    await page.getByRole('button', { name: english ? 'Work' : '工作', exact: true }).click();
    await page
      .locator('.workspace-tree')
      .getByRole('button', { name: /node-1/ })
      .click();
    await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
    const dialog = page.getByRole('dialog', { name: title, exact: true });
    const textarea = dialog.getByRole('textbox', { name: title, exact: true });
    const save = dialog.getByRole('button', { name: english ? 'Save' : '保存', exact: true });
    const cancel = dialog.getByRole('button', { name: english ? 'Cancel' : '取消', exact: true });
    let checkedMenu = false;
    async function open() {
      const row = page.locator('.session-row').filter({ hasText: 'Prompt session' });
      await row.hover();
      await row
        .getByRole('button', { name: english ? /More session actions/ : /更多会话操作/ })
        .click();
      const menu = page.locator('.el-dropdown__popper:visible');
      const promptItem = menu.getByRole('menuitem', { name: title, exact: true });
      if (!checkedMenu) {
        const renameItem = menu.getByRole('menuitem', {
          name: english ? 'Rename' : '重命名',
          exact: true
        });
        const renameIcon = renameItem.locator('svg');
        const promptIcon = promptItem.locator('svg');
        await expect(renameIcon).toBeVisible();
        await expect(promptIcon).toBeVisible();
        const iconPaths = (paths: Element[]) => paths.map((path) => path.getAttribute('d'));
        expect(await promptIcon.locator('path').evaluateAll(iconPaths)).not.toEqual(
          await renameIcon.locator('path').evaluateAll(iconPaths)
        );
        await menu.screenshot({
          path: test.info().outputPath('session-menu.png'),
          animations: 'disabled'
        });
        const renameBounds = (await renameIcon.boundingBox())!;
        const promptBounds = (await promptIcon.boundingBox())!;
        expect(promptBounds.width).toBeCloseTo(renameBounds.width, 2);
        expect(promptBounds.height).toBeCloseTo(renameBounds.height, 2);
        expect(promptBounds.x).toBeCloseTo(renameBounds.x, 2);
        await expect(page.locator('html')).toHaveAttribute('lang', locale);
        await expect(page.locator('html')).toHaveClass(
          theme === 'daylight' ? /^(?!.*dark).*$/ : /dark/
        );
        await renameItem.click();
        const renameDialog = page.locator('.el-message-box');
        await expect(renameDialog).toBeVisible();
        await expect(renameDialog.locator('input')).toHaveValue('Prompt session');
        await renameDialog
          .getByRole('button', { name: english ? 'Cancel' : '取消', exact: true })
          .click();
        expect(writeCount).toBe(0);
        await row.hover();
        await row
          .getByRole('button', { name: english ? /More session actions/ : /更多会话操作/ })
          .click();
        checkedMenu = true;
      }
      await promptItem.click();
      await expect(dialog).toBeVisible();
    }
    await open();
    await expect(textarea).toHaveValue(prompt!);
    await textarea.fill('  Review only this issue.\nPreserve unrelated work.  ');
    await save.click();
    await expect(dialog).not.toBeVisible();
    expect(prompt).toBe('Review only this issue.\nPreserve unrelated work.');
    await open();
    await expect(textarea).toHaveValue(prompt!);
    await textarea.fill('x'.repeat(20_001));
    await save.click();
    await expect(
      dialog.getByText(
        english
          ? 'Session Prompt cannot exceed 20,000 characters.'
          : '会话提示词不能超过 20000 个字符。'
      )
    ).toBeVisible();
    expect(writeCount).toBe(1);
    await textarea.fill('Keep this after a failed save');
    failWrite = true;
    await save.click();
    await expect.poll(() => writeCount).toBe(2);
    await expect(textarea).toHaveValue('Keep this after a failed save');
    await expect(dialog).toBeVisible();
    failWrite = false;
    await save.click();
    await expect(dialog).not.toBeVisible();
    expect(prompt).toBe('Keep this after a failed save');
    await open();
    await expect(textarea).toHaveValue(prompt!);
    if (english) await page.setViewportSize({ width: 390, height: 844 });
    await expect(dialog).toBeInViewport();
    await expect(save).toBeInViewport();
    await page.screenshot({ path: test.info().outputPath('session-prompt.png') });
    await textarea.fill(' \n ');
    await save.click();
    await expect(dialog).not.toBeVisible();
    expect(prompt).toBeNull();
    if (english) await page.setViewportSize({ width: 1100, height: 800 });
    await open();
    await expect(textarea).toHaveValue('');
    await textarea.fill('Discard this draft');
    await cancel.click();
    expect(writeCount).toBe(4);
    prompt = 'Updated outside this dialog';
    await open();
    await expect(textarea).toHaveValue(prompt);
    await cancel.click();
    failRead = true;
    const previousReads = readCount;
    await open();
    await expect.poll(() => readCount).toBeGreaterThan(previousReads);
    await expect(save).toBeDisabled();
    await cancel.click();
    expect(writeCount).toBe(4);
    expect(prompt).toBe('Updated outside this dialog');
  });
}
