import { browserProfileCommandSchema, browserResourceCommandSchema } from '@myagentroam/protocol';
import { z } from 'zod';
import type { BrowserRuntime } from './browser-runtime.js';

const resource = z.strictObject({
  workspaceId: z.string().min(1).max(512),
  __requestUserId: z.number().int().positive().safe(),
  command: z.unknown()
});

/** The authenticated Node request dispatcher supplies the relayed user ID.
 * Neither the browser resource command nor a data link chooses this identity. */
export function createBrowserResourceOperation(
  browser: Pick<BrowserRuntime, 'open' | 'lookup' | 'close'>,
  requireWorkspace: (workspaceId: string) => void
) {
  return async (data: unknown): Promise<{ browserId?: string }> => {
    const parsed = resource.safeParse(data);
    if (!parsed.success) throw new Error('BROWSER_RESOURCE_INVALID');
    const { workspaceId, __requestUserId: userId } = parsed.data;
    const request = browserResourceCommandSchema.safeParse(parsed.data.command);
    if (!request.success) throw new Error('BROWSER_RESOURCE_INVALID');
    const command = request.data;
    requireWorkspace(workspaceId);
    const scope = { workspaceId, userId };
    switch (command.action) {
      case 'open':
        return { browserId: await browser.open(scope, command.preserveLogin) };
      case 'lookup': {
        const browserId = browser.lookup(scope);
        return browserId ? { browserId } : {};
      }
      case 'close':
        await browser.close(scope, command.browserId);
        return {};
    }
  };
}

export function createBrowserProfileOperation(
  browser: Pick<BrowserRuntime, 'describeProfile' | 'useProfile'>,
  requireWorkspace: (workspaceId: string) => void
) {
  return async (data: unknown): Promise<unknown> => {
    const parsed = resource.safeParse(data);
    if (!parsed.success) throw new Error('BROWSER_RESOURCE_INVALID');
    const { workspaceId, __requestUserId: userId } = parsed.data;
    const { success, data: command } = browserProfileCommandSchema.safeParse(parsed.data.command);
    if (!success) throw new Error('BROWSER_RESOURCE_INVALID');
    requireWorkspace(workspaceId);
    const scope = { workspaceId, userId };
    switch (command.action) {
      case 'describe':
        return { profile: await browser.describeProfile(scope), historySuggestions: true };
      case 'history':
        return browser.useProfile(scope, command.target, (profile) =>
          profile.search(command.input)
        );
      case 'clear':
        await browser.useProfile(scope, command.target, (profile) => profile.clear(command.input));
        return {};
      case 'delete':
        await browser.useProfile(scope, command.target, (profile) =>
          profile.deleteUrls(command.input)
        );
        return {};
    }
  };
}
