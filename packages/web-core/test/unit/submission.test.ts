import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkbenchSubmissionService,
  sessionSubmissionContext
} from '../../src/service/WorkbenchSubmissionService.js';

afterEach(() => vi.useRealTimers());

describe('shared submission gate', () => {
  it('keeps bootstrap identity stable and real sessions distinct', () => {
    expect(sessionSubmissionContext(undefined)).toBe('session:draft');
    expect(sessionSubmissionContext('draft:123')).toBe('session:draft');
    expect(sessionSubmissionContext('saved')).toBe('session:saved');
  });

  it('rejects concurrent submission and releases exactly once', () => {
    vi.useFakeTimers();
    const service = createWorkbenchSubmissionService();
    const finish = service.begin('session:a')!;
    expect(service.pending.value).toBe(true);
    expect(service.context.value).toBe('session:a');
    expect(service.begin('session:b')).toBeUndefined();
    expect(finish()).toBe(true);
    expect(finish()).toBe(false);
    expect(service.pending.value).toBe(false);
    expect(service.context.value).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases on timeout without allowing an old completion to release a newer request', () => {
    vi.useFakeTimers();
    const service = createWorkbenchSubmissionService();
    const old = service.begin('session:a')!;
    vi.advanceTimersByTime(5000);
    expect(service.pending.value).toBe(false);
    expect(service.context.value).toBeUndefined();
    const current = service.begin('session:b')!;
    expect(old()).toBe(false);
    expect(service.pending.value).toBe(true);
    expect(service.context.value).toBe('session:b');
    expect(current()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
