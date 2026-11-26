import { AgentError } from '@myagentroam/agent';
import type { DatabaseSync } from 'node:sqlite';

interface WhiteboardEntry {
  readonly id: string;
  readonly revision: number;
  readonly content: string;
}

export interface WhiteboardChange {
  readonly boardRevision: number;
  readonly actorSessionId: string;
  readonly at: number;
  readonly summary: string;
}

export interface WhiteboardSnapshot {
  readonly boardId: string;
  readonly boardRevision: number;
  readonly entries: readonly WhiteboardEntry[];
}

interface StoredWhiteboard extends WhiteboardSnapshot {
  readonly nextEntry: number;
  readonly recentChanges: readonly WhiteboardChange[];
}

export type WhiteboardOperation =
  | { readonly op: 'add'; readonly content: string }
  | {
      readonly op: 'update';
      readonly id: string;
      readonly expectedRevision: number;
      readonly content: string;
    }
  | { readonly op: 'del'; readonly id: string; readonly expectedRevision: number }
  | { readonly op: 'clear'; readonly expectedBoardRevision: number };

export interface WhiteboardUpdate {
  readonly expectedBoardId: string;
  readonly ops: readonly WhiteboardOperation[];
}

/** Sole writer of whiteboard entries, versions, and the bounded commit log. */
export class WhiteboardStore {
  constructor(private readonly database: DatabaseSync) {}

  private load(ownerSessionId: string): StoredWhiteboard {
    const row = this.database
      .prepare(
        'SELECT revision,next_entry,entries,recent_changes FROM whiteboards WHERE owner_session_id=?'
      )
      .get(ownerSessionId) as
      { revision: number; next_entry: number; entries: string; recent_changes: string } | undefined;
    return {
      boardId: ownerSessionId,
      boardRevision: row?.revision ?? 0,
      nextEntry: row?.next_entry ?? 1,
      entries: row ? (JSON.parse(row.entries) as WhiteboardEntry[]) : [],
      recentChanges: row ? (JSON.parse(row.recent_changes) as WhiteboardChange[]) : []
    };
  }

  read(
    ownerSessionId: string
  ): WhiteboardSnapshot & { recentChanges: readonly WhiteboardChange[] } {
    const { boardId, boardRevision, entries, recentChanges } = this.load(ownerSessionId);
    return { boardId, boardRevision, entries, recentChanges };
  }

  update(ownerSessionId: string, actorSessionId: string, input: WhiteboardUpdate) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const board = this.load(ownerSessionId);
      if (input.expectedBoardId !== board.boardId) {
        throw new AgentError(
          'WHITEBOARD_CONFLICT',
          'The current whiteboard is not the one you expected.',
          { details: { boardId: board.boardId } }
        );
      }
      const entries = [...board.entries];
      const added = new Set<string>();
      const counts = { add: 0, update: 0, del: 0, clear: 0 };
      let nextEntry = board.nextEntry;
      for (const [opIndex, op] of input.ops.entries()) {
        if (op.op === 'add') {
          const id = `w${nextEntry++}`;
          entries.push({ id, revision: 1, content: op.content });
          added.add(id);
        } else if (op.op === 'clear') {
          if (op.expectedBoardRevision !== board.boardRevision) {
            throw new AgentError(
              'WHITEBOARD_CONFLICT',
              'The whiteboard changed. Read it before clearing it.',
              { details: { opIndex, boardRevision: board.boardRevision } }
            );
          }
          if (!entries.length) continue;
          entries.length = 0;
        } else {
          const index = entries.findIndex(({ id }) => id === op.id);
          const entry = entries[index];
          if (!entry || entry.revision !== op.expectedRevision) {
            throw new AgentError(
              'WHITEBOARD_CONFLICT',
              'The entry changed or is no longer on the board.',
              { details: { opIndex, id: op.id, revision: entry?.revision ?? null } }
            );
          }
          if (op.op === 'del') entries.splice(index, 1);
          else {
            if (entry.content === op.content) continue;
            entries[index] = { ...entry, revision: entry.revision + 1, content: op.content };
          }
        }
        counts[op.op]++;
      }
      const sizes = entries.map(({ content }) => Buffer.byteLength(content));
      const limit =
        entries.length > 32
          ? 'entries'
          : sizes.some((size) => size > 1024)
            ? 'entryBytes'
            : sizes.reduce((sum, size) => sum + size, 0) > 8192
              ? 'boardBytes'
              : undefined;
      if (limit)
        throw new AgentError('WHITEBOARD_LIMIT', 'The whiteboard exceeds its size limit.', {
          details: { limit }
        });
      const changed =
        entries.length !== board.entries.length ||
        entries.some((entry, i) => entry !== board.entries[i]);
      const boardRevision = board.boardRevision + Number(changed);
      if (changed) {
        const summary = Object.entries(counts)
          .filter(([, count]) => count !== 0)
          .map(([op, count]) => `${op}: ${count}`)
          .join(', ');
        const log = [
          { boardRevision, actorSessionId, at: Date.now(), summary },
          ...board.recentChanges
        ].slice(0, 10);
        this.database
          .prepare(
            `INSERT INTO whiteboards (owner_session_id,revision,next_entry,entries,recent_changes)
          VALUES (?,?,?,?,?) ON CONFLICT(owner_session_id) DO UPDATE SET revision=excluded.revision,
          next_entry=excluded.next_entry,entries=excluded.entries,recent_changes=excluded.recent_changes`
          )
          .run(
            ownerSessionId,
            boardRevision,
            nextEntry,
            JSON.stringify(entries),
            JSON.stringify(log)
          );
      }
      this.database.exec('COMMIT');
      return {
        boardId: board.boardId,
        boardRevision,
        changed,
        added: entries
          .filter(({ id }) => added.has(id))
          .map(({ id, revision }) => ({ id, revision }))
      };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}
