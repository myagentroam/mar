import { describe, expect, it } from 'vitest';
import { ResponseLatencyTracker } from '../../src/service/response-latency-tracker.js';

describe('Observed response latency', () => {
  it('measures once, preserves zero, and resumes after the last parallel tool result', () => {
    let now = 100;
    const tracker = new ResponseLatencyTracker(() => now);
    now = 180;
    expect(tracker.response()).toBe(80);
    expect(tracker.response()).toBeUndefined();
    tracker.toolStarted('a');
    tracker.toolStarted('b');
    now = 10_000;
    tracker.toolCompleted('a');
    expect(tracker.response()).toBeUndefined();
    now = 20_000;
    tracker.toolCompleted('b');
    now = 20_050;
    tracker.toolCompleted('b');
    expect(tracker.toolStarted('a')).toBeUndefined();
    expect(tracker.response()).toBe(50);
    tracker.toolStarted('c');
    tracker.toolCompleted('c');
    expect(tracker.response()).toBe(0);
  });

  it('treats a newly generated tool call as a response, not tool execution output', () => {
    let now = 0;
    const tracker = new ResponseLatencyTracker(() => now);
    now = 50;
    expect(tracker.toolStarted('a')).toBe(50);
    expect(tracker.toolStarted('a')).toBeUndefined();
    now = 50_000;
    expect(tracker.response()).toBeUndefined();
    tracker.toolCompleted('a');
    now = 50_090;
    expect(tracker.toolStarted('b')).toBe(90);
    expect(tracker.hasObservedResponse).toBe(true);
  });

  it('does not treat a repeated response snapshot as a new model response after tools', () => {
    let now = 0;
    const tracker = new ResponseLatencyTracker(() => now);
    now = 20;
    expect(tracker.response('message')).toBe(20);
    tracker.toolStarted('tool');
    now = 1_000;
    tracker.toolCompleted('tool');
    now = 1_050;
    expect(tracker.response('message')).toBeUndefined();
    expect(tracker.response('next-message')).toBe(50);
    tracker.toolStarted('next-tool');
    now = 2_000;
    tracker.toolCompleted('next-tool');
    now = 2_080;
    expect(tracker.response('next-message', true)).toBe(80);
  });
});
