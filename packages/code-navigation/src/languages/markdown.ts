import {
  type FileReference,
  type FileSpecifierParser,
  type NavigationSyntaxDefinition
} from '../types.js';

const inlineLink = /!?\[[^\]\r\n]*\]\(\s*(?:<([^>\r\n]+)>|([^)\s\r\n]+))(?:\s+[^)\r\n]*)?\s*\)/gu;
const referenceLink = /!?\[([^\]\r\n]+)\]\[([^\]\r\n]*)\]/gu;
const referenceDefinition = /^[ \t]{0,3}\[([^\]\r\n]+)\]:\s*(?:<([^>\r\n]+)>|([^ \t\r\n]+))/gmu;
const autolink = /<([^\s<>"'=]+)>/gu;
const htmlAttribute = /(?:^|[\s<])(?:href|src)\s*=\s*(["'])([^"'\r\n]+)\1/giu;

function find(source: string, position: number): FileReference | undefined {
  if (position < 0 || position >= source.length || isWithinFencedCode(source, position))
    return undefined;
  const definitions = referenceDefinitions(source);
  for (const match of source.matchAll(inlineLink)) {
    const value = match[1] ?? match[2];
    const reference = fileReferenceAt(
      source,
      position,
      match.index ?? 0,
      match[0],
      value,
      'markdown.inline'
    );
    if (reference !== undefined) return reference;
  }
  for (const match of source.matchAll(referenceLink)) {
    const label = normalizeLabel(match[2] === '' ? match[1]! : match[2]!);
    const target = definitions.get(label);
    if (target === undefined) continue;
    const reference = fileReferenceAt(
      source,
      position,
      match.index ?? 0,
      match[0],
      target,
      'markdown.reference'
    );
    if (reference !== undefined) return reference;
  }
  for (const match of source.matchAll(autolink)) {
    if (!isLocalAutolinkTarget(match[1])) continue;
    const reference = fileReferenceAt(
      source,
      position,
      match.index ?? 0,
      match[0],
      match[1],
      'markdown.autolink'
    );
    if (reference !== undefined) return reference;
  }
  for (const match of source.matchAll(htmlAttribute)) {
    const reference = fileReferenceAt(
      source,
      position,
      match.index ?? 0,
      match[0],
      match[2],
      'markdown.html-attribute'
    );
    if (reference !== undefined) return reference;
  }
  return undefined;
}

function isLocalAutolinkTarget(value: string | undefined): value is string {
  return value !== undefined && /[./#]/u.test(value);
}

function fileReferenceAt(
  source: string,
  position: number,
  matchOffset: number,
  text: string,
  target: string | undefined,
  extractorId: string
): FileReference | undefined {
  if (target === undefined || position < matchOffset || position >= matchOffset + text.length)
    return undefined;
  const parsed = parseTarget(target);
  if (parsed === undefined) return undefined;
  return {
    value: parsed.path,
    from: matchOffset,
    to: matchOffset + text.length,
    languageId: 'markdown',
    extractorId,
    kind: 'relative-file',
    ...(parsed.anchor === undefined ? {} : { anchor: parsed.anchor })
  };
}

function parseTarget(
  target: string
): { readonly path: string; readonly anchor?: string } | undefined {
  if (
    target.length === 0 ||
    /^[a-z][a-z\d+.-]*:/iu.test(target) ||
    target.startsWith('/') ||
    target.includes('?')
  )
    return undefined;
  const hash = target.indexOf('#');
  const path = hash < 0 ? target : target.slice(0, hash);
  const anchor = hash < 0 ? undefined : target.slice(hash + 1);
  if (anchor === '' && hash >= 0) return undefined;
  if (path === '' && anchor !== undefined) return { path: '.', anchor };
  if (path === '' || path.includes('\\')) return undefined;
  return { path, ...(anchor === undefined ? {} : { anchor }) };
}

function referenceDefinitions(source: string): ReadonlyMap<string, string> {
  const definitions = new Map<string, string>();
  for (const match of source.matchAll(referenceDefinition)) {
    const label = match[1];
    const target = match[2] ?? match[3];
    if (label !== undefined && target !== undefined) definitions.set(normalizeLabel(label), target);
  }
  return definitions;
}

function normalizeLabel(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLowerCase();
}

function isWithinFencedCode(source: string, position: number): boolean {
  let marker: '`' | '~' | undefined;
  let length = 0;
  for (const line of source.slice(0, position).split('\n')) {
    const match = /^[ \t]*(`{3,}|~{3,})/u.exec(line);
    if (match === null) continue;
    const fence = match[1]!;
    if (marker === undefined) {
      marker = fence[0] as '`' | '~';
      length = fence.length;
    } else if (fence[0] === marker && fence.length >= length) {
      marker = undefined;
      length = 0;
    }
  }
  return marker !== undefined;
}

export const markdownFileSpecifierParser: FileSpecifierParser = { find };

export const markdownNavigationSyntaxDefinition = {
  id: 'markdown',
  parser: markdownFileSpecifierParser,
  suffixes: ['.md', '.markdown']
} satisfies NavigationSyntaxDefinition;
