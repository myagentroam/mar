import { describe, expect, it } from 'vitest';
import {
  buildGitHistoryGraph,
  gitGraphNodeX,
  gitGraphWidth
} from '../../src/util/git-history-graph.js';
import type { GitGraphCommit, GitGraphRow } from '../../src/util/git-history-graph.js';

// Explicit frontiers identify the commit carried by each boundary endpoint.
function expectConnectedFrontiers(
  commits: readonly GitGraphCommit[],
  rows: readonly GitGraphRow[],
  frontiers: readonly (readonly string[])[]
): void {
  expect(frontiers).toHaveLength(commits.length + 1);
  for (const [index, commit] of commits.entries()) {
    const row = rows[index]!;
    const before = frontiers[index]!;
    const after = frontiers[index + 1]!;
    const node = [gitGraphNodeX(row), 19];
    const x = (lane: number) => lane * 14 + 7;
    const expected = before.map((hash, lane) => ({
      start: [x(lane), 0],
      end: hash === commit.hash ? node : [x(after.indexOf(hash)), 38]
    }));
    for (const parent of new Set(commit.parents)) {
      expect(after).toContain(parent);
      expected.push({ start: node, end: [x(after.indexOf(parent)), 38] });
    }
    const actual = row.edges.map((edge) => {
      const points = edge.path.match(/-?\d+(?:\.\d+)?/gu)!.map(Number);
      return { start: points.slice(0, 2), end: points.slice(-2) };
    });
    expect(actual, `edges for ${commit.hash}`).toEqual(expect.arrayContaining(expected));
    expect(actual).toHaveLength(expected.length);
    expect(row.outgoingLaneCount).toBe(after.length);

    const next = rows[index + 1];
    if (!next) continue;
    for (const [lane, hash] of after.entries()) {
      const end = actual.find((edge) => edge.end[0] === x(lane) && edge.end[1] === 38);
      expect(end, `outgoing ${hash} at ${commit.hash}`).toBeDefined();
      expect(
        next.edges.some((edge) => edge.path.startsWith(`M ${x(lane)} 0 `)),
        `incoming ${hash} after ${commit.hash}`
      ).toBe(true);
    }
  }
}

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
    expectConnectedFrontiers(
      [
        { hash: 'merge', parents: ['main', 'feature'] },
        { hash: 'main', parents: ['base'] },
        { hash: 'feature', parents: ['base'] },
        { hash: 'base', parents: [] }
      ],
      rows,
      [[], ['main', 'feature'], ['base', 'feature'], ['base'], []]
    );
  });

  it('shows disconnected selected branch tips without inventing an incoming edge', () => {
    const rows = buildGitHistoryGraph([
      { hash: 'left', parents: ['left-base'] },
      { hash: 'right', parents: ['right-base'] }
    ]);

    expect(rows[1]?.lane).toBe(1);
    expect(rows[1]?.laneCount).toBe(2);
    expect(rows[1]?.edges).toHaveLength(2);
    expect(rows[1]?.edges.some((edge) => edge.path.startsWith('M 21 0 '))).toBe(false);
  });

  it.each([
    {
      name: 'two branch tips sharing a base',
      commits: [
        { hash: 'left', parents: ['base'] },
        { hash: 'right', parents: ['base'] },
        { hash: 'base', parents: [] }
      ],
      frontiers: [[], ['base'], ['base'], []]
    },
    {
      name: 'multiple independent heads and ancestors',
      commits: [
        { hash: 'left', parents: ['left-base'] },
        { hash: 'middle', parents: ['middle-base'] },
        { hash: 'right', parents: ['right-base'] },
        { hash: 'left-base', parents: [] },
        { hash: 'middle-base', parents: [] },
        { hash: 'right-base', parents: [] }
      ],
      frontiers: [
        [],
        ['left-base'],
        ['left-base', 'middle-base'],
        ['left-base', 'middle-base', 'right-base'],
        ['middle-base', 'right-base'],
        ['right-base'],
        []
      ]
    },
    {
      name: 'several branch tips joining the same ancestor',
      commits: [
        { hash: 'left', parents: ['base'] },
        { hash: 'middle', parents: ['base'] },
        { hash: 'right', parents: ['base'] },
        { hash: 'base', parents: [] }
      ],
      frontiers: [[], ['base'], ['base'], ['base'], []]
    },
    {
      name: 'nested and octopus merges with an additional selected head',
      commits: [
        { hash: 'merge', parents: ['main', 'feature', 'third'] },
        { hash: 'selected', parents: ['base'] },
        { hash: 'feature', parents: ['main', 'base'] },
        { hash: 'main', parents: ['base'] },
        { hash: 'third', parents: ['base'] },
        { hash: 'base', parents: [] }
      ],
      frontiers: [
        [],
        ['main', 'feature', 'third'],
        ['main', 'feature', 'third', 'base'],
        ['main', 'base', 'third'],
        ['base', 'third'],
        ['base'],
        []
      ]
    }
  ])('connects every boundary for $name', ({ commits, frontiers }) => {
    expectConnectedFrontiers(commits, buildGitHistoryGraph(commits), frontiers);
  });

  it('preserves the rendered prefix and pending edges when another page is appended', () => {
    const commits = [
      { hash: 'merge', parents: ['left', 'right'] },
      { hash: 'left', parents: ['base'] },
      { hash: 'selected', parents: ['base'] },
      { hash: 'right', parents: ['base'] },
      { hash: 'base', parents: [] }
    ];
    const frontiers = [[], ['left', 'right'], ['base', 'right'], ['base', 'right'], ['base'], []];
    const rows = buildGitHistoryGraph(commits);
    for (let pageEnd = 1; pageEnd < commits.length; pageEnd += 1) {
      expect(buildGitHistoryGraph(commits.slice(0, pageEnd))).toEqual(rows.slice(0, pageEnd));
    }
    expectConnectedFrontiers(commits, rows, frontiers);
  });
});
