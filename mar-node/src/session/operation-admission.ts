/** Internal-only signal: caller cancellation is checked until the Session owner accepts work. */
export const SESSION_ADMISSION_SIGNAL = Symbol('session-admission-signal');

export function checkSessionAdmission(input: Record<string, unknown>): void {
  const signal = (input as Record<string | symbol, unknown>)[SESSION_ADMISSION_SIGNAL];
  if (signal instanceof AbortSignal) signal.throwIfAborted();
}
