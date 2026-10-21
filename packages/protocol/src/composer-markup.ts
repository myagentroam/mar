// The product format has one root and text/resource leaves, not arbitrary XML.
export interface ComposerMarkupField {
  readonly name: string;
  readonly attributes: Record<string, string>;
  readonly text: string;
}

export function escapeMarkup(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function markupAttributes(values: object): string {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(
      ([key, value]) =>
        ` ${key}="${escapeMarkup(String(value)).replaceAll('"', '&quot;').replaceAll('\r', '&#13;').replaceAll('\n', '&#10;').replaceAll('\t', '&#9;')}"`
    )
    .join('');
}

function decode(value: string): string {
  if (value.includes('<')) throw new Error('COMPOSER_TAG_INVALID');
  return value.replace(/&([^;]*);|&/gu, (_, name: string | undefined) => {
    const predefined: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (name && Object.hasOwn(predefined, name)) return predefined[name]!;
    if (name && /^#(?:[0-9]+|x[0-9a-fA-F]+)$/u.test(name)) {
      const point = name[1] === 'x' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      if (
        point === 9 ||
        point === 10 ||
        point === 13 ||
        (point >= 32 &&
          point <= 0x10ffff &&
          !(point >= 0xd800 && point <= 0xdfff) &&
          point !== 0xfffe &&
          point !== 0xffff)
      )
        return String.fromCodePoint(point);
    }
    throw new Error('COMPOSER_TAG_INVALID');
  });
}

const header = /^<([a-z_]+)((?:\s+[A-Za-z][A-Za-z0-9]*="[^"<]*")*)\s*(\/?)>/u;
function attributes(text: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const match of text.matchAll(/\s+([A-Za-z][A-Za-z0-9]*)="([^"]*)"/gu)) {
    if (Object.hasOwn(result, match[1]!)) throw new Error('COMPOSER_TAG_INVALID');
    result[match[1]!] = decode(match[2]!);
  }
  return result;
}

export function parseComposerMarkup(raw: string): {
  name: string;
  attributes: Record<string, string>;
  fields: ComposerMarkupField[];
} {
  const root = header.exec(raw);
  if (!root) throw new Error('COMPOSER_TAG_INVALID');
  const result = {
    name: root[1]!,
    attributes: attributes(root[2]!),
    fields: [] as ComposerMarkupField[]
  };
  if (root[3]) {
    if (root[0].length !== raw.length) throw new Error('COMPOSER_TAG_INVALID');
    return result;
  }
  const close = `</${root[1]}>`;
  if (!raw.endsWith(close)) throw new Error('COMPOSER_TAG_INVALID');
  const body = raw.slice(root[0].length, -close.length);
  let offset = 0;
  while (offset < body.length) {
    offset += /^\s*/u.exec(body.slice(offset))![0].length;
    if (offset === body.length) break;
    const field = header.exec(body.slice(offset));
    if (!field) throw new Error('COMPOSER_TAG_INVALID');
    offset += field[0].length;
    let text = '';
    if (!field[3]) {
      const end = body.indexOf(`</${field[1]}>`, offset);
      if (end < 0) throw new Error('COMPOSER_TAG_INVALID');
      text = decode(body.slice(offset, end));
      offset = end + field[1]!.length + 3;
    }
    result.fields.push({ name: field[1]!, attributes: attributes(field[2]!), text });
  }
  return result;
}

// Find the whole candidate before validating it, so invalid parents cannot hide children.
export function composerMarkupEnd(text: string, start: number): number {
  const tags = /<\/?([^\s<>/"']+)(?=[\s/>])(?:"[^"]*"|'[^']*'|[^'"<>])*>/gu;
  tags.lastIndex = start;
  const opening = tags.exec(text);
  if (!opening || opening.index !== start) return text.length;
  if (/\/\s*>$/u.test(opening[0])) return tags.lastIndex;
  const rootName = opening[1];
  let depth = 1;
  for (let token = tags.exec(text); token; token = tags.exec(text)) {
    if (token[1] !== rootName) continue;
    if (token[0].startsWith('</')) depth--;
    else if (!/\/\s*>$/u.test(token[0])) depth++;
    if (depth === 0) return tags.lastIndex;
  }
  return text.length;
}
