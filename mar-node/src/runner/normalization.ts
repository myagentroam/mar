export function compactRunnerText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
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
