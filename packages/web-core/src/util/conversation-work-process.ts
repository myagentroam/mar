import type { AgentRun, ConversationItem, ConversationTurn } from '../model/workbench.js';
import { translate } from '../service/locale-preference-service.js';
import { toolPresentation } from './tool-presentation.js';
import { conversationPayload } from './conversation-history.js';
import { isTerminalRunStatus } from '../service/run-service.js';
import { selectReasoningPreview, type ReasoningPreview } from './conversation-reasoning.js';
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
            status: 'history'
          };
          groups.set(key, group);
          blocks.push(group);
          open.set(turn.sessionId, group);
        }
        group.entries.push(entry);
        if (turn.runId != null) group.runId = turn.runId;
        if (item.processGroup.isStart) group.partial = false;
        if (['PENDING', 'IN_PROGRESS'].includes(item.status)) activeMembers.add(key);
        if (displayItem.type === 'reasoning_group') {
          const preview = selectReasoningPreview(group.preview, displayItem.preview);
          if (preview) group.preview = preview;
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
        blocks.push({
          id: `${turn.sessionId}:${item.id}`,
          entries: [entry],
          partial: false,
          sealed: true,
          active: false
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
        active: false
      });
  }
  const lastGroupByRun = new Map<string, ConversationProcessBlock>();
  for (const group of groups.values()) {
    if (group.runId != null) lastGroupByRun.set(group.runId, group);
  }
  for (const group of groups.values()) {
    group.active =
      group.runId != null &&
      activeRuns.has(group.runId) &&
      (!group.sealed || activeMembers.has(group.id));
    const run = runs.find((candidate) => candidate.id === group.runId);
    const historicalStatus = group.entries.at(-1)?.turn.status;
    const executing = group.entries.some(
      ({ displayItem }) =>
        [
          'tool_group',
          'read_group',
          'command_group',
          'subagent_group',
          'image_generation'
        ].includes(displayItem.type) &&
        ('items' in displayItem ? displayItem.items : [displayItem.item]).some(
          (item) => item.status === 'IN_PROGRESS'
        )
    );
    // A final error can seal the last process too; sealing alone is not success.
    const endedEarlier =
      group.sealed &&
      !activeMembers.has(group.id) &&
      run !== undefined &&
      (!isTerminalRunStatus(run.status) || lastGroupByRun.get(run.id) !== group);
    group.status = group.active
      ? run?.status === 'CANCELLING'
        ? 'stopping'
        : executing
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
    const turnsByItem = new Map(
      group.entries.map(({ turn, displayItem }) => [displayItem.id, turn])
    );
    const items = group.entries.flatMap(({ displayItem }) =>
      'items' in displayItem ? displayItem.items : [displayItem.item]
    );
    // Measure the visible process interval, not summed tool time or the entire Run.
    const first = items[0];
    const last = items.at(-1);
    const latestWork = [...items]
      .reverse()
      .find((item) =>
        [
          'reasoning',
          'command_execution',
          'tool_call',
          'file_change',
          'context_compaction',
          'assistant_message',
          'subagent'
        ].includes(item.kind)
      );
    if (latestWork) group.latestWork = latestWork;
    const start = first?.startedAt ?? first?.completedAt;
    const end = last?.completedAt ?? last?.startedAt;
    if (!group.partial && typeof start === 'number' && Number.isFinite(start) && start >= 0)
      group.startedAt = start;
    if (
      !group.partial &&
      typeof start === 'number' &&
      Number.isFinite(start) &&
      start >= 0 &&
      typeof end === 'number' &&
      Number.isFinite(end) &&
      end >= start
    )
      group.durationMs = end - start;
    group.entries.splice(
      0,
      group.entries.length,
      ...conversationDisplayItems(items).map((displayItem) => ({
        turn: turnsByItem.get(displayItem.id)!,
        displayItem
      }))
    );
  }
  return blocks;
}

/** Advance history by visible work, including newly mounted process headings and summaries. */
export function nextConversationRenderItemCount(
  turns: readonly ConversationTurn[],
  renderedCount: number,
  blocks: readonly ConversationProcessBlock[],
  processOpen: (id: string) => boolean | undefined,
  budget: number
): number {
  const groups = new Map(blocks.filter((block) => block.groupId).map((block) => [block.id, block]));
  const introduced = new Set<string>();
  let scanned = 0;
  let added = 0;
  let work = 0;
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex--) {
    const turn = turns[turnIndex]!;
    for (let itemIndex = turn.items.length - 1; itemIndex >= 0; itemIndex--) {
      if (scanned++ < renderedCount) continue;
      const item = turn.items[itemIndex]!;
      const group = item.processGroup
        ? groups.get(`${turn.sessionId}:${item.processGroup.id}`)
        : undefined;
      let cost = 1;
      if (group) {
        const open = processOpen(group.id);
        cost = (open ?? group.active) ? 1 : 0;
        // Previews remain outside the collapsed body, including during history backfill.
        if (group.preview?.id === item.id) cost = 1;
        if (open === undefined && !introduced.has(group.id)) cost++;
      }
      if (work + cost > budget) return renderedCount + added;
      work += cost;
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
