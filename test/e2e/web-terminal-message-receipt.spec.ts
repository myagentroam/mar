import { expect, test } from '@playwright/test';
import { json, mockConsoleApi } from './support/web-console-api.js';

test('A terminal message receipt clears the unchanged draft without restarting work or Watch', async ({
  page
}) => {
  await mockConsoleApi(
    page,
    'MANAGED',
    ['history.read', 'turn.start'],
    [],
    'GIT_WORKSPACE',
    true,
    'IDLE'
  );
  let watches = 0;
  let messages = 0;
  page.on('request', (request) => {
    if (request.url().includes('/session-1/watch')) watches++;
  });
  await page.route('**/api/agent-sessions/session-1/messages', async (route) => {
    messages++;
    const { clientMessageId } = route.request().postDataJSON();
    return json(route, {
      session: {
        id: 'session-1',
        workspaceId: 'workspace-1',
        runner: 'codex',
        externalSessionId: 'vscode-thread-1',
        activity: 'IDLE',
        control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
      },
      run: {
        id: 'previous-run',
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        status: 'SUCCEEDED',
        recoveryState: 'ACTIVE',
        clientMessageId
      },
      delivery: 'STARTED',
      idempotent: true
    });
  });
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: 'project', exact: true })
    .click();
  await page.locator('.session-list button').first().click();
  const input = page.getByRole('textbox', { name: '输入消息' });
  await expect(input).toBeEnabled();
  const before = watches;
  await input.fill('Retry the unchanged draft');
  await input.press('Enter');
  await expect(input).toHaveValue('');
  await expect(page.locator('.composer-working')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '停止运行' })).toHaveCount(0);
  await expect(page.getByText('Retry the unchanged draft', { exact: true })).toHaveCount(0);
  expect(messages).toBe(1);
  expect(watches).toBe(before);
});
