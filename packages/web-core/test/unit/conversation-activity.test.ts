import { describe, expect, it } from 'vitest';
import type { AgentRun, ConversationItem, ConversationTurn } from '../../src/model/workbench';
import {
  completedStepDuration,
  completedConversationDurations,
  conversationActivityLabel,
  conversationActivityBusy,
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
  it('restores one historical duration from the first input through the final segment after restart', () => {
    const segments = [0, 1, 2].map((index) =>
      turn(
        [{ ...item, id: `input-${index}`, kind: 'user_message', startedAt: 1000 + index * 4000 }],
        {
          id: `segment-${index}`,
          turnId: 'original',
          segmentIndex: index,
          runId: null,
          status: 'SUCCEEDED',
          startedAt: 1000 + index * 4000,
          completedAt: 5000 + index * 4000
        }
      )
    );
    expect([...completedConversationDurations(segments)]).toEqual([['segment-2', 12000]]);
    expect(completedConversationDurations(segments.slice(1)).size).toBe(0);
    const next = turn([{ ...item, kind: 'user_message', startedAt: 20000 }], {
      id: 'next',
      turnId: 'next',
      segmentIndex: 0,
      runId: null,
      status: 'SUCCEEDED',
      completedAt: 23000
    });
    expect([...completedConversationDurations([...segments, next])]).toEqual([
      ['segment-2', 12000],
      ['next', 3000]
    ]);
  });

  it('uses the initial user timestamp before Run startup without resetting for appended inputs', () => {
    const first = turn([{ ...item, kind: 'user_message', startedAt: 500 }], {
      id: 'first',
      turnId: 'round',
      segmentIndex: 0
    });
    const last = turn([{ ...item, kind: 'user_message', startedAt: 2000 }], {
      id: 'last',
      turnId: 'round',
      segmentIndex: 1,
      status: 'SUCCEEDED',
      completedAt: 3500
    });
    expect([...completedConversationDurations([first, last])]).toEqual([['last', 3000]]);
    expect(
      completedConversationDurations([first, { ...last, status: 'RUNNING', completedAt: null }])
        .size
    ).toBe(0);
    expect([
      ...completedConversationDurations([first, last].map((part) => ({ ...part, runId: null })))
    ]).toEqual([['last', 3000]]);
  });

  it('does not invent historical completion, origin or reversed time', () => {
    const base = turn([{ ...item, kind: 'user_message', startedAt: 1000 }], {
      runId: null,
      status: 'SUCCEEDED',
      completedAt: 2000
    });
    for (const changed of [
      { status: 'RUNNING' },
      { completedAt: null },
      { completedAt: 500 },
      { completedAt: NaN },
      { items: [{ ...item, kind: 'user_message' }] },
      { items: [] }
    ]) {
      expect(completedConversationDurations([{ ...base, ...changed }]).size).toBe(0);
    }
  });

  it('only animates ongoing work, not terminal or user-wait states', () => {
    expect(conversationActivityBusy(run, [])).toBe(true);
    for (const kind of ['approval_request', 'user_input_request'] as const) {
      const waiting = turn([{ ...item, kind, status: 'PENDING' }]);
      expect(conversationActivityBusy(run, [waiting])).toBe(false);
      expect(conversationActivityBusy({ ...run, status: 'CANCELLING' }, [waiting])).toBe(true);
    }
    expect(conversationActivityBusy({ ...run, status: 'SUCCEEDED' }, [])).toBe(false);
  });
  it('uses generic activity without summary or public facts, not synthetic thinking', () => {
    expect(conversationActivityLabel(run, [])).toBe(label('running'));
    expect(conversationActivityLabel(run, [turn([{ ...item, kind: 'reasoning' }])])).toBe(
      label('running')
    );
  });
  it('keeps the Run label stable during single and parallel tool work', () => {
    expect(conversationActivityLabel(run, [turn([item])])).toBe(label('running'));
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
    expect(conversationElapsedLabel(1_000, 4_000)).toBe('3s');
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
