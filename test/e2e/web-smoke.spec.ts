import { expect, test } from '@playwright/test';

test('Vue Admin Console renders login gate and does not expose Terminal before Admin session', async ({
  page,
  request
}) => {
  const manifest = await request.get('/manifest.webmanifest');
  expect(manifest.ok()).toBe(true);
  expect(await manifest.json()).toMatchObject({
    id: '/console',
    start_url: '/console',
    scope: '/',
    display: 'standalone'
  });
  expect((await request.get('/api/auth/me')).status()).toBe(401);
  await page.goto('/console');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    'href',
    '/manifest.webmanifest'
  );
  await expect
    .poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.scope))
    .toBe(new URL('/', page.url()).href);
  await expect(page.getByTestId('web-health')).toHaveText('Web Console 已就绪');
  await expect(page.getByRole('heading', { name: '继续你的 Agent 工作。' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '账户' })).toHaveValue('');
  await expect(page.getByRole('heading', { name: '标准终端' })).toHaveCount(0);
  await expect(page.locator('[data-xterm], .xterm, iframe')).toHaveCount(0);
});
