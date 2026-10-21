import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (localStorage.getItem('mar.locale.v2') === null)
      localStorage.setItem('mar.locale.v2', 'zh-CN');
  });
});

test('The public marketing home presents Agent-first engineering work and links Console and documentation', async ({
  page
}) => {
  await page.goto('/');

  await expect(page.locator('html')).not.toHaveClass(/console-ui/);
  await expect(page.locator('html')).toHaveCSS('font-size', '16px');
  const brandLogo = page.locator('.marketing-brand img');
  await expect(brandLogo).toHaveCSS('transform', 'none');
  const logoAlignment = await brandLogo.evaluate((image) => {
    const logo = image as HTMLImageElement;
    const canvas = document.createElement('canvas');
    canvas.width = logo.naturalWidth;
    canvas.height = logo.naturalHeight;
    const context = canvas.getContext('2d');
    context?.drawImage(logo, 0, 0);
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
    const logoBounds = logo.getBoundingClientRect();
    const nameBounds = logo.parentElement?.querySelector('span')?.getBoundingClientRect();
    return {
      alphaCenterX: weightedX / alpha,
      alphaCenterY: weightedY / alpha,
      canvasCenterX: (canvas.width - 1) / 2,
      canvasCenterY: (canvas.height - 1) / 2,
      renderedCenterDelta:
        logoBounds.top +
        logoBounds.height / 2 -
        ((nameBounds?.top ?? 0) + (nameBounds?.height ?? 0) / 2)
    };
  });
  expect(Math.abs(logoAlignment.alphaCenterX - logoAlignment.canvasCenterX)).toBeLessThanOrEqual(1);
  expect(Math.abs(logoAlignment.alphaCenterY - logoAlignment.canvasCenterY)).toBeLessThanOrEqual(1);
  expect(Math.abs(logoAlignment.renderedCenterDelta)).toBeLessThanOrEqual(1);
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
  await expect(page.getByRole('heading', { name: 'Agent First. Work Anywhere.' })).toBeVisible();
  const productFacts = page.getByRole('list', { name: '接入你常用的 Agent' });
  await expect(productFacts.getByText('MAR Agent', { exact: true })).toBeVisible();
  await expect(productFacts.getByText('Codex', { exact: true })).toBeVisible();
  await expect(productFacts.getByText('Claude Code', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('img', {
      name: 'MyAgentRoam 工作台：Agent 会话、任务清单、Git 变更与终端'
    })
  ).toBeVisible();
  await expect(page.locator('footer')).toContainText(
    '面向熟悉 Coding Agent 与自托管开发环境的开发者。'
  );

  const languageSelect = (name: string) =>
    page
      .getByRole('combobox', { name, exact: true })
      .locator(
        'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " el-select ")][1]'
      );
  await languageSelect('切换为英文').click();
  await page.getByRole('option', { name: 'English' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
  await expect(page.getByRole('link', { name: 'Documentation', exact: true })).toHaveAttribute(
    'href',
    '/docs/en-US/getting-started/overview'
  );
  await languageSelect('Switch to Chinese').click();
  await page.getByRole('option', { name: '简体中文' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');

  await expect(page.getByRole('link', { name: '文档中心', exact: true })).toHaveAttribute(
    'href',
    '/docs/getting-started/overview'
  );
  await expect(page.getByRole('link', { name: '部署指南' }).first()).toHaveAttribute(
    'href',
    '/docs/getting-started/server-installation'
  );
  const consoleLink = page.getByRole('link', { name: '进入控制台' }).first();
  await consoleLink.hover();
  await expect(consoleLink).toHaveCSS('background-color', 'rgb(244, 246, 250)');
  await consoleLink.click();
  await expect(page).toHaveURL(/\/console$/u);
  await expect(page.getByRole('heading', { name: '继续你的 Agent 工作。' })).toBeVisible();
  const loginBrandCenters = await page.locator('.login-brand').evaluate((brand) => {
    const logo = brand.querySelector('img')?.getBoundingClientRect();
    const name = brand.querySelector('strong')?.getBoundingClientRect();
    return {
      logo: (logo?.top ?? 0) + (logo?.height ?? 0) / 2,
      name: (name?.top ?? 0) + (name?.height ?? 0) / 2
    };
  });
  expect(Math.abs(loginBrandCenters.logo - loginBrandCenters.name)).toBeLessThanOrEqual(1);
});

test('Mobile marketing navigation and hero content stay accessible without horizontal overflow', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  await expect(page.getByRole('link', { name: '文档中心', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '进入控制台' }).first()).toBeVisible();
  await expect(
    page.getByRole('img', {
      name: 'MyAgentRoam 工作台：Agent 会话、任务清单、Git 变更与终端'
    })
  ).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth
  }));
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
});

test('The marketing home exposes its headline, actions, Agents and screenshot at 1280x720', async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');

  await expect(page.getByRole('navigation', { name: '首页导航' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Agent First. Work Anywhere.' })).toBeVisible();
  await expect(page.getByRole('list', { name: '接入你常用的 Agent' })).toBeInViewport();
  await expect(
    page.getByRole('img', {
      name: 'MyAgentRoam 工作台：Agent 会话、任务清单、Git 变更与终端'
    })
  ).toBeInViewport();
  const dimensions = await page.evaluate(() => {
    const navigation = document
      .querySelector<HTMLElement>('.marketing-nav')
      ?.getBoundingClientRect();
    const heroCopy = document.querySelector<HTMLElement>('.hero-copy')?.getBoundingClientRect();
    return {
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      navigationLeft: navigation?.left ?? 0,
      navigationRight: navigation ? window.innerWidth - navigation.right : 0,
      heroLeft: heroCopy?.left ?? 0
    };
  });
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
  expect(dimensions.navigationLeft).toBeGreaterThanOrEqual(48);
  expect(dimensions.navigationRight).toBeGreaterThanOrEqual(48);
  expect(dimensions.heroLeft).toBeGreaterThanOrEqual(48);
});

test('English marketing and login pages expand with content without horizontal overflow', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/auth/preferences/locale', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ locale: 'en-US' })
    })
  );
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ authenticated: false, mustChangePassword: false, locale: 'en-US' })
    })
  );
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('mar.locale.v2', 'en-US'));
  await page.reload();

  await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
  await expect(
    page.getByRole('heading', {
      name: 'Agent First. Work Anywhere.'
    })
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Documentation', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open console' }).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => window.innerWidth)
  );

  await page.getByRole('link', { name: 'Open console' }).first().click();
  await expect(
    page.getByRole('heading', { name: 'Continue working with your Agent.' })
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => window.innerWidth)
  );
});

for (const locale of ['zh-CN', 'en-US'] as const) {
  test(
    'The marketing home presents localized engineering evidence and screenshots: ' + locale,
    async ({ page }, testInfo) => {
      const failures: string[] = [];
      page.on('pageerror', (error) => failures.push(error.message));
      await page.addInitScript((value) => localStorage.setItem('mar.locale.v2', value), locale);
      await page.setViewportSize({ width: 1440, height: 1100 });
      await page.goto('/');
      await expect(page.locator('.positioning h2')).toHaveText(
        locale === 'en-US' ? 'Not an IDE moved into a browser.' : '不是把 IDE 搬进浏览器。'
      );
      await expect(page.locator('main')).not.toContainText(
        /Synthetic demo data|合成演示数据|真实 Web 界面/
      );
      await expect(page.locator('.context-features dd').first()).toHaveCSS('font-size', '15px');
      await expect(page.locator('.context-evidence')).toContainText('−20.41');
      await expect(page.locator('.evidence-workload')).toContainText('6,364');
      await expect(page.locator('.evidence-workload')).toContainText('75');
      await expect(page.locator('.network')).toContainText('marctl');
      await expect(page.locator('.capabilities')).toContainText('Computer Use');
      await expect(page.locator('.hero-visual img')).toHaveAttribute('src', new RegExp(locale));
      const screenshotImages = page.locator('.hero-visual img, .mobile-frame img, .network img');
      await expect(screenshotImages).toHaveCount(3);
      for (const image of await screenshotImages.all()) {
        await image.scrollIntoViewIfNeeded();
        await expect(image).toHaveAttribute('src', new RegExp(locale));
        await expect
          .poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
          .toBeGreaterThan(0);
      }
      const docsPrefix = locale === 'en-US' ? '/docs/en-US/' : '/docs/';
      await expect(page.locator('.hero .secondary-action')).toHaveAttribute(
        'href',
        docsPrefix + 'getting-started/server-installation'
      );
      await expect(page.locator('.capabilities .text-link')).toHaveAttribute(
        'href',
        docsPrefix + 'runners/mar-agent'
      );
      await expect(page.locator('.license a')).toHaveAttribute(
        'href',
        'https://github.com/myagentroam/mar/blob/develop/LICENSING.md'
      );
      await page.locator('.marketing-nav a[href="#features"]').click();
      await expect(page).toHaveURL(/#features$/);
      await expect(page.locator('#context-title')).toBeInViewport();
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: testInfo.outputPath('portal-desktop.png'), fullPage: true });
      for (const width of [768, 390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        await expect
          .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
          .toBe(true);
        await expect(page.locator('.marketing-nav .console-link')).toBeVisible();
        await expect(page.locator('.language-select')).toBeVisible();
        await page.evaluate(() => scrollTo(0, 0));
        await page.mouse.move(width / 2, 500);
        await page.mouse.wheel(0, 500);
        await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
        await page.locator('#closing-title').scrollIntoViewIfNeeded();
        await expect(page.locator('#closing-title')).toBeInViewport();
        await page.evaluate(() => scrollTo(0, 0));
        if (width === 390) {
          await page.screenshot({ path: testInfo.outputPath('portal-mobile.png'), fullPage: true });
        }
      }
      expect(failures).toEqual([]);
    }
  );
}
