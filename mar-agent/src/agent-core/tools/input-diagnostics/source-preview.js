/**
 * Preview only the submitted line around a one-based Unicode character column.
 * Escape controls and measure rendered graphemes, not source columns, for the caret.
 * @param {string} source
 * @param {number} column
 */
export function sourcePreview(source, column) {
  const characters = Array.from(source);
  const index = column - 1;
  let before = '';
  let start = index;
  let width = 0;
  while (start > 0) {
    const token = displayCharacter(characters[start - 1]);
    const candidate = token + before;
    const size = displayWidth(candidate);
    if (size > 60 || Array.from(candidate).length > 60) break;
    before = candidate;
    width = size;
    start--;
  }
  const prefix = start > 0 ? '… ' : '';
  const caret = width + prefix.length;
  let text = before;
  let end = index;
  while (end < characters.length) {
    const token = displayCharacter(characters[end]);
    const candidate = text + token;
    if (displayWidth(candidate) > 156 || Array.from(candidate).length > 156) break;
    text = candidate;
    end++;
  }
  return {
    text: `${prefix}${text}${end < characters.length ? ' …' : ''}`,
    caret
  };
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function displayWidth(text) {
  let width = 0;
  for (const { segment } of graphemes.segment(text)) {
    const base = segment.match(/[^\p{Mark}\p{Cf}]/u)?.[0];
    if (base === undefined) continue;
    // Match conventional monospace cells: combining marks join their base and emoji occupy two.
    width +=
      /[\p{Emoji_Presentation}\ufe0f\u20e3]/u.test(segment) ||
      /[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]/u.test(
        base
      )
        ? 2
        : 1;
  }
  return width;
}

function displayCharacter(character) {
  if (character === '\t') return '    ';
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Bidi_Control}]/u.test(character)) {
    const escaped = JSON.stringify(character).slice(1, -1);
    return escaped === character ? `\\u{${character.codePointAt(0).toString(16)}}` : escaped;
  }
  return character;
}
