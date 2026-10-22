import { expect, test } from '@playwright/test';

for (const locale of ['zh-CN', 'en-US'] as const) {
  test(
    'Console root entry keeps local routing, branding and mobile login layout: ' + locale,
    async ({ page }) => {
      await page.addInitScript((value) => localStorage.setItem('mar.locale.v2', value), locale);
      await page.route('**/api/auth/preferences/locale', (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify({ locale }) })
      );
      await page.route('**/api/auth/me', (route) =>
        route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ authenticated: false, mustChangePassword: false, locale })
        })
      );
      await page.setViewportSize({ width: locale === 'en-US' ? 390 : 1280, height: 844 });
      const navigations: string[] = [];
      page.on('request', (request) => {
        if (request.isNavigationRequest() && request.frame() === page.mainFrame())
          navigations.push(request.url());
      });
      const response = await page.goto('/?source=bookmark#workspace');
      expect(response?.status()).toBe(200);
      await expect(
        page.getByRole('heading', {
          name: locale === 'en-US' ? 'Continue working with your Agent.' : '继续你的 Agent 工作。'
        })
      ).toBeVisible();
      const url = new URL(page.url());
      expect(url.pathname).toBe('/console');
      expect(url.search).toBe('?source=bookmark');
      expect(url.hash).toBe('#workspace');
      expect(navigations).toHaveLength(1);
      await expect(page.locator('html')).toHaveClass(/console-ui/);
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(page.locator('.marketing-home')).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        await page.evaluate(() => innerWidth)
      );
      const loginBrandCenters = await page.locator('.login-brand').evaluate((brand) => {
        const logo = brand.querySelector('img')?.getBoundingClientRect();
        const name = brand.querySelector('strong')?.getBoundingClientRect();
        return {
          logo: (logo?.top ?? 0) + (logo?.height ?? 0) / 2,
          name: (name?.top ?? 0) + (name?.height ?? 0) / 2
        };
      });
      expect(Math.abs(loginBrandCenters.logo - loginBrandCenters.name)).toBeLessThanOrEqual(1);
      const root = await page.request.get('/index.html', { maxRedirects: 0 });
      expect(root.status()).toBe(200);
      await page.goto('/index.html');
      await expect(page).toHaveURL(/\/console$/u);
    }
  );
}

test('Public application icons retain visually centered artwork', async ({ page }) => {
  await page.goto('/console');
  const publicIconCenterDeltas = await page.evaluate(async () => {
    const centerDelta = async (source: string) => {
      const image = new Image();
      image.src = source;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      context?.drawImage(image, 0, 0);
      const pixels = context?.getImageData(0, 0, canvas.width, canvas.height).data;
      let alpha = 0;
      let weightedX = 0;
      let weightedY = 0;
      if (pixels !== undefined)
        for (let offset = 3; offset < pixels.length; offset += 4) {
          const value = pixels[offset] ?? 0;
          const index = (offset - 3) / 4;
          alpha += value;
          weightedX += (index % canvas.width) * value;
          weightedY += Math.floor(index / canvas.width) * value;
        }
      return {
        x: weightedX / alpha - (canvas.width - 1) / 2,
        y: weightedY / alpha - (canvas.height - 1) / 2
      };
    };
    return Promise.all(
      ['/favicon.ico', '/icons/app-icon-192.png', '/icons/app-icon-512.png'].map(centerDelta)
    );
  });
  for (const delta of publicIconCenterDeltas) {
    expect(Math.abs(delta.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(delta.y)).toBeLessThanOrEqual(1);
  }
});
