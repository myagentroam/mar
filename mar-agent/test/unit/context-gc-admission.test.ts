import { describe, expect, it } from 'vitest';
import {
  contextGcEligibleUsage,
  contextGcMinimumReclaimedTokens
} from '../../src/runtime/context/gc-admission.js';

describe('context GC capacity admission', () => {
  it.each([
    [49_999, undefined],
    [50_000, 50_000],
    [84_999, 84_999],
    [85_000, undefined]
  ])('uses the selected input window for usage %i', (contextInputTokens, expected) => {
    expect(contextGcEligibleUsage({ contextInputTokens, inputTokens: 90_000 }, 100_000)).toBe(
      expected
    );
  });

  it('uses inputTokens only when provider context usage is absent', () => {
    expect(contextGcEligibleUsage({ inputTokens: 60_000 }, 100_000)).toBe(60_000);
    expect(
      contextGcEligibleUsage({ contextInputTokens: 0, inputTokens: 60_000 }, 100_000)
    ).toBeUndefined();
    expect(contextGcEligibleUsage({ inputTokens: 60_000 }, 0)).toBeUndefined();
  });

  it.each([
    [100_000, 10_001],
    [272_000, 27_201],
    [101, 11]
  ])('requires strictly more than ten percent of a %i token window', (window, minimum) =>
    expect(contextGcMinimumReclaimedTokens(window)).toBe(minimum)
  );
});
