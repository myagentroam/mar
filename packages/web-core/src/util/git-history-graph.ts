export interface GitGraphCommit {
  readonly hash: string;
  readonly parents: readonly string[];
}

export interface GitGraphEdge {
  readonly path: string;
  readonly color: number;
}

export interface GitGraphRow {
  readonly lane: number;
  readonly laneCount: number;
  readonly outgoingLaneCount: number;
  readonly edges: readonly GitGraphEdge[];
}

const LANE_WIDTH = 14;
const NODE_Y = 19;
const ROW_HEIGHT = 38;

function laneX(lane: number): number {
  return lane * LANE_WIDTH + LANE_WIDTH / 2;
}

function curvedPath(fromLane: number, fromY: number, toLane: number, toY: number): string {
  const fromX = laneX(fromLane);
  const toX = laneX(toLane);
  const middleY = (fromY + toY) / 2;
  return `M ${fromX} ${fromY} C ${fromX} ${middleY}, ${toX} ${middleY}, ${toX} ${toY}`;
}

function unique(values: readonly string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

export function buildGitHistoryGraph(commits: readonly GitGraphCommit[]): readonly GitGraphRow[] {
  let lanes: string[] = [];
  return commits.map((commit) => {
    let commitLane = lanes.indexOf(commit.hash);
    const hasIncomingEdge = commitLane >= 0;
    if (!hasIncomingEdge) {
      // New tips have no incoming edge and must not shift the existing frontier.
      commitLane = lanes.length;
      lanes = [...lanes, commit.hash];
    }

    const before = [...lanes];
    const after = [...before];
    after.splice(commitLane, 1, ...unique(commit.parents));
    const deduplicatedAfter = unique(after);
    const edges: GitGraphEdge[] = [];

    for (const [lane, hash] of before.entries()) {
      if (lane === commitLane) continue;
      const targetLane = deduplicatedAfter.indexOf(hash);
      if (targetLane >= 0)
        edges.push({
          path: curvedPath(lane, 0, targetLane, ROW_HEIGHT),
          color: lane
        });
    }

    if (hasIncomingEdge) {
      edges.push({
        path: `M ${laneX(commitLane)} 0 L ${laneX(commitLane)} ${NODE_Y}`,
        color: commitLane
      });
    }
    for (const parent of unique(commit.parents)) {
      const targetLane = deduplicatedAfter.indexOf(parent);
      if (targetLane >= 0)
        edges.push({
          path: curvedPath(commitLane, NODE_Y, targetLane, ROW_HEIGHT),
          color: targetLane
        });
    }

    const laneCount = Math.max(before.length, deduplicatedAfter.length, 1);
    lanes = deduplicatedAfter;
    return { lane: commitLane, laneCount, outgoingLaneCount: lanes.length, edges };
  });
}

export function gitGraphWidth(row: GitGraphRow): number {
  return row.laneCount * LANE_WIDTH;
}

export function gitGraphNodeX(row: GitGraphRow): number {
  return laneX(row.lane);
}
