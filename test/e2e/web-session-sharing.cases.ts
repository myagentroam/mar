import { expect, test } from '@playwright/test';
import { json, mockConsoleApi } from './support/web-console-api.js';
import { mockSharedConversation } from './support/session-sharing-page.js';

test('Shared file previews keep the conversation visible and reuse its Watch', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await mockSharedConversation(page, 'en-US', '[Preview report](output/report.txt)');
  let watches = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      new URL(request.url()).pathname.endsWith('/participants-test/watch')
    )
      watches += 1;
  });
  await page.route('**/api/session-shares/participants-test/files/read?*', (route) =>
    json(route, {
      file: {
        path: 'output/report.txt',
        encoding: 'utf-8',
        content: 'Shared preview content',
        size: 22,
        truncated: false,
        nextOffset: null
      }
    })
  );
  await page.goto('/share/participants-test');
  const heading = page.locator('.share-heading h1');
  await expect(heading).toHaveText('Shared session');
  const link = page.getByRole('link', { name: 'Preview report', exact: true });
  await expect(link).toBeVisible();
  expect(watches).toBe(1);
  await link.click();
  const preview = page.getByRole('dialog', { name: 'output/report.txt file preview', exact: true });
  await expect(preview.locator('.cm-content')).toHaveText('Shared preview content');
  await expect(preview.locator('.file-preview-surface')).toHaveCSS('width', '1440px');
  await expect(heading).toBeVisible();
  await expect(page.locator('.share-preview')).toHaveCSS('position', 'static');
  await expect(preview.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);
  await expect(heading).toBeVisible();
  expect(page.isClosed()).toBe(false);
  expect(watches).toBe(1);
});

test('Shared conversations honor upward scroll intent even with short history', async ({
  page
}) => {
  await mockSharedConversation(page, 'en-US', 'A short shared message.');
  await page.goto('/share/participants-test');
  const region = page.locator('.conversation-scroll');
  const latest = page.getByRole('button', { name: 'Jump to latest', exact: true });
  await expect(region.getByText('A short shared message.')).toBeInViewport();
  expect(await region.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
  await expect(latest).toBeHidden();

  await region.hover();
  await page.mouse.wheel(0, -120);
  await expect(latest).toBeVisible();

  await latest.click();
  await expect(latest).toBeHidden();
});

test('Share browser identity synchronizes an already open tab', async ({ page }) => {
  await mockSharedConversation(page, 'en-US');
  await page.goto('/share/participants-test');
  await expect(page.locator('.share-heading h1')).toHaveText('Shared session');
  const other = await page.context().newPage();
  try {
    await mockSharedConversation(other, 'en-US');
    await other.goto('/share/participants-test');
    await expect(other.locator('.share-heading h1')).toHaveText('Shared session');
    await expect(other.locator('.composer-working')).toBeVisible();
    await other.evaluate(() => {
      const socket = (window.WebSocket as typeof WebSocket & { current: WebSocket }).current;
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        const value = JSON.parse(String(data));
        if (value.type === 'session-share.visitor')
          (window as typeof window & { lastSharedName?: string }).lastSharedName =
            value.visitor.name;
        send(data);
      };
    });
    await page.evaluate(() => {
      const key = 'mar:session-share:visitor';
      const visitor = JSON.parse(localStorage.getItem(key)!);
      localStorage.setItem(key, JSON.stringify({ ...visitor, name: 'Alice' }));
    });
    await expect
      .poll(() =>
        other.evaluate(() => (window as typeof window & { lastSharedName?: string }).lastSharedName)
      )
      .toBe('Alice');
  } finally {
    await other.close();
  }
});

for (const labels of [
  { locale: 'zh-CN', edit: '修改名称', save: '保存', cancel: '取消', mobile: false },
  { locale: 'en-US', edit: 'Edit name', save: 'Save', cancel: 'Cancel', mobile: true }
]) {
  test.describe('Share participant rename (' + labels.locale + ')', () => {
    test.use({
      hasTouch: labels.mobile,
      viewport: { width: labels.mobile ? 390 : 1100, height: 740 }
    });
    test('shows the sharer and both visitors with presence dots aligned to names', async ({
      page
    }) => {
      await mockSharedConversation(page, labels.locale);
      await page.goto('/share/participants-test');
      await expect(page.locator('.composer-working')).toBeVisible();
      async function publish(name?: string) {
        await page.evaluate((value) => {
          const socket = (window.WebSocket as typeof WebSocket & { current: WebSocket }).current;
          socket.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                type: 'session-share.participants',
                canRename: true,
                sharerOnline: true,
                participants: [
                  { visitorId: 'browser-aa', name: 'aa' },
                  { visitorId: 'browser-bb', ...(value === undefined ? {} : { name: value }) }
                ]
              })
            })
          );
        }, name);
      }
      await publish();
      if (labels.mobile) await page.locator('.share-heading button').tap();
      const people = page.locator('.share-people');
      const rows = people.locator('.share-person');
      await expect(rows).toHaveCount(3);
      await expect(rows.nth(0).locator('strong')).toHaveText('admin');
      await expect(rows.nth(1)).toHaveText('aa');
      await expect(rows.nth(2)).toContainText(labels.locale === 'zh-CN' ? '匿名#' : 'Anonymous#');
      await publish('bb');
      await expect(rows.nth(2)).toHaveText('bb');
      for (const row of await rows.all()) {
        const difference = await row.evaluate((element) => {
          const dot = element.querySelector('.presence')!.getBoundingClientRect();
          const name = element
            .querySelector('strong, span:not(.presence)')!
            .getBoundingClientRect();
          return Math.abs(dot.y + dot.height / 2 - name.y - name.height / 2);
        });
        expect(difference).toBeLessThanOrEqual(2);
      }
    });
    test('edits only the current visitor without submitting a message', async ({ page }) => {
      await mockSharedConversation(page, labels.locale);
      const theme = labels.mobile ? 'daylight' : 'dark';
      await page.addInitScript((value) => {
        localStorage.setItem('mar.theme', value);
        localStorage.setItem(
          'mar:session-share:visitor',
          JSON.stringify({ visitorId: 'local-browser', name: 'Before' })
        );
      }, theme);
      let messages = 0;
      await page.route('**/api/session-shares/participants-test/messages', (route) => {
        messages++;
        return json(route, {});
      });
      await page.goto('/share/participants-test');
      await expect(page.locator('.composer-working')).toBeVisible();
      expect(await page.locator('html').getAttribute('data-theme')).toBe(
        theme === 'daylight' ? null : theme
      );
      await page.evaluate(() => {
        const socket = (window.WebSocket as typeof WebSocket & { current: WebSocket }).current;
        const send = socket.send.bind(socket);
        const publish = (visitor: unknown) =>
          socket.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                type: 'session-share.participants',
                canRename: true,
                sharerOnline: false,
                participants: [visitor, { visitorId: 'peer-browser', name: 'Other visitor' }]
              })
            })
          );
        socket.send = (data) => {
          send(data);
          const value = JSON.parse(String(data));
          if (value.type === 'session-share.visitor') publish(value.visitor);
        };
        publish(JSON.parse(localStorage.getItem('mar:session-share:visitor')!));
      });
      const people = page.locator('.share-people');
      async function edit(checkAppearance = false) {
        if (labels.mobile) await page.locator('.share-heading button').tap();
        const row = people.locator('.share-person').filter({ hasText: 'Before' });
        const button = row.getByRole('button', { name: labels.edit });
        await expect(people.getByRole('button', { name: labels.edit })).toHaveCount(1);
        if (!labels.mobile) await row.hover();
        await expect(button).toHaveCSS('opacity', '1');
        if (checkAppearance) {
          await expect(button).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
          const controlRadius = await button.evaluate((element) =>
            getComputedStyle(element).getPropertyValue('--mar-radius-control').trim()
          );
          await expect(button).toHaveCSS('border-radius', controlRadius);
          const box = (await button.boundingBox())!;
          expect(box.width).toBeCloseTo(box.height);
          if (!labels.mobile) {
            await button.hover();
            await expect(button).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
          }
          await people.screenshot({
            path: test.info().outputPath('share-participant-edit.png'),
            animations: 'disabled'
          });
        }
        if (labels.mobile) {
          await button.tap();
        } else if (checkAppearance) {
          await button.focus();
          await page.keyboard.press('Shift+Tab');
          await expect(button).not.toBeFocused();
          await page.keyboard.press('Tab');
          await expect(button).toBeFocused();
          await expect(button).toHaveCSS('outline-style', 'solid');
          await page.keyboard.press('Enter');
        } else {
          await button.click();
        }
      }
      await edit(true);
      const dialog = page.getByRole('dialog', { name: labels.edit, exact: true });
      await expect(dialog.getByRole('textbox')).toHaveValue('Before');
      await dialog.getByRole('textbox').fill('Discarded');
      await dialog.getByRole('button', { name: labels.cancel, exact: true }).click();
      await expect(dialog).toHaveCount(0);
      expect(
        await page.evaluate(
          () => JSON.parse(localStorage.getItem('mar:session-share:visitor')!).name
        )
      ).toBe('Before');
      await edit();
      await dialog.getByRole('textbox').fill('Taylor');
      await dialog.getByRole('button', { name: labels.save, exact: true }).click();
      await expect(dialog).toHaveCount(0);
      if (labels.mobile) await page.locator('.share-heading button').tap();
      await expect(people.getByText('Taylor', { exact: true })).toBeVisible();
      expect(
        await page.evaluate(
          () => JSON.parse(localStorage.getItem('mar:session-share:visitor')!).name
        )
      ).toBe('Taylor');
      expect(messages).toBe(0);
    });
  });
}

test.describe('Share participants menu', () => {
  test.use({ hasTouch: true });
  for (const locale of ['zh-CN', 'en-US']) {
    test(`dismisses on outside taps without hiding the desktop list (${locale})`, async ({
      page
    }) => {
      await page.setViewportSize({ width: 390, height: 740 });
      await mockSharedConversation(page, locale);
      await page.goto('/share/participants-test');
      const trigger = page.locator('.share-heading button');
      const panel = page.locator('.share-people');
      await expect(page.locator('.share-workspace')).toHaveText('Project Alpha');
      await expect(page.locator('.share-heading h1')).toHaveText('Shared session');
      const working = page.locator('.composer-working');
      await expect(working).toContainText(/[0-9]+s/);
      const initialWorking = await working.textContent();
      await expect.poll(() => working.textContent()).not.toBe(initialWorking);
      expect(
        await page
          .locator('html')
          .evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
      ).toBe(true);
      await page.screenshot({
        path: test.info().outputPath('share-header-working.png'),
        animations: 'disabled'
      });
      await expect(panel).toHaveCount(0);
      await trigger.tap();
      await expect(panel).toBeVisible();
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
      await expect(panel.locator('.person-avatar')).toHaveCount(0);
      await expect(panel.locator('h2')).toHaveText(locale === 'zh-CN' ? '参与者' : 'Participants');
      await expect(page.locator('.composer-access-slot')).toHaveCount(0);
      await expect(page.locator('.composer-model-slot')).toHaveCount(0);
      await expect(panel.locator('.sharer .presence')).toHaveCount(0);
      await page.evaluate(() => {
        const Socket = window.WebSocket as typeof WebSocket & { current: EventTarget };
        Socket.current.dispatchEvent(
          new MessageEvent('message', {
            data: JSON.stringify({
              type: 'session-share.participants',
              sharerOnline: true,
              participants: [{ visitorId: 'other-browser', name: 'Alice' }]
            })
          })
        );
      });
      await expect(panel.locator('.sharer .presence')).toBeVisible();
      await expect(panel.getByText('Alice', { exact: true })).toBeVisible();
      await panel.getByText('admin', { exact: true }).tap();
      await expect(panel).toBeVisible();
      await page.locator('.share-kicker').tap();
      await expect(panel).toHaveCount(0);
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      await trigger.tap();
      await expect(panel).toBeVisible();
      await trigger.tap();
      await expect(panel).toHaveCount(0);
      await trigger.tap();
      await expect(panel).toBeVisible();
      await page.locator('textarea.composer-input').tap();
      await expect(panel).toHaveCount(0);
      await page.setViewportSize({ width: 1100, height: 740 });
      await expect(panel).toBeVisible();
      await expect(panel.locator('.person-avatar')).toHaveCount(0);
      await page.locator('.share-kicker').tap();
      await expect(panel).toBeVisible();
    });
  }
});

for (const labels of [
  {
    locale: 'zh-CN',
    enter: '进入控制台',
    work: '工作',
    sessions: '打开会话列表',
    title: '分享对话',
    create: '创建分享',
    copy: '复制',
    shareText: '对话分享',
    link: '链接：',
    password: '密码：'
  },
  {
    locale: 'en-US',
    enter: 'Open console',
    work: 'Work',
    sessions: 'Open session list',
    title: 'Share conversation',
    create: 'Create share',
    copy: 'Copy',
    shareText: 'Shared conversation',
    link: 'Link: ',
    password: 'Password: '
  }
]) {
  test(`Session sharing menu icon and dialog stay usable outside the mobile sidebar (${labels.locale})`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width: 1100, height: 850 });
    await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
    await page.addInitScript((locale) => {
      localStorage.setItem('mar.locale.v2', locale);
      localStorage.setItem('mar.theme', 'dark');
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (value: string) => {
            (window as typeof window & { copiedShareText?: string }).copiedShareText = value;
          }
        }
      });
    }, labels.locale);
    await page.route('**/api/agent-sessions?nodeId=node-1*', (route) =>
      json(route, {
        sessions: [
          {
            id: 'session-1',
            workspaceId: 'workspace-1',
            runner: 'codex',
            externalSessionId: 'session-1',
            runnerTitle: 'Shared session',
            activity: 'IDLE',
            runtime: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
          }
        ]
      })
    );
    const shares: {
      id: string;
      nodeId: string;
      workspaceId: string;
      sessionId: string;
      createdAt: number;
      expiresAt: null;
    }[] = [];
    await page.route('**/api/agent-sessions/session-1/shares*', (route) => {
      if (route.request().method() !== 'POST') return json(route, { shares });
      const share = {
        id: 'shared-conversation-link-with-a-long-identifier',
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        createdAt: Date.UTC(2026, 9, 17, 23, 41, 58),
        expiresAt: null
      };
      shares.push(share);
      return json(route, { share, password: '012345' }, 201);
    });
    await page.route('**/api/agent-sessions/session-1/shares/*/copy*', (route) =>
      json(route, { password: '012345' })
    );
    await page.goto('/console');
    await page.getByRole('button', { name: labels.enter }).click();
    await page.getByRole('button', { name: labels.work, exact: true }).click();
    await page
      .locator('.workspace-tree')
      .getByRole('button', { name: /node-1/ })
      .click();
    await page
      .locator('.workspace-tree')
      .getByRole('button', { name: 'project', exact: true })
      .click();
    await page.setViewportSize({ width: 390, height: 740 });
    await page.getByRole('button', { name: labels.sessions }).click();
    const row = page.locator('.session-row').filter({ hasText: 'Shared session' });
    await row.locator('.session-link').focus();
    await row.locator('.session-more-button').click();
    const item = page.getByRole('menuitem', { name: labels.title, exact: true });
    await expect.soft(item.locator('svg')).toBeVisible();
    await item.click();
    const dialog = page.getByRole('dialog', { name: labels.title, exact: true });
    const panel = dialog.locator('.mar-ui-dialog');
    await expect(dialog).toBeVisible();
    async function checkBounds(width: number) {
      await expect
        .poll(async () => {
          const bounds = await panel.boundingBox();
          return {
            bounds,
            contained: bounds !== null && bounds.x >= 15 && bounds.x + bounds.width <= width - 15
          };
        })
        .toMatchObject({ contained: true });
      expect(
        await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
      ).toBe(true);
      const close = dialog.locator('.mar-ui-dialog__close');
      await close.scrollIntoViewIfNeeded();
      await expect(close).toBeInViewport();
      const unobscured = await close.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return element.contains(
          document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
        );
      });
      expect(unobscured).toBe(true);
    }
    await checkBounds(390);
    await expect(dialog.locator('.share-note')).toHaveCount(0);
    await page.locator('html').evaluate((element) => {
      element.style.setProperty('--mar-fill-muted', '#dde9f6');
      element.style.setProperty('--mar-border-subtle', '#a6b7cc');
    });
    await dialog.getByRole('button', { name: labels.create, exact: true }).click();
    const shareReceipt = dialog.locator('.created-share');
    await expect(shareReceipt).toHaveCSS('background-color', 'rgb(221, 233, 246)');
    await expect(shareReceipt).toHaveCSS('border-top-color', 'rgb(166, 183, 204)');
    const shareUrl = new URL(
      '/share/shared-conversation-link-with-a-long-identifier',
      page.url()
    ).toString();
    const shareText = [labels.shareText, labels.link + shareUrl, labels.password + '012345'].join(
      '\n'
    );
    await expect(dialog.locator('.share-text')).toHaveText(shareText);
    const recordLink = dialog.getByRole('link', { name: shareUrl, exact: true });
    await expect(recordLink).toHaveAttribute('href', shareUrl);
    const expectedCreated = await page.evaluate((value) => {
      const date = new Date(value);
      return new Date(value - date.getTimezoneOffset() * 60_000)
        .toISOString()
        .slice(0, 19)
        .replace('T', ' ');
    }, shares[0]!.createdAt);
    await expect(dialog.locator('.mar-ui-table__row').first().locator('td').nth(1)).toHaveText(
      expectedCreated
    );
    expect(expectedCreated).not.toMatch(/AM|PM/);
    await expect(dialog.getByRole('button', { name: labels.copy, exact: true })).toHaveCount(2);
    await expect(dialog).not.toContainText(/only once|仅显示一次/);
    for (const width of [320, 390, 1100]) {
      await page.setViewportSize({ width, height: 740 });
      await checkBounds(width);
      const linkCell = recordLink.locator('..');
      await expect(linkCell).toHaveCSS('white-space', 'nowrap');
      await expect(linkCell).toHaveCSS('text-overflow', 'ellipsis');
      expect(await linkCell.evaluate((cell) => cell.scrollWidth > cell.clientWidth)).toBe(true);
      if (width === 1100) {
        await recordLink.hover();
        await expect(page.getByRole('tooltip').filter({ hasText: shareUrl })).toBeVisible();
      }
      const copy = dialog
        .locator('.created-share')
        .getByRole('button', { name: labels.copy, exact: true });
      await copy.scrollIntoViewIfNeeded();
      await expect(copy).toBeInViewport();
      await copy.click();
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as typeof window & { copiedShareText?: string }).copiedShareText
          )
        )
        .toBe(shareText);
      await page.screenshot({
        path: testInfo.outputPath(`share-dialog-${width}.png`),
        animations: 'disabled'
      });
    }
    await dialog.locator('.mar-ui-dialog__close').click();
    await expect(dialog).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 740 });
    await page.getByRole('button', { name: labels.sessions }).click();
    await row.locator('.session-link').focus();
    await row.locator('.session-more-button').click();
    await page.getByRole('menuitem', { name: labels.title, exact: true }).click();
    await expect(dialog.locator('.created-share')).toHaveCount(0);
    await page.evaluate(() => {
      delete (window as typeof window & { copiedShareText?: string }).copiedShareText;
    });
    const historicalCopy = dialog.getByRole('button', { name: labels.copy, exact: true });
    await historicalCopy.click();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as typeof window & { copiedShareText?: string }).copiedShareText
        )
      )
      .toBe(shareText);
    await dialog.locator('.mar-ui-dialog__close').click();
  });
}

for (const locale of ['zh-CN', 'en-US']) {
  test(
    'Share password gate presents Console branding and inline errors (' + locale + ')',
    async ({ page }, testInfo) => {
      const chinese = locale === 'zh-CN';
      const theme = chinese ? 'dark' : 'daylight';
      await page.setViewportSize(
        chinese ? { width: 320, height: 300 } : { width: 1100, height: 740 }
      );
      await page.addInitScript(
        ({ locale, theme }) => {
          localStorage.setItem('mar.locale.v2', locale);
          localStorage.setItem('mar.theme', theme);
        },
        { locale, theme }
      );
      let submissions = 0;
      await page.route('**/api/session-shares/password-wording/auth', (route) => {
        submissions += 1;
        if (submissions === 2) {
          return json(
            route,
            { error: { code: 'SESSION_SHARE_NOT_FOUND', message: 'Share not found' } },
            404
          );
        }
        return json(
          route,
          {
            error: { code: 'SESSION_SHARE_CREDENTIAL_INVALID', message: 'Invalid share credential' }
          },
          401
        );
      });
      await page.goto('/share/password-wording');
      const panel = page.getByRole('region', {
        name: chinese ? '共享会话' : 'Shared conversation'
      });
      const password = panel.getByLabel(chinese ? '密码' : 'Password', { exact: true });
      await expect(password).toBeVisible();
      await expect(password).not.toBeFocused();
      await expect(page.locator('html')).toHaveCSS('color-scheme', chinese ? 'dark' : 'light');
      await expect(panel.getByText('MyAgentRoam', { exact: true })).toBeVisible();
      await expect(panel.locator('img')).toBeVisible();
      await expect(panel).toHaveCSS('border-top-width', '1px');
      await expect(panel).toHaveCSS('box-shadow', 'none');
      await page.screenshot({
        path: testInfo.outputPath('share-password-gate.png'),
        animations: 'disabled'
      });
      expect(await page.locator('main').evaluate((main) => main.scrollWidth)).toBeLessThanOrEqual(
        chinese ? 320 : 1100
      );
      await expect(panel).not.toContainText(/six|digit|六位|数字/);
      const submit = panel.getByRole('button', {
        name: chinese ? '进入对话' : 'Open conversation',
        exact: true
      });
      await password.fill('wrong');
      const showPassword = panel.getByRole('button', {
        name: chinese ? '显示密码' : 'Show password',
        exact: true
      });
      await showPassword.press('Space');
      await expect(showPassword).toHaveAttribute('aria-pressed', 'true');
      await expect(password).toHaveAttribute('type', 'text');
      await showPassword.press('Space');
      await expect(password).toHaveAttribute('type', 'password');
      await submit.focus();
      await expect(password).not.toHaveAttribute('aria-invalid', 'true');
      await submit.press('Enter');
      const invalidFormat = chinese ? '请输入有效的分享密码。' : 'Enter a valid share password.';
      await expect(password).toHaveAttribute('aria-invalid', 'true');
      await expect(password).toHaveAccessibleDescription(invalidFormat);
      await expect(password).toBeFocused();
      expect(submissions).toBe(0);
      await password.fill('123456');
      await expect(password).not.toHaveAttribute('aria-invalid', 'true');
      await showPassword.press('Space');
      await expect(password).toHaveAttribute('type', 'text');
      await password.press('Enter');
      await expect(password).toHaveAttribute('aria-invalid', 'true');
      await expect(password).toHaveAttribute('type', 'password');
      await expect(showPassword).toHaveAttribute('aria-pressed', 'false');
      await expect(password).not.toHaveAccessibleDescription(invalidFormat);
      await expect(
        panel.getByRole('alert').filter({ hasText: /密码错误|credential is invalid/i })
      ).toBeVisible();
      expect(submissions).toBe(1);
      await expect(panel).not.toContainText(/six|digit|六位|数字/);
      await password.press('Enter');
      await expect(password).toHaveCount(0);
      const status = panel.getByRole('status');
      await expect(status).toBeFocused();
      await expect(status).toContainText(
        chinese ? '此分享已失效。' : 'This share is no longer available.'
      );
      await expect(status).toContainText('SESSION_SHARE_NOT_FOUND');
    }
  );
}
