import { grantClipboardPermissions } from './support/clipboard.js';
import { expect, test, type Locator } from '@playwright/test';
import { hostedConversationSnapshotSchema } from '../../packages/protocol/src/index.js';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';
let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

function sessionListColors(list: Locator) {
  return list.evaluate((element) => {
    const probe = document.createElement('span');
    element.append(probe);
    probe.style.fontSize = 'var(--mar-font-size-body)';
    probe.style.color = 'var(--mar-text-secondary)';
    const secondary = getComputedStyle(probe).color;
    probe.style.color = 'var(--mar-text-muted)';
    const meta = getComputedStyle(probe).color;
    probe.style.color = 'var(--mar-text-primary)';
    const { color: primary, fontSize } = getComputedStyle(probe);
    probe.remove();
    return { primary, secondary, meta, fontSize };
  });
}

for (const theme of ['daylight', 'vscode-dark-2026']) {
  test(`Content search checkbox uses the shared control appearance in ${theme}`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 850 });
    await page.goto(`${fixture.url}workbench-style.html?theme=${theme}&content-search=1`);
    const inspector = page.getByRole('region', { name: 'Inspector fixture' });
    await inspector
      .locator('.workbench-aside-tabs button')
      .filter({ hasText: /^Search$/ })
      .click();
    const checkbox = inspector.getByRole('checkbox', { name: 'Use regular expression' });
    const option = inspector.locator('.content-search-options');
    const label = option.getByText('Use regular expression', { exact: true });
    const input = inspector.locator('.content-search-toolbar .mar-ui-input');
    const search = inspector.getByRole('button', { name: 'Run content search', exact: true });
    await expect(checkbox).not.toBeChecked();
    await expect(checkbox).toHaveCSS('appearance', 'none');
    await expect(checkbox).toHaveCSS(
      'background-color',
      await input.evaluate((el) => getComputedStyle(el).backgroundColor)
    );
    await expect(label).toHaveCSS('font-weight', '400');
    await expect(label).toHaveCSS(
      'font-size',
      await option.locator('.mar-ui-checkbox').evaluate((el) => getComputedStyle(el).fontSize)
    );
    await option.screenshot({ path: testInfo.outputPath('regex-unchecked.png') });
    await label.click();
    await expect(checkbox).toBeChecked();
    await expect(checkbox).toHaveCSS(
      'background-color',
      theme === 'daylight' ? 'rgb(0, 87, 219)' : 'rgb(222, 222, 222)'
    );
    await expect(option.locator('svg')).toBeVisible();
    await option.screenshot({ path: testInfo.outputPath('regex-checked.png') });
    await input.getByRole('textbox').press('Tab');
    await expect(search).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(checkbox).toBeFocused();
    await expect(checkbox).toHaveCSS('outline-style', 'solid');
    const form = inspector.locator('.content-search form');
    await form.evaluate((element) => {
      element.addEventListener('submit', () => element.setAttribute('data-submitted', 'true'), {
        once: true
      });
    });
    await page.keyboard.press('Enter');
    expect(await form.getAttribute('data-submitted')).toBeNull();
    await expect(checkbox).toBeChecked();
    await page.keyboard.press('Space');
    await expect(checkbox).not.toBeChecked();
    await page.emulateMedia({ forcedColors: 'active' });
    await expect(checkbox).toHaveCSS('appearance', 'auto');
    await checkbox.press('Space');
    await expect(checkbox).toBeChecked();
    await expect(option.locator('svg')).toBeHidden();
  });
}

test('Workspace tree rows reserve their background for hover and selection', async ({ page }) => {
  await page.goto(`${fixture.url}workbench-style.html?list-state=unselected&locale=en-US`);
  const tree = page.getByRole('region', { name: 'Workspace tree fixture' });
  const { meta, secondary } = await sessionListColors(tree);
  await expect(tree.locator('.tree-foot')).toHaveCSS('color', meta);
  const node = tree.getByRole('button', { name: 'Node', exact: true });
  await expect(node.locator('.tree-type-icon')).toHaveCSS('color', secondary);
  const row = tree.locator('.tree-node-row');
  const idleColor = await row.evaluate((element) => getComputedStyle(element).backgroundColor);
  await node.hover();
  const hoverColor = await row.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(hoverColor).not.toBe(idleColor);

  await node.click();
  await page.mouse.move(0, 0);
  await expect(node).toBeFocused();
  await expect(row).toHaveCSS('background-color', idleColor);

  await page.keyboard.press('Shift');
  await expect(node).toBeFocused();
  await expect(row).toHaveCSS('background-color', idleColor);

  await page.keyboard.press('Shift+Tab');
  const expand = row.locator('.node-expand-button');
  await expect(expand).toBeFocused();
  await expect(expand).toHaveCSS('outline-style', 'solid');
  await expect(row).toHaveCSS('background-color', idleColor);
});

for (const { theme, width } of [
  { theme: 'daylight', width: 1280 },
  { theme: 'vscode-dark-2026', width: 1280 },
  { theme: 'daylight', width: 390 },
  { theme: 'vscode-dark-2026', width: 390 }
]) {
  test(`Session list shows enabled schedule before pin in ${theme} at ${width}px`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(
      `${fixture.url}workbench-style.html?session-markers&unread=1&theme=${theme}&locale=en-US`
    );
    const sidebar = page
      .getByRole('region', { name: 'Session fixture' })
      .locator('.conversation-sidebar');
    const search = sidebar.locator('.session-search .mar-ui-input');
    const create = sidebar.locator('.new-session-button');
    const groups = sidebar.getByRole('radiogroup');
    for (const control of [
      search,
      create,
      groups,
      sidebar.locator('.session-search-button'),
      sidebar.locator('.workspace-more-button')
    ]) {
      await expect(control).toHaveCSS('height', '26px');
    }
    for (const label of [search.getByRole('textbox'), create, groups]) {
      await expect(label).toHaveCSS('font-size', '12px');
    }
    const options = groups.getByRole('radio');
    await expect(options).toHaveCount(2);
    for (const option of await options.all()) {
      await expect(option).toHaveCSS('height', '20px');
    }
    const list = sidebar.locator('.session-list');
    await expect(list.locator('strong')).toHaveText([
      'Scheduled',
      'Pinned',
      'Paused, still pinned',
      'Paused, not pinned',
      'Normal'
    ]);
    const { primary, secondary, meta, fontSize } = await sessionListColors(list);
    expect(meta).toBe(theme === 'daylight' ? 'rgb(82, 100, 124)' : 'rgb(160, 160, 160)');
    expect(primary).not.toBe(secondary);
    expect(secondary).not.toBe(meta);
    const tree = page.getByRole('region', { name: 'Workspace tree fixture' });
    const plain = tree.getByRole('button', { name: 'plain', exact: true });
    const group = tree.locator('.workspace-group-toggle').filter({ hasText: 'Team' });
    await expect(tree.getByRole('button', { name: 'Node', exact: true })).toHaveCSS(
      'color',
      secondary
    );
    await expect(group).toHaveCSS('color', secondary);
    await expect(group.locator('.tree-type-icon')).toHaveCSS('color', secondary);
    await expect(plain).toHaveCSS('color', primary);
    if ((await group.getAttribute('aria-expanded')) === 'false') await group.click();
    const grouped = tree.getByRole('button', { name: 'grouped', exact: true });
    await expect(grouped).toHaveCSS('color', secondary);
    if (width >= 768) {
      await grouped.hover();
      await expect(grouped).toHaveCSS('color', secondary);
    }
    await grouped.click();
    await expect(grouped).toHaveCSS('color', primary);
    await expect(plain).toHaveCSS('color', secondary);
    const row = (title: string) =>
      list.locator('.session-link').filter({ has: page.getByText(title, { exact: true }) });
    for (const [title, icon, name] of [
      ['Scheduled', 'clock', 'Scheduled task enabled'],
      ['Pinned', 'pin', 'Pinned'],
      ['Paused, still pinned', 'pin', 'Pinned']
    ] as const) {
      await expect(row(title).locator('svg[data-mar-icon]')).toHaveCount(1);
      const marker = row(title).getByRole('img', { name, exact: true });
      await expect(marker).toHaveAttribute('data-mar-icon', icon);
      await expect(marker).toHaveCSS('color', secondary);
    }
    for (const entry of await list.locator('.session-link').all()) {
      const title = entry.locator('strong');
      await expect(title).toHaveCSS(
        'color',
        (await entry.getAttribute('aria-current')) === 'page' ? primary : secondary
      );
      await expect(entry.locator('time')).toHaveCSS('color', meta);
      await expect(entry.locator('time')).toHaveText('>1m');
      await expect(title).toHaveCSS('font-size', fontSize);
      await expect(title).toHaveCSS('font-weight', '400');
    }
    for (const title of ['Paused, not pinned', 'Normal']) {
      await expect(row(title).locator('svg[data-mar-icon]')).toHaveCount(0);
    }
    const scheduled = row('Scheduled');
    const pinned = row('Paused, still pinned');
    if (width >= 768) {
      await scheduled.hover();
      await expect(scheduled.locator('strong')).toHaveCSS('color', secondary);
      await expect(scheduled.locator('..')).toHaveCSS(
        'background-color',
        theme === 'daylight' ? 'rgb(232, 241, 255)' : 'rgb(46, 46, 46)'
      );
    }
    for (const active of [scheduled, pinned]) {
      await active.click();
      await page.mouse.move(0, 0);
      await expect(active).toHaveAttribute('aria-current', 'page');
      await expect(active.locator('..')).toHaveCSS(
        'background-color',
        theme === 'daylight' ? 'rgb(220, 233, 255)' : 'rgb(55, 55, 55)'
      );
      await expect(active.locator('strong')).toHaveCSS('color', primary);
      await expect(active.locator('.session-relative-time')).toHaveCSS('color', meta);
      await expect(active.locator('strong')).toHaveCSS('font-weight', '400');
      await expect(active.getByRole('img', { name: /Pinned|Scheduled task enabled/ })).toHaveCSS(
        'color',
        primary
      );
    }
    await expect(scheduled).not.toHaveAttribute('aria-current', 'page');
    await expect(scheduled.locator('strong')).toHaveCSS('color', secondary);
    await expect(scheduled.getByRole('img', { name: 'Scheduled task enabled' })).toHaveCSS(
      'color',
      secondary
    );
    if (width >= 768)
      await tree.screenshot({ path: testInfo.outputPath('resource-tree-colors.png') });
    await list.screenshot({ path: testInfo.outputPath('session-list-markers.png') });
    await sidebar.screenshot({ path: testInfo.outputPath('workspace-sessions-compact.png') });
  });
}

for (const [theme, width] of [
  ['daylight', 1280],
  ['vscode-dark-2026', 1280],
  ['daylight', 390],
  ['vscode-dark-2026', 390]
] as const) {
  test(`Hosted history follows session title, pin and time colors in ${theme} at ${width}px`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const at = Date.now();
    const conversation = {
      id: 'current',
      nodeId: 'node',
      sessionId: 'session',
      templateId: 'template',
      templateName: 'General',
      activeVersionId: 'version',
      title: 'Current conversation',
      titleSource: 'CUSTOM',
      pinnedAt: at,
      status: 'ACTIVE',
      modelId: 'model',
      createdAt: at,
      updatedAt: at,
      lastActivityAt: at
    };
    const snapshot = hostedConversationSnapshotSchema.parse({
      conversation,
      template: {
        id: 'template',
        nodeId: 'node',
        name: 'General',
        description: '',
        status: 'ACTIVE',
        currentVersionId: 'version',
        available: true,
        createdAt: at,
        updatedAt: at
      },
      run: null,
      turns: [],
      historyNextCursor: null,
      files: [],
      models: [],
      error: null,
      snapshotSequence: 1
    });
    await page.route('**/api/hosted-template-fixture/current', (route) =>
      route.fulfill({ json: snapshot })
    );
    await page.route('**/api/hosted-conversations?limit=*', (route) =>
      route.fulfill({
        json: {
          items: [
            snapshot.conversation,
            { ...snapshot.conversation, id: 'other', title: 'Other conversation' }
          ],
          nextCursor: null
        }
      })
    );
    await page.route('**/hosted-conversations/current/watch', (route) => {
      if (route.request().method() === 'DELETE') return route.fulfill({ json: {} });
      return route.fulfill({
        json: {
          accepted: true,
          watchId: route.request().postDataJSON().watchId,
          nodeGeneration: 'fixture-generation',
          expiresAt: Date.now() + 30_000
        }
      });
    });
    await page.goto(
      `${fixture.url}hosted-entry.html?existing=1&workspace-page=1&history-open=1&theme=${theme}`
    );
    const historyFilter = page.locator('.history-search-row .mar-ui-input');
    await historyFilter.screenshot({ path: testInfo.outputPath('hosted-history-filter.png') });
    const textbox = historyFilter.getByRole('textbox');
    const font = '12px';
    await expect(historyFilter).toHaveCSS('height', '26px');
    await expect(page.locator('.history-refresh-button')).toHaveCSS('height', '26px');
    await expect(page.locator('.history-create-button')).toHaveCSS('height', '26px');
    await expect(textbox).toHaveCSS('font-size', font);
    expect(await textbox.evaluate((el) => getComputedStyle(el, '::placeholder').fontSize)).toBe(
      font
    );
    const list = page.locator('.hosted-conversation-history .history-list');
    const selected = list.locator('button[aria-current="page"]');
    const idle = list.locator('.history-open:not([aria-current])');
    await expect(selected.locator('strong')).toHaveText('Current conversation');
    await expect(idle.locator('strong')).toHaveText('Other conversation');
    const { primary, secondary, meta, fontSize } = await sessionListColors(list);
    for (const [row, color] of [
      [selected, primary],
      [idle, secondary]
    ] as const) {
      await expect(row.locator('strong')).toHaveCSS('color', color);
      await expect(row.locator('strong')).toHaveCSS('font-size', fontSize);
      await expect(row.locator('strong')).toHaveCSS('font-weight', '400');
      await expect(row.locator('svg[data-mar-icon="pin"]')).toHaveCSS('color', color);
      await expect(row.locator('time')).toHaveCSS('color', meta);
    }
    if (width >= 768) {
      await idle.hover();
      await expect(idle.locator('svg[data-mar-icon="pin"]')).toHaveCSS('color', secondary);
      await page.mouse.move(0, 0);
    }
    await list.screenshot({ path: testInfo.outputPath('hosted-history-colors.png') });
    await page.locator('.hosted-conversation-history').screenshot({
      path: testInfo.outputPath('hosted-history-compact.png')
    });
  });
}

for (const theme of ['daylight', 'vscode-dark-2026']) {
  for (const width of [1280, 390]) {
    test(`Workbench filters use standard controls in ${theme} at ${width}px`, async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.route('**/api/workspaces/workspace/**', async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith('/git/refs')) await route.fulfill({ json: { refs: [] } });
        else if (path.endsWith('/git/fetch'))
          await route.fulfill({ json: { fetchFailed: false, updated: false } });
        else if (path.endsWith('/git/history'))
          await route.fulfill({ json: { commits: [], nextCursor: null } });
        else if (path.endsWith('/changes'))
          await route.fulfill({
            json: {
              changes: [],
              repositories: [
                {
                  repositoryPath: '',
                  repositoryName: 'my-agent-roam',
                  source: 'ROOT',
                  current: true,
                  branch: 'main',
                  status: 'CLEAN',
                  locked: false,
                  prunable: false,
                  changes: []
                }
              ]
            }
          });
        else await route.fulfill({ json: { files: { entries: [], nextCursor: null } } });
      });
      const inspector = page.getByRole('region', { name: 'Inspector fixture' });
      const files = inspector.locator('.file-display-filter');
      if (theme === 'vscode-dark-2026' && width === 1280) {
        await page.goto(
          `${fixture.url}workbench-style.html?theme=${theme}&content-search=1&locale=zh-CN`
        );
        await files.screenshot({ path: testInfo.outputPath('files-filter.png') });
        await page.locator('.workspace-tree-filter .mar-ui-input').screenshot({
          path: testInfo.outputPath('resources-filter.png')
        });
        await page.locator('.session-search .mar-ui-input').screenshot({
          path: testInfo.outputPath('sessions-filter.png')
        });
      }
      await page.goto(
        `${fixture.url}workbench-style.html?theme=${theme}&content-search=1&locale=en-US`
      );
      await page.getByRole('button', { name: 'Open directory picker' }).click();
      const picker = page.getByRole('dialog', { name: 'Register Workspace' });
      const standard = picker.locator('.workspace-picker-filter');
      const appearance = (input: Locator) =>
        input.evaluate(async (wrapper) => {
          await Promise.all(wrapper.getAnimations().map((animation) => animation.finished));
          const style = getComputedStyle(wrapper);
          return {
            // A borderless input inherits the text color, which differs on dialog surfaces.
            border: style.borderTopWidth === '0px' ? 'none' : style.border,
            radius: style.borderRadius,
            background: style.backgroundColor,
            shadow: style.boxShadow,
            height: style.height,
            padding: getComputedStyle(wrapper.querySelector('.mar-ui-input__body')!).padding,
            font: getComputedStyle(wrapper.querySelector('input')!).fontSize,
            placeholderFont: getComputedStyle(wrapper.querySelector('input')!, '::placeholder')
              .fontSize
          };
        });
      await page.mouse.move(0, 0);
      const normal = await appearance(standard);
      expect(normal.font).toBe('12px');
      expect(normal.placeholderFont).toBe(normal.font);
      expect(normal.shadow).not.toBe('none');
      await standard.hover();
      const hover = await appearance(standard);
      await standard.locator('input').focus();
      const focused = await appearance(standard);
      expect(focused.border).toBe(normal.border);
      expect(focused.shadow).not.toBe(normal.shadow);
      expect(focused.background).toBe(normal.background);
      await picker.getByRole('button', { name: 'Cancel', exact: true }).click();

      for (const [name, input] of [
        ['files', files],
        ['resources', page.locator('.workspace-tree-filter .mar-ui-input')],
        ['sessions', page.locator('.session-search .mar-ui-input')],
        ['content', inspector.locator('.content-search .mar-ui-input')]
      ] as const) {
        if (name === 'content')
          await inspector.getByRole('tab', { name: 'Search', exact: true }).click();
        await input.scrollIntoViewIfNeeded();
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await page.mouse.move(0, 0);
        await expect.poll(() => appearance(input)).toEqual(normal);
        await input.hover();
        await expect.poll(() => appearance(input)).toEqual(hover);
        const textbox = input.locator('input');
        await textbox.focus();
        await expect(textbox).toBeFocused();
        await expect.poll(() => appearance(input)).toEqual(focused);
        await textbox.press('Tab');
        await page.keyboard.press('Shift+Tab');
        await expect(textbox).toBeFocused();
        await input.screenshot({ path: testInfo.outputPath(`${name}-filter-focused.png`) });
      }
      const query = inspector.getByRole('textbox', { name: 'Search file contents', exact: true });
      await query.fill('kept search draft');
      await expect(query).toHaveValue('kept search draft');
      await inspector.getByRole('tab', { name: 'Git Changes', exact: true }).click();
      await inspector.getByRole('tab', { name: 'Git History', exact: true }).click();
      await expect(inspector.getByText('No Git commit history.', { exact: true })).toBeVisible();
      await expect(inspector.locator('.git-history .git-fetch-notice')).toHaveCount(0);
      await expect(inspector.locator('.history-filter').first()).toContainText('my-agent-roam');
      const historyFilters = inspector.locator('.history-filter .mar-ui-select__field');
      await expect(historyFilters).toHaveCount(2);
      for (const filter of await historyFilters.all()) {
        await expect(filter).toHaveCSS('background-color', normal.background);
        await expect(filter).toHaveCSS('border-radius', normal.radius);
        await expect(filter).toHaveCSS('box-shadow', normal.shadow);
        await filter.getByRole('combobox').focus();
        await expect(filter).toHaveCSS('box-shadow', focused.shadow);
      }
      await inspector.screenshot({ path: testInfo.outputPath('history-standard-filters.png') });
      await inspector.getByRole('tab', { name: 'Search', exact: true }).click();
      await expect(query).toHaveValue('kept search draft');
    });
  }
}

test('late-mounted Files reveals the selected virtual row without taking focus', async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${fixture.url}workbench-style.html?late-tree=1`);
  const inspector = page.getByRole('region', { name: 'Inspector fixture' });
  const files = inspector.getByRole('tab', { name: 'Files', exact: true });
  await files.click();
  const selected = inspector.getByRole('treeitem', { name: /file-450\.ts/ });
  await expect(selected).toHaveAttribute('aria-selected', 'true');
  await expect
    .poll(() =>
      selected.evaluate((row) => {
        const tree = row.closest('.workspace-file-tree')!;
        const visible = tree.getBoundingClientRect();
        const bounds = row.getBoundingClientRect();
        return bounds.top >= visible.top && bounds.bottom <= visible.bottom;
      })
    )
    .toBe(true);
  await expect(files).toBeFocused();
});

for (const width of [1280, 390]) {
  test(`Closing the last embedded terminal preserves the new-terminal action at ${width}px`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 900 });
    let opens = 0;
    const closes: string[] = [];
    await page.route('**/api/terminals**', (route) => {
      if (route.request().method() === 'DELETE') {
        closes.push(new URL(route.request().url()).pathname);
        return route.fulfill({ json: {} });
      }
      if (route.request().method() === 'POST')
        return route.fulfill({
          json: {
            terminal: {
              id: `terminal-${++opens}`,
              workspaceId: 'workspace',
              profileId: 'bash',
              state: 'RUNNING',
              latestSequence: 0
            }
          }
        });
      return route.fulfill({ json: { terminals: [] } });
    });
    await page.goto(`${fixture.url}workbench-style.html?embedded-terminal`);
    const terminal = page.getByRole('region', { name: 'Terminal fixture' });
    const add = terminal.getByRole('button', { name: 'New terminal', exact: true });
    await expect(terminal.getByRole('tab', { name: 'Terminal 1', exact: true })).toBeVisible();
    await expect(terminal.getByRole('heading', { name: 'Terminal', exact: true })).toHaveCount(0);
    await expect(terminal.getByRole('region', { name: 'Terminal', exact: true })).toBeVisible();
    await expect(terminal.getByRole('tablist', { name: 'Terminal list' })).toBeVisible();
    for (const count of [1, 2]) {
      await terminal.getByRole('button', { name: 'Close terminal 1', exact: true }).click();
      await expect(terminal.getByRole('tab')).toHaveCount(0);
      await expect(add).toBeVisible();
      await expect(add).toBeEnabled();
      expect(opens).toBe(count);
      expect(closes).toHaveLength(count);
      await terminal.screenshot({ path: test.info().outputPath(`terminal-empty-${width}.png`) });
      await add.click();
      await expect(terminal.getByRole('tab', { name: 'Terminal 1', exact: true })).toBeVisible();
      expect(opens).toBe(count + 1);
    }
    await expect(terminal.locator('.admin-terminal-content')).toBeVisible();
  });
}

for (const theme of ['daylight', 'vscode-dark-2026']) {
  test(`Terminal capability is not confused with temporary unavailability in ${theme}`, async ({
    page
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.route('**/api/terminals**', (route) =>
      route.fulfill({
        json:
          route.request().method() === 'POST'
            ? {
                terminal: {
                  id: 'terminal-one',
                  workspaceId: 'workspace',
                  profileId: 'bash',
                  state: 'RUNNING',
                  latestSequence: 0
                }
              }
            : { terminals: [] }
      })
    );
    await page.goto(
      `${fixture.url}workbench-style.html?embedded-terminal&terminal-capability&theme=${theme}`
    );
    const add = page.getByRole('button', { name: 'New terminal', exact: true });
    await expect(add).toBeEnabled();
    for (const mode of ['unknown', 'disabled', 'unsupported'] as const) {
      await page.mouse.move(0, 0);
      await page.evaluate(
        (mode) =>
          (
            window as unknown as Window & {
              setFixtureTerminalAvailability(mode: 'unknown' | 'unsupported' | 'disabled'): void;
            }
          ).setFixtureTerminalAvailability(mode),
        mode
      );
      await expect(add).toBeDisabled();
      await add.scrollIntoViewIfNeeded();
      await add.hover();
      await expect(page.getByRole('tooltip')).toHaveText(
        mode === 'unsupported'
          ? 'You do not have permission to access this resource.'
          : 'New terminal'
      );
      await expect(page.getByRole('tooltip')).not.toContainText('PERMISSION_DENIED');
    }
  });
}

test('Pane model shortcut uses the focused Composer and preserves the draft', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.url}workbench-style.html?composer=1`);
  const composer = page.locator('.composer textarea');
  await composer.fill('kept draft');
  await composer.press('Alt+m');
  await expect(page.locator('.composer-model-effort-select [role=combobox]')).toBeFocused();
  await expect(composer).toHaveValue('kept draft');
});

test('Manual session dragging immediately takes over activity reorder motion', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.addInitScript(() => {
    const animate = Element.prototype.animate;
    let moves = 0;
    Element.prototype.animate = function (keyframes, options) {
      const animation = animate.call(this, keyframes, options);
      if (this.classList.contains('mar-session-reorder-item')) {
        animation.pause();
        document.documentElement.dataset.sessionMoves = String(++moves);
      }
      return animation;
    };
  });
  await page.goto(`${fixture.url}workbench-style.html?session-reorder=1`);
  const list = page.getByRole('region', { name: 'Session fixture' });
  const titles = list.locator('.session-link strong');
  await expect(titles).toHaveText(['pinned-one', 'pinned-two', 'pinned-three', 'active', 'idle']);
  await list.getByRole('button', { name: 'Advance session activity' }).click();
  await expect(titles).toHaveText(['pinned-one', 'pinned-two', 'pinned-three', 'idle', 'active']);
  await expect(page.locator('html')).toHaveAttribute('data-session-moves', '2');
  await list.locator('.session-list').evaluate((element) => {
    element.addEventListener('pointerdown', () => {
      element.setAttribute(
        'data-animations-at-pointerdown',
        String(Array.from(element.children).flatMap((row) => row.getAnimations()).length)
      );
    });
  });
  const source = list.locator('li').filter({ hasText: 'pinned-one' });
  const target = list.locator('li').filter({ hasText: 'pinned-two' });
  await source.dragTo(target, {
    targetPosition: { x: 30, y: (await target.boundingBox())!.height - 3 }
  });
  await expect(list.locator('.session-list')).toHaveAttribute(
    'data-animations-at-pointerdown',
    '0'
  );
  await expect(titles).toHaveText(['pinned-two', 'pinned-one', 'pinned-three', 'idle', 'active']);
  await expect(page.locator('html')).toHaveAttribute('data-session-moves', '2');
  expect(
    await list
      .locator('.session-list')
      .evaluate(
        (element) => Array.from(element.children).flatMap((row) => row.getAnimations()).length
      )
  ).toBe(0);

  await list.getByRole('button', { name: 'Advance session activity' }).click();
  await expect(titles).toHaveText(['pinned-two', 'pinned-one', 'pinned-three', 'active', 'idle']);
  await expect(page.locator('html')).toHaveAttribute('data-session-moves', '4');
});

for (const { sourceId, targetId, after, expected } of [
  { sourceId: 'one', targetId: 'three', after: false, expected: ['two', 'one', 'three'] },
  { sourceId: 'one', targetId: 'three', after: true, expected: ['two', 'three', 'one'] },
  { sourceId: 'three', targetId: 'one', after: false, expected: ['three', 'one', 'two'] },
  { sourceId: 'three', targetId: 'one', after: true, expected: ['one', 'three', 'two'] },
  { sourceId: 'one', targetId: 'two', after: false, expected: ['one', 'two', 'three'] },
  { sourceId: 'two', targetId: 'one', after: true, expected: ['one', 'two', 'three'] }
]) {
  test(`Pinned session drop matches the ${after ? 'bottom' : 'top'} line: ${sourceId} to ${targetId}`, async ({
    page
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${fixture.url}workbench-style.html?session-reorder=1`);
    const list = page.getByRole('region', { name: 'Session fixture' });
    const source = list.locator('li').filter({ hasText: `pinned-${sourceId}` });
    const target = list.locator('li').filter({ hasText: `pinned-${targetId}` });
    const bounds = (await target.boundingBox())!;
    await source.hover();
    await page.mouse.down();
    await page.mouse.move(bounds.x + 30, bounds.y + (after ? bounds.height - 3 : 3), { steps: 5 });
    // Chromium needs a second move to deliver native dragover after dragstart.
    await page.mouse.move(bounds.x + 31, bounds.y + (after ? bounds.height - 3 : 3));
    await expect(target).toHaveClass(/drag-over-pinned/);
    expect(await target.evaluate((row) => row.classList.contains('drag-over-pinned-after'))).toBe(
      after
    );
    await page.mouse.up();
    await expect(list.locator('.session-link strong')).toHaveText([
      ...expected.map((id) => `pinned-${id}`),
      'active',
      'idle'
    ]);
    await expect(list.locator('.drag-over-pinned')).toHaveCount(0);
  });
}

for (const scenario of [
  {
    width: 1280,
    locale: 'en-US',
    theme: 'daylight',
    copy: 'Copy absolute path',
    relative: 'Copy relative path',
    refresh: 'Refresh files'
  },
  {
    width: 390,
    locale: 'zh-CN',
    theme: 'vscode-dark-2026',
    copy: '复制绝对路径',
    relative: '复制相对路径',
    refresh: '刷新文件'
  }
]) {
  test(`File tree copies absolute paths for files, folders and the root at ${scenario.width}px`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width: scenario.width, height: 900 });
    await grantClipboardPermissions(page.context());
    await page.route('**/api/workspaces/workspace/**', (route) =>
      route.fulfill({
        json: {
          files: {
            entries: [
              { path: 'notes.txt', name: 'notes.txt', kind: 'FILE', size: 24 },
              { path: 'src', name: 'src', kind: 'DIRECTORY', size: null }
            ],
            nextCursor: null
          }
        }
      })
    );
    await page.goto(
      `${fixture.url}workbench-style.html?file-root=1&locale=${scenario.locale}&theme=${scenario.theme}`
    );
    const inspector = page.getByRole('region', { name: 'Inspector fixture' });
    const feedback = inspector.getByLabel('File operation feedback');
    await inspector.getByRole('button', { name: scenario.refresh, exact: true }).click();
    await test.step('Keep the file action focus outline clear of row clipping', async () => {
      await page.mouse.move(0, 0);
      await inspector.locator('[data-file-path="."]').press('ArrowDown');
      const folder = inspector.locator('[data-file-path="src"]');
      await expect(folder).toBeFocused();
      await page.keyboard.press('Tab');
      const shell = folder.locator('..');
      const more = shell.locator('.file-tree-more');
      await expect(more).toBeFocused();
      await expect(more).toHaveCSS('outline-style', 'solid');
      await expect(shell).toHaveCSS('overflow', 'visible');
    });
    const menu = async (path: string) => {
      await expect(page.getByRole('menuitem', { name: scenario.copy, exact: true })).toBeHidden();
      const row = inspector.locator(`[data-file-path="${path}"]`);
      await row.hover();
      await row.locator('..').locator('.file-tree-more').click();
    };
    for (const [path, absolute] of [
      ['.', '/home/example/my-agent-roam'],
      ['src', '/home/example/my-agent-roam/src'],
      ['notes.txt', '/home/example/my-agent-roam/notes.txt']
    ]) {
      await test.step(`Copy ${path}`, async () => {
        await menu(path!);
        const relativeAction = page.getByRole('menuitem', { name: scenario.relative, exact: true });
        const absoluteAction = page.getByRole('menuitem', { name: scenario.copy, exact: true });
        await expect(relativeAction.locator('[data-mar-icon="path-relative"]')).toBeVisible();
        await expect(absoluteAction.locator('[data-mar-icon="path-absolute"]')).toBeVisible();
        if (path === '.') {
          const relativeGlyph = relativeAction.locator('svg');
          await expect(relativeGlyph.locator('circle')).toHaveCount(1);
          await expect(absoluteAction.locator('circle')).toHaveCount(0);
          const geometry = await relativeGlyph.evaluate((element) => {
            const svg = element as SVGSVGElement;
            const dot = svg.querySelector('circle')!.getBBox();
            const slash = svg.querySelectorAll('path')[1]!;
            const halfStroke = parseFloat(getComputedStyle(slash).strokeWidth) / 2;
            const scale = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
            return {
              dotDiameter: dot.width * scale,
              gap: (slash.getBBox().x - halfStroke - dot.x - dot.width) * scale,
              stroke: getComputedStyle(slash).stroke,
              foreground: getComputedStyle(svg).color
            };
          });
          expect(geometry.dotDiameter).toBeGreaterThanOrEqual(1.2);
          expect(geometry.gap).toBeGreaterThanOrEqual(0.5);
          expect(geometry.stroke).toBe(geometry.foreground);
          await absoluteAction.locator('..').screenshot({
            path: testInfo.outputPath('copy-path-icons.png')
          });
        }
        await page.getByRole('menuitem', { name: scenario.copy, exact: true }).click();
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(absolute);
        await expect(feedback).toHaveAttribute('data-type', 'info');
      });
    }
    await menu('notes.txt');
    await page.getByRole('menuitem', { name: scenario.relative, exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('notes.txt');
    await inspector.getByRole('button', { name: 'Switch root path', exact: true }).click();
    await menu('.');
    await page.getByRole('menuitem', { name: scenario.copy, exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe('/home/other/my-agent-roam');
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async () => {
            throw new DOMException('Clipboard access denied', 'NotAllowedError');
          }
        }
      });
    });
    await menu('.');
    await page.getByRole('menuitem', { name: scenario.copy, exact: true }).click();
    await expect(feedback).toHaveAttribute('data-type', 'error');
    await inspector.getByRole('button', { name: 'Clear root path', exact: true }).click();
    await menu('notes.txt');
    await expect(page.getByRole('menuitem', { name: scenario.copy, exact: true })).toHaveAttribute(
      'aria-disabled',
      'true'
    );
    await expect(
      page
        .getByRole('menuitem', { name: scenario.copy, exact: true })
        .locator('[data-mar-icon="path-absolute"]')
    ).toBeVisible();
    await expect(
      page.getByRole('menuitem', { name: scenario.relative, exact: true })
    ).not.toHaveAttribute('aria-disabled', 'true');
  });
}

for (const theme of ['daylight', 'vscode-dark-2026']) {
  for (const width of [1280, 390]) {
    test(`List empty and initial loading states are centered in ${theme} at ${width}px`, async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.route('**/api/terminals**', (route) => route.fulfill({ json: { terminals: [] } }));
      await page.goto(`${fixture.url}workbench-style.html?theme=${theme}&list-state=main`);
      // Give the standalone sidebar a bounded pane like the product grid.
      await page.addStyleTag({
        content: `
          [aria-label="Session fixture"] > .conversation-sidebar,
          [aria-label="Workspace tree fixture"] { height: 360px; }
        `
      });
      const sessions = page.getByRole('region', { name: 'Session fixture' });
      const state = sessions.getByRole('combobox', { name: 'Set fixture list state' });
      const empty = sessions.locator('.sidebar-empty');
      for (const group of ['main', 'child']) {
        await state.selectOption(group);
        await expect(empty).toBeVisible();
        await expect(empty).toHaveCSS('text-align', 'center');
        await expect(empty).toContainText(group === 'main' ? 'main' : 'child');
      }
      await sessions.getByRole('textbox', { name: 'Set fixture search' }).fill('unmatched');
      await expect(empty).toContainText('No matching');
      await expect(empty).toHaveCSS('text-align', 'center');
      await state.selectOption('searching');
      await expect(sessions.locator('.watch-status.is-centered .mar-busy-indicator')).toBeVisible();
      await expect(sessions.locator('button [data-mar-icon="loading-action"]')).toHaveCount(0);
      await expect(empty).toHaveCount(0);
      await state.selectOption('search-failed');
      await expect(sessions.locator('.watch-status')).toHaveCount(0);
      await expect(empty).toHaveCount(0);
      await state.selectOption('loading');
      const loading = sessions.locator('.watch-status:not(.failed)');
      await expect(loading).toBeVisible();
      await sessions
        .locator('.conversation-sidebar')
        .screenshot({ path: testInfo.outputPath('sessions-initial.png') });
      const centerOffset = await loading.evaluate((status) => {
        const sidebar = status.closest<HTMLElement>('.conversation-sidebar')!;
        const controls = status.previousElementSibling!;
        const controlsBottom =
          controls.getBoundingClientRect().bottom +
          parseFloat(getComputedStyle(controls).marginBottom);
        const pane = sidebar.getBoundingClientRect();
        const paddingBottom = parseFloat(getComputedStyle(sidebar).paddingBottom);
        const indicator = status.querySelector('.mar-busy-indicator')!.getBoundingClientRect();
        return {
          x: indicator.x + indicator.width / 2 - (pane.x + pane.width / 2),
          y: indicator.y + indicator.height / 2 - (controlsBottom + pane.bottom - paddingBottom) / 2
        };
      });
      expect(Math.abs(centerOffset.x)).toBeLessThan(1);
      expect(Math.abs(centerOffset.y)).toBeLessThan(1);
      await expect(empty).toHaveCount(0);
      await state.selectOption('failed');
      await expect(sessions.locator('.watch-status.failed')).toBeVisible();
      await expect(sessions.locator('.watch-status.failed')).toHaveCSS('text-align', 'center');
      await expect(sessions.locator('.watch-status.failed')).toHaveClass(/is-centered/);
      await sessions
        .locator('.conversation-sidebar')
        .screenshot({ path: testInfo.outputPath('sessions-failed.png') });
      await expect(empty).toHaveCount(0);

      const tree = page.getByRole('region', { name: 'Workspace tree fixture' });
      await state.selectOption('main');
      await tree.locator('.workspace-tree-filter input').fill('unmatched');
      await expect(tree.locator('.tree-filter-empty')).toBeVisible();
      await expect(tree.locator('.tree-filter-empty')).toHaveCSS('text-align', 'center');
      await tree.screenshot({ path: testInfo.outputPath('tree-filter-empty.png') });
      const treeStatus = tree.getByRole('status');
      for (const [fixtureState, text] of [
        ['loading', 'Loading Nodes…'],
        ['failed', 'Node list unavailable'],
        ['no-nodes', 'No nodes']
      ]) {
        await state.selectOption(fixtureState);
        await expect(treeStatus).toHaveText(text);
        await expect(tree.locator('.tree-filter-empty')).toHaveCount(0);
        await expect(treeStatus.locator('[data-mar-icon="loading-action"]')).toHaveCount(
          fixtureState === 'loading' ? 1 : 0
        );
        const position = await treeStatus.evaluate((element) => {
          const panel = element.parentElement!.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(element);
          const content = range.getBoundingClientRect();
          return {
            top: content.top - panel.top,
            centerOffset: content.x + content.width / 2 - (panel.x + panel.width / 2)
          };
        });
        expect(position.top).toBeGreaterThanOrEqual(0);
        expect(position.top).toBeLessThan(24);
        expect(Math.abs(position.centerOffset)).toBeLessThanOrEqual(2);
        await tree.screenshot({ path: testInfo.outputPath(`tree-${fixtureState}.png`) });
      }
      await tree.screenshot({ path: testInfo.outputPath('tree-empty.png') });
      await state.selectOption('unselected');
      await expect(treeStatus).toHaveCount(0);
      await tree.locator('.workspace-tree-filter input').fill('');
      await expect(tree.getByRole('button', { name: 'Node', exact: true })).toBeVisible();
      await expect(tree.locator('.tree-foot')).toBeVisible();
      await state.selectOption('main');
      await expect(tree.locator('.tree-foot')).toHaveCount(0);
      await sessions.getByRole('textbox', { name: 'Set fixture search' }).fill('');
      await expect(empty).toBeVisible();
      const alignment = await empty.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const text = range.getBoundingClientRect();
        const panel = element.closest('.conversation-sidebar')!.getBoundingClientRect();
        return Math.abs(text.x + text.width / 2 - (panel.x + panel.width / 2));
      });
      expect(alignment).toBeLessThanOrEqual(1);
      await sessions.screenshot({ path: testInfo.outputPath('session-empty.png') });
    });
  }
}

for (const theme of ['daylight', 'vscode-dark-2026']) {
  test(`Unread labels share typography, color and geometry in ${theme}`, async ({ page }) => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${fixture.url}workbench-style.html?theme=${theme}&unread=1`);
      const properties = [
        'color',
        'background-color',
        'border-top-color',
        'border-top-width',
        'border-radius',
        'font-size',
        'font-weight',
        'line-height',
        'padding',
        'height'
      ];
      const reference = page.locator('.session-unread-label').first();
      await expect(reference).toBeVisible();
      const expected = await reference.evaluate(
        (element, properties) =>
          Object.fromEntries(
            properties.map((name) => [name, getComputedStyle(element).getPropertyValue(name)])
          ),
        properties
      );
      for (const selector of ['.workspace-tab-unread', '.session-unread-label']) {
        const badges = page.locator(`${selector}:visible`);
        expect(await badges.count()).toBeGreaterThan(0);
        for (const badge of await badges.all())
          for (const [property, value] of Object.entries(expected))
            await expect(badge).toHaveCSS(property, value);
      }
      await expect(page.locator('.session-state-unread:visible')).toHaveCount(0);
      await page.goto(`${fixture.url}visual-alignment.html?theme=${theme}`);
      await page.locator('.activity-center-trigger').click();
      await page.getByRole('tab', { name: 'Notifications', exact: true }).click();
      const notification = page.locator('.notification-unread-label').first();
      await expect(notification).toBeVisible();
      for (const [property, value] of Object.entries(expected))
        await expect(notification).toHaveCSS(property, value);
    }
  });

  test(`File tree roots use the actual directory instead of the Workspace alias in ${theme}`, async ({
    page
  }) => {
    await page.route('**/api/workspaces/workspace/**', (route) =>
      route.fulfill({
        json: {
          files: {
            entries: [{ path: 'README.md', name: 'README.md', kind: 'FILE', size: 1 }],
            nextCursor: null
          }
        }
      })
    );
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${fixture.url}workbench-style.html?theme=${theme}&file-root=1`);
      const inspector = page.getByRole('region', { name: 'Inspector fixture' });
      const root = inspector.locator('[role="treeitem"][data-file-path="."]');
      await expect(root.locator('.tree-name')).toHaveText('my-agent-roam');
      await expect(root).toHaveAccessibleName('/home/example/my-agent-roam');
      if (width >= 768) {
        await root.scrollIntoViewIfNeeded();
        await page.mouse.move(0, 0);
        await root.hover();
        await expect(page.getByRole('tooltip')).toHaveText('/home/example/my-agent-roam');
      }
      await root.click();
      await expect(root).toHaveAttribute('aria-expanded', 'false');
      await root.click();
      await expect(root).toHaveAttribute('aria-expanded', 'true');
      const child = inspector.getByRole('treeitem', { name: 'README.md', exact: true });
      await expect(child).toBeVisible();
      await inspector.getByRole('button', { name: 'Clear root path', exact: true }).click();
      await expect(root.locator('.tree-name')).toHaveText('.');
      await expect(root).toHaveAccessibleName('.');
      await expect(child).toBeVisible();
      await inspector.getByRole('button', { name: 'Switch root path', exact: true }).click();
      await expect(root.locator('.tree-name')).toHaveText('my-agent-roam');
      await expect(root).toHaveAccessibleName('/home/other/my-agent-roam');
    }
  });

  test(`Git repository headers keep tags subordinate to file content in ${theme}`, async ({
    page
  }, testInfo) => {
    const change = {
      repositoryPath: '',
      repositoryName: 'my-agent-roam',
      source: 'ROOT',
      path: 'src/main.ts',
      state: 'UNSTAGED',
      change: 'MODIFIED',
      diffAvailable: true
    };
    await page.route('**/api/workspaces/workspace/**', (route) =>
      route.fulfill({
        json: new URL(route.request().url()).pathname.endsWith('/changes')
          ? {
              changes: [change],
              repositories: [
                {
                  repositoryPath: '',
                  repositoryName: 'my-agent-roam',
                  physicalPath: '/home/example/project',
                  source: 'ROOT',
                  current: true,
                  branch: 'develop',
                  status: 'DIRTY',
                  tracking: { upstream: 'origin/develop', ahead: 25, behind: 0 },
                  changes: [change]
                },
                {
                  repositoryPath: 'packages/agent',
                  repositoryName: 'agent',
                  source: 'SUBMODULE',
                  current: false,
                  branch: 'develop',
                  status: 'CLEAN',
                  changes: []
                },
                {
                  repositoryPath: '',
                  repositoryName: 'review',
                  worktreePath: '/home/example/project/.worktrees/review',
                  physicalPath: '/home/example/project/.worktrees/review',
                  source: 'WORKTREE',
                  current: false,
                  branch: 'feature/long-branch-name',
                  status: 'UNAVAILABLE',
                  locked: true,
                  changes: []
                }
              ]
            }
          : { files: { entries: [], nextCursor: null } }
      })
    );
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${fixture.url}workbench-style.html?theme=${theme}&git-previews=1`);
      const inspector = page.getByRole('region', { name: 'Inspector fixture' });
      if (width >= 768) {
        await inspector.evaluate((element) => {
          (element as HTMLElement).style.width = '360px';
        });
      }
      await inspector.getByRole('tab', { name: 'Git Changes', exact: true }).click();
      const headings = inspector.locator('.change-repository-heading');
      await expect(headings).toHaveCount(3);
      const root = headings.first();
      const sessionHeading = page
        .getByRole('region', { name: 'Session fixture' })
        .locator('.session-heading');
      const branchTag = sessionHeading.locator('.workspace-branch-tag');
      const repositoryTag = headings.nth(1).locator('.repository-kind');
      await expect(branchTag).toHaveText('develop');
      await expect(branchTag).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      for (const property of ['padding-inline-start', 'padding-inline-end', 'border-top-color']) {
        const expected = await repositoryTag.evaluate(
          (element, name) => getComputedStyle(element).getPropertyValue(name),
          property
        );
        await expect(branchTag).toHaveCSS(property, expected);
      }
      if (width === 1280) {
        await sessionHeading.screenshot({
          path: testInfo.outputPath('session-branch.png'),
          animations: 'disabled'
        });
      }
      const titleRows = headings.locator('.repository-title-row');
      await page.evaluate(() => document.fonts.ready);
      for (const name of await titleRows.locator('strong').all()) {
        const inkClearance = await name.evaluate((element) => {
          const style = getComputedStyle(element);
          const canvas = document.createElement('canvas').getContext('2d')!;
          canvas.font = [style.fontStyle, style.fontWeight, style.fontSize, style.fontFamily].join(
            ' '
          );
          const ink = canvas.measureText(element.textContent ?? '');
          const clip = element.getBoundingClientRect();
          const baselineMarker = document.createElement('span');
          baselineMarker.style.cssText =
            'display:inline-block;width:0;height:0;margin:0;padding:0;border:0;' +
            'vertical-align:baseline';
          element.append(baselineMarker);
          const baseline = baselineMarker.getBoundingClientRect().top;
          baselineMarker.remove();
          return {
            top: baseline - ink.actualBoundingBoxAscent - clip.top,
            bottom: clip.bottom - baseline - ink.actualBoundingBoxDescent
          };
        });
        expect(inkClearance.top).toBeGreaterThanOrEqual(0);
        expect(inkClearance.bottom).toBeGreaterThanOrEqual(0);
      }
      const compactSize = await root.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).getPropertyValue('--mar-compact-control-size'))
      );
      for (const row of await titleRows.all()) {
        expect((await row.boundingBox())!.height).toBeCloseTo(compactSize, 1);
      }
      const refresh = root.getByRole('button', { name: 'Refresh Git changes', exact: true });
      await expect(root.locator('.repository-title-row .changes-refresh-button')).toHaveCount(1);
      const refreshBounds = (await refresh.boundingBox())!;
      const titleBounds = (await root.locator('.repository-title-row').boundingBox())!;
      expect(refreshBounds.y + refreshBounds.height / 2).toBeCloseTo(
        titleBounds.y + titleBounds.height / 2,
        1
      );
      expect(refreshBounds.x + refreshBounds.width).toBeCloseTo(
        titleBounds.x + titleBounds.width,
        1
      );
      expect(refreshBounds.height).toBeCloseTo(compactSize, 1);
      expect(refreshBounds.width).toBeCloseTo(compactSize, 1);
      await expect(root.locator('.repository-title-row strong')).toHaveCSS('font-weight', '500');
      await expect(root.locator('.repository-title-row strong')).toHaveCSS(
        'font-size',
        width >= 768 ? '14px' : '13px'
      );
      for (const tag of await inspector.locator('.repository-tags-row .mar-ui-tag').all()) {
        // MarTag's minimum block size takes precedence over the repository row's em height.
        await expect(tag).toHaveCSS('height', '20px');
        await expect(tag).toHaveCSS('font-weight', '400');
        await expect(tag).toHaveCSS('font-size', width >= 768 ? '12px' : '11px');
      }
      const colors = await root.evaluate((element, scheme) => {
        const probe = document.createElement('span');
        element.append(probe);
        probe.style.color = 'var(--mar-border-default)';
        const syncBorder = getComputedStyle(probe).color;
        if (scheme !== 'daylight') probe.style.color = 'var(--mar-border-medium)';
        const kindBorder = getComputedStyle(probe).color;
        probe.style.color = 'var(--mar-text-secondary)';
        const secondary = getComputedStyle(probe).color;
        probe.style.color = 'var(--mar-color-git-graph-main)';
        const gitBlue = getComputedStyle(probe).color;
        probe.remove();
        return { kindBorder, syncBorder, secondary, gitBlue };
      }, theme);
      await expect(root.locator('.repository-current')).toHaveCSS('color', colors.secondary);
      for (const selector of ['.repository-kind', '.repository-current']) {
        await expect(root.locator(selector)).toHaveCSS('border-color', colors.kindBorder);
      }
      await expect(root.locator('.repository-sync-tag')).toHaveCSS(
        'border-color',
        colors.syncBorder
      );
      const syncTag = root.locator('.repository-sync-tag');
      await expect(syncTag).toHaveText('↓ 0 ↑ 25');
      await expect(syncTag).toHaveCSS('color', colors.gitBlue);
      await expect(syncTag).not.toHaveAttribute('title');
      const description = await syncTag.getAttribute('aria-label');
      expect(description).toContain('origin/develop');
      expect(description).toContain('25');
      if (width >= 768) {
        await syncTag.scrollIntoViewIfNeeded();
        // Flush the queued scroll event before hover; scrolling intentionally closes hints.
        await page.evaluate(
          () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        );
        await syncTag.hover();
        const hint = page.locator('.mar-tooltip:visible');
        await expect(hint).toHaveText(description!);
        await expect
          .poll(() => hint.evaluate((element) => getComputedStyle(element, '::before').content))
          .toBe('""');
        await page.screenshot({ path: testInfo.outputPath('git-sync-tooltip.png') });
        await page.mouse.move(0, 0);
        await expect(hint).toHaveCount(0);
        await page.evaluate(() => {
          document.documentElement.style.setProperty('--mar-control-primary-fg', '#c94b71');
        });
        await expect(syncTag).toHaveCSS('color', colors.gitBlue);
        await page.evaluate(() => {
          document.documentElement.style.setProperty('--mar-color-git-graph-main', '#9454c0');
        });
        await expect(syncTag).toHaveCSS('color', 'rgb(148, 84, 192)');
        await expect(root.locator('.repository-current')).toHaveCSS('color', colors.secondary);
        await page.evaluate(() => {
          document.documentElement.style.removeProperty('--mar-control-primary-fg');
          document.documentElement.style.removeProperty('--mar-color-git-graph-main');
        });
      }
      await expect(root.locator('.mar-ui-tag[data-type="warning"]')).toBeVisible();
      await expect(headings.nth(1).locator('.mar-ui-tag[data-type="success"]')).toBeVisible();
      await expect(headings.nth(2).locator('.mar-ui-tag[data-type="warning"]')).toBeVisible();
      await expect(inspector.locator('.change-file-name')).toHaveCSS(
        'font-size',
        width >= 768 ? '12px' : '11px'
      );
      const changeEntry = inspector.locator('.change-entry').filter({ hasText: 'main.ts' });
      const changePath = changeEntry.locator('.change-path');
      await expect(changeEntry.locator('.change-status[data-file-change="MODIFIED"]')).toHaveCSS(
        'color',
        theme === 'daylight' ? 'rgb(133, 74, 0)' : 'rgb(248, 203, 114)'
      );
      await expect(changeEntry.locator('small.change-status')).toHaveCSS('color', colors.secondary);
      if (width >= 768) {
        const rowHover = await changeEntry.evaluate((row) => {
          const probe = document.createElement('span');
          probe.style.color = 'var(--mar-fill-row-hover)';
          row.append(probe);
          const color = getComputedStyle(probe).color;
          probe.remove();
          return color;
        });
        await changePath.hover();
        await expect(changeEntry).toHaveCSS('background-color', rowHover);
        await expect(changePath).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await page.mouse.move(0, 0);
        await page.keyboard.press('Tab');
        await changePath.focus();
        await expect(changePath).toHaveCSS('outline-style', 'solid');
        await expect(changePath).toHaveCSS('outline-width', '2px');
        await changePath.blur();
      }
      // Keep the gap compact without assuming a specific font's inline box metrics.
      await expect(root).toHaveCSS('padding-bottom', '0px');
      const { rowGap, pathToFileGap } = await root.evaluate((heading) => {
        const path = heading.querySelector('.repository-physical-path')!.getBoundingClientRect();
        const row = heading.nextElementSibling!;
        const file = row.querySelector('.change-file-name')!.getBoundingClientRect();
        return {
          rowGap: row.getBoundingClientRect().top - path.bottom,
          pathToFileGap: file.top - path.bottom
        };
      });
      expect(rowGap).toBeCloseTo(0, 1);
      expect(pathToFileGap).toBeGreaterThan(0);
      expect(pathToFileGap).toBeLessThanOrEqual(6);
      expect(
        await headings.nth(1).evaluate((heading) => parseFloat(getComputedStyle(heading).marginTop))
      ).toBeGreaterThan(6);
      for (const heading of await headings.all()) {
        expect(
          await heading.evaluate((element) => element.scrollWidth <= element.clientWidth)
        ).toBe(true);
      }
      await inspector.screenshot({
        path: testInfo.outputPath(`git-headers-${width}.png`),
        animations: 'disabled'
      });
      for (const row of await titleRows.all()) {
        await row.evaluate((element) => {
          (element as HTMLElement).style.fontSize = '2em';
        });
        const rowHeight = (await row.boundingBox())!.height;
        expect(rowHeight).toBeGreaterThan(compactSize);
        expect(rowHeight).toBeGreaterThanOrEqual(
          (await row.locator('strong').boundingBox())!.height
        );
      }
    }
  });

  test(`Git Changes retry and local automatic batches in ${theme}`, async ({ page }) => {
    let reads = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let releaseFetch: (() => void) | undefined;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const entries = Array.from({ length: 205 }, (_, index) => ({
      repositoryPath: '',
      repositoryName: 'root',
      source: 'ROOT',
      path: `file-${index}.ts`,
      state: 'UNSTAGED',
      change: 'MODIFIED',
      diffAvailable: true
    }));
    await page.route('**/api/workspaces/workspace/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/changes')) {
        if (++reads === 1)
          await route.fulfill({
            status: 503,
            json: { error: { code: 'NODE_OFFLINE', message: 'Offline' } }
          });
        else {
          await gate;
          await route.fulfill({
            json: {
              changes: entries,
              repositories: [
                {
                  repositoryPath: '',
                  repositoryName: 'root',
                  source: 'ROOT',
                  current: true,
                  status: 'DIRTY',
                  changes: entries
                }
              ]
            }
          });
        }
      } else if (path.endsWith('/git/fetch')) {
        await fetchGate;
        await route.fulfill({ json: { fetchFailed: false, updated: true } });
      } else await route.fulfill({ json: { files: { entries: [], nextCursor: null } } });
    });
    await page.goto(`${fixture.url}workbench-style.html?theme=${theme}&git-previews=1`);
    const inspector = page.getByRole('region', { name: 'Inspector fixture' });
    await inspector.evaluate((element) => {
      (element as HTMLElement).style.height = '360px';
    });
    await inspector.getByRole('tab', { name: 'Git Changes', exact: true }).click();
    const retry = inspector.locator('.changes-read-state button');
    await expect(retry).toHaveAttribute('aria-description', /NODE_OFFLINE/);
    await expect(inspector.locator('.current-changes .mar-empty')).toHaveCount(0);
    await expect(inspector.getByLabel('File operation feedback')).toHaveText('');
    await retry.click();
    await expect(retry).toBeFocused();
    await expect(retry).toHaveAttribute('aria-busy', 'true');
    release?.();
    const list = inspector.locator('.change-list');
    await expect(list.locator('.change-path')).toHaveCount(200);
    expect(reads).toBe(2);
    releaseFetch?.();
    await expect.poll(() => reads).toBe(3);
    await expect(
      inspector.getByRole('button', { name: 'Refresh Git changes', exact: true })
    ).toBeEnabled();
    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(list.locator('.change-path')).toHaveCount(205);
    expect(reads).toBe(3);
    await expect(inspector.getByRole('button', { name: 'Load more' })).toHaveCount(0);
  });

  test(`Content search uses neutral row feedback without losing match emphasis in ${theme}`, async ({
    page
  }, testInfo) => {
    const directory = 'src/a-very-long-parent-directory/with-another-nested-folder';
    const path = `${directory}/main.ts`;
    const longFileName = `${'long-file-name-'.repeat(12)}main.ts`;
    const longPath = `${directory}/${longFileName}`;
    await page.route('**/api/workspaces/workspace/**', (route) =>
      route.fulfill({
        json: route.request().url().includes('/content/search')
          ? {
              search: {
                matches: [
                  { path, line: 2, column: 7, preview: 'const needle = true;' },
                  { path: longPath, line: 3, column: 7, preview: 'const needle = false;' }
                ],
                truncated: false
              }
            }
          : { files: { entries: [], nextCursor: null } }
      })
    );
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`${fixture.url}workbench-style.html?theme=${theme}&content-search=1`);
      const inspector = page.getByRole('region', { name: 'Inspector fixture' });
      await inspector
        .locator('.workbench-aside-tabs button')
        .filter({ hasText: /^Search$/ })
        .click();
      const input = inspector.getByRole('textbox', { name: 'Search file contents', exact: true });
      await input.fill('needle');
      await input.press('Enter');
      const result = inspector.getByRole('button', { name: path, exact: true });
      const fileName = result.getByText('main.ts', { exact: true });
      const folder = result.getByText(directory, { exact: true });
      const line = result.locator('small');
      const preview = result.locator('code');
      await expect(fileName).toBeVisible();
      await expect(folder).toBeVisible();
      await expect(line).toHaveText('Line 2');
      await expect(inspector.getByRole('alert')).toHaveCount(0);
      await expect(result.locator('mark')).toHaveText('needle');
      const style = await result.evaluate((element) => {
        const probe = document.createElement('span');
        element.append(probe);
        const color = (token: string) => {
          probe.style.color = `var(${token})`;
          return getComputedStyle(probe).color;
        };
        const resolved = {
          primary: color('--mar-text-primary'),
          hover: color('--mar-fill-row-hover'),
          focus: color('--mar-control-focus'),
          match: getComputedStyle(element.querySelector('mark')!).backgroundColor,
          meta: getComputedStyle(probe).getPropertyValue('--mar-font-size-meta').trim(),
          nano: getComputedStyle(probe).getPropertyValue('--mar-font-size-nano').trim()
        };
        probe.remove();
        return resolved;
      });
      await expect(fileName).toHaveCSS('font-size', style.meta);
      await expect(fileName).toHaveCSS('font-weight', '400');
      await expect(preview).toHaveCSS('font-size', style.meta);
      await expect(folder).toHaveCSS('font-size', style.nano);
      await expect(line).toHaveCSS('font-size', style.nano);
      expect((await preview.boundingBox())!.x).toBeCloseTo((await fileName.boundingBox())!.x);
      const longResult = inspector.getByRole('button', { name: longPath, exact: true });
      const longResultFolder = longResult.getByText(directory, { exact: true });
      expect((await longResultFolder.boundingBox())!.width).toBeGreaterThan(24);
      await result.hover();
      await expect(result).toHaveCSS('background-color', style.hover);
      await expect(result).toHaveCSS('color', style.primary);
      await expect(result.locator('mark')).toHaveCSS('background-color', style.match);
      await result.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(result).toBeFocused();
      await expect(result).toHaveCSS('outline-color', style.focus);
      await expect(result).toHaveCSS('outline-style', 'solid');
      await page.screenshot({ path: testInfo.outputPath(`content-search-${width}.png`) });
    }
  });

  for (const locale of ['en-US', 'zh-CN']) {
    for (const viewportWidth of [1280, 390]) {
      test(`Inspector tabs fit panel widths in ${theme} (${locale}) at ${viewportWidth}px`, async ({
        page
      }, testInfo) => {
        await page.setViewportSize({ width: viewportWidth, height: 900 });
        await page.route('**/api/terminals**', (route) =>
          route.fulfill({ json: { terminals: [] } })
        );
        await page.goto(`${fixture.url}workbench-style.html?theme=${theme}&locale=${locale}`);
        const inspector = page.getByRole('region', { name: 'Inspector fixture' });
        const strip = inspector.getByRole('tablist');
        const tabs = strip.getByRole('tab');
        await expect(tabs).toHaveCount(4);
        // Aside uses the shared compact Tab token, including its mobile size.
        await expect(tabs.first()).toHaveCSS('font-size', '12px');
        for (const width of viewportWidth >= 768 ? [341, 275] : [366, 320]) {
          await inspector.evaluate((element, width) => {
            (element as HTMLElement).style.width = `${width}px`;
          }, width);
          expect(
            await strip.evaluate((element) => element.scrollWidth <= element.clientWidth)
          ).toBe(true);
          const bounds = (await strip.boundingBox())!;
          for (const tab of await tabs.all()) {
            const tabBounds = (await tab.boundingBox())!;
            expect(tabBounds.x).toBeGreaterThanOrEqual(bounds.x);
            expect(tabBounds.x + tabBounds.width).toBeLessThanOrEqual(bounds.x + bounds.width);
          }
          const items = await strip.locator('.mar-tab-strip-item').evaluateAll((elements) =>
            elements.map((element) => {
              const bounds = element.getBoundingClientRect();
              return {
                left: bounds.left,
                right: bounds.right,
                bottom: bounds.bottom,
                border: parseFloat(getComputedStyle(element).borderLeftWidth)
              };
            })
          );
          for (let index = 1; index < items.length; index += 1) {
            expect(items[index]!.left).toBeCloseTo(
              items[index - 1]!.right - items[index]!.border,
              1
            );
            expect(items[index]!.bottom).toBeCloseTo(bounds.y + bounds.height, 1);
          }
        }
        await inspector.screenshot({ path: testInfo.outputPath('inspector-tabs.png') });
        await inspector.evaluate((element) => {
          (element as HTMLElement).style.width = '200px';
        });
        await expect(strip).toHaveCSS('overflow-x', 'auto');
        expect(await strip.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
          true
        );
        await tabs.last().scrollIntoViewIfNeeded();
        await tabs.last().click();
        await expect(tabs.last()).toHaveAttribute('aria-selected', 'true');
      });
    }
  }
}

for (const theme of ['daylight', 'vscode-dark-2026']) {
  for (const width of [1280, 390]) {
    test(`Workspace connection feedback is singular and restrictions stay neutral in ${theme} at ${width}px`, async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(
        `${fixture.url}workbench-style.html?theme=${theme}&offline=1&network-offline=1`
      );
      const offline = page.locator('.workspace-offline-placeholder');
      await expect(offline).toBeVisible();
      await expect(offline).toContainText('Offline. Waiting for reconnection.');
      await expect(
        page.locator('.readonly-banner, .workspace-recovery-panel, .mar-message')
      ).toHaveCount(0);
      await offline.screenshot({ path: testInfo.outputPath('network-offline.png') });
      await page.evaluate(() => {
        (
          window as unknown as Window & { restoreWorkspaceConnection: () => void }
        ).restoreWorkspaceConnection();
      });
      await expect(offline).toHaveCount(0);
      await expect(page.locator('.workspace-recovery-panel')).toBeVisible();
      await expect(page.locator('.mar-message')).toHaveCount(0);

      await page.goto(`${fixture.url}workbench-style.html?theme=${theme}&offline=1&restriction=1`);
      const notice = page.locator('.readonly-banner');
      await expect(notice).toBeVisible();
      await expect(notice).toHaveAttribute('role', 'status');
      await expect(notice).toContainText('disabled');
      await expect(notice.locator('[data-mar-icon="info"]')).toBeVisible();
      await expect(notice).toHaveCSS('border-radius', '6px');
      const surface = (await page.locator('.session-layout').boundingBox())!;
      const box = (await notice.boundingBox())!;
      expect(box.x - surface.x).toBeGreaterThanOrEqual(8);
      expect(surface.x + surface.width - box.x - box.width).toBeGreaterThanOrEqual(8);
      await notice.screenshot({ path: testInfo.outputPath('workspace-restriction.png') });
    });

    test(`Workspace recovery stays compact and centered in ${theme} at ${width}px`, async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${fixture.url}workbench-style.html?theme=${theme}&workspace-recovery=1`);
      const panel = page.locator('.workspace-selection-panel');
      const failure = panel.locator('[role="status"]');
      const retry = panel.getByRole('button');
      await expect(failure).toBeVisible();
      await expect(panel.locator('.mar-ui-empty')).toHaveCount(0);
      await expect(retry).toHaveClass(/mar-ui-button--inline/);
      await expect(retry).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(retry).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
      await expect(retry).toHaveCSS('border-bottom-color', 'rgba(0, 0, 0, 0)');
      const outer = (await panel.boundingBox())!;
      const content = (await panel.locator('.workspace-recovery-state').boundingBox())!;
      expect(Math.abs(content.x + content.width / 2 - outer.x - outer.width / 2)).toBeLessThan(2);
      expect(Math.abs(content.y + content.height / 2 - outer.y - outer.height / 2)).toBeLessThan(2);
      const retryBounds = await retry.boundingBox();
      expect(retryBounds).not.toBeNull();
      await page.screenshot({ path: testInfo.outputPath('workspace-recovery.png') });
      await retry.click();
      const busyRetry = panel.getByRole('button', { name: 'Loading', exact: true });
      const ring = busyRetry.locator('.mar-read-loading-indicator');
      await expect(busyRetry).toBeFocused();
      await expect(busyRetry).toHaveAttribute('aria-busy', 'true');
      await expect(ring).toBeVisible();
      await expect.poll(() => busyRetry.boundingBox()).toEqual(retryBounds);
      const ringBounds = (await ring.boundingBox())!;
      expect(
        Math.abs(ringBounds.x + ringBounds.width / 2 - (retryBounds!.x + retryBounds!.width / 2))
      ).toBeLessThan(1);
      expect(
        Math.abs(ringBounds.y + ringBounds.height / 2 - (retryBounds!.y + retryBounds!.height / 2))
      ).toBeLessThan(1);
      await expect(failure).toBeHidden();
      await expect(panel.locator('.mar-busy-indicator')).toHaveCount(1);
      await expect(panel.locator('.mar-page-loading-state')).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath('workspace-recovery-retrying.png') });
      await page.keyboard.press('Enter');
      expect(
        await page.evaluate(() =>
          (
            window as Window & { failWorkspaceRecoveryRead: () => number }
          ).failWorkspaceRecoveryRead()
        )
      ).toBe(1);
      await expect(failure).toBeVisible();
      await expect(retry).toBeFocused();
      await expect(retry).not.toHaveAttribute('aria-busy', 'true');
    });

    test(`Offline Workspace uses a static disconnected icon in ${theme} at ${width}px`, async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.route('**/api/terminals**', (route) => route.fulfill({ json: { terminals: [] } }));
      await page.goto(`${fixture.url}workbench-style.html?theme=${theme}&offline=1`);
      const offline = page.locator('.workspace-offline-placeholder');
      await expect(offline).toBeVisible();
      await expect(offline).toHaveAttribute('role', 'status');
      const offlineIcon = offline.locator('[data-mar-icon="connection-off"]');
      await expect(offlineIcon).toBeVisible();
      await expect(offlineIcon).toBeInViewport({ ratio: 1 });
      await expect(offline.locator('svg')).toHaveCount(1);
      await expect(offlineIcon).toHaveAttribute('aria-hidden', 'true');
      await expect(offlineIcon).toHaveCSS('animation-name', 'none');
      const geometry = await offlineIcon.evaluate((element) => {
        const bounds = (element as SVGSVGElement).getBBox();
        const viewportBounds = element.getBoundingClientRect();
        const hitTarget = document.elementFromPoint(
          viewportBounds.x + viewportBounds.width / 2,
          viewportBounds.y + viewportBounds.height / 2
        );
        const style = getComputedStyle(element);
        const stroke = parseFloat(style.strokeWidth);
        return {
          color: style.color,
          stroke: style.stroke,
          width: parseFloat(style.width),
          height: parseFloat(style.height),
          rootFontSize: parseFloat(getComputedStyle(document.documentElement).fontSize),
          min: Math.min(bounds.x, bounds.y) - stroke / 2,
          max: Math.max(bounds.x + bounds.width, bounds.y + bounds.height) + stroke / 2,
          unobscured: hitTarget === element || element.contains(hitTarget),
          pseudoContent: getComputedStyle(element, '::after').content
        };
      });
      const expectedSize = geometry.rootFontSize * (width < 768 ? 1.5 : 1.75);
      expect(geometry.width).toBeCloseTo(expectedSize, 1);
      expect(geometry.height).toBeCloseTo(expectedSize, 1);
      expect(geometry.stroke).toBe(geometry.color);
      expect(geometry.min).toBeGreaterThan(0);
      expect(geometry.max).toBeLessThan(24);
      expect(geometry.unobscured).toBe(true);
      expect(['none', 'normal']).toContain(geometry.pseudoContent);
      await offline.screenshot({ path: testInfo.outputPath('offline-connection-icon.png') });
    });

    test(`Session row feedback stays immediate in ${theme} at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.route('**/api/terminals**', (route) => route.fulfill({ json: { terminals: [] } }));
      await page.goto(`${fixture.url}workbench-style.html?theme=${theme}`);
      const sessions = page.getByRole('region', { name: 'Session fixture' });
      const selected = sessions.locator('.session-row.selected');
      const idle = sessions.locator('.session-row').filter({ hasText: 'idle' });
      await expect(selected).toHaveCSS('transition-duration', '0s');
      await expect(idle).toHaveCSS('transition-duration', '0s');
      const selectionColor = await selected.evaluate(
        (element) => getComputedStyle(element).backgroundColor
      );
      expect(selectionColor).not.toBe('rgba(0, 0, 0, 0)');
      await selected.hover();
      await expect(selected).toHaveCSS('background-color', selectionColor);
      await page.mouse.move(0, 0);
      await expect(idle).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await idle.hover();
      const hoverColor = await idle.evaluate(
        (element) => getComputedStyle(element).backgroundColor
      );
      expect(hoverColor).not.toBe('rgba(0, 0, 0, 0)');
      expect(hoverColor).not.toBe(selectionColor);
      await page.mouse.move(0, 0);
      const link = idle.locator('.session-link');
      await page.keyboard.press('Tab');
      await link.focus();
      await expect(link).toBeFocused();
      expect(await link.evaluate((element) => element.matches(':focus-visible'))).toBe(true);
      await expect(link).not.toHaveCSS('outline-style', 'none');
      expect(
        await link.evaluate((element) => parseFloat(getComputedStyle(element).outlineWidth))
      ).toBeGreaterThan(0);
      await expect(idle).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await link.click();
      await expect(idle).toHaveClass(/selected/u);
      await expect(idle).toHaveCSS('background-color', selectionColor);
      await expect(sessions.locator('.mar-session-activity')).toHaveCount(1);
    });
  }
  for (const width of [768, 1280, 1440, 390]) {
    test(`Workbench controls preserve selection, spacing and scrolling in ${theme} at ${width}px`, async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      let terminalCount = 0;
      await page.route('**/api/terminals**', (route) =>
        route.fulfill({
          json:
            route.request().method() === 'POST'
              ? {
                  terminal: {
                    id: `terminal-${++terminalCount}`,
                    nodeId: 'node',
                    workspaceId: 'workspace',
                    profileId: 'bash',
                    state: 'RUNNING',
                    latestSequence: 0
                  }
                }
              : { terminals: [] }
        })
      );
      await page.goto(
        `${fixture.url}workbench-style.html?theme=${theme}${width === 768 ? '&multipleProfiles=1' : ''}`
      );
      const offline = page.locator('.workspace-offline-placeholder');
      await expect(offline).toBeVisible();
      const message = page.locator('.workspace-offline-message');
      expect((await message.boundingBox())!.width).toBeLessThanOrEqual(380);
      const outer = (await offline.boundingBox())!;
      const inner = (await message.boundingBox())!;
      expect(Math.abs(inner.y + inner.height / 2 - outer.y - outer.height / 2)).toBeLessThan(2);
      const tabs = page.getByRole('region', { name: 'Workspace tab fixture' }).getByRole('tab');
      await tabs.nth(1).click();
      await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
      const activeTab = page
        .getByRole('region', { name: 'Workspace tab fixture' })
        .locator('.workspace-tab.active');
      await expect(activeTab).toHaveCSS('border-radius', '6px');
      await expect(activeTab).toHaveCSS('box-shadow', 'none');
      const selected = await activeTab.evaluate(
        (element) => getComputedStyle(element).backgroundColor
      );
      expect(selected).not.toBe('rgba(0, 0, 0, 0)');
      await page.locator('.workspace-group-toggle').click();
      const plain = page.getByRole('button', { name: 'plain', exact: true });
      const grouped = page.getByRole('button', { name: 'grouped', exact: true });
      for (const row of [
        page.locator('.tree-node-row').first(),
        plain.locator('..'),
        page.locator('.session-row').first()
      ]) {
        await row.hover();
        const rowBackground = await row.evaluate(
          (element) => getComputedStyle(element).backgroundColor
        );
        expect(rowBackground).not.toBe('rgba(0, 0, 0, 0)');
        const action = row.locator('.tree-more-button, .session-more-button');
        await action.hover();
        await expect(action).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await expect(row).toHaveCSS('background-color', rowBackground);
      }
      const indent = (await grouped.boundingBox())!.x - (await plain.boundingBox())!.x;
      expect(indent).toBeCloseTo(16, 0);
      const sessions = page.locator('.session-list');
      await expect(sessions.locator('.mar-session-activity')).toHaveCount(1);
      await expect(sessions.locator('.session-row.selected')).toHaveCSS('border-radius', '6px');
      await expect(sessions.locator('.session-row.selected')).toHaveCSS('box-shadow', 'none');
      const search = page.locator('.session-search-button');
      await search.click();
      await expect(page.getByLabel('Session action')).toHaveText('refresh');
      await page.getByLabel('Set fixture search').fill('review');
      await search.click();
      await expect(page.getByLabel('Session action')).toHaveText('search:review');
      await expect(search).toHaveAccessibleName(/search/iu);
      await page.getByRole('button', { name: 'Open directory picker' }).click();
      const picker = page.getByRole('dialog', { name: 'Register Workspace' });
      await expect(picker.locator('.workspace-picker-toolbar-actions button')).toHaveCount(3);
      for (const button of await picker.locator('.workspace-picker-toolbar-actions button').all()) {
        const bounds = (await button.boundingBox())!;
        expect(bounds.width).toBeGreaterThanOrEqual(28);
        expect(bounds.height).toBeCloseTo(26, 2);
        await expect(button.locator('svg')).toHaveCount(1);
      }
      const rowColors = await picker.evaluate((element) => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--mar-text-primary)';
        element.append(probe);
        const style = getComputedStyle(probe);
        probe.style.backgroundColor = 'var(--mar-fill-row-hover)';
        const hover = style.backgroundColor;
        probe.style.backgroundColor = 'var(--mar-fill-selection)';
        const colors = { hover, selected: style.backgroundColor, color: style.color };
        probe.remove();
        return colors;
      });
      const transparent = 'rgba(0, 0, 0, 0)';
      expect(rowColors.hover).not.toBe(transparent);
      expect(rowColors.selected).not.toBe(transparent);
      const rows = picker.locator('.workspace-directory-list > li');
      const pendingRow = rows.filter({ hasText: 'new-workspace' });
      const directoryRow = rows.filter({
        has: page.getByRole('button', { name: 'example', exact: true })
      });
      const selectDirectory = directoryRow.getByRole('button', { name: 'example', exact: true });
      await selectDirectory.hover();
      await expect(directoryRow).toHaveCSS('background-color', rowColors.hover);
      await expect(selectDirectory).toHaveCSS('background-color', transparent);
      await directoryRow.getByRole('button', { name: 'Open example' }).hover();
      await expect(directoryRow).toHaveCSS('background-color', rowColors.hover);
      for (const [row, name, select] of [
        [pendingRow, 'Cancel new directory', undefined],
        [directoryRow, 'Open example', selectDirectory]
      ] as const) {
        await select?.click();
        const button = row.getByRole('button', { name });
        await button.hover();
        await expect(row).toHaveCSS('background-color', rowColors.selected);
        await expect(button).toHaveCSS('background-color', transparent);
        await expect(button).toHaveCSS('color', rowColors.color);
        await page.mouse.move(0, 0);
        await page.keyboard.press('Tab');
        await button.focus();
        await expect(button).toHaveCSS('background-color', transparent);
        await expect(button).toHaveCSS('outline-width', '2px');
      }
      await expect(pendingRow).toHaveCount(0);
      await picker.getByRole('button', { name: 'Cancel', exact: true }).click();
      const strip = page.locator('.workbench-aside-tabs .mar-tab-strip');
      await expect(strip.getByRole('tab')).toHaveCount(4);
      expect(await strip.evaluate((element) => element.scrollWidth >= element.clientWidth)).toBe(
        true
      );
      expect((await strip.boundingBox())!.height).toBeGreaterThan(24);
      await expect(strip).toHaveCSS('overflow-x', 'auto');
      const terminal = page.getByRole('region', { name: 'Terminal fixture' });
      await expect(terminal.getByRole('heading', { name: 'Terminal', exact: true })).toBeVisible();
      await terminal.getByRole('button', { name: 'Expand terminal', exact: true }).click();
      await terminal.locator('.terminal-tab-add').click();
      await expect(terminal.getByRole('tab', { name: 'Terminal 1', exact: true })).toHaveAttribute(
        'aria-selected',
        'true'
      );
      await expect(terminal.locator('.terminal-tab.active')).toHaveCSS('border-radius', '6px');
      await expect(terminal.locator('.terminal-tab.active')).toHaveCSS('box-shadow', 'none');
      const terminalSelection = await terminal
        .locator('.terminal-tab.active')
        .evaluate((element) => getComputedStyle(element).backgroundColor);
      const terminalClose = terminal.locator('.terminal-tab.active .terminal-tab-close');
      await terminalClose.hover();
      await expect(terminalClose).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(terminal.locator('.terminal-tab.active')).toHaveCSS(
        'background-color',
        terminalSelection
      );
      const add = terminal.locator('.terminal-tab-add');
      await add.hover();
      const hoverBackground = await add.evaluate((element) => {
        const probe = document.createElement('span');
        probe.style.backgroundColor = 'var(--mar-action-hover-overlay)';
        element.append(probe);
        const color = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return color;
      });
      await expect(add).toHaveCSS('background-color', hoverBackground);
      await expect(add).toHaveCSS('border-radius', '6px');
      await expect(terminal.locator('.admin-terminal-body')).toBeVisible();
      if (width >= 768) {
        const chrome = await terminal.evaluate((element) => {
          const bounds = (selector: string) =>
            element.querySelector(selector)!.getBoundingClientRect();
          const header = bounds('.admin-terminal-header');
          const tab = bounds('.terminal-tab.active');
          const title = bounds('h2');
          const actions = bounds('.admin-terminal-actions');
          return {
            height: bounds('.admin-terminal-body').top - header.top,
            tabHeight: tab.height,
            titleCenter: title.y + title.height / 2,
            tabCenter: tab.y + tab.height / 2,
            actionsCenter: actions.y + actions.height / 2,
            titleGap: tab.left - title.right,
            actionsGap: actions.left - bounds('.terminal-tabs').right
          };
        });
        expect(chrome.height).toBeLessThanOrEqual(36);
        expect(chrome.tabHeight).toBeGreaterThanOrEqual(26);
        expect(chrome.tabHeight).toBeLessThanOrEqual(28);
        expect(Math.abs(chrome.titleCenter - chrome.tabCenter)).toBeLessThan(1);
        expect(Math.abs(chrome.actionsCenter - chrome.tabCenter)).toBeLessThan(1);
        expect(chrome.titleGap).toBeGreaterThanOrEqual(6);
        expect(chrome.actionsGap).toBeGreaterThanOrEqual(6);
      }
      const background = await page.evaluate(() => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--mar-terminal-background)';
        document.body.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      });
      await expect(terminal.locator('.admin-terminal-body')).toHaveCSS(
        'background-color',
        background
      );
      await expect(terminal.locator('.xterm-host')).toHaveCSS('background-color', background);
      await terminal.screenshot({ path: testInfo.outputPath('terminal.png') });
      await terminal.locator('.terminal-tab-add').click();
      await expect(terminal.getByRole('tab', { name: 'Terminal 2', exact: true })).toHaveAttribute(
        'aria-selected',
        'true'
      );
      const firstTerminal = terminal.getByRole('tab', { name: 'Terminal 1', exact: true });
      await firstTerminal.focus();
      await page.keyboard.press('Enter');
      await expect(firstTerminal).toHaveAttribute('aria-selected', 'true');
      await terminal.getByRole('button', { name: 'Close terminal 2', exact: true }).click();
      await expect(terminal.getByRole('tab')).toHaveCount(1);
      if (width === 768) {
        for (let index = 0; index < 8; index += 1) {
          await terminal.locator('.terminal-tab-add').click();
        }
        const terminalTabs = terminal.locator('.terminal-tabs');
        expect(
          await terminalTabs.evaluate((element) => element.scrollWidth > element.clientWidth)
        ).toBe(true);
        await terminal.getByRole('tab').last().scrollIntoViewIfNeeded();
        const bounds = (await terminalTabs.boundingBox())!;
        const actions = (await terminal.locator('.admin-terminal-actions').boundingBox())!;
        expect(bounds.x + bounds.width).toBeLessThan(actions.x);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true
        );
        await terminal.evaluate((element: HTMLElement) => {
          element.style.width = 'calc(100vw - var(--mar-workbench-sidebar-total-width))';
        });
        const narrowTabs = (await terminalTabs.boundingBox())!;
        expect(narrowTabs.width).toBeGreaterThanOrEqual(120);
        const narrowTerminal = (await terminal.boundingBox())!;
        const narrowActions = (await terminal.locator('.admin-terminal-actions').boundingBox())!;
        expect(narrowActions.x + narrowActions.width).toBeLessThanOrEqual(
          narrowTerminal.x + narrowTerminal.width
        );
        const title = (await terminal.locator('h2').boundingBox())!;
        expect(narrowTabs.y).toBeGreaterThanOrEqual(title.y + title.height);
        expect(
          (await terminal.locator('.admin-terminal-header').boundingBox())!.height
        ).toBeLessThanOrEqual(76);
        await terminal.getByRole('tab').last().scrollIntoViewIfNeeded();
        await terminal.getByRole('tab').last().click();
        await expect(terminal.getByRole('tab').last()).toHaveAttribute('aria-selected', 'true');
        await terminal.locator('.terminal-tab.active .terminal-tab-close').click();
        await expect(terminal.getByRole('tab')).toHaveCount(8);
        await terminal.locator('.terminal-tab-add').click();
        await expect(terminal.getByRole('tab')).toHaveCount(9);
        await terminal.screenshot({ path: testInfo.outputPath('terminal-narrow.png') });
      }
      await terminal.getByRole('button', { name: 'Collapse terminal', exact: true }).click();
      await expect(terminal.getByRole('tab').first()).toBeHidden();
    });
  }
}

for (const theme of ['daylight', 'vscode-dark-2026']) {
  test(`Files Watch and refresh share one visible loading feedback in ${theme}`, async ({
    page
  }, testInfo) => {
    let reads = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/workspaces/workspace/**', async (route) => {
      if (new URL(route.request().url()).pathname.endsWith('/files') && ++reads === 1) await gate;
      await route.fulfill({ json: { files: { entries: [], nextCursor: null } } });
    });
    await page.goto(`${fixture.url}workbench-style.html?theme=${theme}&overlapping-watch=1`);
    const inspector = page.getByRole('region', { name: 'Inspector fixture' });
    const watchStatus = inspector.locator('.watch-status [role="status"]');
    await expect(watchStatus).toContainText('Loading…');
    await expect(watchStatus).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(watchStatus).toHaveCSS('border-top-width', '0px');
    await expect(watchStatus).toHaveCSS('cursor', 'default');
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const [statusBox, inspectorBox] = await Promise.all([
        watchStatus.boundingBox(),
        inspector.locator('.workbench-aside').boundingBox()
      ]);
      expect(statusBox!.width).toBeLessThan(inspectorBox!.width / 2);
      await inspector
        .locator('.workbench-aside')
        .screenshot({ path: testInfo.outputPath(`files-initial-${width}.png`) });
    }
    await page.setViewportSize({ width: 1280, height: 844 });
    await inspector.getByRole('button', { name: 'Refresh files', exact: true }).click();
    await expect.poll(() => reads).toBe(1);
    await expect(inspector.locator('.watch-status')).toHaveCount(1);
    await expect(inspector.locator('.watch-status [data-mar-icon="loading-action"]')).toHaveCount(
      1
    );
    await expect(
      inspector
        .getByRole('button', { name: 'Refresh files', exact: true })
        .locator('[data-mar-icon="loading-action"]')
    ).toHaveCount(0);
    release?.();
    await expect(inspector.locator('.watch-status')).toHaveCount(1);
  });

  test(`Files retry uses a muted busy state and retains focus in ${theme}`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    let reads = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/workspaces/workspace/**', async (route) => {
      if (new URL(route.request().url()).pathname.endsWith('/files')) {
        if (++reads === 1)
          return route.fulfill({
            status: 503,
            json: { error: { code: 'NODE_OFFLINE', message: 'Offline' } }
          });
        await gate;
      }
      await route.fulfill({ json: { files: { entries: [], nextCursor: null } } });
    });
    await page.goto(`${fixture.url}workbench-style.html?theme=${theme}&file-root=1`);
    const inspector = page.getByRole('region', { name: 'Inspector fixture' });
    await inspector.getByRole('button', { name: 'Refresh files', exact: true }).click();
    const retry = inspector.locator('button.files-read-retry');
    await expect(retry).toHaveClass(/failed/);
    await expect(retry).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(retry).toHaveCSS('border-top-width', '0px');
    await expect(retry).toHaveCSS('cursor', 'pointer');
    await inspector
      .locator('.workbench-aside')
      .screenshot({ path: testInfo.outputPath('files-failed.png') });
    await retry.focus();
    await retry.press('Enter');
    await expect(retry).toBeFocused();
    await expect(retry).toHaveAttribute('aria-busy', 'true');
    await expect(retry).not.toHaveClass(/failed/);
    const filesLoadingIcon = retry.locator('[data-mar-icon="loading-action"]');
    const filesFeedbackFontSize = await retry.evaluate((el) => getComputedStyle(el).fontSize);
    await expect(filesLoadingIcon).toHaveCSS('width', filesFeedbackFontSize);
    await expect(filesLoadingIcon).toHaveCSS('height', filesFeedbackFontSize);
    await expect(retry.locator('.mar-inline-loading')).toHaveCSS('column-gap', '4px');
    const mutedColor = await page.locator('body').evaluate((body) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--mar-text-secondary)';
      probe.style.position = 'fixed';
      probe.style.visibility = 'hidden';
      body.append(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    });
    await expect(retry).toHaveCSS('color', mutedColor);
    await inspector
      .locator('.workbench-aside')
      .screenshot({ path: testInfo.outputPath('files-retrying.png') });
    release?.();
    await expect(retry).toHaveCount(0);
    await inspector.locator('.file-display-filter input').fill('unmatched-file');
    await expect(inspector.locator('.file-tree-empty')).toBeVisible();
    await inspector
      .locator('.workbench-aside')
      .screenshot({ path: testInfo.outputPath('files-empty.png') });
    await expect(retry).toHaveCount(0);
  });

  test(`Git History classifies branches and file changes in ${theme}`, async ({
    page
  }, testInfo) => {
    const parents = ['main', 'green', 'cyan', 'amber', 'neutral', 'red'];
    const commit = (hash: string, incoming: string[] = [], refs: string[] = []) => ({
      hash,
      parents: incoming,
      subject: hash === 'merge' ? 'Merge worktree branches' : `Update ${hash} worktree`,
      authorName: 'Author',
      authorEmail: 'a@example.test',
      committedAt: 1,
      refs
    });
    await page.route('**/api/workspaces/workspace/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/git/history')) {
        await route.fulfill({
          json: {
            commits: [
              commit('merge', parents, ['main']),
              ...parents.map((hash) => commit(hash, [], hash === 'green' ? ['origin/feature'] : []))
            ]
          }
        });
      } else if (path.includes('/git/commits/') && path.endsWith('/files')) {
        await route.fulfill({
          json: {
            files: [
              { path: 'src/added.ts', change: 'ADDED' },
              { path: 'src/modified.ts', change: 'MODIFIED' },
              { path: 'src/removed.ts', change: 'DELETED' }
            ]
          }
        });
      } else if (path.endsWith('/git/refs')) await route.fulfill({ json: { refs: [] } });
      else if (path.endsWith('/git/fetch')) await route.fulfill({ json: { fetchFailed: false } });
      else if (path.endsWith('/changes')) await route.fulfill({ json: { changes: [] } });
      else await route.fulfill({ json: { files: { entries: [], nextCursor: null } } });
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${fixture.url}workbench-style.html?theme=${theme}&git-previews=1`);
    const inspector = page.getByRole('region', { name: 'Inspector fixture' });
    await inspector.getByRole('tab', { name: 'Git History', exact: true }).click();
    const history = inspector.locator('.git-history');
    const merge = history
      .locator('.history-commit-row')
      .filter({ hasText: 'Merge worktree branches' });
    const green = merge.locator('path.history-graph-color-1');
    const greenStroke = theme === 'daylight' ? 'rgb(0, 107, 52)' : 'rgb(113, 228, 154)';
    await expect(green).toHaveCSS('stroke', greenStroke);
    const mainLane = merge.locator('path.history-graph-color-0');
    const branchRefs = history.locator('.history-ref');
    const blue = theme === 'daylight' ? 'rgb(39, 103, 173)' : 'rgb(82, 155, 238)';
    await expect(mainLane).toHaveCSS('stroke', blue);
    await expect(branchRefs).toHaveText(['main', 'origin/feature']);
    await expect(branchRefs.nth(0)).toHaveCSS('color', blue);
    await expect(branchRefs.nth(1)).toHaveCSS('color', blue);
    const lanes = await merge
      .locator('path.history-graph-edge')
      .evaluateAll((paths) => paths.map((path) => getComputedStyle(path).stroke));
    expect(new Set(lanes).size).toBe(6);
    await merge.click();
    await history.getByRole('button', { name: 'src', exact: true }).click();
    const modified = history.locator('.history-file-status[data-file-change="MODIFIED"]');
    const warning = theme === 'daylight' ? 'rgb(133, 74, 0)' : 'rgb(248, 203, 114)';
    await expect(modified).toHaveCSS('color', warning);
    await page.mouse.move(0, 0);
    await history.screenshot({ path: testInfo.outputPath('git-branches-and-files.png') });
    await page.locator('html').evaluate((root) => {
      root.style.setProperty('--mar-color-git-graph-main', '#9454c0');
      root.style.setProperty('--mar-color-success-text', '#aabbcc');
    });
    await expect(mainLane).toHaveCSS('stroke', 'rgb(148, 84, 192)');
    await expect(branchRefs.nth(0)).toHaveCSS('color', 'rgb(148, 84, 192)');
    await expect(branchRefs.nth(1)).toHaveCSS('color', 'rgb(148, 84, 192)');
    await expect(green).toHaveCSS('stroke', greenStroke);
    await expect(history.locator('.history-file-status[data-file-change="ADDED"]')).toHaveCSS(
      'color',
      'rgb(170, 187, 204)'
    );
  });

  test(`Git History auto-append and in-place failures in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    let historyReads = 0;
    let fileReads = 0;
    let releaseHistory: (() => void) | undefined;
    let releaseAppend!: () => void;
    let releaseFiles: (() => void) | undefined;
    const historyGate = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    const filesGate = new Promise<void>((resolve) => {
      releaseFiles = resolve;
    });
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const commit = (hash: string) => ({
      hash,
      parents: [],
      subject: `subject ${hash}`,
      authorName: 'Author',
      authorEmail: 'a@example.test',
      committedAt: 1,
      refs: []
    });
    await page.route('**/api/workspaces/workspace/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/git/history')) {
        historyReads += 1;
        if (historyReads === 3) await appendGate;
        if (historyReads === 1 || historyReads === 3)
          await route.fulfill({
            status: 503,
            json: { error: { code: 'NODE_OFFLINE', message: 'Offline' } }
          });
        else {
          if (historyReads === 2) await historyGate;
          await route.fulfill({
            json: {
              commits: [commit(historyReads === 2 ? 'first' : 'second')],
              nextCursor: historyReads === 2 ? 'cursor' : null
            }
          });
        }
      } else if (path.includes('/git/commits/') && path.endsWith('/files')) {
        if (++fileReads === 1)
          await route.fulfill({
            status: 503,
            json: { error: { code: 'NODE_OFFLINE', message: 'Offline' } }
          });
        else {
          await filesGate;
          await route.fulfill({ json: { files: [{ path: 'src/main.ts', change: 'MODIFIED' }] } });
        }
      } else if (path.endsWith('/git/refs')) await route.fulfill({ json: { refs: [] } });
      else if (path.endsWith('/git/fetch')) await route.fulfill({ json: { fetchFailed: false } });
      else if (path.endsWith('/changes')) await route.fulfill({ json: { changes: [] } });
      else await route.fulfill({ json: { files: { entries: [], nextCursor: null } } });
    });
    await page.goto(`${fixture.url}workbench-style.html?theme=${theme}&git-previews=1`);
    const inspector = page.getByRole('region', { name: 'Inspector fixture' });
    await inspector.evaluate((element) => {
      (element as HTMLElement).style.height = '360px';
    });
    await inspector.getByRole('tab', { name: 'Git History', exact: true }).click();
    let retry = inspector.locator('button.history-load-more');
    await expect(retry).toHaveAttribute('aria-description', /NODE_OFFLINE/);
    await retry.click();
    await expect(retry).toBeFocused();
    await expect(retry).toHaveAttribute('aria-busy', 'true');
    releaseHistory?.();
    await expect(inspector.locator('.history-list')).toContainText('subject first');
    await expect(inspector.locator(':scope .git-history > [role="status"]')).toHaveText('Loading…');
    await inspector
      .locator('.workbench-aside')
      .screenshot({ path: testInfo.outputPath('history-append-loading.png') });
    releaseAppend();
    await expect(retry).toBeVisible();
    await inspector
      .locator('.workbench-aside')
      .screenshot({ path: testInfo.outputPath('history-append-failed.png') });
    await page.waitForTimeout(150);
    expect(historyReads).toBe(3);
    await retry.click();
    await expect(inspector.locator('.history-list')).toContainText('subject second');
    expect(historyReads).toBe(4);
    await inspector.locator('.history-commit').filter({ hasText: 'subject first' }).click();
    retry = inspector.locator('.history-files button');
    await expect(retry).toHaveAttribute('aria-description', /NODE_OFFLINE/);
    await retry.click();
    await expect(retry).toBeFocused();
    await expect(retry).toHaveAttribute('aria-busy', 'true');
    await expect(retry.locator('[data-mar-icon="loading-action"]')).toHaveCSS(
      'width',
      await retry.evaluate((el) => getComputedStyle(el).fontSize)
    );
    await inspector
      .locator('.workbench-aside')
      .screenshot({ path: testInfo.outputPath('history-commit-retrying.png') });
    releaseFiles?.();
    await expect(inspector.locator('.history-files')).toContainText('src');
    await expect(inspector.getByLabel('File operation feedback')).toHaveText('');
    expect(fileReads).toBe(2);
    await inspector
      .locator('.workbench-aside-tabs button')
      .filter({ hasText: /^Search$/ })
      .click();
    await page.waitForTimeout(150);
    expect(historyReads).toBe(4);
    expect(fileReads).toBe(2);
  });

  for (const operation of ['refresh', 'branch'] as const) {
    test(`History ${operation} failure preserves pending commit files in ${theme}`, async ({
      page
    }, testInfo) => {
      let historyReads = 0;
      let filesStarted = false;
      let releaseHistory!: () => void;
      const historyGate = new Promise<void>((resolve) => {
        releaseHistory = resolve;
      });
      let releaseFiles: (() => void) | undefined;
      const filesGate = new Promise<void>((resolve) => {
        releaseFiles = resolve;
      });
      await page.route('**/api/workspaces/workspace/**', async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith('/git/history')) {
          if (++historyReads !== 2)
            await route.fulfill({
              json: {
                commits: [
                  {
                    hash: historyReads === 1 ? 'old' : 'new',
                    parents: [],
                    subject: historyReads === 1 ? 'old subject' : 'new subject',
                    authorName: 'Author',
                    authorEmail: 'a@example.test',
                    committedAt: 1,
                    refs: []
                  }
                ],
                nextCursor: null
              }
            });
          else {
            await historyGate;
            await route.fulfill({
              status: 503,
              json: { error: { code: 'NODE_OFFLINE', message: 'Offline' } }
            });
          }
        } else if (path.includes('/git/commits/') && path.endsWith('/files')) {
          filesStarted = true;
          await filesGate;
          await route.fulfill({
            json: { files: [{ path: 'still-readable.txt', change: 'MODIFIED' }] }
          });
        } else if (path.endsWith('/git/refs'))
          await route.fulfill({
            json: {
              refs: ['develop', 'feature/compact-workbench-controls', 'next'].map((name) => ({
                name: `refs/heads/${name}`,
                kind: 'LOCAL',
                displayName: name,
                hash: 'a'.repeat(40),
                current: false
              }))
            }
          });
        else if (path.endsWith('/git/fetch')) await route.fulfill({ json: { fetchFailed: false } });
        else if (path.endsWith('/changes')) await route.fulfill({ json: { changes: [] } });
        else await route.fulfill({ json: { files: { entries: [], nextCursor: null } } });
      });
      await page.goto(`${fixture.url}workbench-style.html?theme=${theme}&git-previews=1`);
      const inspector = page.getByRole('region', { name: 'Inspector fixture' });
      await inspector.getByRole('tab', { name: 'Git History', exact: true }).click();
      await inspector.locator('.history-commit-row').filter({ hasText: 'old subject' }).click();
      await expect.poll(() => filesStarted).toBe(true);
      const files = inspector.locator('.history-files');
      await expect(files.getByRole('status')).toContainText('Loading…');
      if (operation === 'refresh') {
        const refresh = inspector.getByRole('button', { name: 'Refresh Git history', exact: true });
        await refresh.click();
        await expect(refresh).toHaveAttribute('aria-busy', 'true');
      } else {
        const branch = inspector.getByRole('combobox', { name: 'Select Git branch' });
        await branch.click();
        const options = page.getByRole('listbox', { name: 'Select Git branch' });
        const next = options.getByRole('option', { name: 'next', exact: true });
        await options.screenshot({ path: testInfo.outputPath('git-branch-options.png') });
        await expect(branch).toHaveCSS('font-size', '12px');
        await expect(next).toHaveCSS('font-size', '12px');
        await next.click();
        await expect(inspector.locator('.git-history > .mar-region-status')).toHaveText('Loading…');
        await expect(inspector.locator('.git-history > .mar-region-status')).not.toHaveClass(
          /mar-region-status--center/
        );
      }
      await expect(files.getByRole('status')).toBeVisible();
      releaseHistory();
      await expect(inspector.locator('.history-load-more')).toContainText('Failed to load. Retry');
      await expect(files.getByRole('button', { name: 'Failed to load. Retry' })).toHaveCount(0);
      await expect(files.getByRole('status')).toContainText('Loading…');
      releaseFiles?.();
      await expect(files.getByRole('button', { name: 'still-readable.txt' })).toBeVisible();
      await expect(files.getByRole('button', { name: 'Failed to load. Retry' })).toHaveCount(0);
      await inspector.getByRole('button', { name: 'Failed to load. Retry', exact: true }).click();
      await expect(inspector.locator('.history-commit-row')).toContainText('new subject');
      await expect(files).toHaveCount(0);
      expect(historyReads).toBe(3);
    });
  }

  test(`Content search failures retry without duplicate notices in ${theme}`, async ({
    page
  }, testInfo) => {
    let searches = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let releaseInitial!: () => void;
    const initialGate = new Promise<void>((resolve) => {
      releaseInitial = resolve;
    });
    await page.route('**/api/workspaces/workspace/**', async (route) => {
      if (!route.request().url().includes('/content/search')) {
        await route.fulfill({ json: { files: { entries: [], nextCursor: null } } });
      } else if (++searches === 2) {
        await route.fulfill({
          status: 503,
          json: {
            error: { code: 'NODE_OFFLINE', message: 'Node unavailable', requestId: 'test-request' }
          }
        });
      } else {
        if (searches === 1) await initialGate;
        if (searches === 3) await gate;
        await route.fulfill({
          json: {
            search: {
              matches:
                searches === 4
                  ? []
                  : [{ path: 'src/main.ts', line: 2, column: 7, preview: 'const needle = true;' }],
              truncated: false
            }
          }
        });
      }
    });
    await page.goto(`${fixture.url}workbench-style.html?theme=${theme}&content-search=1`);
    const inspector = page.getByRole('region', { name: 'Inspector fixture' });
    async function captureSearchState(name: string): Promise<void> {
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await inspector
          .locator('.workbench-aside')
          .screenshot({ path: testInfo.outputPath(`search-${name}-${width}.png`) });
      }
      await page.setViewportSize({ width: 1280, height: 844 });
    }
    await inspector
      .locator('.workbench-aside-tabs button')
      .filter({ hasText: /^Search$/ })
      .click();
    const input = inspector.getByRole('textbox', { name: 'Search file contents', exact: true });
    await input.fill('needle');
    await input.press('Enter');
    const first = inspector.locator('.content-search-state.mar-region-status--center');
    await expect(first).toHaveText('Loading…');
    await expect(inspector.locator('[data-mar-icon="loading-action"]')).toHaveCount(1);
    await captureSearchState('initial');
    releaseInitial();
    await expect(inspector.locator('.content-search-results button')).toHaveCount(1);
    await input.press('Enter');
    const retry = inspector.locator('button.watch-status');
    await expect(retry).toBeVisible();
    await expect(retry).toHaveClass(/mar-ui-button--inline/);
    await expect(retry).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await retry.hover();
    await expect(retry).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(retry).toHaveAttribute('aria-description', /NODE_OFFLINE/);
    await expect(inspector.locator('.content-search-results button')).toHaveCount(1);
    await expect(inspector.getByLabel('File operation feedback')).toHaveText('');
    await expect(inspector.locator('.content-search-state')).toHaveCSS('padding-top', '8px');
    await captureSearchState('failed');
    await retry.click();
    await expect(retry).toBeFocused();
    await expect(retry).toHaveAttribute('aria-busy', 'true');
    await expect(retry).not.toHaveClass(/failed/);
    await expect(inspector.locator('[data-mar-icon="loading-action"]')).toHaveCount(1);
    await page.setViewportSize({ width: 390, height: 844 });
    const searchFeedbackFontSize = await retry.evaluate((el) => getComputedStyle(el).fontSize);
    await expect(retry.locator('[data-mar-icon="loading-action"]')).toHaveCSS(
      'width',
      searchFeedbackFontSize
    );
    await expect(inspector.locator('.content-search-state')).toHaveCSS('padding-top', '8px');
    await captureSearchState('retrying');
    release?.();
    await expect(retry).toHaveCount(0);
    await expect(inspector.locator('.content-search-results button')).toHaveCount(1);
    expect(searches).toBe(3);
    await input.fill('not-found');
    await input.press('Enter');
    await expect(inspector.locator('.file-search-empty')).toBeVisible();
    await captureSearchState('empty');
  });
}
