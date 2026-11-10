/** Check the JSON search contract without treating an empty result as an error. */
export async function probeSearchEndpoint(
  endpoint: string,
  request: typeof fetch = fetch
): Promise<boolean> {
  try {
    const url = new URL('/search', endpoint);
    url.searchParams.set('q', 'MyAgentRoam');
    url.searchParams.set('format', 'json');
    const response = await request(url, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    return (
      typeof body === 'object' &&
      body !== null &&
      Array.isArray((body as { results?: unknown }).results)
    );
  } catch {
    return false;
  }
}
