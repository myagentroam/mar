import { expect, type Page, type TestInfo } from '@playwright/test';

async function themeColor(page: Page, token: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);
}

export async function verifyConversationThemes(
  page: Page,
  testInfo: TestInfo,
  prefix: string
): Promise<void> {
  const assistant = page.locator('.conversation-item.assistant_message').first();
  await expect(assistant).toBeVisible();
  const processHeading = page.locator('.conversation-process.is-group .process-heading').first();
  if ((await processHeading.getAttribute('aria-expanded')) === 'false') {
    await processHeading.focus();
    await page.keyboard.press('Enter');
  }
  await expect(processHeading).toHaveAttribute('aria-expanded', 'true');
  // Lazy content enters while the scroll container is following its changing height.
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => {}))
    );
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  for (const dark of [false, true]) {
    await page.evaluate((enabled) => {
      document.documentElement.classList.toggle('dark', enabled);
      if (enabled) document.documentElement.dataset.theme = 'vscode-dark-2026';
      else delete document.documentElement.dataset.theme;
    }, dark);
    const disclosureRows = page.locator('.process-heading, .conversation-item summary:visible');
    for (const row of await disclosureRows.all()) {
      await page.mouse.move(0, 0);
      const before = await row.boundingBox();
      const color = await row.evaluate((element) => getComputedStyle(element).color);
      await row.hover();
      const canHover = await page.evaluate(
        () => matchMedia('(hover: hover) and (pointer: fine)').matches
      );
      const hoverColor = await themeColor(page, '--mar-fill-row-hover');
      await expect(row).toHaveCSS('background-color', canHover ? hoverColor : 'rgba(0, 0, 0, 0)');
      await page.mouse.down();
      await expect(row).toHaveCSS('background-color', hoverColor);
      await page.mouse.move(0, 0);
      await page.mouse.up();
      await expect(row).toHaveCSS('color', color);
      const after = await row.boundingBox();
      expect(after!.width).toBeCloseTo(before!.width, 1);
      expect(after!.height).toBeCloseTo(before!.height, 1);
      await page.mouse.move(0, 0);
      await expect(row).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await row.focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      await expect(row).toHaveCSS('outline-style', 'solid');
    }
    await expect(assistant).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(assistant).toHaveCSS('border-top-width', '0px');
    await expect(page.locator('.conversation-scroll').first()).toHaveCSS(
      'background-color',
      await themeColor(page, '--mar-conversation-canvas')
    );
    const expectedBodyFontSize = page.viewportSize()!.width < 768 ? '13px' : '14px';
    await expect(assistant).toHaveCSS('font-size', expectedBodyFontSize);
    await expect(assistant.locator('.agent-markdown')).toHaveCSS('font-size', expectedBodyFontSize);
    const action = assistant.locator('.conversation-message-action').first();
    await page.keyboard.press('Tab');
    await action.focus();
    await expect(action).toHaveCSS('outline-style', 'solid');
    await expect(action).toHaveCSS('outline-width', '2px');
    const process = page.locator('.conversation-item.reasoning-group').first();
    await expect(process).toBeVisible();
    {
      const summary = process.locator(':scope > details > summary');
      await expect(process.locator(':scope > details')).not.toHaveAttribute('open', '');
      const bodyBox = await assistant.boundingBox();
      const processBox = await process.boundingBox();
      const groupBox = await processHeading.boundingBox();
      expect(Math.abs(bodyBox!.width - groupBox!.width)).toBeLessThan(1);
      expect(Math.abs(bodyBox!.x - groupBox!.x)).toBeLessThan(1);
      const naturalHeight = await summary.evaluate((element) => {
        const style = getComputedStyle(element);
        return (
          Math.max(
            Number.parseFloat(style.lineHeight),
            ...Array.from(element.children, (child) => child.getBoundingClientRect().height)
          ) +
          Number.parseFloat(style.paddingTop) +
          Number.parseFloat(style.paddingBottom)
        );
      });
      expect(Math.abs(processBox!.height - naturalHeight)).toBeLessThan(1);
      const headings = await page
        .locator(
          '.conversation-item:is(.reasoning-group, .command-group, .tool-group, .file-change-group) > details > summary'
        )
        .evaluateAll((elements) =>
          elements.map((element) => {
            const title = element.querySelector('strong')!;
            const marker = getComputedStyle(element, '::marker');
            return {
              titleOffset:
                title.getBoundingClientRect().left -
                element.closest('.conversation-item')!.getBoundingClientRect().left,
              display: getComputedStyle(element).display,
              open: element.parentElement!.hasAttribute('open'),
              markerFont: marker.font,
              markerColor: marker.color,
              markerType: getComputedStyle(element).listStyleType,
              customIcon: element.querySelector('svg') !== null
            };
          })
        );
      for (const heading of headings) {
        expect(heading.display).toBe(heading.open ? 'grid' : 'flex');
        expect(heading.markerType).toBe('none');
        expect(heading.markerFont).toBe(headings[0]!.markerFont);
        expect(heading.markerColor).toBe(headings[0]!.markerColor);
        expect(heading.customIcon).toBe(true);
        expect(Math.abs(heading.titleOffset - headings[0]!.titleOffset)).toBeLessThan(1);
      }
      await expect(process).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(process).toHaveCSS('border-top-width', '0px');
      if (!dark && page.viewportSize()!.width >= 768) {
        const details = process.locator(':scope > details');
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.evaluate(() =>
          document.documentElement.style.setProperty('--el-transition-duration-fast', '1s')
        );
        await summary.focus();
        await page.keyboard.press('Enter');
        await expect.poll(() => details.evaluate((el) => el.getAnimations().length)).toBe(1);
        const heights = await details.evaluate((el) => {
          const animation = el.getAnimations()[0]!;
          animation.currentTime = 500;
          const frames = (animation.effect as KeyframeEffect).getKeyframes();
          return {
            start: Number.parseFloat(String(frames[0]!.height)),
            end: Number.parseFloat(String(frames.at(-1)!.height)),
            current: el.getBoundingClientRect().height
          };
        });
        expect(heights.current).toBeGreaterThan(heights.start);
        expect(heights.current).toBeLessThan(heights.end);
        // Bypass actionability waits to exercise reversal during an active transition.
        await summary.evaluate((el: HTMLElement) => el.click());
        await expect(details).toHaveAttribute('data-disclosure-closing', '');
        const closing = await details.evaluate((el) => {
          const frames = (el.getAnimations()[0]!.effect as KeyframeEffect).getKeyframes();
          return [
            Number.parseFloat(String(frames[0]!.height)),
            Number.parseFloat(String(frames.at(-1)!.height))
          ];
        });
        expect(closing[1]).toBeLessThan(closing[0]!);
        await summary.evaluate((el: HTMLElement) => el.click());
        await expect(details).not.toHaveAttribute('data-disclosure-closing');
        await details.evaluate((el) =>
          el.getAnimations().forEach((animation) => animation.finish())
        );
        await expect.poll(() => details.evaluate((el) => el.getAnimations().length)).toBe(0);
        await expect(details).toHaveAttribute('open', '');
        await summary.evaluate((el: HTMLElement) => el.click());
        await details.evaluate((el) =>
          el.getAnimations().forEach((animation) => animation.finish())
        );
        await expect(details).not.toHaveAttribute('open', '');
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await summary.click();
        await expect(details).toHaveAttribute('open', '');
        expect(await details.evaluate((el) => el.getAnimations().length)).toBe(0);
        await summary.click();
        await expect(details).not.toHaveAttribute('open', '');
        await page.evaluate(() =>
          document.documentElement.style.removeProperty('--el-transition-duration-fast')
        );
        await page.emulateMedia({ reducedMotion: 'no-preference' });
      }
      await summary.click();
      await expect(process.locator(':scope > details')).toHaveAttribute('open', '');
      await expect(process.locator(':scope > details')).toHaveCSS(
        'background-color',
        'rgba(0, 0, 0, 0)'
      );
      await summary.click();
    }
    const code = assistant.locator('.agent-markdown p > code').first();
    await expect(code).toBeVisible();
    {
      await expect(code).toHaveCSS('color', await themeColor(page, '--mar-conversation-text'));
      await expect(code).toHaveCSS(
        'background-color',
        await themeColor(page, '--mar-conversation-code')
      );
    }
    const codeCopy = assistant.locator('[data-code-copy]').first();
    await page.keyboard.press('Tab');
    await codeCopy.focus();
    await expect(codeCopy).toHaveCSS('outline-style', 'solid');
    await expect(codeCopy).toHaveCSS('opacity', '1');
    if (page.viewportSize()!.width < 768) {
      for (const button of [action, codeCopy]) {
        const box = await button.boundingBox();
        expect(box!.width).toBeGreaterThanOrEqual(36);
        expect(box!.height).toBeGreaterThanOrEqual(36);
      }
    }
    expect(
      await page
        .locator('.conversation-scroll')
        .first()
        .evaluate((element) => element.scrollWidth <= element.clientWidth)
    ).toBe(true);
    const files = page.locator('.conversation-item.file-change-group').first();
    if (await files.count()) {
      const details = files.locator(':scope > details');
      await details.locator(':scope > summary').click();
      const list = details.locator('.conversation-file-change-list');
      await expect(list).toBeVisible();
      const bounds = await details.boundingBox();
      const listBounds = await list.boundingBox();
      const inset = page.viewportSize()!.width < 768 ? 8 : 12;
      expect(listBounds!.x - bounds!.x).toBeCloseTo(inset, 1);
      expect(bounds!.x + bounds!.width - listBounds!.x - listBounds!.width).toBeCloseTo(inset, 1);
      await expect
        .poll(async () => {
          const outer = await details.boundingBox();
          const inner = await list.boundingBox();
          return outer!.y + outer!.height - inner!.y - inner!.height;
        })
        .toBeCloseTo(8, 1);
      const row = list.locator('li').first();
      await expect(row.locator('.conversation-file-change-stats')).toContainText('+6');
      await expect(row.locator('.conversation-file-change-stats')).toContainText('-1');
      if (page.viewportSize()!.width < 768) {
        const rowBounds = await row.boundingBox();
        const pathBounds = await row.locator('button').boundingBox();
        expect(pathBounds!.width).toBeGreaterThanOrEqual(rowBounds!.width - 1);
        expect(pathBounds!.height).toBeLessThan(90);
      }
      await files.screenshot({
        path: testInfo.outputPath(`${prefix}-files-${dark ? 'dark' : 'light'}.png`)
      });
      await details.locator(':scope > summary').click();
    }
    await codeCopy.blur();
    await assistant.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath(`${prefix}-${dark ? 'dark' : 'light'}.png`)
    });
  }
  await page.evaluate(() => {
    document.documentElement.classList.remove('dark');
    delete document.documentElement.dataset.theme;
  });
}
