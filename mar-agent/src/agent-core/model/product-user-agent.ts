import { readFileSync } from 'node:fs';

let cachedUserAgent: string | undefined;

/**
 * Product identity sent to upstream model endpoints. Runtime credential headers may
 * override this value per request.
 */
export function productUserAgent(): string {
  cachedUserAgent ??= resolveProductUserAgent();
  return cachedUserAgent;
}

function resolveProductUserAgent(): string {
  try {
    const raw = readFileSync(new URL('../../../package.json', import.meta.url), 'utf8');
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    if (typeof version === 'string' && version.length > 0 && version.length <= 64)
      return 'MyAgentRoam/' + version + ' (' + process.platform + '; ' + process.arch + ')';
  } catch {
    // Fall through to the identity-preserving fallback below.
  }
  return 'MyAgentRoam/unknown (' + process.platform + '; ' + process.arch + ')';
}
