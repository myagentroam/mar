import { AgentError } from '../../error.js';

export function unavailable(_cause?: unknown): AgentError {
  return new AgentError('SANDBOX_UNAVAILABLE', 'Bubblewrap sandbox is unavailable.');
}

export function policyInvalid(_cause?: unknown): AgentError {
  return new AgentError('SANDBOX_POLICY_INVALID', 'Sandbox policy is invalid.');
}

export function withCleanupDiagnostics(
  error: AgentError,
  failures: readonly ('close' | 'remove' | 'terminate' | 'exit_timeout')[]
): AgentError {
  if (failures.length === 0) return error;
  return new AgentError(error.code, error.publicMessage, {
    details: { cleanup: [...new Set(failures)] }
  });
}
