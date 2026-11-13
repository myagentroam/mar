import { expect, test, type Locator, type Route } from '@playwright/test';
import type { AgentEvent } from '../../mar-agent/src/index.js';
import { MarAgentConversationNormalizer } from '../../mar-node/src/runner/mar-agent/conversation-normalizer.js';
import {
  serializeComposerTag,
  COMPOSER_SKILL_INSTRUCTION
} from '../../packages/protocol/src/composer-tags.js';
import { verifyConversationThemes } from './support/conversation-visual.js';
import {
  emitMockSessionEvent,
  fulfillMockSessionWatch,
  mockConsoleApi,
  json
} from './support/web-console-api.js';

// Conversation rendering, history, and pagination
const syntheticAbsoluteFile = `${process.cwd()}/mar-web-console/src/App.vue`;

test('Assistant Markdown images use compact thumbnails and the conversation image preview', async ({
  page
}, testInfo) => {
  const longImageName = `External screenshot ${'long filename 中文 with spaces '.repeat(8)}.png`;
  const imageSizes = [
    { width: 1200, height: 900 },
    { width: 600, height: 1800 },
    { width: 2400, height: 200 }
  ];
  const imageSvg = ({ width, height }: { width: number; height: number }) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#4b80bd"/></svg>`;
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await page.route('**/api/agent-sessions/session-1/watch*', (route) =>
    fulfillMockSessionWatch(
      page,
      route,
      { id: 'session-1', workspaceId: 'workspace-1' },
      watchedConversation([
        {
          id: 'markdown-images:segment:0',
          turnId: 'markdown-images',
          index: 0,
          runId: null,
          status: 'SUCCEEDED',
          items: [
            {
              id: 'markdown-images-answer',
              kind: 'assistant_message',
              status: 'COMPLETED',
              payload: {
                text: `**Desktop**\n\n![Desktop screenshot](/tmp/desktop.png)\n\n**Mobile**\n\n![Mobile screenshot](output/mobile.png)\n\n![${longImageName}](https://images.example/screenshot.png)`
              }
            }
          ]
        }
      ])
    )
  );
  await page.route('**/api/workspaces/workspace-1/files/content?**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: imageSvg(
        new URL(route.request().url()).searchParams.get('path')?.endsWith('mobile.png')
          ? imageSizes[1]!
          : imageSizes[0]!
      )
    })
  );
  await page.route('https://images.example/screenshot.png', (route) =>
    route.fulfill({ contentType: 'image/svg+xml', body: imageSvg(imageSizes[2]!) })
  );
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.locator('.session-list .session-link').first().click();
  for (const { width, height, theme } of [
    { width: 1440, height: 1000, theme: 'vscode-dark-2026' },
    { width: 390, height: 844, theme: 'vscode-dark-2026' },
    { width: 320, height: 568, theme: 'daylight' },
    { width: 667, height: 375, theme: 'daylight' }
  ]) {
    await page.evaluate((value) => localStorage.setItem('mar.theme', value), theme);
    await page.setViewportSize({ width, height });
    await page.reload();
    const thumbnails = page.locator('.agent-markdown [data-image-preview]');
    await expect(thumbnails).toHaveCount(3);
    for (let index = 0; index < 3; index += 1) {
      const thumbnail = thumbnails.nth(index);
      const img = thumbnail.locator('img');
      await thumbnail.evaluate((element) =>
        element.scrollIntoView({ block: 'center', inline: 'nearest' })
      );
      await expect
        .poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth))
        .toBe(imageSizes[index]!.width);
      const bounds = await img.boundingBox();
      expect(bounds!.width).toBeLessThanOrEqual(160);
      expect(bounds!.height).toBeLessThanOrEqual(120);
      const source = await img.getAttribute('data-image-source');
      const name = await img.getAttribute('alt');
      if (index === 1) {
        await thumbnail.focus();
        await page.keyboard.press('Enter');
      } else await thumbnail.click();
      const dialog = page.getByRole('dialog', { name: name!, exact: true });
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('img')).toHaveAttribute('src', source!);
      const frame = dialog.locator('.attachment-preview-dialog');
      const expectedWidth = Math.min(960, width - 32);
      const expectedHeight = Math.min(760, height - 32);
      await expect
        .poll(() => frame.boundingBox())
        .toEqual({
          x: (width - expectedWidth) / 2,
          y: (height - expectedHeight) / 2,
          width: expectedWidth,
          height: expectedHeight
        });
      const title = dialog.locator('.el-dialog__title');
      await expect(title).toHaveCSS(
        'font-size',
        await title.evaluate((element) =>
          getComputedStyle(element).getPropertyValue('--mar-font-size-title').trim()
        )
      );
      await expect(title).toHaveAttribute('title', name!);
      await expect(title).toHaveCSS('text-overflow', 'ellipsis');
      await expect(dialog.locator('img')).toHaveCSS('object-fit', 'contain');
      await expect(dialog.locator('img')).toHaveCSS('object-position', '50% 50%');
      const layout = await frame.evaluate((element) => {
        const body = element.querySelector('.el-dialog__body')!.getBoundingClientRect();
        const image = element.querySelector('img')!.getBoundingClientRect();
        const close = element.querySelector('.el-dialog__headerbtn')!.getBoundingClientRect();
        const header = element.querySelector('.el-dialog__header')!.getBoundingClientRect();
        return {
          imageFillsBody:
            Math.abs(image.left - body.left) < 1 &&
            Math.abs(image.top - body.top) < 1 &&
            Math.abs(image.width - body.width) < 1 &&
            Math.abs(image.height - body.height) < 1,
          closeVisible:
            close.left >= 0 &&
            close.right <= innerWidth &&
            close.top >= 0 &&
            close.bottom <= innerHeight,
          headerAboveImage: header.bottom <= body.top,
          noOverflow: element.scrollHeight <= element.clientHeight
        };
      });
      expect(layout).toEqual({
        imageFillsBody: true,
        closeVisible: true,
        headerAboveImage: true,
        noOverflow: true
      });
      if (index === 1)
        await page.screenshot({ path: testInfo.outputPath(`image-preview-${width}.png`) });
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(thumbnail).toBeFocused();
    }
    await testInfo.attach(`markdown-images-${width}`, {
      body: await page.screenshot(),
      contentType: 'image/png'
    });
  }
});

test('Ctrl-click attachment previews do not navigate Workspace directories or show spurious errors', async ({
  page
}) => {
  await mockConsoleApi(
    page,
    'MANAGED',
    ['history.read', 'turn.start'],
    [],
    'GIT_WORKSPACE',
    true,
    undefined,
    undefined,
    '0.9.6',
    true
  );
  const path = 'mar-attachment://00000000-0000-4000-8000-000000000001/image.png';
  const invalidDirectoryRequests: string[] = [];
  let contentReads = 0;
  const context = page.context();
  await context.route('**/api/agent-sessions/session-1/watch*', (route) =>
    fulfillMockSessionWatch(
      page,
      route,
      { id: 'session-1', workspaceId: 'workspace-1' },
      watchedConversation([
        {
          id: 'attachment:segment:0',
          turnId: 'attachment',
          index: 0,
          runId: null,
          status: 'SUCCEEDED',
          items: [
            {
              id: 'attachment-user',
              kind: 'user_message',
              status: 'COMPLETED',
              payload: {
                text: serializeComposerTag('mar_attachments', {
                  files: [{ name: 'image.png', mime: 'image/png', path }]
                })
              }
            }
          ]
        }
      ])
    )
  );
  await context.route(/\/api\/workspaces\/workspace-1\/files(?:\?.*)?$/, (route) => {
    const directory = new URL(route.request().url()).searchParams.get('path') ?? '.';
    if (!directory.startsWith('mar-attachment:')) return route.fallback();
    invalidDirectoryRequests.push(directory);
    return json(route, { error: { code: 'FILE_NOT_FOUND', message: 'File was not found.' } }, 404);
  });
  await context.route(/\/api\/workspaces\/workspace-1\/files\/read(?:\?.*)?$/, (route) => {
    if (new URL(route.request().url()).searchParams.get('path') !== path) return route.fallback();
    return json(route, {
      file: { path, encoding: 'base64', size: 68, content: '', truncated: true, nextOffset: 1 }
    });
  });
  await context.route(/\/api\/workspaces\/workspace-1\/files\/content(?:\?.*)?$/, (route) => {
    if (new URL(route.request().url()).searchParams.get('path') !== path) return route.fallback();
    contentReads += 1;
    return route.fulfill({
      contentType: 'image/png',
      headers: { 'cache-control': 'private, no-store' },
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII=',
        'base64'
      )
    });
  });
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.locator('.session-list .session-link').first().click();
  const card = page.locator('.conversation-file-attachment');
  await expect(card.locator('img')).toBeVisible();
  await expect(card).toHaveText('');
  await expect(card).not.toHaveAttribute('title');
  for (const modifier of ['Control', 'Meta'] as const) {
    const popupPromise = page.waitForEvent('popup');
    await card.click({ modifiers: [modifier] });
    const popup = await popupPromise;
    await expect(popup).toHaveURL(/standaloneFile=1/);
    expect(new URL(popup.url()).searchParams.get('path')).toBe(path);
    const preview = popup.getByRole('dialog', { name: `${path} 文件预览` });
    await expect(preview).toBeVisible();
    await expect
      .poll(() => preview.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBe(1);
    await expect(popup.locator('.el-message').filter({ hasText: /FILE_NOT_FOUND/ })).toHaveCount(0);
    await expect(page.locator('.attachment-preview-dialog')).toHaveCount(0);
    await popup.close();
  }
  expect(contentReads).toBeGreaterThan(0);
  expect(invalidDirectoryRequests).toEqual([]);
});

for (const locale of ['zh-CN', 'en-US'] as const) {
  test(`Unified user tags hide resource input, preview attachments, and revalidate expired data ${locale}`, async ({
    page
  }, testInfo) => {
    const english = locale === 'en-US';
    await page.addInitScript((value) => localStorage.setItem('mar.locale.v2', value), locale);
    await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
    const fileName = 'Reference_20261010_185346_com.microsoft.emmx_笔记 with spaces.txt';
    const path = `mar-attachment://00000000-0000-4000-8000-000000000001/${fileName}`;
    const imageName = 'Screenshot_20261010_185346_com.microsoft.emmx_原图 with spaces.jpg';
    const resources = [
      serializeComposerTag('mar_skills', {
        action: 'use',
        instruction: COMPOSER_SKILL_INSTRUCTION,
        skills: [
          {
            name: 'hidden-skill',
            source: 'WORKSPACE',
            path: '.agents/skills/hidden-skill/SKILL.md'
          }
        ]
      }),
      serializeComposerTag('mar_references', {
        references: [{ type: 'file', path: 'hidden-reference.ts', label: 'hidden-reference.ts' }]
      })
    ].join('\n');
    const files = serializeComposerTag('mar_attachments', {
      files: [
        { name: fileName, mime: 'text/plain', path },
        {
          name: imageName,
          mime: 'image/jpeg',
          path: `mar-attachment://00000000-0000-4000-8000-000000000001/${imageName}`
        }
      ]
    });
    const items = [
      {
        id: 'goal-user',
        kind: 'user_message',
        status: 'COMPLETED',
        payload: {
          text: [
            serializeComposerTag('mar_goal_start', { objective: '检查目标' }),
            resources,
            files
          ].join('\n')
        }
      },
      {
        id: 'hidden-user',
        kind: 'user_message',
        status: 'COMPLETED',
        payload: { text: resources }
      },
      {
        id: 'continue-user',
        kind: 'user_message',
        status: 'COMPLETED',
        payload: { text: serializeComposerTag('mar_goal_continue', {}) }
      },
      { id: 'reply', kind: 'assistant_message', status: 'COMPLETED', payload: { text: '完成检查' } }
    ];
    await page.route('**/api/agent-sessions/session-1/watch*', (route) =>
      fulfillMockSessionWatch(
        page,
        route,
        { id: 'session-1', workspaceId: 'workspace-1' },
        watchedConversation([
          {
            id: 'tags:segment:0',
            turnId: 'tags',
            index: 0,
            runId: null,
            status: 'SUCCEEDED',
            items
          }
        ])
      )
    );
    let expired = false;
    let imageExpired = false;
    let imageVanishesDuringLoad = false;
    let thumbnailUnavailable = false;
    let imageReads = 0;
    const imagePath = `mar-attachment://00000000-0000-4000-8000-000000000001/${imageName}`;
    let reads = 0;
    await page.route(/\/api\/workspaces\/workspace-1\/files\/read(?:\?.*)?$/, (route) => {
      if (new URL(route.request().url()).searchParams.get('path') === imagePath) {
        imageReads += 1;
        if (imageExpired)
          return json(route, { error: { code: 'FILE_NOT_FOUND', message: 'File not found' } }, 404);
        return json(route, {
          file: {
            path: imagePath,
            encoding: 'base64',
            size: 68,
            content: '',
            truncated: true,
            nextOffset: 1
          }
        });
      }
      if (new URL(route.request().url()).searchParams.get('path') !== path) return route.fallback();
      reads += 1;
      if (expired)
        return json(route, { error: { code: 'FILE_NOT_FOUND', message: 'File not found' } }, 404);
      return json(route, {
        file: {
          path,
          encoding: 'utf-8',
          size: 19,
          content: 'Retained attachment',
          truncated: false,
          nextOffset: null
        }
      });
    });
    await page.route(/\/api\/workspaces\/workspace-1\/files\/content(?:\?.*)?$/, (route) => {
      if (new URL(route.request().url()).searchParams.get('path') !== imagePath)
        return route.fallback();
      if (thumbnailUnavailable)
        return json(route, { error: { code: 'FILE_NOT_FOUND', message: 'File not found' } }, 404);
      if (imageVanishesDuringLoad) {
        imageExpired = true;
        return json(route, { error: { code: 'FILE_NOT_FOUND', message: 'File not found' } }, 404);
      }
      return route.fulfill({
        contentType: 'image/svg+xml',
        headers: { 'cache-control': 'private, no-store' },
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#59758d" /></svg>'
      });
    });
    await page.goto('/console');
    await page.getByRole('button', { name: english ? 'Open console' : '进入控制台' }).click();
    await page.getByRole('button', { name: english ? 'Work' : '工作', exact: true }).click();
    await page
      .locator('.workspace-tree')
      .getByRole('button', { name: /node-1/ })
      .click();
    await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
    await page.locator('.session-list .session-link').first().click();
    await expect(page.locator('.conversation-item.user_message')).toHaveCount(2);
    await expect(page.locator('.conversation-item.user_message').first()).toContainText(
      english ? 'Goal started' : '目标开始'
    );
    await expect(page.locator('.conversation-item.user_message').last()).toContainText(
      english ? 'Goal continued' : '目标继续'
    );
    await expect(page.locator('.conversation-file-attachment')).toHaveCount(2);
    const imageFile = page.locator('.conversation-file-attachment').last();
    await expect(imageFile).toHaveText('');
    await expect(imageFile).not.toHaveAttribute('title');
    await expect(imageFile.locator('.conversation-file-name')).toHaveCount(0);
    await expect(imageFile.locator('img')).toHaveAttribute(
      'alt',
      english ? 'Image attachment' : '图片附件'
    );
    await expect
      .poll(() =>
        imageFile.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth)
      )
      .toBe(320);
    await page.setViewportSize({ width: 390, height: 844 });
    const thumbnail = await imageFile.locator('img').boundingBox();
    expect(thumbnail).not.toBeNull();
    expect(thumbnail!.width).toBeLessThanOrEqual(160);
    expect(thumbnail!.height).toBeLessThanOrEqual(120);
    expect(thumbnail!.width / thumbnail!.height).toBeCloseTo(320 / 180, 1);
    const filename = page
      .locator('.conversation-file-attachment')
      .first()
      .locator('.conversation-file-name');
    await expect(filename).toHaveCSS('white-space', 'nowrap');
    await expect(filename).toHaveCSS('text-overflow', 'ellipsis');
    await expect(filename).toHaveCSS('overflow', 'hidden');
    const layout = await filename.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const button = element.closest('button')!;
      return {
        lines: new Set(Array.from(range.getClientRects(), (rect) => rect.top)).size,
        clipped: element.scrollWidth > element.clientWidth,
        buttonWidth: button.getBoundingClientRect().width,
        buttonHeight: button.getBoundingClientRect().height,
        containerWidth: button.parentElement!.getBoundingClientRect().width,
        iconWidth: button.querySelector('.file-type-icon')?.getBoundingClientRect().width
      };
    });
    expect(layout.lines).toBe(1);
    expect(layout.clipped).toBe(true);
    expect(layout.buttonWidth).toBeLessThanOrEqual(layout.containerWidth + 1);
    expect(layout.buttonHeight).toBeLessThan(48);
    expect(layout.iconWidth).toBeGreaterThanOrEqual(14);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(page.locator('.conversation-user-image-attachments')).toHaveCount(0);
    await expect(page.locator('.conversation-timeline')).not.toContainText('hidden-skill');
    await expect(page.locator('.conversation-timeline')).not.toContainText('mar_references');
    for (const dark of [false, true]) {
      await page.evaluate((enabled) => {
        document.documentElement.classList.toggle('dark', enabled);
        if (enabled) document.documentElement.dataset.theme = 'vscode-dark-2026';
        else delete document.documentElement.dataset.theme;
      }, dark);
      const card = page.locator('.conversation-item.user_message').first();
      const colors = await card.evaluate((element) => {
        const style = getComputedStyle(element);
        const sample = document.createElement('canvas').getContext('2d')!;
        const rgb = (color: string) => {
          sample.clearRect(0, 0, 1, 1);
          sample.fillStyle = color;
          sample.fillRect(0, 0, 1, 1);
          return Array.from(sample.getImageData(0, 0, 1, 1).data).slice(0, 3);
        };
        const distance = (left: number[], right: number[]) =>
          Math.hypot(...left.map((value, index) => value - right[index]!));
        const border = rgb(style.borderTopColor);
        const neutral = rgb(style.getPropertyValue('--mar-conversation-border'));
        const brandBorder = rgb(style.getPropertyValue('--mar-color-brand-border'));
        return {
          borderDistance: distance(border, neutral),
          oldBorderDistance: distance(brandBorder, neutral),
          surfaceDistance: distance(
            rgb(style.backgroundColor),
            rgb(style.getPropertyValue('--mar-conversation-surface'))
          ),
          titleColor: rgb(getComputedStyle(element.querySelector('strong')!).color),
          mutedColor: rgb(style.getPropertyValue('--mar-conversation-muted').trim())
        };
      });
      expect(colors.borderDistance).toBeLessThan(colors.oldBorderDistance);
      expect(colors.surfaceDistance).toBeLessThan(30);
      expect(colors.titleColor).toEqual(colors.mutedColor);
      await page.screenshot({
        path: testInfo.outputPath(`attachment-${dark ? 'dark' : 'light'}.png`)
      });
    }
    await page.evaluate(() => {
      document.documentElement.classList.remove('dark');
      delete document.documentElement.dataset.theme;
    });
    thumbnailUnavailable = true;
    await imageFile.locator('img').evaluate((image: HTMLImageElement) => {
      image.src += '&thumbnailFailure=1';
    });
    await expect(imageFile.locator('.conversation-image-fallback')).toBeVisible();
    await expect(imageFile).toHaveText('');
    await expect(imageFile).not.toHaveAttribute('title');
    await expect(page.locator('.el-message')).toHaveCount(0);
    expect(imageReads).toBe(0);
    thumbnailUnavailable = false;
    await imageFile.click();
    const dialog = page.locator('.attachment-preview-dialog').filter({ has: page.locator('img') });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('img')).toHaveAttribute('alt', imageName);
    await expect
      .poll(() => dialog.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBeGreaterThan(0);
    expect(imageReads).toBe(1);
    await dialog.locator('.el-dialog__headerbtn').click();
    await expect(dialog).not.toBeVisible();
    imageExpired = true;
    await imageFile.click();
    await expect(
      page
        .locator('.el-message')
        .filter({ hasText: english ? 'File has expired' : '文件已过期' })
        .last()
    ).toBeVisible();
    await expect(dialog).not.toBeVisible();
    expect(imageReads).toBe(2);
    imageExpired = false;
    imageVanishesDuringLoad = true;
    await imageFile.click();
    await expect.poll(() => imageReads).toBe(4);
    await expect(dialog).not.toBeVisible();
    await emitMockSessionEvent(page, 'queue', {
      sessionId: 'session-1',
      queue: {
        version: 1,
        paused: false,
        items: [
          {
            queueItemId: 'queued-text-files',
            sessionId: 'session-1',
            workspaceId: 'workspace-1',
            runner: 'codex',
            clientMessageId: 'queue-files-message',
            content: `Queued body\n${files}`,
            createdAt: 1
          },
          {
            queueItemId: 'queued-files-only',
            sessionId: 'session-1',
            workspaceId: 'workspace-1',
            runner: 'codex',
            clientMessageId: 'queue-only-message',
            content: files,
            createdAt: 2
          }
        ]
      }
    });
    const queue = page.locator('.composer-queue');
    await expect(queue.locator('.queue-item')).toHaveCount(2);
    await expect(queue).toContainText('Queued body');
    await expect(queue.locator('.conversation-file-attachment')).toHaveCount(0);
    await expect(queue).not.toContainText(imageName);
    await expect(queue).not.toContainText('mar_attachments');
    const file = page.getByRole('button', {
      name: english ? `Preview file: ${fileName}` : `预览文件：${fileName}`
    });
    await file.click();
    await expect(
      page.locator('.cm-content').filter({ hasText: 'Retained attachment' })
    ).toBeVisible();
    const before = reads;
    expired = true;
    // Keep the preview tab mounted to exercise the cached-tab revalidation boundary.
    await file.dispatchEvent('click');
    await expect.poll(() => reads).toBeGreaterThan(before);
    await expect(page.getByText(/FILE_NOT_FOUND/).first()).toBeVisible();
    await expect(
      page
        .locator('.el-message')
        .filter({ hasText: english ? 'File has expired' : '文件已过期' })
        .last()
    ).toBeVisible();
    await expect(page.locator('.conversation-file-attachment')).toHaveCount(2);
  });
}

for (const language of ['zh-CN', 'en-US'] as const) {
  test(`ChatGPT quota errors show the usage settings URL as plain text and preserve diagnostics ${language}`, async ({
    page
  }) => {
    await page.addInitScript((locale) => localStorage.setItem('mar.locale.v2', locale), language);
    await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
    const codes = ['subscription_sharing_usage_limit_exceeded', 'rate_limit_error'];
    await page.route('**/api/agent-sessions/session-1/watch*', (route) =>
      fulfillMockSessionWatch(
        page,
        route,
        { id: 'session-1', workspaceId: 'workspace-1' },
        watchedConversation([
          {
            id: 'usage-errors:segment:0',
            turnId: 'usage-errors',
            index: 0,
            runId: 'run-usage-errors',
            status: 'FAILED',
            items: codes.map((code, index) => ({
              id: `usage-error-${index}`,
              kind: 'error',
              status: 'FAILED',
              payload: { code, httpStatus: 429, message: 'Original upstream diagnostic.' }
            }))
          }
        ])
      )
    );
    const english = language === 'en-US';
    await page.goto('/console');
    await page.getByRole('button', { name: english ? 'Open console' : '进入控制台' }).click();
    await page.getByRole('button', { name: english ? 'Work' : '工作', exact: true }).click();
    await page
      .locator('.workspace-tree')
      .getByRole('button', { name: /node-1/ })
      .click();
    await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
    await page.locator('.session-list .session-link').first().click();
    const cards = page.locator('.conversation-error-card');
    await expect(cards).toHaveCount(2);
    const limited = cards.first();
    await expect(limited).toContainText(
      english
        ? 'Your ChatGPT plan or this app has reached a usage limit.'
        : 'ChatGPT 套餐或本应用的用量已达限制。'
    );
    await expect(limited).toContainText(codes[0]!);
    await expect(limited).toContainText('HTTP 429');
    await expect(limited).toContainText('Original upstream diagnostic.');
    await expect(limited.locator('.conversation-error-message')).toContainText(
      english
        ? 'Open https://chatgpt.com/settings/usage'
        : '请打开 https://chatgpt.com/settings/usage'
    );
    await expect(cards.locator('a, button')).toHaveCount(0);
    await expect(cards.last()).not.toContainText('https://chatgpt.com/settings/usage');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(limited.locator('.conversation-error-message')).toBeVisible();
  });
}

test('History loading failures keep multiline errors readable with diagnostics', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await page.route('**/api/agent-sessions/session-1/watch*', (route) =>
    json(
      route,
      {
        error: {
          code: 'NODE_OFFLINE',
          message: 'The Node is offline. Confirm that the Node service is running.',
          requestId: 'req-multiline-message'
        }
      },
      503
    )
  );
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.locator('.session-list .session-link').first().click();

  const content = page.locator('.el-message__content').filter({ hasText: 'req-multiline-message' });
  await expect(content).toContainText('NODE_OFFLINE');
  await expect(content).toContainText('req-multiline-message');
  const layout = await content.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      lineHeightRatio: Number.parseFloat(style.lineHeight) / Number.parseFloat(style.fontSize),
      lineCount: element.clientHeight / Number.parseFloat(style.lineHeight),
      whiteSpace: style.whiteSpace
    };
  });
  expect(layout.whiteSpace).toBe('pre-line');
  expect(layout.lineHeightRatio).toBeCloseTo(1.5);
  expect(layout.lineCount).toBeGreaterThanOrEqual(3);
});

test('Approval cards emphasize pending states and use neutral terminal states in both themes', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  const states = ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'] as const;
  await page.route('**/api/agent-sessions/session-1/watch*', (route) =>
    fulfillMockSessionWatch(
      page,
      route,
      { id: 'session-1', workspaceId: 'workspace-1' },
      watchedConversation([
        {
          id: 'approval-visual:segment:0',
          turnId: 'approval-visual',
          index: 0,
          runId: 'run-approval-visual',
          status: 'RUNNING',
          items: states.map((status) => ({
            id: `approval-${status}`,
            kind: 'approval_request',
            status: status === 'PENDING' ? 'PENDING' : 'COMPLETED',
            payload: {
              approvalId: `approval-${status}`,
              approvalStatus: status,
              approval: {
                toolName: 'Bash',
                reason: 'Confirm the captured target.',
                input: { command: 'pwd', cwd: '/fixture' }
              },
              expiresAt: 0
            }
          }))
        }
      ])
    )
  );
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.locator('.session-list .session-link').first().click();
  const cards = page.locator('.conversation-item.approval_request');
  await expect(cards).toHaveCount(states.length);
  await expect(cards.first()).toContainText('Confirm the captured target.');
  await expect(cards.first()).toContainText('/fixture');
  for (const dark of [false, true]) {
    await page.evaluate((enabled) => {
      document.documentElement.classList.toggle('dark', enabled);
      if (enabled) document.documentElement.dataset.theme = 'vscode-dark-2026';
      else delete document.documentElement.dataset.theme;
    }, dark);
    await expect(cards.first()).toHaveCSS(
      'border-left-color',
      dark ? 'rgb(227, 179, 65)' : 'rgb(242, 176, 30)'
    );
    for (let index = 1; index < states.length; index += 1) {
      await expect(cards.nth(index)).toHaveCSS(
        'border-left-color',
        dark ? 'rgb(32, 42, 57)' : 'rgb(229, 234, 240)'
      );
      await expect(cards.nth(index).locator('.conversation-card-actions')).toHaveCount(0);
    }
  }
  let submitted: unknown;
  await page.route(
    '**/api/agent-runs/run-approval-visual/approvals/approval-PENDING/decision',
    async (route) => {
      submitted = route.request().postDataJSON();
      await json(route, {});
    }
  );
  const response = page.waitForResponse((entry) =>
    entry.url().endsWith('/approval-PENDING/decision')
  );
  await cards.first().getByRole('button', { name: '允许', exact: true }).click();
  await response;
  expect(submitted).toEqual({ nodeId: 'node-1', decision: 'APPROVED' });
});

for (const hasTouch of [false, true]) {
  test.describe(hasTouch ? 'Touch disclosures' : 'Pointer disclosures', () => {
    test.use({ hasTouch });
    test('Conversation cards preserve text hierarchy, monospace process cards, and mobile actions across themes', async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
      await page.route('**/api/agent-sessions/session-1/watch*', (route) =>
        fulfillMockSessionWatch(
          page,
          route,
          { id: 'session-1', workspaceId: 'workspace-1' },
          watchedConversation([
            {
              id: 'visual:segment:0',
              turnId: 'visual',
              index: 0,
              runId: null,
              status: 'SUCCEEDED',
              items: [
                {
                  id: 'visual-user',
                  kind: 'user_message',
                  status: 'COMPLETED',
                  payload: { text: '检查会话卡片 / Review conversation cards' }
                },
                {
                  id: 'visual-reasoning',
                  kind: 'reasoning',
                  processGroup: { id: 'visual-process', isStart: true },
                  status: 'COMPLETED',
                  payload: {
                    representation: 'summary',
                    sections: [{ index: 0, text: '检查正文、过程和操作层级。' }]
                  }
                },
                {
                  id: 'visual-command',
                  processGroup: { id: 'visual-process' },
                  kind: 'command_execution',
                  status: 'COMPLETED',
                  payload: { command: 'git status', exitCode: 0 }
                },
                {
                  id: 'visual-tool',
                  processGroup: { id: 'visual-process' },
                  kind: 'tool_call',
                  status: 'COMPLETED',
                  payload: { toolName: 'read', input: { path: 'src/main.ts' } }
                },
                {
                  id: 'visual-file-change',
                  processGroup: { id: 'visual-process' },
                  kind: 'file_change',
                  status: 'COMPLETED',
                  payload: {
                    changes: [
                      {
                        path: 'my-agent-roam/packages/web-core/src/view/workspace/WorkspaceFileTree.vue',
                        change: 'MODIFIED',
                        additions: 6,
                        deletions: 1
                      }
                    ]
                  }
                },
                {
                  id: 'visual-answer',
                  kind: 'assistant_message',
                  status: 'COMPLETED',
                  payload: {
                    text: '## 检查结果 / Review results\n\n已完成 `theme tokens` 检查。正文优先，过程保持紧凑。\n\n- 浅色与深色使用一致布局\n- Links remain interactive: [Documentation](https://example.com)\n\n```ts\nconst theme = "daylight";\n```'
                  }
                }
              ]
            }
          ])
        )
      );
      await page.goto('/console');
      await page.getByRole('button', { name: '进入控制台' }).click();
      await page.getByRole('button', { name: '工作', exact: true }).click();
      await page
        .locator('.workspace-tree')
        .getByRole('button', { name: /node-1/ })
        .click();
      await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
      await page.locator('.session-list .session-link').first().click();
      await expect(page.locator('.conversation-process.is-group .process-content')).toHaveCount(0);
      await page.locator('.conversation-process.is-group .process-heading').first().click();
      const reasoning = page.locator('.conversation-item.reasoning-group details');
      await expect(reasoning).not.toHaveAttribute('open', '');
      await expect(reasoning.locator('summary > strong')).toHaveText('思考');
      await reasoning.locator('summary').click();
      await expect(reasoning).toHaveAttribute('open', '');
      await expect(reasoning.locator('p')).toContainText('检查正文、过程和操作层级。');
      await reasoning.locator('summary').click();
      await expect(reasoning).not.toHaveAttribute('open', '');
      const process = page.locator('.conversation-process.is-group').first();
      const verifyProcessSpacing = async (mobile: boolean) => {
        await expect(page.locator('.conversation-item.user_message').first()).toHaveCSS(
          'padding-top',
          '12px'
        );
        await expect(page.locator('.conversation-item.user_message').first()).toHaveCSS(
          'padding-left',
          '14px'
        );
        await expect(process.locator('.process-content')).toHaveCSS('gap', '4px');
        await expect(process.locator('.process-content')).toHaveCSS(
          'padding-left',
          mobile ? '4px' : '8px'
        );
        await expect(process.locator('.process-heading')).toHaveCSS('padding-top', '4px');
        await expect(process.locator('.process-heading')).toHaveCSS(
          'padding-left',
          mobile ? '8px' : '12px'
        );
        const row = reasoning.locator('summary');
        await expect(row).toHaveCSS('padding-top', '4px');
        await expect(row).toHaveCSS('padding-bottom', '4px');
        await expect(row).toHaveCSS('padding-left', mobile ? '8px' : '12px');
        await expect(row).toHaveCSS('min-height', '0px');
        await process.locator('.process-heading').click();
        await expect(process.locator('.process-heading')).toHaveAttribute('aria-expanded', 'false');
        await expect
          .poll(() =>
            process
              .locator('.process-body')
              .evaluate((element) => element.getBoundingClientRect().height)
          )
          .toBe(0);
        await expect(process.locator('.process-content')).toHaveCount(0);
        await process.locator('.process-heading').click();
        await expect(process.locator('.process-heading')).toHaveAttribute('aria-expanded', 'true');
      };
      await verifyProcessSpacing(false);
      await verifyConversationThemes(page, testInfo, 'workspace-desktop');
      await page.setViewportSize({ width: 390, height: 844 });
      await verifyProcessSpacing(true);
      await verifyConversationThemes(page, testInfo, 'workspace-mobile');
      await page.evaluate(() => localStorage.setItem('mar.locale.v2', 'en-US'));
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
      await page.locator('.conversation-process.is-group .process-heading').first().click();
      await expect(page.locator('.conversation-item.reasoning-group summary')).toContainText(
        'Reasoning'
      );
      await expect(page.locator('.conversation-item.reasoning-group details')).not.toHaveAttribute(
        'open',
        ''
      );
      await verifyConversationThemes(page, testInfo, 'workspace-mobile-en');
    });
  });
}

for (const locale of ['zh-CN', 'en-US'] as const) {
  test(`Read projections aggregate within a work process with accessible details (${locale})`, async ({
    page
  }, testInfo) => {
    await page.addInitScript((value) => localStorage.setItem('mar.locale.v2', value), locale);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
    const normalizer = new MarAgentConversationNormalizer();
    const reads = ['src/first.ts', '目录/second.ts'].map((path, index) => {
      const base = {
        eventId: `event-${index}`,
        sequence: index,
        timestamp: '2026-10-23T00:00:00.000Z',
        sessionId: 'session-1',
        executionId: 'execution',
        turnId: 'read-turn',
        callId: `read-${index}`,
        toolName: 'read',
        parentCallId: 'cell'
      };
      normalizer.normalize({
        ...base,
        type: 'tool.started',
        input: {
          reads:
            index === 0
              ? [
                  { path, offset: 1, limit: 20 },
                  { path, offset: 90, limit: 10 },
                  { path: 'test/first.ts' }
                ]
              : [{ path }]
        }
      } as AgentEvent);
      const [result] = normalizer.normalize({
        ...base,
        type: 'tool.completed',
        summary: `Content for ${path}`
      } as AgentEvent);
      return {
        id: result!.itemId,
        kind: result!.kind,
        status: result!.status,
        payload: result!.payload
      };
    });
    const items = [
      {
        id: 'thinking-a',
        kind: 'reasoning',
        status: 'COMPLETED',
        payload: { representation: 'visible_thinking', sections: [{ text: 'Inspect files' }] }
      },
      reads[0]!,
      {
        id: 'skill-a',
        kind: 'tool_call',
        status: 'COMPLETED',
        payload: {
          toolName: 'skill',
          toolPresentation: { kind: 'SKILL', name: 'first-skill' }
        }
      },
      {
        id: 'command-a',
        kind: 'command_execution',
        status: 'COMPLETED',
        parentItemId: null,
        payload: {
          command:
            'node -e "console.log(\'Long command preview with enough arguments to wrap across several lines on a mobile viewport without returning to the disclosure arrow\')"',
          outputPreview: 'first',
          durationMs: 1500
        }
      },
      reads[1]!,
      {
        id: 'skill-b',
        kind: 'tool_call',
        status: 'COMPLETED',
        payload: {
          toolName: 'skill',
          toolPresentation: { kind: 'SKILL', name: 'second-skill' }
        }
      },
      {
        id: 'thinking-b',
        kind: 'reasoning',
        status: 'COMPLETED',
        payload: { representation: 'visible_thinking', sections: [{ text: 'Verify files' }] }
      },
      {
        id: 'command-b',
        kind: 'command_execution',
        status: 'FAILED',
        payload: { command: 'echo second', outputPreview: 'second', exitCode: 1 }
      }
    ].map((item, index) => ({
      ...item,
      startedAt: 1000 + index * 1000,
      completedAt: 1500 + index * 1000,
      processGroup: { id: 'read-process', ...(index === 0 ? { isStart: true } : {}) }
    }));
    await page.route('**/api/agent-sessions/session-1/watch*', (route) =>
      fulfillMockSessionWatch(
        page,
        route,
        { id: 'session-1', workspaceId: 'workspace-1' },
        watchedConversation([
          {
            id: 'read-turn:segment:0',
            turnId: 'read-turn',
            index: 0,
            runId: null,
            status: 'SUCCEEDED',
            items: items.filter((item) => item.id !== reads[1]!.id)
          }
        ])
      )
    );
    await page.goto('/console');
    await page
      .getByRole('button', { name: locale === 'zh-CN' ? '进入控制台' : 'Open console' })
      .click();
    await page
      .getByRole('button', { name: locale === 'zh-CN' ? '工作' : 'Work', exact: true })
      .click();
    await page
      .locator('.workspace-tree')
      .getByRole('button', { name: /node-1/ })
      .click();
    await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
    await page.locator('.session-list .session-link').first().click();
    const process = page.locator('.conversation-process.is-group');
    await expect(process.locator('.process-heading')).toContainText(
      locale === 'zh-CN' ? '已完成' : 'Completed'
    );
    await expect(process.locator('.process-heading')).not.toContainText(
      locale === 'zh-CN' ? '查看记录' : 'View details'
    );
    await process.locator('.process-heading').click();
    await expect(process.locator('.reasoning-group')).toHaveCount(1);
    await expect(process.locator('.command-group')).toHaveCount(1);
    await expect(process.locator('[data-tool-presentation="SKILL"]')).toHaveCount(2);
    await expect(
      process.locator('[data-tool-presentation="SKILL"] summary > .conversation-record-preview')
    ).toHaveText(['first-skill', 'second-skill']);
    await expect(process.locator('.process-activity + .process-duration')).toHaveText(
      locale === 'zh-CN' ? '· 耗时 7s' : '· Duration 7s'
    );
    await process.locator('.command-group > details > summary').click();
    const command = process.locator('.conversation-command-detail').first();
    await expect(command.locator('summary > strong')).toHaveCount(0);
    await expect(command.locator('summary .conversation-record-icon')).toHaveCount(0);
    await expect(command.locator('.conversation-command-preview')).toContainText('node -e');
    await expect(
      command.locator('.conversation-command-status + .conversation-step-duration')
    ).toContainText('1');
    await expect(command.locator('summary')).toHaveCSS('list-style-type', 'none');
    await expect(process.locator('.process-activity')).toHaveCSS(
      'font-size',
      await command.locator('summary').evaluate((el) => getComputedStyle(el).fontSize)
    );
    expect(
      await command.locator('summary').evaluate((el) => getComputedStyle(el, '::before').maskImage)
    ).not.toBe('none');
    const read = process.locator('[data-tool-presentation="READ"]');
    await expect(read).toHaveCount(1);
    await expect(read.locator(':scope > summary')).toContainText(
      locale === 'zh-CN' ? '1 次调用' : '1 call'
    );
    await expect(read).not.toHaveAttribute('open', '');
    await expect(read.locator('.conversation-tool-detail')).toHaveCount(0);
    await expect(process.locator('.process-content > article').last()).toHaveClass(/command-group/);
    await read.evaluate((element) => {
      element.setAttribute('data-stable-group', 'initial');
    });
    await read.locator(':scope > summary').click();
    await read.locator('.conversation-tool-detail > summary').click();
    await expect(read.locator('.conversation-tool-detail p')).toContainText(
      'Content for src/first.ts'
    );
    await emitMockSessionEvent(page, 'conversation', {
      sessionId: 'session-1',
      turn: {
        id: 'read-turn',
        sessionId: 'session-1',
        runId: null,
        status: 'SUCCEEDED',
        items: []
      },
      segments: (
        watchedConversation([
          {
            id: 'read-turn:segment:0',
            turnId: 'read-turn',
            index: 0,
            runId: null,
            status: 'SUCCEEDED',
            items
          }
        ]).conversation as { segments: Record<string, unknown>[] }
      ).segments
    });
    await expect(read).toHaveAttribute('open', '');
    await expect(read).toHaveAttribute('data-stable-group', 'initial');
    await expect(read.locator('.conversation-tool-detail').first().locator('p')).toContainText(
      'Content for src/first.ts'
    );
    await expect(read.locator(':scope > summary > strong')).toHaveText(
      locale === 'zh-CN' ? '读取文件' : 'Read'
    );
    await expect(read.locator(':scope > summary')).toContainText(
      locale === 'zh-CN' ? '2 次调用' : '2 calls'
    );
    await expect(process.locator('.command-group > details > summary')).not.toContainText(
      locale === 'zh-CN' ? '失败' : 'Failed'
    );
    await expect(process.locator('.conversation-command-status').last()).toHaveText(
      locale === 'zh-CN' ? '失败' : 'Failed'
    );
    await read.locator(':scope > summary').focus();
    await page.keyboard.press('Enter');
    await expect(read).not.toHaveAttribute('open', '');
    await emitMockSessionEvent(page, 'conversation', {
      sessionId: 'session-1',
      turn: {
        id: 'read-turn',
        sessionId: 'session-1',
        runId: null,
        status: 'SUCCEEDED',
        items: []
      },
      segments: (
        watchedConversation([
          {
            id: 'read-turn:segment:0',
            turnId: 'read-turn',
            index: 0,
            runId: null,
            status: 'SUCCEEDED',
            items: [
              ...items,
              {
                ...reads[1],
                id: 'read-third',
                startedAt: 9000,
                completedAt: 10000,
                processGroup: { id: 'read-process' }
              }
            ]
          }
        ]).conversation as { segments: Record<string, unknown>[] }
      ).segments
    });
    await expect(read.locator(':scope > summary')).toContainText(
      locale === 'zh-CN' ? '3 次调用' : '3 calls'
    );
    await expect(
      process.locator('.process-content > article').last().locator(':scope > details')
    ).toHaveAttribute('data-tool-presentation', 'READ');
    await expect(read).toHaveAttribute('data-stable-group', 'initial');
    await expect(read).not.toHaveAttribute('open', '');
    await page.keyboard.press('Enter');
    await expect(read).toHaveAttribute('open', '');
    await expect(read.locator('.conversation-tool-detail')).toHaveCount(3);
    await expect(read.locator('.conversation-tool-detail > summary > strong')).toHaveCount(0);
    await expect(read.locator('.conversation-tool-preview').first()).toHaveText(
      locale === 'zh-CN' ? 'first.ts · 另 1 个文件' : 'first.ts · 1 more file'
    );
    await expect(read.locator('.conversation-tool-detail').first()).toContainText('test/first.ts');
    await expect(read.locator('.conversation-tool-detail').first()).toContainText('"offset":90');
    await expect(read.locator('.conversation-tool-detail').first()).toContainText(
      'Content for src/first.ts'
    );
    await process.locator('.process-heading').click();
    await expect(process.locator('.process-content')).toHaveCount(0);
    await process.locator('.process-heading').click();
    await expect(read).toHaveAttribute('open', '');
    await expect(read.locator('.conversation-tool-detail')).toHaveCount(3);
    await expect(read.locator('.conversation-tool-detail').first()).toContainText(
      'Content for src/first.ts'
    );
    // Reopen before the leave transition finishes: do not duplicate or lose the subtree.
    await process.locator('.process-heading').evaluate(async (heading) => {
      for (let index = 0; index < 4; index += 1) {
        (heading as HTMLButtonElement).click();
        await new Promise(requestAnimationFrame);
      }
    });
    await expect(process.locator('.process-content')).toHaveCount(1);
    await expect(read).toHaveAttribute('open', '');
    await expect(read.locator('.conversation-tool-detail')).toHaveCount(3);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const dark of [false, true]) {
        await page.evaluate((enabled) => {
          document.documentElement.classList.toggle('dark', enabled);
          if (enabled) document.documentElement.dataset.theme = 'vscode-dark-2026';
          else delete document.documentElement.dataset.theme;
        }, dark);
        const icon = read.locator(':scope > summary .conversation-record-icon');
        await expect(icon).toBeVisible();
        await expect(read).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await expect(read.locator(':scope > summary')).toHaveCSS('display', 'flex');
        const headingLayout = await process
          .locator('.conversation-record-heading')
          .evaluateAll((elements) =>
            elements.map((element) => ({
              titleLeft: element.querySelector('strong')!.getBoundingClientRect().left,
              iconLeft: element.querySelector('svg')!.getBoundingClientRect().left,
              titleCenter:
                element.querySelector('strong')!.getBoundingClientRect().top +
                element.querySelector('strong')!.getBoundingClientRect().height / 2,
              iconCenter:
                element.querySelector('svg')!.getBoundingClientRect().top +
                element.querySelector('svg')!.getBoundingClientRect().height / 2,
              alignment: getComputedStyle(element).alignItems,
              width: element.clientWidth,
              contentWidth: element.scrollWidth
            }))
          );
        for (const heading of headingLayout) {
          expect(Math.abs(heading.titleLeft - headingLayout[0]!.titleLeft)).toBeLessThan(1);
          expect(Math.abs(heading.iconLeft - headingLayout[0]!.iconLeft)).toBeLessThan(1);
          expect(Math.abs(heading.iconCenter - heading.titleCenter)).toBeLessThan(1);
          expect(heading.alignment).toBe('center');
          expect(heading.contentWidth).toBeLessThanOrEqual(heading.width + 1);
        }
        if ((await command.getAttribute('open')) === null) {
          await expect(command.locator('.conversation-command-preview')).toHaveCSS(
            'white-space',
            'nowrap'
          );
          await command.locator('summary').click();
        }
        await expect(command.locator('.conversation-command-output')).toBeVisible();
        await expect
          .poll(() => command.evaluate((element) => element.getAnimations().length))
          .toBe(0);
        const commandLayout = await process.locator('.command-group').evaluate((group) => {
          const parent = group.querySelector(':scope > details > summary')!;
          const summary = group.querySelector('.conversation-command-detail > summary')!;
          const preview = summary.querySelector('.conversation-command-preview')!;
          const range = document.createRange();
          range.selectNodeContents(preview);
          return {
            indent: summary.getBoundingClientRect().left - parent.getBoundingClientRect().left,
            parentGrid: getComputedStyle(parent).gridTemplateColumns,
            childGrid: getComputedStyle(summary).gridTemplateColumns,
            childAlignment: getComputedStyle(summary).alignItems,
            parentHeight: parent.getBoundingClientRect().height,
            childHeight: summary.getBoundingClientRect().height,
            parentPadding: getComputedStyle(parent).padding,
            childPadding: getComputedStyle(summary).padding,
            childMargin: getComputedStyle(summary.parentElement!).marginLeft,
            textLeft: preview.getBoundingClientRect().left,
            textRects: Array.from(range.getClientRects(), (rect) => ({
              left: rect.left,
              top: rect.top
            }))
          };
        });
        const indentStep = await page.evaluate(
          () => Number.parseFloat(getComputedStyle(document.documentElement).fontSize) / 2
        );
        expect(commandLayout.indent, JSON.stringify(commandLayout)).toBeCloseTo(indentStep, 1);
        expect(commandLayout.textRects.length).toBeGreaterThan(0);
        await expect(command.locator('.conversation-command-preview')).toHaveCSS(
          'white-space',
          'nowrap'
        );
        expect(commandLayout.childAlignment).toBe('center');
        expect(commandLayout.childHeight).toBeCloseTo(commandLayout.parentHeight, 1);
        expect(commandLayout.childPadding).toBe(commandLayout.parentPadding);
        for (const rect of commandLayout.textRects) {
          expect(Math.abs(rect.top - commandLayout.textRects[0]!.top)).toBeLessThanOrEqual(1);
          expect(rect.left).toBeGreaterThanOrEqual(commandLayout.textLeft - 1);
        }
        await expect(icon).toHaveAttribute('fill', 'none');
        await expect(icon).toHaveAttribute('aria-hidden', 'true');
        if ((await command.getAttribute('open')) === null) await command.locator('summary').click();
        await expect(command.locator('.conversation-command-output')).toContainText('first');
        const output = await command.locator('.conversation-command-output').boundingBox();
        const commandBounds = await command.boundingBox();
        expect(output!.x - commandBounds!.x).toBeCloseTo(indentStep, 1);
        expect(output!.width).toBeCloseTo(commandBounds!.width - indentStep, 1);
        await expect(command.locator('.conversation-command-output')).toHaveCSS(
          'font-family',
          await command
            .locator('.conversation-command-preview')
            .evaluate((el) => getComputedStyle(el).fontFamily)
        );
        expect(await process.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
        await process.screenshot({
          path: testInfo.outputPath(`read-${locale}-${width}-${dark ? 'dark' : 'light'}.png`),
          animations: 'disabled'
        });
      }
    }
  });
}

test('Work processes preserve manual disclosure, static reasoning and authoritative Run completion', async ({
  page
}, testInfo) => {
  const now = Date.now();
  await page.clock.setFixedTime(now);
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  const latestSummary =
    'Inspecting selection tests and planning route candidate script execution in the workspace';
  const run = {
    id: 'run-reasoning',
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    status: 'RUNNING',
    recoveryState: 'ACTIVE',
    clientMessageId: 'message-reasoning',
    startedAt: now - 10_000
  };
  const segments = (append: boolean) =>
    (
      watchedConversation([
        {
          id: 'turn-reasoning:segment:0',
          turnId: 'turn-reasoning',
          index: 0,
          runId: run.id,
          status: 'RUNNING',
          items: [
            {
              id: 'round-input',
              kind: 'user_message',
              status: 'COMPLETED',
              startedAt: now - 11_000,
              payload: { text: 'Inspect the workspace.' }
            },
            {
              id: 'reasoning-first',
              kind: 'reasoning',
              startedAt: now - 8000,
              completedAt: now - 7000,
              processGroup: { id: 'process-reading', ...(append ? { isStart: true } : {}) },
              status: 'COMPLETED',
              payload: {
                representation: 'summary',
                sections: [
                  { index: 0, text: 'Inspecting patch ordering\nFurther reasoning detail' }
                ]
              }
            },
            ...(append
              ? [
                  {
                    id: 'reasoning-second',
                    kind: 'reasoning',
                    startedAt: now - 6500,
                    completedAt: now - 6000,
                    processGroup: { id: 'process-reading' },
                    status: 'COMPLETED',
                    payload: {
                      representation: 'visible_thinking',
                      sections: [
                        { index: 0, text: `**${latestSummary}**\nFurther appended detail` }
                      ]
                    }
                  },
                  {
                    id: 'process-commentary',
                    kind: 'assistant_message',
                    status: 'COMPLETED',
                    payload: { text: 'Starting verification.' }
                  },
                  {
                    id: 'process-tool',
                    kind: 'tool_call',
                    startedAt: now - 4000,
                    completedAt: now - 2000,
                    status: 'FAILED',
                    processGroup: { id: 'process-verification', isStart: true },
                    payload: {
                      toolName: 'read',
                      input: {},
                      outputSummary: 'Verification fixture failure.'
                    }
                  }
                ]
              : [])
          ]
        }
      ]).conversation as { segments: Record<string, unknown>[] }
    ).segments;
  await page.route('**/api/agent-sessions/session-1/watch*', (route) => {
    const snapshot = watchedConversation(segments(false));
    return fulfillMockSessionWatch(
      page,
      route,
      { id: 'session-1', workspaceId: 'workspace-1' },
      { ...snapshot, runs: [run] }
    );
  });
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.locator('.session-list .session-link').first().click();
  const processes = page.locator('.conversation-process.is-group');
  const heading = processes.first().locator('.process-heading');
  await expect(heading).toHaveAttribute('aria-expanded', 'true');
  await expect(heading).not.toContainText('工作过程');
  await expect(heading).not.toContainText('条记录');
  await expect(processes.first().locator('.reasoning-subtitle')).toHaveText(
    'Inspecting patch ordering'
  );
  await expect(page.locator('.composer-working')).not.toContainText('已运行');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  expect(
    await page
      .locator('.composer-working')
      .evaluate((el) => getComputedStyle(el, '::before').animationName)
  ).toBe('none');
  await expect(page.locator('.composer-working > i')).toHaveCSS(
    'animation-name',
    /mar-busy-indicator-spin/u
  );
  await expect(page.locator('.composer-working > i')).toHaveCSS('width', '10px');
  const stroke = await page
    .locator('.composer-working > i')
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).borderTopWidth));
  // Fractional borders snap to physical pixels at the current device scale.
  expect(stroke).toBeGreaterThan(0);
  expect(stroke).toBeLessThanOrEqual(1.5);
  const indicator = heading.locator('.process-activity-indicator');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(indicator).toBeVisible();
  await expect(indicator).toHaveCSS('animation-name', /mar-busy-indicator-spin/u);
  await expect(indicator).toHaveAttribute('aria-hidden', 'true');
  await expect(heading.locator('.process-activity-label')).toHaveCSS('font-weight', '600');
  expect(
    await heading.locator('.process-activity-label').evaluate((element) => {
      const expected = document.createElement('span');
      expected.style.color = 'var(--mar-conversation-text)';
      element.parentElement!.append(expected);
      const matches = getComputedStyle(element).color === getComputedStyle(expected).color;
      expected.remove();
      return matches;
    })
  ).toBe(true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(indicator).toHaveCSS('animation-name', 'none');
  await expect(page.locator('.composer-working > i')).toHaveCSS('animation-name', 'none');
  expect(
    await page
      .locator('.composer-working')
      .evaluate((el) => getComputedStyle(el, '::before').animationName)
  ).toBe('none');
  await expect(heading).toContainText('正在思考中');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await processes.first().screenshot({ path: testInfo.outputPath('process-active.png') });
  await expect(heading).toContainText('部分记录');
  await expect(heading.locator('.process-duration')).toHaveCount(0);
  await expect(processes.first().locator('.process-summary')).toHaveText(
    'Inspecting patch ordering'
  );
  await expect(processes.first().locator('.process-summary')).toHaveCSS('animation-name', 'none');
  await heading.click();
  await expect(heading).toHaveAttribute('aria-expanded', 'false');
  await expect(indicator).toBeVisible();

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.evaluate(() => {
    const events: string[] = [];
    Object.assign(window, { __entryAnimations: events });
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args: Parameters<Element['animate']>) {
      const key = this.getAttribute('data-entry-key');
      if (key) events.push(key);
      return animate.apply(this, args);
    };
  });
  await emitMockSessionEvent(page, 'conversation', {
    sessionId: 'session-1',
    turn: {
      id: 'turn-reasoning',
      sessionId: 'session-1',
      runId: run.id,
      status: 'RUNNING',
      items: []
    },
    segments: segments(true)
  });
  await expect(processes).toHaveCount(2);
  const entered = await page.evaluate(
    () => (window as unknown as { __entryAnimations: string[] }).__entryAnimations
  );
  expect(entered).toContain('session-1:process-commentary');
  expect(entered).not.toContain('session-1:reasoning-first');
  await expect(heading.locator('.process-duration')).toContainText('2s');
  const activeDuration = processes.last().locator('.process-duration');
  await expect(activeDuration).toContainText('4s');
  await page.clock.setFixedTime(now + 2000);
  await expect(activeDuration).toContainText('6s');
  await expect(heading.locator('.process-duration')).toContainText('2s');
  await expect(page.locator('.composer-working')).toContainText('12s');
  await expect(heading.locator('.process-activity-indicator')).toHaveCount(0);
  await expect(processes.last().locator('.process-activity-indicator')).toBeVisible();
  await expect(processes.last().locator('.process-activity-label')).toHaveText(
    '正在调用工具：read'
  );
  await expect(heading).toHaveAttribute('aria-expanded', 'false');
  await expect(heading).not.toContainText('部分记录');
  await expect(processes.last().locator('.process-heading')).toHaveAttribute(
    'aria-expanded',
    'true'
  );
  await expect(processes.last().locator('.process-heading')).not.toContainText('有需关注的记录');
  await heading.click();
  const cards = processes.first().locator('.conversation-item.reasoning-group');
  await expect(cards).toHaveCount(2);
  const card = cards.last();
  await expect(card.locator('.reasoning-subtitle')).toHaveText(latestSummary);
  await expect(card.locator('.reasoning-subtitle')).not.toContainText('Further appended detail');
  const desktopPreviewBounds = await card.locator('summary').evaluate((element) => ({
    clipped: element.scrollWidth > element.clientWidth,
    singleLine: getComputedStyle(element).whiteSpace === 'nowrap'
  }));
  expect(desktopPreviewBounds.clipped).toBe(false);
  expect(desktopPreviewBounds.singleLine).toBe(true);
  await card.screenshot({
    path: testInfo.outputPath('reasoning-live-desktop.png'),
    animations: 'disabled'
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const previewBounds = await card.locator('summary').evaluate((element) => ({
    right: element.getBoundingClientRect().right,
    cardRight: element.closest('.reasoning-group')?.getBoundingClientRect().right ?? 0,
    clipped:
      element.querySelector('.reasoning-subtitle')!.scrollWidth >
      element.querySelector('.reasoning-subtitle')!.clientWidth,
    display: getComputedStyle(element).display,
    textOverflow: getComputedStyle(element.querySelector('.reasoning-subtitle')!).textOverflow
  }));
  expect(previewBounds.clipped).toBe(true);
  expect(previewBounds.right).toBeLessThanOrEqual(previewBounds.cardRight);
  expect(previewBounds.display).toBe('flex');
  expect(previewBounds.textOverflow).toBe('ellipsis');
  await expect(card.locator('.reasoning-subtitle')).toHaveText(latestSummary);
  await expect(card.locator('summary > strong')).toBeVisible();
  await expect(card.locator('summary > svg.mar-disclosure-icon')).toHaveCount(1);
  await expect(card.locator('summary > svg.conversation-record-icon')).toHaveCount(1);
  await card.screenshot({
    path: testInfo.outputPath('reasoning-live-mobile.png'),
    animations: 'disabled'
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  );
  await card.locator('summary').click();
  await expect(card.locator('details p')).toContainText(latestSummary);
  await cards.first().locator('summary').click();
  await expect(cards.first().locator('details p')).toContainText('Further reasoning detail');
  await expect(card.locator('details p')).toContainText('Further appended detail');
  await card.locator('summary').focus();
  await page.keyboard.press('Space');
  await expect(card.locator('details')).not.toHaveAttribute('open', '');
  await page.keyboard.press('Enter');
  await expect(card.locator('details')).toHaveAttribute('open', '');

  await emitMockSessionEvent(page, 'run', {
    run: { ...run, status: 'SUCCEEDED', completedAt: run.startedAt + 20_000 }
  });
  await emitMockSessionEvent(page, 'conversation', {
    sessionId: 'session-1',
    turn: {
      id: 'turn-reasoning',
      sessionId: 'session-1',
      runId: run.id,
      status: 'SUCCEEDED',
      items: []
    },
    segments: segments(true).map((segment) => ({
      ...segment,
      status: 'SUCCEEDED',
      completedAt: now + 10_000
    }))
  });
  await expect(heading).toHaveAttribute('aria-expanded', 'true');
  await expect(processes.last().locator('.process-heading')).toHaveAttribute(
    'aria-expanded',
    'false'
  );
  await expect(processes.last().locator('.process-heading')).not.toContainText('有需关注的记录');
  await expect(card.locator('details')).toHaveAttribute('open', '');
  await expect(page.locator('.conversation-run-duration')).toHaveText('本轮耗时 21s');
  await expect(processes.locator('.process-activity-indicator')).toHaveCount(0);
  await expect(processes.last().locator('.process-heading')).toContainText('已完成');
  await expect(activeDuration).toContainText('2s');
  await page.clock.setFixedTime(now + 5000);
  await expect(activeDuration).toContainText('2s');
  await expect(card.locator('.reasoning-progress')).toHaveCount(0);
});

test.describe('Independent tool presentation', () => {
  test.use({ timezoneId: 'Asia/Shanghai' });
  for (const locale of ['zh-CN', 'en-US'] as const) {
    test(
      'four tool types stay independent on desktop and mobile ' + locale,
      async ({ page }, testInfo) => {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.addInitScript((value) => localStorage.setItem('mar.locale.v2', value), locale);
        await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
        const normalizer = new MarAgentConversationNormalizer();
        const latest = new Map<
          string,
          ReturnType<MarAgentConversationNormalizer['normalize']>[number]
        >();
        let sequence = 0;
        const accept = (payload: Record<string, unknown>) => {
          const entry = {
            eventId: `event-${++sequence}`,
            sequence,
            timestamp: '2026-10-20T15:50:00.000Z',
            sessionId: 'session-1',
            executionId: 'execution',
            turnId: 'tool-turn',
            ...payload
          } as AgentEvent;
          for (const item of normalizer.normalize(entry)) latest.set(item.itemId, item);
        };
        const calls = [
          { name: 'ordinary', input: {}, data: undefined, summary: 'Ordinary result' },
          {
            name: 'web_search',
            input: { query: 'Original query' },
            data: {
              sourceCount: 1,
              sources: [
                {
                  title: 'Original source',
                  url: 'https://example.com/source',
                  snippet: 'Original summary'
                }
              ]
            },
            summary: 'Search complete'
          },
          {
            name: 'web_fetch',
            input: { url: 'https://request.example/page', mode: 'http' },
            data: {
              url: 'https://final.example/page',
              title: 'Original page',
              mode: 'http'
            },
            summary: 'Original page body'
          },
          {
            name: 'skill',
            input: { name: 'original-skill' },
            data: { name: 'original-skill' },
            summary: 'Original skill instructions'
          },
          {
            name: 'sleep',
            input: { durationMs: 1800000 },
            data: { durationMs: 1800000, elapsedMs: 192000, wakeReason: 'subagent_message' },
            summary: 'Sleep finished'
          }
        ];
        for (const call of calls) {
          accept({
            type: 'tool.started',
            toolName: call.name,
            callId: call.name,
            input: call.input
          });
          accept({
            type: 'tool.completed',
            toolName: call.name,
            callId: call.name,
            data: call.data,
            summary: call.summary
          });
        }
        accept({
          type: 'tool.started',
          toolName: 'sleep',
          callId: 'waiting',
          input: { durationMs: 1800000 }
        });
        accept({
          type: 'sleep.started',
          callId: 'waiting',
          durationMs: 1800000,
          startedAt: '2026-10-20T15:50:00.000Z'
        });
        expect(latest.size).toBe(6);
        expect([...latest.values()].at(-1)?.payload.toolPresentation).toMatchObject({
          kind: 'SLEEP',
          startedAt: '2026-10-20T15:50:00.000Z'
        });
        const snapshot = () =>
          watchedConversation([
            {
              id: 'tool-turn:segment:0',
              turnId: 'tool-turn',
              index: 0,
              runId: null,
              status: 'RUNNING',
              items: [...latest.values()]
                .map((item) => ({
                  id: item.itemId,
                  kind: item.kind,
                  status: item.status,
                  payload: item.payload
                }))
                .concat([
                  {
                    id: 'subagent-disclosure',
                    kind: 'tool_call',
                    status: 'FAILED',
                    payload: {
                      toolName: 'agent_start',
                      subagentOperation: 'START',
                      subagentId: 'child-agent',
                      title: 'Review the complete integration and report actionable findings',
                      outputSummary: 'Original subagent failure details'
                    }
                  }
                ])
            }
          ]);
        await page.route('**/api/agent-sessions/session-1/watch*', (route) =>
          fulfillMockSessionWatch(
            page,
            route,
            { id: 'session-1', workspaceId: 'workspace-1' },
            snapshot()
          )
        );
        await page.goto('/console');
        await page
          .getByRole('button', { name: locale === 'zh-CN' ? '进入控制台' : 'Open console' })
          .click();
        await page
          .getByRole('button', { name: locale === 'zh-CN' ? '工作' : 'Work', exact: true })
          .click();
        await page
          .locator('.workspace-tree')
          .getByRole('button', { name: /node-1/ })
          .click();
        await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
        await page.locator('.session-list .session-link').first().click();
        const tools = page.locator('.conversation-tool-presentation');
        await expect(tools).toHaveCount(5);
        await expect(page.locator('.conversation-item.tool-group')).toHaveCount(1);
        const search = page.locator('[data-tool-presentation="WEB_SEARCH"]');
        const skill = page.locator('[data-tool-presentation="SKILL"]');
        const waiting = page.locator('[data-tool-presentation="SLEEP"]').last();
        await expect(skill.locator('summary .conversation-record-preview')).toHaveText(
          'original-skill'
        );
        const expectInlineSkill = async () => {
          const positions = await skill.locator('summary').evaluate((element) => {
            const title = element.querySelector('strong')!.getBoundingClientRect();
            const name = element.querySelector('span')!.getBoundingClientRect();
            return { titleY: title.y, nameY: name.y, titleRight: title.right, nameX: name.x };
          });
          expect(Math.abs(positions.titleY - positions.nameY)).toBeLessThan(1);
          expect(positions.nameX).toBeGreaterThan(positions.titleRight);
          await expect(skill.locator('summary .conversation-record-preview')).toHaveCSS(
            'white-space',
            'nowrap'
          );
        };
        await expectInlineSkill();
        const expectCompactTools = async () => {
          const groupMeta = page.locator(
            '.tool-group > details > summary > .conversation-group-meta'
          );
          await expect(groupMeta).toBeVisible();
          const rightInset = await groupMeta.evaluate((element) => {
            const summary = element.parentElement!;
            return (
              summary.getBoundingClientRect().right -
              element.getBoundingClientRect().right -
              Number.parseFloat(getComputedStyle(summary).paddingRight)
            );
          });
          expect(rightInset).toBeCloseTo(0, 1);
          const rows = page.locator(
            '.conversation-item > details > summary, .conversation-record-group > details > summary'
          );
          const metrics = [];
          for (const row of await rows.all()) {
            if (!(await row.isVisible())) continue;
            metrics.push(
              await row.evaluate((element) => {
                const style = getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                return {
                  height: rect.height,
                  padding: style.padding,
                  radius: style.borderRadius,
                  left: rect.left,
                  right: rect.right,
                  nested: element.parentElement!.parentElement!.matches(
                    'details.conversation-record-group'
                  )
                };
              })
            );
          }
          const baseline = metrics.find((row) => !row.nested)!;
          for (const row of metrics) {
            expect(row.height).toBeCloseTo(baseline.height, 1);
            expect(row.padding).toBe(baseline.padding);
            expect(row.radius).toBe(baseline.radius);
            expect(row.right).toBeCloseTo(baseline.right, 1);
            if (row.nested) {
              expect(row.left).toBeGreaterThan(baseline.left);
              expect(row.left - baseline.left).toBeLessThanOrEqual(12);
            } else expect(row.left).toBeCloseTo(baseline.left, 1);
          }
          for (const tool of await tools.or(page.locator('.subagent-group > details')).all()) {
            const heading = tool.locator(':scope > summary');
            const status = heading.locator('.conversation-record-meta');
            await expect(status).toBeVisible();
            const layout = await heading.evaluate((element) => {
              const title = element.querySelector('strong')!.getBoundingClientRect();
              const preview = element
                .querySelector('.conversation-record-preview')!
                .getBoundingClientRect();
              const state = element
                .querySelector('.conversation-record-meta')!
                .getBoundingClientRect();
              return {
                titleY: title.y,
                previewY: preview.y,
                stateY: state.y,
                stateRight: state.right,
                right:
                  element.getBoundingClientRect().right -
                  Number.parseFloat(getComputedStyle(element).paddingRight)
              };
            });
            expect(Math.abs(layout.titleY - layout.previewY)).toBeLessThan(1);
            expect(Math.abs(layout.titleY - layout.stateY)).toBeLessThan(3);
            expect(Math.abs(layout.stateRight - layout.right)).toBeLessThan(1);
            await expect(heading.locator('.conversation-record-preview')).toHaveCSS(
              'white-space',
              'nowrap'
            );
          }
        };
        await expectCompactTools();
        const groupHeading = page.locator('.tool-group > details > summary');
        const skillHeading = skill.locator(':scope > summary');
        await groupHeading.hover();
        const groupHover = await groupHeading.evaluate(
          (element) => getComputedStyle(element).backgroundColor
        );
        await skillHeading.hover();
        await expect(skillHeading).toHaveCSS('background-color', groupHover);
        expect(groupHover).not.toBe('rgba(0, 0, 0, 0)');
        await skillHeading.focus();
        await page.keyboard.press('Tab');
        await page.keyboard.press('Shift+Tab');
        await expect(skillHeading).toBeFocused();
        await expect(skillHeading).toHaveCSS('outline-style', 'solid');
        await expect(search.locator('summary .conversation-record-preview')).toHaveText(
          locale === 'zh-CN' ? 'Original query · 1 个来源' : 'Original query · 1 sources'
        );
        expect(
          await search
            .locator('summary .conversation-record-preview')
            .evaluate((element) => getComputedStyle(element).cssFloat)
        ).toBe('none');
        await expect(search.locator('summary')).toContainText(
          locale === 'zh-CN' ? 'Original query · 1 个来源' : 'Original query · 1 sources'
        );
        await expect(waiting.locator('summary')).toContainText(
          locale === 'zh-CN'
            ? '30 分钟 · 预计至 2026-10-21 00:20'
            : '30 min · until about 2026-10-21 00:20'
        );
        await expect(skill).not.toHaveAttribute('open');
        await expect(
          skill.getByText('Original skill instructions', { exact: false })
        ).not.toBeVisible();
        await skill.locator('summary').focus();
        await page.keyboard.press('Enter');
        await expect(skill).toHaveAttribute('open', '');
        await expect(skill.locator('p')).toContainText('Original skill instructions');
        await search.locator('summary').click();
        await expect(search.getByRole('link', { name: 'Original source' })).toHaveAttribute(
          'href',
          'https://example.com/source'
        );
        await expect(search.getByText('Original summary')).toBeVisible();
        for (const tool of await tools.or(page.locator('.subagent-group > details')).all()) {
          if (!(await tool.evaluate((element) => element.hasAttribute('open'))))
            await tool.locator(':scope > summary').click();
        }
        await expectCompactTools();
        await expect
          .poll(() =>
            tools.evaluateAll(
              (elements) => elements.flatMap((element) => element.getAnimations()).length
            )
          )
          .toBe(0);
        await page.screenshot({ path: testInfo.outputPath('tools-desktop.png') });
        await page.evaluate(() =>
          document.documentElement.style.setProperty('--el-transition-duration-fast', '1s')
        );
        await skill.locator('summary').evaluate((element: HTMLElement) => element.click());
        await expect(skill).toHaveAttribute('data-disclosure-closing', '');
        await skill.evaluate((element) =>
          element.getAnimations().forEach((animation) => animation.pause())
        );
        const skillPreview = skill.locator('.conversation-record-preview');
        await expect(skillPreview).toHaveCSS('flex-grow', '1');
        await expect(skillPreview).toHaveCSS('white-space', 'nowrap');
        const closingWidth = (await skillPreview.boundingBox())!.width;
        await skill.evaluate((element) =>
          element.getAnimations().forEach((animation) => animation.finish())
        );
        await expect(skill).not.toHaveAttribute('open');
        expect((await skillPreview.boundingBox())!.width).toBeCloseTo(closingWidth, 1);
        await page.evaluate(() =>
          document.documentElement.style.removeProperty('--el-transition-duration-fast')
        );
        await search.locator('summary').click();
        await expect(skill).not.toHaveAttribute('open');
        await expect(search).not.toHaveAttribute('open');
        await page.setViewportSize({ width: 390, height: 844 });
        await expectInlineSkill();
        await expectCompactTools();
        await expect
          .poll(() =>
            page
              .locator('.workspace-tree')
              .evaluate((element) => element.getBoundingClientRect().right)
          )
          .toBeLessThanOrEqual(1);
        await expect(tools).toHaveCount(5);
        expect(
          await page
            .locator('.conversation-scroll')
            .first()
            .evaluate((element) => element.scrollWidth <= element.clientWidth)
        ).toBe(true);
        for (const tool of await tools.or(page.locator('.subagent-group > details')).all()) {
          if (!(await tool.evaluate((element) => element.hasAttribute('open'))))
            await tool.locator(':scope > summary').click();
        }
        await expectCompactTools();
        await page.screenshot({ path: testInfo.outputPath('tools-mobile.png') });
        await page.reload();
        await expect(tools).toHaveCount(5);
        await expect(skill).not.toHaveAttribute('open');
        await expect(waiting.locator('summary')).toContainText('2026-10-21 00:20');
        await page.setViewportSize({ width: 390, height: 500 });
        const scroll = page.locator('.conversation-scroll').first();
        const lastDisclosure = page.locator('.subagent-group > details').last();
        await expect
          .poll(() => scroll.evaluate((element) => element.scrollHeight > element.clientHeight))
          .toBe(true);
        const bottomGap = () =>
          scroll.evaluate(
            (element) => element.scrollHeight - element.scrollTop - element.clientHeight
          );
        for (const reducedMotion of ['no-preference', 'reduce'] as const) {
          await page.emulateMedia({ reducedMotion });
          await scroll.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
          });
          await expect.poll(bottomGap).toBeLessThan(2);
          const previousHeight = await scroll.evaluate((element) => element.scrollHeight);
          await lastDisclosure.locator(':scope > summary').click();
          await expect(lastDisclosure).toHaveAttribute('open');
          await expect
            .poll(() => lastDisclosure.evaluate((element) => element.getAnimations().length))
            .toBe(0);
          await expect
            .poll(() => scroll.evaluate((element) => element.scrollHeight))
            .toBeGreaterThan(previousHeight);
          await expect.poll(bottomGap).toBeLessThan(2);
          await expect(page.locator('.conversation-latest')).toHaveCount(0);
          const skillHeading = skill.locator(':scope > summary');
          await scroll.hover();
          await page.mouse.wheel(0, -600);
          await expect.poll(bottomGap).toBeGreaterThan(28);
          await skillHeading.scrollIntoViewIfNeeded();
          await expect(page.locator('.conversation-latest')).toBeVisible();
          const previousTop = await scroll.evaluate((element) => element.scrollTop);
          await skillHeading.click();
          await expect(skill).toHaveAttribute('open');
          await expect
            .poll(() => skill.evaluate((element) => element.getAnimations().length))
            .toBe(0);
          expect(await scroll.evaluate((element) => element.scrollTop)).toBeCloseTo(previousTop, 0);
          await skillHeading.click();
          await expect(skill).not.toHaveAttribute('open');
          await lastDisclosure.locator(':scope > summary').click();
          await expect(lastDisclosure).not.toHaveAttribute('open');
        }
      }
    );
  }
});

function watchedConversation(
  segments: readonly Record<string, unknown>[],
  nextCursor: string | null = null
): Record<string, unknown> {
  const normalizedSegments = segments.map((segment) => {
    const turnId = String(segment.turnId);
    const runId = typeof segment.runId === 'string' ? segment.runId : null;
    const items = (segment.items as readonly Record<string, unknown>[]).map((item) => {
      const payload = item.payload as Record<string, unknown>;
      return {
        sessionId: 'session-1',
        turnId,
        runId,
        parentItemId: null,
        sourceSequence: null,
        revision: 1,
        startedAt: null,
        completedAt: null,
        ...item,
        payload:
          item.kind === 'assistant_message'
            ? { format: 'markdown', model: null, ...payload }
            : item.kind === 'user_message'
              ? {
                  clientMessageId: String(item.id),
                  contexts: [],
                  delivery: 'ACCEPTED',
                  ...payload
                }
              : payload
      };
    });
    return {
      sessionId: 'session-1',
      runId,
      startedAt: null,
      completedAt: null,
      ...segment,
      items
    };
  });
  return {
    kind: 'session-watch-snapshot',
    sequence: 1,
    session: {
      id: 'session-1',
      workspaceId: 'workspace-1',
      runner: 'codex',
      activity: 'IDLE',
      control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
    },
    runs: [],
    queue: { version: 0, paused: false, items: [] },
    context: null,
    conversation: {
      unit: 'SEGMENT',
      source: 'official',
      readAt: 1,
      latestVisibleAt: normalizedSegments.length,
      snapshotSequence: 1,
      segments: normalizedSegments,
      nextCursor
    }
  };
}

for (const locale of ['zh-CN', 'en-US'] as const) {
  test(
    'Code Exec waits render as distinct command details on desktop and mobile ' + locale,
    async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.addInitScript((value) => localStorage.setItem('mar.locale.v2', value), locale);
      await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
      const events: AgentEvent[] = [
        {
          eventId: 'code-started',
          sequence: 1,
          timestamp: '2026-10-17T00:00:00.000Z',
          sessionId: 'session-1',
          executionId: 'execution',
          turnId: 'turn-code',
          type: 'tool.started',
          toolName: 'code_exec',
          callId: 'code-call',
          input: { code: 'await tools.exec({ command: "verify" });' }
        },
        {
          eventId: 'code-completed',
          sequence: 2,
          timestamp: '2026-10-17T00:00:01.000Z',
          sessionId: 'session-1',
          executionId: 'execution',
          turnId: 'turn-code',
          type: 'tool.completed',
          toolName: 'code_exec',
          callId: 'code-call',
          summary: 'Code cell completed.',
          truncated: false,
          data: { cellId: 'cell-code', status: 'completed' }
        },
        {
          eventId: 'poll-started',
          sequence: 3,
          timestamp: '2026-10-17T00:00:02.000Z',
          sessionId: 'session-1',
          executionId: 'execution',
          turnId: 'turn-code',
          type: 'tool.started',
          toolName: 'code_exec_wait',
          callId: 'poll-call',
          input: { action: 'poll', cellId: 'cell-poll', yieldMs: 0 }
        },
        {
          eventId: 'poll-completed',
          sequence: 4,
          timestamp: '2026-10-17T00:00:03.000Z',
          sessionId: 'session-1',
          executionId: 'execution',
          turnId: 'turn-code',
          type: 'tool.completed',
          toolName: 'code_exec_wait',
          callId: 'poll-call',
          summary: 'Cell is still running.',
          truncated: false,
          data: { cellId: 'cell-poll', status: 'running' }
        },
        {
          eventId: 'cancel-started',
          sequence: 5,
          timestamp: '2026-10-17T00:00:04.000Z',
          sessionId: 'session-1',
          executionId: 'execution',
          turnId: 'turn-code',
          type: 'tool.started',
          toolName: 'code_exec_wait',
          callId: 'cancel-call',
          input: { action: 'cancel', cellId: 'cell-cancel' }
        },
        {
          eventId: 'cancel-completed',
          sequence: 6,
          timestamp: '2026-10-17T00:00:05.000Z',
          sessionId: 'session-1',
          executionId: 'execution',
          turnId: 'turn-code',
          type: 'tool.completed',
          toolName: 'code_exec_wait',
          callId: 'cancel-call',
          summary: 'Cell cancellation completed.',
          truncated: false,
          data: { cellId: 'cell-cancel', status: 'cancelled' }
        },
        {
          eventId: 'skill-started',
          sequence: 7,
          timestamp: '2026-10-17T00:00:06.000Z',
          sessionId: 'session-1',
          executionId: 'execution',
          turnId: 'turn-code',
          type: 'tool.started',
          toolName: 'skill',
          callId: 'skill-call',
          input: { name: 'playwright-cli' }
        },
        {
          eventId: 'skill-completed',
          sequence: 8,
          timestamp: '2026-10-17T00:00:07.000Z',
          sessionId: 'session-1',
          executionId: 'execution',
          turnId: 'turn-code',
          type: 'tool.completed',
          toolName: 'skill',
          callId: 'skill-call',
          summary: 'Skill loaded.',
          truncated: false
        }
      ];
      const latestById = new Map<
        string,
        ReturnType<MarAgentConversationNormalizer['normalize']>[number]
      >();
      const normalizer = new MarAgentConversationNormalizer();
      for (const event of events)
        for (const item of normalizer.normalize(event)) latestById.set(item.itemId, item);
      const normalizedItems = [...latestById.values()].map((item) => ({
        id: item.itemId,
        kind: item.kind,
        status: item.status,
        payload: item.payload,
        processGroup: { id: 'code-process' }
      }));
      const conversation = watchedConversation([
        {
          id: 'turn-code:segment:0',
          turnId: 'turn-code',
          index: 0,
          runId: null,
          status: 'SUCCEEDED',
          items: normalizedItems
        }
      ]);
      await page.route('**/api/agent-sessions/session-1/watch*', (route) =>
        fulfillMockSessionWatch(
          page,
          route,
          { id: 'session-1', workspaceId: 'workspace-1' },
          conversation
        )
      );
      await page.goto('/console');
      await page
        .getByRole('button', { name: locale === 'zh-CN' ? '进入控制台' : 'Open console' })
        .click();
      await page
        .getByRole('button', { name: locale === 'zh-CN' ? '工作' : 'Work', exact: true })
        .click();
      await page
        .locator('.workspace-tree')
        .getByRole('button', { name: /node-1/ })
        .click();
      await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
      await page.locator('.session-list .session-link').first().click();

      const commands = page.locator('.conversation-item.command-group');
      const tools = page.locator('.conversation-item.tool-group');
      const skill = page.locator('[data-tool-presentation="SKILL"]');
      await expect(commands).toHaveCount(1);
      await expect(tools).toHaveCount(0);
      await expect(skill).toHaveCount(1);
      await expect(commands.locator(':scope > details > summary > strong')).toHaveText(
        locale === 'zh-CN' ? '命令' : 'Command'
      );
      await expect(skill.locator(':scope > summary > strong')).toHaveText(
        locale === 'zh-CN' ? '加载技能' : 'Load skill'
      );
      const openDisclosure = async (disclosure: Locator) => {
        if ((await disclosure.getAttribute('open')) === null)
          await disclosure.locator(':scope > summary').click();
      };
      const verify = async () => {
        const heading = page.locator('[data-process-id="code-process"] > .process-heading');
        if ((await heading.getAttribute('aria-expanded')) === 'false') await heading.click();
        await openDisclosure(commands.locator(':scope > details'));
        const details = commands.locator('.conversation-command-detail');
        await expect(details).toHaveCount(3);
        await expect(details.filter({ hasText: 'await tools.exec' }).first()).toBeVisible();
        const waitPoll = details.filter({ hasText: 'code_exec_wait' }).nth(0);
        await expect(waitPoll).toBeVisible();
        await openDisclosure(waitPoll);
        await expect(waitPoll.locator('p')).toContainText('Action: poll');
        await expect(waitPoll.locator('p')).toContainText('cell-poll');
        await expect(waitPoll.locator('p')).toContainText('Cell is still running.');
        const waitCancel = details.filter({ hasText: 'code_exec_wait' }).nth(1);
        await openDisclosure(waitCancel);
        await expect(waitCancel.locator('p')).toContainText('cell-cancel');
        await expect(waitCancel.locator('p')).toContainText('Cell cancellation completed.');
        await openDisclosure(skill);
        const skillIcon = skill.locator(':scope > summary > .conversation-record-icon');
        await expect(skillIcon).toBeVisible();
        await expect(skillIcon).toHaveAttribute('aria-hidden', 'true');
        await expect(skillIcon).toHaveAttribute('fill', 'none');
        const skillLayout = await skill.locator(':scope > summary').boundingBox();
        const commandLayout = await commands.locator(':scope > details > summary').boundingBox();
        const skillIconBox = await skillIcon.boundingBox();
        const skillTitleBox = await skill.locator(':scope > summary > strong').boundingBox();
        await expect(skill.locator(':scope > summary')).toHaveCSS('align-items', 'center');
        expect(
          Math.abs(
            skillIconBox!.y +
              skillIconBox!.height / 2 -
              (skillTitleBox!.y + skillTitleBox!.height / 2)
          )
        ).toBeLessThan(1);
        const commandIconBox = await commands
          .locator(':scope > details > summary > svg')
          .boundingBox();
        expect(Math.abs(skillIconBox!.x - commandIconBox!.x)).toBeLessThan(1);
        expect(Math.abs(skillIconBox!.width - commandIconBox!.width)).toBeLessThan(1);
        expect(Math.abs(skillLayout!.x - commandLayout!.x)).toBeLessThanOrEqual(14);
        await expect(skill.locator('p')).toContainText('playwright-cli');
        expect(
          await skill.evaluate((element) =>
            Math.abs(
              element.querySelector('p')!.getBoundingClientRect().left -
                element.querySelector('summary > strong')!.getBoundingClientRect().left
            )
          )
        ).toBeLessThanOrEqual(1);
        expect(
          await page
            .locator('.conversation-scroll')
            .first()
            .evaluate((element) => element.scrollWidth <= element.clientWidth)
        ).toBe(true);
      };
      await verify();
      await page.setViewportSize({ width: 390, height: 844 });
      await verify();
      await page.locator('[data-process-id="code-process"]').screenshot({
        path: testInfo.outputPath(`skill-${locale}-mobile.png`),
        animations: 'disabled'
      });
    }
  );
}

test('Session lists preserve the authoritative merged Node order without parallel Web discovery', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'events.live', 'turn.start'], writes);
  await page.route('**/api/agent-sessions?nodeId=node-1*', (route) =>
    json(route, {
      sessions: [
        {
          id: 'codex-fast',
          workspaceId: 'workspace-1',
          runner: 'codex',
          runnerTitle: 'Codex 立即可用',
          externalSessionId: 'thread-fast',
          control: { level: 'MANAGED', capabilities: ['history.read'] }
        }
      ],
      nextCursor: null
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

  await expect(page.getByText('Codex 立即可用', { exact: true })).toBeVisible();
  expect(writes.some((entry) => entry.url.includes('/agent-sessions/discover'))).toBe(false);
});

test('Image generation uses dedicated cards while ordinary image tools retain their tool category', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  await page.route('**/api/agent-sessions/session-1/watch*', (route) =>
    fulfillMockSessionWatch(
      page,
      route,
      { id: 'session-1', workspaceId: 'workspace-1' },
      watchedConversation([
        {
          id: 'turn-images:segment:0',
          turnId: 'turn-images',
          index: 0,
          runId: null,
          status: 'SUCCEEDED',
          items: [
            {
              id: 'view-image',
              kind: 'tool_call',
              status: 'COMPLETED',
              payload: {
                namespace: 'workspace',
                toolName: 'view_image',
                title: 'view_image',
                inputSummary: '{"path":"diagram.png"}',
                outputSummary: 'diagram.png',
                progressLabel: null,
                errorCode: null,
                truncated: false,
                attachments: [
                  {
                    name: 'diagram.png',
                    mime: 'image/png',
                    runId: 'run-view-image',
                    imageIndex: 0
                  }
                ]
              }
            },
            {
              id: 'generate-image',
              kind: 'tool_call',
              status: 'COMPLETED',
              payload: {
                namespace: 'media',
                toolName: 'generate',
                title: 'generate',
                inputSummary: '{"prompt":"A lighthouse"}',
                outputSummary: 'generated.png',
                progressLabel: null,
                errorCode: null,
                truncated: false,
                toolCategory: 'IMAGE_GENERATION',
                attachments: [
                  {
                    name: 'generated.png',
                    mime: 'image/png',
                    runId: 'run-generate-image',
                    imageIndex: 0
                  }
                ]
              }
            }
          ]
        }
      ])
    )
  );
  await page.route(/\/api\/agent-runs\/[^/?]+\/images\/0\?nodeId=node-1$/, (route) =>
    route.fulfill({
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
        'base64'
      )
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
  await page.locator('.session-list .session-link').first().click();

  const imageGeneration = page.locator('.conversation-item.image-generation');
  await expect(imageGeneration).toHaveCount(1);
  await expect(imageGeneration.getByText('图片生成', { exact: true })).toBeVisible();
  await expect(imageGeneration.getByRole('img', { name: 'generated.png' })).toBeVisible();

  const toolGroup = page.locator('.conversation-item.tool-group');
  await expect(toolGroup).toHaveCount(1);
  await expect(toolGroup.locator('summary').first()).toContainText('工具');
  await expect(toolGroup.locator('summary').first()).toContainText('1 条');

  await imageGeneration.getByRole('button', { name: '放大查看 generated.png' }).click();
  await expect(page.getByRole('dialog', { name: 'generated.png' })).toBeVisible();
});

for (const runner of ['mar-agent', 'codex'] as const) {
  test(`${runner} offers native Rollback after terminal user messages and restores their text`, async ({
    page
  }) => {
    const writes: {
      readonly url: string;
      readonly csrf: string | undefined;
      readonly body: string;
    }[] = [];
    await mockConsoleApi(
      page,
      'MANAGED',
      ['history.read', 'turn.start'],
      writes,
      'GIT_WORKSPACE',
      true,
      'IDLE',
      undefined,
      '0.9.49'
    );
    const session = {
      id: 'session-1',
      workspaceId: 'workspace-1',
      runner,
      externalSessionId: 'mar-agent-session-1',
      nativeControl: 'MAR_MANAGED',
      runnerTitle: 'Rollback 会话',
      modelId: 'coding',
      effort: 'high',
      access: 'full-access',
      activity: 'IDLE',
      control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] },
      runtime: {
        level: 'MANAGED',
        capabilities: ['history.read', 'turn.start', 'session.rewind', 'session.rollback'],
        reasonCode: null
      }
    };
    const retainedSegment = {
      id: 'turn-retained:segment:0',
      turnId: 'turn-retained',
      index: 0,
      runId: null,
      status: 'SUCCEEDED',
      rewind: { before: null, after: 'turn-retained' },
      items: [
        {
          id: 'retained-assistant',
          kind: 'assistant_message',
          status: 'COMPLETED',
          payload: { text: '保留的历史' }
        }
      ]
    };
    const rollbackSegment = {
      id: 'turn-rollback:segment:0',
      turnId: 'turn-rollback',
      index: 0,
      runId: null,
      status: 'SUCCEEDED',
      rewind: { before: 'turn-retained', after: 'turn-rollback' },
      items: [
        {
          id: 'rollback-user',
          kind: 'user_message',
          status: 'COMPLETED',
          payload: { text: '请重新检查这个问题' }
        },
        {
          id: 'rollback-assistant',
          kind: 'assistant_message',
          status: 'COMPLETED',
          payload: { text: '稍后会被删除的回复' }
        }
      ]
    };
    const snapshot = (segments: readonly Record<string, unknown>[], sequence: number) => {
      const value = watchedConversation(segments);
      return {
        ...value,
        sequence,
        session,
        conversation: {
          ...(value.conversation as Record<string, unknown>),
          snapshotSequence: sequence
        }
      };
    };
    let rollbackApplied = false;
    let rollbackBody: Record<string, unknown> | undefined;
    let watchReads = 0;
    await page.route(/\/api\/agent-sessions\?nodeId=node-1(?:&.*)?$/, (route) =>
      json(route, { sessions: [session], nextCursor: null })
    );
    await page.route('**/api/agent-sessions/session-1?nodeId=node-1', (route) =>
      json(route, { session })
    );
    await page.route(/\/api\/runner-profiles\?.*\bnodeId=node-1(?:&|$)/, (route) =>
      json(route, {
        profiles: [
          {
            runner,
            models: [{ id: 'coding', label: 'Coding', supportedEfforts: ['high'] }],
            accessOptions: [{ id: 'full-access', label: 'Full access' }],
            commands: [],
            capabilities: ['history.read', 'turn.start']
          }
        ]
      })
    );
    await page.route('**/api/agent-sessions/session-1/rollback', (route) => {
      rollbackBody = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
      rollbackApplied = true;
      return json(route, { session: { ...session, lastActivityAt: 1_789_000_000_000 } });
    });
    await page.route('**/api/agent-sessions/session-1/watch*', async (route) => {
      if (route.request().method() === 'DELETE') {
        await json(route, { unwatched: true });
        return;
      }
      watchReads += 1;
      await fulfillMockSessionWatch(
        page,
        route,
        session,
        rollbackApplied
          ? snapshot([retainedSegment], 2)
          : snapshot([retainedSegment, rollbackSegment], 1)
      );
    });

    await page.goto('/console');
    await page.getByRole('button', { name: '进入控制台' }).click();
    await page.getByRole('button', { name: '工作', exact: true }).click();
    await page
      .locator('.workspace-tree')
      .getByRole('button', { name: /node-1/ })
      .click();
    await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
    await page.locator('.session-list .session-link').first().click();

    const userMessage = page.locator('.conversation-item.user_message', {
      hasText: '请重新检查这个问题'
    });
    await expect(userMessage).toBeVisible();
    const userActionLabels = await userMessage
      .locator('.conversation-message-actions button')
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')));
    expect(userActionLabels.slice(-2)).toEqual([
      '从此消息之前创建会话分支',
      '永久删除此用户消息及其后的对话记录'
    ]);
    const assistantMessage = page.locator('.conversation-item.assistant_message', {
      hasText: '稍后会被删除的回复'
    });
    await expect(
      assistantMessage.getByRole('button', { name: '永久删除此用户消息及其后的对话记录' })
    ).toHaveCount(0);

    const rewindButton = userMessage.getByRole('button', { name: '从此消息之前创建会话分支' });
    const rollbackButton = userMessage.getByRole('button', {
      name: '永久删除此用户消息及其后的对话记录'
    });
    const activeSession = { ...session, activity: 'MANAGED_ACTIVE' };
    await emitMockSessionEvent(page, 'session', { session: activeSession });
    await expect(page.locator('.composer-working')).toBeVisible();
    await expect(rewindButton).toHaveCount(0);
    await expect(rollbackButton).toHaveCount(0);
    await expect(
      assistantMessage.getByRole('button', { name: '从此轮结束处创建会话分支' })
    ).toHaveCount(0);
    await expect(userMessage.getByRole('button', { name: /^复制.*消息$/u })).toBeVisible();
    await expect(page.locator('.composer-model-effort-select .el-select__wrapper')).toHaveClass(
      /is-disabled/u
    );
    const sessionRow = page.locator('.session-row', { hasText: 'Rollback 会话' });
    await sessionRow.hover();
    await sessionRow.getByRole('button', { name: /更多会话操作/u }).click();
    await expect(
      page.locator('.session-action-menu').getByRole('menuitem', { name: '删除', exact: true })
    ).toHaveCount(0);
    await expect(
      page.locator('.session-action-menu').getByRole('menuitem', { name: '重命名', exact: true })
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await emitMockSessionEvent(page, 'session', { session });
    await expect(rewindButton).toBeVisible();
    await expect(rollbackButton).toBeVisible();

    for (const [button, confirmName] of [
      [rewindButton, '创建分支'],
      [rollbackButton, '确认回滚']
    ] as const) {
      await button.click();
      await expect(page.locator('.el-message-box')).toBeVisible();
      await emitMockSessionEvent(page, 'session', { session: activeSession });
      await expect(button).toHaveCount(0);
      await page
        .locator('.el-message-box')
        .getByRole('button', { name: confirmName, exact: true })
        .click();
      await expect(page.locator('.el-message-box')).toBeHidden();
      expect(rollbackBody).toBeUndefined();
      expect(writes.filter((entry) => /\/(rewind|rollback)$/.test(entry.url))).toHaveLength(0);
      await emitMockSessionEvent(page, 'session', { session });
      await expect(button).toBeVisible();
    }

    await userMessage.getByRole('button', { name: '永久删除此用户消息及其后的对话记录' }).click();
    const confirmation = page.locator('.el-message-box');
    await expect(confirmation).toContainText('永久删除这条用户消息及其后的全部对话记录');
    await expect(confirmation.locator('[data-mar-icon="warning"]')).toBeVisible();
    await expect(
      confirmation.locator('.el-message-box__headerbtn [data-mar-icon="close"]')
    ).toBeVisible();
    await confirmation.getByRole('button', { name: '确认回滚', exact: true }).click();

    await expect(page.getByText('请重新检查这个问题', { exact: true })).toHaveCount(0);
    await expect(page.getByText('稍后会被删除的回复', { exact: true })).toHaveCount(0);
    await expect(page.getByText('保留的历史', { exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: '输入消息' })).toHaveValue('请重新检查这个问题');
    await expect(page.locator('.session-list .session-link').first()).toHaveClass(/selected/u);
    expect(rollbackBody).toEqual({
      nodeId: 'node-1',
      turnId: 'turn-rollback',
      boundary: 'turn-retained'
    });
    expect(watchReads).toBe(2);
  });
}

for (const outcome of ['success', 'navigation-failure'] as const) {
  test(`Rewind ${outcome} keeps the committed branch distinct from navigation`, async ({
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
    const source = {
      id: 'session-1',
      workspaceId: 'workspace-1',
      runner: 'codex',
      externalSessionId: 'native-source',
      nativeControl: 'MAR_MANAGED',
      runnerTitle: 'Source conversation',
      activity: 'IDLE',
      control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] },
      runtime: { level: 'MANAGED', capabilities: ['session.rollback'], reasonCode: null }
    };
    const branch = {
      ...source,
      id: 'session-3',
      externalSessionId: 'native-branch',
      runnerTitle: 'New branch'
    };
    let posts = 0;
    let body: Record<string, unknown> | undefined;
    await page.route(/\/api\/agent-sessions\?nodeId=node-1(?:&.*)?$/, (route) =>
      json(route, { sessions: [source], nextCursor: null })
    );
    await page.route(/\/api\/agent-sessions\/session-[13]\?nodeId=node-1$/, (route) => {
      const isBranch = route.request().url().includes('/session-3?');
      if (isBranch && outcome === 'navigation-failure')
        return json(
          route,
          { code: 'SESSION_READ_FAILED', error: 'Branch history unavailable.' },
          503
        );
      return json(route, { session: isBranch ? branch : source });
    });
    await page.route(/\/api\/agent-sessions\/session-[13]\/watch(?:\?|$)/, (route) => {
      if (route.request().method() === 'DELETE') return json(route, { unwatched: true });
      const session = route.request().url().includes('/session-3/') ? branch : source;
      const payload = watchedConversation([
        {
          sessionId: session.id,
          id: session.id + ':segment:0',
          turnId: 'native-turn',
          index: 0,
          runId: null,
          status: 'SUCCEEDED',
          rewind: { before: null, after: 'native-turn' },
          items: [
            {
              sessionId: session.id,
              id: session.id + ':user',
              kind: 'user_message',
              status: 'COMPLETED',
              payload: { text: session.id === source.id ? 'Original user text' : 'Branch history' }
            }
          ]
        }
      ]);
      return fulfillMockSessionWatch(page, route, session, { ...payload, session });
    });
    await page.route('**/api/agent-sessions/session-1/rewind', (route) => {
      posts += 1;
      body = route.request().postDataJSON();
      return json(route, { session: branch });
    });
    await page.goto('/console');
    await page.getByRole('button', { name: '进入控制台' }).click();
    await page.getByRole('button', { name: '工作', exact: true }).click();
    await page
      .locator('.workspace-tree')
      .getByRole('button', { name: /node-1/ })
      .click();
    await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
    await page.locator('.session-link', { hasText: 'Source conversation' }).click();
    const composer = page.getByRole('textbox', { name: '输入消息' });
    await composer.fill('Unsent source draft');
    await page
      .locator('.conversation-item.user_message', { hasText: 'Original user text' })
      .getByRole('button', { name: '从此消息之前创建会话分支' })
      .click();
    const confirmation = page.locator('.el-message-box');
    await expect(confirmation.locator('[data-mar-icon="warning"]')).toBeVisible();
    await expect(
      confirmation.locator('.el-message-box__headerbtn [data-mar-icon="close"]')
    ).toBeVisible();
    await page
      .locator('.el-message-box')
      .getByRole('button', { name: '创建分支', exact: true })
      .click();
    if (outcome === 'success') {
      await expect(page.locator('.el-message--success [data-mar-icon="success"]')).toBeVisible();
      await expect(
        page.locator('.conversation-item.user_message', { hasText: 'Branch history' })
      ).toBeVisible();
      await expect(composer).toHaveValue('Original user text');
      await expect(composer).toBeFocused();
    } else {
      await expect(page.getByText(/会话分支已创建，但无法打开/)).toBeVisible();
      await expect(page.locator('.el-message--error [data-mar-icon="error"]')).toBeVisible();
      await expect(page.locator('.session-link', { hasText: 'Source conversation' })).toHaveClass(
        /selected/
      );
      await expect(
        page.locator('.conversation-item.user_message', { hasText: 'Original user text' })
      ).toBeVisible();
      await expect(composer).toHaveValue('Unsent source draft');
      await expect(page.locator('.session-link', { hasText: 'New branch' })).toBeVisible();
    }
    expect(posts).toBe(1);
    expect(body).toEqual({
      nodeId: 'node-1',
      turnId: 'native-turn',
      position: 'BEFORE',
      boundary: null
    });
  });
}

for (const operation of ['rewind', 'rollback'] as const) {
  for (const outcome of ['success', 'failure', 'watch-failure'] as const) {
    if (operation === 'rewind' && outcome === 'watch-failure') continue;
    test(`Late ${operation} ${outcome} preserves the newly selected conversation and draft`, async ({
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
      const source = {
        id: 'session-1',
        workspaceId: 'workspace-1',
        runner: 'codex',
        externalSessionId: 'native-source',
        nativeControl: 'MAR_MANAGED',
        runnerTitle: 'Source conversation',
        activity: 'IDLE',
        control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] },
        runtime: { level: 'MANAGED', capabilities: ['session.rollback'], reasonCode: null }
      };
      const target = {
        ...source,
        id: 'session-2',
        externalSessionId: 'native-target',
        runnerTitle: 'Target conversation'
      };
      const branch = {
        ...source,
        id: 'session-3',
        externalSessionId: 'native-branch',
        runnerTitle: 'New branch'
      };
      await page.route(/\/api\/agent-sessions\?nodeId=node-1(?:&.*)?$/, (route) =>
        json(route, { sessions: [source, target], nextCursor: null })
      );
      await page.route(/\/api\/agent-sessions\/session-[123]\?nodeId=node-1$/, (route) => {
        const session = route.request().url().includes('/session-2?')
          ? target
          : route.request().url().includes('/session-3?')
            ? branch
            : source;
        return json(route, { session });
      });
      await page.route(/\/api\/agent-sessions\/session-[123]\/watch(?:\?|$)/, async (route) => {
        if (route.request().method() === 'DELETE') return json(route, { unwatched: true });
        const session = route.request().url().includes('/session-2/')
          ? target
          : route.request().url().includes('/session-3/')
            ? branch
            : source;
        const payload = watchedConversation([
          {
            sessionId: session.id,
            id: `${session.id}:segment:0`,
            turnId: `${session.id}:turn`,
            index: 0,
            runId: null,
            status: 'SUCCEEDED',
            rewind: { before: null, after: `${session.id}:turn` },
            items: [
              {
                sessionId: session.id,
                id: `${session.id}:message`,
                kind: 'user_message',
                status: 'COMPLETED',
                payload: { text: session.id === source.id ? 'Source history' : 'Target history' }
              }
            ]
          }
        ]);
        await fulfillMockSessionWatch(page, route, session, { ...payload, session });
      });
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      await page.route(`**/api/agent-sessions/session-1/${operation}`, async (route) => {
        markStarted();
        await pending;
        if (outcome !== 'success')
          return json(route, { error: 'Session active.', code: 'SESSION_ACTIVE' }, 409);
        return json(route, { session: operation === 'rewind' ? branch : source });
      });
      await page.goto('/console');
      await page.getByRole('button', { name: '进入控制台' }).click();
      await page.getByRole('button', { name: '工作', exact: true }).click();
      await page
        .locator('.workspace-tree')
        .getByRole('button', { name: /node-1/ })
        .click();
      await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
      await page.locator('.session-link', { hasText: 'Source conversation' }).click();
      const message = page.locator('.conversation-item.user_message', {
        hasText: 'Source history'
      });
      await expect(message).toBeVisible();
      await message
        .getByRole('button', {
          name:
            operation === 'rewind'
              ? '从此消息之前创建会话分支'
              : '永久删除此用户消息及其后的对话记录'
        })
        .click();
      await page
        .locator('.el-message-box')
        .getByRole('button', {
          name: operation === 'rewind' ? '创建分支' : '确认回滚',
          exact: true
        })
        .click();
      await started;
      const targetRow = page.locator('.session-row', {
        hasText: outcome === 'watch-failure' ? 'Source conversation' : 'Target conversation'
      });
      if (outcome === 'watch-failure') {
        await emitMockSessionEvent(page, 'conversation', {
          sessionId: source.id,
          runId: 'watch-run',
          item: {
            itemId: 'watch-update',
            kind: 'assistant_message',
            status: 'COMPLETED',
            segmentId: 'session-1:segment:0',
            segmentIndex: 0,
            startedAt: 1,
            completedAt: 2,
            payload: { text: 'Watch update while pending', format: 'markdown', model: null }
          }
        });
        await expect(page.getByText('Watch update while pending', { exact: true })).toBeVisible();
      } else {
        await targetRow.locator('.session-link').click();
        await expect(
          page.locator('.conversation-item.user_message', { hasText: 'Target history' })
        ).toBeVisible();
      }
      const composer = page.getByRole('textbox', { name: '输入消息' });
      await composer.fill('Keep target draft');
      await targetRow.hover();
      const response = page.waitForResponse((response) =>
        response.url().endsWith(`/session-1/${operation}`)
      );
      release();
      await response;
      if (outcome === 'failure')
        await expect(page.locator('.el-message--error [data-mar-icon="error"]')).toBeVisible();
      await expect(targetRow.locator('.session-more-button')).toBeEnabled();
      await expect(targetRow.locator('.session-link')).toHaveClass(/selected/u);
      if (outcome === 'watch-failure') {
        await expect(page.getByText('Watch update while pending', { exact: true })).toBeVisible();
      } else {
        await expect(
          page.locator('.conversation-item.user_message', { hasText: 'Target history' })
        ).toBeVisible();
        await expect(
          page.locator('.conversation-item.user_message', { hasText: 'Source history' })
        ).toHaveCount(0);
      }
      await expect(composer).toHaveValue('Keep target draft');
    });
  }
}

test('Admin workspaces render replies, plans, and streaming updates as safe Markdown', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  const previewPaths: string[] = [];
  const previewContentPaths: string[] = [];
  const previewRoute = (route: Route) => {
    const requestUrl = new URL(route.request().url());
    const path = requestUrl.searchParams.get('path') ?? '';
    const offset = requestUrl.searchParams.get('offset');
    previewPaths.push(path);
    return json(route, {
      file: {
        path,
        encoding: 'utf-8',
        content: offset === '2' ? '\n目标行' : '第一行\n第二行\n第三行',
        truncated: offset !== '2',
        nextOffset: offset === '2' ? null : 2
      }
    });
  };
  await page.context().route('**/api/workspaces/workspace-1/files/read**', previewRoute);
  await page.route('**/api/workspaces/workspace-1/files/read**', previewRoute);
  await page.context().route('**/api/workspaces/workspace-1/files/content**', (route) => {
    const requestUrl = new URL(route.request().url());
    previewContentPaths.push(requestUrl.searchParams.get('path') ?? '');
    return route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64'
      )
    });
  });
  await page.route(/\/api\/workspaces\/workspace-1\/changes(?:\?.*)?$/, (route) =>
    json(route, {
      branch: 'develop',
      changes: [
        { path: 'src/main.ts', state: 'UNSTAGED', change: 'MODIFIED', diffAvailable: true }
      ],
      repositories: [
        {
          repositoryPath: '',
          repositoryName: 'project',
          source: 'ROOT',
          branch: 'develop',
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
        path: 'src/main.ts',
        binary: false,
        truncated: false,
        text: 'diff --git a/src/main.ts b/src/main.ts\n@@ -1 +1 @@\n-old\n+new\n'
      }
    })
  );
  let watchReads = 0;
  await page.route('**/api/agent-sessions/session-1/watch*', (route) => {
    watchReads += 1;
    const content = [
      '# 流式完成的回复',
      '',
      '- 普通列表',
      '- [x] 已完成任务',
      '- [ ] 待处理任务',
      '',
      '| 文件 | 状态 |',
      '| --- | --- |',
      '| `src/App.vue` | 已更新 |',
      '',
      '[外部文档](https://example.com/docs)',
      '[打开源文件](src/main.ts)',
      '[带行号的源文件](src/main.ts:4)',
      '[绝对安全文件](/project/src/main.ts)',
      '[越界文件](../secret.txt)',
      `[节点允许目录文件](${new URL(route.request().url()).origin}${syntheticAbsoluteFile}:2640)`,
      '![工作区截图](/project/assets/chart.png)',
      '![相对路径截图](assets/chart.png)',
      '![临时截图](/tmp/capture.png)',
      '![物模型缓存提示截图](sandbox:/tmp/thing-model-cache-tip.png)',
      '',
      '```ts',
      'const answer = 42;',
      '```',
      '',
      '<img src=x onerror="window.__markdownXss = true">',
      '[危险链接](javascript:window.__markdownXss = true)'
    ].join('\n');
    return fulfillMockSessionWatch(
      page,
      route,
      { id: 'session-1', workspaceId: 'workspace-1' },
      watchedConversation([
        {
          id: 'turn-markdown:segment:0',
          turnId: 'turn-markdown',
          index: 0,
          runId: 'run-1',
          status: 'RUNNING',
          items: [
            {
              id: 'user-message-copy',
              kind: 'user_message',
              status: 'COMPLETED',
              startedAt: Date.UTC(2026, 7, 24, 2, 30),
              completedAt: Date.UTC(2026, 7, 24, 2, 30),
              payload: { text: '请复制这条用户消息' }
            },
            {
              id: 'assistant-markdown',
              kind: 'assistant_message',
              status: 'IN_PROGRESS',
              startedAt: Date.UTC(2026, 7, 24, 2, 31),
              completedAt: null,
              payload: { text: content }
            },
            {
              id: 'file-change-absolute',
              kind: 'file_change',
              status: 'COMPLETED',
              payload: {
                changes: [
                  {
                    path: '/project/src/main.ts',
                    change: 'MODIFIED',
                    additions: null,
                    deletions: null,
                    diffAvailable: true
                  }
                ]
              }
            },
            {
              id: 'plan-markdown',
              kind: 'plan',
              status: 'COMPLETED',
              payload: {
                explanation: '## 实施计划\n\n> 先校验再实施。',
                steps: [
                  { id: 'step-1', text: '### 检查\n\n- [x] 阅读现状', status: 'COMPLETED' },
                  {
                    id: 'step-2',
                    text: '### 实现\n\n使用 `AgentMarkdown`。',
                    status: 'PENDING'
                  }
                ]
              }
            }
          ]
        }
      ])
    );
  });
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.locator('.session-list .session-link').first().click();
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          Object.defineProperty(window, '__copiedConversationText', {
            configurable: true,
            value: text,
            writable: true
          });
        }
      }
    });
  });

  const assistantMarkdown = page.locator('.conversation-item.assistant_message .agent-markdown');
  const copyUserMessage = page.getByRole('button', { name: '复制你消息' });
  const copyAgentMessage = page.getByRole('button', { name: '复制Agent消息' });
  await expect(copyUserMessage).toHaveCount(1);
  await expect(copyAgentMessage).toHaveCount(1);
  await expect(copyUserMessage).toBeVisible();
  await expect(copyAgentMessage).toBeVisible();
  await expect(page.locator('.conversation-message-time')).toHaveCount(2);
  await expect(page.locator('.conversation-message-time').nth(0)).toHaveAttribute(
    'datetime',
    '2026-08-24T02:30:00.000Z'
  );
  await expect(page.locator('.conversation-message-time').nth(1)).toHaveAttribute(
    'datetime',
    '2026-08-24T02:31:00.000Z'
  );
  await expect(page.locator('.conversation-message-time').nth(0)).toHaveText(
    /^2026-08-24 \d{2}:\d{2}:\d{2}$/u
  );
  const userActionLayout = await page
    .locator('.conversation-item.user_message')
    .evaluate((item) => {
      const content = item.querySelector('.conversation-message')?.getBoundingClientRect();
      const actions = item.querySelector('.conversation-message-actions')?.getBoundingClientRect();
      return { contentBottom: content?.bottom ?? 0, actionsTop: actions?.top ?? 0 };
    });
  expect(userActionLayout.actionsTop).toBeGreaterThanOrEqual(userActionLayout.contentBottom);
  await copyUserMessage.click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as Window & { __copiedConversationText?: string }).__copiedConversationText
      )
    )
    .toBe('请复制这条用户消息');
  await expect(page.getByText('消息已复制。', { exact: true })).toHaveCount(0);
  await expect(assistantMarkdown.locator('h1')).toHaveText('流式完成的回复');
  await expect(assistantMarkdown.locator('ul')).toContainText('已完成任务');
  await expect(assistantMarkdown.locator('.task-list-item input')).toHaveCount(2);
  await expect(assistantMarkdown.locator('table')).toContainText('src/App.vue');
  await expect(assistantMarkdown.locator('pre code')).toContainText('const answer = 42;');
  const link = assistantMarkdown.locator('a[href="https://example.com/docs"]');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  const fileLink = assistantMarkdown.locator('a[data-workspace-file="src/main.ts"]');
  await expect(fileLink).toHaveCount(3);
  const lineFileLink = assistantMarkdown.locator(
    'a[data-workspace-file="src/main.ts"][data-workspace-line="4"]'
  );
  await expect(lineFileLink).toHaveCount(1);
  await expect(assistantMarkdown.locator('a[data-workspace-file="../secret.txt"]')).toHaveCount(0);
  const externalFileLink = assistantMarkdown.locator(
    `a[data-workspace-file="${syntheticAbsoluteFile}"]`
  );
  await expect(externalFileLink).toHaveCount(1);
  await expect(externalFileLink).toHaveAttribute('data-workspace-line', '2640');
  const markdownImages = assistantMarkdown.locator('img');
  await expect(markdownImages).toHaveCount(4);
  for (const [name, path] of [
    ['工作区截图', 'assets/chart.png'],
    ['相对路径截图', 'assets/chart.png'],
    ['临时截图', '/tmp/capture.png'],
    ['物模型缓存提示截图', '/tmp/thing-model-cache-tip.png']
  ] as const) {
    const image = assistantMarkdown.getByRole('img', { name });
    await expect(image).toHaveAttribute('src', /\/api\/workspaces\/workspace-1\/files\/content\?/u);
    await expect
      .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
      .toBe(1);
    const src = await image.getAttribute('src');
    if (src === null) throw new Error('Image source is missing.');
    expect(new URL(src, page.url()).searchParams.get('path')).toBe(path);
  }
  await expect
    .poll(() => previewContentPaths)
    .toEqual(
      expect.arrayContaining([
        'assets/chart.png',
        '/tmp/capture.png',
        '/tmp/thing-model-cache-tip.png'
      ])
    );
  await expect(assistantMarkdown.locator('[src^="sandbox:"]')).toHaveCount(0);
  await lineFileLink.click();
  await expect(page.getByRole('dialog', { name: 'src/main.ts Git 差异' })).toBeVisible();
  await page.locator('.workspace-file-tab.is-active .workspace-file-tab-close').click();
  const popupPromise = page.waitForEvent('popup');
  await fileLink.first().click({ modifiers: ['Control'] });
  const filePopup = await popupPromise;
  await filePopup.waitForURL(/standaloneFile=1/);
  const filePopupUrl = filePopup.url();
  await mockConsoleApi(filePopup, 'MANAGED', ['history.read', 'turn.start'], []);
  await filePopup.goto('/console');
  await filePopup.getByRole('button', { name: '进入控制台' }).click();
  await expect(
    filePopup.locator('.workspace-tree').getByRole('button', { name: /node-1/ })
  ).toBeVisible();
  await filePopup.goto(filePopupUrl);
  await expect(filePopup.getByRole('dialog', { name: 'src/main.ts 文件预览' })).toBeVisible();
  await expect(filePopup.getByRole('button', { name: '关闭预览' })).toHaveCount(1);
  const filePopupClosed = filePopup.waitForEvent('close');
  await filePopup
    .getByRole('button', { name: '关闭文件窗口', exact: true })
    .click()
    .catch((error: unknown) => {
      if (!filePopup.isClosed()) throw error;
    });
  await filePopupClosed;
  await page.locator('.conversation-file-change-details > summary').click();
  await page.getByRole('button', { name: '查看 /project/src/main.ts 的更改' }).click();
  await expect(page.getByRole('dialog', { name: 'src/main.ts Git 差异' })).toBeVisible();
  await page.locator('.workspace-file-tab.is-active .workspace-file-tab-close').click();
  await externalFileLink.click();
  await expect.poll(() => previewPaths).toContain(syntheticAbsoluteFile);
  await expect(
    page.getByRole('dialog', {
      name: `${syntheticAbsoluteFile} 文件预览`
    })
  ).toBeVisible();
  await page.locator('.workspace-file-tab.is-active .workspace-file-tab-close').click();
  await expect(assistantMarkdown.locator('[onerror]')).toHaveCount(0);
  await expect(assistantMarkdown.locator('a[href^="javascript:"]')).toHaveCount(0);
  await expect(page.locator('.agent-markdown h2')).toHaveText('实施计划');
  await expect(page.locator('.plan-step-list')).toContainText('阅读现状');
  await expect(page.locator('.plan-step-list code')).toContainText('AgentMarkdown');
  expect(watchReads).toBe(1);
  expect(
    await page.evaluate(() => (window as unknown as { __markdownXss?: boolean }).__markdownXss)
  ).toBeUndefined();
});

for (const mobile of [false, true]) {
  test.describe(`History action recovery ${mobile ? 'mobile' : 'desktop'}`, () => {
    test.use({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      isMobile: mobile,
      hasTouch: mobile
    });

    test('Keeps retries focused and shows only rings while history loads across locales', async ({
      page
    }, testInfo) => {
      await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
      let initialAttempts = 0;
      let releaseRetry!: () => void;
      const retryReady = new Promise<void>((resolve) => {
        releaseRetry = resolve;
      });
      await page.route('**/api/agent-sessions/session-1/watch*', async (route) => {
        initialAttempts += 1;
        if (initialAttempts <= 2) {
          if (initialAttempts === 2) await retryReady;
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({
              error: { code: 'TEMPORARILY_UNAVAILABLE', message: 'History unavailable' }
            })
          });
          return;
        }
        await fulfillMockSessionWatch(
          page,
          route,
          { id: 'session-1', workspaceId: 'workspace-1' },
          watchedConversation(
            [
              {
                id: 'short:segment:0',
                turnId: 'short',
                index: 0,
                status: 'SUCCEEDED',
                items: [
                  {
                    id: 'short-answer',
                    kind: 'assistant_message',
                    status: 'COMPLETED',
                    payload: { text: 'Short history' }
                  }
                ]
              }
            ],
            'older-page'
          )
        );
      });
      await page.goto('/console');
      await page.getByRole('button', { name: '进入控制台' }).click();
      const work = page.getByRole('button', { name: '工作', exact: true });
      if (!mobile || (await work.getAttribute('aria-expanded')) !== 'true') await work.click();
      await page
        .locator('.workspace-tree')
        .getByRole('button', { name: /node-1/ })
        .click();
      const project = page
        .locator('.workspace-tree')
        .getByRole('button', { name: 'project', exact: true });
      if (mobile && (await work.getAttribute('aria-expanded')) !== 'true') await work.click();
      await project.click();
      if (mobile) await page.getByRole('button', { name: '打开会话列表' }).click();
      await page.locator('.session-list .session-link').first().click();
      const retry = page.locator('button.conversation-reload');
      await expect(retry).toBeVisible();
      await retry.focus();
      await retry.press('Enter');
      await expect(retry).toBeFocused();
      await expect(retry).toHaveAttribute('aria-busy', 'true');
      await expect(retry).toHaveText('');
      await expect(retry.locator('.mar-busy-indicator')).toHaveCount(1);
      await expect(page.locator('.conversation-loading-initial .mar-busy-indicator')).toHaveCount(
        0
      );
      await expect.poll(() => initialAttempts).toBe(2);
      await retry.press('Enter');
      expect(initialAttempts).toBe(2);
      releaseRetry();
      await expect(retry).toHaveAttribute('aria-busy', 'false');
      await expect(retry).toBeFocused();
      let olderAttempts = 0;
      let releaseOlder!: () => void;
      const olderReady = new Promise<void>((resolve) => {
        releaseOlder = resolve;
      });
      await page.route('**/api/agent-sessions/session-1/turns*', async (route) => {
        olderAttempts += 1;
        if (olderAttempts === 1) {
          await json(route, { segments: [], nextCursor: 'manual-older-page', snapshotSequence: 2 });
          return;
        }
        await olderReady;
        await json(route, { segments: [], nextCursor: null, snapshotSequence: 2 });
      });
      await retry.press('Enter');
      await expect(page.getByText('Short history', { exact: true })).toBeVisible();
      await expect(page.locator('.el-message')).toHaveCount(0, { timeout: 15_000 });
      await expect.poll(() => olderAttempts).toBe(1);
      const scroll = page.locator('.conversation-scroll');
      const history = scroll.locator('.conversation-history-control');
      await expect(history).toHaveText('');
      await expect(history.locator('button')).toHaveCount(0);
      expect(await scroll.evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(
        true
      );
      await scroll.focus();
      await scroll.press('PageUp');
      await expect(history).toHaveAttribute('aria-busy', 'true');
      // Reproduce the supported cross-tab locale update without reloading the pending request.
      await page.evaluate(() =>
        window.dispatchEvent(
          new StorageEvent('storage', {
            key: 'mar.locale.v2',
            newValue: 'en-US'
          })
        )
      );
      await expect(history).toHaveText('');
      await expect(scroll.getByRole('status', { name: 'Loading earlier messages…' })).toBeVisible();
      await expect(scroll).toBeFocused();
      await expect(history.locator('.mar-busy-indicator')).toHaveCount(1);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await expect(history.locator('.mar-busy-indicator')).toHaveCSS(
        'animation-name',
        'mar-busy-indicator-spin'
      );
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await expect(history.locator('.mar-busy-indicator')).toHaveCSS('animation-name', 'none');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await expect.poll(() => olderAttempts).toBe(2);
      await page.screenshot({ path: testInfo.outputPath('history-pending.png') });
      await scroll.press('PageUp');
      expect(olderAttempts).toBe(2);
      releaseOlder();
      await expect(history).toHaveCount(0);
      await expect(page.locator('.conversation-history-start')).toHaveCount(0);
      await expect(page.locator('.conversation-history-control .mar-busy-indicator')).toHaveCount(
        0
      );
    });
  });
}

test('Opening a session loads only the latest window without initial scroll backfill', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  const turnRequests: string[] = [];
  let watchReads = 0;
  let releaseInitialTurns!: () => void;
  const initialTurnsReady = new Promise<void>((resolve) => {
    releaseInitialTurns = resolve;
  });
  page.on('request', (request) => {
    if (request.url().includes('/api/agent-sessions/session-1/turns'))
      turnRequests.push(request.url());
  });
  await page.route('**/api/agent-sessions/session-1/watch*', async (route) => {
    watchReads += 1;
    const segments = Array.from({ length: 10 }, (_, index) => ({
      id: `turn-${index + 1}:segment:0`,
      turnId: `turn-${index + 1}`,
      index: 0,
      status: 'SUCCEEDED',
      items: [
        {
          id: `item-${index + 1}`,
          kind: 'assistant_message',
          status: 'COMPLETED',
          payload: { text: `第 ${index + 1} 条最新窗口记录：${'内容 '.repeat(40)}` }
        }
      ]
    }));
    if (watchReads > 1) {
      segments.push({
        id: 'turn-11:segment:0',
        turnId: 'turn-11',
        index: 0,
        status: 'SUCCEEDED',
        items: [
          {
            id: 'item-11',
            kind: 'assistant_message',
            status: 'COMPLETED',
            payload: { text: '重新打开后读取的最新消息' }
          }
        ]
      });
    }
    await initialTurnsReady;
    await fulfillMockSessionWatch(
      page,
      route,
      { id: 'session-1', workspaceId: 'workspace-1' },
      watchedConversation(segments, 'older-page')
    );
  });

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.locator('.session-list .session-link').first().click();
  await expect.poll(() => watchReads).toBe(1);
  releaseInitialTurns();
  await expect(page.getByText(/第 10 条最新窗口记录/)).toBeVisible();
  await expect(page.getByRole('status', { name: '正在加载会话记录…' })).toHaveCount(0);
  await expect
    .poll(() =>
      page
        .locator('.conversation-scroll')
        .evaluate((element) =>
          Math.abs(element.scrollHeight - element.scrollTop - element.clientHeight)
        )
    )
    .toBeLessThanOrEqual(1);

  await page.reload();
  await expect(page.getByText(/第 10 条最新窗口记录/)).toBeVisible();
  await expect(page.locator('.session-list .session-link.selected')).toHaveCount(1);
  const reopenedWatchReads = watchReads;

  expect(turnRequests.filter((url) => url.includes('&cursor=older-page'))).toHaveLength(0);
  const conversationScroll = page.locator('.conversation-scroll');
  let scrollTop = 0;
  await expect
    .poll(async () => {
      scrollTop = await conversationScroll.evaluate((element) => {
        element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 120);
        element.dispatchEvent(new Event('scroll'));
        return element.scrollTop;
      });
      return page.getByRole('button', { name: '回到最新' }).count();
    })
    .toBe(1);
  await expect(page.getByRole('button', { name: '回到最新' })).toBeVisible();
  const latestButtonBounds = await page
    .getByRole('button', { name: '回到最新' })
    .evaluate((button) => {
      const scroll = button.closest<HTMLElement>('.conversation-scroll-region');
      if (scroll === null) throw new Error('conversation scroll region is missing');
      const buttonRect = button.getBoundingClientRect();
      const scrollRect = scroll.getBoundingClientRect();
      return {
        buttonTop: buttonRect.top,
        buttonBottom: buttonRect.bottom,
        buttonWidth: buttonRect.width,
        buttonHeight: buttonRect.height,
        scrollTop: scrollRect.top,
        scrollBottom: scrollRect.bottom
      };
    });
  expect(latestButtonBounds.buttonTop).toBeGreaterThanOrEqual(latestButtonBounds.scrollTop);
  expect(latestButtonBounds.buttonBottom).toBeLessThanOrEqual(latestButtonBounds.scrollBottom);
  expect(latestButtonBounds.scrollBottom - latestButtonBounds.buttonBottom).toBeLessThanOrEqual(16);
  expect(latestButtonBounds.buttonWidth).toBeLessThan(120);
  expect(latestButtonBounds.buttonHeight).toBeLessThanOrEqual(36);
  await page.waitForTimeout(250);
  expect(watchReads).toBe(reopenedWatchReads);
  await expect(page.getByText('重新打开后读取的最新消息')).toBeVisible();
  expect(scrollTop).toBeGreaterThanOrEqual(0);
  let olderAttempts = 0;
  let releaseOlder!: () => void;
  const olderReady = new Promise<void>((resolve) => {
    releaseOlder = resolve;
  });
  await page.route('**/api/agent-sessions/session-1/turns*', async (route) => {
    olderAttempts += 1;
    if (olderAttempts === 1) {
      await olderReady;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'TEMPORARILY_UNAVAILABLE', message: 'History unavailable' }
        })
      });
    } else {
      await json(route, { segments: [], nextCursor: null, snapshotSequence: 2 });
    }
  });
  await expect(page.getByRole('button', { name: '加载更早记录' })).toHaveCount(0);
  await conversationScroll.focus();
  await conversationScroll.press('Home');
  const historyLoading = page.locator('.conversation-history-control .mar-busy-indicator');
  await expect(historyLoading).toBeVisible();
  await expect(page.locator('.conversation-history-control')).toHaveText('');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(historyLoading).not.toHaveCSS('animation-name', 'none');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(historyLoading).toHaveCSS('animation-name', 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(page.locator('.conversation-history-control .mar-busy-indicator')).toHaveCount(1);
  expect(
    await historyLoading.evaluate((element) => {
      const reference = document.createElement('span');
      reference.style.color = 'var(--mar-color-brand-text)';
      element.append(reference);
      const expected = getComputedStyle(reference).color;
      reference.remove();
      return getComputedStyle(element).color === expected;
    })
  ).toBe(true);
  await expect(conversationScroll).toBeFocused();
  await expect(page.locator('.conversation-history-control')).toHaveAttribute('aria-busy', 'true');
  await conversationScroll.press('Home');
  expect(olderAttempts).toBe(1);
  releaseOlder();
  await expect(page.locator('.conversation-history-error')).toHaveText('加载失败，点击重试');
  await conversationScroll.evaluate((element) => element.dispatchEvent(new Event('scroll')));
  const retryOlder = page.locator('.conversation-history-control button');
  await expect(retryOlder).toBeVisible();
  expect(olderAttempts).toBe(1);
  await retryOlder.click();
  await expect(page.locator('.conversation-history-control')).toHaveCount(0);
  await expect(page.getByText('已到最早消息', { exact: true })).toHaveCount(0);
  await expect(conversationScroll).toBeFocused();
  expect(olderAttempts).toBe(2);
  await expect(page.locator('.conversation-history-error')).toHaveCount(0);
  for (const reducedMotion of ['no-preference', 'reduce'] as const) {
    await page.emulateMedia({ reducedMotion });
    await conversationScroll.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
    const latest = page.locator('.conversation-latest');
    await expect(latest).toBeVisible();
    const leave = await latest.evaluate(async (button: HTMLButtonElement) => {
      button.click();
      await Promise.resolve();
      return { className: button.className, duration: getComputedStyle(button).transitionDuration };
    });
    expect(leave.className).toContain('conversation-latest-leave-active');
    expect(leave.duration).toBe(reducedMotion === 'reduce' ? '0s' : '0.16s, 0.16s');
    await expect(latest).toHaveCount(0);
  }
});

test('Switching from a paginated session to a new draft hides history backfill', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  await page.route('**/api/agent-sessions/session-1/turns*', (route) =>
    json(route, { segments: [], nextCursor: 'older-page', snapshotSequence: 2 })
  );
  await page.route('**/api/agent-sessions/session-1/watch*', (route) =>
    fulfillMockSessionWatch(
      page,
      route,
      { id: 'session-1', workspaceId: 'workspace-1' },
      watchedConversation(
        [
          {
            id: 'current:segment:0',
            turnId: 'current',
            index: 0,
            status: 'SUCCEEDED',
            items: [
              {
                id: 'current-message',
                kind: 'assistant_message',
                status: 'COMPLETED',
                payload: { text: '当前页会话内容' }
              }
            ]
          }
        ],
        'older-page'
      )
    )
  );

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.locator('.session-list .session-link').first().click();
  const historyTrigger = page.locator('.conversation-history-control');
  await expect(historyTrigger).toBeVisible();
  await expect(historyTrigger.locator('button')).toHaveCount(0);

  await page.getByRole('button', { name: '新建会话', exact: true }).click();

  await expect(page.getByRole('heading', { name: '新建会话' })).toBeVisible();
  await expect(historyTrigger).toHaveCount(0);
  await expect(page.getByRole('button', { name: '加载更早记录' })).toHaveCount(0);
});

test('New session drafts ignore late history pagination responses from the previous session', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  let receivedWatchRequest = false;
  let releaseWatchRequest: (() => void) | undefined;
  const watchRequest = new Promise<void>((resolve) => {
    releaseWatchRequest = resolve;
  });
  await page.route('**/api/agent-sessions/session-1/watch*', async (route) => {
    receivedWatchRequest = true;
    await watchRequest;
    await fulfillMockSessionWatch(
      page,
      route,
      { id: 'session-1', workspaceId: 'workspace-1' },
      watchedConversation([], 'older-page')
    );
  });

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.locator('.session-list .session-link').first().click();
  await expect.poll(() => receivedWatchRequest).toBe(true);

  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  releaseWatchRequest?.();

  await expect(page.getByRole('heading', { name: '新建会话' })).toBeVisible();
  await expect(page.getByRole('button', { name: '加载更早记录' })).toHaveCount(0);
});

test('Reselecting the active session does not recreate its Session Watch', async ({ page }) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  let watchReads = 0;
  await page.route('**/api/agent-sessions/session-1/watch*', async (route) => {
    watchReads += 1;
    await fulfillMockSessionWatch(
      page,
      route,
      { id: 'session-1', workspaceId: 'workspace-1' },
      watchedConversation([
        {
          id: 'turn-1:segment:0',
          turnId: 'turn-1',
          index: 0,
          status: 'SUCCEEDED',
          items: [
            {
              id: 'reply-1',
              kind: 'assistant_message',
              status: 'COMPLETED',
              payload: { text: '当前快照回复' }
            }
          ]
        }
      ])
    );
  });

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  const session = page.locator('.session-list .session-link').first();
  await session.click();
  await expect(page.getByText('当前快照回复', { exact: true })).toBeVisible();
  await session.click();

  await expect.poll(() => watchReads).toBe(1);
  await expect(page.getByText('当前快照回复', { exact: true })).toBeVisible();
});

test('Live history backfill inserts old Segments in Node order rather than after the current reply', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  const current = {
    id: 'current:segment:0',
    turnId: 'current',
    index: 0,
    runId: 'run-1',
    status: 'RUNNING',
    items: [
      {
        id: 'current-reply',
        kind: 'assistant_message',
        status: 'IN_PROGRESS',
        payload: { text: '当前实时回复' }
      }
    ]
  };
  const earlier = {
    id: 'earlier:segment:0',
    turnId: 'earlier',
    index: 0,
    runId: null,
    status: 'SUCCEEDED',
    items: [
      {
        id: 'earlier-reply',
        kind: 'assistant_message',
        status: 'COMPLETED',
        payload: { text: '上一轮历史回复' }
      }
    ]
  };
  await page.route('**/api/agent-sessions/session-1/watch*', (route) =>
    fulfillMockSessionWatch(
      page,
      route,
      { id: 'session-1', workspaceId: 'workspace-1' },
      watchedConversation([current])
    )
  );
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.locator('.session-list .session-link').first().click();
  await expect(page.getByText('当前实时回复', { exact: true })).toBeVisible();

  const hydrated = watchedConversation([earlier, current]);
  (hydrated.conversation as Record<string, unknown>).snapshotSequence = 2;
  await page.evaluate((snapshot) => {
    const socket = (
      window as unknown as {
        __consoleMockWorkbenchWebSocket?: {
          activeWatch?: Record<string, unknown>;
          acceptSessionWatch(watch: Record<string, unknown>, payload: unknown): void;
        };
      }
    ).__consoleMockWorkbenchWebSocket;
    if (socket?.activeWatch === undefined) throw new Error('Session Watch is not active');
    socket.acceptSessionWatch(socket.activeWatch, snapshot);
  }, hydrated);
  const messages = page.locator('.conversation-item.assistant_message');
  await expect(messages).toHaveCount(2);
  await expect(messages.nth(0)).toContainText('上一轮历史回复');
  await expect(messages.nth(1)).toContainText('当前实时回复');
});

test('Initial session snapshots do not overwrite realtime Turns received in flight', async ({
  page
}) => {
  await page.addInitScript(() => {
    class MockWorkbenchWebSocket extends EventTarget {
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      static readonly instances: MockWorkbenchWebSocket[] = [];
      static emitTurn() {
        const socket = MockWorkbenchWebSocket.instances.find((item) =>
          item.url.includes('/api/workbench/live')
        );
        const turn = {
          id: 'turn-1:segment:0',
          turnId: 'turn-1',
          segmentIndex: 0,
          sessionId: 'session-1',
          runId: 'run-1',
          status: 'RUNNING',
          items: [
            {
              id: 'reply-1',
              kind: 'assistant_message',
              status: 'IN_PROGRESS',
              payload: { text: '实时回复', format: 'markdown', model: null }
            }
          ]
        };
        socket?.dispatchEvent(
          new MessageEvent('message', {
            data: JSON.stringify({
              type: 'watch.event',
              event: {
                type: 'watch.session.event',
                workbenchConnectionId: 'mock-workbench-connection',
                watchId: 'mock-session-watch',
                nodeGeneration: 'mock-node-generation',
                nodeId: 'node-1',
                workspaceId: 'workspace-1',
                sessionId: 'session-1',
                expiresAt: Date.now() + 30_000,
                event: {
                  sequence: 2,
                  category: 'conversation',
                  payload: {
                    turn,
                    segments: [{ ...turn, index: 0 }]
                  }
                }
              }
            })
          })
        );
      }
      readonly url: string;
      readyState = MockWorkbenchWebSocket.OPEN;
      constructor(url: string) {
        super();
        this.url = url;
        MockWorkbenchWebSocket.instances.push(this);
        queueMicrotask(() => this.dispatchEvent(new Event('open')));
      }
      send() {}
      close() {
        this.readyState = MockWorkbenchWebSocket.CLOSED;
        this.dispatchEvent(new CloseEvent('close'));
      }
    }
    Object.defineProperty(window, 'WebSocket', {
      configurable: true,
      value: MockWorkbenchWebSocket
    });
    Object.defineProperty(window, '__workbenchWebSockets', {
      configurable: true,
      value: MockWorkbenchWebSocket
    });
  });
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'events.live', 'turn.start'], writes);
  let releaseSnapshot: (() => void) | undefined;
  const snapshotReady = new Promise<void>((resolve) => {
    releaseSnapshot = resolve;
  });
  let watchRequests = 0;
  await page.route('**/api/agent-sessions/session-1/watch*', async (route) => {
    watchRequests += 1;
    await snapshotReady;
    return fulfillMockSessionWatch(
      page,
      route,
      { id: 'session-1', workspaceId: 'workspace-1' },
      watchedConversation([
        {
          id: 'turn-1:segment:0',
          turnId: 'turn-1',
          runId: 'run-1',
          index: 0,
          status: 'RUNNING',
          items: [
            {
              id: 'reply-1',
              kind: 'assistant_message',
              status: 'IN_PROGRESS',
              payload: { text: '旧快照回复' }
            }
          ]
        }
      ])
    );
  });
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.locator('.session-list .session-link').first().click();
  await expect.poll(() => watchRequests).toBe(1);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __workbenchWebSockets: { instances: readonly unknown[] } })
            .__workbenchWebSockets.instances.length
      )
    )
    .toBeGreaterThan(0);
  await page.evaluate(() =>
    (
      window as unknown as { __workbenchWebSockets: { emitTurn(): void } }
    ).__workbenchWebSockets.emitTurn()
  );
  await expect(page.getByText('实时回复', { exact: true })).toHaveCount(0);
  releaseSnapshot?.();
  await expect(page.getByText('实时回复', { exact: true })).toBeVisible();
  await expect(page.getByText('旧快照回复', { exact: true })).toHaveCount(0);
});

test('Session lists initially show thirty entries and load more in descending activity order', async ({
  page
}) => {
  const writes: {
    readonly url: string;
    readonly csrf: string | undefined;
    readonly body: string;
  }[] = [];
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], writes);
  const now = Date.now();
  const activityOffsets = [10_000, 5 * 60_000, 2 * 60 * 60_000, 3 * 24 * 60 * 60_000];
  const sessions = Array.from({ length: 32 }, (_, index) => ({
    id: `session-${index + 1}`,
    workspaceId: 'workspace-1',
    runner: 'codex' as const,
    externalSessionId: `thread-${index + 1}`,
    runnerTitle: `会话 ${index + 1}`,
    lastActivityAt: now - (activityOffsets[index] ?? (index + 1) * 4 * 24 * 60 * 60_000),
    activity: 'IDLE' as const,
    control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
  }));
  await page.route('**/api/workspaces?nodeId=node-1', (route) =>
    json(route, {
      workspaces: [
        { id: 'workspace-1', path: '/project', kind: 'GIT_WORKSPACE' },
        { id: 'workspace-2', path: '/project-2', kind: 'DIRECTORY' }
      ]
    })
  );
  const sessionPageRequests: { readonly url: string; readonly watchSnapshot: boolean }[] = [];
  await page.route(/\/api\/agent-sessions\?nodeId=node-1(?:&.*)?$/, (route) => {
    const url = new URL(route.request().url());
    const cursor = url.searchParams.get('cursor');
    const workspaceId = url.searchParams.get('workspaceId');
    sessionPageRequests.push({
      url: route.request().url(),
      watchSnapshot: route.request().headers()['x-mar-e2e-workspace-watch-snapshot'] === '1'
    });
    if (workspaceId === 'workspace-2') return json(route, { sessions: [], nextCursor: null });
    return json(route, {
      sessions: cursor === null ? sessions.slice(0, 30) : sessions.slice(30),
      nextCursor: cursor === null ? 'page-2' : null
    });
  });
  const initialAdminRead = page.waitForResponse('**/api/auth/me');
  await page.goto('/console');
  await initialAdminRead;
  await page.getByRole('button', { name: '进入控制台' }).click();
  await expect(page.locator('.workspace-tree')).toBeVisible();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: 'project', exact: true })
    .click();

  const rows = page.locator('.session-list .session-link');
  await expect(rows).toHaveCount(30);
  await expect
    .poll(() =>
      page
        .locator('.session-title-row strong')
        .evaluateAll((items) => items.map((item) => item.textContent?.trim()))
    )
    .toEqual(Array.from({ length: 30 }, (_, index) => `会话 ${index + 1}`));
  await expect(
    page
      .locator('.session-relative-time')
      .evaluateAll((items) => items.slice(0, 4).map((item) => item.textContent?.trim()))
  ).resolves.toEqual(['<1m', '>5m', '>2h', '>3d']);
  await expect(page.getByRole('button', { name: '加载更多会话' })).toHaveText('加载更多');
  await page.getByRole('button', { name: '加载更多会话' }).click();
  await expect(rows).toHaveCount(32);
  await expect(page.getByRole('button', { name: '加载更多会话' })).toHaveCount(0);
  expect(sessionPageRequests).toHaveLength(2);
  expect(sessionPageRequests[0]).toMatchObject({ watchSnapshot: true });
  expect(sessionPageRequests[0]?.url).toContain('workspaceId=workspace-1&limit=30');
  expect(sessionPageRequests[1]).toMatchObject({ watchSnapshot: false });
  expect(sessionPageRequests[1]?.url).toContain('cursor=page-2');

  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: 'project-2', exact: true })
    .click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: 'project', exact: true })
    .click();
  await expect(rows).toHaveCount(32);
  expect(
    sessionPageRequests.some(
      (request) => request.watchSnapshot && request.url.includes('workspace-2')
    )
  ).toBe(true);
  expect(
    sessionPageRequests.filter((request) => request.url.includes('cursor=page-2'))
  ).toHaveLength(1);

  await page.getByRole('button', { name: '关闭 project', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: 'project', exact: true })
    .click();
  await expect(rows).toHaveCount(30);
  expect(
    sessionPageRequests.filter((request) => request.url.includes('cursor=page-2'))
  ).toHaveLength(1);
  expect(sessionPageRequests.at(-1)).toEqual(
    expect.objectContaining({ watchSnapshot: true, url: expect.stringContaining('workspace-1') })
  );
});

for (const recovery of ['切换会话', '断线重连', '可见性恢复'] as const) {
  test(`Consecutive Runs continue streaming after message insertion and ${recovery}`, async ({
    page
  }, testInfo) => {
    const writes: { url: string; csrf: string | undefined; body: string }[] = [];
    const capabilities = [
      'history.read',
      'events.live',
      'turn.start',
      'turn.steer',
      'turn.interrupt'
    ];
    await mockConsoleApi(
      page,
      'MANAGED',
      capabilities,
      writes,
      'GIT_WORKSPACE',
      true,
      'MANAGED_ACTIVE'
    );
    const active = {
      id: 'session-1',
      workspaceId: 'workspace-1',
      runner: 'codex',
      runnerTitle: '流式回归会话',
      externalSessionId: 'realtime-thread-1',
      activity: 'MANAGED_ACTIVE',
      control: { level: 'MANAGED', capabilities }
    };
    const other = {
      ...active,
      id: 'session-2',
      runnerTitle: '另一会话',
      externalSessionId: 'realtime-thread-2',
      activity: 'IDLE'
    };
    const run = {
      id: 'run-1',
      sessionId: active.id,
      workspaceId: active.workspaceId,
      status: 'RUNNING',
      recoveryState: 'ACTIVE',
      version: 1,
      clientMessageId: 'initial-message'
    };
    let inserted = false;
    let messageId = 'inserted-message';
    let reply = '';
    let initialCount = 0;
    const segments = () => [
      {
        id: 'older-turn:segment:3',
        turnId: 'older-turn',
        index: 3,
        runId: run.id,
        status: 'SUCCEEDED',
        items: [
          {
            id: 'older-reply',
            kind: 'assistant_message',
            status: 'COMPLETED',
            payload: { text: '先前 Agent 回复' }
          }
        ]
      },
      ...(inserted
        ? [
            {
              id: 'current-turn:segment:0',
              turnId: 'current-turn',
              index: 0,
              runId: run.id,
              status: 'RUNNING',
              items: [
                {
                  id: 'inserted-user',
                  kind: 'user_message',
                  status: 'COMPLETED',
                  payload: { text: '插入的新约束', clientMessageId: messageId }
                },
                ...(reply
                  ? [
                      {
                        id: 'current-reply',
                        kind: 'assistant_message',
                        status: 'IN_PROGRESS',
                        payload: { text: reply }
                      }
                    ]
                  : [])
              ]
            }
          ]
        : [])
    ];
    await page.route('**/api/agent-sessions?nodeId=node-1*', (route) =>
      json(route, { sessions: [active, other], nextCursor: null })
    );
    for (const session of [active, other]) {
      await page.route(`**/api/agent-sessions/${session.id}?nodeId=node-1`, (route) =>
        json(route, { session })
      );
      await page.route(`**/api/agent-sessions/${session.id}/watch*`, async (route) => {
        const request = route.request().postDataJSON() as { mode: string; watchId: string };
        if (request.mode === 'renew') {
          await json(route, {
            accepted: true,
            watchId: request.watchId,
            nodeGeneration: 'mock-node-generation',
            expiresAt: Date.now() + 30_000
          });
          return;
        }
        if (session.id === active.id) initialCount += 1;
        const sequence = await page.evaluate(
          () =>
            (window as unknown as { __consoleMockWorkbenchWebSocket: { sequence: number } })
              .__consoleMockWorkbenchWebSocket.sequence
        );
        const snapshot = watchedConversation(session.id === active.id ? segments() : []);
        const conversation = snapshot.conversation as Record<string, unknown>;
        await fulfillMockSessionWatch(page, route, session, {
          ...snapshot,
          sequence,
          session,
          runs: session.id === active.id ? [run] : [],
          conversation: { ...conversation, source: 'runtime', snapshotSequence: sequence }
        });
      });
    }
    await page.route('**/api/agent-sessions/session-1/messages', async (route) => {
      const body = route.request().postDataJSON() as {
        clientMessageId: string;
        deliveryIntent: string;
      };
      expect(body.deliveryIntent).toBe('REPLACE_CURRENT');
      messageId = body.clientMessageId;
      inserted = true;
      await json(route, { session: active, run, delivery: 'RESTARTING' });
    });
    await page.goto('/console');
    const documentTimeOrigin = await page.evaluate(() => performance.timeOrigin);
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
    await page.locator('.session-link').filter({ hasText: active.runnerTitle }).click();
    await expect(page.getByText('先前 Agent 回复', { exact: true })).toBeVisible();
    const input = page.getByRole('textbox', { name: '输入消息' });
    await input.fill('插入的新约束');
    const sent = page.waitForResponse((response) => response.url().endsWith('/session-1/messages'));
    await input.press('Control+Enter');
    await sent;
    const projected = (watchedConversation(segments()).conversation as { segments: unknown[] })
      .segments;
    await emitMockSessionEvent(page, 'conversation', {
      sessionId: active.id,
      turn: {
        id: 'current-turn',
        sessionId: active.id,
        runId: run.id,
        status: 'RUNNING',
        items: []
      },
      segments: projected
    });
    await expect(
      page.locator('.conversation-message').filter({ hasText: '插入的新约束' })
    ).toBeVisible();
    const emitText = async (text: string) => {
      reply += text;
      await emitMockSessionEvent(page, 'conversation', {
        sessionId: active.id,
        delta: {
          runId: run.id,
          turnId: 'current-turn',
          segmentId: 'current-turn:segment:0',
          segmentIndex: 0,
          itemId: 'current-reply',
          text,
          createdAt: Date.now()
        }
      });
      await expect(
        page.locator('.conversation-item.assistant_message').filter({ hasText: reply })
      ).toBeVisible();
    };
    await emitText('新回复第一段');
    const streaming = await page.evaluate(
      async ({ runId }) => {
        const socket = (
          window as unknown as {
            __consoleMockWorkbenchWebSocket: {
              emitSessionEvent(category: string, payload: unknown): boolean;
            };
          }
        ).__consoleMockWorkbenchWebSocket;
        const message = [...document.querySelectorAll('.assistant_message .agent-markdown')].at(
          -1
        )!;
        const latencies: number[] = [];
        let batchStarted = performance.now();
        const observer = new MutationObserver(() =>
          latencies.push(performance.now() - batchStarted)
        );
        observer.observe(message, { childList: true, subtree: true, characterData: true });
        const chunk = ' Smooth frame-batched streaming.';
        for (let batch = 0; batch < 8; batch++) {
          batchStarted = performance.now();
          for (let index = 0; index < 5; index++) {
            if (
              !socket.emitSessionEvent('conversation', {
                sessionId: 'session-1',
                delta: {
                  runId,
                  turnId: 'current-turn',
                  segmentId: 'current-turn:segment:0',
                  segmentIndex: 0,
                  itemId: 'current-reply',
                  text: chunk,
                  createdAt: Date.now()
                }
              })
            )
              throw new Error('Mock Session Watch is not active');
          }
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
        }
        observer.disconnect();
        return { appended: chunk.repeat(40), latencies };
      },
      { runId: run.id }
    );
    reply += streaming.appended;
    await expect(page.locator('.assistant_message .agent-markdown').last()).toContainText(reply);
    expect(streaming.latencies.length).toBeGreaterThan(0);
    expect(streaming.latencies.length).toBeLessThanOrEqual(8);
    await testInfo.attach('streaming-frame-batching', {
      body: JSON.stringify({ deltas: 40, ...streaming, appended: undefined }),
      contentType: 'application/json'
    });
    const order = async () => {
      const texts = await page.locator('.conversation-item').allTextContents();
      const before = texts.findIndex((value) => value.includes('先前 Agent 回复'));
      const user = texts.findIndex((value) => value.includes('插入的新约束'));
      const agent = texts.findIndex((value) => value.includes(reply));
      expect(before).toBeGreaterThanOrEqual(0);
      expect(user).toBeGreaterThan(before);
      expect(agent).toBeGreaterThan(user);
      expect(texts.filter((value) => value.includes(reply))).toHaveLength(1);
    };
    await order();
    expect(initialCount).toBe(1);
    for (let round = 0; round < 3; round += 1) {
      const previousInitialCount = initialCount;
      if (recovery === '切换会话') {
        await page.locator('.session-link').filter({ hasText: other.runnerTitle }).click();
        await expect(
          page.getByRole('heading', { name: other.runnerTitle, exact: true })
        ).toBeVisible();
        await page.locator('.session-link').filter({ hasText: active.runnerTitle }).click();
      } else if (recovery === '断线重连') {
        await page.evaluate(() =>
          (
            window as unknown as {
              __consoleMockWorkbenchWebSocket: { closeActive(): void };
            }
          ).__consoleMockWorkbenchWebSocket.closeActive()
        );
      } else {
        // Exercise the browser visibility handler with controlled lifecycle events.
        await page.evaluate(() => {
          Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            get: () => 'hidden'
          });
          document.dispatchEvent(new Event('visibilitychange'));
        });
        await page.evaluate(() => {
          Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            get: () => 'visible'
          });
          document.dispatchEvent(new Event('visibilitychange'));
        });
      }
      await expect.poll(() => initialCount).toBeGreaterThan(previousInitialCount);
      await expect(
        page.locator('.conversation-item.assistant_message').filter({ hasText: reply })
      ).toBeVisible();
      await emitText(`，恢复后第${round + 1}段`);
      await order();
    }
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(documentTimeOrigin);
    await expect(page.locator('.composer-working')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('realtime-recovery.png'), fullPage: true });
  });
}
