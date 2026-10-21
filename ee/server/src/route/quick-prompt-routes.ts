import { registerQuickPromptRoutes as registerCore } from '@myagentroam/server-core/quick-prompt-routes';
import { databaseError } from '../util/http-request.js';
export function registerQuickPromptRoutes(
  input: Omit<Parameters<typeof registerCore>[0], 'databaseError'>
): void {
  registerCore({ ...input, databaseError });
}
