import { describe, expect, it } from 'vitest';
import { createExecutionRoundPreparer } from '../../src/sdk/execution-round-preparation.js';

describe('execution round preparation', () => {
  it('rebuilds after late input and resource adoption without recollecting subagent updates', async () => {
    const calls: string[] = [];
    let attempt = 0;
    const prepare = createExecutionRoundPreparer<string, number, number>({
      prepareInputs: async (collect) => {
        calls.push(`inputs:${collect}`);
      },
      buildCandidate: async (continuation) => {
        calls.push(`candidate:${continuation}`);
        return ++attempt;
      },
      adoptLateInput: async () => {
        calls.push('late');
        return attempt === 1;
      },
      prepareResources: async (candidate) => {
        calls.push(`resources:${candidate}`);
        return candidate === 2 ? { retry: true } : { round: candidate };
      }
    });
    await expect(prepare('continuation')).resolves.toBe(3);
    expect(calls).toEqual([
      'inputs:true',
      'candidate:continuation',
      'late',
      'inputs:false',
      'candidate:continuation',
      'late',
      'resources:2',
      'inputs:false',
      'candidate:continuation',
      'late',
      'resources:3'
    ]);
  });
});
