export function secretEnvironment(
  values: Iterable<readonly [string, string]>
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = Object.fromEntries(values);
  const entries = Object.entries(environment);
  const bytes = entries.reduce(
    (total, [name, value]) => total + Buffer.byteLength(name) + Buffer.byteLength(value),
    0
  );
  if (entries.length > 128 || bytes > 64 * 1024)
    throw new Error('SECRET_ENVIRONMENT_LIMIT_EXCEEDED');
  return environment;
}

export function supportsSecretEnvironment(metadata: string | undefined): boolean {
  if (!metadata) return false;
  try {
    const version = (JSON.parse(metadata) as { nodeAppVersion?: unknown }).nodeAppVersion;
    const match = typeof version === 'string' ? /^(\d+)\.(\d+)\.(\d+)$/u.exec(version) : null;
    if (!match) return false;
    const [major, minor, patch] = match.slice(1).map(Number);
    return major! > 0 || minor! > 1 || (minor === 1 && patch! >= 4);
  } catch {
    return false;
  }
}
