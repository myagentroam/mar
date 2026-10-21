import { expect, type Page, type TestInfo } from '@playwright/test';

export async function verifyConversationThemes(
  page: Page,
  testInfo: TestInfo,
  prefix: string
): Promise<void> {
  const assistant = page.locator('.conversation-item.assistant_message').first();
  await expect(assistant).toBeVisible();
  for (const dark of [false, true]) {
    await page.evaluate((enabled) => {
      document.documentElement.classList.toggle('dark', enabled);
      if (enabled) document.documentElement.dataset.theme = 'vscode-dark-2026';
      else delete document.documentElement.dataset.theme;
    }, dark);
    await expect(assistant).toHaveCSS(
      'background-color',
      dark ? 'rgb(19, 25, 34)' : 'rgb(255, 255, 255)'
    );
    await expect(page.locator('.conversation-scroll').first()).toHaveCSS(
      'background-color',
      dark ? 'rgb(14, 17, 22)' : 'rgb(243, 246, 249)'
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
      expect(Math.abs(bodyBox!.width - processBox!.width)).toBeLessThan(1);
      expect(Math.abs(bodyBox!.x - processBox!.x)).toBeLessThan(1);
      const processHeight = Math.round(processBox!.height);
      expect(processHeight).toBeGreaterThanOrEqual(38);
      expect(processHeight).toBeLessThanOrEqual(40);
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
              markerFont: marker.font,
              markerColor: marker.color,
              markerType: getComputedStyle(element).listStyleType,
              customIcon: element.querySelector('svg') !== null
            };
          })
        );
      for (const heading of headings) {
        expect(heading.display).toBe('list-item');
        expect(heading.markerType).toBe('disclosure-closed');
        expect(heading.markerFont).toBe(headings[0]!.markerFont);
        expect(heading.markerColor).toBe(headings[0]!.markerColor);
        expect(heading.customIcon).toBe(false);
        expect(Math.abs(heading.titleOffset - headings[0]!.titleOffset)).toBeLessThan(1);
      }
      await expect(process).toHaveCSS(
        'background-color',
        dark ? 'rgb(17, 23, 32)' : 'rgb(246, 248, 250)'
      );
      await summary.click();
      await expect(process.locator(':scope > details')).toHaveAttribute('open', '');
      await summary.click();
    }
    const code = assistant.locator('.agent-markdown p > code').first();
    await expect(code).toBeVisible();
    {
      await expect(code).toHaveCSS('color', dark ? 'rgb(232, 238, 248)' : 'rgb(28, 39, 51)');
      await expect(code).toHaveCSS(
        'background-color',
        dark ? 'rgb(26, 34, 48)' : 'rgb(240, 243, 246)'
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
