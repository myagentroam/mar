export const MODEL_TOKEN_ESTIMATOR = 'UTF8_BYTES_V1' as const;
const BYTES_PER_TOKEN = 4;

/** Local budget estimate only; provider usage remains authoritative. */
export function countModelTokens(value: string): number {
  return Math.ceil(Buffer.byteLength(value, 'utf8') / BYTES_PER_TOKEN);
}

export function modelTokenBudgetBytes(maximumTokens: number): number {
  return Math.max(0, Math.floor(maximumTokens)) * BYTES_PER_TOKEN;
}

export function truncateModelText(
  value: string,
  maximumTokens: number,
  omittedLabel = 'tool output',
  reported?: {
    readonly originalTokenCount?: number;
    readonly totalLines?: number;
  }
): { content: string; truncated: boolean; omittedTokens: number } {
  const tokens = countModelTokens(value);
  if (tokens <= maximumTokens) return { content: value, truncated: false, omittedTokens: 0 };
  const maximumBytes = modelTokenBudgetBytes(maximumTokens);
  const bytes = Buffer.from(value, 'utf8');
  const warning = `Warning: truncated output (original token count: ${
    reported?.originalTokenCount ?? tokens
  })\nTotal output lines: ${reported?.totalLines ?? countTextLines(value)}\n\n`;
  let retainedBytes = Math.max(0, maximumBytes - 16 * BYTES_PER_TOKEN);
  for (let attempt = 0; attempt < 8; attempt++) {
    let head = Math.ceil(retainedBytes / 2);
    let tail = bytes.length - Math.floor(retainedBytes / 2);
    // Move cuts away from retained characters, never through a UTF-8 code point.
    while (head > 0 && isContinuationByte(bytes[head])) head--;
    while (tail < bytes.length && isContinuationByte(bytes[tail])) tail++;
    const omittedTokens = Math.ceil((tail - head) / BYTES_PER_TOKEN);
    const marker = `\n...[${omittedTokens} tokens of ${omittedLabel} omitted]...\n`;
    const candidateBytes =
      Buffer.byteLength(warning, 'utf8') +
      head +
      Buffer.byteLength(marker, 'utf8') +
      bytes.length -
      tail;
    if (candidateBytes <= maximumBytes)
      return {
        content: `${warning}${bytes.toString('utf8', 0, head)}${marker}${bytes.toString('utf8', tail)}`,
        truncated: true,
        omittedTokens
      };
    if (retainedBytes === 0) break;
    retainedBytes = Math.max(0, retainedBytes - (candidateBytes - maximumBytes));
  }
  const marker = `\n...[${tokens} tokens of ${omittedLabel} omitted]...\n`;
  const fallback = `${warning}${marker}`;
  return {
    content: countModelTokens(fallback) <= maximumTokens ? fallback : '',
    truncated: true,
    omittedTokens: tokens
  };
}

export function countTextLines(value: string): number {
  let lines = value.length === 0 ? 0 : 1;
  for (let index = 0; index < value.length; index++) if (value.charCodeAt(index) === 10) lines++;
  if (value.endsWith('\n')) lines--;
  return lines;
}

function isContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}
