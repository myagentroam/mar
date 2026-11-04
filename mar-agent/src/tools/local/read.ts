import type { ClientToolDefinition } from '../contracts.js';
import { formatReadContextItem } from '../../prompts/read-context.js';
import { markupAttributes, markupText } from '../../prompts/markup.js';
import { AGENT_EXECUTION_POLICY } from '../../runtime/execution-policy.js';
import { modelTokenBudgetBytes } from '../../runtime/token-budget.js';
import { createReadStream } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import { AgentError } from '../../error.js';
import type { ReadEventData } from '../contracts.js';

import { TOOL_EXECUTION_LIMITS } from '../execution-limits.js';
import { WorkspacePathResolver } from '../shared/path-resolver.js';
export type { ReadEventData } from '../contracts.js';

export const readToolDefinition: ClientToolDefinition = {
  name: 'read',
  allowedCallers: ['direct', 'programmatic'],
  parallelSafety: 'safe',
  outputSchema: {
    type: 'object',
    required: ['content', 'data', 'truncated'],
    properties: {
      content: { type: 'string' },
      truncated: { type: 'boolean' },
      data: {
        type: 'object',
        required: ['mode', 'results', 'truncated'],
        properties: {
          mode: { enum: ['batch'] },
          truncated: { type: 'boolean' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              required: ['path'],
              properties: {
                path: { type: 'string' },
                content: { type: 'string' },
                text: { type: 'string' },
                startLine: { type: 'number' },
                endLine: { type: 'number' },
                nextOffset: { type: 'number' },
                eof: { type: 'boolean' },
                truncated: { type: 'boolean' },
                encoding: { enum: ['utf-8', 'utf-16le', 'utf-16be'] },
                newline: { enum: ['lf', 'crlf'] },
                error: {
                  type: 'object',
                  required: ['code', 'message'],
                  properties: { code: { type: 'string' }, message: { type: 'string' } }
                }
              }
            }
          }
        }
      }
    }
  },
  description: `Read one or more known text files/ranges. Strict UTF-8 with optional BOM is the default; BOM-declared UTF-16LE/UTF-16BE is supported. Invalid text returns an item error instead of replacement characters. Always pass reads; use one item for a single file and up to ${TOOL_EXECUTION_LIMITS.readMaxBatchItems} items for a batch. Batch only already-located, bounded ranges whose combined content is likely to fit the model-visible output budget; for exploration, locate relevant files, symbols, or headings first, then read the smallest useful ranges. Results retain input order and use <mar_read_result> or <mar_read_error>. Successful items use 1-based line numbers and include <metadata> with path, encoding, newline, exact visible range, eof, truncation, nextOffset, and whether previewComplete. Items fail independently and run with bounded concurrency. Each item returns at most ${TOOL_EXECUTION_LIMITS.readMaxLines} lines/${TOOL_EXECUTION_LIMITS.readMaxBytes} bytes; the structured call shares a ${TOOL_EXECUTION_LIMITS.readMaxBatchBytes}-byte budget, while ordinary model-visible content fairly shares the common tool-output budget across all items. Structured data.results items provide text as decoded source for the returned range, preserving line endings and excluding BOM; content is numbered display text. Large files support bounded range reads. If previewComplete is false and nextOffset is present, continue only the still-relevant item from nextOffset. An oversized single line instead returns a head/tail preview with no line continuation cursor; use exec to obtain exact source before editing omitted content. Relative paths use the workspace; absolute paths are allowed. Prefer exec with rg for search and read for known files.`,
  inputSchema: {
    type: 'object',
    properties: {
      reads: {
        type: 'array',
        minItems: 1,
        maxItems: TOOL_EXECUTION_LIMITS.readMaxBatchItems,
        description: 'Known files or ranges to read in one ordered batch.',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative workspace path or absolute file path.' },
            offset: {
              type: 'integer',
              minimum: 1,
              description: 'First 1-based line; defaults to 1.'
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: TOOL_EXECUTION_LIMITS.readMaxLines,
              description: `Maximum lines; defaults to ${TOOL_EXECUTION_LIMITS.readDefaultLines}.`
            }
          },
          required: ['path'],
          additionalProperties: false
        }
      }
    },
    required: ['reads'],
    additionalProperties: false
  }
};

export interface ReadRequest {
  path: string;
  offset?: number;
  limit?: number;
}

export interface ReadResult {
  path: string;
  content: string;
  text: string;
  encoding: 'utf-8' | 'utf-16le' | 'utf-16be';
  newline: 'crlf' | 'lf';
  startLine: number;
  endLine?: number;
  eof: boolean;
  truncated: boolean;
  nextOffset?: number;
}

export interface ReadErrorResult {
  path: string;
  error: { code: string; message: string };
}

export interface BatchReadResult {
  mode: 'batch';
  results: Array<ReadResult | ReadErrorResult>;
  truncated: boolean;
}

/** Produce public text and offsets together, independently of model-visible markup. */
export function formatReadEventOutput(results: BatchReadResult['results']): {
  source: string;
  summary: string;
  truncated: boolean;
  data: ReadEventData;
} {
  let source = '';
  const items = results
    .slice(0, TOOL_EXECUTION_LIMITS.readMaxBatchItems)
    .map((item): { body: string; result: ReadEventData['results'][number] } => {
      const path = item.path.slice(0, 4096).replace(/[\uD800-\uDBFF]$/u, '');
      if ('error' in item) {
        const error = {
          code: item.error.code.slice(0, 80),
          message: item.error.message.slice(0, 1000)
        };
        return { body: `${error.code}: ${error.message}`, result: { path, error } };
      }
      return {
        body: item.text,
        result: {
          path,
          startLine: item.startLine,
          ...(item.endLine === undefined ? {} : { endLine: item.endLine }),
          ...(item.text.length === 0 ? { empty: true as const } : {})
        }
      };
    });
  const maximum = AGENT_EXECUTION_POLICY.toolEventSummaryCharacters;
  const completeLength = items.reduce(
    (length, { body, result }) => length + result.path.length + 1 + body.length,
    Math.max(0, items.length - 1) * 2
  );
  let truncated = items.length < results.length;
  const projected: ReadEventData['results'] = [];
  for (const [index, { body, result }] of items.entries()) {
    const path = result.path;
    const separator = index === 0 ? '' : '\n\n';
    const remaining = items.length - index;
    const budget =
      completeLength <= maximum
        ? maximum - source.length - separator.length
        : Math.floor(
            (maximum - source.length - separator.length - 2 * (remaining - 1)) / remaining
          );
    // Keep full paths in metadata; long display labels must leave room for each body.
    const pathBudget = Math.max(Math.floor(budget / 2), budget - body.length - 1);
    const label =
      path.length <= pathBudget
        ? path
        : `${path.slice(0, pathBudget - 3).replace(/[\uD800-\uDBFF]$/u, '')}...`;
    const preview = body.slice(0, budget - label.length - 1).replace(/[\uD800-\uDBFF]$/u, '');
    truncated ||= label.length < path.length || preview.length < body.length;
    source += `${separator}${label}\n`;
    const start = source.length;
    source += preview;
    if (!result.error) result.contentRange = { start, end: source.length };
    projected.push(result);
  }
  return {
    source,
    summary: source,
    truncated,
    data: { mode: 'batch', results: projected, truncated }
  };
}

export class ReadTool {
  constructor(private readonly paths: WorkspacePathResolver) {}
  async execute(arguments_: unknown, signal?: AbortSignal): Promise<BatchReadResult> {
    return this.#readBatch(parseReadInput(arguments_).reads, signal);
  }

  async #readBatch(reads: ReadRequest[], signal?: AbortSignal): Promise<BatchReadResult> {
    const perItemBytes = Math.min(
      TOOL_EXECUTION_LIMITS.readMaxBytes,
      Math.floor(TOOL_EXECUTION_LIMITS.readMaxBatchBytes / reads.length)
    );
    const unique = new Map<string, ReadRequest>();
    for (const item of reads) unique.set(readKey(item), item);
    const entries = [...unique.entries()];
    const completed = new Map<string, ReadResult | ReadErrorResult>();
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const entry = entries[cursor++];
        if (!entry) return;
        const [key, item] = entry;
        try {
          completed.set(key, await this.#readOne(item, perItemBytes, signal));
        } catch (error) {
          if (signal?.aborted) throw error;
          completed.set(key, readError(item.path, error));
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(TOOL_EXECUTION_LIMITS.readBatchConcurrency, entries.length) },
        worker
      )
    );
    const results = reads.map((item) => completed.get(readKey(item))!);
    return {
      mode: 'batch',
      results,
      truncated: results.some((result) => 'truncated' in result && result.truncated)
    };
  }

  async #readOne(input: ReadRequest, maxBytes: number, signal?: AbortSignal): Promise<ReadResult> {
    signal?.throwIfAborted();
    const path = await this.paths.resolve(input.path);
    const stat = await lstat(path);
    if (!stat.isFile())
      throw new AgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Path is not a regular file.');
    const offset = Math.max(1, input.offset ?? 1);
    const limit = Math.min(
      TOOL_EXECUTION_LIMITS.readMaxLines,
      Math.max(1, input.limit ?? TOOL_EXECUTION_LIMITS.readDefaultLines)
    );
    const detected = await detectEncoding(path);
    const selected: string[] = [];
    const sourceLines: string[] = [];
    let outputBytes = 0;
    let lineNumber = 0;
    let hasMore = false;
    let newline: 'crlf' | 'lf' = 'lf';
    let pending = '';
    let stopped = false;
    const decoder = new TextDecoder(detected.decoder, { fatal: true, ignoreBOM: true });
    const stream = createReadStream(path, { start: detected.bomBytes, signal });
    const consumeLine = (rawLine: string, hasLineFeed: boolean) => {
      const source = rawLine + (hasLineFeed ? '\n' : '');
      lineNumber++;
      if (rawLine.endsWith('\r')) {
        newline = 'crlf';
        rawLine = rawLine.slice(0, -1);
      }
      if (lineNumber < offset) return true;
      if (selected.length >= limit) {
        hasMore = true;
        return false;
      }
      const formatted = `${lineNumber}\t${rawLine}`;
      const formattedBytes = Buffer.byteLength(formatted);
      const separatorBytes = selected.length === 0 ? 0 : 1;
      if (outputBytes + separatorBytes + formattedBytes > maxBytes) {
        if (selected.length === 0)
          throw new AgentError(
            'MAR_AGENT_TOOL_OUTPUT_LIMIT',
            'A single line exceeds the read result limit.'
          );
        hasMore = true;
        return false;
      }
      selected.push(formatted);
      sourceLines.push(source);
      outputBytes += separatorBytes + formattedBytes;
      return true;
    };
    const consumeDecoded = (value: string) => {
      if (value.includes('\0'))
        throw new AgentError(
          'MAR_AGENT_FILE_ENCODING_INVALID',
          'Text files cannot contain NUL characters; UTF-16 requires a BOM.'
        );
      pending += value;
      for (;;) {
        const delimiter = pending.indexOf('\n');
        if (delimiter < 0) break;
        const line = pending.slice(0, delimiter);
        pending = pending.slice(delimiter + 1);
        if (!consumeLine(line, true)) return false;
      }
      if (lineNumber + 1 < offset && pending.length > 1)
        pending = pending.endsWith('\r') ? '\r' : '';
      else if (Buffer.byteLength(pending) > maxBytes)
        throw new AgentError(
          'MAR_AGENT_TOOL_OUTPUT_LIMIT',
          'A single line exceeds the read result limit.'
        );
      return true;
    };
    try {
      for await (const chunk of stream) {
        if (!consumeDecoded(decoder.decode(chunk as Buffer, { stream: true }))) {
          stopped = true;
          break;
        }
      }
      if (!stopped) {
        consumeDecoded(decoder.decode());
        if (pending.length > 0) consumeLine(pending, false);
      }
    } catch (error) {
      if (error instanceof TypeError)
        throw new AgentError(
          'MAR_AGENT_FILE_ENCODING_INVALID',
          'File contains invalid text for its declared encoding.',
          { cause: error }
        );
      throw error;
    } finally {
      stream.destroy();
    }
    const nextOffset = hasMore ? offset + selected.length : undefined;
    return {
      path: input.path,
      content: selected.join('\n'),
      text: sourceLines.join(''),
      encoding: detected.encoding,
      newline,
      startLine: offset,
      ...(selected.length ? { endLine: offset + selected.length - 1 } : {}),
      eof: !hasMore,
      truncated: hasMore,
      ...(nextOffset === undefined ? {} : { nextOffset })
    };
  }
}

async function detectEncoding(path: string): Promise<{
  encoding: ReadResult['encoding'];
  decoder: 'utf-8' | 'utf-16le' | 'utf-16be';
  bomBytes: number;
}> {
  const handle = await open(path, 'r');
  try {
    const header = Buffer.alloc(3);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead >= 3 && header[0] === 0xef && header[1] === 0xbb && header[2] === 0xbf)
      return { encoding: 'utf-8', decoder: 'utf-8', bomBytes: 3 };
    if (bytesRead >= 2 && header[0] === 0xff && header[1] === 0xfe)
      return { encoding: 'utf-16le', decoder: 'utf-16le', bomBytes: 2 };
    if (bytesRead >= 2 && header[0] === 0xfe && header[1] === 0xff)
      return { encoding: 'utf-16be', decoder: 'utf-16be', bomBytes: 2 };
    return { encoding: 'utf-8', decoder: 'utf-8', bomBytes: 0 };
  } finally {
    await handle.close();
  }
}

function parseReadInput(value: unknown): { reads: ReadRequest[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalidReadInput('input', 'an object with a reads array');
  const input = value as Record<string, unknown>;
  if (
    !Array.isArray(input.reads) ||
    input.reads.length === 0 ||
    input.reads.length > TOOL_EXECUTION_LIMITS.readMaxBatchItems
  )
    return invalidReadInput(
      'reads',
      `an array of 1 to ${TOOL_EXECUTION_LIMITS.readMaxBatchItems} requests`
    );
  if (Object.keys(input).some((key) => key !== 'reads'))
    return invalidReadInput('input', 'only the reads field; put path/offset/limit inside reads');
  return { reads: input.reads.map(parseReadRequest) };
}

function parseReadRequest(value: unknown, index: number): ReadRequest {
  const field = `reads[${index}]`;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalidReadInput(field, 'an object with path and optional offset/limit');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !['path', 'offset', 'limit'].includes(key)))
    return invalidReadInput(field, 'only path, offset and limit fields');
  if (typeof input.path !== 'string' || input.path === '')
    return invalidReadInput(`${field}.path`, 'a non-empty string');
  if (
    input.offset !== undefined &&
    input.offset !== null &&
    (!Number.isInteger(input.offset) || (input.offset as number) < 1)
  )
    return invalidReadInput(`${field}.offset`, 'an integer >= 1');
  if (
    input.limit !== undefined &&
    input.limit !== null &&
    (!Number.isInteger(input.limit) || (input.limit as number) < 1)
  )
    return invalidReadInput(`${field}.limit`, 'an integer >= 1');
  return {
    path: input.path,
    ...(typeof input.offset === 'number' ? { offset: input.offset } : {}),
    ...(typeof input.limit === 'number'
      ? { limit: Math.min(input.limit, TOOL_EXECUTION_LIMITS.readMaxLines) }
      : {})
  };
}

function readKey(input: ReadRequest): string {
  return JSON.stringify([
    input.path,
    input.offset ?? 1,
    input.limit ?? TOOL_EXECUTION_LIMITS.readDefaultLines
  ]);
}

function readError(path: string, error: unknown): ReadErrorResult {
  if (error instanceof AgentError)
    return { path, error: { code: error.code, message: error.publicMessage } };
  const code =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'MAR_AGENT_TOOL_FAILED';
  return { path, error: { code, message: 'Unable to read file.' } };
}

function invalidReadInput(field: string, expected: string): never {
  throw new AgentError('MAR_AGENT_TOOL_INPUT_INVALID', `${field}: expected ${expected}.`);
}

function escapeAttribute(value: string): string {
  return markupAttributes({ value }).slice(8, -1);
}

function boundedUtf8Prefix(
  value: string,
  maximumBytes: number
): {
  value: string;
  truncated: boolean;
} {
  if (Buffer.byteLength(value) <= maximumBytes) return { value, truncated: false };
  const marker = '…';
  const contentBudget = Math.max(0, maximumBytes - Buffer.byteLength(marker));
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > contentBudget) break;
    result += character;
    bytes += characterBytes;
  }
  return { value: `${result}${marker}`, truncated: true };
}

function oversizedLinePreview(
  value: string,
  retainedBytes: number,
  lineNumber: number
): {
  value: string;
  shownBytes: number;
  omittedBytes: number;
} {
  const bytes = Buffer.from(value, 'utf8');
  if (retainedBytes >= bytes.length) return { value, shownBytes: bytes.length, omittedBytes: 0 };
  const headTarget = Math.floor(retainedBytes / 2);
  const tailTarget = retainedBytes - headTarget;
  let head = Math.min(headTarget, bytes.length);
  while (head > 0 && isUtf8ContinuationByte(bytes[head])) head--;
  let tail = Math.max(head, bytes.length - tailTarget);
  while (tail < bytes.length && isUtf8ContinuationByte(bytes[tail])) tail++;
  const shownBytes = head + bytes.length - tail;
  const omittedBytes = bytes.length - shownBytes;
  const marker = `...[${omittedBytes} bytes omitted from line ${lineNumber}]...`;
  return {
    value: `${bytes.toString('utf8', 0, head)}${marker}${bytes.toString('utf8', tail)}`,
    shownBytes,
    omittedBytes
  };
}

function isUtf8ContinuationByte(value: number | undefined): boolean {
  return value !== undefined && (value & 0xc0) === 0x80;
}

function formatBatchReadResult(
  result: ReadResult | ReadErrorResult,
  index: number,
  maximumBytes: number
): { content: string; previewComplete: boolean } {
  const visiblePath = boundedUtf8Prefix(result.path, 128);
  const path = escapeAttribute(visiblePath.value);
  const pathTruncatedAttribute = visiblePath.truncated ? ' pathTruncated="true"' : '';
  if ('error' in result) {
    const message = boundedUtf8Prefix(result.error.message, 256);
    const detailsTruncatedAttribute = message.truncated ? ' detailsTruncated="true"' : '';
    const content = `<mar_read_error index="${index}" path="${path}"${pathTruncatedAttribute} code="${escapeAttribute(result.error.code)}"${detailsTruncatedAttribute}>\n  ${markupText('message', message.value)}\n</mar_read_error>`;
    if (Buffer.byteLength(content) <= maximumBytes) return { content, previewComplete: true };
    return {
      content: `<mar_read_error index="${index}" code="MAR_AGENT_TOOL_OUTPUT_LIMIT">
  <message>Model-visible error metadata exceeds this item's output share.</message>
</mar_read_error>`,
      previewComplete: false
    };
  }
  const lines = result.content ? result.content.split('\n') : [];
  const render = (visibleLines: number) => {
    const previewComplete = visibleLines === lines.length;
    const endLine =
      visibleLines === 0 ? undefined : result.startLine + Math.max(0, visibleLines - 1);
    const metadata = {
      path: visiblePath.value,
      ...(visiblePath.truncated ? { pathTruncated: true } : {}),
      encoding: result.encoding,
      newline: result.newline,
      startLine: result.startLine,
      ...(endLine === undefined ? {} : { endLine }),
      eof: previewComplete ? result.eof : false,
      truncated: previewComplete ? result.truncated : true,
      ...(previewComplete
        ? result.nextOffset === undefined
          ? {}
          : { nextOffset: result.nextOffset }
        : { nextOffset: result.startLine + visibleLines }),
      previewComplete
    };
    return formatReadContextItem(index, metadata, lines.slice(0, visibleLines).join('\n'));
  };
  const full = render(lines.length);
  if (Buffer.byteLength(full) <= maximumBytes) return { content: full, previewComplete: true };
  let low = 0;
  let high = lines.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(render(middle)) <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  const content = render(low);
  if (low > 0 && Buffer.byteLength(content) <= maximumBytes)
    return { content, previewComplete: low === lines.length };
  if (lines.length > 0) {
    const lineNumber = result.startLine;
    const prefix = `${lineNumber}\t`;
    const formattedLine = lines[0]!;
    const sourceLine = formattedLine.startsWith(prefix)
      ? formattedLine.slice(prefix.length)
      : formattedLine;
    const sourceLineBytes = Buffer.byteLength(sourceLine);
    const renderOversizedLine = (retainedBytes: number) => {
      const preview = oversizedLinePreview(sourceLine, retainedBytes, lineNumber);
      const metadata = {
        path: visiblePath.value,
        ...(visiblePath.truncated ? { pathTruncated: true } : {}),
        encoding: result.encoding,
        newline: result.newline,
        startLine: lineNumber,
        endLine: lineNumber,
        eof: false,
        truncated: true,
        previewComplete: false,
        oversizedLine: {
          line: lineNumber,
          bytes: sourceLineBytes,
          shownBytes: preview.shownBytes,
          omittedBytes: preview.omittedBytes
        }
      };
      return formatReadContextItem(index, metadata, `${prefix}${preview.value}`);
    };
    let minimum = renderOversizedLine(0);
    if (Buffer.byteLength(minimum) <= maximumBytes) {
      let retainedLow = 0;
      let retainedHigh = sourceLineBytes;
      while (retainedLow < retainedHigh) {
        const middle = Math.ceil((retainedLow + retainedHigh) / 2);
        const candidate = renderOversizedLine(middle);
        if (Buffer.byteLength(candidate) <= maximumBytes) {
          retainedLow = middle;
          minimum = candidate;
        } else retainedHigh = middle - 1;
      }
      return { content: minimum, previewComplete: false };
    }
  }
  return {
    content: `<mar_read_error index="${index}" code="MAR_AGENT_TOOL_OUTPUT_LIMIT">
  <message>Model-visible read metadata exceeds this item's output share.</message>
</mar_read_error>`,
    previewComplete: false
  };
}

export function formatBatchReadOutput(results: Array<ReadResult | ReadErrorResult>): {
  content: string;
  truncated: boolean;
} {
  const blocks: string[] = [];
  let bytes = 0;
  let truncated = false;
  const maximumBytes = modelTokenBudgetBytes(AGENT_EXECUTION_POLICY.modelToolOutputTokens);
  for (const [index, result] of results.entries()) {
    const separatorBytes = blocks.length === 0 ? 0 : 1;
    const remainingItems = results.length - index;
    const itemBudget = Math.floor((maximumBytes - bytes - separatorBytes) / remainingItems);
    const block = formatBatchReadResult(result, index, itemBudget);
    const blockBytes = Buffer.byteLength(block.content);
    if (bytes + separatorBytes + blockBytes > maximumBytes) break;
    blocks.push(block.content);
    bytes += separatorBytes + blockBytes;
    if (!block.previewComplete) truncated = true;
  }
  return { content: blocks.join('\n'), truncated };
}
