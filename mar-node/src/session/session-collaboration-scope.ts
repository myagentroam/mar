import type { SessionCollaborationEdge } from '@myagentroam/protocol';
import type { NodeDatabase } from '../database.js';

type Session = ReturnType<NodeDatabase['listSessionRecords']>[number];
const maxPeers = 32;
const maxSharing = 134;

/** Selects a bounded connected network without traversing unrelated Workspace sessions. */
export function collectSessionCollaborationScope(input: {
  anchor: Session;
  limit: number;
  get: (id: string) => Session | undefined;
  children: (id: string, limit: number) => readonly Session[];
  sharing: readonly SessionCollaborationEdge[];
}) {
  const { anchor, limit, get, children } = input;
  const parent = anchor.metadata.parentSessionId ? get(anchor.metadata.parentSessionId) : undefined;
  const capacity = 1 + limit + maxPeers + (parent ? 1 : 0);
  const compareId = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
  const sharing = [
    ...new Map(
      input.sharing
        .filter(({ ownerSessionId, followerSessionId }) => ownerSessionId !== followerSessionId)
        .map((edge) => [JSON.stringify([edge.ownerSessionId, edge.followerSessionId]), edge])
    ).values()
  ].sort(
    (left, right) =>
      compareId(left.ownerSessionId, right.ownerSessionId) ||
      compareId(left.followerSessionId, right.followerSessionId)
  );
  const sharedNeighbors = new Map<string, Map<string, SessionCollaborationEdge>>();
  function link(from: string, to: string, edge: SessionCollaborationEdge) {
    const adjacent = sharedNeighbors.get(from) ?? new Map<string, SessionCollaborationEdge>();
    if (!adjacent.has(to)) adjacent.set(to, edge);
    sharedNeighbors.set(from, adjacent);
  }
  for (const edge of sharing) {
    link(edge.ownerSessionId, edge.followerSessionId, edge);
    link(edge.followerSessionId, edge.ownerSessionId, edge);
  }

  const visited = new Set([anchor.id]);
  const queue = [anchor];
  const connecting = new Set<SessionCollaborationEdge>();
  let truncated = false;
  function add(record: Session | undefined, via?: SessionCollaborationEdge) {
    if (!record || visited.has(record.id)) return;
    if (queue.length >= capacity) {
      truncated = true;
      return;
    }
    visited.add(record.id);
    queue.push(record);
    if (via) connecting.add(via);
  }
  for (let index = 0; index < queue.length && !truncated; index++) {
    const record = queue[index]!;
    if (record.metadata.parentSessionId) add(get(record.metadata.parentSessionId));
    // One extra child is sufficient to detect overflow even if every admitted node is its child.
    for (const child of children(record.id, capacity + 1)) {
      add(child);
      if (truncated) break;
    }
    if (truncated) break;
    for (const [id, edge] of sharedNeighbors.get(record.id) ?? []) {
      if (!visited.has(id)) add(get(id), edge);
      if (truncated) break;
    }
  }

  const network = queue.slice(1).filter(({ id }) => id !== parent?.id);
  const edges = sharing.filter(
    ({ ownerSessionId, followerSessionId }) =>
      visited.has(ownerSessionId) && visited.has(followerSessionId)
  );
  const edgeOverflow = edges.length > maxSharing;
  return {
    parent,
    nodes: network.slice(0, limit),
    peers: network.slice(limit),
    // Preserve the links that brought peer nodes into the network if edges reach their own cap.
    sharing: edgeOverflow
      ? [...connecting, ...edges.filter((edge) => !connecting.has(edge))].slice(0, maxSharing)
      : edges,
    truncated: truncated || edgeOverflow
  };
}
