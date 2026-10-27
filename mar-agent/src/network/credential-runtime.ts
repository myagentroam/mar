import { AgentError } from '../error.js';
import {
  SecretValue,
  type ModelCredentialProvider,
  type ModelCredential,
  type ModelCredentialAcquireReason
} from './credentials.js';

export async function acquireModelCredential(
  configuration: {
    readonly apiKey?: SecretValue;
    readonly credentialProvider?: ModelCredentialProvider;
  },
  reason: ModelCredentialAcquireReason,
  missingCredentialMessage: string,
  signal?: AbortSignal
): Promise<ModelCredential> {
  signal?.throwIfAborted();
  if (configuration.credentialProvider !== undefined) {
    if (configuration.apiKey !== undefined)
      throw new AgentError(
        'MAR_AGENT_MODEL_CONFIG_INVALID',
        'Model credential sources are ambiguous.'
      );
    const credential = await waitForModelCredential(
      configuration.credentialProvider,
      reason,
      signal
    );
    signal?.throwIfAborted();
    if (
      !Number.isSafeInteger(credential.revision) ||
      credential.revision < 0 ||
      !Number.isFinite(credential.expiresAt) ||
      !(credential.bearer instanceof SecretValue) ||
      credential.headers === null ||
      typeof credential.headers !== 'object' ||
      Array.isArray(credential.headers) ||
      (credential.socks5Url !== undefined && !(credential.socks5Url instanceof SecretValue))
    )
      throw new AgentError(
        'MAR_AGENT_MODEL_CONFIG_INVALID',
        'Dynamic model credential is invalid.'
      );
    return credential;
  }
  if (configuration.apiKey === undefined)
    throw new AgentError('MAR_AGENT_MODEL_CONFIG_INVALID', missingCredentialMessage);
  return {
    revision: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
    bearer: configuration.apiKey,
    headers: {}
  };
}

async function waitForModelCredential(
  provider: ModelCredentialProvider,
  reason: ModelCredentialAcquireReason,
  signal?: AbortSignal
): Promise<ModelCredential> {
  if (signal === undefined) return provider.acquire(reason);
  let abort = () => {};
  try {
    return await new Promise<ModelCredential>((resolve, reject) => {
      // Cancel only this request's wait; the shared provider remains caller-owned.
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      provider.acquire(reason).then(resolve, reject);
    });
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

export function appendModelCredentialHeaders(
  headers: Headers,
  credential: ModelCredential,
  reservedHeaders: ReadonlySet<string>
): Headers {
  for (const [name, value] of Object.entries(credential.headers)) {
    if (reservedHeaders.has(name.toLowerCase()))
      throw new AgentError(
        'MAR_AGENT_MODEL_CONFIG_INVALID',
        'Dynamic model credential contains a reserved header.'
      );
    headers.set(name, value instanceof SecretValue ? value.reveal() : value);
  }
  return headers;
}

/** Values known to be credentials, used only when producing public HTTP error diagnostics. */
export function modelCredentialSensitiveValues(credential: ModelCredential): readonly string[] {
  const values = [
    credential.bearer.reveal(),
    ...Object.values(credential.headers)
      .filter((value): value is SecretValue => value instanceof SecretValue)
      .map((value) => value.reveal())
  ];
  if (credential.socks5Url !== undefined) {
    const proxy = credential.socks5Url.reveal();
    const url = new URL(proxy);
    values.push(proxy, decodeURIComponent(url.username), decodeURIComponent(url.password));
  }
  return values;
}
