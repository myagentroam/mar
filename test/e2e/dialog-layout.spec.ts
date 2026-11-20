import { expect, test, type Locator, type Page } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

// @test-covers packages/web-core/src/styles.css
let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/dialog-layout.html');
});
test.afterAll(async () => {
  await fixture?.close();
});

async function expectBounded(dialog: Locator): Promise<void> {
  await expect(dialog).toBeVisible();
  await dialog.evaluate(async (element) => {
    for (let current: Element | null = element; current; current = current.parentElement) {
      await Promise.allSettled(current.getAnimations().map((animation) => animation.finished));
    }
  });
  await expect
    .poll(() =>
      dialog.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const overlay = element.closest('.mar-ui-dialog-overlay[open]')!;
        const root = document.documentElement;
        const controls = element.querySelectorAll(
          ':scope > .mar-ui-dialog__header, :scope > .mar-ui-dialog__footer'
        );
        return {
          topInside: bounds.top >= -1,
          bottomInside: bounds.bottom <= window.innerHeight + 1,
          leftInside: bounds.left >= -1,
          rightInside: bounds.right <= window.innerWidth + 1,
          controlsInside: [...controls].every((control) => {
            const rect = control.getBoundingClientRect();
            return (
              rect.height === 0 || (rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1)
            );
          }),
          overlayScroll: overlay.scrollHeight - overlay.clientHeight,
          pageOverflow: root.scrollWidth - root.clientWidth
        };
      })
    )
    .toEqual({
      topInside: true,
      bottomInside: true,
      leftInside: true,
      rightInside: true,
      controlsInside: true,
      overlayScroll: 0,
      pageOverflow: 0
    });
}

async function expectScrollableBody(
  dialog: Locator,
  selector = '.mar-ui-dialog__body'
): Promise<void> {
  const body = dialog.locator(selector);
  await expect
    .poll(() => body.evaluate((element) => element.scrollHeight - element.clientHeight))
    .toBeGreaterThan(20);
  const header = dialog.locator('.mar-ui-dialog__header');
  const headerTop = (await header.boundingBox())!.y;
  await body.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect((await header.boundingBox())!.y).toBeCloseTo(headerTop, 0);
  await expectBounded(dialog);
}

async function expectSingleScrollRegion(dialog: Locator): Promise<void> {
  const count = await dialog
    .locator('.mar-ui-dialog__body')
    .evaluate(
      (body) =>
        [body, ...body.querySelectorAll('*')].filter(
          (element) =>
            /^(auto|scroll)$/.test(getComputedStyle(element).overflowY) &&
            element.scrollHeight > element.clientHeight + 1
        ).length
    );
  expect(count).toBe(1);
}

const viewports = [
  { width: 1280, height: 800 },
  { width: 390, height: 600 },
  { width: 844, height: 320 }
];

async function visit(page: Page, kind: string, theme = 'daylight'): Promise<void> {
  await page.goto(`${fixture.url}dialog-layout.html?kind=${kind}&theme=${theme}`);
}

for (const [kind, title] of [
  ['short', 'Content dialog'],
  ['message', 'Long confirmation']
] as const) {
  test(`${kind} Escape restores focus without adding an outline to a pointer-opened trigger`, async ({
    page
  }) => {
    await visit(page, kind);
    const trigger = page.getByRole('button', { name: 'Open content' });
    const dialog = page.getByRole('dialog', { name: title });

    await trigger.click();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(':focus')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveCSS('outline-style', 'none');

    await visit(page, kind);
    await page.keyboard.press('Tab');
    await expect(trigger).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(':focus')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(trigger).not.toHaveCSS('outline-style', 'none');
  });
}

test('Dialog focus return does not first refocus the opener when the dialog moves focus explicitly', async ({
  page
}) => {
  await visit(page, 'focus-return');
  const trigger = page.getByRole('button', { name: 'Open content' });
  const dialog = page.getByRole('dialog', { name: 'Content dialog' });
  await trigger.click();
  await expect(dialog.locator(':focus')).toHaveCount(1);
  await trigger.evaluate((button) =>
    button.addEventListener('focus', () => button.setAttribute('data-refocused', 'true'))
  );

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Continue workflow' })).toBeFocused();
  await expect(trigger).not.toHaveAttribute('data-refocused', 'true');
});

test('Dialog and MessageBox titles use the panel title size', async ({ page }) => {
  for (const [viewport, theme] of [
    [viewports[0]!, 'daylight'],
    [viewports[1]!, 'vscode-dark-2026']
  ] as const) {
    await page.setViewportSize(viewport);
    for (const kind of ['short', 'message']) {
      await visit(page, kind, theme);
      await page.getByRole('button', { name: 'Open content' }).click();
      const title = page.locator('.mar-ui-dialog__title:visible');
      await expect(title).toBeVisible();
      const sizes = await title.evaluate((element) => ({
        actual: getComputedStyle(element).fontSize,
        expected: getComputedStyle(document.documentElement)
          .getPropertyValue('--mar-font-size-title')
          .trim()
      }));
      expect(sizes.actual).toBe(sizes.expected);
    }
  }
});

for (const locale of ['en-US', 'zh-CN']) {
  for (const viewport of [viewports[0]!, viewports[1]!]) {
    test(`Workspace cleanup displays partial counts without a timeout error: ${locale} ${viewport.width}`, async ({
      page
    }) => {
      await page.setViewportSize(viewport);
      const theme = viewport.width < 768 ? 'vscode-dark-2026' : 'daylight';
      await page.goto(
        `${fixture.url}dialog-layout.html?kind=cleanup&theme=${theme}&locale=${locale}`
      );
      await page.waitForLoadState('networkidle');
      await page.getByRole('button', { name: 'Open content' }).click();
      const dialog = page.getByRole('dialog');
      await expectBounded(dialog);
      await expect(dialog.locator('input')).toHaveValue('30');
      await dialog
        .getByRole('button', {
          name: locale === 'en-US' ? 'Clean up sessions' : '清理会话',
          exact: true
        })
        .click();
      await expect(
        dialog.getByRole('heading', {
          name: locale === 'en-US' ? 'Cleanup partially complete' : '已完成部分清理'
        })
      ).toBeVisible();
      await expect(
        dialog.getByText(locale === 'en-US' ? 'Not processed' : '待处理', { exact: true })
      ).toBeVisible();
      await expect(dialog.getByText('7', { exact: true })).toBeVisible();
      await expect(dialog.getByText('Codex 3', { exact: true })).toBeVisible();
      const statistics = dialog.locator('.workspace-session-cleanup-statistics');
      const cells = statistics.locator(':scope > div');
      await expect(cells).toHaveCount(4);
      const boxes = await cells.evaluateAll((elements) =>
        elements.map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            top: rect.top,
            overflow: element.scrollWidth - element.clientWidth
          };
        })
      );
      expect(new Set(boxes.map((box) => box.top)).size).toBe(viewport.width < 768 ? 2 : 1);
      expect(boxes.every((box) => box.overflow <= 1)).toBe(true);
      await expect(page.locator('.mar-message--error')).toHaveCount(0);
      await expectBounded(dialog);
      await dialog
        .getByRole('button', { name: locale === 'en-US' ? 'Close' : '关闭', exact: true })
        .click();
      await expect(dialog).toHaveCount(0);
    });
  }
}

for (const theme of ['daylight', 'vscode-dark-2026']) {
  for (const resource of ['Skills', 'MCP']) {
    test(`Loaded ${resource} scrolls inside its dialog without overlay scrolling: ${theme}`, async ({
      page
    }, testInfo) => {
      for (const viewport of viewports) {
        await page.setViewportSize(viewport);
        await visit(page, 'workspace', theme);
        await page.getByRole('button', { name: 'More workspace actions' }).click();
        await page
          .getByRole('menuitem', {
            name: resource === 'Skills' ? 'Loaded skills' : 'Loaded MCP',
            exact: true
          })
          .click();
        const dialog = page.locator('.mar-ui-dialog:visible');
        const rows = dialog.locator('.effective-skill-row');
        await expect(rows).toHaveCount(60);
        if (resource === 'Skills') {
          await expect(rows.nth(0).locator('.mar-ui-tag')).toHaveText(['Node HOME']);
          await expect(rows.nth(1).locator('.mar-ui-tag')).toHaveText(['Workspace']);
          await expect(rows.nth(2).locator('.mar-ui-tag')).toHaveText([
            'Incomplete installation',
            'Workspace'
          ]);
        }
        await expectBounded(dialog);
        await expectScrollableBody(dialog);
        await expectSingleScrollRegion(dialog);
        await expect(
          dialog.getByText(resource === 'Skills' ? 'Skill 60' : 'MCP 60', { exact: true })
        ).toBeInViewport();
        await page.screenshot({
          path: testInfo.outputPath(`${viewport.width}-${viewport.height}.png`)
        });
        await dialog.getByRole('button', { name: 'Close this dialog' }).click();
        await expect(dialog).toBeHidden();
      }
    });
  }

  for (const kind of ['details', 'table', 'form']) {
    test(`Long ${kind} keeps dialog controls visible while the body scrolls: ${theme}`, async ({
      page
    }) => {
      for (const viewport of viewports) {
        await page.setViewportSize(viewport);
        await visit(page, kind, theme);
        await page.getByRole('button', { name: 'Open content' }).click();
        const dialog = page.locator('.mar-ui-dialog:visible');
        await expectBounded(dialog);
        if (kind === 'form') {
          await dialog.getByRole('combobox', { name: 'First field' }).focus();
          await page.keyboard.press('ArrowDown');
          await page.getByRole('option', { name: 'Selected option' }).click();
        }
        const footer = dialog.locator('.mar-ui-dialog__footer');
        const footerTop = (await footer.boundingBox())!.y;
        await expectScrollableBody(dialog);
        expect((await footer.boundingBox())!.y).toBeCloseTo(footerTop, 0);
        await expect(footer).toBeInViewport();
        await expectSingleScrollRegion(dialog);
        await footer.getByRole('button').click();
        await expect(dialog).toBeHidden();
      }
    });
  }
}

for (const kind of ['details', 'mcp-details']) {
  test(`A maximum-length ${kind} name cannot hide content or footer actions`, async ({ page }) => {
    for (const viewport of [
      { width: 390, height: 320 },
      { width: 844, height: 320 }
    ]) {
      await page.setViewportSize(viewport);
      await page.goto(`${fixture.url}dialog-layout.html?kind=${kind}&long-name=1`);
      await page.getByRole('button', { name: 'Open content' }).click();
      const dialog = page.locator('.mar-ui-dialog:visible');
      await expectBounded(dialog);
      const name = dialog
        .locator('.mar-ui-dialog__body')
        .getByText((kind === 'details' ? 'w' : 'W').repeat(128), { exact: true });
      await expect(name).toBeVisible();
      await expect
        .poll(() => dialog.locator('.mar-ui-dialog__body').evaluate((el) => el.clientHeight))
        .toBeGreaterThan(60);
      await expectScrollableBody(dialog);
      await dialog.locator('.mar-ui-dialog__footer').getByRole('button').click();
      await expect(dialog).toBeHidden();
    }
  });
}

test('Quick Open accepts typing during its enter animation without taking focus back later', async ({
  page
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await visit(page, 'quick');
  await page.addStyleTag({
    content:
      '.mar-ui-dialog-overlay[open]:not([data-closing]) { animation-duration: 2s !important; }'
  });
  await page.getByRole('button', { name: 'Open content' }).click();
  const dialog = page.getByRole('dialog', { name: 'Quick Open' });
  const entering = page.locator('.mar-ui-dialog-overlay[open]:not([data-closing])');
  const enteringAnimation = () =>
    entering.evaluate((element) =>
      element.getAnimations().some((animation) => animation.playState === 'running')
    );
  const input = dialog.getByRole('textbox');
  const filter = dialog.getByRole('button', { name: 'Workspace', exact: true });
  await expect.poll(enteringAnimation).toBe(true);
  await expect(input).toBeFocused({ timeout: 1000 });
  await page.keyboard.type('readme');
  await expect(input).toHaveValue('readme');
  await expect.poll(enteringAnimation).toBe(true);
  await filter.focus();
  await expect(filter).toBeFocused();
  await expect.poll(enteringAnimation).toBe(false);
  await expect(filter).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Open content' }).click();
  await expect(input).toBeFocused();
});

test('Quick Open keeps source feedback visible until its exit animation completes', async ({
  page
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.route('**/api/workspaces?*', (route) =>
    route.fulfill({
      status: 503,
      json: { error: 'WORKSPACE_QUERY_FAILED', message: 'Workspace query failed' }
    })
  );
  await visit(page, 'quick');
  const leaveStyle = await page.addStyleTag({
    content: '.mar-ui-dialog-overlay[data-closing] { animation-duration: 2s !important; }'
  });
  await page.getByRole('button', { name: 'Open content' }).click();
  const dialog = page.getByRole('dialog', { name: 'Quick Open' });
  const retry = dialog.getByRole('button', { name: 'Retry', exact: true });
  await expect(retry).toBeVisible();
  await dialog.evaluate((element) =>
    Promise.allSettled(element.getAnimations().map(({ finished }) => finished))
  );

  await page.keyboard.press('Escape');
  await expect(page.locator('.mar-ui-dialog-overlay[data-closing]')).toBeVisible();
  await expect(retry).toBeVisible();
  await leaveStyle.evaluate((style) => style.remove());
  await expect(dialog).toHaveCount(0);
});

test('Quick Open keeps keyboard results visible when failed-source details expand', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 320 });
  let fail = true;
  await page.route('**/api/workspaces?*', async (route) => {
    await route.fulfill(
      fail
        ? {
            status: 503,
            json: { error: 'WORKSPACE_QUERY_FAILED', message: 'diagnostic '.repeat(120) }
          }
        : { json: { workspaces: [] } }
    );
  });
  await visit(page, 'quick');
  await page.getByRole('button', { name: 'Open content' }).click();
  const dialog = page.locator('.mar-ui-dialog:visible');
  await dialog.locator('summary').click();
  await expectBounded(dialog);
  const results = dialog.locator('.quick-open-results');
  await expect.poll(() => results.evaluate((el) => el.clientHeight)).toBeGreaterThanOrEqual(56);
  const notices = dialog.locator('.quick-open-statuses');
  await expect.poll(() => notices.evaluate((el) => el.clientHeight)).toBeGreaterThanOrEqual(32);
  const input = dialog.locator('.quick-open-input');
  for (let i = 0; i < 35; i++) await input.press('ArrowDown');
  await expect(dialog.locator('li[aria-selected="true"]')).toBeInViewport();
  await expect(input).toBeInViewport();
  const retry = notices.getByRole('button', { name: 'Retry', exact: true });
  await retry.scrollIntoViewIfNeeded();
  await expect(retry).toHaveClass(/mar-ui-button--inline/);
  await expect(retry).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await retry.hover();
  await expect(retry).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  fail = false;
  await retry.click();
  await expect(dialog.locator('details')).toHaveCount(0);
  await expectBounded(dialog);
  await expectSingleScrollRegion(dialog);
});

test('Quick Open keeps a single candidate compact alongside source errors', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.route('**/api/workspaces?*', async (route) => {
    await route.fulfill({
      status: 503,
      json: { error: 'WORKSPACE_QUERY_FAILED', message: 'Workspace query failed' }
    });
  });
  await visit(page, 'quick');
  await page.getByRole('button', { name: 'Open content' }).click();
  const dialog = page.locator('.mar-ui-dialog:visible');
  await expect(dialog.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  await dialog.locator('.quick-open-input').fill('Skill 60');
  const results = dialog.locator('.quick-open-results');
  await expect(results.locator('li')).toHaveCount(1);
  await expect.poll(() => results.evaluate((el) => el.clientHeight)).toBeLessThan(160);
  await expectBounded(dialog);
  await expect(dialog.getByRole('button', { name: 'Retry', exact: true })).toBeInViewport();
});

for (const kind of ['tokens', 'mail', 'registration', 'upload', 'quick']) {
  test(`${kind} remains bounded with a single body scroll region at low height`, async ({
    page
  }) => {
    await page.setViewportSize({ width: 390, height: 320 });
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/uploads/preflight')) {
        const { files } = route.request().postDataJSON() as { files: { name: string }[] };
        await route.fulfill({
          json: {
            uploads: files.map(({ name }) => ({ status: 'READY', path: name }))
          }
        });
      } else if (path.endsWith('/files')) {
        await route.fulfill({ json: { path: '', entries: [], nextCursor: null } });
      } else if (path.endsWith('/workspaces')) {
        await route.fulfill({ json: { workspaces: [] } });
      } else {
        throw new Error(`Unexpected fixture HTTP request: ${path}`);
      }
    });
    await visit(page, kind);
    if (kind === 'upload') {
      await page.locator('input[type="file"]').setInputFiles(
        Array.from({ length: 40 }, (_, i) => ({
          name: `file-${i}.txt`,
          mimeType: 'text/plain',
          buffer: Buffer.from('Fixture')
        }))
      );
    } else {
      await page.getByRole('button').first().click();
    }
    const dialog = page.locator('.mar-ui-dialog:visible');
    if (kind === 'mail') await expect(dialog.locator('iframe')).toBeVisible();
    await expectBounded(dialog);
    if (kind === 'registration') {
      await expect(dialog.getByRole('button', { name: 'Register a New Workspace' })).toHaveCount(0);
      await expect(dialog.getByRole('button', { name: 'Register Workspace' })).toBeInViewport();
      await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport();
    }
    if (kind !== 'quick') await expectScrollableBody(dialog);
    if (kind === 'quick') {
      const input = dialog.locator('.quick-open-input');
      for (let i = 0; i < 35; i++) await input.press('ArrowDown');
      await expect(dialog.locator('li[aria-selected="true"]')).toBeInViewport();
      await expect(input).toBeInViewport();
      await expectBounded(dialog);
    }
    await expectSingleScrollRegion(dialog);
    if (kind === 'registration') {
      const register = dialog.getByRole('button', { name: 'Register Workspace' });
      await expect(register).toBeInViewport();
      await expect(register).toBeDisabled();
      await dialog.getByRole('button', { name: 'Select current directory' }).click();
      await expect(register).toBeEnabled();
      const filter = dialog.getByRole('textbox', { name: 'Filter displayed items' });
      await filter.fill('folder');
      await filter.press('Enter');
      await expect(filter).toBeFocused();
      await expect(page.getByLabel('Registered path')).toHaveText('');
      await register.press('Enter');
      await expect(dialog).toHaveCount(0);
      await expect(page.getByLabel('Registered path')).toHaveText('/workspace');
    }
  });
}

test('Workspace registration keeps new-directory confirmation separate from submission', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 600 });
  await visit(page, 'registration', 'vscode-dark-2026');
  await page.getByRole('button').first().click();
  const registration = page.getByRole('dialog', { name: 'Register Workspace' });
  await registration.getByRole('button', { name: 'New directory', exact: true }).click();
  const directory = page.getByRole('dialog', { name: 'New Directory', exact: true });
  const name = directory.getByRole('textbox', { name: 'Directory Name' });
  await name.fill('new-project');
  await name.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  await expect(directory).toBeVisible();
  await expect(name).toBeFocused();
  await name.press('Enter');
  await expect(directory).toHaveCount(0);

  const register = registration.getByRole('button', { name: 'Create and register' });
  await expect(register).toBeEnabled();
  await expect(register).toBeInViewport();
  await expect(page.getByLabel('Registered path')).toHaveText('');
  await registration.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(registration).toHaveCount(0);
  await page.getByRole('button').first().click();
  await expect(registration.getByRole('button', { name: 'Register Workspace' })).toBeDisabled();
  await expect(registration.getByText('new-project', { exact: true })).toHaveCount(0);
});

test('Workspace registration cannot be dismissed while the request is pending', async ({
  page
}) => {
  let finishRequest!: () => void;
  const pendingRequest = new Promise<void>((resolve) => (finishRequest = resolve));
  await page.route('**/api/workspace-registration-fixture', async (route) => {
    await pendingRequest;
    await route.fulfill({ status: 409 });
  });
  try {
    await page.goto(`${fixture.url}dialog-layout.html?kind=registration&defer-registration`);
    await page.getByRole('button').first().click();
    const registration = page.getByRole('dialog', { name: 'Register Workspace' });
    await registration.getByRole('button', { name: 'Select current directory' }).click();
    const register = registration.getByRole('button', { name: 'Register Workspace' });
    await register.click();
    const cancel = registration.getByRole('button', { name: 'Cancel', exact: true });
    await expect(cancel).toBeDisabled();
    await expect(registration.getByRole('button', { name: 'Close this dialog' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.locator('.mar-ui-dialog-overlay[open]').click({ position: { x: 2, y: 2 } });
    await expect(registration).toBeVisible();
    finishRequest();
    await expect(register).toBeEnabled();
    await expect(cancel).toBeEnabled();
    await page.keyboard.press('Escape');
    await expect(registration).toHaveCount(0);
    await expect(page.getByLabel('Registered path')).toHaveText('');
  } finally {
    finishRequest();
  }
});

test.describe('Mobile dialog viewport', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Mobile emulation requires Chromium.');
  test.use({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } });

  test('A smaller viewport keeps the open dialog and close action reachable', async ({ page }) => {
    await visit(page, 'details', 'vscode-dark-2026');
    await page.getByRole('button', { name: 'Open content' }).tap();
    const dialog = page.locator('.mar-ui-dialog:visible');
    await expectBounded(dialog);
    await page.setViewportSize({ width: 390, height: 360 });
    await expectBounded(dialog);
    await expectScrollableBody(dialog);
    await dialog.getByRole('button', { name: 'Close this dialog' }).tap();
    await expect(dialog).toBeHidden();
  });
});

test('Long MessageBox confirmation scrolls its content without moving the actions', async ({
  page
}) => {
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await visit(page, 'message');
    await page.getByRole('button', { name: 'Open content' }).click();
    const dialog = page.locator('.mar-message-box');
    await expectBounded(dialog);
    const buttons = dialog.locator('.mar-ui-dialog__footer');
    const top = (await buttons.boundingBox())!.y;
    await expectScrollableBody(dialog, '.mar-ui-dialog__body');
    expect((await buttons.boundingBox())!.y).toBeCloseTo(top, 0);
    await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(dialog).toBeHidden();
  }
});

for (const kind of ['short', 'centered', 'fullscreen', 'file', 'image']) {
  test(`${kind} dialog retains its compact or dedicated preview layout`, async ({ page }) => {
    for (const viewport of [viewports[0]!, viewports[2]!]) {
      await page.setViewportSize(viewport);
      await visit(page, kind);
      await page.getByRole('button', { name: 'Open content' }).click();
      const dialog = page.locator('.mar-ui-dialog:visible');
      if (kind === 'image') await expect(dialog.locator('img')).toHaveJSProperty('complete', true);
      await expectBounded(dialog);
      const bounds = (await dialog.boundingBox())!;
      if (['short', 'centered'].includes(kind)) expect(bounds.height).toBeLessThan(220);
      if (kind === 'centered')
        expect(bounds.y + bounds.height / 2).toBeCloseTo(viewport.height / 2, 0);
      if (kind === 'fullscreen') expect(bounds.height).toBe(viewport.height);
      if (kind === 'file') expect(bounds.height).toBeCloseTo(viewport.height - 32, 0);
    }
  });
}
