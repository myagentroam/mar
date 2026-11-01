import { describe, expect, it } from 'vitest';
import {
  contextGcMinimumGrossReductionRate,
  evaluateContextGcEconomics
} from '../../src/runtime/context/gc-economics.js';

describe('context GC payback', () => {
  const base = {
    contextUsageTokens: 80_000,
    contextWindowTokens: 100_000,
    reclaimedTokens: 20_000,
    reclaimedCachedTokens: 20_000,
    cacheReadTokens: 60_000,
    preservedCachedPrefixTokens: 0,
    compactDeferralCreditCostUnits: 0,
    projectedRolloutsUntilCompactAfterGc: 0,
    contextGrowthSampleCount: 0
  };

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
      cacheReadTokens: 19_000 + (Number(n) - 1) * 1_000,
      minimumReclaimedTokens: 1
    });
    expect(result.requiredPositiveNetRollouts).toBe(n);
    expect(result.passes).toBe(passes);
  });

  it('does not use Compact credit to bypass the normal-only payback limit', () => {
    const input = {
      ...base,
      contextUsageTokens: 84_000,
      reclaimedTokens: 19_000,
      reclaimedCachedTokens: 19_000,
      cacheReadTokens: 85_000,
      minimumReclaimedTokens: 1
    };
    for (const credit of [0, 1e-15, 1_000_000]) {
      expect(
        evaluateContextGcEconomics({ ...input, compactDeferralCreditCostUnits: credit })
      ).toMatchObject({ requiredPositiveNetRollouts: 67, passes: false });
    }
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

  it('rejects exact zero at the window without applying even a small Compact credit', () => {
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
    for (const credit of [1e-9, 1e-15]) {
      const smallPositive = evaluateContextGcEconomics({
        ...input,
        compactDeferralCreditCostUnits: credit
      });
      expect(smallPositive.requiredPositiveNetRollouts).toBe(31);
      expect(smallPositive.expectedNetSavedCostUnits).toBeGreaterThan(0);
      expect(smallPositive.passes).toBe(false);
    }
  });

  it('keeps strict zero semantics for uncached savings regardless of Compact credit', () => {
    const uncached = {
      ...base,
      reclaimedTokens: 19_000,
      reclaimedCachedTokens: 0,
      cacheReadTokens: 20_000
    };
    expect(evaluateContextGcEconomics(uncached).requiredPositiveNetRollouts).toBe(2);
    expect(
      evaluateContextGcEconomics({ ...uncached, compactDeferralCreditCostUnits: 19_000 })
        .requiredPositiveNetRollouts
    ).toBe(2);
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
      cacheReadTokens: 1_001,
      minimumReclaimedTokens: 1
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
      reclaimedTokens: 1_000,
      reclaimedCachedTokens: 1_000,
      cacheReadTokens: 1_000 + ((n - 0.5) * 50) / 0.95,
      minimumReclaimedTokens: 1
    };
    expect(evaluateContextGcEconomics(input)).toMatchObject({
      requiredPositiveNetRollouts: n,
      passes: true
    });
    expect(
      evaluateContextGcEconomics({
        ...input,
        cacheReadTokens: input.cacheReadTokens + 50 / 0.95
      })
    ).toMatchObject({ requiredPositiveNetRollouts: n + 1, passes: false });
  });

  it('reaches ten percent at the async threshold', () => {
    expect(contextGcMinimumGrossReductionRate(0.7)).toBeCloseTo(0.2);
    expect(contextGcMinimumGrossReductionRate(0.8)).toBeCloseTo(2 / 15);
    expect(contextGcMinimumGrossReductionRate(0.85)).toBeCloseTo(0.1);
  });
});
