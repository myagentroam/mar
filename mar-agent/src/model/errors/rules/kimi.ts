import type { ModelErrorRule, UpstreamModelError } from '../chain.js';

export const kimiErrorRules: readonly ModelErrorRule<UpstreamModelError>[] = [
  {
    id: 'kimi-code.concurrent-request-limit',
    action: 'retry',
    // Kimi documents this as 429; Messages-compatible endpoints also emit it as SSE or 403.
    matches: ({ source, status, code, message }) =>
      (source === 'sse' || (source === 'http' && status === 403)) &&
      code === 'permission_error' &&
      message ===
        "You've reached your concurrent request limit. Please wait for your ongoing requests to finish and try again."
  }
];
