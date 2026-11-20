import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { clearMessages, showMessage } from '../../src/service/message-feedback-service.js';
import { dismissMessages, presentMessage } from '../../src/service/mar-message-presenter.js';
import { AuthenticationContextChangedError } from '../../src/service/workbench-http-service.js';

vi.mock('../../src/service/mar-message-presenter.js', () => ({
  presentMessage: vi.fn(),
  dismissMessages: vi.fn()
}));

beforeEach(() => vi.clearAllMocks());

describe('Message feedback service', () => {
  it('renders only after pending UI is flushed', async () => {
    const flushUi = vi.fn();
    void nextTick(flushUi);
    showMessage('Settings saved', 'success');
    expect(presentMessage).not.toHaveBeenCalled();
    await nextTick();
    expect(flushUi.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(presentMessage).mock.invocationCallOrder[0]!
    );
    expect(presentMessage).toHaveBeenCalledWith('Settings saved', 'success');
  });

  it('clears pending old feedback before rendering feedback from the next identity', async () => {
    showMessage('Old identity result', 'error');
    clearMessages();
    showMessage('New identity result', 'info');
    await nextTick();
    expect(vi.mocked(presentMessage).mock.calls).toEqual([
      ['Old identity result', 'error'],
      ['New identity result', 'info']
    ]);
    const [first, second] = vi.mocked(presentMessage).mock.invocationCallOrder;
    const clears = vi.mocked(dismissMessages).mock.invocationCallOrder;
    expect(clears).toHaveLength(2);
    expect(first).toBeLessThan(clears[1]!);
    expect(second).toBeGreaterThan(clears[1]!);
  });

  it('suppresses blank text and stale authentication errors but preserves ordinary errors', async () => {
    const cause = new AuthenticationContextChangedError();
    expect(cause.name).toBe('AbortError');
    showMessage('  ', 'info');
    showMessage('Stale authentication context', 'error', cause);
    showMessage('An ordinary error.', 'error', new Error('An ordinary error.'));
    showMessage(
      'An ordinary abort.',
      'error',
      new DOMException('An ordinary abort.', 'AbortError')
    );
    showMessage('Timed out.', 'warning', new DOMException('Timed out.', 'TimeoutError'));
    await nextTick();
    expect(vi.mocked(presentMessage).mock.calls).toEqual([
      ['An ordinary error.', 'error'],
      ['An ordinary abort.', 'error'],
      ['Timed out.', 'warning']
    ]);
  });

  it('retains severity, duplicates and raw text for the presenter', async () => {
    const text = '<img src=x>\nDiagnostic detail';
    for (const type of ['success', 'info', 'warning', 'error', 'error'] as const)
      showMessage(text, type);
    await nextTick();
    expect(vi.mocked(presentMessage).mock.calls).toEqual(
      ['success', 'info', 'warning', 'error', 'error'].map((type) => [text, type])
    );
  });
});
