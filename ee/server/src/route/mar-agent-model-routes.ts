import { registerMarAgentModelRoutes as registerCore } from '@myagentroam/server-core/mar-agent-model-routes';
import { databaseError } from '../util/http-request.js';
export function registerMarAgentModelRoutes(
  input: Omit<Parameters<typeof registerCore>[0], 'databaseError'>
): void {
  registerCore({ ...input, databaseError });
}
