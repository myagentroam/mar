import { browserUsePreferenceSchema } from '@myagentroam/protocol';
import type { WorkbenchHttpService } from './workbench-http-service.js';

const endpoint = '/api/auth/preferences/browser-use';

export async function readBrowserUsePreference(
  request: WorkbenchHttpService['request'],
  signal: AbortSignal
): Promise<boolean> {
  return browserUsePreferenceSchema.parse(await request<unknown>(endpoint, { signal })).enabled;
}

export async function writeBrowserUsePreference(
  request: WorkbenchHttpService['request'],
  enabled: boolean,
  signal: AbortSignal
): Promise<void> {
  await request<void>(endpoint, { method: 'PUT', body: JSON.stringify({ enabled }), signal });
}
