/** Only the authenticated Node-local credential broker is addressable by helpers. */
export async function gitCredentialRequest(
  path: '/credential' | '/ssh' | '/identity' | '/restore' | '/passphrase',
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const endpoint = new URL(process.env.MAR_GIT_ENDPOINT ?? '');
  if (
    endpoint.protocol !== 'http:' ||
    endpoint.hostname !== '127.0.0.1' ||
    !/^[a-f0-9]{64}$/u.test(process.env.MAR_GIT_TOKEN ?? '')
  )
    throw new Error('GIT_CREDENTIAL_CONTEXT_EXPIRED');
  const response = await fetch(new URL(path, endpoint), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.MAR_GIT_TOKEN}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(10_000),
    redirect: 'error'
  });
  if (!response.ok) throw new Error('GIT_CREDENTIAL_CONTEXT_EXPIRED');
  return (await response.json()) as Record<string, unknown>;
}

export async function originalGitEnvironment(): Promise<NodeJS.ProcessEnv> {
  const result = await gitCredentialRequest('/restore', {});
  const environment = { ...process.env };
  for (const [name, value] of Object.entries(result.restore as Record<string, string | null>)) {
    if (value === null) delete environment[name];
    else environment[name] = value;
  }
  return environment;
}
