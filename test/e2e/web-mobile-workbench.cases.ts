import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  emitMockSessionEvent,
  fulfillMockSessionWatch,
  json,
  mockConsoleApi,
  write
} from './support/web-console-api.js';

const currentVersion = (
  JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
    version: string;
  }
).version;

// Mobile Workbench

for (const labels of [
  { locale: 'zh-CN', enter: '进入控制台', work: '工作', sessions: '打开会话列表' },
  { locale: 'en-US', enter: 'Open console', work: 'Work', sessions: 'Open session list' }
]) {
  test(`Composer toolbar stays compact and left-aligned on mobile and desktop (${labels.locale})`, async ({
    page
  }, testInfo) => {
    const capabilities = ['history.read', 'events.live', 'turn.start', 'turn.interrupt'];
    await page.setViewportSize({ width: 1600, height: 900 });
    await mockConsoleApi(
      page,
      'MANAGED',
      capabilities,
      [],
      'GIT_WORKSPACE',
      true,
      'MANAGED_ACTIVE'
    );
    await page.addInitScript(
      (locale) => localStorage.setItem('mar.locale.v2', locale),
      labels.locale
    );
    const session = {
      id: 'session-1',
      workspaceId: 'workspace-1',
      runner: 'codex' as const,
      externalSessionId: 'vscode-thread-1',
      activity: 'MANAGED_ACTIVE' as const,
      control: { level: 'MANAGED', capabilities }
    };
    await page.route('**/api/agent-sessions/session-1/watch*', (route) =>
      fulfillMockSessionWatch(page, route, session, {
        kind: 'session-watch-snapshot',
        sequence: 1,
        session,
        runs: [{ id: 'run-1', status: 'RUNNING', recoveryState: 'ACTIVE' }],
        queue: { version: 0, paused: false, items: [] },
        context: { model: 'GPT-5.6 Sol', usedTokens: 34_700, maxTokens: 100_000, percentage: 34.7 },
        conversation: {
          unit: 'SEGMENT',
          source: 'official',
          readAt: 1,
          latestVisibleAt: 1,
          nextCursor: null,
          snapshotSequence: 1,
          segments: []
        }
      })
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

    const toolbar = page.locator('.composer-toolbar');
    const input = page.locator('.composer-input');
    for (const state of ['draft', 'running', 'queue'] as const) {
      if (state === 'running') {
        await page.setViewportSize({ width: 390, height: 900 });
        await page.getByRole('button', { name: labels.sessions }).click();
        await page.locator('.session-list button').first().click();
        await expect(toolbar.locator('.composer-context-button')).toHaveText('34.7%');
        await expect(toolbar.locator('.composer-stop-button')).toBeEnabled();
        await expect(toolbar.locator('.composer-send-button')).toHaveCount(0);
      }
      if (state === 'queue') {
        await input.fill('Follow-up message');
        await expect(toolbar.locator('.composer-send-button')).toBeEnabled();
      }
      for (const width of [320, 390, 767, 768, 1280, 1600]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(toolbar.locator('.composer-hint')).toHaveCount(width < 768 ? 0 : 1);
        const geometry = await toolbar.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const controls = Array.from(
            element.querySelectorAll<HTMLElement>(
              '.composer-attachment-button, .el-select__wrapper, .composer-context-button, .composer-send-button, .composer-stop-button'
            )
          ).map((control) => {
            const rect = control.getBoundingClientRect();
            return {
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom
            };
          });
          return {
            left: bounds.left,
            right: bounds.right,
            verticalSpace:
              bounds.height -
              (Math.max(...controls.map((c) => c.bottom)) -
                Math.min(...controls.map((c) => c.top))),
            controls
          };
        });
        expect(geometry.verticalSpace).toBeLessThanOrEqual(8);
        expect(
          geometry.controls[0]!.left - geometry.left,
          `${state} at ${width}px: attachment stays near the toolbar's left edge`
        ).toBeLessThanOrEqual(6);
        if (width < 768) {
          expect(
            geometry.controls[1]!.left - geometry.controls[0]!.right,
            `${state} at ${width}px: attachment stays close to the first configuration option`
          ).toBeLessThanOrEqual(8);
          for (const [index, control] of geometry.controls.entries()) {
            expect(control.left).toBeGreaterThanOrEqual(geometry.left);
            expect(control.right).toBeLessThanOrEqual(geometry.right);
            expect(
              Math.abs(
                (control.top + control.bottom) / 2 -
                  (geometry.controls[0]!.top + geometry.controls[0]!.bottom) / 2
              )
            ).toBeLessThanOrEqual(1);
            if (index > 0)
              expect(control.left).toBeGreaterThanOrEqual(geometry.controls[index - 1]!.right);
          }
        }
        if (width === 390 || width === 1600) {
          await page.locator('.composer-shell').screenshot({
            animations: 'disabled',
            path: testInfo.outputPath(`${state}-${width}.png`)
          });
        }
      }
    }
  });
}

test('Mobile conversation tools stay aligned to the right of the title bar', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  const notificationNow = Date.now();
  await page.route('**/api/notifications', (route) =>
    json(route, {
      notifications: [
        {
          id: 'mobile-notification',
          kind: 'run',
          title: 'Run complete',
          message: 'Open the run.',
          createdAt: notificationNow,
          updatedAt: notificationNow,
          expiresAt: notificationNow + 60_000,
          read: false,
          target: {
            targetType: 'WORKSPACE_SESSION',
            nodeId: 'node-1',
            workspaceId: 'workspace-1',
            sessionId: 'session-1'
          }
        }
      ]
    })
  );
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  const notificationButton = page.getByRole('button', { name: '打开通知中心' });
  const badge = notificationButton.locator('.workbench-notification-badge');
  await expect(badge).toHaveText('1');
  const badgePosition = await notificationButton.evaluate((button) => {
    const icon = button.querySelector('.el-icon')!.getBoundingClientRect();
    const badge = button.querySelector('.workbench-notification-badge')!.getBoundingClientRect();
    return {
      horizontalOverlap: icon.right - badge.left,
      rightInset: button.getBoundingClientRect().right - badge.right,
      leftInset: badge.left - button.getBoundingClientRect().left,
      topInset: badge.top - button.getBoundingClientRect().top,
      verticalOverlap: badge.bottom - icon.top
    };
  });
  expect(badgePosition.horizontalOverlap).toBeGreaterThanOrEqual(6);
  expect(badgePosition.rightInset).toBeGreaterThanOrEqual(0);
  expect(badgePosition.leftInset).toBeGreaterThanOrEqual(0);
  expect(badgePosition.topInset).toBeGreaterThanOrEqual(0);
  expect(badgePosition.verticalOverlap).toBeGreaterThanOrEqual(6);
  const nodesButton = page.getByRole('button', { name: '工作', exact: true });
  await nodesButton.click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await nodesButton.click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await expect(page.locator('.conversation-header h2')).toHaveText('新建会话');

  for (const width of [390, 420]) {
    await page.setViewportSize({ width, height: 844 });
    const bounds = await page.locator('.conversation-header').evaluate((header) => {
      const tools = header.querySelector('.mobile-conversation-tools');
      if (tools === null) throw new Error('Mobile conversation tools are missing');
      return {
        headerRight: header.getBoundingClientRect().right,
        toolsRight: tools.getBoundingClientRect().right,
        padding: Number.parseFloat(getComputedStyle(header).paddingRight)
      };
    });
    expect(Math.abs(bounds.headerRight - bounds.padding - bounds.toolsRight)).toBeLessThan(1);
  }
  await page.getByRole('button', { name: '打开会话列表' }).click();
  await expect(page.locator('.new-session-button')).toHaveCSS('height', '32px');
  const composer = page.getByRole('textbox', { name: '输入消息' });
  await page.locator('.new-session-button').click();
  await expect(page.locator('.new-session-button')).toBeHidden();
  await expect(composer).toBeFocused();
  await composer.fill('Mobile draft');
  await page.getByRole('button', { name: '打开会话列表' }).click();
  await page.locator('.new-session-button').click();
  await expect(page.locator('.new-session-button')).toBeHidden();
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue('Mobile draft');
});

test('Mobile file upload confirmation remains fully visible with accessible actions', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await page.route(/\/api\/workspaces\/workspace-1\/uploads\/preflight(?:\?.*)?$/, (route) =>
    json(route, {
      uploads: [
        {
          name: 'mobile-upload-confirmation.json',
          status: 'READY',
          path: 'mobile-upload-confirmation.json'
        }
      ]
    })
  );

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  const nodesButton = page.getByRole('button', { name: '工作', exact: true });
  await nodesButton.click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await nodesButton.click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.getByRole('button', { name: '打开文件' }).click();
  await expect(page.locator('.workspace-inspector')).toBeVisible();
  await page.locator('.explorer-toolbar .workspace-upload-input').setInputFiles({
    name: 'mobile-upload-confirmation.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{}')
  });

  const dialog = page.locator(
    '.upload-confirm-dialog.el-dialog, .upload-confirm-dialog .el-dialog'
  );
  await expect(dialog).toBeVisible();
  const layout = await dialog.evaluate((element) => {
    const dialogBounds = element.getBoundingClientRect();
    const buttons = [...element.querySelectorAll<HTMLButtonElement>('button')].map((button) =>
      button.getBoundingClientRect()
    );
    return {
      dialogLeft: dialogBounds.left,
      dialogRight: dialogBounds.right,
      dialogBottom: dialogBounds.bottom,
      buttons: buttons.map(({ left, right, bottom }) => ({ left, right, bottom })),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight
    };
  });

  expect(layout.dialogLeft).toBeGreaterThanOrEqual(0);
  expect(layout.dialogRight).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.dialogBottom).toBeLessThanOrEqual(layout.viewportHeight);
  for (const button of layout.buttons) {
    expect(button.left).toBeGreaterThanOrEqual(0);
    expect(button.right).toBeLessThanOrEqual(layout.viewportWidth);
    expect(button.bottom).toBeLessThanOrEqual(layout.viewportHeight);
  }
  await expect(dialog.getByRole('button', { name: '取消' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '开始上传' })).toBeVisible();
});

test('Mobile Composer anchors to the visual viewport bottom with matching conversation spacing', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await page.setViewportSize({ width: 390, height: 844 });
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  await page.route('**/api/notifications', (route) => json(route, { notifications: [] }));

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await expect(page.getByRole('button', { name: 'Web 性能诊断' })).toHaveCount(0);
  const nodesButton = page.getByRole('button', { name: '工作', exact: true });
  await nodesButton.click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await nodesButton.click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();

  const layout = await page.evaluate(() => {
    const composerHost = document.querySelector<HTMLElement>('.composer-host');
    const composer = document.querySelector<HTMLElement>('.composer');
    const conversationScroll = document.querySelector<HTMLElement>('.conversation-scroll-region');
    if (composerHost === null || composer === null || conversationScroll === null)
      throw new Error('Composer layout is unavailable');
    const hostBounds = composerHost.getBoundingClientRect();
    const composerBounds = composer.getBoundingClientRect();
    const scrollBounds = conversationScroll.getBoundingClientRect();
    return {
      documentHeight: document.scrollingElement?.scrollHeight ?? 0,
      viewportHeight: window.innerHeight,
      composerPosition: getComputedStyle(composer).position,
      composerTop: composerBounds.top,
      composerBottom: composerBounds.bottom,
      composerHeight: composerBounds.height,
      hostHeight: hostBounds.height,
      scrollBottom: scrollBounds.bottom
    };
  });

  expect(layout.documentHeight).toBeLessThanOrEqual(layout.viewportHeight + 1);
  expect(layout.composerPosition).toBe('fixed');
  expect(layout.composerBottom).toBeLessThanOrEqual(layout.viewportHeight + 1);
  expect(Math.abs(layout.hostHeight - layout.composerHeight)).toBeLessThanOrEqual(1);
  expect(layout.scrollBottom).toBeLessThanOrEqual(layout.composerTop + 1);

  const navigationTop = await page
    .getByTestId('workbench-brand')
    .evaluate((element) => element.getBoundingClientRect().top);
  await page.setViewportSize({ width: 390, height: 600 });
  await expect
    .poll(() =>
      page.locator('.composer').evaluate((element) => element.getBoundingClientRect().bottom)
    )
    .toBeCloseTo(600, 2);
  await expect
    .poll(() =>
      page.locator('.composer-host').evaluate((element) => {
        const hostHeight = element.getBoundingClientRect().height;
        const composerHeight = document
          .querySelector<HTMLElement>('.composer')
          ?.getBoundingClientRect().height;
        return Math.abs(hostHeight - (composerHeight ?? 0));
      })
    )
    .toBeLessThanOrEqual(1);
  expect(
    await page
      .getByTestId('workbench-brand')
      .evaluate((element) => element.getBoundingClientRect().top)
  ).toBe(navigationTop);
});

test('Mobile Workbench keeps one conversation surface and opens sessions, files, and terminals as tool layers', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await page.setViewportSize({ width: 390, height: 844 });
  await mockConsoleApi(
    page,
    'MANAGED',
    ['history.read', 'turn.start'],
    writes,
    'GIT_WORKSPACE',
    true,
    undefined,
    undefined,
    '0.9.12'
  );
  const notificationNow = Date.now();
  await page.route('**/api/notifications', (route) =>
    json(route, {
      notifications: [
        {
          id: 'mobile-notification',
          kind: 'run',
          title: '后台运行已完成',
          message: '点击查看相关会话。',
          createdAt: notificationNow,
          updatedAt: notificationNow,
          expiresAt: notificationNow + 60_000,
          read: false,
          target: {
            nodeId: 'node-1',
            workspaceId: 'workspace-1',
            sessionId: 'session-1',
            sessionName: 'session-1'
          }
        }
      ]
    })
  );
  await page.route(/\/api\/workspaces\/workspace-1\/files(?:\?.*)?$/, (route) => {
    const directory = new URL(route.request().url()).searchParams.get('path');
    return json(route, {
      files: {
        entries:
          directory === 'src'
            ? [{ path: 'src/main.ts', name: 'main.ts', kind: 'FILE', size: 25, modifiedAt: 1 }]
            : [
                { path: 'AGENTS.md', name: 'AGENTS.md', kind: 'FILE', size: 25, modifiedAt: 1 },
                { path: 'src', name: 'src', kind: 'DIRECTORY', size: null, modifiedAt: 1 }
              ],
        nextCursor: null,
        truncated: false
      }
    });
  });
  await page.route(/\/api\/workspaces\/workspace-1\/files\/read(?:\?.*)?$/, (route) =>
    json(route, {
      file: {
        path: new URL(route.request().url()).searchParams.get('path') ?? 'src/main.ts',
        encoding: 'utf-8',
        content: '# Agent constraints\n',
        truncated: false,
        nextOffset: null,
        revision: 'a'.repeat(64)
      }
    })
  );
  await page.route(/\/api\/workspaces\/workspace-1\/changes(?:\?.*)?$/, (route) =>
    json(route, {
      branch: 'main',
      changes: [
        { path: 'src/main.ts', state: 'UNSTAGED', change: 'MODIFIED', diffAvailable: true }
      ],
      repositories: [
        {
          repositoryPath: '',
          repositoryName: 'project',
          source: 'ROOT',
          branch: 'main',
          changes: [
            { path: 'src/main.ts', state: 'UNSTAGED', change: 'MODIFIED', diffAvailable: true }
          ]
        }
      ]
    })
  );
  await page.route(/\/api\/workspaces\/workspace-1\/changes\/diff(?:\?.*)?$/, (route) =>
    json(route, {
      diff: {
        binary: false,
        afterText: 'export const answer = 42;\n',
        text: 'diff --git a/src/main.ts b/src/main.ts\n@@ -1 +1 @@\n-export const answer = 41;\n+export const answer = 42;\n'
      }
    })
  );
  let mobileTerminalCreated = false;
  await page.route('**/api/terminals**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/terminals' && route.request().method() === 'POST') {
      mobileTerminalCreated = true;
      return json(route, {
        terminal: {
          id: 'terminal-1',
          workspaceId: 'workspace-1',
          profileId: 'default',
          state: 'RUNNING',
          latestSequence: 0
        }
      });
    }
    if (path === '/api/terminals/terminal-1/attach-ticket')
      return json(route, { ticket: 'ticket-1' });
    if (path === '/api/terminals/terminal-1' && route.request().method() === 'DELETE') {
      mobileTerminalCreated = false;
      return json(route, {
        terminal: {
          id: 'terminal-1',
          workspaceId: 'workspace-1',
          profileId: 'default',
          state: 'CLOSED',
          latestSequence: 0
        }
      });
    }
    if (path === '/api/terminals') {
      return json(route, {
        terminals: mobileTerminalCreated
          ? [
              {
                id: 'terminal-1',
                workspaceId: 'workspace-1',
                profileId: 'default',
                state: 'RUNNING',
                latestSequence: 0
              }
            ]
          : []
      });
    }
    return route.fallback();
  });
  await page.route('**/api/agent-sessions/session-1/watch', (route) =>
    json(route, {
      session: {
        id: 'session-1',
        workspaceId: 'workspace-1',
        runner: 'codex',
        externalSessionId: 'vscode-thread-1',
        activity: 'IDLE',
        control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
      },
      watch: { expiresAt: 1_900_000_015_000 }
    })
  );

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  const nodesButton = page.getByRole('button', { name: '工作', exact: true });
  await expect(nodesButton).toBeVisible();
  await nodesButton.click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await nodesButton.click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();

  const brand = page.getByTestId('workbench-brand');
  await expect(page.locator('html')).toHaveCSS('font-size', '16px');
  await page.locator('html').evaluate((element) => {
    element.setAttribute('data-theme', 'vscode-dark-2026');
    element.classList.add('dark');
  });
  await expect(brand).toHaveCSS('border-top-width', '0px');
  await expect(brand).toHaveCSS('border-bottom-width', '1px');
  await expect(brand).toHaveCSS('border-bottom-color', 'rgb(39, 49, 66)');
  expect(
    await page
      .locator('html')
      .evaluate((element) =>
        getComputedStyle(element).getPropertyValue('--el-component-size-small').trim()
      )
  ).toBe('24px');
  expect(
    await page
      .locator('html')
      .evaluate((element) =>
        getComputedStyle(element).getPropertyValue('--el-font-size-small').trim()
      )
  ).toBe('13px');
  await expect(brand.getByRole('link', { name: '返回 MyAgentRoam 首页' })).toHaveAttribute(
    'href',
    '/'
  );
  await expect(brand.getByText('MyAgentRoam')).not.toBeVisible();
  await expect(brand.locator('.brand-version')).not.toBeVisible();
  await expect(brand.getByRole('img', { name: 'MyAgentRoam' })).toHaveAttribute(
    'title',
    `MyAgentRoam ${currentVersion}`
  );
  const notificationsButton = page.getByRole('button', { name: '打开通知中心' });
  const documentationLink = page.getByRole('link', { name: '帮助' });
  await expect(documentationLink).toHaveAttribute('href', '/docs/getting-started/overview');
  await expect(documentationLink).toHaveAttribute('target', '_blank');
  await expect(documentationLink.locator('.rail-label')).toHaveText('帮助');
  await expect(documentationLink.locator('.rail-label')).toBeVisible();
  await expect(notificationsButton.locator('.workbench-notification-trigger-label')).toHaveCount(0);
  const [nodesGeometry, documentationGeometry, notificationGeometry, brandGeometryBox] =
    await Promise.all([
      nodesButton.boundingBox(),
      documentationLink.boundingBox(),
      notificationsButton.boundingBox(),
      page.getByTestId('workbench-brand').boundingBox()
    ]);
  expect(documentationGeometry?.y).toBe(nodesGeometry?.y);
  expect(documentationGeometry?.height).toBe(nodesGeometry?.height);
  const [nodesContentGeometry, documentationContentGeometry] = await Promise.all([
    nodesButton.locator('.nav-item-content').evaluate((element) => {
      const content = element.getBoundingClientRect();
      const icon = element.querySelector('.el-icon')!.getBoundingClientRect();
      const label = element.querySelector('.rail-label')!.getBoundingClientRect();
      return {
        contentCenterY: content.top + content.height / 2,
        iconCenterY: icon.top + icon.height / 2,
        labelCenterY: label.top + label.height / 2
      };
    }),
    documentationLink.locator('.nav-item-content').evaluate((element) => {
      const content = element.getBoundingClientRect();
      const icon = element.querySelector('.el-icon')!.getBoundingClientRect();
      const label = element.querySelector('.rail-label')!.getBoundingClientRect();
      return {
        contentCenterY: content.top + content.height / 2,
        iconCenterY: icon.top + icon.height / 2,
        labelCenterY: label.top + label.height / 2
      };
    })
  ]);
  expect(documentationContentGeometry).toEqual(nodesContentGeometry);
  expect(
    (notificationGeometry?.y ?? Infinity) + (notificationGeometry?.height ?? 0)
  ).toBeLessThanOrEqual((brandGeometryBox?.y ?? 0) + (brandGeometryBox?.height ?? 0));
  await notificationsButton.click();
  const notificationCenter = page.getByRole('complementary', { name: '通知中心' });
  await expect(notificationCenter.getByText('后台运行已完成', { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      notificationCenter.evaluate((element) => {
        const drawer = document.querySelector<HTMLElement>('.workspace-tree');
        const headerHeight = Number.parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue('--sidebar-header-height')
        );
        return (
          element.parentElement === document.body &&
          Number(getComputedStyle(element).zIndex) > Number(getComputedStyle(drawer!).zIndex) &&
          element.getBoundingClientRect().top - headerHeight >= 7 &&
          element.getBoundingClientRect().bottom <= window.innerHeight - 7
        );
      })
    )
    .toBe(true);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '账户安全' })).toBeVisible();
  await notificationsButton.click();
  await notificationCenter
    .locator('.workbench-notification-list > li')
    .first()
    .getByRole('button')
    .first()
    .click();
  await expect(page.getByRole('button', { name: '工作', exact: true })).toHaveClass(/active/);
  await expect(page.getByRole('button', { name: '打开会话列表' })).toBeVisible();
  await expect(page.getByRole('button', { name: '打开文件' })).toBeVisible();
  await expect(page.getByRole('button', { name: '打开终端' })).toBeVisible();
  await expect(page.locator('.workbench-header')).toHaveCount(0);
  await expect(page.locator('.conversation-sidebar')).not.toBeVisible();
  await expect(page.locator('.inspector-column')).not.toBeVisible();
  await expect(page.locator('.terminal-dock')).not.toBeVisible();

  const initialLayout = await page.evaluate(() => {
    const composer = document.querySelector<HTMLElement>('.composer');
    if (composer === null) throw new Error('Composer 未渲染');
    return {
      documentHeight: document.scrollingElement?.scrollHeight ?? 0,
      viewportHeight: window.innerHeight,
      composerBottom: composer.getBoundingClientRect().bottom
    };
  });
  expect(initialLayout.documentHeight).toBeLessThanOrEqual(initialLayout.viewportHeight + 1);
  expect(initialLayout.composerBottom).toBeLessThanOrEqual(initialLayout.viewportHeight + 1);
  await expect(page.locator('body')).toHaveCSS('overflow-y', 'hidden');

  const mobileComposer = page.getByRole('textbox', { name: '输入消息' });
  await expect(mobileComposer).toHaveAttribute('enterkeyhint', 'enter');
  await mobileComposer.fill('第一行');
  await mobileComposer.press('Enter');
  await expect(mobileComposer).toHaveValue('第一行\n');
  await expect(page.getByText(/Enter 发送|Enter 排队/)).toHaveCount(0);
  await expect(page.locator('.composer-mobile-select-label')).toHaveCount(0);
  const composerRow = await page.locator('.composer-toolbar').evaluate((toolbar) => {
    const toolbarRect = toolbar.getBoundingClientRect();
    const controls = [
      '.composer-attachment-button',
      '.composer-model-slot',
      '.composer-access-slot',
      '.composer-send-button'
    ].map((selector) => {
      const element = toolbar.querySelector<HTMLElement>(selector);
      if (element === null) throw new Error(`缺少 Composer 控件：${selector}`);
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
    });
    return { toolbar: { left: toolbarRect.left, right: toolbarRect.right }, controls };
  });
  const controlCenters = composerRow.controls.map((control) => (control.top + control.bottom) / 2);
  const sendControl = composerRow.controls.at(-1);
  if (sendControl === undefined) throw new Error('发送按钮未渲染');
  expect(Math.max(...controlCenters) - Math.min(...controlCenters)).toBeLessThanOrEqual(1);
  expect(sendControl.right - sendControl.left).toBe(36);
  expect(sendControl.bottom - sendControl.top).toBe(36);
  expect(composerRow.controls.every((control) => control.left >= composerRow.toolbar.left)).toBe(
    true
  );
  expect(composerRow.controls.every((control) => control.right <= composerRow.toolbar.right)).toBe(
    true
  );

  const closeMobileWorkspaceSurface = async () => {
    const scrim = page.getByRole('button', { name: '关闭工作区工具' });
    await expect(scrim).toBeVisible();
    const bounds = await scrim.boundingBox();
    if (bounds === null) throw new Error('工作区工具遮罩未生成可点击区域');
    await page.mouse.click(bounds.x + bounds.width - 12, bounds.y + 64);
    await expect(scrim).toHaveCount(0);
  };

  await page.getByRole('button', { name: '打开会话列表' }).click();
  await expect(page.locator('.conversation-sidebar')).toBeVisible();
  await expect(page.locator('.conversation-sidebar')).toHaveCSS('top', '46px');
  await expect(page.getByRole('button', { name: '返回对话' })).toHaveCount(0);
  await closeMobileWorkspaceSurface();
  await expect(page.locator('.conversation-sidebar')).not.toBeVisible();
  await expect(page.locator('.conversation-header h2')).toHaveText('新建会话');

  await page.getByRole('button', { name: '打开文件' }).click();
  await expect(page.locator('.inspector-column')).toBeVisible();
  await expect(page.locator('.workspace-inspector').getByRole('heading', { level: 2 })).toHaveText(
    '文件'
  );
  await expect(page.locator('.inspector-column')).toHaveCSS('top', '46px');
  const inspectorBounds = await page.locator('.inspector-column').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { bottom: rect.bottom, viewportHeight: window.innerHeight };
  });
  expect(inspectorBounds.bottom).toBe(inspectorBounds.viewportHeight);
  await page.getByRole('button', { name: '刷新文件' }).click();
  await page.getByRole('treeitem', { name: 'AGENTS.md', exact: true }).click();
  const preview = page.getByRole('dialog', { name: 'AGENTS.md 文件预览' });
  const previewSurface = page.locator('.workspace-file-tabs');
  await expect(previewSurface).toHaveCSS('position', 'fixed');
  await expect(preview).toBeVisible();
  const previewBounds = await previewSurface.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: window.innerWidth,
      height: window.innerHeight
    };
  });
  expect(previewBounds).toEqual({
    left: 0,
    top: 0,
    right: previewBounds.width,
    bottom: previewBounds.height,
    width: previewBounds.width,
    height: previewBounds.height
  });
  await expect(preview.locator('.mobile-preview-actions')).toBeVisible();
  await expect(
    preview.locator('.mobile-preview-actions').getByRole('button', { name: '下载文件' })
  ).toBeVisible();
  await expect(preview.getByText('只读文件', { exact: true })).toBeVisible();
  await expect(
    preview.locator('.mobile-preview-actions').getByRole('button', { name: 'Markdown 预览设置' })
  ).toBeVisible();
  await expect(preview.getByRole('button', { name: '关闭预览' })).toHaveCount(0);
  const mobilePreviewActionBounds = await page
    .getByRole('button', { name: '关闭文件窗口', exact: true })
    .evaluate((close) => {
      const rect = close.getBoundingClientRect();
      return {
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth
      };
    });
  expect(mobilePreviewActionBounds.left).toBeGreaterThanOrEqual(0);
  expect(mobilePreviewActionBounds.top).toBeGreaterThanOrEqual(0);
  expect(mobilePreviewActionBounds.right).toBeLessThanOrEqual(
    mobilePreviewActionBounds.viewportWidth
  );
  expect(mobilePreviewActionBounds.bottom).toBeLessThanOrEqual(
    mobilePreviewActionBounds.viewportHeight
  );
  await preview.getByRole('button', { name: '收起文件预览快捷操作' }).click();
  await expect(preview.locator('.workspace-file-mobile-actions-body')).toHaveAttribute(
    'aria-hidden',
    'true'
  );
  await preview.getByRole('button', { name: '展开文件预览快捷操作' }).click();
  await expect(preview.locator('.workspace-file-mobile-actions-body')).toHaveAttribute(
    'aria-hidden',
    'false'
  );
  await preview
    .locator('.mobile-preview-actions')
    .getByRole('button', { name: '文件内查找' })
    .click();
  await expect(preview.getByRole('search', { name: '文件内查找' })).toBeVisible();
  await preview.getByRole('button', { name: '关闭查找' }).click();
  await page.getByRole('button', { name: '关闭文件窗口', exact: true }).click();

  await page.getByRole('tab', { name: 'Git 变更', exact: true }).click();
  await page.getByRole('button', { name: '查看 src/main.ts 的 Diff' }).click();
  const diff = page.getByRole('dialog', { name: 'src/main.ts Git 差异' });
  const diffSurface = page.locator('.workspace-file-tabs');
  await expect(diffSurface).toHaveCSS('position', 'fixed');
  await expect(diff).toBeVisible();
  const diffBounds = await diffSurface.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: window.innerWidth,
      height: window.innerHeight
    };
  });
  expect(diffBounds).toEqual({
    left: 0,
    top: 0,
    right: diffBounds.width,
    bottom: diffBounds.height,
    width: diffBounds.width,
    height: diffBounds.height
  });
  await expect(diff.locator('.mobile-preview-actions')).toBeVisible();
  const diffSummary = diff.getByLabel('Diff 摘要');
  await expect(diffSummary.getByText('文件 1 / 1', { exact: true })).toBeVisible();
  await expect(diffSummary.getByText('差异 1 / 1', { exact: true })).toBeVisible();
  const diffNavigation = diff.locator('.diff-mobile-navigation');
  const diffUtilities = diff.locator('.diff-mobile-utilities');
  for (const name of ['上一个文件', '下一个文件', '上一个差异', '下一个差异']) {
    await expect(diffNavigation.getByRole('button', { name })).toBeVisible();
  }
  const [navigationBounds, utilityBounds] = await Promise.all([
    diffNavigation.boundingBox(),
    diffUtilities.boundingBox()
  ]);
  expect((navigationBounds?.y ?? Infinity) + (navigationBounds?.height ?? 0)).toBeLessThanOrEqual(
    utilityBounds?.y ?? 0
  );
  await expect(diffUtilities.getByRole('button', { name: '下载 Diff' })).toBeVisible();
  await diff.getByRole('button', { name: '收起文件预览快捷操作' }).click();
  await expect(diff.locator('.workspace-file-mobile-actions-body')).toHaveAttribute(
    'aria-hidden',
    'true'
  );
  await diff.getByRole('button', { name: '展开文件预览快捷操作' }).click();
  await expect(diff.locator('.workspace-file-mobile-actions-body')).toHaveAttribute(
    'aria-hidden',
    'false'
  );
  await diffUtilities.getByRole('button', { name: '文件内查找' }).click();
  await expect(diff.getByRole('search', { name: '文件内查找' })).toBeVisible();
  await diff.getByRole('button', { name: '关闭查找' }).click();
  await expect(diff.getByRole('button', { name: '关闭 Diff 预览' })).toHaveCount(0);
  await page.getByRole('button', { name: '关闭文件窗口', exact: true }).click();
  await closeMobileWorkspaceSurface();
  await expect(page.locator('.inspector-column')).not.toBeVisible();

  await page.getByRole('button', { name: '打开终端' }).click();
  await expect(page.locator('.terminal-dock')).toBeVisible();
  await expect(page.locator('.terminal-dock')).toHaveCSS('top', '46px');
  await expect(page.locator('.terminal-tab:not(.terminal-tab-add)')).toHaveCount(1);
  const terminalFill = await page.locator('.terminal-dock').evaluate((dock) => {
    const body = dock.querySelector<HTMLElement>('.admin-terminal-body');
    if (body === null) return null;
    const dockBounds = dock.getBoundingClientRect();
    const bodyBounds = body.getBoundingClientRect();
    return {
      bottomGap: Math.round(dockBounds.bottom - bodyBounds.bottom),
      bodyHeight: Math.round(bodyBounds.height)
    };
  });
  expect(terminalFill).not.toBeNull();
  expect(terminalFill?.bottomGap).toBeLessThanOrEqual(1);
  expect(terminalFill?.bodyHeight).toBeGreaterThan(500);
  await page.getByRole('button', { name: '关闭终端 1' }).click();
  await expect(page.locator('.terminal-dock')).not.toBeVisible();
  await expect(page.getByRole('button', { name: '关闭工作区工具' })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '输入消息' })).toBeVisible();

  await page.locator('.conversation-header').evaluate((header) => {
    const sessionId = document.createElement('p');
    sessionId.className = 'conversation-session-id';
    sessionId.title = 'session-'.repeat(24);
    const code = document.createElement('code');
    code.textContent = sessionId.title;
    sessionId.append(code);
    header.querySelector('.conversation-header-title')?.append(sessionId);
  });
  const sessionId = page.locator('.conversation-session-id').last();
  await expect(sessionId).toHaveText('session-'.repeat(24));
  await expect(sessionId.locator('code')).toHaveCSS('white-space', 'nowrap');
  const sessionIdLayout = await sessionId.locator('code').evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight
  }));
  expect(sessionIdLayout.scrollHeight).toBeLessThanOrEqual(sessionIdLayout.clientHeight);
  expect(writes).toEqual([]);
});

test('Mobile messages entered during a Run can be sent to the queue', async ({ page }) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await page.setViewportSize({ width: 390, height: 844 });
  await mockConsoleApi(
    page,
    'MANAGED',
    ['history.read', 'events.live', 'turn.start', 'turn.steer', 'turn.interrupt'],
    writes
  );
  await page.route('**/api/agent-sessions/session-1/runs?nodeId=node-1', (route) =>
    json(route, {
      runs: [
        {
          id: 'run-1',
          sessionId: 'session-1',
          workspaceId: 'workspace-1',
          status: 'RUNNING',
          recoveryState: 'ACTIVE',
          clientMessageId: 'working-message'
        }
      ]
    })
  );
  await page.route('**/api/agent-sessions/session-1/messages', (route) =>
    write(route, writes, {
      session: {
        id: 'session-1',
        workspaceId: 'workspace-1',
        runner: 'codex',
        externalSessionId: 'vscode-thread-1',
        activity: 'MANAGED_ACTIVE',
        control: {
          level: 'MANAGED',
          capabilities: [
            'history.read',
            'events.live',
            'turn.start',
            'turn.steer',
            'turn.interrupt'
          ]
        }
      },
      run: {
        id: 'run-1',
        status: 'RUNNING',
        recoveryState: 'ACTIVE',
        clientMessageId: 'working-message'
      },
      queueItemId: 'queue-item-2',
      delivery: 'QUEUED'
    })
  );

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.getByRole('button', { name: '打开会话列表' }).click();
  await page.locator('.session-list button').first().click();

  const input = page.getByRole('textbox', { name: '输入消息' });
  await expect(page.getByRole('button', { name: '停止运行' })).toBeVisible();
  await expect(page.getByRole('button', { name: '停止运行' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '发送' })).toHaveCount(0);
  await input.fill('移动端排队消息');
  await expect(page.getByRole('button', { name: '停止运行' })).toBeVisible();
  await expect(page.getByRole('button', { name: '发送' })).toBeVisible();
  await page.getByRole('button', { name: '发送' }).click();

  await emitMockSessionEvent(page, 'queue', {
    sessionId: 'session-1',
    queue: {
      version: 1,
      paused: false,
      items: [
        {
          queueItemId: 'queue-item-2',
          sessionId: 'session-1',
          workspaceId: 'workspace-1',
          runner: 'codex',
          clientMessageId: 'queue-message-2',
          sessionTitle: '现有会话',
          content: '移动端排队消息',
          createdAt: 2
        }
      ]
    }
  });
  const pendingWork = page.getByLabel('待执行工作');
  await expect(pendingWork).toContainText('移动端排队消息');
  const mobileQueueLayout = await pendingWork.locator('.queue-item').evaluate((item) => {
    const kindElement = item.querySelector('.work-item-kind');
    const contentElement = item.querySelector('.work-item-content');
    const actionsElement = item.querySelector('.queue-item-actions');
    const kind = kindElement?.getBoundingClientRect();
    const content = contentElement?.getBoundingClientRect();
    const actions = actionsElement?.getBoundingClientRect();
    const edit = Array.from(item.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === '编辑'
    );
    const runNow = Array.from(item.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === '执行'
    );
    return {
      itemHeight: item.getBoundingClientRect().height,
      kindCenter: kind === undefined ? undefined : kind.top + kind.height / 2,
      kindRight: kind?.right,
      contentLeft: content?.left,
      contentCenter: content === undefined ? undefined : content.top + content.height / 2,
      actionsCenter: actions === undefined ? undefined : actions.top + actions.height / 2,
      contentFontSize:
        contentElement === null ? undefined : getComputedStyle(contentElement).fontSize,
      kindFontSize: kindElement === null ? undefined : getComputedStyle(kindElement).fontSize,
      actionLabelDisplay:
        edit === undefined
          ? undefined
          : getComputedStyle(edit.querySelector('.work-item-action-label')!).display,
      editColor: edit === undefined ? undefined : getComputedStyle(edit).color,
      runNowColor: runNow === undefined ? undefined : getComputedStyle(runNow).color
    };
  });
  expect(Math.abs(mobileQueueLayout.kindCenter! - mobileQueueLayout.contentCenter!)).toBeLessThan(
    3
  );
  expect(
    Math.abs(mobileQueueLayout.actionsCenter! - mobileQueueLayout.contentCenter!)
  ).toBeLessThan(3);
  expect(mobileQueueLayout.contentFontSize).toBe('11px');
  expect(mobileQueueLayout.kindFontSize).toBe(mobileQueueLayout.contentFontSize);
  expect(mobileQueueLayout.contentLeft! - mobileQueueLayout.kindRight!).toBeLessThanOrEqual(8);
  expect(mobileQueueLayout.itemHeight).toBeLessThanOrEqual(32);
  expect(mobileQueueLayout.actionLabelDisplay).toBe('inline');
  expect(mobileQueueLayout.runNowColor).toBe(mobileQueueLayout.editColor);
  const activeGoalSession = {
    id: 'session-1',
    workspaceId: 'workspace-1',
    runner: 'codex',
    externalSessionId: 'vscode-thread-1',
    activity: 'MANAGED_ACTIVE',
    control: {
      level: 'MANAGED',
      capabilities: ['history.read', 'events.live', 'turn.start', 'turn.steer', 'turn.interrupt']
    },
    commandStates: [
      {
        commandId: 'goal',
        active: true,
        label: 'Goal',
        detail: 'Goal is active.',
        closable: true,
        closeInput: '/goal --clear',
        goal: {
          id: 'goal-1',
          objective: '持续处理当前目标',
          revision: 1,
          status: 'active',
          turns: 1
        }
      }
    ]
  };
  await emitMockSessionEvent(page, 'session', { session: activeGoalSession });
  await expect(pendingWork.locator('.goal-kind')).toHaveText('目标');
  const mobileGoalLayout = await pendingWork.locator('.goal-card').evaluate((item) => {
    const textCenter = (selector: string): number | undefined => {
      const element = item.querySelector(selector);
      if (element === null) return undefined;
      const range = document.createRange();
      range.selectNodeContents(element);
      const bounds = range.getBoundingClientRect();
      return bounds.top + bounds.height / 2;
    };
    return {
      itemHeight: item.getBoundingClientRect().height,
      kindCenter: textCenter('.goal-kind'),
      objectiveCenter: textCenter('.goal-objective'),
      actionsCenter: textCenter('.goal-actions'),
      kindFontSize: getComputedStyle(item.querySelector('.goal-kind')!).fontSize,
      objectiveFontSize: getComputedStyle(item.querySelector('.goal-objective')!).fontSize
    };
  });
  expect(Math.abs(mobileGoalLayout.kindCenter! - mobileGoalLayout.objectiveCenter!)).toBeLessThan(
    3
  );
  expect(
    Math.abs(mobileGoalLayout.actionsCenter! - mobileGoalLayout.objectiveCenter!)
  ).toBeLessThan(3);
  expect(mobileGoalLayout.kindFontSize).toBe(mobileGoalLayout.objectiveFontSize);
  expect(mobileGoalLayout.itemHeight).toBeLessThanOrEqual(32);
  await page.setViewportSize({ width: 1280, height: 800 });
  const desktopQueueLayout = await pendingWork.locator('.queue-item').evaluate((item) => {
    const kind = item.querySelector('.work-item-kind');
    const content = item.querySelector('.work-item-content');
    return {
      itemHeight: item.getBoundingClientRect().height,
      kindRight: kind?.getBoundingClientRect().right,
      contentLeft: content?.getBoundingClientRect().left,
      kindFontSize: kind === null ? undefined : getComputedStyle(kind).fontSize,
      contentFontSize: content === null ? undefined : getComputedStyle(content).fontSize
    };
  });
  expect(desktopQueueLayout.kindFontSize).toBe(desktopQueueLayout.contentFontSize);
  expect(desktopQueueLayout.contentLeft! - desktopQueueLayout.kindRight!).toBeLessThanOrEqual(8.05);
  expect(desktopQueueLayout.itemHeight).toBeLessThanOrEqual(32);
  const desktopGoalLayout = await pendingWork.locator('.goal-card').evaluate((item) => {
    const textCenter = (selector: string): number | undefined => {
      const element = item.querySelector(selector);
      if (element === null) return undefined;
      const range = document.createRange();
      range.selectNodeContents(element);
      const bounds = range.getBoundingClientRect();
      return bounds.top + bounds.height / 2;
    };
    return {
      itemHeight: item.getBoundingClientRect().height,
      kindCenter: textCenter('.goal-kind'),
      objectiveCenter: textCenter('.goal-objective'),
      actionsCenter: textCenter('.goal-actions'),
      kindFontSize: getComputedStyle(item.querySelector('.goal-kind')!).fontSize,
      objectiveFontSize: getComputedStyle(item.querySelector('.goal-objective')!).fontSize
    };
  });
  expect(Math.abs(desktopGoalLayout.kindCenter! - desktopGoalLayout.objectiveCenter!)).toBeLessThan(
    3
  );
  expect(
    Math.abs(desktopGoalLayout.actionsCenter! - desktopGoalLayout.objectiveCenter!)
  ).toBeLessThan(3);
  expect(desktopGoalLayout.kindFontSize).toBe(desktopGoalLayout.objectiveFontSize);
  expect(desktopGoalLayout.itemHeight).toBeLessThanOrEqual(32);
  await page.setViewportSize({ width: 390, height: 844 });
  const goalCard = pendingWork.locator('.goal-card');
  await goalCard.getByRole('button', { name: '编辑', exact: true }).click();
  const goalEditor = goalCard.locator('.goal-objective-input textarea');
  await expect(goalEditor).toHaveCSS('font-size', mobileGoalLayout.objectiveFontSize);
  await expect(goalEditor).toHaveValue('持续处理当前目标');
  await goalCard.getByRole('button', { name: '取消', exact: true }).click();
  await expect(goalCard.locator('.goal-objective')).toHaveText('持续处理当前目标');
  await pendingWork.locator('.queue-item').getByRole('button', { name: '编辑' }).click();
  const mobileQueueEditLayout = await pendingWork
    .locator('.queue-item.editing')
    .evaluate((item) => {
      const kind = item.querySelector('.work-item-kind')?.getBoundingClientRect();
      const input = item.querySelector('textarea')?.getBoundingClientRect();
      const actions = item.querySelector('.queue-item-actions')?.getBoundingClientRect();
      const section = item.closest('.composer-queue')?.getBoundingClientRect();
      const itemBounds = item.getBoundingClientRect();
      return {
        itemHeight: itemBounds.height,
        inputHeight: input?.height,
        kindCenter: kind === undefined ? undefined : kind.top + kind.height / 2,
        inputCenter: input === undefined ? undefined : input.top + input.height / 2,
        actionsCenter: actions === undefined ? undefined : actions.top + actions.height / 2,
        bottomGap: section === undefined ? undefined : section.bottom - itemBounds.bottom
      };
    });
  expect(mobileQueueEditLayout.itemHeight).toBeLessThanOrEqual(32);
  expect(mobileQueueEditLayout.inputHeight).toBeLessThanOrEqual(28);
  expect(
    Math.abs(mobileQueueEditLayout.kindCenter! - mobileQueueEditLayout.inputCenter!)
  ).toBeLessThan(3);
  expect(
    Math.abs(mobileQueueEditLayout.actionsCenter! - mobileQueueEditLayout.inputCenter!)
  ).toBeLessThan(3);
  expect(mobileQueueEditLayout.bottomGap).toBeLessThanOrEqual(5);
  const queueEditor = pendingWork.locator('.composer-queue-input textarea');
  await expect(queueEditor).toHaveCSS('font-size', mobileQueueLayout.contentFontSize!);
  await queueEditor.fill('第一行\n第二行');
  await expect
    .poll(async () => (await queueEditor.boundingBox())?.height)
    .toBeGreaterThan(mobileQueueEditLayout.inputHeight!);
  expect(writes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        url: expect.stringContaining('/messages'),
        body: expect.stringContaining('"deliveryIntent":"QUEUE"')
      })
    ])
  );
  await emitMockSessionEvent(page, 'session', {
    session: { ...activeGoalSession, activity: 'IDLE', commandStates: [] }
  });
  await expect(pendingWork.locator('.goal-card')).toHaveCount(0);
  await emitMockSessionEvent(page, 'session', { session: activeGoalSession });
  await expect(pendingWork.locator('.goal-card')).toBeVisible();
  await page.route('**/api/agent-sessions/session-1/commands', (route) =>
    write(route, writes, {
      session: {
        id: 'session-1',
        workspaceId: 'workspace-1',
        runner: 'codex',
        externalSessionId: 'vscode-thread-1',
        activity: 'MANAGED_ACTIVE',
        control: {
          level: 'MANAGED',
          capabilities: [
            'history.read',
            'events.live',
            'turn.start',
            'turn.steer',
            'turn.interrupt'
          ]
        },
        commandStates: []
      },
      cleared: true,
      goalExit: { status: 'removed', elapsedWallMs: 12_000, turns: 1 }
    })
  );
  await pendingWork.locator('.goal-card').getByRole('button', { name: '移除' }).click();
  await expect(page.locator('.el-message')).toContainText(
    '已移除目标，当前执行未中断。累计耗时 12s，已开始 1 轮。'
  );
  expect(writes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        url: expect.stringContaining('/commands'),
        body: expect.stringContaining('"input":"/goal --clear"')
      })
    ])
  );
});

for (const labels of [
  { locale: 'zh-CN', enter: '进入控制台', work: '工作', help: '帮助', theme: 'vscode-dark-2026' },
  { locale: 'en-US', enter: 'Open console', work: 'Work', help: 'Help', theme: 'daylight' }
]) {
  test(`Mobile Help and notification icons align with navigation entries (${labels.locale})`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
    await page.addInitScript(({ locale, theme }) => {
      localStorage.setItem('mar.locale.v2', locale);
      localStorage.setItem('mar.theme', theme);
    }, labels);
    await page.goto('/console');
    await page.getByRole('button', { name: labels.enter }).click();
    const help = page.getByRole('link', { name: labels.help, exact: true });
    const work = page.getByRole('button', { name: labels.work, exact: true });
    const notification = page.locator('.workbench-notification-trigger');
    await work.click();
    for (const width of [320, 390, 767, 768, 1600]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(help).toBeVisible();
      if (width >= 768) {
        await expect(help.locator('.documentation-icon')).toBeHidden();
        await notification.hover();
        await expect(notification).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        continue;
      }
      await expect(notification).toHaveCSS('width', '36px');
      await expect(notification).toHaveCSS('height', '36px');
      await expect(notification.locator('.el-icon')).toHaveCSS('width', '18px');
      await expect(notification.locator('.el-icon')).toHaveCSS('height', '18px');
      const [workBounds, notificationBounds] = await Promise.all([
        work.boundingBox(),
        notification.boundingBox()
      ]);
      expect(notificationBounds?.y).toBe(workBounds?.y);
      expect(notificationBounds?.height).toBe(workBounds?.height);
      const idleNavigation = page.locator('button.nav-menu-button:not(.active)').first();
      await page.mouse.move(0, 100);
      await expect(notification).toHaveCSS(
        'color',
        await idleNavigation.evaluate((element) => getComputedStyle(element).color)
      );
      await idleNavigation.hover();
      const hoverStyle = await idleNavigation.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          color: style.color,
          background: style.backgroundColor,
          radius: style.borderRadius
        };
      });
      await notification.hover();
      await expect(notification).toHaveCSS('color', hoverStyle.color);
      await expect(notification).toHaveCSS('background-color', hoverStyle.background);
      await expect(notification).toHaveCSS('border-radius', hoverStyle.radius);
      await expect(notification.locator('svg')).toHaveCSS('transform', 'none');
      await page.mouse.move(0, 100);
      await page.keyboard.press('Tab');
      await notification.focus();
      await expect(notification).toHaveCSS('outline-style', 'solid');
      await expect(notification).toHaveCSS('outline-width', '2px');
      await expect(notification).toHaveCSS('outline-offset', '-2px');
      await notification.click();
      await expect(notification).toHaveAttribute('aria-expanded', 'true');
      const activeStyle = await work.evaluate((element) => {
        const style = getComputedStyle(element);
        return { color: style.color, background: style.backgroundColor };
      });
      await page.mouse.move(0, 100);
      await expect(notification).toHaveCSS('color', activeStyle.color);
      await expect(notification).toHaveCSS('background-color', activeStyle.background);
      if (width === 390)
        await page.screenshot({ path: testInfo.outputPath('mobile-notification-open.png') });
      await notification.click();
      await expect(notification).toHaveAttribute('aria-expanded', 'false');
      const geometry = await Promise.all(
        [work, help].map((entry) =>
          entry.evaluate((element) => {
            const svg = element.querySelector<SVGSVGElement>('.el-icon > svg')!;
            const rect = svg.getBoundingClientRect();
            const shape = svg.getBBox();
            const icon = svg.parentElement!.getBoundingClientRect();
            return {
              paintedWidth: (shape.width / svg.viewBox.baseVal.width) * rect.width,
              paintedHeight: (shape.height / svg.viewBox.baseVal.height) * rect.height,
              iconCenterY: icon.top + icon.height / 2
            };
          })
        )
      );
      const visualSizes = geometry.map((icon) => Math.max(icon.paintedWidth, icon.paintedHeight));
      const ratio = visualSizes[1]! / visualSizes[0]!;
      expect(ratio).toBeGreaterThanOrEqual(0.9);
      expect(ratio).toBeLessThanOrEqual(1.1);
      expect(geometry[1]!.iconCenterY).toBe(geometry[0]!.iconCenterY);
      await expect(help.locator('.rail-label')).toBeHidden();
      if (width === 390)
        await page
          .getByTestId('workbench-brand')
          .screenshot({ path: testInfo.outputPath('mobile-help.png') });
    }
  });
}
