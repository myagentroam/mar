import { describe, expect, it } from 'vitest';
import type { AgentRun, ConversationItem, ConversationTurn } from '../../src/model/workbench';
import {
  completedStepDuration,
  conversationActivityLabel,
  conversationElapsedLabel,
  runDuration
} from '../../src/util/conversation-activity';
import { translate } from '../../src/service/LocalePreferenceService';

const run: AgentRun = {
  id: 'run',
  sessionId: 'session',
  status: 'RUNNING',
  recoveryState: 'ACTIVE',
  clientMessageId: 'input',
  startedAt: 1_000
};
const item: ConversationItem = {
  id: 'tool',
  kind: 'command_execution',
  status: 'IN_PROGRESS',
  payload: {}
};
const turn = (
  items: readonly ConversationItem[],
  extra: Partial<ConversationTurn> = {}
): ConversationTurn => ({
  id: 'turn',
  runId: run.id,
  sessionId: 'session',
  status: 'RUNNING',
  items,
  ...extra
});
const label = (key: string) => translate(`conversationActivity.${key}`);

describe('Public activity and duration', () => {
  it('uses generic activity without summary or public facts, not synthetic thinking', () => {
    expect(conversationActivityLabel(run, [])).toBe(label('running'));
    expect(conversationActivityLabel(run, [turn([{ ...item, kind: 'reasoning' }])])).toBe(
      label('running')
    );
  });
  it('uses only unique current activity and never the last event in parallel work', () => {
    expect(conversationActivityLabel(run, [turn([item])])).toBe(label('command'));
    expect(conversationActivityLabel(run, [turn([item, { ...item, id: 'other' }])])).toBe(
      label('running')
    );
    expect(conversationActivityLabel(run, [turn([{ ...item, status: 'COMPLETED' }])])).toBe(
      label('running')
    );
  });
  it('does not reuse an older execution or a previous Run', () => {
    expect(conversationActivityLabel(run, [turn([item]), turn([], { id: 'next' })])).toBe(
      label('running')
    );
    expect(conversationActivityLabel({ ...run, id: 'new' }, [turn([item])])).toBe(label('running'));
    expect(conversationActivityLabel(run, [turn([item], { status: 'SUCCEEDED' })])).toBe(
      label('running')
    );
  });
  it('prioritizes effective pending requests, stopping and authoritative terminal state', () => {
    const waiting = turn([
      item,
      { ...item, id: 'approval', kind: 'approval_request', status: 'PENDING' }
    ]);
    expect(conversationActivityLabel(run, [waiting])).toBe(label('approval'));
    expect(conversationActivityLabel({ ...run, status: 'CANCELLING' }, [waiting])).toBe(
      label('stopping')
    );
    expect(conversationActivityLabel({ ...run, status: 'SUCCEEDED' }, [waiting])).toBe('');
  });
  it.each(['SUCCEEDED', 'FAILED', 'CANCELLED'] as const)(
    'ignores stale actions in the latest %s segment without reviving an earlier segment',
    (status) => {
      const stale = turn(
        [item, { ...item, id: 'approval', kind: 'approval_request', status: 'PENDING' }],
        { id: 'latest', status }
      );
      expect(conversationActivityLabel(run, [turn([item]), stale])).toBe(label('running'));
    }
  );
  it('uses full Run duration including waits, never sums tools or estimates missing endpoints', () => {
    expect(runDuration({ startedAt: 1_000, completedAt: 21_000 })).toBe(20_000);
    expect(runDuration({ startedAt: 21_000, completedAt: 1_000 })).toBeUndefined();
    expect(runDuration({ startedAt: 1_000 })).toBeUndefined();
    expect(conversationElapsedLabel(undefined, 10_000)).toBe('');
    expect(conversationElapsedLabel(10_000, 1_000)).toBe('');
  });
  it('uses actual step durations even without start, never projected zero or requested sleep duration', () => {
    expect(
      completedStepDuration({ ...item, status: 'COMPLETED', startedAt: 1, completedAt: 1 })
    ).toBeUndefined();
    expect(
      completedStepDuration({ ...item, status: 'COMPLETED', payload: { durationMs: 0 } })
    ).toBe(0);
    expect(
      completedStepDuration({
        ...item,
        kind: 'tool_call',
        status: 'COMPLETED',
        payload: { toolPresentation: { kind: 'SLEEP', durationMs: 10_000, elapsedMs: 200 } }
      })
    ).toBe(200);
  });
});
