import { randomUUID } from 'node:crypto';
import { AgentError, countModelTokens } from '@myagentroam/agent';

const DEFAULT_BUDGET = 2_000;
const SNAPSHOT_BUDGET = 32 * 1024 * 1024;

export interface WebDocument {
  content: string;
  url: string;
  status: number;
  contentType: string;
  title?: string;
  sourceTruncated: boolean;
}

interface Snapshot extends WebDocument {
  scope: string;
  size: number;
}

/** Process-local documents; callers supply the trusted storage/session scope. */
export class WebSnapshots {
  readonly #entries = new Map<string, Snapshot>();
  #bytes = 0;

  constructor(readonly maxBytes = SNAPSHOT_BUDGET) {}

  add(scope: string, document: WebDocument): string {
    const ref = randomUUID();
    const size = Buffer.byteLength(JSON.stringify({ ...document, scope, ref })) + 128;
    if (size > this.maxBytes) throw unavailable();
    while (this.#bytes + size > this.maxBytes) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#delete(oldest);
    }
    this.#entries.set(ref, { ...document, scope, size });
    this.#bytes += size;
    return ref;
  }

  clearScope(scope: string): void {
    for (const [ref, entry] of this.#entries) if (entry.scope === scope) this.#delete(ref);
  }

  clearHostedStorage(storage: string): void {
    for (const [ref, entry] of this.#entries) {
      try {
        const scope: unknown = JSON.parse(entry.scope);
        if (Array.isArray(scope) && scope[0] === 'hosted' && scope[1] === storage)
          this.#delete(ref);
      } catch {
        /* Ignore unrelated scopes. */
      }
    }
  }

  clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
  }

  open(
    scope: string,
    ref: string,
    options: { line?: number; cursor?: string; maxTokens?: number }
  ) {
    const entry = this.#get(scope, ref);
    const lines = entry.content.split('\n');
    const budget = options.maxTokens ?? DEFAULT_BUDGET;
    let line = options.line ?? 0;
    let column = 0;
    if (options.cursor !== undefined) {
      const match = /^(\d+):(\d+)$/u.exec(options.cursor);
      if (!match) throw invalidCursor();
      line = Number(match[1]);
      column = Number(match[2]);
    }
    if (
      !Number.isSafeInteger(line) ||
      !Number.isSafeInteger(column) ||
      line < 0 ||
      line >= lines.length ||
      column < 0 ||
      column > lines[line]!.length ||
      (column > 0 && column < lines[line]!.length && /[\uDC00-\uDFFF]/u.test(lines[line]![column]!))
    )
      throw invalidCursor();
    const startLine = line;
    const header = `Ref: ${ref}\nTitle: ${short(entry.title ?? '', 160)}\nURL: ${short(entry.url, 240)}\n`;
    let body = '';
    let lastLine = line;
    for (let seen = 0; line < lines.length && seen < 200; seen++) {
      const remaining = lines[line]!.slice(column);
      const points = Array.from(remaining);
      const prefix = `${line}: `;
      if (countModelTokens(header + body + prefix + '\n' + 'x'.repeat(180)) > budget) break;
      let low = 0;
      let high = points.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (
          countModelTokens(
            header + body + prefix + points.slice(0, mid).join('') + '\n' + 'x'.repeat(180)
          ) <= budget
        )
          low = mid;
        else high = mid - 1;
      }
      if (low === 0 && points.length > 0) break;
      const part = points.slice(0, low).join('');
      body += prefix + part + '\n';
      lastLine = line;
      column += part.length;
      if (column < lines[line]!.length) break;
      line++;
      column = 0;
    }
    const hasMore = line < lines.length;
    const nextCursor = hasMore ? `${line}:${column}` : undefined;
    const footer = `Lines: ${startLine}-${lastLine} / ${lines.length}\nsourceTruncated: ${entry.sourceTruncated}\nhasMore: ${hasMore}${nextCursor ? `\nnextCursor: ${nextCursor}` : ''}`;
    return {
      content: header + body + footer,
      data: {
        ref,
        url: entry.url,
        title: entry.title,
        status: entry.status,
        contentType: entry.contentType,
        format: /^text\/html\b/iu.test(entry.contentType) ? 'markdown' : 'text',
        totalLines: lines.length,
        startLine,
        endLine: lastLine,
        hasMore,
        ...(nextCursor ? { nextCursor } : {}),
        sourceTruncated: entry.sourceTruncated
      }
    };
  }

  find(scope: string, ref: string, pattern: string, maxTokens = DEFAULT_BUDGET) {
    const entry = this.#get(scope, ref);
    const needle = pattern.toLowerCase();
    if (!needle)
      throw new AgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Find pattern must not be empty.');
    const matchLines: number[] = [];
    const lines = entry.content.split('\n');
    for (let i = 0; i < lines.length; i++)
      if (lines[i]!.toLowerCase().includes(needle)) matchLines.push(i);
    if (!matchLines.length)
      return {
        content: `Ref: ${ref}\nNo matches in the retained snapshot.\nsourceTruncated: ${entry.sourceTruncated}`,
        data: { ref, matchLines: [], sourceTruncated: entry.sourceTruncated, partial: false }
      };
    const first = matchLines[0]!;
    const matchOffset = lines[first]!.toLowerCase().indexOf(needle);
    let originalOffset = 0;
    let foldedOffset = 0;
    for (const point of lines[first]!) {
      const next = foldedOffset + point.toLowerCase().length;
      if (next > matchOffset) break;
      foldedOffset = next;
      originalOffset += point.length;
    }
    let column = Math.max(0, originalOffset - 80);
    if (column > 0 && /[\uDC00-\uDFFF]/u.test(lines[first]![column]!)) column--;
    const shown = matchLines.slice(0, 40);
    const partial = shown.length < matchLines.length;
    const prefix = `Matches${partial ? ' (partial)' : ''}: ${shown.join(', ')}\n`;
    const window = this.open(scope, ref, {
      cursor: `${first}:${column}`,
      maxTokens: maxTokens - countModelTokens(prefix) - 1
    });
    return {
      content: prefix + window.content,
      data: { ...window.data, matchLines: shown, partial }
    };
  }

  #get(scope: string, ref: string): Snapshot {
    const entry = this.#entries.get(ref);
    if (!entry || entry.scope !== scope) throw unavailable();
    this.#entries.delete(ref);
    this.#entries.set(ref, entry);
    return entry;
  }

  #delete(ref: string): void {
    const entry = this.#entries.get(ref);
    if (entry) this.#bytes -= entry.size;
    this.#entries.delete(ref);
  }
}

function short(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  const bytes = Buffer.from(value);
  return `${new TextDecoder().decode(bytes.subarray(0, maxBytes - 3), { stream: true })}…`;
}

function unavailable(): AgentError {
  return new AgentError(
    'MAR_AGENT_WEB_SNAPSHOT_UNAVAILABLE',
    'Page reference is unavailable. Open the URL again.'
  );
}

function invalidCursor(): AgentError {
  return new AgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Page position is invalid.');
}
