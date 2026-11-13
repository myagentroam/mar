import type { Browser, BrowserContext } from '@playwright/test';

// Firefox uses its test-profile clipboard preference; these permission names are Chromium-only.
export function clipboardPermissions(browser: Browser | null): string[] {
  return browser?.browserType().name() === 'chromium' ? ['clipboard-read', 'clipboard-write'] : [];
}

export async function grantClipboardPermissions(
  context: BrowserContext,
  options?: { origin?: string }
): Promise<void> {
  const permissions = clipboardPermissions(context.browser());
  if (permissions.length > 0) await context.grantPermissions(permissions, options);
}
