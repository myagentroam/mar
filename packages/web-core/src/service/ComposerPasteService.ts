const LONG_PASTE_LINES = 100;
const LONG_PASTE_CHARACTERS = 10_000;

export function isLongComposerPaste(text: string): boolean {
  if (text.length >= LONG_PASTE_CHARACTERS) return true;
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n' || (text[index] === '\r' && text[index + 1] !== '\n')) lines += 1;
    if (lines >= LONG_PASTE_LINES) return true;
  }
  return false;
}

export function createLongTextAttachment(text: string, now = new Date()): File {
  const stamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds())
  ].join('');
  return new File([text], `pasted-text-${stamp}.txt`, {
    type: 'text/plain;charset=utf-8'
  });
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
