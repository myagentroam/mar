const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_SECRET_COUNT = 128;
const MAX_SECRET_VALUE_BYTES = 16 * 1024;
const MAX_SECRET_TOTAL_BYTES = 64 * 1024;

export function parseSecretEnvironment(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('SECRET_ENVIRONMENT_INVALID');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_SECRET_COUNT) throw new Error('SECRET_ENVIRONMENT_LIMIT_EXCEEDED');
  const environment: Record<string, string> = {};
  let bytes = 0;
  for (const [name, secret] of entries) {
    if (!ENVIRONMENT_NAME.test(name) || typeof secret !== 'string' || secret.includes('\0'))
      throw new Error('SECRET_ENVIRONMENT_INVALID');
    const valueBytes = Buffer.byteLength(secret);
    bytes += Buffer.byteLength(name) + valueBytes;
    if (valueBytes > MAX_SECRET_VALUE_BYTES || bytes > MAX_SECRET_TOTAL_BYTES)
      throw new Error('SECRET_ENVIRONMENT_LIMIT_EXCEEDED');
    environment[name] = secret;
  }
  return environment;
}
