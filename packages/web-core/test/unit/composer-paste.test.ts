import { describe, expect, it } from 'vitest';
import {
  createLongTextAttachment,
  isLongComposerPaste
} from '../../src/service/ComposerPasteService.js';

describe('Web Composer Paste', () => {
  it('Recognizes long text when it reaches 100 lines or 10,000 characters', () => {
    expect(isLongComposerPaste(Array.from({ length: 99 }, () => 'line').join('\n'))).toBe(false);
    expect(isLongComposerPaste(Array.from({ length: 100 }, () => 'line').join('\n'))).toBe(true);
    expect(isLongComposerPaste('x'.repeat(9_999))).toBe(false);
    expect(isLongComposerPaste('x'.repeat(10_000))).toBe(true);
  });

  it('Supports CRLF and lone CR line breaks', () => {
    expect(isLongComposerPaste(Array.from({ length: 100 }, () => 'line').join('\r\n'))).toBe(true);
    expect(isLongComposerPaste(Array.from({ length: 100 }, () => 'line').join('\r'))).toBe(true);
  });

  it('Creates a timestamped UTF-8 TXT attachment from long text', async () => {
    const attachment = createLongTextAttachment('long text', new Date(2026, 7, 27, 9, 8, 7));

    expect(attachment.name).toBe('pasted-text-20260827-090807.txt');
    expect(attachment.type).toBe('text/plain;charset=utf-8');
    expect(await attachment.text()).toBe('long text');
  });
});
