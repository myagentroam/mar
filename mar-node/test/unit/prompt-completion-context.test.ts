import { describe, expect, it } from 'vitest';
import { serializeComposerTag } from '@myagentroam/protocol';
import type { NodeConversationItem, NodeConversationTurn } from '../../src/runtime-model.js';
import { projectCompletionContext } from '../../src/service/prompt-completion-context.js';

function item(
  id: string,
  kind: string,
  payload: unknown,
  status = 'COMPLETED'
): NodeConversationItem {
  return {
    id,
    kind,
    payload,
    status,
    revision: 1,
    sessionId: 'session',
    turnId: 'turn',
    runId: 'run',
    parentItemId: null,
    sourceSequence: null,
    startedAt: 1,
    completedAt: null
  };
}
function turn(items: NodeConversationItem[]): NodeConversationTurn {
  return {
    id: 'turn',
    sessionId: 'session',
    runId: 'run',
    userItemId: 'user',
    status: 'RUNNING',
    model: null,
    effort: null,
    access: null,
    items,
    startedAt: 1,
    completedAt: null
  };
}

describe('prompt completion context projection', () => {
  it('does not revive failed tools or waiting requests from earlier turns', () => {
    const old = {
      ...turn([
        item('failed', 'command_execution', {}, 'FAILED'),
        item('approval', 'approval', {}, 'PENDING')
      ]),
      id: 'old'
    };
    const current = {
      ...turn([
        item('latest', 'user_message', { text: 'No need to investigate the old interruption.' })
      ]),
      id: 'current'
    };
    const projection = projectCompletionContext([old, current], 'generation');
    expect(JSON.parse(projection.executionSnapshot)).toMatchObject({ tools: [], waiting: [] });
    expect(projection.history[0]?.text).toContain('No need to investigate');
  });

  it('uses visible user text rather than hidden Composer resource paths or Skill instructions', () => {
    const raw = `Review this ${serializeComposerTag('mar_skills', {
      action: 'use',
      instruction: 'Hidden instruction',
      skills: [{ name: 'skill', source: 'WORKSPACE', path: '/private/skill' }]
    })}`;
    const projection = projectCompletionContext(
      [turn([item('user', 'user_message', { text: raw })])],
      'generation'
    );
    expect(projection.history[0]?.text).toBe('Review this');
    expect(JSON.stringify(projection)).not.toContain('/private/skill');
    expect(JSON.stringify(projection)).not.toContain('Hidden instruction');
  });

  it('keeps only consumed user text and complete assistant messages, without author filtering', () => {
    const projection = projectCompletionContext(
      [
        turn([
          item('user', 'user_message', {
            text: 'Keep API compatibility',
            delivery: 'ACCEPTED',
            author: 'other'
          }),
          item('scheduled', 'user_message', {
            text: 'scheduled',
            delivery: 'ACCEPTED',
            source: 'SCHEDULED'
          }),
          item('queued', 'user_message', { text: 'queued', delivery: 'QUEUED_NEXT_TURN' }),
          item('native', 'user_message', { text: 'native' }),
          item('complete', 'assistant_message', { text: 'API checked' }),
          item('partial', 'assistant_message', { text: 'Working on tests' }, 'IN_PROGRESS')
        ])
      ],
      'generation'
    );
    expect(projection.history.map((value) => value.text)).toEqual([
      'Keep API compatibility',
      'native',
      'API checked'
    ]);
    expect(projection.references.map((value) => value.text)).toEqual([
      'Keep API compatibility',
      'native'
    ]);
    expect(JSON.parse(projection.executionSnapshot).partialAssistant).toEqual(['Working on tests']);
  });

  it('keeps semantic identity stable across progress but invalidates it on completion and history edits', () => {
    const user = item('user', 'user_message', { text: 'Check tests', delivery: 'ACCEPTED' });
    const partial = item('assistant', 'assistant_message', { text: 'Checking' }, 'IN_PROGRESS');
    const first = projectCompletionContext([turn([user, partial])], 'generation');
    const progress = { ...partial, revision: 3, payload: { text: 'Checking another test' } };
    const next = projectCompletionContext([turn([user, progress])], 'generation');
    expect(next.identity.contextVersion).toBe(first.identity.contextVersion);
    expect(next.identity.progressRevision).toBeGreaterThan(first.identity.progressRevision);
    expect(
      projectCompletionContext([turn([user, { ...progress, status: 'COMPLETED' }])], 'generation')
        .identity.contextVersion
    ).not.toBe(first.identity.contextVersion);
    expect(
      projectCompletionContext(
        [turn([{ ...user, payload: { text: 'Changed' } }, partial])],
        'generation'
      ).identity.contextVersion
    ).not.toBe(first.identity.contextVersion);
    expect(
      projectCompletionContext([turn([user, partial])], 'new-generation').identity.contextVersion
    ).not.toBe(first.identity.contextVersion);
  });

  it('never includes raw tool details, file contents, hidden reasoning or approval arguments', () => {
    const secret = 'private-tool-output';
    const projection = projectCompletionContext(
      [
        turn([
          item('tool', 'tool_call', {
            toolName: secret,
            inputSummary: secret,
            outputSummary: secret
          }),
          item('file', 'file_change', { changes: [{ diff: secret }] }),
          item('reasoning', 'reasoning_summary', { text: secret }),
          item('approval', 'approval', { command: secret }, 'PENDING')
        ])
      ],
      'generation'
    );
    expect(JSON.stringify(projection)).not.toContain(secret);
    expect(JSON.parse(projection.executionSnapshot).waiting).toEqual([
      { kind: 'approval', status: 'PENDING' }
    ]);
    expect(JSON.parse(projection.executionSnapshot).tools).toHaveLength(2);
  });

  it('deduplicates repeated echo identities, not independent equal messages', () => {
    const echo = item('first', 'user_message', { text: 'continue', clientMessageId: 'client' });
    const projection = projectCompletionContext(
      [
        turn([
          echo,
          { ...echo, id: 'echo' },
          item('independent', 'user_message', { text: 'continue', clientMessageId: 'second' })
        ])
      ],
      'generation'
    );
    expect(projection.history).toHaveLength(2);
  });
});
