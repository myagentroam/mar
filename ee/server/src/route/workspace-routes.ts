import { registerWorkspaceRoutes as registerCore } from '@myagentroam/server-core/workspace-routes';
import { databaseError } from '../util/http-request.js';
export function registerWorkspaceRoutes(
  input: Omit<Parameters<typeof registerCore>[0], 'databaseError'>
): void {
  registerCore({ ...input, databaseError });
}
