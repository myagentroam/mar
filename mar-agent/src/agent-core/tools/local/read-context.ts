import {
  decodeMarkupText,
  markupAttributes,
  markupText,
  parseMarkupAttributes
} from '../../prompts/markup.js';

export interface ParsedReadContextItem {
  readonly index: number;
  readonly path: string;
  readonly pathTruncated: boolean;
  readonly content: string;
  readonly metadata: Record<string, unknown>;
  readonly contentStart: number;
  readonly contentEnd: number;
}

export interface ParsedReadContextOutput {
  readonly items: readonly ParsedReadContextItem[];
}

export function formatReadContextItem(
  index: number,
  metadata: Record<string, unknown>,
  content: string
): string {
  const { oversizedLine, ...values } = metadata;
  const header = `<mar_read_result${markupAttributes({ index, path: metadata.path, pathTruncated: metadata.pathTruncated })}>`;
  const info =
    oversizedLine && typeof oversizedLine === 'object'
      ? `<metadata${markupAttributes(values)}>\n    <oversized_line${markupAttributes(oversizedLine)} />\n  </metadata>`
      : `<metadata${markupAttributes(values)} />`;
  return [header, '  ' + markupText('content', content), '  ' + info, '</mar_read_result>'].join(
    '\n'
  );
}

function metadataValues(values: Record<string, string>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (key === 'path') result[key] = value;
    else if (key === 'encoding' && ['utf-8', 'utf-16le', 'utf-16be'].includes(value))
      result[key] = value;
    else if (key === 'newline' && ['lf', 'crlf'].includes(value)) result[key] = value;
    else if (['pathTruncated', 'eof', 'truncated', 'previewComplete'].includes(key)) {
      if (value !== 'true' && value !== 'false') throw new Error('MAR_AGENT_MARKUP_INVALID');
      result[key] = value === 'true';
    } else if (['startLine', 'endLine', 'nextOffset'].includes(key)) {
      if (!/^[0-9]+$/u.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)
        throw new Error('MAR_AGENT_MARKUP_INVALID');
      result[key] = Number(value);
    } else throw new Error('MAR_AGENT_MARKUP_INVALID');
  }
  return result;
}

export function parseReadContextOutput(value: string): ParsedReadContextOutput | undefined {
  try {
    if (!value.startsWith('<mar_read_')) return undefined;
    const items: ParsedReadContextItem[] = [];
    const indexes = new Set<number>();
    let offset = 0;
    while (offset < value.length) {
      const header = /^<mar_read_(result|error)([^<>]*)>/.exec(value.slice(offset));
      if (!header) return undefined;
      const attrs = parseMarkupAttributes(header[2]!);
      const index = Number(attrs.index);
      if (!/^[0-9]+$/u.test(attrs.index ?? '') || !Number.isSafeInteger(index)) return undefined;
      if (indexes.has(index)) return undefined;
      indexes.add(index);
      if (header[1] === 'error') {
        if (
          !attrs.code ||
          Object.keys(attrs).some(
            (key) => !['index', 'path', 'pathTruncated', 'code', 'detailsTruncated'].includes(key)
          )
        )
          return undefined;
        if (
          ['pathTruncated', 'detailsTruncated'].some(
            (key) => attrs[key] !== undefined && attrs[key] !== 'true' && attrs[key] !== 'false'
          )
        )
          return undefined;
        const end = value.indexOf('</mar_read_error>', offset + header[0].length);
        if (end < 0) return undefined;
        const body = value.slice(offset + header[0].length, end).trim();
        if (body !== '<message />') {
          if (!body.startsWith('<message>') || !body.endsWith('</message>')) return undefined;
          decodeMarkupText(body.slice(9, -10));
        }
        offset = end + '</mar_read_error>'.length;
      } else {
        if (
          !attrs.path ||
          Object.keys(attrs).some((key) => !['index', 'path', 'pathTruncated'].includes(key)) ||
          (attrs.pathTruncated !== undefined &&
            attrs.pathTruncated !== 'true' &&
            attrs.pathTruncated !== 'false')
        )
          return undefined;
        const contentStart = offset + header[0].length + 3;
        if (value.slice(contentStart - 3, contentStart) !== '\n  ') return undefined;
        const contentEnd = value.indexOf('\n  ' + '<metadata', contentStart);
        if (contentEnd < 0) return undefined;
        const body = value.slice(contentStart, contentEnd);
        let content: string;
        if (body === '<content />') content = '';
        else if (body.startsWith('<content>') && body.endsWith('</content>'))
          content = decodeMarkupText(body.slice(9, -10));
        else {
          const reclaimed =
            /^<mar_context_gc([^<>]*)>\s*<instruction>([^<]*)<\/instruction>\s*<\/mar_context_gc>$/u.exec(
              body
            );
          if (!reclaimed || parseMarkupAttributes(reclaimed[1]!).kind !== 'stale_read')
            return undefined;
          decodeMarkupText(reclaimed[2]!);
          content = body;
        }
        const end = value.indexOf('\n' + '</mar_read_result>', contentEnd);
        if (end < 0) return undefined;
        const info = value.slice(contentEnd + 3, end);
        const meta =
          /^<metadata([^<>]*?)(?: \/>|>\s*<oversized_line([^<>]*) \/>\s*<\/metadata>)$/u.exec(info);
        if (!meta) return undefined;
        const metadata = metadataValues(parseMarkupAttributes(meta[1]!));
        if (
          metadata.path !== attrs.path ||
          (metadata.pathTruncated === true) !== (attrs.pathTruncated === 'true')
        )
          return undefined;
        if (meta[2] !== undefined) {
          const oversized = parseMarkupAttributes(meta[2]);
          if (
            Object.keys(oversized).length !== 4 ||
            Object.keys(oversized).some(
              (key) => !['line', 'bytes', 'shownBytes', 'omittedBytes'].includes(key)
            ) ||
            Object.values(oversized).some(
              (number) => !/^[0-9]+$/u.test(number) || !Number.isSafeInteger(Number(number))
            )
          )
            return undefined;
          metadata.oversizedLine = Object.fromEntries(
            Object.entries(oversized).map(([key, number]) => [key, Number(number)])
          );
        }
        items.push({
          index,
          path: attrs.path,
          pathTruncated: attrs.pathTruncated === 'true',
          content,
          metadata,
          contentStart,
          contentEnd
        });
        offset = end + 1 + '</mar_read_result>'.length;
      }
      if (offset < value.length) {
        if (value[offset] !== '\n') return undefined;
        offset++;
      }
    }
    return { items };
  } catch {
    return undefined;
  }
}

export function replaceReadContextItems(
  value: string,
  replacements: readonly { readonly index: number; readonly replacement: string }[]
): string {
  const parsed = parseReadContextOutput(value);
  if (!parsed) return value;
  const byIndex = new Map(replacements.map((replacement) => [replacement.index, replacement]));
  const selected = parsed.items
    .flatMap((item) => {
      const replacement = byIndex.get(item.index);
      return replacement ? [{ item, replacement: replacement.replacement }] : [];
    })
    .sort((left, right) => right.item.contentStart - left.item.contentStart);
  let result = value;
  for (const { item, replacement } of selected)
    result = `${result.slice(0, item.contentStart)}${replacement}${result.slice(item.contentEnd)}`;
  return result;
}
