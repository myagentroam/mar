import { expect, it } from 'vitest';
import {
  buildCollaborationGraph,
  focusCollaborationGraph,
  zoomCollaborationGraph
} from '../../src/util/collaboration-graph.js';

it('keeps parent and board edges distinct in a bounded mixed graph', () => {
  const nodes = [
    { id: 'root', parentSessionId: null },
    { id: 'current', parentSessionId: 'root' },
    { id: 'peer', parentSessionId: 'hidden' },
    ...Array.from({ length: 80 }, (_, i) => ({
      id: `child-${i}`,
      parentSessionId: i < 8 ? 'current' : `child-${Math.floor((i - 8) / 8)}`
    }))
  ];
  const graph = buildCollaborationGraph(nodes, [
    { ownerSessionId: 'current', followerSessionId: 'child-0' },
    { ownerSessionId: 'current', followerSessionId: 'peer' },
    { ownerSessionId: 'unknown', followerSessionId: 'peer' }
  ]);
  expect(graph.nodes.size).toBe(83);
  expect(new Set(Array.from(graph.nodes.values(), ({ x, y }) => `${x}:${y}`)).size).toBe(83);
  expect(
    graph.edges.filter((edge) => edge.from === 'current' && edge.to === 'child-0')
  ).toMatchObject([{ kind: 'parent' }, { kind: 'sharing' }]);
  expect(graph.edges).not.toContainEqual(expect.objectContaining({ from: 'hidden' }));
  expect(graph.edges).not.toContainEqual(expect.objectContaining({ from: 'unknown' }));

  const size = { width: 360, height: 320 };
  const camera = focusCollaborationGraph(graph, size, 'current');
  const current = graph.nodes.get('current')!;
  expect(camera.scale).toBeLessThan(0.8);
  expect(camera.scale).toBeGreaterThanOrEqual(0.1);
  expect(camera.x + current.x * camera.scale).toBeCloseTo(180);
  expect(camera.y + current.y * camera.scale).toBeCloseTo(160);
  const cursor = { x: 130, y: 190 };
  const zoomed = zoomCollaborationGraph(graph, size, camera, cursor, 1.15);
  expect((cursor.x - camera.x) / camera.scale).toBeCloseTo((cursor.x - zoomed.x) / zoomed.scale);
  expect((cursor.y - camera.y) / camera.scale).toBeCloseTo((cursor.y - zoomed.y) / zoomed.scale);
});

it('bounds zoom to 10–100% and follows a moving pinch center', () => {
  const graph = buildCollaborationGraph([{ id: 'root', parentSessionId: null }], []);
  const port = { width: 600, height: 500 };
  const camera = focusCollaborationGraph(graph, port);
  const origin = { x: 310, y: 260 };
  const destination = { x: 330, y: 275 };
  expect(camera.scale).toBe(1);
  expect(zoomCollaborationGraph(graph, port, camera, origin, 8).scale).toBe(1);
  expect(zoomCollaborationGraph(graph, port, camera, origin, 0.01).scale).toBe(0.1);
  expect(focusCollaborationGraph(graph, { width: 25, height: 25 }).scale).toBe(0.1);
  const pinched = zoomCollaborationGraph(graph, port, camera, origin, 0.75, destination);
  expect((destination.x - pinched.x) / pinched.scale).toBeCloseTo(origin.x - camera.x);
  expect((destination.y - pinched.y) / pinched.scale).toBeCloseTo(origin.y - camera.y);
});

it.each([null, 'a'])(
  'routes two active boards between the same pair into separate lanes (parent %s)',
  (parentSessionId) => {
    const graph = buildCollaborationGraph(
      [
        { id: 'a', parentSessionId: null },
        { id: 'b', parentSessionId }
      ],
      [
        { ownerSessionId: 'a', followerSessionId: 'b' },
        { ownerSessionId: 'b', followerSessionId: 'a' }
      ]
    );
    const points = graph.edges
      .filter(({ kind }) => kind === 'sharing')
      .map(({ path }) => path.match(/-?\d+(?:\.\d+)?/g)!.map(Number));
    const forward = points[0]!;
    const reverse = points[1]!;
    // Compare opposing endpoints geometrically; reversed path strings alone are not distinct lanes.
    expect(Math.hypot(forward[0]! - reverse[6]!, forward[1]! - reverse[7]!)).toBeGreaterThan(14);
  }
);
