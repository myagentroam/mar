import type { AgentRun, ConversationItem, ConversationTurn } from '../model/workbench.js';
import { translate } from '../service/locale-preference-service.js';
import { toolPresentation } from './tool-presentation.js';
import {
  CONVERSATION_INITIAL_RENDER_CHARACTERS,
  conversationPayload
} from './conversation-history.js';
import { isTerminalRunStatus } from '../service/run-service.js';
import { selectReasoningPreview, type ReasoningPreview } from './conversation-reasoning.js';
import {
  aggregateConversationDisplayItems,
  conversationDisplayItems,
  conversationProcessItemFacts,
  type ConversationDisplayItem
} from './conversation-presentation.js';

export interface ConversationProcessBlock {
  readonly id: string;
  readonly entries: {
    readonly turn: ConversationTurn;
    readonly displayItem: ConversationDisplayItem;
  }[];
  readonly groupId?: string;
  runId?: string | null;
  partial: boolean;
  sealed: boolean;
  active: boolean;
  startedAt?: number;
  durationMs?: number;
  latestWork?: ConversationItem;
  status?:
    'running' | 'executing' | 'stopping' | 'completed' | 'stopped' | 'incomplete' | 'history';
  preview?: ReasoningPreview;
  readonly footerTurnId?: string;
}

/** Consume authoritative membership; never infer a group from text, time, or Item type. */
export function conversationWorkProcessBlocks(
  turns: readonly ConversationTurn[],
  runs: readonly Pick<AgentRun, 'id' | 'status'>[] = [],
  footerTurnIds: ReadonlySet<string> = new Set()
): ConversationProcessBlock[] {
  return conversationWorkProcessProjection(turns, turns, runs, footerTurnIds).blocks;
}

/** Materialize the mounted window while retaining facts from the received history. */
export function conversationWorkProcessVisibleBlocks(
  renderedTurns: readonly ConversationTurn[],
  metadataBlocks: readonly ConversationProcessBlock[],
  footerTurnIds: ReadonlySet<string> = new Set()
): ConversationProcessBlock[] {
  const metadata = new Map(metadataBlocks.map((block) => [block.id, block]));
  return conversationWorkProcessBlocks(renderedTurns, [], footerTurnIds).map((block) => {
    const complete = block.groupId === undefined ? undefined : metadata.get(block.id);
    return complete === undefined ? block : { ...complete, entries: block.entries };
  });
}

/** Keep process facts for the received window while materializing only mounted entries. */
export function conversationWorkProcessProjection(
  turns: readonly ConversationTurn[],
  renderedTurns: readonly ConversationTurn[],
  runs: readonly Pick<AgentRun, 'id' | 'status'>[] = [],
  footerTurnIds: ReadonlySet<string> = new Set()
): { blocks: ConversationProcessBlock[]; metadataBlocks: ConversationProcessBlock[] } {
  const blocks: ConversationProcessBlock[] = [];
  const groups = new Map<string, ConversationProcessBlock>();
  const visibleGroups = new Map<string, ConversationProcessBlock>();
  const open = new Map<string, ConversationProcessBlock>();
  const activeRuns = new Set(
    runs.filter((run) => !isTerminalRunStatus(run.status)).map((run) => run.id)
  );
  const activeMembers = new Set<string>();
  const visibleItems = new Set(renderedTurns.flatMap((turn) => turn.items));
  const visibleTurns = new Set(
    renderedTurns.map((turn) => JSON.stringify([turn.sessionId, turn.id]))
  );
  const facts = new Map<
    string,
    { first: ConversationItem; last: ConversationItem; turn: ConversationTurn; executing: boolean }
  >();
  for (const turn of turns) {
    for (const item of turn.items) {
      const mounted = visibleItems.has(item);
      const itemFacts = conversationProcessItemFacts(item, mounted);
      if (!itemFacts.visible) continue;
      const displayItem = mounted
        ? (itemFacts.reasoning ?? conversationDisplayItems([item])[0])
        : undefined;
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
            status: 'history'
          };
          groups.set(key, group);
          open.set(turn.sessionId, group);
          facts.set(key, { first: item, last: item, turn, executing: false });
        }
        const state = facts.get(key)!;
        state.last = item;
        state.turn = turn;
        state.executing ||= itemFacts.executing;
        if (turn.runId != null) group.runId = turn.runId;
        if (item.processGroup.isStart) group.partial = false;
        if (['PENDING', 'IN_PROGRESS'].includes(item.status)) activeMembers.add(key);
        if (itemFacts.preview !== undefined) {
          const preview = selectReasoningPreview(group.preview, itemFacts.preview);
          if (preview) group.preview = preview;
        }
        if (
          [
            'reasoning',
            'command_execution',
            'tool_call',
            'file_change',
            'context_compaction',
            'assistant_message',
            'subagent'
          ].includes(item.kind)
        )
          group.latestWork = item;
        if (displayItem) {
          let visible = visibleGroups.get(key);
          if (!visible) {
            visible = { ...group, entries: [] };
            visibleGroups.set(key, visible);
            blocks.push(visible);
          }
          visible.entries.push({ turn, displayItem });
        }
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
        if (displayItem)
          blocks.push({
            id: `${turn.sessionId}:${item.id}`,
            entries: [{ turn, displayItem }],
            partial: false,
            sealed: true,
            active: false
          });
      }
    }
    if (visibleTurns.has(JSON.stringify([turn.sessionId, turn.id])) && footerTurnIds.has(turn.id))
      blocks.push({
        id: `duration:${turn.id}`,
        footerTurnId: turn.id,
        entries: [],
        partial: false,
        sealed: true,
        active: false
      });
  }
  const lastGroupByRun = new Map<string, ConversationProcessBlock>();
  for (const group of groups.values())
    if (group.runId != null) lastGroupByRun.set(group.runId, group);
  for (const group of groups.values()) {
    const state = facts.get(group.id)!;
    group.active =
      group.runId != null &&
      activeRuns.has(group.runId) &&
      (!group.sealed || activeMembers.has(group.id));
    const run = runs.find((candidate) => candidate.id === group.runId);
    const historicalStatus = state.turn.status;
    const endedEarlier =
      group.sealed &&
      !activeMembers.has(group.id) &&
      run !== undefined &&
      (!isTerminalRunStatus(run.status) || lastGroupByRun.get(run.id) !== group);
    group.status = group.active
      ? run?.status === 'CANCELLING'
        ? 'stopping'
        : state.executing
          ? 'executing'
          : 'running'
      : run === undefined
        ? historicalStatus === 'SUCCEEDED'
          ? 'completed'
          : historicalStatus === 'CANCELLED'
            ? 'stopped'
            : historicalStatus !== undefined && isTerminalRunStatus(historicalStatus)
              ? 'incomplete'
              : 'history'
        : endedEarlier || run.status === 'SUCCEEDED'
          ? 'completed'
          : run.status === 'CANCELLED'
            ? 'stopped'
            : isTerminalRunStatus(run.status)
              ? 'incomplete'
              : 'history';
    const start = state.first.startedAt ?? state.first.completedAt;
    const end = state.last.completedAt ?? state.last.startedAt;
    if (!group.partial && typeof start === 'number' && Number.isFinite(start) && start >= 0)
      group.startedAt = start;
    if (
      group.startedAt !== undefined &&
      typeof end === 'number' &&
      Number.isFinite(end) &&
      end >= group.startedAt
    )
      group.durationMs = end - group.startedAt;
    const visible = visibleGroups.get(group.id);
    if (visible) {
      const entries = visible.entries;
      const turnsByItem = new Map(entries.map(({ turn, displayItem }) => [displayItem.id, turn]));
      const aggregated = aggregateConversationDisplayItems(
        entries.map(({ displayItem }) => displayItem)
      );
      Object.assign(visible, group, {
        entries: aggregated.map((displayItem) => ({
          turn: turnsByItem.get(displayItem.id)!,
          displayItem
        }))
      });
    }
  }
  return { blocks, metadataBlocks: [...groups.values()] };
}

/** Advance history by visible work, including newly mounted process headings and summaries. */
export function nextConversationRenderItemCount(
  turns: readonly ConversationTurn[],
  renderedCount: number,
  blocks: readonly ConversationProcessBlock[],
  processOpen: (id: string) => boolean | undefined,
  budget: number,
  characterBudget = CONVERSATION_INITIAL_RENDER_CHARACTERS
): number {
  const groups = new Map(blocks.filter((block) => block.groupId).map((block) => [block.id, block]));
  const introduced = new Set<string>();
  let scanned = 0;
  let added = 0;
  let work = 0;
  let characters = 0;
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex--) {
    const turn = turns[turnIndex]!;
    for (let itemIndex = turn.items.length - 1; itemIndex >= 0; itemIndex--) {
      if (scanned++ < renderedCount) continue;
      const item = turn.items[itemIndex]!;
      const group = item.processGroup
        ? groups.get(`${turn.sessionId}:${item.processGroup.id}`)
        : undefined;
      let cost = 1;
      let contentVisible = true;
      if (group) {
        const open = processOpen(group.id);
        contentVisible = (open ?? group.active) || group.preview?.id === item.id;
        cost = (open ?? group.active) ? 1 : 0;
        // Previews remain outside the collapsed body, including during history backfill.
        if (group.preview?.id === item.id) cost = 1;
        if (open === undefined && !introduced.has(group.id)) cost++;
      }
      if (work + cost > budget) return renderedCount + added;
      const itemCharacters = contentVisible ? JSON.stringify(item.payload ?? null).length : 0;
      if (added > 0 && characters + itemCharacters > characterBudget) return renderedCount + added;
      work += cost;
      characters += itemCharacters;
      added++;
      if (group) introduced.add(group.id);
    }
  }
  return renderedCount + added;
}

/** Estimate live elapsed time; use recorded endpoints outside synchronized activity. */
export function conversationProcessDuration(
  block: ConversationProcessBlock,
  now: number | undefined,
  synchronized: boolean
): number | undefined {
  if (
    !block.active ||
    !synchronized ||
    block.startedAt === undefined ||
    now === undefined ||
    !Number.isFinite(now) ||
    now < block.startedAt
  )
    return block.durationMs;
  return now - block.startedAt;
}

/** Describe the last work record, not whether an individual call is still pending. */
export function conversationProcessLabel(
  block: ConversationProcessBlock,
  synchronized: boolean
): string {
  if (!block.active || block.status === 'stopping' || !synchronized)
    return translate(
      `conversationProcess.${block.active && !synchronized ? 'syncing' : (block.status ?? 'history')}`
    );
  const item = block.latestWork;
  const payload = conversationPayload(item?.payload);
  let activity = 'processing';
  let name: unknown;
  switch (item?.kind) {
    case 'reasoning':
      activity = 'thinking';
      break;
    case 'command_execution':
      activity = 'command';
      break;
    case 'file_change':
      activity = 'file';
      break;
    case 'context_compaction':
      activity = 'compact';
      break;
    case 'assistant_message':
      activity = 'reply';
      break;
    case 'subagent':
      activity = 'subagent';
      break;
    case 'tool_call': {
      const presentation = toolPresentation(item.payload);
      if (presentation) {
        activity = {
          READ: 'read',
          WEB_SEARCH: 'search',
          WEB_FETCH: 'fetch',
          SKILL: 'skill',
          SLEEP: 'sleep'
        }[presentation.kind];
        if (presentation.kind === 'SKILL') name = presentation.name;
      } else if (payload?.toolCategory === 'IMAGE_GENERATION') activity = 'image';
      else if (payload?.subagentOperation) activity = 'subagent';
      else {
        activity = 'tool';
        name = payload?.toolName;
      }
      break;
    }
  }
  const label = translate(`conversationProcess.activity.${activity}`);
  return typeof name === 'string' && name.trim()
    ? translate('conversationProcess.namedActivity', { activity: label, name })
    : label;
}
