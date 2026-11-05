import { expect, test, type Page } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});

async function colors(page: Page) {
  return page.evaluate(() => {
    const probe = document.createElement('span');
    document.body.append(probe);
    const color = (name: string) => {
      probe.style.color = `var(${name})`;
      return getComputedStyle(probe).color;
    };
    const result = {
      primary: color('--mar-text-primary'),
      secondary: color('--mar-text-secondary'),
      tertiary: color('--mar-text-tertiary'),
      success: color('--mar-color-success-text'),
      link: color('--mar-control-link-text'),
      selected: color('--mar-fill-selection'),
      hover: color('--mar-fill-row-hover'),
      match: color('--mar-color-brand-text')
    };
    probe.remove();
    return result;
  });
}

for (const theme of ['daylight', 'vscode-dark-2026']) {
  test(`Notification titles match recent session typography in ${theme}`, async ({ page }) => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`${fixture.url}visual-alignment.html?list-hierarchy=recent&theme=${theme}`);
      const recent = page.locator('.recent-session-title').first();
      await expect(recent).toBeVisible();
      const typography = await recent.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          lineHeight: style.lineHeight
        };
      });
      await page.goto(
        `${fixture.url}visual-alignment.html?long-notification=1&theme=${theme}${width < 768 ? '&mobile=1' : ''}`
      );
      await page.locator('.activity-center-trigger').click();
      await page.getByRole('tab', { name: /^Notifications/ }).click();
      const title = page.locator('.workbench-notification-title strong').first();
      await expect(title).toBeVisible();
      await expect(title).toHaveCSS('font-size', typography.fontSize);
      await expect(title).toHaveCSS('font-weight', typography.fontWeight);
      await expect(title).toHaveCSS('line-height', typography.lineHeight);
    }
  });

  test(`Theme apply uses an ordinary link while Active stays green in ${theme}`, async ({
    page
  }) => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`${fixture.url}visual-alignment.html?menus&theme=${theme}`);
      await page.mouse.move(0, 0);
      const palette = await colors(page);
      const active = page.getByRole('button', { name: 'Active', exact: true });
      await expect(active).toBeDisabled();
      await expect(active).toHaveCSS('color', palette.success);
      const target = page.locator('.theme-option').nth(theme === 'daylight' ? 0 : 1);
      const apply = target.getByRole('button', { name: 'Apply theme', exact: true });
      await expect(apply).toHaveClass(/is-link/);
      await expect(apply).not.toHaveClass(/el-button--primary/);
      await expect(apply).toHaveCSS('color', palette.secondary);
      await expect(apply.locator('.el-icon')).toHaveCSS('color', palette.secondary);
      await apply.focus();
      await page.keyboard.press('Enter');
      await expect(target).toHaveClass(/active/);
      await expect(target.getByRole('button', { name: 'Active', exact: true })).toBeDisabled();
      await expect(target.getByRole('button', { name: 'Active', exact: true })).toHaveCSS(
        'color',
        (await colors(page)).success
      );
      await expect(page.locator('.theme-option.active')).toHaveCount(1);
    }
  });

  test(`Quick Open and recent sessions keep regular names and distinct semantics in ${theme}`, async ({
    page
  }) => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`${fixture.url}visual-alignment.html?list-hierarchy=quick&theme=${theme}`);
      const palette = await colors(page);
      const rows = page.locator('.quick-open-results li');
      await expect(rows).toHaveCount(2);
      await expect(rows.first().locator('.entry-name')).toHaveCSS('font-weight', '400');
      await expect(rows.first().locator('.entry-name')).toHaveCSS('color', palette.primary);
      await expect(rows.last().locator('.entry-name')).toHaveCSS('color', palette.secondary);
      const input = page.locator('.quick-open-input');
      await input.fill('Review');
      await expect(rows.first().locator('.quick-open-match').first()).toHaveCSS(
        'color',
        palette.match
      );
      await input.press('ArrowDown');
      await expect(rows.last()).toHaveAttribute('aria-selected', 'true');
      await expect(rows.last().locator('.entry-name')).toHaveCSS('font-weight', '400');
      await expect(rows.last().locator('.entry-name')).toHaveCSS('color', palette.primary);
      await expect(rows.first().locator('.entry-name')).toHaveCSS('color', palette.secondary);
      await input.press('Enter');
      await expect(page.getByTestId('opened')).toHaveText('Review second');

      await page.goto(`${fixture.url}visual-alignment.html?list-hierarchy=recent&theme=${theme}`);
      for (const title of await page.locator('.recent-session-title').all()) {
        await expect(title).toHaveCSS('font-weight', '400');
        await expect(title).toHaveCSS('color', (await colors(page)).primary);
      }
      await expect(page.locator('.recent-sessions-list .el-tag--success')).toHaveCount(1);
      await expect(page.locator('.recent-sessions-list .el-tag--info')).toHaveCount(1);
      const statuses = page.locator('.recent-sessions-list .el-tag');
      const recentPalette = await colors(page);
      await expect(statuses.first()).toHaveClass(/el-tag--success/);
      await expect(statuses.first()).toHaveCSS('color', recentPalette.success);
      await expect(statuses.last()).toHaveClass(/el-tag--info/);
      await page.locator('.recent-sessions-list button').last().click();
      await expect(page.getByTestId('opened')).toHaveText('Review second');
    }
  });

  test(`Skill and MCP categories select without bold text or brand fill in ${theme}`, async ({
    page
  }) => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      for (const view of ['skills', 'mcp', 'sources']) {
        await page.goto(
          `${fixture.url}visual-alignment.html?list-hierarchy=${view}&theme=${theme}`
        );
        if (view === 'sources') await page.getByRole('tab').last().click();
        const strip = page.locator('.skill-category-strip, .mcp-category-strip');
        const engineering = strip.getByRole('button', { name: 'Engineering', exact: true });
        await expect(engineering).toBeVisible();
        const palette = await colors(page);
        const before = await engineering.boundingBox();
        await expect(engineering).toHaveCSS('font-weight', '400');
        await engineering.click();
        await expect(engineering).toHaveClass(/selected/);
        await expect(engineering).toHaveCSS('font-weight', '400');
        await expect(engineering).toHaveCSS('color', palette.primary);
        await expect(engineering).toHaveCSS('background-color', palette.selected);
        expect((await engineering.boundingBox())!.width).toBe(before!.width);
        await engineering.hover();
        await expect(engineering).toHaveCSS('background-color', palette.selected);
        const writing = strip.getByRole('button', { name: 'Writing', exact: true });
        await writing.hover();
        await expect(writing).toHaveCSS('background-color', palette.hover);
        await expect(writing).toHaveCSS('font-weight', '400');
        await writing.press('Enter');
        await expect(writing).toHaveClass(/selected/);
      }
    }
  });

  for (const width of [1280, 390]) {
    test(`Composer selectors separate neutral hover from brand focus in ${theme} at ${width}px`, async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(
        `${fixture.url}visual-alignment.html?select-states&model-options&theme=${theme}${width < 768 ? '&mobile' : ''}`
      );
      for (const custom of [false, true]) {
        if (custom)
          await page.locator('html').evaluate((element) => {
            for (const [token, value] of Object.entries({
              '--mar-color-brand': '#bf6ac9',
              '--mar-text-primary': '#dae5cf',
              '--mar-fill-row-hover': '#334455',
              '--mar-fill-selection': '#445566',
              '--mar-border-medium': '#718293'
            }))
              element.style.setProperty(token, value);
          });
        const palette = await colors(page);
        const borders = await page.locator('html').evaluate((element) => {
          const probe = document.createElement('span');
          element.append(probe);
          probe.style.color = 'var(--mar-color-brand)';
          const focus = getComputedStyle(probe).color;
          probe.style.color = 'var(--mar-border-medium)';
          const hover = getComputedStyle(probe).color;
          probe.remove();
          return { focus, hover };
        });
        for (const kind of ['runner', 'access', 'model-effort']) {
          const select = page.locator(`.composer-${kind}-select`);
          const input = select.getByRole('combobox');
          const wrapper = select.locator('.el-select__wrapper');
          await page.getByRole('button', { name: 'Open hint dialog', exact: true }).focus();
          await wrapper.hover();
          await expect(wrapper).toHaveCSS('box-shadow', `${borders.hover} 0px 0px 0px 1px inset`);
          await input.focus();
          await expect(wrapper).toHaveCSS('box-shadow', `${borders.focus} 0px 0px 0px 1px inset`);
          await input.press('ArrowDown');
          const dropdown = page.locator(`.el-select-dropdown.composer-${kind}-popper:visible`);
          const selected = dropdown.locator('.is-selected, .composer-model-effort-option-selected');
          await expect(selected).toHaveCount(kind === 'model-effort' ? 2 : 1);
          for (const option of await selected.all()) {
            await expect(option).toHaveCSS('color', palette.primary);
            await expect(option).toHaveCSS('font-weight', '400');
            await option.hover();
            await expect(option).toHaveCSS('background-color', palette.selected);
          }
          const other = dropdown.getByRole('option', {
            name: kind === 'runner' ? 'Codex' : kind === 'access' ? 'Ask' : 'Model Two',
            exact: true
          });
          await other.hover();
          await expect(other).toHaveCSS('background-color', palette.hover);
          if (!custom)
            await dropdown.screenshot({ path: testInfo.outputPath(`${kind}-${width}.png`) });
          await input.press('Escape');
          await expect(dropdown).toBeHidden();
        }
      }
    });
  }

  test(`Settings navigation and model choices keep regular selected text in ${theme}`, async ({
    page
  }) => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`${fixture.url}workbench-mobile-drawer.html?theme=${theme}`);
      for (const icon of ['settings', 'administration']) {
        await page.locator(`.nav-menu-button:has([data-mar-icon="${icon}"])`).click();
        await expect(page.locator('.settings-nav button.active')).toHaveCSS('font-weight', '400');
      }
      await page.goto(
        `${fixture.url}visual-alignment.html?model-options&theme=${theme}${width < 768 ? '&mobile' : ''}`
      );
      const select = page.locator('.composer-model-effort-select');
      await select.click();
      const dropdown = page.locator('.el-select-dropdown.composer-model-effort-popper:visible');
      const selected = dropdown.locator('.composer-model-effort-option-selected');
      await expect(selected).toHaveCount(2);
      for (const option of await selected.all()) {
        await expect(option).toHaveCSS('font-weight', '400');
        await expect(option).toHaveCSS('background-color', (await colors(page)).selected);
      }
      await dropdown.getByRole('option', { name: 'high', exact: true }).click();
      await select.click();
      await expect(selected.filter({ hasText: 'high' })).toHaveCount(1);
      await expect(selected.filter({ hasText: 'Model One' })).toHaveCount(1);
      await dropdown.getByRole('option', { name: 'Model Two', exact: true }).click();
      await select.click();
      await expect(selected.filter({ hasText: 'high' })).toHaveCount(1);
      await expect(selected.filter({ hasText: 'Model Two' })).toHaveCount(1);
      await expect(dropdown.locator('.is-selected')).toHaveCSS('font-weight', '400');
    }
  });

  test(`Mail and model catalogs use regular readable names in ${theme}`, async ({
    page
  }, testInfo) => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`${fixture.url}visual-alignment.html?theme=${theme}`);
      await page.getByRole('button', { name: 'View email templates', exact: true }).click();
      const choices = page.locator('.template-choice');
      const palette = await colors(page);
      for (const name of await choices.locator('.template-choice__name').all()) {
        await expect(name).toHaveCSS('font-weight', '400');
      }
      await expect(choices.first().locator('.template-choice__name')).toHaveCSS(
        'color',
        palette.primary
      );
      await expect(choices.last().locator('.template-choice__name')).toHaveCSS(
        'color',
        palette.secondary
      );
      await expect(choices.first().locator('.template-choice__meta')).toHaveCSS(
        'font-weight',
        '400'
      );
      await expect(choices.first().locator('.template-choice__meta')).toHaveCSS(
        'color',
        palette.tertiary
      );
      await choices.last().click();
      await expect(choices.last().locator('.template-choice__name')).toHaveCSS(
        'color',
        palette.primary
      );
      await expect(choices.first().locator('.template-choice__name')).toHaveCSS(
        'color',
        palette.secondary
      );

      await page.goto(`${fixture.url}visual-alignment.html?list-hierarchy=models&theme=${theme}`);
      await page.getByRole('tab', { name: 'OAuth credentials', exact: true }).click();
      await page.locator('.el-table__row').filter({ hasText: 'Catalog credential' }).click();
      await page.getByRole('button', { name: 'Load model catalog', exact: true }).click();
      const name = page.locator('.catalog-model-name');
      await expect(name).toHaveText('Catalog model');
      await expect(name).toHaveCSS('font-weight', '400');
      await expect(name).toHaveCSS('color', (await colors(page)).primary);
      await page.locator('.catalog-table-wrap .el-table__body .el-checkbox').click();
      await expect(name).toHaveCSS('font-weight', '400');
      await page.screenshot({
        path: testInfo.outputPath(`catalog-${width}.png`),
        animations: 'disabled'
      });
    }
  });
}
