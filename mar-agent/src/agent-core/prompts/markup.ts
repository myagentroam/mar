export function escapeMarkupText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function markupAttributes(values: object): string {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(
      ([key, value]) =>
        ` ${key}="${escapeMarkupText(String(value)).replaceAll('"', '&quot;').replaceAll('\r', '&#13;').replaceAll('\n', '&#10;').replaceAll('\t', '&#9;')}"`
    )
    .join('');
}

export function markupText(name: string, value: string): string {
  return value === '' ? `<${name} />` : `<${name}>${escapeMarkupText(value)}</${name}>`;
}

export function decodeMarkupText(value: string): string {
  if (value.includes('<')) throw new Error('MAR_AGENT_MARKUP_INVALID');
  return value.replace(/&([^;]*);|&/gu, (_, name: string | undefined) => {
    const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (name && Object.hasOwn(entities, name)) return entities[name]!;
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
    throw new Error('MAR_AGENT_MARKUP_INVALID');
  });
}

export function parseMarkupAttributes(value: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  const pattern = /\s+([A-Za-z][A-Za-z0-9]*)="([^"<]*)"/guy;
  let offset = 0;
  for (let match = pattern.exec(value); match; match = pattern.exec(value)) {
    if (Object.hasOwn(result, match[1]!)) throw new Error('MAR_AGENT_MARKUP_INVALID');
    result[match[1]!] = decodeMarkupText(match[2]!);
    offset = pattern.lastIndex;
  }
  if (value.slice(offset).trim() !== '') throw new Error('MAR_AGENT_MARKUP_INVALID');
  return result;
}
