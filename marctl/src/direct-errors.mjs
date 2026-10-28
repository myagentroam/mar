export class DirectFallbackError extends Error {
  constructor(code = 'DIRECT_UNAVAILABLE') {
    super(code);
    this.name = 'DirectFallbackError';
    this.code = code;
  }
}

export class DirectUnsafeError extends Error {
  constructor(code = 'DIRECT_CANCEL_UNCONFIRMED') {
    super(code);
    this.name = 'DirectUnsafeError';
    this.code = code;
  }
}

const directRejections = new Set([
  'DIRECT_TRANSFER_NOT_AUTHORIZED',
  'DIRECT_SESSION_LIMIT_REACHED',
  'DIRECT_NODE_GENERATION_MISMATCH',
  'DIRECT_TRANSFER_SESSION_CONFLICT',
  'TERMINAL_NOT_AUTHORIZED',
  'TERMINAL_DIRECT_LEASE_EXPIRED',
  'TERMINAL_NOT_FOUND',
  'TERMINAL_CLOSED',
  'TERMINAL_WORKSPACE_MISMATCH',
  'TERMINAL_GIT_OWNER_REQUIRED',
  'TERMINAL_ATTACH_CONFLICT',
  'TERMINAL_RELAY_LIMIT_REACHED'
]);

export class DirectRejectedError extends Error {
  constructor(code) {
    super(code);
    this.name = 'DirectRejectedError';
    this.code = code;
  }
}

export function directControlError(code) {
  const safeCode =
    typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/u.test(code)
      ? code
      : 'TERMINAL_DIRECT_UNAVAILABLE';
  return directRejections.has(safeCode)
    ? new DirectRejectedError(safeCode)
    : new DirectFallbackError(safeCode);
}
