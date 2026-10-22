import { describe, expect, it } from 'vitest';
import type { MarAgentEvent } from '../../mar-agent/src/index.js';
import { NodeRuntimeState } from '../../mar-node/src/runtime-state.js';
import { MarAgentConversationNormalizer } from '../../mar-node/src/runner/mar-agent/conversation-normalizer.js';
import { conversationTurnSchema, workbenchEventSchema } from '../../packages/protocol/src/index.js';
import { createRunService } from '../../packages/web-core/src/service/RunService.js';
import { conversationDisplayItems } from '../../packages/web-core/src/util/conversation-presentation.js';
import {
  conversationActivityLabel,
  runDuration
} from '../../packages/web-core/src/util/conversation-activity.js';
import { translate } from '../../packages/web-core/src/service/LocalePreferenceService.js';
import type { AgentRun } from '../../packages/web-core/src/model/workbench.js';

describe('MAR public callbacks through Node and Web presentation', () => {
  it('keeps one Run clock across two executions without requiring public reasoning', () => {
    let now = 1_000;
    const runtime = new NodeRuntimeState(
      () => 'node',
      () => ({
        id: 'workspace',
        path: '/workspace',
        kind: 'DIRECTORY',
        gitSummary: null,
        createdAt: 1,
        updatedAt: 1
      }),
      () => now
    );
    const session = runtime.createAgentSession({
      workspaceId: 'workspace',
      runner: 'mar-agent',
      cwd: '/workspace'
    });
    const { run } = runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'first',
      content: 'Review'
    });
    let execution = runtime.createExecution(run.id);
    const normalizer = new MarAgentConversationNormalizer();
    const web = createRunService({ value: session.id } as never);
    let sequence = 0;
    const emit = (eventType: string, payload: unknown, status?: 'RUNNING' | 'SUCCEEDED') =>
      runtime.appendRunEvent({
        runId: execution.id,
        sequence: ++sequence,
        eventType,
        payload,
        status
      });
    const publish = () => {
      const event = workbenchEventSchema.parse(
        JSON.parse(
          JSON.stringify({
            sequence: sequence + 1,
            category: 'run',
            payload: { runs: runtime.listRunsForSession(session.id, { includeTerminal: true }) }
          })
        )
      );
      web.mergeSnapshots((event.payload as { runs: AgentRun[] }).runs);
      return runtime
        .listConversationTurns({ sessionId: session.id })
        .turns.map((turn) => conversationTurnSchema.parse(turn));
    };
    const callback = (data: Record<string, unknown>) => {
      const event = {
        eventId: `event-${sequence}`,
        sequence: sequence + 1,
        timestamp: new Date(now).toISOString(),
        sessionId: session.id,
        executionId: execution.id,
        turnId: execution.turnId,
        ...data
      } as MarAgentEvent;
      for (const item of normalizer.normalize(event)) emit('conversation.item', item);
    };

    emit('run.started', {}, 'RUNNING');
    const initialTurns = publish();
    expect(conversationActivityLabel(web.runs.value[0], initialTurns)).toBe(
      translate('conversationActivity.running')
    );
    callback({
      type: 'tool.started',
      callId: 'read',
      toolName: 'read',
      input: { reads: [{ path: 'source.ts' }] }
    });
    const activeTurns = publish();
    expect(conversationActivityLabel(web.runs.value[0], activeTurns)).toBe(
      translate('conversationActivity.tool')
    );
    expect(
      activeTurns
        .flatMap((turn) => conversationDisplayItems(turn.items))
        .some((item) => item.type === 'reasoning_group')
    ).toBe(false);
    now = 5_000;
    callback({ type: 'tool.completed', callId: 'read', toolName: 'read', summary: 'Source read' });
    emit('run.completed', {}, 'SUCCEEDED');
    runtime.createQueueItem({
      sessionId: session.id,
      clientMessageId: 'follow-up',
      content: 'Continue'
    });
    runtime.claimNextQueueItem(session.id);
    now = 8_000;
    execution = runtime.createExecution(run.id);
    emit('run.started', {}, 'RUNNING');
    publish();
    expect(web.runs.value[0]?.startedAt).toBe(1_000);
    expect(runDuration(web.runs.value[0]!)).toBeUndefined();
    now = 21_000;
    emit('text.delta', { itemId: 'answer', text: 'Done' });
    emit('run.completed', {}, 'SUCCEEDED');
    runtime.finishRun(run.id, 'SUCCEEDED');
    const finalTurns = publish();
    expect(new Set(finalTurns.map((turn) => turn.runId))).toEqual(new Set([run.id]));
    expect(finalTurns).toHaveLength(2);
    expect(web.runs.value[0]?.completedAt).toBe(21_000);
    expect(runDuration(web.runs.value[0]!)).toBe(20_000);
    expect(conversationActivityLabel(web.runs.value[0], finalTurns)).toBe('');
    expect(
      finalTurns.flatMap((turn) => turn.items).some((item) => item.kind === 'assistant_message')
    ).toBe(true);
  });
});
