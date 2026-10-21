import { registerRunControlRoutes as registerCore } from '@myagentroam/server-core/run-control-routes';
import { databaseError } from '../util/http-request.js';

export function registerRunControlRoutes(
  input: Omit<Parameters<typeof registerCore>[0], 'databaseError'>
): void {
  registerCore({ ...input, databaseError });
}
