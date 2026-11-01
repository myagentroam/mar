import { describe, expect, it } from 'vitest';
import { evaluateContextGcEconomics } from '../../src/runtime/context/gc-economics.js';

describe('context GC payback', () => {
  const base = {
    contextUsageTokens: 80_000,
    contextWindowTokens: 100_000,
    reclaimedTokens: 20_000,
    reclaimedCachedTokens: 20_000,
    cacheReadTokens: 60_000,
    preservedCachedPrefixTokens: 0
  };

  it.each([50_000, 70_000, 80_000, 84_999])(
    'requires the same five percent of the window at usage %i',
    (contextUsageTokens) => {
      const input = {
        ...base,
        contextUsageTokens,
        reclaimedCachedTokens: 0,
        cacheReadTokens: 0
      };
      expect(evaluateContextGcEconomics({ ...input, reclaimedTokens: 4_999 }).passes).toBe(false);
      expect(evaluateContextGcEconomics({ ...input, reclaimedTokens: 5_000 }).passes).toBe(true);
      expect(
        evaluateContextGcEconomics({
          ...input,
          reclaimedTokens: 5_000,
          reclaimedCachedTokens: 5_000,
          cacheReadTokens: 50_000
        }).passes
      ).toBe(false);
    }
  );

  it('rounds the five percent window threshold upward', () => {
    const input = {
      ...base,
      contextWindowTokens: 100_003,
      reclaimedCachedTokens: 0,
      cacheReadTokens: 0
    };
    expect(evaluateContextGcEconomics({ ...input, reclaimedTokens: 5_000 }).passes).toBe(false);
    expect(evaluateContextGcEconomics({ ...input, reclaimedTokens: 5_001 }).passes).toBe(true);
  });

  it.each([
    [50_000, 30, true],
    [50_000, 31, false],
    [60_000, 38, true],
    [60_000, 39, false],
    [70_000, 47, true],
    [70_000, 48, false],
    [80_000, 55, true],
    [80_000, 56, false],
    [84_999, 59, true],
    [84_999, 60, false],
    [84_999, 61, false],
    [85_000, 60, false]
  ])('uses the linear 30–60 window at usage %i for payback %i', (usage, n, passes) => {
    const result = evaluateContextGcEconomics({
      ...base,
      contextUsageTokens: usage,
      reclaimedTokens: 19_000,
      reclaimedCachedTokens: 19_000,
      cacheReadTokens: 19_000 + (Number(n) - 1) * 1_000
    });
    expect(result.requiredPositiveNetRollouts).toBe(n);
    expect(result.passes).toBe(passes);
  });

  it('uses normal input minus cache read and admits strictly positive net without forecast samples', () => {
    const result = evaluateContextGcEconomics({ ...base, cacheReadTokens: 80_000 });
    expect(result.cacheRebuildPenaltyCostUnits).toBe(57_000);
    expect(result.requiredPositiveNetRollouts).toBe(58);
    expect(result.passes).toBe(false);
    expect(evaluateContextGcEconomics({ ...base, contextUsageTokens: 84_000 }).passes).toBe(true);
  });

  it('uses the inclusive dynamic window and never invests at the async threshold', () => {
    const input = { ...base, cacheReadTokens: 40_000 };
    expect(evaluateContextGcEconomics(input).passes).toBe(true);
    expect(evaluateContextGcEconomics({ ...input, cacheReadTokens: 80_000 }).passes).toBe(false);
    expect(evaluateContextGcEconomics({ ...input, contextUsageTokens: 85_000 }).passes).toBe(false);
    expect(
      Number.isFinite(
        evaluateContextGcEconomics({ ...input, contextUsageTokens: 85_000 })
          .expectedNetSavedCostUnits
      )
    ).toBe(true);
    expect(
      evaluateContextGcEconomics({
        ...input,
        contextUsageTokens: 85_000,
        reclaimedTokens: 0,
        reclaimedCachedTokens: 0
      }).requiredPositiveNetRollouts
    ).toBeNull();
  });

  it('rejects exact zero at the window', () => {
    const input = {
      ...base,
      reclaimedTokens: 19_038,
      reclaimedCachedTokens: 19_038,
      cacheReadTokens: 49_098,
      contextUsageTokens: 50_000
    };
    const exactZero = evaluateContextGcEconomics(input);
    expect(exactZero).toMatchObject({
      requiredPositiveNetRollouts: 31,
      passes: false
    });
    expect(exactZero.expectedNetSavedCostUnits).toBeCloseTo(951.9);
  });

  it('keeps strict zero semantics for uncached savings', () => {
    const uncached = {
      ...base,
      reclaimedTokens: 19_000,
      reclaimedCachedTokens: 0,
      cacheReadTokens: 20_000
    };
    expect(evaluateContextGcEconomics(uncached).requiredPositiveNetRollouts).toBe(2);
    for (let a = 1_000; a <= 2_000; a++) {
      const result = evaluateContextGcEconomics({
        ...base,
        reclaimedTokens: 19 * a,
        reclaimedCachedTokens: 19 * a,
        cacheReadTokens: 39 * a
      });
      expect(result.requiredPositiveNetRollouts, `a=${a}`).toBe(21);
      expect(result.passes, `a=${a}`).toBe(true);
    }
  });

  it('does not truncate large payback counts near 85 percent', () => {
    const result = evaluateContextGcEconomics({
      ...base,
      contextUsageTokens: 84_999.99,
      reclaimedTokens: 1,
      reclaimedCachedTokens: 1,
      cacheReadTokens: 1_001
    });
    expect(result.requiredPositiveNetRollouts).toBe(19_001);
    expect(result.passes).toBe(false);
  });

  it.each([
    [50_000, 30],
    [67_500, 45],
    [80_000, 55],
    [84_000, 59]
  ])('accepts exactly the window at usage %i and rejects one more', (usage, n) => {
    const input = {
      ...base,
      contextUsageTokens: usage,
      reclaimedTokens: 5_000,
      reclaimedCachedTokens: 5_000,
      cacheReadTokens: 5_000 + ((n - 0.5) * 250) / 0.95
    };
    expect(evaluateContextGcEconomics(input)).toMatchObject({
      requiredPositiveNetRollouts: n,
      passes: true
    });
    expect(
      evaluateContextGcEconomics({
        ...input,
        cacheReadTokens: input.cacheReadTokens + 250 / 0.95
      })
    ).toMatchObject({ requiredPositiveNetRollouts: n + 1, passes: false });
  });
});
