import { boundToolOutput, type ToolOutput } from '@myagentroam/protocol';

export function compactRunnerText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}

export function publicOutputSnapshot(
  value: unknown,
  truncated = false
): { text: string; truncated: boolean } {
  const text =
    typeof value === 'string' ? value : compactRunnerValue(value, Number.MAX_SAFE_INTEGER).text;
  let bounded = text.slice(-10_000);
  const first = bounded.charCodeAt(0);
  if (text.length > 10_000 && first >= 0xdc00 && first <= 0xdfff) bounded = bounded.slice(1);
  return { text: bounded, truncated: truncated || text.length > 10_000 };
}

export function publicToolOutput(
  value: unknown,
  truncation?: ToolOutput['truncation'],
  channel: ToolOutput['blocks'][number]['channel'] = 'TEXT'
): ToolOutput {
  const text =
    typeof value === 'string' ? value : compactRunnerValue(value, Number.MAX_SAFE_INTEGER).text;
  return boundToolOutput(text ? [{ channel, text }] : [], truncation);
}

export function compactRunnerValue(
  value: unknown,
  limit: number
): {
  readonly text: string;
  readonly truncated: boolean;
} {
  if (value === undefined || value === null) return { text: '', truncated: false };
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      return { text: '(Unable to display)', truncated: false };
    }
  }
  return { text: compactRunnerText(text, limit), truncated: text.length > limit };
}

export function nativePageEnd(
  cursor: string | undefined,
  sessionId: string,
  fallback: number
): number {
  if (cursor === undefined) return fallback;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      sessionId?: unknown;
      end?: unknown;
    };
    return value.sessionId === sessionId &&
      Number.isInteger(value.end) &&
      (value.end as number) >= 0
      ? Math.min(value.end as number, fallback)
      : fallback;
  } catch {
    return fallback;
  }
}

export function boundedConversationItemId(prefix: string, value: string): string {
  const candidate = `${prefix}:${value}`;
  if (candidate.length <= 88) return candidate;
  return `${prefix}:${Buffer.from(value)
    .toString('base64url')
    .slice(0, 88 - prefix.length - 1)}`;
}
