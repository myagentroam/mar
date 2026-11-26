import type { SessionCollaborationEdge } from '@myagentroam/protocol';

export interface GraphPoint {
  readonly x: number;
  readonly y: number;
}
export interface GraphSize {
  readonly width: number;
  readonly height: number;
}
export interface GraphCamera extends GraphPoint {
  readonly scale: number;
}
interface GraphEdge {
  readonly kind: 'parent' | 'sharing';
  readonly from: string;
  readonly to: string;
  readonly path: string;
}
export interface CollaborationGraph extends GraphSize {
  readonly nodes: ReadonlyMap<string, GraphPoint>;
  readonly edges: readonly GraphEdge[];
}

export const collaborationNodeSize = { width: 156, height: 46 };
export const MIN_COLLABORATION_SCALE = 0.8;
export const MAX_COLLABORATION_SCALE = 1.75;
const col = 180;
const row = 112;
const halfHeight = collaborationNodeSize.height / 2;
const halfWidth = collaborationNodeSize.width / 2;

/** Lays out formal parent links as a forest; temporary sharing edges never drive tree depth. */
export function buildCollaborationGraph(
  sessions: readonly { readonly id: string; readonly parentSessionId: string | null }[],
  sharing: readonly SessionCollaborationEdge[]
): CollaborationGraph {
  const ordered = [...new Map(sessions.map((session) => [session.id, session])).values()].sort(
    (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
  const byId = new Map(ordered.map((node) => [node.id, node]));
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const node of ordered) {
    const parent = node.parentSessionId;
    if (parent !== null && parent !== node.id && byId.has(parent)) {
      const list = children.get(parent) ?? [];
      list.push(node.id);
      children.set(parent, list);
    } else roots.push(node.id);
  }
  // Use the largest formal tree as the layout reference regardless of entry point.
  let root = ordered[0]?.id;
  let largest = 0;
  for (const id of roots) {
    const family = [id];
    for (let i = 0; i < family.length; i++) family.push(...(children.get(family[i]!) ?? []));
    if (family.length <= largest) continue;
    largest = family.length;
    root = id;
  }
  const nodes = new Map<string, GraphPoint>();
  const seen = new Set<string>();
  const formal: Array<{ from: string; to: string }> = [];
  let cursor = col / 2;
  function place(id: string, depth: number): number {
    seen.add(id);
    const xs = [];
    for (const child of children.get(id) ?? []) {
      if (seen.has(child)) continue;
      formal.push({ from: id, to: child });
      xs.push(place(child, depth + 1));
    }
    const x = xs.length ? (xs[0]! + xs.at(-1)!) / 2 : cursor;
    if (!xs.length) cursor += col;
    nodes.set(id, { x, y: row / 2 + row * depth });
    return x;
  }
  if (root !== undefined) place(root, 0);
  const reference = (root === undefined ? undefined : nodes.get(root)) ?? {
    x: col / 2,
    y: row / 2
  };
  // Close gaps above wide descendant rows without changing the left-to-right branch order.
  const layers = new Map<number, Array<[string, GraphPoint]>>();
  for (const entry of nodes) {
    const y = entry[1].y;
    const layer = layers.get(y) ?? [];
    layer.push(entry);
    layers.set(y, layer);
  }
  for (const layer of layers.values()) {
    layer.sort((a, b) => a[1].x - b[1].x);
    const center = layer.reduce(
      (nearest, entry, index) =>
        Math.abs(entry[1].x - reference.x) < Math.abs(layer[nearest]![1].x - reference.x)
          ? index
          : nearest,
      0
    );
    let x = layer[center]![1].x;
    for (let i = center - 1; i >= 0; i--) {
      const [id, point] = layer[i]!;
      x -= Math.min(col * 1.2, layer[i + 1]![1].x - point.x);
      nodes.set(id, { x, y: point.y });
    }
    x = layer[center]![1].x;
    for (let i = center + 1; i < layer.length; i++) {
      const [id, point] = layer[i]!;
      x += Math.min(col * 1.2, point.x - layer[i - 1]![1].x);
      nodes.set(id, { x, y: point.y });
    }
  }
  let isolated = 0;
  for (const id of roots) {
    if (seen.has(id)) continue;
    if (!children.has(id)) {
      const offset = isolated++;
      const y = reference.y + row * ((offset + 1) % 3);
      let x = reference.x + col;
      for (const node of [...nodes.values()]
        .filter((point) => point.y === y)
        .sort((a, b) => a.x - b.x)) {
        if (Math.abs(node.x - x) < col) x = node.x + col;
      }
      nodes.set(id, { x, y });
      cursor = Math.max(cursor, x + col);
      seen.add(id);
    }
  }
  for (const id of [...roots, ...byId.keys()]) if (!seen.has(id)) place(id, 0);

  const edges: GraphEdge[] = formal.map(({ from, to }) => {
    const a = nodes.get(from)!;
    const b = nodes.get(to)!;
    const high = a.y + halfHeight;
    const low = b.y - halfHeight - 2;
    const mid = (high + low) / 2;
    return {
      kind: 'parent',
      from,
      to,
      path: `M ${a.x} ${high} C ${a.x} ${mid}, ${b.x} ${mid}, ${b.x} ${low}`
    };
  });
  const unique = new Set<string>();
  const sharingKeys = new Set(
    sharing.map((edge) => JSON.stringify([edge.ownerSessionId, edge.followerSessionId]))
  );
  for (const { ownerSessionId: from, followerSessionId: to } of sharing) {
    const a = nodes.get(from);
    const b = nodes.get(to);
    const key = JSON.stringify([from, to]);
    if (!a || !b || from === to || unique.has(key)) continue;
    unique.add(key);
    const sameColumn = a.x === b.x;
    const reciprocal = sharingKeys.has(JSON.stringify([to, from]));
    const lane = from < to ? 1 : -1;
    const direction = sameColumn ? (reciprocal ? lane : 1) : b.x > a.x ? 1 : -1;
    const ax = a.x + direction * halfWidth;
    const bx = b.x - direction * halfWidth;
    // Same branch and same column use a side arc distinct from the formal arrow.
    const ex = sameColumn ? ax : bx;
    const bulge = sameColumn ? direction * 62 : (ex - ax) * 0.28;
    // Distinct lanes let either board be reached even when each session follows the other.
    const offset = reciprocal && !sameColumn ? lane * 12 : 0;
    edges.push({
      kind: 'sharing',
      from,
      to,
      path: `M ${ax} ${a.y + offset} C ${ax + bulge} ${a.y + offset}, ${ex + (sameColumn ? bulge : -bulge)} ${b.y + offset}, ${ex} ${b.y + offset}`
    });
  }
  return {
    width: Math.max(col, ...[...nodes.values()].map(({ x }) => x + col / 2 + 48)),
    height: Math.max(row, ...[...nodes.values()].map(({ y }) => y + row / 2)),
    nodes,
    edges
  };
}

export function boundCollaborationGraph(
  graph: GraphSize,
  port: GraphSize,
  camera: GraphCamera
): GraphCamera {
  return {
    scale: camera.scale,
    x: Math.min(port.width / 2, Math.max(port.width / 2 - graph.width * camera.scale, camera.x)),
    y: Math.min(port.height / 2, Math.max(port.height / 2 - graph.height * camera.scale, camera.y))
  };
}

export function focusCollaborationGraph(
  graph: CollaborationGraph,
  port: GraphSize,
  anchor?: string,
  scale?: number
): GraphCamera {
  const fitted =
    scale ??
    Math.max(
      MIN_COLLABORATION_SCALE,
      Math.min(1, (port.width - 24) / graph.width, (port.height - 24) / graph.height)
    );
  const center = (anchor === undefined ? undefined : graph.nodes.get(anchor)) ?? {
    x: graph.width / 2,
    y: graph.height / 2
  };
  return {
    scale: fitted,
    x: port.width / 2 - center.x * fitted,
    y: port.height / 2 - center.y * fitted
  };
}

export function zoomCollaborationGraph(
  graph: GraphSize,
  port: GraphSize,
  camera: GraphCamera,
  origin: GraphPoint,
  factor: number
): GraphCamera {
  const scale = Math.min(
    MAX_COLLABORATION_SCALE,
    Math.max(MIN_COLLABORATION_SCALE, camera.scale * factor)
  );
  const ratio = scale / camera.scale;
  return boundCollaborationGraph(graph, port, {
    scale,
    x: origin.x - (origin.x - camera.x) * ratio,
    y: origin.y - (origin.y - camera.y) * ratio
  });
}
