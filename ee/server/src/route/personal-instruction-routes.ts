import { registerPersonalInstructionRoutes as registerCore } from '@myagentroam/server-core/personal-instruction-routes';
import { databaseError } from '../util/http-request.js';
export function registerPersonalInstructionRoutes(
  input: Omit<Parameters<typeof registerCore>[0], 'databaseError'>
): void {
  registerCore({ ...input, databaseError });
}
