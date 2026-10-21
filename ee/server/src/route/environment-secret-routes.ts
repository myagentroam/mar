import { registerEnvironmentSecretRoutes as registerCore } from '@myagentroam/server-core/environment-secret-routes';
import { databaseError } from '../util/http-request.js';
export function registerEnvironmentSecretRoutes(
  input: Omit<Parameters<typeof registerCore>[0], 'databaseError'>
): void {
  registerCore({ ...input, databaseError });
}
