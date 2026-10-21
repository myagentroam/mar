import { describe, expect, it } from 'vitest';
import { GenerationTimingTracker } from '../../src/service/generation-timing-tracker.js';

describe('GenerationTimingTracker', () => {
  it('counts only observed generation intervals and does not resume after tool completion', () => {
    let now = 0;
    const tracker = new GenerationTimingTracker(() => now);

    tracker.start('request-1');
    now = 100;
    tracker.pause('request-1');
    now = 10_000;
    expect(tracker.settle('request-1', 50)).toEqual({
      outputTokens: 50,
      durationMs: 100,
      tokensPerSecond: 500
    });

    tracker.start('request-2');
    now = 10_100;
    tracker.pause('request-2');
    now = 20_000;
    tracker.start('request-2');
    now = 20_100;
    tracker.end('request-2');
    expect(tracker.settle('request-2', 50)?.durationMs).toBe(200);
    expect(tracker.settle('request-2', 50)).toBeUndefined();
  });

  it('ends the interval before late usage arrives and rejects missing or zero duration facts', () => {
    let now = 0;
    const tracker = new GenerationTimingTracker(() => now);

    tracker.start('late');
    now = 250;
    tracker.end('late');
    now = 100_000;
    expect(tracker.settle('late', 25)).toEqual({
      outputTokens: 25,
      durationMs: 250,
      tokensPerSecond: 100
    });

    tracker.start('empty');
    expect(tracker.settle('empty', 1)).toBeUndefined();
    tracker.start('invalid');
    now = 101_000;
    expect(tracker.settle('invalid', Number.NaN)).toBeUndefined();
  });

  it('invalidates the whole request when the monotonic clock goes backwards', () => {
    let now = 100;
    const tracker = new GenerationTimingTracker(() => now);

    tracker.start('backwards');
    now = 90;
    tracker.pause('backwards');
    now = 200;

    expect(tracker.settle('backwards', 10)).toBeUndefined();
  });
});
