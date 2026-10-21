import type { ModelAttemptDiagnostic, ModelRequest } from './contracts.js';

/** One observer boundary for all adapters; telemetry cannot change request outcomes. */
export async function reportModelAttempt(
  request: ModelRequest,
  diagnostic: ModelAttemptDiagnostic
): Promise<void> {
  try {
    await request.onAttemptDiagnostic?.(diagnostic);
  } catch {
    // Diagnostics must never change the model request result.
  }
}
