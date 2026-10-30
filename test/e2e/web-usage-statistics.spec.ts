import { expect, test, type Locator } from '@playwright/test';
import { json, mockConsoleApi } from './support/web-console-api.js';

test.use({ timezoneId: 'Asia/Shanghai' });

// Mock APIs isolate browser behavior; the ledger integration has its own real database test.
for (const locale of ['en-US', 'zh-CN'] as const) {
  test(`Usage statistics filters, pagination and recovery remain accessible in ${locale}`, async ({
    page
  }, testInfo) => {
    await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start'], []);
    await page.route('**/api/auth/me', (route) =>
      json(route, {
        authenticated: true,
        mustChangePassword: false,
        username: 'member',
        isAdmin: false
      })
    );
    await page.addInitScript((value) => localStorage.setItem('mar.locale.v2', value), locale);
    await page.setViewportSize(
      locale === 'zh-CN' ? { width: 390, height: 844 } : { width: 1920, height: 1080 }
    );
    const labels =
      locale === 'en-US'
        ? {
            title: 'Usage statistics',
            refresh: 'Refresh',
            next: 'Go to next page',
            previous: 'Go to previous page',
            notes: 'About these statistics',
            custom: 'Custom range',
            update: 'Update records',
            chart: 'View chart data',
            trend: 'Usage over time',
            cache: 'Cache',
            input: 'Input',
            output: 'Output',
            inputTokens: 'Input tokens',
            outputTokens: 'Output tokens',
            totalTokens: 'Total tokens',
            cacheWrite: 'Cache write tokens',
            unknown: 'Unknown',
            range: 'Time range',
            day: 'Last 24 hours',
            week: 'Last 7 days'
          }
        : {
            title: '用量统计',
            refresh: '刷新',
            next: '下一页',
            previous: '上一页',
            notes: '统计说明',
            custom: '自定义范围',
            update: '更新明细',
            chart: '查看图表数据',
            trend: '用量趋势',
            cache: '缓存',
            input: '输入',
            output: '输出',
            inputTokens: '输入 Token',
            outputTokens: '输出 Token',
            totalTokens: '总 Token',
            cacheWrite: '缓存写入 Token',
            unknown: '未知',
            range: '时间范围',
            day: '最近 24 小时',
            week: '最近 7 天'
          };
    const now = Date.UTC(2026, 9, 14, 1, 44, 5);
    await page.clock.install({ time: new Date(now) });
    await page.clock.pauseAt(new Date(now + 1000));
    const numericHeaders = [
      labels.inputTokens,
      labels.cache,
      labels.outputTokens,
      labels.totalTokens
    ];
    const expectMetricOrder = async (target: Locator, expected: string[]) => {
      const text = await target.innerText();
      let previous = -1;
      for (const label of expected) {
        const position = text.indexOf(label);
        expect(position, `${label} follows the preceding metric`).toBeGreaterThan(previous);
        previous = position;
      }
    };
    const totals = {
      inputTokens: '12345678901234567890',
      outputTokens: '20',
      cacheReadTokens: '3086419725308641972',
      cacheWriteTokens: '1000',
      totalTokens: '12345678901234567910',
      requests: '2',
      completeRequests: '1',
      partialRequests: '1',
      unknownRequests: '0'
    };
    const record = (id: string) => ({
      schemaVersion: 1,
      recordId: id,
      ledgerId: id,
      requestId: id,
      revision: 2,
      scopeId: '00000000-0000-4000-8000-000000000001',
      sessionId: 'session',
      runId: 'run',
      runner: 'mar-agent',
      purpose: 'conversation',
      agentRole: 'root',
      state: 'succeeded',
      coverage: 'request',
      startedAt: now - 2000,
      endedAt: now - 1000,
      inputTokens: '1234567',
      cacheReadTokens: id.endsWith('-2') ? undefined : id.endsWith('-1') ? '0' : '617283',
      cacheWriteTokens: '0',
      reasoningTokens: '10000',
      mode: 'work',
      totalTokens: null
    });
    const requests: URL[] = [];
    let categoryTesting = false;
    let failure = false;
    let finishInitialRead!: () => void;
    const pendingInitialRead = new Promise<void>((resolve) => {
      finishInitialRead = resolve;
    });
    let finishPageRead!: () => void;
    const pendingPageRead = new Promise<void>((resolve) => {
      finishPageRead = resolve;
    });
    await page.route('**/api/me/usage/**', async (route) => {
      const url = new URL(route.request().url());
      requests.push(url);
      await pendingInitialRead;
      if (failure)
        return json(
          route,
          {
            error: { code: 'USAGE_TEST_UNAVAILABLE', message: 'Usage is temporarily unavailable.' }
          },
          503
        );
      if (url.pathname.endsWith('/records')) {
        const number = Number(url.searchParams.get('page') ?? 1);
        if (number === 4) await pendingPageRead;
        return json(route, {
          records: Array.from({ length: number === 4 ? 1 : 20 }, (_, index) =>
            record(`page-${number}-${index}`)
          ),
          total: '61',
          page: number,
          nextCursor: number === 4 ? null : 'next'
        });
      }
      const categoryTotals = categoryTesting
        ? { ...totals, totalTokens: url.searchParams.get('purpose') === 'compact' ? '700' : '900' }
        : totals;
      return json(route, {
        asOf: now,
        availableFrom: now - 90 * 86400000,
        firstRecordedAt: now - 2000,
        lastReceivedAt: now,
        last24Hours: categoryTotals,
        last7Days: categoryTotals,
        selected: categoryTotals,
        coverage: 'observed-only',
        buckets: [{ ...totals, from: now - 3600000, to: now }],
        runners: [{ ...totals, key: 'mar-agent', label: 'mar-agent' }],
        models: [{ ...totals, key: 'fixture-model', label: 'Fixture model' }]
      });
    });
    await page.goto('/console?view=settings&settings=usage');
    if (locale === 'zh-CN') await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: labels.title, exact: true }).click();
    const panel = page.getByTestId('usage-statistics');
    await expect(panel.getByRole('heading', { name: labels.title, exact: true })).toBeVisible();
    await expect(panel).toHaveAttribute('aria-busy', 'true');
    const loadingMask = panel.locator(':scope > .el-loading-mask');
    const expectLoadingInViewport = async () => {
      const area = await page.locator('.settings-content').boundingBox();
      const mask = await loadingMask.boundingBox();
      const spinner = await loadingMask.locator('.el-loading-spinner').boundingBox();
      expect(area).not.toBeNull();
      expect(mask).not.toBeNull();
      expect(spinner).not.toBeNull();
      for (const key of ['x', 'y', 'width', 'height'] as const)
        expect(Math.abs(mask![key] - area![key])).toBeLessThanOrEqual(1);
      expect(
        Math.abs(spinner!.y + spinner!.height / 2 - (area!.y + area!.height / 2))
      ).toBeLessThanOrEqual(2);
    };
    await expect(loadingMask).toBeVisible();
    await expect(loadingMask).toHaveText('');
    await expect(panel.locator('header').getByRole('status')).toBeEmpty();
    await expect(panel.getByText('Loading usage…', { exact: true })).toHaveCount(0);
    await page.clock.runFor(250);
    await expectLoadingInViewport();
    await page.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath('usage-initial-loading.png')
    });
    finishInitialRead();
    await expect(panel).toHaveAttribute('aria-busy', 'false');
    // The paused refresh clock also controls Element Plus loading transitions.
    await page.clock.runFor(500);
    await expect(loadingMask).toBeHidden();
    await expect(panel.getByRole('heading', { name: labels.title, exact: true })).toBeVisible();
    await expect(
      panel.getByText(
        locale === 'en-US' ? 'Agent usage for the current account' : '当前账号的 Agent 用量',
        { exact: true }
      )
    ).toBeVisible();
    const categories = panel.locator('.usage-purposes');
    const categoryFontSize = await categories.evaluate((element) =>
      getComputedStyle(element).getPropertyValue('--mar-font-size-meta').trim()
    );
    for (const button of await categories.getByRole('button').all()) {
      await expect(button).toHaveCSS('font-size', categoryFontSize);
      await expect(button).toHaveCSS('border-radius', '6px');
      await expect(button).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
    }
    const selectedCategory = categories.locator('[aria-pressed="true"]');
    for (const theme of ['vscode-light-2026', 'vscode-dark-2026']) {
      await page.evaluate(
        (value) => document.documentElement.setAttribute('data-theme', value),
        theme
      );
      const selection = await categories.evaluate((element) => {
        const reference = document.createElement('span');
        reference.style.backgroundColor = 'var(--mar-fill-selection)';
        reference.style.color = 'var(--mar-text-primary)';
        element.append(reference);
        const style = getComputedStyle(reference);
        const result = { background: style.backgroundColor, color: style.color };
        reference.remove();
        return result;
      });
      expect(selection.background).not.toBe('rgba(0, 0, 0, 0)');
      await expect(selectedCategory).toHaveCSS('background-color', selection.background);
      await expect(selectedCategory).toHaveCSS('color', selection.color);
      await selectedCategory.hover();
      await expect(selectedCategory).toHaveCSS('background-color', selection.background);
      await expect(selectedCategory).toHaveCSS('color', selection.color);
      await selectedCategory.focus();
      await page.keyboard.press('Tab');
      const nextCategory = categories.getByRole('button').nth(1);
      await expect(nextCategory).toBeFocused();
      await expect(nextCategory).toHaveCSS('outline-style', 'solid');
      await expect(nextCategory).toHaveCSS('outline-width', '2px');
      await expect(nextCategory).toHaveAttribute('aria-pressed', 'false');
      await categories.screenshot({
        path: testInfo.outputPath(`usage-category-labels-${theme}.png`)
      });
    }
    const panelLayout = await panel.evaluate((element) => {
      const parent = element.parentElement!;
      const style = getComputedStyle(parent);
      return {
        width: element.getBoundingClientRect().width,
        availableWidth:
          parent.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth
      };
    });
    expect(Math.abs(panelLayout.width - panelLayout.availableWidth)).toBeLessThanOrEqual(1);
    expect(panelLayout.documentWidth).toBeLessThanOrEqual(panelLayout.viewportWidth);
    await expect(panel.locator('.overview-cell')).toHaveCount(2);
    for (const card of await panel.locator('.overview-cell').all())
      await expectMetricOrder(card, [
        labels.input,
        labels.cache,
        labels.output,
        labels.totalTokens
      ]);
    await expectMetricOrder(panel.locator('.legend'), [labels.input, labels.cache, labels.output]);
    await expectMetricOrder(panel.locator('.section-heading .usage-count').first(), [
      labels.input,
      labels.cache,
      labels.output,
      labels.totalTokens
    ]);
    await expectMetricOrder(panel.locator('.distribution-cache').first(), [
      labels.cache,
      labels.totalTokens
    ]);
    expect(
      (await panel.locator('.records').getByRole('columnheader').allTextContents())
        .map((text) => text.trim())
        .filter((text) => numericHeaders.includes(text))
    ).toEqual(numericHeaders);
    await expect(panel.locator('.overview')).not.toContainText(
      locale === 'en-US' ? 'Partial usage' : '部分用量'
    );
    await expect(panel.getByRole('img', { name: labels.trend })).toBeVisible();
    await expect(panel.locator('.axis-labels')).toHaveText(
      '2026-10-14 08:44:052026-10-14 09:44:05'
    );
    await panel
      .locator('.trend')
      .screenshot({ path: testInfo.outputPath('usage-cache-trend.png') });
    const compact = (value: string) =>
      new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(
        BigInt(value)
      );
    const exact = (value: string) => new Intl.NumberFormat(locale).format(BigInt(value));
    const total = panel.locator('.overview-cell strong').first();
    await expect(total).toHaveText(compact(totals.totalTokens));
    const cacheSummary = `${compact(totals.cacheReadTokens)} (25%)`;
    await expect(panel.locator('.overview-cell').first()).toContainText(
      `${labels.cache} ${cacheSummary}`
    );
    await expect(panel.locator('.legend')).toContainText(labels.cache);
    await expect(panel.locator('.legend')).not.toContainText(/[\d%]/u);
    await expect(panel.locator('.distribution-cache')).toHaveCount(2);
    await expect(panel.locator('.distribution-cache').first()).toContainText(cacheSummary);
    const cacheHeight = await panel
      .locator('.trend-bucket')
      .first()
      .evaluate(
        (element) =>
          Number(element.querySelector('.cache-bar')?.getAttribute('height')) /
          Number(element.querySelector('.input-bar')?.getAttribute('height'))
      );
    expect(cacheHeight).toBeCloseTo(0.25, 3);
    await expect(total).toHaveCSS('cursor', 'pointer');
    await expect(total).not.toHaveAttribute('title');
    await total.hover();
    await page.clock.runFor(200);
    const tooltip = page.getByRole('tooltip').filter({ visible: true });
    await expect(tooltip).toHaveText(exact(totals.totalTokens));
    await panel.getByRole('heading', { name: labels.title, exact: true }).hover();
    await page.clock.runFor(300);
    const bucket = panel.locator('.trend-bucket').first();
    await expect(bucket).toHaveCSS('cursor', 'pointer');
    await expect(bucket).toHaveAccessibleName(
      new RegExp(`2026-10-14 08:44:05.*${locale === 'en-US' ? 'Input tokens' : '输入 Token'}`)
    );
    await bucket.hover();
    await page.clock.runFor(200);
    await expect(tooltip).toContainText('2026-10-14 08:44:05 – 2026-10-14 09:44:05');
    await expect(tooltip).toContainText(
      `${compact(totals.inputTokens)} (${exact(totals.inputTokens)})`
    );
    await expect(tooltip).toContainText(cacheSummary);
    await expect(tooltip).toContainText(`${exact(totals.cacheReadTokens)} (25%)`);
    await expectMetricOrder(tooltip, numericHeaders);
    await bucket.click();
    await expect(bucket).not.toBeFocused();
    await expect(bucket).toHaveCSS('outline-style', 'none');
    await expect(tooltip).toContainText(exact(totals.inputTokens));
    await expect(bucket).toHaveAccessibleName(
      new RegExp(
        `${labels.inputTokens}.*${labels.cache}.*${labels.outputTokens}.*${labels.totalTokens}`
      )
    );
    await panel.getByRole('heading', { name: labels.title, exact: true }).hover();
    await page.clock.runFor(300);
    await expect(tooltip).toHaveCount(0);
    await panel.getByText(labels.chart, { exact: true }).click();
    await expect(panel.locator('.trend details')).toHaveAttribute('open', '');
    expect(
      (await panel.locator('.trend details .el-table').getByRole('columnheader').allTextContents())
        .map((text) => text.trim())
        .filter((text) => numericHeaders.includes(text))
    ).toEqual(numericHeaders);
    await expect(panel.getByText(labels.notes, { exact: true })).toHaveCount(0);
    await expect(panel.locator('.el-table__body-wrapper').last()).toContainText(labels.unknown);
    const rows = panel.locator('.records .el-table__body-wrapper tr.el-table__row');
    await expect(rows).toHaveCount(20);
    await expect(rows.first()).toContainText('2026-10-14 09:44:04');
    await expect(rows.first()).toContainText(`${compact('617283')} (50%)`);
    await expect(rows.nth(1)).toContainText('0 (0%)');
    await expect(rows.nth(2)).toContainText('0 (0%)');
    await expect(rows.first().getByText('0', { exact: true }).first()).not.toHaveCSS(
      'cursor',
      'pointer'
    );
    const inputCount = rows.first().getByText(compact('1234567'), { exact: true });
    await expect(inputCount).toHaveCSS('cursor', 'pointer');
    await inputCount.hover();
    await page.clock.runFor(200);
    await expect(tooltip).toHaveText(exact('1234567'));
    await panel.getByRole('heading', { name: labels.title, exact: true }).hover();
    await page.clock.runFor(300);
    const mobile = locale === 'zh-CN';
    const cacheWithoutRead = rows.nth(2).getByText('0 (0%)', { exact: true });
    await expect(cacheWithoutRead).toHaveCSS('cursor', 'pointer');
    await cacheWithoutRead.hover();
    await page.clock.runFor(300);
    await expect(tooltip).toContainText(`${labels.cacheWrite}: 0`);
    await panel.getByRole('heading', { name: labels.title, exact: true }).hover();
    await page.clock.runFor(300);
    const pager = panel.locator('.management-pagination');
    await panel.locator('.records .el-table__expand-icon').first().click();
    const detail = panel.locator('.record-detail');
    await expect(detail.getByText('0', { exact: true }).first()).toBeVisible();
    await expect(detail).toContainText(`${compact('617283')} (50%)`);
    await expect(detail.getByText(compact('10000'), { exact: true })).toBeVisible();
    await expect(detail).toContainText(labels.unknown);
    if (mobile) {
      await expect(pager.locator('.el-pagination')).toHaveCount(0);
      for (const expected of [40, 60]) {
        await pager.scrollIntoViewIfNeeded();
        await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(expected);
        await page.clock.runFor(500);
      }
      await pager.scrollIntoViewIfNeeded();
      await expect(panel).toHaveAttribute('aria-busy', 'false');
      await expect(loadingMask).toBeHidden();
      await expect(pager.getByRole('status', { name: '正在加载', exact: true })).toBeVisible();
      await expect(pager.getByRole('button')).toHaveCount(0);
      await expect(rows).toHaveCount(60);
      finishPageRead();
      await page.clock.runFor(500);
      await expect(rows).toHaveCount(61);
      await expect(panel.locator('.record-detail')).toHaveCount(1);
      expect(
        requests
          .filter((url) => url.pathname.endsWith('/records'))
          .map((url) => url.searchParams.get('page'))
      ).toEqual(['1', '2', '3', '4']);
      await expect(pager.getByRole('status')).toHaveCount(0);
      await expect(pager.getByRole('button')).toHaveCount(0);
    } else {
      await expect(
        panel.getByRole('button', { name: labels.previous, exact: true })
      ).toBeDisabled();
      await expect(pager.locator('.el-pagination__total')).toContainText('61');
      await expect(pager.locator('.el-pager li.number')).toHaveCount(4);
      const refreshedStatus = await panel.locator('header').getByRole('status').innerText();
      await pager.locator('.el-pager li.number').filter({ hasText: /^4$/u }).click();
      await expect(panel).toHaveAttribute('aria-busy', 'false');
      await expect(loadingMask).toBeHidden();
      await expect(panel.locator('header').getByRole('status')).toHaveText(refreshedStatus);
      await expect(panel.getByRole('button', { name: labels.next, exact: true })).toBeDisabled();
      await expect(rows).toHaveCount(20);
      finishPageRead();
      await expect(rows).toHaveCount(1);
      await expect(panel).toHaveAttribute('aria-busy', 'false');
      await page.clock.runFor(500);
      await expect(loadingMask).toBeHidden();
      await expect(pager.locator('.el-pager .is-active')).toContainText('4');
      await expect(pager.locator('.el-pager li.number')).toHaveCount(4);
      await expect(panel.getByRole('button', { name: labels.next, exact: true })).toBeDisabled();
      await expect(pager.locator('.el-pagination')).toHaveClass(/is-background/u);
    }
    await pager.scrollIntoViewIfNeeded();
    await pager.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath(`usage-pager-${locale}.png`)
    });
    const recordReads = requests.filter((url) => url.pathname.endsWith('/records')).length;
    await page.clock.fastForward(60_000);
    await expect
      .poll(() => requests.filter((url) => url.pathname.endsWith('/overview')).length)
      .toBe(2);
    await expect(rows).toHaveCount(mobile ? 61 : 1);
    expect(requests.filter((url) => url.pathname.endsWith('/records')).length).toBe(recordReads);
    await expect(panel.getByRole('button', { name: labels.update, exact: true })).toBeVisible();
    await page.clock.resume();
    if (!mobile) {
      await pager.getByRole('listitem', { name: 'page 1', exact: true }).click();
      await expect(rows).toHaveCount(20);
      await panel.getByRole('button', { name: labels.next, exact: true }).click();
    }
    // Change the initial 24-hour filter before selecting it again.
    for (const [label, duration, overviewReads] of [
      [labels.week, 7 * 86400000, 3],
      [labels.day, 86400000, 4]
    ] as const) {
      await panel.getByRole('combobox', { name: labels.range, exact: true }).press('Enter');
      await page.getByRole('option', { name: label, exact: true }).click();
      await expect
        .poll(() => requests.filter((url) => url.pathname.endsWith('/overview')).length)
        .toBe(overviewReads);
      await expect(panel).toHaveAttribute('aria-busy', 'false');
      const query = requests.filter((url) => url.pathname.endsWith('/overview')).at(-1)!;
      expect(Number(query.searchParams.get('to')) - Number(query.searchParams.get('from'))).toBe(
        duration
      );
    }
    await expect(panel.locator('.overview-cell').first()).toContainText('20');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
    if (!mobile) await expect(pager.locator('.el-pager .is-active')).toContainText('1');
    else await expect(rows).toHaveCount(20);
    failure = true;
    await panel.getByRole('button', { name: labels.refresh, exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.el-message')).toContainText('Usage is temporarily unavailable.');
    await expect(rows).toHaveCount(20);
    failure = false;
    await panel.getByRole('button', { name: labels.refresh, exact: true }).click();
    await expect(panel.locator('.overview-cell')).toHaveCount(2);
    await expect(panel).toHaveAttribute('aria-busy', 'false');
    await panel.getByRole('combobox', { name: labels.range, exact: true }).press('Enter');
    await page.getByRole('option', { name: labels.custom, exact: true }).click();
    await expect(panel.locator('.custom-range')).toBeVisible();
    await expect(panel.locator('.el-form-item__error')).toHaveCount(0);
    const layout = await panel.locator('.filters').evaluate((element) => {
      const items = Array.from(element.querySelectorAll('.el-form-item'));
      const range = element.querySelector('.custom-range')!.getBoundingClientRect();
      const time = items[0]!.getBoundingClientRect();
      const runner = items[1]!.getBoundingClientRect();
      return {
        timeWidth: time.width,
        runnerWidth: runner.width,
        rangeTop: range.top,
        runnerBottom: runner.bottom,
        width: range.width,
        formWidth: element.getBoundingClientRect().width,
        maximumWidth: 38 * parseFloat(getComputedStyle(document.documentElement).fontSize)
      };
    });
    expect(Math.abs(layout.timeWidth - layout.runnerWidth)).toBeLessThan(2);
    expect(layout.rangeTop).toBeGreaterThan(layout.runnerBottom);
    expect(layout.width).toBeLessThanOrEqual(Math.min(layout.maximumWidth, layout.formWidth) + 1);
    await expect(page.locator('.el-message')).toHaveCount(0);
    await panel.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath(`usage-custom-${locale}.png`)
    });
    await panel.locator('.custom-range .el-range-input').first().click();
    const picker = page.locator('.el-date-range-picker:visible');
    await expect(picker).toBeVisible();
    await page.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath(`usage-picker-${locale}.png`)
    });
    const pickerBox = await picker.boundingBox();
    expect(pickerBox!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await panel.getByRole('heading', { name: labels.title, exact: true }).click();

    await panel.getByRole('button', { name: labels.refresh, exact: true }).click();
    await expect(panel.locator('.el-form-item__error')).toBeVisible();
    const range = await page.evaluate((now) => {
      const format = (value: number) => {
        const date = new Date(value);
        const pad = (n: number) => String(n).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:00`;
      };
      return { from: format(now - 2 * 86400000), to: format(now - 86400000) };
    }, now);
    const inputs = panel.locator('.custom-range .el-range-input');
    await inputs.first().fill(range.from);
    await inputs.last().fill(range.to);
    await inputs.last().press('Enter');
    await expect(panel.locator('.el-form-item__error')).toHaveCount(0);
    await expect
      .poll(() => {
        const selected = requests.filter((url) => url.pathname.endsWith('/overview')).at(-1)!;
        return Number(selected.searchParams.get('to')) < now;
      })
      .toBe(true);

    await expect(panel).toHaveAttribute('aria-busy', 'false');
    const customQuery = requests.filter((url) => url.pathname.endsWith('/overview')).at(-1)!;
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    const reads = (kind: string) =>
      requests.filter((url) => url.pathname.endsWith(`/${kind}`)).length;
    await panel.locator('.records .el-table__expand-icon').first().click();
    await expect(panel.locator('.record-detail')).toHaveCount(1);
    const beforeExpanded = { overview: reads('overview'), records: reads('records') };
    await page.clock.fastForward(60_000);
    await expect.poll(() => reads('overview')).toBe(beforeExpanded.overview + 1);
    await expect(panel.getByRole('button', { name: labels.update, exact: true })).toBeVisible();
    await expect(panel.locator('.record-detail')).toHaveCount(1);
    expect(reads('records')).toBe(beforeExpanded.records);
    expect(requests.filter((url) => url.pathname.endsWith('/overview')).at(-1)!.search).toBe(
      customQuery.search
    );

    await panel.getByRole('button', { name: labels.update, exact: true }).click();
    await expect(panel).toHaveAttribute('aria-busy', 'false');
    await page.clock.runFor(500);
    await expect(panel.locator('.record-detail')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: labels.update, exact: true })).toHaveCount(0);
    await panel.locator('.records th .caret-wrapper').first().press('Enter');
    await expect(panel.locator('.records th.ascending')).toHaveCount(1);
    const beforeSorted = { overview: reads('overview'), records: reads('records') };
    await page.clock.fastForward(60_000);
    await expect.poll(() => reads('overview')).toBe(beforeSorted.overview + 1);
    await expect(panel.getByRole('button', { name: labels.update, exact: true })).toBeVisible();
    await expect(panel.locator('.records th.ascending')).toHaveCount(1);
    expect(reads('records')).toBe(beforeSorted.records);
    await page.clock.resume();

    categoryTesting = true;
    for (const [purpose, label, tokens] of [
      ['compact', locale === 'en-US' ? 'Compact' : '上下文压缩', '700'],
      ['prompt_completion', locale === 'en-US' ? 'Composer Prediction' : '输入预测', '900']
    ] as const) {
      const category = panel
        .locator('.usage-purposes')
        .getByRole('button', { name: label, exact: true });
      const before = { overview: reads('overview'), records: reads('records') };
      await category.click();
      await expect(category).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(() => reads('overview')).toBe(before.overview + 1);
      await expect.poll(() => reads('records')).toBe(before.records + 1);
      for (const endpoint of ['overview', 'records'])
        expect(
          requests
            .filter((url) => url.pathname.endsWith('/' + endpoint))
            .at(-1)!
            .searchParams.get('purpose')
        ).toBe(purpose);
      await expect(panel.locator('.overview-cell').first()).toContainText(tokens);
      await expect(panel.locator('.overview-cell').last()).toContainText(tokens);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
  });
}
