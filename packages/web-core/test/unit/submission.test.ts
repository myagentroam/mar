import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkbenchSubmissionService,
  createWorkbenchSubmissionOwner,
  sessionSubmissionContext
} from '../../src/service/workbench-submission-service.js';

afterEach(() => vi.useRealTimers());

describe('shared submission gate', () => {
  it('shares one admission by target while allowing different targets to submit', () => {
    const owner = createWorkbenchSubmissionOwner();
    const a = {},
      b = {};
    const main = owner.bind(() => a);
    const aside = owner.bind(() => a);
    const other = owner.bind(() => b);
    const finish = main.begin('session:a')!;
    expect(aside.pending.value).toBe(true);
    expect(aside.begin('session:a')).toBeUndefined();
    const finishOther = other.begin('session:b')!;
    expect(finishOther).toBeDefined();
    finish();
    finishOther();
  });

  it.each(['old', 'next'])(
    'merges in-flight admissions and remains blocked when %s settles first',
    (first) => {
      vi.useFakeTimers();
      const owner = createWorkbenchSubmissionOwner();
      const oldSlot = {},
        nextSlot = {};
      const old = owner.bind(() => oldSlot);
      const next = owner.bind(() => nextSlot);
      const finishOld = old.begin('session:old')!;
      const finishNext = next.begin('session:next')!;
      owner.transfer(oldSlot, nextSlot, 'old', 'next');
      expect(next.context.value).toBe('session:next');
      const firstFinish = first === 'old' ? finishOld : finishNext;
      const secondFinish = first === 'old' ? finishNext : finishOld;
      expect(firstFinish()).toBe(true);
      expect(next.pending.value).toBe(true);
      expect(next.begin('session:next')).toBeUndefined();
      expect(secondFinish()).toBe(true);
      expect(next.pending.value).toBe(false);
      const fresh = next.begin('session:next')!;
      expect(firstFinish()).toBe(false);
      expect(next.pending.value).toBe(true);
      vi.advanceTimersByTime(5000);
      expect(next.pending.value).toBe(false);
      expect(fresh()).toBe(false);
    }
  );

  it('retains the other admission if the first merged request times out', () => {
    vi.useFakeTimers();
    const owner = createWorkbenchSubmissionOwner();
    const oldSlot = {},
      nextSlot = {};
    const old = owner.bind(() => oldSlot);
    const next = owner.bind(() => nextSlot);
    const expired = old.begin('session:old', undefined, 1000)!;
    const current = next.begin('session:next', undefined, null)!;
    owner.transfer(oldSlot, nextSlot, 'old', 'next');
    vi.advanceTimersByTime(1000);
    expect(expired()).toBe(false);
    expect(next.pending.value).toBe(true);
    expect(next.begin('session:next')).toBeUndefined();
    expect(current()).toBe(true);
    expect(next.pending.value).toBe(false);
  });
  it('keeps bootstrap identity stable and real sessions distinct', () => {
    expect(sessionSubmissionContext(undefined)).toBe('session:draft');
    expect(sessionSubmissionContext('draft:123')).toBe('session:draft');
    expect(sessionSubmissionContext('saved')).toBe('session:saved');
  });

  it('rejects concurrent submission and releases exactly once', () => {
    vi.useFakeTimers();
    const service = createWorkbenchSubmissionService();
    const onTimeout = vi.fn();
    const finish = service.begin('session:a', onTimeout)!;
    expect(service.pending.value).toBe(true);
    expect(service.context.value).toBe('session:a');
    expect(service.begin('session:b')).toBeUndefined();
    expect(finish()).toBe(true);
    expect(finish()).toBe(false);
    expect(service.pending.value).toBe(false);
    expect(service.context.value).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('releases on timeout without allowing an old completion to release a newer request', () => {
    vi.useFakeTimers();
    const service = createWorkbenchSubmissionService();
    const onTimeout = vi.fn();
    const old = service.begin('session:a', onTimeout)!;
    vi.advanceTimersByTime(5000);
    expect(service.pending.value).toBe(false);
    expect(service.context.value).toBeUndefined();
    expect(onTimeout).toHaveBeenCalledOnce();
    const current = service.begin('session:b')!;
    expect(old()).toBe(false);
    expect(service.pending.value).toBe(true);
    expect(service.context.value).toBe('session:b');
    expect(current()).toBe(true);
    expect(onTimeout).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps an explicitly settlement-bound transaction exclusive without changing normal timeouts', () => {
    vi.useFakeTimers();
    const service = createWorkbenchSubmissionService();
    const finish = service.begin('session:history', undefined, null)!;
    vi.advanceTimersByTime(30_000);
    expect(service.begin('session:message')).toBeUndefined();
    expect(finish()).toBe(true);
    service.begin('session:message');
    vi.advanceTimersByTime(5_000);
    expect(service.pending.value).toBe(false);
  });
});
