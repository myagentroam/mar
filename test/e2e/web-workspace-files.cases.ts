import { expect, test, type Locator } from '@playwright/test';
import {
  emitMockSessionEvent,
  fulfillMockWorkspaceWatch,
  mockConsoleApi,
  json
} from './support/web-console-api.js';

// Files, Git, uploads, and the resource tree

test('samples first and warm mobile Files opening with a populated directory', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], [], 'DIRECTORY', true);
  const entries = Array.from({ length: 180 }, (_, index) => ({
    path: `file-${String(index).padStart(3, '0')}.ts`,
    name: `file-${String(index).padStart(3, '0')}.ts`,
    kind: 'FILE',
    size: 25,
    modifiedAt: 1
  }));
  await page.route(/\/api\/workspaces\/workspace-1\/files(?:\?.*)?$/, (route) =>
    json(route, { files: { entries, nextCursor: null, truncated: false } })
  );
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.getByRole('button', { name: '打开会话列表' }).click();
  await page.locator('.session-link').first().click();
  await expect(page.getByText('正在同步对话', { exact: true })).toBeVisible();
  await page.waitForTimeout(700);
  const open = page.getByRole('button', { name: '打开辅助工作面' });
  const aside = page.locator('.workspace-aside');
  const cdp = process.env.MAR_FILES_TRACE === '1' ? await page.context().newCDPSession(page) : null;
  if (cdp) await cdp.send('Profiler.enable');
  const results: Array<{
    firstFrame: number;
    frames: number[];
    longTasks: number[];
    nodes: number;
  }> = [];
  for (const phase of ['first', 'warm']) {
    const before = await page.evaluate(() => ({
      nodes: document.querySelectorAll('*').length,
      poppers: document.querySelectorAll('.el-popper').length,
      markdown: document.querySelectorAll('.agent-markdown').length
    }));
    await page.evaluate(() => {
      const main = document.querySelector('.conversation-panel');
      if (!main) throw new Error('MAIN_PANEL_MISSING');
      const markdown = [...main.querySelectorAll('.agent-markdown')];
      const state = { added: 0, removed: 0, markdown, observer: new MutationObserver(() => {}) };
      state.observer = new MutationObserver((records) => {
        for (const record of records) {
          state.added += record.addedNodes.length;
          state.removed += record.removedNodes.length;
        }
      });
      state.observer.observe(main, { childList: true, subtree: true });
      (window as unknown as { __mainMutationSample: typeof state }).__mainMutationSample = state;
    });
    if (cdp) {
      await cdp.send('Profiler.start');
      await cdp.send('Tracing.start', {
        categories: 'devtools.timeline,v8,blink.user_timing',
        transferMode: 'ReturnAsStream'
      });
    }
    await open.evaluate((element) => {
      element.addEventListener(
        'click',
        () => {
          const state = {
            firstFrame: 0,
            frames: [] as number[],
            longTasks: [] as number[],
            nodes: 0,
            stop: () => {}
          };
          (window as unknown as { __filesOpenSample: typeof state }).__filesOpenSample = state;
          const started = performance.now();
          let last = 0;
          let running = true;
          const observer = new PerformanceObserver((list) =>
            state.longTasks.push(...list.getEntries().map((entry) => entry.duration))
          );
          observer.observe({ type: 'longtask' });
          const frame = (time: number) => {
            if (!running) return;
            if (!state.firstFrame) state.firstFrame = performance.now() - started;
            if (last) state.frames.push(time - last);
            last = time;
            requestAnimationFrame(frame);
          };
          requestAnimationFrame(frame);
          state.stop = () => {
            running = false;
            observer.disconnect();
            state.nodes = document.querySelectorAll('*').length;
          };
        },
        { once: true, capture: true }
      );
    });
    await open.click();
    await page.waitForTimeout(700);
    results.push(
      await page.evaluate(() => {
        const state = (
          window as unknown as {
            __filesOpenSample: {
              firstFrame: number;
              frames: number[];
              longTasks: number[];
              nodes: number;
              stop(): void;
            };
          }
        ).__filesOpenSample;
        state.stop();
        return {
          firstFrame: state.firstFrame,
          frames: state.frames,
          longTasks: state.longTasks,
          nodes: state.nodes
        };
      })
    );
    if (cdp) {
      const profile = await cdp.send('Profiler.stop');
      await test.info().attach(`mobile-files-${phase}-cpu.json`, {
        body: JSON.stringify(profile.profile),
        contentType: 'application/json'
      });
      const tracingComplete = new Promise<{ stream?: string }>((resolve) =>
        cdp.once('Tracing.tracingComplete', resolve)
      );
      await cdp.send('Tracing.end');
      const { stream } = await tracingComplete;
      if (!stream) throw new Error('TRACE_STREAM_MISSING');
      let trace = '';
      for (;;) {
        const chunk = await cdp.send('IO.read', { handle: stream });
        trace += chunk.base64Encoded
          ? Buffer.from(chunk.data, 'base64').toString('utf8')
          : chunk.data;
        if (chunk.eof) break;
      }
      await cdp.send('IO.close', { handle: stream });
      const events = (
        JSON.parse(trace) as {
          traceEvents: Array<{ name: string; ph: string; dur?: number; args?: unknown }>;
        }
      ).traceEvents;
      await test.info().attach(`mobile-files-${phase}-trace.json`, {
        body: trace,
        contentType: 'application/json'
      });
      await test.info().attach(`mobile-files-${phase}-top-events.json`, {
        body: JSON.stringify(
          events
            .filter((event) => event.ph === 'X' && (event.dur ?? 0) >= 10_000)
            .sort((a, b) => (b.dur ?? 0) - (a.dur ?? 0))
            .slice(0, 30)
        ),
        contentType: 'application/json'
      });
    }
    await expect(aside).toBeVisible();
    await expect(aside.getByRole('treeitem', { name: 'file-000.ts' })).toBeVisible();
    await test.info().attach(`mobile-files-${phase}-geometry.json`, {
      body: JSON.stringify(
        await aside.locator('.workspace-file-tree').evaluate((tree) => ({
          clientHeight: tree.clientHeight,
          scrollHeight: tree.scrollHeight,
          renderedRows: tree.querySelectorAll('.file-tree-row').length,
          asideNodes: tree.closest('.workspace-aside')?.querySelectorAll('*').length,
          tooltipNodes: document.querySelectorAll('.el-popper').length,
          markdownNodes: document.querySelectorAll('.agent-markdown').length,
          bounds: tree.getBoundingClientRect().toJSON()
        }))
      ),
      contentType: 'application/json'
    });
    await test.info().attach(`mobile-files-${phase}-before.json`, {
      body: JSON.stringify(before),
      contentType: 'application/json'
    });
    await test.info().attach(`mobile-files-${phase}-main-mutations.json`, {
      body: JSON.stringify(
        await page.evaluate(() => {
          const state = (
            window as unknown as {
              __mainMutationSample: {
                added: number;
                removed: number;
                markdown: Element[];
                observer: MutationObserver;
              };
            }
          ).__mainMutationSample;
          state.observer.disconnect();
          return {
            added: state.added,
            removed: state.removed,
            markdownConnected: state.markdown.map((node) => node.isConnected)
          };
        })
      ),
      contentType: 'application/json'
    });
    expect(
      await aside
        .locator('.file-tree-virtual-space')
        .evaluate((element) => element.getBoundingClientRect().height)
    ).toBeGreaterThan(4000);
    const more = aside.getByRole('button', { name: 'file-000.ts 更多操作' });
    const copyPath = page.getByRole('menuitem', { name: '复制相对路径' });
    await more.click();
    await expect(copyPath).toBeVisible();
    const openedMenu = await copyPath.evaluateHandle((element) =>
      element.closest('.el-dropdown__popper')
    );
    await test.info().attach(`mobile-files-${phase}-menu-focus.json`, {
      body: JSON.stringify(
        await page.evaluate(() => ({
          active: document.activeElement?.outerHTML.slice(0, 500),
          inDropdown: document.activeElement?.closest('.el-dropdown__popper') !== null
        }))
      ),
      contentType: 'application/json'
    });
    await page.keyboard.press('Escape');
    await expect(copyPath).toBeHidden();
    await expect.poll(() => openedMenu.evaluate((element) => element?.isConnected)).toBe(false);
    await expect(more).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(copyPath).toBeVisible();
    await expect(
      page.locator('.el-dropdown__popper :is([role="menu"], [role="menuitem"]):focus')
    ).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await test.info().attach(`mobile-files-${phase}-keyboard-focus.json`, {
      body: JSON.stringify(
        await page.evaluate(() => ({ active: document.activeElement?.outerHTML.slice(0, 600) }))
      ),
      contentType: 'application/json'
    });
    await expect(page.locator('.el-dropdown__popper [role="menuitem"]:focus')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(copyPath).toBeHidden();
    await aside.getByRole('treeitem', { name: 'file-000.ts' }).click({ button: 'right' });
    await expect(copyPath).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(copyPath).toBeHidden();
    await expect(more).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(aside).toBeHidden();
    await expect(page.getByText('正在同步对话', { exact: true })).toBeVisible();
    await page.waitForTimeout(700);
  }
  await test.info().attach('mobile-files-open-samples.json', {
    body: JSON.stringify(results),
    contentType: 'application/json'
  });
  expect(
    results.every((sample) => sample.firstFrame > 0 && sample.frames.length > 5),
    JSON.stringify(results)
  ).toBe(true);
});

test('Hiding a constrained Aside preserves the dirty file window and its owner', async ({
  page
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], [], 'GIT_WORKSPACE', true);
  await page.route(/\/api\/workspaces\/workspace-1\/files\/read(?:\?.*)?$/, (route) =>
    json(route, {
      file: {
        path: 'src/main.ts',
        encoding: 'utf-8',
        size: 6,
        content: 'source',
        truncated: false,
        nextOffset: null,
        revision: 'a'.repeat(64)
      }
    })
  );
  await page.goto('/console');
  await page.getByLabel('密码').fill('test-password');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.locator('.file-tree-row[data-file-path="src/main.ts"]').click();
  const editor = page.locator('.workspace-file-tabs .cm-content');
  await editor.fill('unsaved aside content');
  await editor.evaluate((element) => {
    (window as unknown as { asideEditor: Element }).asideEditor = element;
  });
  await page.setViewportSize({ width: 768, height: 900 });
  await expect(page.locator('.workspace-aside')).toBeHidden();
  const main = page.locator('.workspace-grid > .conversation-panel');
  await expect(main).toBeVisible();
  await expect
    .poll(async () => {
      const gridBounds = await page.locator('.workspace-grid').boundingBox();
      const mainBounds = await main.boundingBox();
      return Math.abs((gridBounds?.height ?? 0) - (mainBounds?.height ?? 0));
    })
    .toBeLessThanOrEqual(2);
  await expect(editor).toContainText('unsaved aside content');
  expect(
    await editor.evaluate(
      (element) => element === (window as unknown as { asideEditor: Element }).asideEditor
    )
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('.workspace-aside')).toBeVisible();
  await expect(editor).toContainText('unsaved aside content');
  await page.getByRole('button', { name: '关闭文件窗口', exact: true }).click();
  await expect(page.locator('.el-message-box')).toContainText('未保存的修改');
  await page.locator('.el-message-box__btns').getByRole('button', { name: '取消' }).click();
  await expect(editor).toContainText('unsaved aside content');
});

test('Wide session sidebar stays stable when the Aside hides and restores its content width', async ({
  page
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 2400, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem(
      'mar.workbench.panel-widths.v1',
      JSON.stringify({ sidebar: 420, content: 760 })
    );
  });
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], [], 'GIT_WORKSPACE', true);
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  const aside = page.locator('.workspace-aside');
  const grid = page.locator('.workspace-grid');
  const sidebar = page.locator('.conversation-sidebar');
  await grid.evaluate((element) =>
    (element as HTMLElement).style.setProperty('--mar-session-sidebar-width', '420px')
  );
  await aside.getByRole('tab', { name: '终端', exact: true }).click();
  await expect
    .poll(() => aside.evaluate((element) => Math.round(element.getBoundingClientRect().width)))
    .toBe(760);
  const terminalDock = page.locator('.terminal-dock');
  await expect(terminalDock).toBeVisible();
  const terminalOwner = await terminalDock.elementHandle();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(aside).toBeHidden();
  await expect(terminalDock).toBeHidden();
  await expect
    .poll(() => sidebar.evaluate((element) => Math.round(element.getBoundingClientRect().width)))
    .toBe(420);
  const stability = await grid.evaluate(async (element) => {
    const samples: number[] = [];
    for (let index = 0; index < 8; index++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      samples.push(element.querySelector('.workspace-aside')!.getBoundingClientRect().width);
    }
    return samples;
  });
  expect(stability).toEqual(Array(8).fill(0));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '打开辅助工作面', exact: true }).click();
  await expect(aside).toBeVisible();
  await expect(terminalDock).toBeVisible();
  expect(await terminalDock.evaluate((element, owner) => element === owner, terminalOwner)).toBe(
    true
  );
  await aside.getByRole('button', { name: '关闭工作区工具', exact: true }).click();
  await expect(aside).toBeHidden();
  await page.setViewportSize({ width: 2400, height: 900 });
  await expect(aside).toBeVisible();
  await expect(terminalDock).toBeVisible();
  expect(await terminalDock.evaluate((element, owner) => element === owner, terminalOwner)).toBe(
    true
  );
  await expect
    .poll(() => aside.evaluate((element) => Math.round(element.getBoundingClientRect().width)))
    .toBe(760);
});

test('Quick Open filters match Workspace Tab selection and tab labels keep their descenders', async ({
  page
}, testInfo) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await page.route('**/api/workspaces?nodeId=node-1', (route) =>
    json(route, {
      workspaces: [{ id: 'workspace-1', path: '/MyAgentRoam-gypqj', kind: 'GIT_WORKSPACE' }]
    })
  );
  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'MyAgentRoam-gypqj' }).click();

  for (const width of [1365, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(() => document.fonts.ready);
    const workspaceTab = page.locator('.workspace-tab.active:visible').first();
    const label = workspaceTab.locator('.workspace-tab-content > span');
    await expect(label).toHaveText('MyAgentRoam-gypqj');
    const tabText = workspaceTab.locator(
      '.workspace-tab-content > span, .workspace-tab-node:not(.direct-available-node), .workspace-tab-node-label'
    );
    for (const textElement of await tabText.all()) {
      const labelBounds = await textElement.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const text = range.getBoundingClientRect();
        const clip = element.getBoundingClientRect();
        const tab = element.closest('.workspace-tab')!.getBoundingClientRect();
        let clipTop = clip.top;
        let clipBottom = clip.bottom;
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          if (!['hidden', 'auto', 'scroll', 'clip'].includes(getComputedStyle(parent).overflowY))
            continue;
          const bounds = parent.getBoundingClientRect();
          clipTop = Math.max(clipTop, bounds.top);
          clipBottom = Math.min(clipBottom, bounds.bottom);
        }
        return {
          textTop: text.top,
          textBottom: text.bottom,
          clipTop,
          clipBottom,
          tabTop: tab.top,
          tabBottom: tab.bottom
        };
      });
      expect(labelBounds.textTop).toBeGreaterThanOrEqual(labelBounds.clipTop);
      expect(labelBounds.textBottom).toBeLessThanOrEqual(labelBounds.clipBottom);
      expect(labelBounds.clipTop).toBeGreaterThanOrEqual(labelBounds.tabTop);
      expect(labelBounds.clipBottom).toBeLessThanOrEqual(labelBounds.tabBottom);
    }
    await workspaceTab.screenshot({
      path: testInfo.outputPath('workspace-descenders-' + width + '.png')
    });

    for (const scheme of ['daylight', 'vscode-dark-2026', 'custom']) {
      await page.evaluate((value) => {
        document.documentElement.setAttribute(
          'data-theme',
          value === 'custom' ? 'vscode-dark-2026' : value
        );
        document.documentElement.classList.toggle('dark', value !== 'daylight');
        if (value === 'custom') {
          document.documentElement.style.setProperty('--mar-fill-selection', '#294039');
          document.documentElement.style.setProperty('--mar-text-primary', '#d8e9df');
        } else {
          document.documentElement.style.removeProperty('--mar-fill-selection');
          document.documentElement.style.removeProperty('--mar-text-primary');
        }
      }, scheme);
      const reference = await workspaceTab.evaluate((element) => {
        const swatch = document.createElement('span');
        swatch.style.backgroundColor = 'var(--mar-fill-selection)';
        element.append(swatch);
        const background = getComputedStyle(swatch).backgroundColor;
        swatch.remove();
        return {
          background,
          color: getComputedStyle(element.querySelector('button')!).color,
          weight: getComputedStyle(element.querySelector('.workspace-tab-content > span')!)
            .fontWeight,
          radius: getComputedStyle(element).borderRadius
        };
      });
      await page.keyboard.press('Control+Shift+O');
      const dialog = page.getByRole('dialog', { name: '快速打开', exact: true });
      const filters = dialog.getByRole('tablist');
      await expect(filters).toBeVisible();
      const selectedResult = dialog.locator('.quick-open-results li[aria-selected="true"] button');
      await expect(selectedResult).toHaveCount(1);
      await expect(selectedResult).toHaveCSS('background-color', reference.background);
      await expect(selectedResult).toHaveCSS('color', reference.color);
      await expect(selectedResult).toHaveCSS('border-radius', reference.radius);
      await expect(selectedResult).toHaveCSS('box-shadow', 'none');
      await selectedResult.hover();
      await expect(selectedResult).toHaveCSS('background-color', reference.background);
      for (const filter of await filters.getByRole('tab').all()) {
        await filter.click();
        await expect(filter).toHaveAttribute('aria-selected', 'true');
        await expect(filter).toHaveCSS('background-color', reference.background);
        await expect(filter).toHaveCSS('color', reference.color);
        await expect(filter).toHaveCSS('font-weight', reference.weight);
        await expect(filter).toHaveCSS('border-radius', reference.radius);
        await filter.hover();
        await expect(filter).toHaveCSS('background-color', reference.background);
        await filter.press('Tab');
        await page.keyboard.press('Shift+Tab');
        await expect(filter).toBeFocused();
        await expect(filter).toHaveCSS('outline-style', 'solid');
        await expect(filter).toHaveCSS('outline-width', '2px');
      }
      await dialog.screenshot({
        path: testInfo.outputPath('quick-open-tabs-' + scheme + '-' + width + '.png')
      });
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    }
  }
});

test('File navigation uses rounded selection and the editor fills its surface with themed text selection', async ({
  page
}, testInfo) => {
  await mockConsoleApi(
    page,
    'MANAGED',
    ['history.read', 'turn.start'],
    [],
    'GIT_WORKSPACE',
    true,
    undefined,
    undefined,
    '0.9.12'
  );
  await page.route(/\/api\/workspaces\/workspace-1\/files\/read(?:\?.*)?$/, (route) =>
    json(route, {
      file: {
        path: 'src/main.ts',
        encoding: 'utf-8',
        size: 25,
        content: 'export const answer = 42;',
        truncated: false,
        nextOffset: null,
        revision: 'a'.repeat(64)
      }
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
  const file = page.getByRole('treeitem', { name: 'src/main.ts', exact: true });
  await expect(file).toContainText('main.ts');
  await expect(page.locator('.workspace-tree .tree-node').first()).toHaveCSS('font-weight', '400');
  const workspaceName = page.locator('.workspace-tree .workspace-branch-button').first();
  await expect(workspaceName).toHaveCSS('font-weight', '400');
  await expect(workspaceName).toHaveCSS('font-size', '13px');
  await expect(page.locator('.workbench-aside-tabs').getByRole('tab').first()).toHaveCSS(
    'font-size',
    '12px'
  );
  await expect(page.locator('.workbench-aside-tabs').getByRole('tab').first()).toHaveCSS(
    'font-weight',
    '500'
  );
  await expect(page.locator('.file-explorer .file-display-filter')).toBeVisible();
  await expect(page.locator('.workspace-tab-content > span').first()).toHaveCSS(
    'font-weight',
    '400'
  );
  await expect(page.locator('.workspace-tab-content > span').first()).toHaveCSS(
    'font-size',
    '13px'
  );
  await expect(page.locator('.workspace-tab small').first()).toHaveCSS('font-size', '11px');
  await expect(page.locator('.workbench-brand')).toHaveCSS('height', '44px');
  const brandFits = await page.locator('.workbench-brand').evaluate((element) => {
    const header = element.getBoundingClientRect();
    const copy = element.querySelector('.brand-copy')!.getBoundingClientRect();
    return copy.top >= header.top && copy.bottom <= header.bottom;
  });
  expect(brandFits).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('aligned-workbench-header.png') });
  await file.click();
  await expect(page.locator('.file-tree-row-shell.selected').first()).toHaveCSS(
    'border-radius',
    '6px'
  );
  const preview = page.getByRole('dialog', { name: 'src/main.ts 文件预览' });
  const editor = preview.locator('.cm-content');
  await expect(editor).toBeVisible();
  await expect(editor).toContainText('export const answer = 42;');
  for (const theme of ['vscode-light-2026', 'vscode-dark-2026']) {
    await page.evaluate(
      (value) => document.documentElement.setAttribute('data-theme', value),
      theme
    );
    const tabSelection = await page
      .locator('.workspace-tab.active')
      .first()
      .evaluate((tab) => {
        const reference = document.createElement('span');
        reference.style.backgroundColor = 'var(--mar-fill-selection)';
        tab.append(reference);
        const background = getComputedStyle(reference).backgroundColor;
        reference.remove();
        return {
          background,
          radius: getComputedStyle(tab).borderRadius,
          color: getComputedStyle(tab.querySelector('button')!).color
        };
      });
    const selectedRow = page.locator('.file-tree-row-shell.selected').first();
    await expect(selectedRow).toHaveCSS('background-color', tabSelection.background);
    await expect(selectedRow).toHaveCSS('border-radius', tabSelection.radius);
    await expect(selectedRow.getByRole('treeitem')).toHaveCSS('color', tabSelection.color);
    await editor.click();
    await editor.press('Control+a');
    const selection = preview.locator('.cm-selectionBackground').first();
    await expect(selection).toBeVisible();
    await expect(selection).toHaveCSS('box-shadow', 'none');
    const before = await selection.evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(before).not.toBe('rgb(168, 82, 0)');
    await page.evaluate(() =>
      document.documentElement.style.setProperty('--mar-color-brand', '#805ad5')
    );
    await expect
      .poll(() => selection.evaluate((element) => getComputedStyle(element).backgroundColor))
      .not.toBe(before);
    await page.evaluate(() => document.documentElement.style.removeProperty('--mar-color-brand'));
  }
  for (const width of [1365, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const titleFits = await preview
      .locator('.workspace-file-page-frame-title')
      .evaluate((element) => {
        const header = element.parentElement!.getBoundingClientRect();
        return [element, ...element.children].every((child) => {
          const bounds = child.getBoundingClientRect();
          return bounds.top >= header.top && bounds.bottom <= header.bottom;
        });
      });
    expect(titleFits).toBe(true);
    if (width >= 768) {
      await expect(preview.locator('.workspace-file-page-frame-header')).toHaveCSS(
        'height',
        '44px'
      );
      const controls = preview.locator('.file-preview-desktop-actions .el-button.is-circle');
      expect(await controls.count()).toBeGreaterThan(0);
      for (const button of await controls.all()) {
        const label = await button.getAttribute('aria-label');
        expect(label).toBeTruthy();
        await button.hover();
        await expect(page.getByRole('tooltip').filter({ hasText: label! })).toBeVisible();
        await expect(button).toHaveCSS('height', '26px');
        await expect(button).toHaveCSS('width', '26px');
      }
    } else {
      await expect(page.locator('.workbench-brand')).toHaveCSS('height', '46px');
      await expect(preview.locator('.file-preview-desktop-actions')).toBeHidden();
      await expect(preview.locator('.workspace-file-mobile-actions')).toBeVisible();
    }
    await expect(preview.locator('.file-preview-content')).toHaveCSS('padding', '0px');
    const edges = await preview.locator('.code-file-editor').evaluate((element) => {
      const editorBounds = element.getBoundingClientRect();
      const parentBounds = element.parentElement!.getBoundingClientRect();
      return (['top', 'right', 'bottom', 'left'] as const).map((edge) =>
        Math.abs(editorBounds[edge] - parentBounds[edge])
      );
    });
    expect(edges.every((distance) => distance < 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`editor-${width}.png`) });
  }
});

test('Unknown-extension binaries use bounded detection and offer download without reading the full body', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  const entries = [
    { path: 'archive.zip', name: 'archive.zip', kind: 'FILE', size: 450_000, modifiedAt: 1 }
  ];
  await page.route(/\/api\/workspaces\/workspace-1\/files(?:\?.*)?$/, (route) =>
    json(route, { files: { entries, nextCursor: null, truncated: false } })
  );
  const bodyRequests: string[] = [];
  const fileReadRoute = /\/api\/workspaces\/workspace-1\/files\/read(?:\?.*)?$/;
  await page.unroute(fileReadRoute);
  await page.context().route(fileReadRoute, (route) => {
    const query = new URL(route.request().url()).searchParams;
    expect(query.get('path')).toBe('archive.zip');
    expect(query.get('offset')).toBe('0');
    expect(query.get('limit')).toBe('4096');
    return json(route, {
      file: {
        path: 'archive.zip',
        encoding: 'base64',
        size: 450_000,
        content: 'UEsAAA==',
        truncated: false,
        nextOffset: null
      }
    });
  });
  page.context().on('request', (request) => {
    const url = request.url();
    if (
      url.includes('archive.zip') &&
      (url.includes('/files/read') ||
        url.includes('/files/content') ||
        url.includes('/direct-file'))
    )
      bodyRequests.push(url);
  });

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.getByRole('treeitem', { name: 'archive.zip', exact: true }).click();

  const preview = page.getByRole('dialog', { name: 'archive.zip 文件预览' });
  await expect(preview).toBeVisible();
  await expect(
    preview.getByText('此文件类型暂不支持浏览器预览；你仍可使用右上角按钮下载文件。')
  ).toBeVisible();
  await expect(preview.getByRole('button', { name: '下载文件' })).toBeVisible();
  await page.waitForTimeout(200);
  expect(bodyRequests).toHaveLength(1);
  expect(bodyRequests.every((url) => new URL(url).pathname.endsWith('/files/read'))).toBe(true);

  const popup = await page.context().newPage();
  await mockConsoleApi(popup, 'MANAGED', ['history.read', 'turn.start'], []);
  await popup.unroute(fileReadRoute);
  const popupFilesRoute = /\/api\/workspaces\/workspace-1\/files(?:\?.*)?$/;
  await popup.unroute(popupFilesRoute);
  await popup.route(popupFilesRoute, (route) =>
    json(route, {
      files: {
        entries,
        nextCursor: null,
        truncated: false
      }
    })
  );
  await popup.goto('/console');
  await popup.getByLabel('密码').fill('test-password');
  await popup.getByRole('button', { name: '进入控制台' }).click();
  await popup.goto(
    '/console?standaloneFile=1&nodeId=node-1&workspaceId=workspace-1&path=archive.zip&rawContent=1'
  );
  const standalonePreview = popup.getByRole('region', { name: 'archive.zip 文件预览' });
  await expect(standalonePreview).toBeVisible();
  await expect(
    standalonePreview.getByText('此文件类型暂不支持浏览器预览；你仍可使用右上角按钮下载文件。')
  ).toBeVisible();
  await popup.waitForTimeout(200);
  expect(bodyRequests).toHaveLength(2);
  expect(bodyRequests.every((url) => new URL(url).pathname.endsWith('/files/read'))).toBe(true);
  await popup.close();
});

test('Supported files open a loading preview shell before asynchronously reading content', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  let releaseRead: (() => void) | undefined;
  const readReleased = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const fileReadRoute = /\/api\/workspaces\/workspace-1\/files\/read(?:\?.*)?$/;
  await page.unroute(fileReadRoute);
  await page.context().route(fileReadRoute, async (route) => {
    await readReleased;
    await json(route, {
      file: {
        path: 'src/main.ts',
        encoding: 'utf-8',
        size: 25,
        content: 'export const answer = 42;',
        truncated: false,
        nextOffset: null
      }
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
  await page.getByRole('treeitem', { name: 'src/main.ts', exact: true }).click();

  const preview = page.getByRole('dialog', { name: 'src/main.ts 文件预览' });
  await expect(preview).toBeVisible();
  await expect(preview.getByRole('status', { name: '正在加载中…' })).toBeVisible();
  releaseRead?.();
  await expect(preview.locator('.cm-content')).toContainText('export const answer = 42;');
});

test('Quick Open and Agent output locations share file, line, and column navigation', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  const searchQueries: string[] = [];
  await page.route(/\/api\/workspaces\/workspace-1\/files\/search(?:\?.*)?$/, (route) => {
    searchQueries.push(new URL(route.request().url()).searchParams.get('q') ?? '');
    return json(route, {
      files: {
        entries: [{ path: 'src/a.ts', name: 'a.ts', kind: 'FILE', size: 42, modifiedAt: 1 }],
        nextCursor: null,
        truncated: false
      }
    });
  });
  await page.route(/\/api\/workspaces\/workspace-1\/files\/read(?:\?.*)?$/, (route) => {
    const path = new URL(route.request().url()).searchParams.get('path');
    return json(route, {
      file:
        path === 'src/a.ts'
          ? {
              path,
              encoding: 'utf-8',
              size: 42,
              content: 'export const alpha = 1;\nalpha();',
              truncated: false,
              nextOffset: null
            }
          : {
              path: 'src/main.ts',
              encoding: 'utf-8',
              size: 25,
              content: 'export const answer = 42;',
              truncated: false,
              nextOffset: null
            }
    });
  });
  await page.route(/\/api\/workspaces\/workspace-1\/symbols\/definition(?:\?.*)?$/, (route) =>
    json(route, {
      definition: {
        state: 'READY',
        targets: [
          { path: 'src/a.ts', line: 1, kind: 'constant', preview: 'export const alpha = 1;' }
        ],
        references: [{ path: 'src/a.ts', line: 2, column: 1, preview: 'alpha();' }],
        referenceTruncated: false,
        paths: [],
        truncated: false
      }
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

  await page.keyboard.press('Control+Shift+O');
  const quickOpen = page.getByRole('dialog', { name: '快速打开' });
  const quickOpenInput = quickOpen.getByRole('textbox', { name: '快速打开' });
  await expect(quickOpen.getByRole('tab', { name: '全部' })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await expect(quickOpen.getByRole('tab', { name: '工作区' })).toBeVisible();
  await expect(quickOpen.getByRole('tab', { name: '会话' })).toBeVisible();
  await expect(quickOpen.getByRole('tab', { name: '符号' })).toBeVisible();
  await expect(quickOpen.getByRole('tab', { name: '文件' })).toBeVisible();
  expect(await quickOpen.getByRole('tab').allTextContents()).toEqual([
    '全部',
    '工作区',
    '会话',
    '文件',
    '符号'
  ]);
  let releaseSessionOpen: (() => void) | undefined;
  const sessionOpenBlocked = new Promise<void>((resolve) => {
    releaseSessionOpen = resolve;
  });
  await page.route('**/api/agent-sessions/session-1?nodeId=node-1', async (route) => {
    await sessionOpenBlocked;
    await route.fallback();
  });
  await quickOpen.getByRole('tab', { name: '会话' }).click();
  const sessionResults = quickOpen.locator('.quick-open-results button');
  await expect(sessionResults).toHaveCount(1);
  await sessionResults.first().click();
  await expect(quickOpen).toBeHidden();
  releaseSessionOpen?.();

  await page.keyboard.press('Control+Shift+O');
  await quickOpen.getByRole('button', { name: /project/ }).click();
  await expect(quickOpen).toBeHidden();

  await page.keyboard.press('Control+Shift+O');
  await quickOpen.getByRole('tab', { name: '符号' }).click();
  await quickOpenInput.fill('alpha');
  const symbolResults = quickOpen.locator('.quick-open-results button');
  await expect(symbolResults).toHaveCount(2);
  await expect(symbolResults.nth(0)).toContainText('定义');
  await expect(symbolResults.nth(1)).toContainText('引用');
  await symbolResults.nth(1).click();
  await expect(quickOpen).toBeHidden();
  const preview = page.getByRole('dialog', { name: 'src/a.ts 文件预览' });
  await expect(preview.locator('.cm-activeLine')).toContainText('alpha();');
  await page.keyboard.press('Escape');

  await page.keyboard.press('Control+Shift+O');
  await quickOpenInput.fill('src/a.ts:2:3');
  await expect.poll(() => searchQueries).toEqual(['src/a.ts']);
  await quickOpen.getByRole('button', { name: /a\.ts/ }).click();
  await expect(quickOpen).toBeHidden();

  await expect(preview.locator('.cm-activeLine')).toContainText('alpha();');
  await page.keyboard.press('Escape');
  await expect(preview).toBeHidden();

  await page.locator('.session-list button').first().click();
  await emitMockSessionEvent(page, 'conversation', {
    sessionId: 'session-1',
    runId: 'run-1',
    item: {
      itemId: 'agent-file-location',
      kind: 'assistant_message',
      status: 'COMPLETED',
      segmentId: 'turn-1:segment:0',
      segmentIndex: 0,
      payload: {
        text: '请查看 src/a.ts:2:3。也可查看 [行号锚点](src/a.ts#L2)。',
        format: 'markdown',
        model: null
      }
    }
  });
  const agentLocation = page.locator(
    '.agent-markdown a[data-workspace-file="src/a.ts"][data-workspace-line="2"][data-workspace-column="3"]'
  );
  await expect(agentLocation).toHaveText('src/a.ts:2:3');
  await agentLocation.click();
  await expect(preview.locator('.cm-activeLine')).toContainText('alpha();');
  await page.keyboard.press('Escape');
  await expect(preview).toBeHidden();
  const anchoredLocation = page.locator(
    '.agent-markdown a[data-workspace-file="src/a.ts"][data-workspace-line="2"]:not([data-workspace-column])'
  );
  await expect(anchoredLocation).toHaveText('行号锚点');
  await anchoredLocation.click();
  await expect(preview.locator('.cm-activeLine')).toContainText('alpha();');
  await expect(page).toHaveURL(/\/console(?:[?#]|$)/u);
});

test('Code-navigation Nodes show only the Ctrl-hovered symbol with candidate code and layered jump previews', async ({
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
    '0.9.95'
  );
  const definitionRequests: URL[] = [];
  const fileReferenceRequests: string[] = [];
  const sourceContent =
    'import { target } from "./definition.js";\nimport { management } from "@myagentroam/web-core/management";\ntarget();';
  await page.route(/\/api\/workspaces\/workspace-1\/symbols\/definition(?:\?.*)?$/, (route) => {
    const request = new URL(route.request().url());
    definitionRequests.push(request);
    const body =
      route.request().method() === 'POST'
        ? (route.request().postDataJSON() as { reference?: { value?: string } })
        : undefined;
    const specifier = body?.reference?.value ?? request.searchParams.get('specifier');
    if (body?.reference?.value !== undefined) fileReferenceRequests.push(body.reference.value);
    return json(route, {
      definition: {
        state: 'READY',
        targets:
          specifier === null
            ? [
                {
                  path: 'src/definition.ts',
                  line: 1,
                  kind: 'f',
                  preview: 'export function target() { return 7; }'
                },
                ...Array.from({ length: 12 }, (_, index) => ({
                  path: `src/generated/navigation-target-${String(index + 1).padStart(2, '0')}.ts`,
                  line: index + 2,
                  kind: 'f',
                  preview: `export function target${index + 1}() { return ${index + 1}; }`
                }))
              ]
            : [],
        references:
          specifier === null
            ? [
                { path: 'src/use.ts', line: 2, column: 1, preview: 'target();' },
                {
                  path: `src/${'a'.repeat(160)}.ts`,
                  line: 3,
                  column: 1,
                  preview: `target(${'.'.repeat(240)});`
                }
              ]
            : [],
        referenceTruncated: false,
        paths:
          specifier === './definition.js'
            ? [{ path: 'src/definition.ts', line: 1, kind: 'file' }]
            : specifier === '@myagentroam/web-core/management'
              ? [{ path: 'packages/web-core/src/management.ts', line: 1, kind: 'file' }]
              : [],
        truncated: false
      }
    });
  });
  await page.route(/\/api\/workspaces\/workspace-1\/files\/read(?:\?.*)?$/, (route) => {
    const path = new URL(route.request().url()).searchParams.get('path');
    return json(route, {
      file:
        path === 'src/definition.ts'
          ? {
              path,
              encoding: 'utf-8',
              size: 38,
              content: 'export function target() { return 7; }',
              truncated: false,
              nextOffset: null
            }
          : path === 'packages/web-core/src/management.ts'
            ? {
                path,
                encoding: 'utf-8',
                size: 40,
                content: 'export const management = true;',
                truncated: false,
                nextOffset: null
              }
            : {
                path: 'src/main.ts',
                encoding: 'utf-8',
                size: sourceContent.length,
                content: sourceContent,
                truncated: false,
                nextOffset: null
              }
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
  await page.getByRole('treeitem', { name: 'src/main.ts', exact: true }).click();

  const filePage = (path: string) =>
    page.getByRole('region', { name: `${path} 文件预览`, exact: true });
  const sourcePreview = filePage('src/main.ts');
  await expect(sourcePreview.getByRole('heading')).toHaveAttribute(
    'aria-description',
    'src/main.ts'
  );
  const callSite = sourcePreview.locator('.cm-line').filter({ hasText: 'target();' });
  await expect(callSite).toBeVisible();
  await page.keyboard.down('Control');
  await callSite.hover({ position: { x: 16, y: 10 } });
  await expect(sourcePreview.locator('.cm-code-navigation-target')).toHaveText('target');
  await page.keyboard.up('Control');
  await expect(sourcePreview.locator('.cm-code-navigation-target')).toHaveCount(0);
  await callSite.click({ position: { x: 16, y: 10 }, modifiers: ['Control'] });
  const firstDefinitionRequests = () =>
    definitionRequests.filter((request) => request.searchParams.get('references') === '0');
  await expect.poll(firstDefinitionRequests).toHaveLength(1);
  await expect
    .poll(() =>
      definitionRequests.filter((request) => request.searchParams.get('references') === '1')
    )
    .toHaveLength(1);
  expect(firstDefinitionRequests()[0]?.searchParams.get('path')).toBe('src/main.ts');
  expect(firstDefinitionRequests()[0]?.searchParams.get('symbol')).toBe('target');

  const navigation = sourcePreview.locator('.file-navigation-dropdown');
  await expect(navigation).toBeVisible();
  await expect(navigation).toContainText('定义位置');
  await expect(navigation).toContainText('引用');
  await expect(navigation).toContainText('src/use.ts');
  await expect(navigation).toContainText('export function target() { return 7; }');
  expect(await navigation.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
    true
  );
  expect(await navigation.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
    true
  );
  expect(
    await navigation.evaluate((element) => {
      const style = getComputedStyle(element);
      return style.overflowX === 'hidden' && style.overflowY === 'auto';
    })
  ).toBe(true);
  expect(
    await navigation.locator('.file-symbol-list').evaluateAll((lists) =>
      lists.every((list) => {
        const style = getComputedStyle(list);
        return style.overflowX === 'visible' && style.overflowY === 'visible';
      })
    )
  ).toBe(true);
  await callSite.click({ position: { x: 16, y: 10 } });
  await expect(navigation).toBeHidden();

  await callSite.click({ position: { x: 16, y: 10 }, modifiers: ['Control'] });
  await navigation.getByRole('option').filter({ hasText: 'src/definition.ts' }).click();
  const definitionPreview = filePage('src/definition.ts');
  await expect(definitionPreview.locator('.cm-content')).toContainText(
    'export function target() { return 7; }'
  );
  await page.locator('.workspace-file-tab.is-active .workspace-file-tab-close').click();
  await expect(sourcePreview).toBeVisible();

  const controlClickText = async (line: Locator, text: string): Promise<void> => {
    const point = await line.evaluate((element, expected) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const value = node.textContent ?? '';
        const start = value.indexOf(expected);
        if (start < 0) continue;
        const range = document.createRange();
        const middle = start + Math.floor(expected.length / 2);
        range.setStart(node, middle);
        range.setEnd(node, middle + 1);
        const rect = range.getBoundingClientRect();
        return { x: rect.left + 1, y: rect.top + Math.max(1, rect.height / 2) };
      }
      return undefined;
    }, text);
    expect(point).toBeDefined();
    if (point === undefined) throw new Error(`Code text not found: ${text}`);
    await page.keyboard.down('Control');
    try {
      await page.mouse.move(point.x, point.y);
      await expect(sourcePreview.locator('.cm-code-navigation-target')).toHaveText(text);
      await page.mouse.click(point.x, point.y);
    } finally {
      await page.keyboard.up('Control');
    }
  };

  const controlClickImmediatelyAfterText = async (line: Locator, text: string): Promise<void> => {
    const point = await line.evaluate((element, expected) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const value = node.textContent ?? '';
        const start = value.indexOf(expected);
        const end = start + expected.length;
        if (start < 0 || end >= value.length) continue;
        const range = document.createRange();
        range.setStart(node, end);
        range.setEnd(node, end + 1);
        const rect = range.getBoundingClientRect();
        return { x: rect.left + 1, y: rect.top + Math.max(1, rect.height / 2) };
      }
      return undefined;
    }, text);
    expect(point).toBeDefined();
    if (point === undefined) throw new Error(`Code text not found: ${text}`);
    await page.keyboard.down('Control');
    try {
      await page.mouse.click(point.x, point.y);
    } finally {
      await page.keyboard.up('Control');
    }
  };

  const requestsForSpecifier = (specifier: string) =>
    fileReferenceRequests.filter((value) => value === specifier);
  const relativeRequestBaseline = requestsForSpecifier('./definition.js').length;
  await controlClickImmediatelyAfterText(
    sourcePreview.locator('.cm-line').filter({ hasText: './definition.js' }),
    './definition.js'
  );
  await page.waitForTimeout(100);
  expect(requestsForSpecifier('./definition.js')).toHaveLength(relativeRequestBaseline);

  await controlClickText(
    sourcePreview.locator('.cm-line').filter({ hasText: './definition.js' }),
    './definition.js'
  );
  await expect
    .poll(() => requestsForSpecifier('./definition.js'))
    .toHaveLength(relativeRequestBaseline + 1);
  const relativePreview = filePage('src/definition.ts');
  await expect(relativePreview.locator('.cm-content')).toContainText(
    'export function target() { return 7; }'
  );
  await page.locator('.workspace-file-tab.is-active .workspace-file-tab-close').click();

  const packageRequestBaseline = requestsForSpecifier('@myagentroam/web-core/management').length;
  await controlClickText(
    sourcePreview.locator('.cm-line').filter({ hasText: '@myagentroam/web-core/management' }),
    '@myagentroam/web-core/management'
  );
  await expect
    .poll(() => requestsForSpecifier('@myagentroam/web-core/management'))
    .toHaveLength(packageRequestBaseline + 1);
  const packagePreview = filePage('packages/web-core/src/management.ts');
  await expect(packagePreview.getByRole('heading')).toHaveAttribute(
    'aria-description',
    'packages/web-core/src/management.ts'
  );
  await expect(packagePreview.locator('.cm-content')).toContainText(
    'export const management = true;'
  );
  await page.locator('.workspace-file-tab.is-active .workspace-file-tab-close').click();
  await expect(sourcePreview).toBeVisible();
  await controlClickText(
    sourcePreview.locator('.cm-line').filter({ hasText: 'target();' }),
    'target'
  );
  await expect(navigation).toBeVisible();
  await navigation.getByRole('option').filter({ hasText: 'src/definition.ts' }).click();
  await expect(definitionPreview).toBeVisible();
  const visiblePreviewTabs = page.getByRole('tablist', { name: '文件预览标签' });
  await expect(visiblePreviewTabs).toBeVisible();
  expect(
    await visiblePreviewTabs.evaluate((element) => element.getBoundingClientRect().height)
  ).toBeGreaterThan(0);
  await expect(page.locator('.workspace-file-tabs')).toHaveCount(1);
  await expect(definitionPreview.locator('.cm-activeLine')).toContainText(
    'export function target() { return 7; }'
  );
  const previewTabs = visiblePreviewTabs;
  await expect(previewTabs.getByRole('tab', { name: 'main.ts' })).toBeVisible();
  await expect(previewTabs.getByRole('tab', { name: 'definition.ts' })).toBeVisible();
  await definitionPreview.locator('.cm-content').click();
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(sourcePreview).toBeVisible();
  await sourcePreview.locator('.cm-content').click();
  await page.keyboard.press('Alt+ArrowRight');
  await expect(definitionPreview).toBeVisible();
  await previewTabs.getByRole('tab', { name: 'main.ts' }).click();
  await expect(sourcePreview).toBeVisible();
  await previewTabs.getByRole('tab', { name: 'main.ts' }).focus();
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(definitionPreview).toBeVisible();
  await previewTabs.getByRole('tab', { name: 'definition.ts' }).focus();
  await page.keyboard.press('Alt+ArrowRight');
  await expect(sourcePreview).toBeVisible();
  await previewTabs.getByRole('tab', { name: 'definition.ts' }).click();
  await expect(definitionPreview).toBeVisible();
  await page.keyboard.press('Alt+w');
  await expect(definitionPreview).toBeHidden();
  await expect(sourcePreview).toBeVisible();
  await expect(page.locator('.workspace-file-tabs')).toHaveCount(1);
  await expect(sourcePreview.locator('.cm-content')).toContainText('target();');
});

test('File preview history navigates read-only code and file tabs without revisiting closed entries', async ({
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
    '0.9.95'
  );
  await page.route(/\/api\/workspaces\/workspace-1\/symbols\/definition(?:\?.*)?$/, (route) =>
    json(route, {
      definition: {
        state: 'READY',
        targets: [{ path: 'src/definition.ts', line: 2, preview: 'export function target() {}' }],
        references: [],
        paths: [],
        truncated: false,
        referenceTruncated: false
      }
    })
  );
  await page.route(/\/api\/workspaces\/workspace-1\/files\/read(?:\?.*)?$/, (route) => {
    const path = new URL(route.request().url()).searchParams.get('path');
    const content =
      path === 'src/definition.ts'
        ? 'const first = true;\nexport function target() {}'
        : 'const first = true;\ntarget();';
    return json(route, {
      file: {
        path,
        encoding: 'utf-8',
        size: content.length,
        content,
        truncated: false,
        nextOffset: null
      }
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
  await page.getByRole('treeitem', { name: 'src/main.ts', exact: true }).click();
  const source = page.getByRole('dialog', { name: 'src/main.ts 文件预览' });
  await source
    .locator('.cm-line')
    .filter({ hasText: 'target();' })
    .click({ position: { x: 16, y: 10 }, modifiers: ['Control'] });
  await source
    .locator('.file-navigation-dropdown')
    .getByRole('option')
    .filter({ hasText: 'src/definition.ts' })
    .click();
  const definition = page.getByRole('dialog', { name: 'src/definition.ts 文件预览' });
  await expect(definition.locator('.cm-activeLine')).toContainText('export function target()');
  await definition.locator('.cm-content').click();
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(source).toBeVisible();
  await expect(source.locator('.cm-activeLine')).toContainText('target();');
  await source.locator('.cm-content').click();
  await page.keyboard.press('Alt+ArrowRight');
  await expect(definition).toBeVisible();
  const tabs = page.getByRole('tablist', { name: '文件预览标签' });
  await tabs.getByRole('tab', { name: 'main.ts' }).click();
  await tabs.getByRole('tab', { name: 'main.ts' }).focus();
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(definition).toBeVisible();
  await page.locator('.workspace-file-tab.is-active .workspace-file-tab-close').click();
  await expect(tabs.getByRole('tab', { name: 'definition.ts' })).toHaveCount(0);
  await source.locator('.cm-content').click();
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(source).toBeVisible();
  await source
    .locator('.cm-line')
    .filter({ hasText: 'target();' })
    .click({ position: { x: 16, y: 10 }, modifiers: ['Control'] });
  await source
    .locator('.file-navigation-dropdown')
    .getByRole('option')
    .filter({ hasText: 'src/definition.ts' })
    .click();
  await expect(tabs.getByRole('tab')).toHaveCount(2);
  await expect(definition.getByRole('button', { name: '关闭预览' })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  const closeWindow = page.getByRole('button', { name: '关闭文件窗口', exact: true });
  await expect(closeWindow).toBeVisible();
  await closeWindow.click();
  await expect(page.locator('.workspace-file-tabs')).toHaveCount(0);
});

test('Ctrl+Shift+F searches Workspace file contents and jumps to matching lines', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  let contentSearchUrl: URL | undefined;
  let searchGate: Promise<void> | undefined;
  let releaseSearch: (() => void) | undefined;
  await page.route(/\/api\/workspaces\/workspace-1\/content\/search(?:\?.*)?$/, async (route) => {
    contentSearchUrl = new URL(route.request().url());
    await searchGate;
    return json(route, {
      search: {
        matches: [{ path: 'src/main.ts', line: 2, column: 7, preview: 'const 中文内容 = true;' }],
        engine: 'RIPGREP',
        truncated: false,
        skippedFiles: 0
      }
    });
  });
  await page.route(/\/api\/workspaces\/workspace-1\/files\/read(?:\?.*)?$/, (route) =>
    json(route, {
      file: {
        path: 'src/main.ts',
        encoding: 'utf-8',
        size: 37,
        content: 'export {};\nconst 中文内容 = true;',
        truncated: false,
        nextOffset: null
      }
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
  await page.keyboard.press('Control+Shift+F');
  const search = page.getByRole('textbox', { name: '搜索文件内容' });
  await expect(search).toBeFocused();
  const contentSearchButton = page.locator('.content-search-toolbar .content-search-button');
  await expect(contentSearchButton).toHaveAttribute('type', 'submit');
  await expect(contentSearchButton).toHaveClass(/file-explorer-utility-button/u);
  await expect(contentSearchButton).toHaveClass(/utility-control/u);
  expect(
    await page
      .locator('.content-search-toolbar .el-input__wrapper')
      .evaluate((element) => Math.round(element.getBoundingClientRect().height))
  ).toBeLessThanOrEqual(28);
  const regex = page.getByRole('checkbox', { name: '使用正则表达式' });
  await expect(regex).not.toBeChecked();
  await page.locator('.content-search-options .el-checkbox').click();
  await expect(regex).toBeChecked();
  await search.fill('中文内容');
  await search.press('Enter');
  await expect.poll(() => contentSearchUrl?.searchParams.get('regex')).toBe('true');
  const searchResult = page
    .locator('.content-search-results')
    .getByRole('button', { name: 'src/main.ts', exact: true });
  await expect(searchResult).toBeVisible();
  await expect(searchResult.locator('small')).toHaveText('第 2 行');
  await expect(searchResult.locator('code')).toHaveText('const 中文内容 = true;');
  await expect(searchResult.locator('code mark')).toHaveCount(0);
  await page.locator('.content-search-options .el-checkbox').click();
  searchGate = new Promise((resolve) => {
    releaseSearch = resolve;
  });
  await search.press('Enter');
  await expect.poll(() => contentSearchUrl?.searchParams.get('regex')).toBeNull();
  // Changing the draft cannot reinterpret the in-flight plain-text result.
  await page.locator('.content-search-options .el-checkbox').click();
  await expect(regex).toBeChecked();
  releaseSearch!();
  await expect(searchResult.locator('code mark')).toHaveText('中文内容');
  await searchResult.hover();
  await expect(searchResult).toHaveCSS('border-radius', '6px');
  await searchResult.focus();
  await expect(searchResult).toHaveCSS('border-radius', '6px');
  await searchResult.click();
  const preview = page
    .getByRole('dialog')
    .filter({ has: page.getByRole('heading', { name: 'main.ts', exact: true }) });
  await expect(preview).toBeVisible();
  await expect(preview.getByRole('heading')).toHaveAttribute('aria-description', 'src/main.ts');
  await expect(preview.locator('.cm-content')).toContainText('export {}');
  await expect(preview.locator('.cm-activeLine')).toContainText('const 中文内容 = true;');
});

test('Text files default to editing and support saving, replacement, symbols, and unsaved-close confirmation', async ({
  page,
  browserName
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
    '0.9.12'
  );
  const originalRevision = 'a'.repeat(64);
  const source = Array.from(
    { length: 30 },
    (_, index) => `export function answer${index + 1}() { return ${index + 1}; }`
  ).join('\n');
  await page.route(/\/api\/workspaces\/workspace-1\/files\/read(?:\?.*)?$/, (route) =>
    json(route, {
      file: {
        path: 'src/main.ts',
        encoding: 'utf-8',
        size: source.length,
        content: source,
        truncated: false,
        nextOffset: null,
        revision: originalRevision
      }
    })
  );
  let savedContent = '';
  let writeRequests = 0;
  let releaseWrite: (() => void) | undefined;
  const writeReleased = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  await page.route('**/api/workspaces/workspace-1/files/write', async (route) => {
    writeRequests += 1;
    const body = route.request().postDataJSON() as {
      content: string;
      expectedRevision: string;
    };
    savedContent = body.content;
    expect(body.expectedRevision).toBe(originalRevision);
    await writeReleased;
    await json(route, { file: { path: 'src/main.ts', revision: 'b'.repeat(64), size: 39 } });
  });

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.getByRole('treeitem', { name: 'src/main.ts', exact: true }).click();

  const preview = page.getByRole('dialog', { name: 'src/main.ts 文件预览' });
  await expect(preview.locator('.file-preview-eyebrow')).toContainText('正在编辑');
  const editor = preview.locator('.cm-content');
  await page.evaluate(() =>
    document.documentElement.setAttribute('data-theme', 'vscode-light-2026')
  );
  await expect(preview.locator('.cm-editor')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await page.evaluate(() =>
    document.documentElement.setAttribute('data-theme', 'vscode-dark-2026')
  );
  await expect(preview.locator('.cm-editor')).toHaveCSS('background-color', 'rgb(30, 30, 30)');
  await editor.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: '复制' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '粘贴' })).toBeEnabled();
  await expect(page.getByRole('menuitem', { name: '重新加载' })).toBeVisible();
  await page.keyboard.press('Escape');
  await editor.press('Control+Home');
  await page.keyboard.press('Alt+m');
  const symbolSearch = preview.getByPlaceholder('搜索符号');
  await expect(symbolSearch).toBeFocused();
  for (let index = 0; index < 18; index += 1) await symbolSearch.press('ArrowDown');
  const selectedSymbol = preview.locator('.file-symbol-list [aria-selected="true"]');
  await expect(selectedSymbol).toHaveAttribute('data-symbol-index', '18');
  expect(
    await selectedSymbol.evaluate((element) => {
      const item = element.getBoundingClientRect();
      const list = element.parentElement!.getBoundingClientRect();
      return item.top >= list.top && item.bottom <= list.bottom;
    })
  ).toBe(true);
  await symbolSearch.press('Escape');
  await expect(symbolSearch).toBeHidden();
  await editor.fill('export function answer() { return 43; }');
  await page.keyboard.press('Control+h');
  await expect(preview.getByRole('search', { name: '文件内查找' })).toBeVisible();
  await expect(preview.getByPlaceholder('替换为')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(preview.getByRole('search', { name: '文件内查找' })).toBeHidden();
  await page.keyboard.press('Alt+m');
  await expect(preview.getByPlaceholder('搜索符号')).toBeFocused();
  await page.keyboard.press('Alt+m');
  await page.keyboard.press('Control+s');
  await expect.poll(() => writeRequests).toBe(1);
  await page.keyboard.press('Control+s');
  await expect.poll(() => writeRequests).toBe(1);
  releaseWrite?.();
  await expect.poll(() => savedContent).toBe('export function answer() { return 43; }');
  await expect(preview.getByRole('button', { name: '保存' })).toBeDisabled();

  await editor.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.insertText('export function answer() { return 44; }');
  await expect(preview.getByRole('button', { name: '保存' })).toBeEnabled();
  await page.getByRole('tab', { name: 'main.ts', exact: true }).focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('.el-message-box')).toContainText('未保存的修改');
  await page.keyboard.press('Escape');
  await expect(page.locator('.el-message-box')).toBeHidden();
  await expect(preview).toBeVisible();
  await editor.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '重新加载' }).click();
  await expect(page.locator('.el-message-box')).toContainText('重新加载会丢弃未保存的修改');
  await page.locator('.el-message-box__btns .el-button--primary').click();
  await expect(editor).toContainText('answer1()');
  await editor.press('Control+Home');
  await page.keyboard.press('Alt+m');
  const navigationSearch = preview.getByPlaceholder('搜索符号');
  await expect(navigationSearch).toBeFocused();
  for (let index = 0; index < 18; index += 1) await navigationSearch.press('ArrowDown');
  await navigationSearch.press('Enter');
  await expect(navigationSearch).toBeHidden();
  const targetLineText = await preview.locator('.cm-activeLine').innerText();
  expect(targetLineText).not.toContain('answer1()');
  await editor.press('Alt+ArrowLeft');
  await expect(preview.locator('.cm-activeLine')).toContainText('answer1()');
  await editor.press('Alt+ArrowRight');
  await expect(preview.locator('.cm-activeLine')).toHaveText(targetLineText);
  if (browserName === 'chromium')
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await editor.press('Control+a');
  await editor.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '复制' }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain('answer19()');
  await page.evaluate(() => navigator.clipboard.writeText('\n// pasted from menu'));
  await editor.press('Control+End');
  await editor.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '粘贴' }).click();
  await expect(editor).toContainText('// pasted from menu');
  await expect(
    preview
      .getByRole('region', { name: 'src/main.ts 文件预览', exact: true })
      .getByRole('button', { name: '关闭预览' })
  ).toHaveCount(0);
  const closeWindow = page.getByRole('button', { name: '关闭文件窗口', exact: true });
  await closeWindow.click();
  await expect(page.locator('.el-message-box')).toContainText('未保存的修改');
  await page.locator('.el-message-box__btns').getByRole('button', { name: '取消' }).click();
  await expect(preview).toBeVisible();
  await expect(editor).toContainText('// pasted from menu');
  await closeWindow.click();
  await page.locator('.el-message-box__btns .el-button--primary').click();
  await expect(page.locator('.workspace-file-tabs')).toHaveCount(0);
});

test('Large text previews disable expensive syntax trees and symbol scans', async ({ page }) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  const content = 'const item = 1;\n'.repeat(70_000);
  await page.route(/\/api\/workspaces\/workspace-1\/files\/read(?:\?.*)?$/, (route) =>
    json(route, {
      file: {
        path: 'src/main.ts',
        encoding: 'utf-8',
        size: content.length,
        content,
        truncated: false,
        nextOffset: null,
        revision: 'a'.repeat(64)
      }
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
  await page.getByRole('treeitem', { name: 'src/main.ts', exact: true }).click();

  const preview = page.getByRole('dialog', { name: 'src/main.ts 文件预览' });
  await expect
    .poll(() => preview.getByRole('textbox', { name: '代码编辑器预览' }).inputValue())
    .toContain('const item = 1;');
  await page.keyboard.press('Alt+m');
  await expect(preview.getByPlaceholder('搜索符号')).toHaveCount(0);
  for (const width of [1365, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const contentArea = preview.locator('.file-preview-content');
    await expect(contentArea).toHaveCSS('overflow-y', 'auto');
    const notice = contentArea.locator('.empty');
    await notice.scrollIntoViewIfNeeded();
    const bounds = await notice.evaluate((element) => {
      const notice = element.getBoundingClientRect();
      const container = element.parentElement!.getBoundingClientRect();
      return { top: notice.top - container.top, bottom: container.bottom - notice.bottom };
    });
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.bottom).toBeGreaterThanOrEqual(-1);
  }
});

test('File tree More menus remain open while the pointer enters the menu', async ({ page }) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();

  const tree = page.getByRole('tree', { name: '文件树' });
  await tree.getByRole('treeitem', { name: 'project', exact: true }).hover();
  const more = tree.getByRole('button', { name: 'project 更多操作' });
  await more.click();
  const menuItem = page.getByRole('menuitem', { name: '复制相对路径' });
  await expect(menuItem).toBeVisible();
  await menuItem.hover();
  await expect(menuItem).toBeVisible();
  await expect(more).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menuItem).toBeHidden();
});

test('Files filtering affects only loaded tree entries and clearing restores them', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();

  const tree = page.getByRole('tree', { name: '文件树' });
  const filter = page.getByRole('textbox', { name: '显示过滤' });
  await expect(tree.getByRole('treeitem', { name: /main\.ts/ })).toBeVisible();
  await tree.getByRole('treeitem', { name: /main\.ts/ }).hover();
  const rows = tree.locator('.file-tree-row-shell');
  expect(await rows.count()).toBeGreaterThan(1);
  await expect(rows.first()).toHaveCSS('background-clip', 'padding-box');
  await expect(rows.first()).toHaveCSS('border-top-width', '1px');
  await expect(rows.first()).toHaveCSS('border-bottom-width', '1px');
  const geometry = await rows.evaluateAll((elements) => {
    const height = Number.parseFloat(
      getComputedStyle(elements[0]!).getPropertyValue('--mar-compact-row-size')
    );
    return elements.every((element, index) => {
      const bounds = element.getBoundingClientRect();
      return (
        Math.abs(bounds.height - height) < 0.1 &&
        (index === 0 ||
          Math.abs(bounds.top - elements[index - 1]!.getBoundingClientRect().bottom) < 0.1)
      );
    });
  });
  expect(geometry).toBe(true);
  await filter.fill('missing');
  await expect(tree.getByRole('treeitem', { name: /main\.ts/ })).toHaveCount(0);
  await expect(tree.getByText('没有匹配的文件或目录。')).toBeVisible();
  await filter.clear();
  await expect(tree.getByRole('treeitem', { name: /main\.ts/ })).toBeVisible();
});

test('The Material icon theme renders SVG icons in the file tree', async ({ page }) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await page.addInitScript(() => localStorage.setItem('mar.icon-theme', 'material'));

  await page.goto('/console');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();

  const tree = page.getByRole('tree', { name: '文件树' });
  await expect(tree.getByRole('treeitem', { name: /main\.ts/ })).toBeVisible();
  await expect(tree.locator('.material-file-icon svg')).not.toHaveCount(0);
});

test('Quick Open narrows duplicate filenames with space-separated terms and clears stale results on input changes', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await page.route(/\/api\/workspaces\/workspace-1\/files(?:\?.*)?$/, (route) =>
    json(route, { files: { entries: [], nextCursor: null, truncated: false } })
  );
  const queries: string[] = [];
  await page.route(/\/api\/workspaces\/workspace-1\/files\/search(?:\?.*)?$/, (route) => {
    const query = new URL(route.request().url()).searchParams.get('q') ?? '';
    queries.push(query);
    return json(route, {
      files: {
        entries: [
          { path: 'src/app.ts', name: 'app.ts', kind: 'FILE', size: 1 },
          ...(query.includes('src')
            ? []
            : [{ path: 'test/app.ts', name: 'app.ts', kind: 'FILE', size: 1 }])
        ],
        nextCursor: null,
        truncated: false
      }
    });
  });
  await page.goto('/console');
  await page.getByLabel('密码').fill('test-password');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.keyboard.press('Control+Shift+O');
  const dialog = page.getByRole('dialog', { name: '快速打开' });
  const input = dialog.getByLabel('快速打开');
  await input.fill('app');
  await expect(dialog.locator('.quick-open-results button')).toHaveCount(2);
  await input.fill('app src');
  await expect(dialog.locator('.quick-open-results button')).toHaveCount(0);
  const result = dialog.locator('.quick-open-results button');
  await expect(result).toHaveCount(1);
  await expect(result).toContainText('src/app.ts');
  await expect(result.locator('code .quick-open-match')).toHaveCount(2);
  await expect(result).toHaveCSS('cursor', 'pointer');
  const background = await result.evaluate((element) => getComputedStyle(element).backgroundColor);
  await result.hover();
  await expect
    .poll(() => result.evaluate((element) => getComputedStyle(element).backgroundColor))
    .not.toBe(background);
  expect(queries).toEqual(['app', 'app src']);
});

test('Ctrl+Shift+O opens Workspace files from fuzzy results', async ({ page }) => {
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
  await page.route(/\/api\/workspaces\/workspace-1\/files(?:\?.*)?$/, (route) =>
    json(route, { files: { entries: [], nextCursor: null, truncated: false } })
  );
  await page.route(/\/api\/workspaces\/workspace-1\/files\/search(?:\?.*)?$/, (route) =>
    json(route, {
      files: {
        entries: [
          { path: 'src/my-agent-roam.ts', name: 'my-agent-roam.ts', kind: 'FILE', size: 1 },
          ...Array.from({ length: 11 }, (_, index) => ({
            path: `src/fixture-m-x-a-x-r-${index + 1}.ts`,
            name: `fixture-m-x-a-x-r-${index + 1}.ts`,
            kind: 'FILE',
            size: 1
          }))
        ],
        nextCursor: null,
        truncated: false
      }
    })
  );
  const previewFileResponse = {
    file: {
      path: 'src/my-agent-roam.ts',
      encoding: 'utf-8',
      size: 10,
      content: 'export {};',
      truncated: false,
      nextOffset: null
    }
  } as const;
  await page
    .context()
    .route(/\/api\/workspaces\/workspace-1\/files\/read(?:\?.*)?$/, (route) =>
      json(route, previewFileResponse)
    );
  await page.route(/\/api\/workspaces\/workspace-1\/files\/read(?:\?.*)?$/, (route) =>
    json(route, previewFileResponse)
  );

  await page.goto('/console');
  await page.getByLabel('密码').fill('test-password');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.keyboard.press('Control+Shift+O');
  const dialog = page.getByRole('dialog', { name: '快速打开' });
  await expect(dialog.getByLabel('快速打开')).toBeFocused();
  await dialog.getByLabel('快速打开').fill('mar');
  await expect(dialog.getByText('src/my-agent-roam.ts', { exact: true })).toBeVisible();
  await expect(dialog.locator('.quick-open-match').first()).toHaveText('m');
  const results = dialog.locator('.quick-open-results');
  for (let index = 0; index < 11; index += 1) await page.keyboard.press('ArrowDown');
  await expect(results.getByRole('option', { selected: true })).toContainText(
    'fixture-m-x-a-x-r-11.ts'
  );
  await expect.poll(() => results.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await page.keyboard.press('ArrowDown');
  await expect(results.getByRole('option', { selected: true })).toContainText('my-agent-roam.ts');
  await page.keyboard.press('Enter');
  const tree = page.getByRole('tree', { name: '文件树' });
  await expect(tree.getByRole('treeitem', { name: /src/ })).toHaveAttribute(
    'aria-expanded',
    'true'
  );
  await expect(tree.getByRole('treeitem', { name: /my-agent-roam\.ts/ })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  const preview = page.getByRole('dialog', { name: 'my-agent-roam.ts 文件预览' });
  await expect(preview).toBeVisible();
  await expect(preview.locator('.cm-content')).toContainText('export');
  await page.locator('.workspace-file-tab.is-active .workspace-file-tab-close').click();
  await page.keyboard.press('Control+Shift+O');
  await dialog.getByLabel('快速打开').fill('mar');
  await expect(dialog.getByText('src/my-agent-roam.ts', { exact: true })).toBeVisible();
  const popupPromise = page.waitForEvent('popup');
  await page.keyboard.press('Control+Enter');
  const popup = await popupPromise;
  await expect(popup).toHaveURL(/standaloneFile=1/);
  await expect(popup.getByRole('dialog', { name: 'src/my-agent-roam.ts 文件预览' })).toBeVisible();
  await expect(popup.locator('.cm-content')).toContainText('export');
  const popupLine = popup.locator('.cm-line').first();
  const popupLineBounds = await popupLine.boundingBox();
  expect(popupLineBounds).not.toBeNull();
  if (popupLineBounds === null) throw new Error('独立预览文本行未渲染');
  await popup.mouse.move(popupLineBounds.x + 1, popupLineBounds.y + popupLineBounds.height / 2);
  await popup.mouse.down();
  await popup.mouse.move(
    popupLineBounds.x + Math.min(popupLineBounds.width - 1, 70),
    popupLineBounds.y + popupLineBounds.height / 2
  );
  await popup.mouse.up();
  await expect
    .poll(() => popup.evaluate(() => window.getSelection()?.toString() ?? ''))
    .toContain('export');
  await popup.evaluate(() => {
    HTMLAnchorElement.prototype.click = function click(): void {
      const url = new URL(this.href);
      (
        window as unknown as {
          __downloadQuery?: Record<string, string | null>;
        }
      ).__downloadQuery = {
        nodeId: url.searchParams.get('nodeId'),
        path: url.searchParams.get('path'),
        download: url.searchParams.get('download')
      };
    };
  });
  await popup.getByRole('button', { name: '下载文件' }).click();
  await expect
    .poll(() =>
      popup.evaluate(
        () =>
          (
            window as unknown as {
              __downloadQuery?: Record<string, string | null>;
            }
          ).__downloadQuery
      )
    )
    .toEqual({ nodeId: 'node-1', path: 'src/my-agent-roam.ts', download: '1' });
  if (!popup.isClosed()) {
    const closed = popup.waitForEvent('close');
    await popup
      .getByRole('button', { name: '关闭文件窗口', exact: true })
      .click()
      .catch((error: unknown) => {
        if (!popup.isClosed()) throw error;
      });
    await closed;
  }
  expect(popup.isClosed()).toBe(true);
});

test('Standalone Markdown previews render Mermaid and allow HTTP images', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('mar.theme', 'vscode-dark-2026');
    localStorage.setItem(
      'mar.markdown-preview',
      JSON.stringify({ watermarkEnabled: false, watermarkText: '', theme: 'light' })
    );
  });
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  const preview = {
    file: {
      path: 'README.md',
      encoding: 'utf-8',
      content:
        '# Preview\n\n![Remote](https://example.test/image.png)\n\n```mermaid\ngraph TD\n  A --> B\n```',
      truncated: false,
      nextOffset: null
    }
  } as const;
  await page.route(/\/api\/workspaces\/workspace-1\/files(?:\?.*)?$/, (route) =>
    json(route, {
      files: {
        entries: [{ path: 'README.md', name: 'README.md', kind: 'FILE', size: 80, modifiedAt: 1 }],
        nextCursor: null,
        truncated: false
      }
    })
  );
  const fileReadRoute = /\/api\/workspaces\/workspace-1\/files\/read(?:\?.*)?$/;
  await page.unroute(fileReadRoute);
  await page.context().route(fileReadRoute, (route) => json(route, preview));

  await page.goto('/console');
  await page.getByLabel('密码').fill('test-password');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
  await page.getByRole('treeitem', { name: /README\.md/ }).click();
  const dialog = page.getByRole('dialog', { name: 'README.md 文件预览' });
  await expect(dialog.getByRole('button', { name: '打开 Markdown 预览' })).toBeVisible();
  let releaseCapabilities: (() => void) | undefined;
  const capabilitiesReleased = new Promise<void>((resolve) => {
    releaseCapabilities = resolve;
  });
  await page.context().route('**/api/nodes/node-1/workbench-capabilities', async (route) => {
    await capabilitiesReleased;
    await json(route, {
      manifest: {
        nodeGeneration: 'generation-1',
        directTransfer: { apiVersion: 3, transport: true, download: true, range: true }
      }
    });
  });
  const popupPromise = page.waitForEvent('popup');
  await page.keyboard.press('Control+Shift+v');
  const popup = await popupPromise;
  await expect(popup.locator('html')).toHaveAttribute('data-theme', 'vscode-dark-2026');
  await expect(popup.getByRole('heading', { name: 'Preview' })).toBeVisible({ timeout: 2_500 });
  releaseCapabilities?.();
  await expect(popup.locator('img[src="https://example.test/image.png"]')).toHaveCount(1);
  await expect(popup.locator('.markdown-mermaid svg')).toHaveCount(1);
  const closed = popup.waitForEvent('close');
  await popup.keyboard.press('Escape').catch((error: unknown) => {
    if (!popup.isClosed()) throw error;
  });
  await closed;
});

test('Refreshing Files upgrades a plain directory to a Git Workspace', async ({ page }) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], [], 'DIRECTORY');
  const initialWatchTopics: Record<string, unknown>[] = [];
  let fileReads = 0;
  await page.route(/\/api\/workspaces\/workspace-1\/watch$/, async (route) => {
    const request = JSON.parse(route.request().postData() ?? '{}') as {
      readonly mode?: string;
      readonly topics?: Record<string, unknown>;
    };
    if (request.mode === 'initial') initialWatchTopics.push(request.topics ?? {});
    await fulfillMockWorkspaceWatch(
      page,
      route,
      {
        id: 'session-1',
        workspaceId: 'workspace-1'
      },
      request.topics?.changes === true ? 'GIT_WORKSPACE' : 'DIRECTORY'
    );
  });
  await page.route(/\/api\/workspaces\/workspace-1\/files(?:\?.*)?$/, (route) => {
    fileReads += 1;
    return json(route, {
      files: {
        entries: [{ path: 'README.md', name: 'README.md', kind: 'FILE', size: 12, modifiedAt: 1 }],
        nextCursor: null,
        truncated: false
      },
      workspace: {
        id: 'workspace-1',
        path: '/project',
        kind: 'GIT_WORKSPACE',
        gitSummary: {
          commonDir: '.git',
          head: '',
          branch: 'main',
          dirty: true,
          snapshot: 'README.md'
        }
      }
    });
  });

  await page.goto('/console');
  await page.getByLabel('密码').fill('test-password');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();

  await expect(page.getByRole('tab', { name: 'Git 变更' })).toHaveCount(0);
  await expect.poll(() => initialWatchTopics.length).toBeGreaterThanOrEqual(1);
  expect(initialWatchTopics[0]).not.toHaveProperty('changes');
  await page.getByRole('button', { name: '刷新文件', exact: true }).click();

  await expect(page.getByRole('tab', { name: 'Git 变更' })).toBeVisible();
  await expect(page.locator('.session-heading-meta .workspace-kind-tag')).toHaveText('Git');
  await expect(page.locator('.session-heading-meta .workspace-branch-tag')).toHaveText('main');
  await expect.poll(() => initialWatchTopics.length).toBe(2);
  expect(initialWatchTopics.at(-1)).toMatchObject({ changes: true });

  await page.getByRole('button', { name: '刷新文件', exact: true }).click();
  await expect.poll(() => fileReads).toBe(2);
  await page.waitForTimeout(200);
  expect(initialWatchTopics).toHaveLength(2);
});

test('Git Workspace downgrades clear Inspector state and reject stale Changes responses', async ({
  page
}) => {
  await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
  await page.unroute(/\/api\/workspaces\/workspace-1\/files(?:\?.*)?$/);
  await page.unroute(/\/api\/workspaces\/workspace-1\/changes(?:\?.*)?$/);
  const initialWatchTopics: Record<string, unknown>[] = [];
  let workspaceKind: 'DIRECTORY' | 'GIT_WORKSPACE' = 'GIT_WORKSPACE';
  let gitBranch = 'stale/branch';
  let changesReads = 0;
  let releaseOldChanges: (() => void) | undefined;
  let releaseFreshChanges: (() => void) | undefined;
  await page.route(/\/api\/workspaces\/workspace-1\/git\/fetch(?:\?.*)?$/, (route) =>
    json(route, { fetchFailed: false, updated: false })
  );
  await page.route(/\/api\/workspaces\/workspace-1\/watch$/, async (route) => {
    const request = JSON.parse(route.request().postData() ?? '{}') as {
      readonly mode?: string;
      readonly topics?: Record<string, unknown>;
      readonly watchId?: string;
    };
    if (request.mode === 'initial') initialWatchTopics.push(request.topics ?? {});
    await fulfillMockWorkspaceWatch(
      page,
      route,
      {
        id: 'session-1',
        workspaceId: 'workspace-1'
      },
      workspaceKind,
      undefined,
      request.topics?.changes === true
        ? {
            branch: gitBranch,
            changes: [
              {
                path: gitBranch === 'fresh/main' ? 'fresh.txt' : 'stale.txt',
                state: 'UNTRACKED',
                change: 'ADDED',
                diffAvailable: false
              }
            ],
            repositories: [
              {
                repositoryPath: '',
                repositoryName: '根仓库',
                source: 'ROOT',
                branch: gitBranch,
                changes: [
                  {
                    path: gitBranch === 'fresh/main' ? 'fresh.txt' : 'stale.txt',
                    state: 'UNTRACKED',
                    change: 'ADDED',
                    diffAvailable: false
                  }
                ]
              }
            ]
          }
        : undefined
    );
  });
  await page.route(/\/api\/workspaces\/workspace-1\/files(?:\?.*)?$/, (route) =>
    json(route, {
      files: {
        entries: [{ path: 'README.md', name: 'README.md', kind: 'FILE', size: 12, modifiedAt: 1 }],
        nextCursor: null,
        truncated: false
      },
      workspace: {
        id: 'workspace-1',
        path: '/project',
        kind: workspaceKind,
        gitSummary:
          workspaceKind === 'GIT_WORKSPACE'
            ? {
                commonDir: '.git',
                head: '',
                branch: gitBranch,
                dirty: true,
                snapshot: 'README.md'
              }
            : null
      }
    })
  );
  await page.route(/\/api\/workspaces\/workspace-1\/changes(?:\?.*)?$/, async (route) => {
    changesReads += 1;
    if (changesReads === 2)
      await new Promise<void>((resolve) => {
        releaseOldChanges = resolve;
      });
    if (changesReads === 3)
      await new Promise<void>((resolve) => {
        releaseFreshChanges = resolve;
      });
    const path = changesReads === 1 ? 'stale.txt' : changesReads === 2 ? 'late.txt' : 'fresh.txt';
    return json(route, {
      branch: changesReads < 3 ? 'stale/branch' : 'fresh/main',
      changes: [
        {
          path,
          state: 'UNTRACKED',
          change: 'ADDED',
          diffAvailable: false
        }
      ],
      repositories: [
        {
          repositoryPath: '',
          repositoryName: '根仓库',
          source: 'ROOT',
          branch: changesReads < 3 ? 'stale/branch' : 'fresh/main',
          changes: [
            {
              path,
              state: 'UNTRACKED',
              change: 'ADDED',
              diffAvailable: false
            }
          ]
        }
      ]
    });
  });

  await page.goto('/console');
  await page.getByLabel('密码').fill('test-password');
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page
    .locator('.workspace-tree')
    .getByRole('button', { name: /node-1/ })
    .click();
  await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();

  await expect(page.getByRole('tab', { name: 'Git 变更' })).toBeVisible();
  await page.getByRole('tab', { name: 'Git 变更' }).click();
  await expect(page.getByText('stale.txt', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '刷新 Git 变更', exact: true }).click();
  await expect.poll(() => releaseOldChanges !== undefined).toBe(true);
  await page.getByRole('tab', { name: '文件', exact: true }).click();
  workspaceKind = 'DIRECTORY';
  await page.getByRole('button', { name: '刷新文件', exact: true }).click();

  await expect(page.getByRole('tab', { name: 'Git 变更' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: '文件', exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await expect(page.locator('.session-heading-meta .workspace-kind-tag')).toHaveCount(0);
  await expect(page.locator('.session-heading-meta .workspace-branch-tag')).toHaveCount(0);
  await expect.poll(() => initialWatchTopics.length).toBeGreaterThanOrEqual(2);
  expect(initialWatchTopics.at(-1)).not.toHaveProperty('changes');

  releaseOldChanges?.();
  await page.waitForTimeout(300);
  await expect(page.getByText('stale.txt', { exact: true })).toHaveCount(0);
  await expect(page.getByText('late.txt', { exact: true })).toHaveCount(0);
  await expect(page.locator('.session-heading-meta .workspace-branch-tag')).toHaveCount(0);

  workspaceKind = 'GIT_WORKSPACE';
  gitBranch = 'fresh/main';
  await page.getByRole('button', { name: '刷新文件', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Git 变更' })).toBeVisible();
  await expect(page.locator('.session-heading-meta .workspace-branch-tag')).toHaveText(
    'fresh/main'
  );
  await page.getByRole('tab', { name: 'Git 变更' }).click();
  await expect.poll(() => releaseFreshChanges !== undefined).toBe(true);
  await expect(page.getByText('stale.txt', { exact: true })).toHaveCount(0);
  await expect(page.getByText('late.txt', { exact: true })).toHaveCount(0);
  releaseFreshChanges?.();
  await expect(page.getByText('fresh.txt', { exact: true })).toBeVisible();
  await expect(page.getByText('stale.txt', { exact: true })).toHaveCount(0);
});
