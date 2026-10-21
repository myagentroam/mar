import { registerSessionRunRoutes as registerCore } from '@myagentroam/server-core/session-run-routes';
import { databaseError } from '../util/http-request.js';

export function registerSessionRunRoutes(
  input: Omit<Parameters<typeof registerCore>[0], 'databaseError'>
): void {
  registerCore({ ...input, databaseError });
}
