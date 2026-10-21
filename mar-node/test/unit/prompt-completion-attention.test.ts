import { describe, expect, it, vi } from 'vitest';
import { projectPredictionAttention } from '../../src/service/prompt-completion-attention.js';

describe('Prediction browser attention', () => {
  const event = {
    kind: 'FILE' as const,
    path: 'src/a.ts',
    observedAt: 1000,
    revision: 'r',
    startLine: 2,
    endLine: 3
  };
  const signal = new AbortController().signal;
  it('uses only revalidated visible file lines, not the browser supplied body', async () => {
    const read = vi.fn(async () => ({
      revision: 'r',
      encoding: 'utf-8',
      content: 'hidden\nviewed\nalso viewed\nnot viewed'
    }));
    expect(JSON.parse(await projectPredictionAttention([event], read, signal, 2000))).toEqual([
      expect.objectContaining({ text: 'viewed\nalso viewed', startLine: 2, endLine: 3 })
    ]);
  });
  it('omits incomplete and out-of-window lines from a truncated file prefix', async () => {
    const read = vi.fn(async () => ({
      revision: 'r',
      encoding: 'utf-8',
      content: 'complete\npartial',
      truncated: true
    }));
    expect(await projectPredictionAttention([event], read, signal, 2000)).toBe('[]');
    const result = JSON.parse(
      await projectPredictionAttention([{ ...event, startLine: 1, endLine: 3 }], read, signal, 2000)
    );
    expect(result[0]).toMatchObject({ text: 'complete', startLine: 1, endLine: 1 });
  });
  it('omits expired, future and escaping paths before reading', async () => {
    const read = vi.fn();
    const events = [
      { ...event, observedAt: 1 },
      { ...event, observedAt: 300000 },
      ...['../secret', '/etc/passwd', 'C:\\secret', 'mar-attachment:secret'].map((path) => ({
        ...event,
        path,
        observedAt: 200000
      }))
    ];
    expect(await projectPredictionAttention(events, read, signal, 200000)).toBe('[]');
    expect(read).not.toHaveBeenCalled();
  });
  it('omits changed or binary files and does not read unversioned Diff bodies', async () => {
    const read = vi.fn(async () => ({
      revision: 'changed',
      encoding: 'utf-8',
      content: 'unrelated'
    }));
    const result = JSON.parse(
      await projectPredictionAttention(
        [event, { ...event, kind: 'DIFF', source: 'WORKING_TREE' }],
        read,
        signal,
        2000
      )
    );
    expect(result).toHaveLength(1);
    expect(result[0]).not.toHaveProperty('text');
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('does not let optional reference failures mask cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      projectPredictionAttention([event], vi.fn(), controller.signal, 2000)
    ).rejects.toThrow();
  });
});
