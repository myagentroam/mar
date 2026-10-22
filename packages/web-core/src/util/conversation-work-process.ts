import type { AgentRun, ConversationTurn } from '../model/workbench.js';
import { conversationPayload } from './conversation-history.js';
import { isTerminalRunStatus } from '../service/RunService.js';
import {
  conversationDisplayItems,
  type ConversationDisplayItem
} from './conversation-presentation.js';

export interface ConversationProcessBlock {
  readonly id: string;
  readonly entries: {
    readonly turn: ConversationTurn;
    readonly displayItem: ConversationDisplayItem;
  }[];
  readonly groupId?: string;
  readonly runId?: string | null;
  partial: boolean;
  sealed: boolean;
  active: boolean;
  warning: boolean;
  readonly footerTurnId?: string;
}

/** Consume authoritative membership; never infer a group from text, time, or Item type. */
export function conversationWorkProcessBlocks(
  turns: readonly ConversationTurn[],
  runs: readonly Pick<AgentRun, 'id' | 'status'>[] = [],
  footerTurnIds: ReadonlySet<string> = new Set()
): ConversationProcessBlock[] {
  const blocks: ConversationProcessBlock[] = [];
  const groups = new Map<string, ConversationProcessBlock>();
  const open = new Map<string, ConversationProcessBlock>();
  const activeRuns = new Set(
    runs.filter((run) => !isTerminalRunStatus(run.status)).map((run) => run.id)
  );
  const activeMembers = new Set<string>();
  for (const turn of turns) {
    for (const item of turn.items) {
      const displayItem = conversationDisplayItems([item])[0];
      if (displayItem === undefined) continue;
      const entry = { turn, displayItem };
      if (item.processGroup !== undefined) {
        const key = `${turn.sessionId}:${item.processGroup.id}`;
        let group = groups.get(key);
        if (group === undefined) {
          const previous = open.get(turn.sessionId);
          if (previous !== undefined) previous.sealed = true;
          group = {
            id: key,
            groupId: item.processGroup.id,
            runId: turn.runId,
            entries: [],
            partial: true,
            sealed: false,
            active: false,
            warning: false
          };
          groups.set(key, group);
          blocks.push(group);
          open.set(turn.sessionId, group);
        }
        group.entries.push(entry);
        if (item.processGroup.isStart) group.partial = false;
        if (['PENDING', 'IN_PROGRESS'].includes(item.status)) activeMembers.add(key);
        if (
          ['FAILED', 'DECLINED', 'CANCELLED', 'INTERRUPTED'].includes(item.status) ||
          ['warning', 'error'].includes(item.kind)
        )
          group.warning = true;
      } else {
        const payload = conversationPayload(item.payload);
        const boundary =
          [
            'user_message',
            'approval_request',
            'user_input_request',
            'plan',
            'error',
            'turn_summary'
          ].includes(item.kind) ||
          (item.kind === 'assistant_message' &&
            typeof payload?.text === 'string' &&
            !!payload.text.trim()) ||
          (item.kind === 'context_compaction' && payload?.mode !== 'BACKGROUND');
        if (boundary) {
          const previous = open.get(turn.sessionId);
          if (previous !== undefined) previous.sealed = true;
          open.delete(turn.sessionId);
        }
        blocks.push({
          id: `${turn.sessionId}:${item.id}`,
          entries: [entry],
          partial: false,
          sealed: true,
          active: false,
          warning: false
        });
      }
    }
    if (footerTurnIds.has(turn.id))
      blocks.push({
        id: `duration:${turn.id}`,
        footerTurnId: turn.id,
        entries: [],
        partial: false,
        sealed: true,
        active: false,
        warning: false
      });
  }
  for (const group of groups.values())
    group.active =
      group.runId != null &&
      activeRuns.has(group.runId) &&
      (!group.sealed || activeMembers.has(group.id));
  return blocks;
}
