import { describe, expect, it } from 'vitest';
import { sourcePreview } from '../../src/tools/input-diagnostics/source-preview.js';

describe('tool input source previews', () => {
  it('keeps submitted Unicode text and points at the reported character', () => {
    expect(sourcePreview('🙂中文?', 4)).toEqual({ text: '🙂中文?', caret: 6 });
  });

  it.each([
    { source: 'e\u0301?', column: 3, caret: 1 },
    { source: '👨‍👩‍👧‍👦?', column: 8, caret: 2 },
    { source: '🇨🇳?', column: 3, caret: 2 },
    { source: '❤️?', column: 3, caret: 2 },
    { source: 'Ａ한?', column: 3, caret: 4 }
  ])('aligns the caret after rendered graphemes in $source', ({ source, column, caret }) => {
    expect(sourcePreview(source, column)).toEqual({ text: source, caret });
  });

  it('expands tabs and escapes terminal controls without moving the caret', () => {
    expect(sourcePreview('\t\x1b\r?', 4)).toEqual({ text: '    \\u001b\\r?', caret: 12 });
    expect(sourcePreview('a\u202eb?', 4)).toEqual({ text: 'a\\u{202e}b?', caret: 10 });
  });

  it('keeps the error visible when cropping both ends of a long line', () => {
    const preview = sourcePreview(`${'a'.repeat(500)}?${'b'.repeat(500)}`, 501);
    expect(preview.text.startsWith('… ')).toBe(true);
    expect(preview.text.endsWith(' …')).toBe(true);
    expect(preview.text[preview.caret]).toBe('?');
    expect(preview.text.length).toBeLessThanOrEqual(164);
  });

  it('escapes every bidi control without hiding the submitted characters', () => {
    for (const codePoint of [
      0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069
    ]) {
      const control = String.fromCodePoint(codePoint);
      const prefix = `a\\u{${codePoint.toString(16)}}b`;
      expect(sourcePreview(`a${control}b?`, 4)).toEqual({
        text: `${prefix}?`,
        caret: prefix.length
      });
    }
  });

  it('bounds escaped controls as displayed text, not only source characters', () => {
    const preview = sourcePreview(`${'\x1b'.repeat(500)}?${'\x1b'.repeat(500)}`, 501);
    expect(preview.text[preview.caret]).toBe('?');
    expect(preview.text).not.toContain('\x1b');
    expect(preview.text.length).toBeLessThanOrEqual(164);
  });

  it('keeps a cropped wide-character line aligned within the display budget', () => {
    const preview = sourcePreview(`${'中'.repeat(500)}?${'🙂'.repeat(500)}`, 501);
    expect(preview).toEqual({
      text: `… ${'中'.repeat(30)}?${'🙂'.repeat(47)} …`,
      caret: 62
    });
  });

  it('points after the last character at end of input, including empty input', () => {
    expect(sourcePreview('hello', 6)).toEqual({ text: 'hello', caret: 5 });
    expect(sourcePreview('', 1)).toEqual({ text: '', caret: 0 });
  });
});
