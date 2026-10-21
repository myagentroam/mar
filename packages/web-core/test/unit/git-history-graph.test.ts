import { describe, expect, it } from 'vitest';
import {
  buildGitHistoryGraph,
  gitGraphNodeX,
  gitGraphWidth
} from '../../src/util/git-history-graph.js';

describe('Git history graph', () => {
  it('keeps a linear history on one lane', () => {
    const rows = buildGitHistoryGraph([
      { hash: 'c', parents: ['b'] },
      { hash: 'b', parents: ['a'] },
      { hash: 'a', parents: [] }
    ]);

    expect(rows.map((row) => [row.lane, row.laneCount])).toEqual([
      [0, 1],
      [0, 1],
      [0, 1]
    ]);
    expect(rows.map((row) => row.outgoingLaneCount)).toEqual([1, 1, 0]);
    expect(rows[1]?.edges).toHaveLength(2);
    expect(gitGraphNodeX(rows[0]!)).toBe(7);
    expect(gitGraphWidth(rows[0]!)).toBe(14);
  });

  it('opens a second lane for a merge parent and closes it at the shared ancestor', () => {
    const rows = buildGitHistoryGraph([
      { hash: 'merge', parents: ['main', 'feature'] },
      { hash: 'main', parents: ['base'] },
      { hash: 'feature', parents: ['base'] },
      { hash: 'base', parents: [] }
    ]);

    expect(rows.map((row) => [row.lane, row.laneCount])).toEqual([
      [0, 2],
      [0, 2],
      [1, 2],
      [0, 1]
    ]);
    expect(rows.map((row) => row.outgoingLaneCount)).toEqual([2, 2, 1, 0]);
    expect(rows[0]?.edges).toHaveLength(2);
    expect(rows[2]?.edges.some((edge) => edge.path.includes('C'))).toBe(true);
  });

  it('shows disconnected selected branch tips without inventing an incoming edge', () => {
    const rows = buildGitHistoryGraph([
      { hash: 'left', parents: ['left-base'] },
      { hash: 'right', parents: ['right-base'] }
    ]);

    expect(rows[1]?.lane).toBe(0);
    expect(rows[1]?.laneCount).toBe(2);
    expect(rows[1]?.edges).toHaveLength(2);
  });
});
