import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserTextInput } from '../../src/service/browser-text-input.js';

afterEach(() => vi.useRealTimers());

describe('Browser text input', () => {
  const ordinary = { inputType: 'insertText', data: '你好', isComposing: false };
  const composed = { inputType: 'insertCompositionText', data: 'ni', isComposing: true };

  it('commits Chromium compositionend even when every input event was composing', () => {
    const output = vi.fn();
    const input = new BrowserTextInput(output);
    input.start(1);
    expect(input.read(composed, 'ni', 1)).toBe(false);
    expect(output).not.toHaveBeenCalled();
    input.end('你好', 1);
    expect(output.mock.calls).toEqual([['你好', 1]]);
    input.reset();
  });

  it('suppresses a trailing commit input but not a later identical ordinary input', () => {
    vi.useFakeTimers();
    const output = vi.fn();
    const input = new BrowserTextInput(output);
    input.start(1);
    input.read({ ...ordinary, inputType: 'insertFromComposition' }, '你好', 1);
    input.end('你好', 1);
    expect(input.read(ordinary, '你好', 1)).toBe(true);
    expect(output).toHaveBeenCalledTimes(1);
    vi.runAllTimers();
    expect(input.read(ordinary, '你好', 1)).toBe(true);
    expect(output.mock.calls).toEqual([
      ['你好', 1],
      ['你好', 1]
    ]);
  });

  it('does not submit canceled or stale composition to a replacement view', () => {
    const output = vi.fn();
    const input = new BrowserTextInput(output);
    input.start(1);
    input.end('', 1);
    input.start(1);
    input.invalidate();
    expect(input.active).toBe(true);
    input.end('你好', 2);
    input.read({ ...ordinary, inputType: 'insertFromComposition' }, '你好', 2);
    expect(output).not.toHaveBeenCalled();
    input.reset();
  });
});
