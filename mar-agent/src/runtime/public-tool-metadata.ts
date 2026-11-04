export type PublicToolMetadata = (
  | {
      query?: string;
      sourcesOnly?: true;
      sources?: { url: string; title?: string; snippet?: string }[];
      sourceCount?: number;
    }
  | {
      url?: string;
      title?: string;
      mode?: 'http' | 'browser';
      status?: number;
      contentType?: string;
    }
  | { name: string; description?: string; source?: string }
  | { tools: string[] }
  | { status: 'accepted' }
) & { hostedToolKind?: 'WEB_SEARCH' | 'WEB_FETCH' };

/** Public metadata only; page bodies and skill instructions stay in the bounded output. */
export function publicToolMetadata(
  toolName: string,
  value: Record<string, unknown>
): PublicToolMetadata | undefined {
  const text = (key: string, limit: number): string | undefined =>
    typeof value[key] === 'string' ? value[key].slice(0, limit) : undefined;
  if (
    toolName === 'tool_search' &&
    Array.isArray(value.tools) &&
    value.tools.every((name) => typeof name === 'string')
  )
    return { tools: value.tools.slice(0, 20).map((name: string) => name.slice(0, 512)) };
  if (toolName === 'smart_compact' && value.status === 'accepted') return { status: 'accepted' };
  if (toolName === 'web_search') {
    const entries = Array.isArray(value.results)
      ? value.results
      : Array.isArray(value.sources)
        ? value.sources
        : undefined;
    const sources = entries?.flatMap((entry: unknown) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const source = entry as Record<string, unknown>;
      if (typeof source.url !== 'string' || !source.url) return [];
      return [
        {
          url: source.url.slice(0, 8192),
          ...(typeof source.title === 'string' ? { title: source.title.slice(0, 1000) } : {}),
          ...(typeof source.snippet === 'string' ? { snippet: source.snippet.slice(0, 2000) } : {})
        }
      ];
    });
    const sourcesComplete =
      entries !== undefined &&
      sources !== undefined &&
      entries.length <= 20 &&
      entries.length === sources.length &&
      value.truncated !== true &&
      value.sourcesTruncated !== true &&
      entries.every((entry: unknown, index: number) => {
        const source = entry as Record<string, unknown>;
        const projected = sources[index]!;
        return (
          source.url === projected.url &&
          source.title === projected.title &&
          source.snippet === projected.snippet
        );
      });
    return {
      ...(value.sourcesOnly === true && sourcesComplete ? { sourcesOnly: true as const } : {}),
      ...(text('query', 500) === undefined ? {} : { query: text('query', 500)! }),
      ...(sources === undefined
        ? {}
        : {
            sources: sources.slice(0, 20),
            ...(value.sourcesTruncated === true ? {} : { sourceCount: sources.length })
          })
    };
  }
  if (toolName === 'web_fetch')
    return {
      ...(text('url', 8192) === undefined ? {} : { url: text('url', 8192)! }),
      ...(text('title', 1000) === undefined ? {} : { title: text('title', 1000)! }),
      ...(value.mode === 'http' || value.mode === 'browser' ? { mode: value.mode } : {}),
      ...(typeof value.status === 'number' &&
      Number.isInteger(value.status) &&
      value.status >= 100 &&
      value.status <= 599
        ? { status: value.status }
        : {}),
      ...(text('contentType', 256) === undefined ? {} : { contentType: text('contentType', 256)! })
    };
  if (toolName === 'skill' && typeof value.name === 'string')
    return {
      name: value.name.slice(0, 128),
      ...(text('description', 2000) === undefined
        ? {}
        : { description: text('description', 2000)! }),
      ...(text('source', 4096) === undefined ? {} : { source: text('source', 4096)! })
    };
  return undefined;
}
