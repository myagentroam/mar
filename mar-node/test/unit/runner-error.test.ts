import { describe, expect, it } from 'vitest';
import { createEnvelope } from '../../../packages/protocol/src/index.js';
import { ClaudeManagedRunController } from '../../src/runner/claude/managed-run-controller.js';
import { CodexManagedRunController } from '../../src/runner/codex/managed-run-controller.js';
import { NodeRuntimeState } from '../../src/runtime-state.js';
import { runnerErrorProjection } from '../../src/util/runner-error.js';
import { nativeConversationPage } from '../../src/util/runner-native-session-parsers.js';

describe('Runner error projection', () => {
  it('preserves the structured provider code and message ahead of an HTTP fallback', () => {
    expect(
      runnerErrorProjection(
        Object.assign(new Error('Request failed with status code 403'), {
          code: 'ERR_BAD_REQUEST',
          response: {
            status: 403,
            data: {
              error: {
                code: 'insufficient_user_quota',
                message: 'subscription quota insufficient, need=431775'
              }
            }
          }
        }),
        'RUNNER_FAILED'
      )
    ).toEqual({
      code: 'insufficient_user_quota',
      message: 'subscription quota insufficient, need=431775',
      httpStatus: 403
    });
  });

  it('preserves a structured HTTP status and provider message', () => {
    expect(
      runnerErrorProjection(
        { response: { status: 429, data: { error: { message: 'Rate limit exceeded.' } } } },
        'RUNNER_FAILED'
      )
    ).toEqual({ code: 'HTTP_429', message: 'Rate limit exceeded.', httpStatus: 429 });
  });

  it('extracts an HTTP status from an Error message and bounds the displayed message', () => {
    const projected = runnerErrorProjection(
      new Error(`Request failed with status 503: ${'x'.repeat(6000)}`),
      'RUNNER_FAILED'
    );
    expect(projected.code).toBe('HTTP_503');
    expect(projected.httpStatus).toBe(503);
    expect(projected.message).toHaveLength(1000);
  });

  it('uses the runner fallback when no public error details exist', () => {
    expect(runnerErrorProjection({}, 'RUNNER_FAILED')).toEqual({
      code: 'RUNNER_FAILED',
      message: 'RUNNER_FAILED',
      httpStatus: null
    });
  });

  it('accepts string HTTP status fields without treating unrelated numbers as HTTP errors', () => {
    expect(
      runnerErrorProjection({ statusCode: '429', message: 'Too many requests.' }, 'RUNNER_FAILED')
    ).toMatchObject({ code: 'HTTP_429', httpStatus: 429 });
    expect(
      runnerErrorProjection(new Error('The model has 500 weighted tokens left.'), 'FAILED')
    ).toMatchObject({ code: 'FAILED', httpStatus: null });
  });

  it('projects a failed Codex turn before publishing run.failed', () => {
    const calls: Array<{ readonly type: string; readonly value: unknown }> = [];
    const runner = {
      execution: {
        runs: new Map([
          [
            'run-codex',
            {
              sessionId: 'session-codex',
              threadId: 'thread-codex',
              turnId: 'turn-codex',
              cwd: '/workspace',
              refreshTitle: false
            }
          ]
        ]),
        managedTurns: new Map()
      },
      releaseEnvironment: () => undefined
    };
    const controller = new CodexManagedRunController(
      runner as never,
      {
        emitItem: (_runId: string, item: unknown) => calls.push({ type: 'item', value: item }),
        emit: (_runId: string, eventType: string, payload: unknown) =>
          calls.push({ type: eventType, value: payload }),
        appendImages: () => [],
        session: () => undefined,
        removeActive: () => undefined
      } as never
    );

    controller.handleNotification({
      method: 'turn/completed',
      params: {
        threadId: 'thread-codex',
        turn: {
          id: 'turn-codex',
          status: 'failed',
          error: { status: 429, message: 'Codex rate limit exceeded.' }
        }
      }
    });

    expect(calls.map(({ type }) => type)).toEqual(['item', 'run.failed']);
    expect(calls[0]?.value).toEqual(
      expect.objectContaining({
        kind: 'error',
        payload: expect.objectContaining({ httpStatus: 429, message: 'Codex rate limit exceeded.' })
      })
    );
  });

  it('projects a Claude start failure before publishing run.failed', () => {
    const calls: Array<{ readonly type: string; readonly value: unknown }> = [];
    const failure = Object.assign(new Error('Claude rate limit exceeded.'), { status: 429 });
    const runner = {
      execution: { managedNativeIds: new Set(), runs: new Map() },
      mcpConfiguration: () => undefined,
      startChannel: () => {
        throw failure;
      }
    };
    const controller = new ClaudeManagedRunController(
      runner as never,
      {
        intercepted: () => false,
        active: new Set(),
        parseAttachments: () => [],
        adopt: () => undefined,
        run: () => ({ status: 'STARTING' }),
        completeCancelled: () => false,
        emitItem: (_runId: string, item: unknown) => calls.push({ type: 'item', value: item }),
        emit: (_runId: string, eventType: string, payload: unknown) =>
          calls.push({ type: eventType, value: payload })
      } as never
    );

    controller.start(
      createEnvelope('run.start', {
        runner: 'claude-code',
        runId: 'run-claude',
        sessionId: 'session-claude',
        input: 'hello',
        cwd: '/workspace'
      })
    );

    expect(calls.map(({ type }) => type)).toEqual(['run.started', 'item', 'run.failed']);
    expect(calls[1]?.value).toEqual(
      expect.objectContaining({
        kind: 'error',
        payload: expect.objectContaining({
          httpStatus: 429,
          message: 'Claude rate limit exceeded.'
        })
      })
    );
  });

  it('keeps the failed Turn error and continues the next QueueItem in the same Run', () => {
    const runtime = new NodeRuntimeState(
      () => 'node-1',
      (id) =>
        id === 'workspace-1'
          ? {
              id,
              path: '/workspace',
              kind: 'DIRECTORY',
              gitSummary: null,
              createdAt: 1,
              updatedAt: 1
            }
          : undefined
    );
    const session = runtime.createAgentSession({
      workspaceId: 'workspace-1',
      runner: 'codex',
      cwd: '/workspace'
    });
    const first = runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'message-1',
      content: 'first'
    }).run;
    const second = runtime.createQueueItem({
      sessionId: session.id,
      clientMessageId: 'message-2',
      content: 'second'
    }).item;
    const firstExecution = runtime.createExecution(first.id);
    runtime.appendRunEvent({
      runId: firstExecution.id,
      sequence: 1,
      eventType: 'conversation.item',
      payload: {
        itemId: `runner-error:${first.id}`,
        kind: 'error',
        status: 'FAILED',
        payload: {
          code: 'HTTP_429',
          httpStatus: 429,
          message: 'Too many requests.',
          recoverable: true,
          retryAfterMs: null
        }
      }
    });
    runtime.appendRunEvent({
      runId: firstExecution.id,
      sequence: 2,
      eventType: 'run.failed',
      payload: { code: 'HTTP_429', httpStatus: 429, message: 'Too many requests.' },
      status: 'FAILED'
    });
    expect(runtime.listConversationTurns({ sessionId: session.id }).turns[0]?.items).toContainEqual(
      expect.objectContaining({
        kind: 'error',
        payload: expect.objectContaining({ httpStatus: 429, message: 'Too many requests.' })
      })
    );
    expect(runtime.claimNextQueueItem(session.id)?.item.id).toBe(second.id);
    const secondExecution = runtime.createExecution(first.id);
    runtime.appendRunEvent({
      runId: secondExecution.id,
      sequence: 3,
      eventType: 'run.completed',
      payload: {},
      status: 'SUCCEEDED'
    });
    runtime.finishRun(first.id, 'SUCCEEDED');
    runtime.removeTerminalRun(first.id);

    expect(
      runtime.listConversationTurns({ sessionId: session.id }).turns.flatMap((turn) => turn.items)
    ).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'error' })]));
  });

  it('only merges a current Claude error into a matching native history turn', () => {
    const page = nativeConversationPage(
      {
        id: 'claude-session',
        workspaceId: 'workspace-1',
        runner: 'claude-code',
        cwd: '/workspace',
        externalSessionId: 'claude-session'
      } as never,
      {
        items: [
          {
            kind: 'message',
            role: 'USER',
            text: 'hello',
            createdAt: 100
          }
        ]
      } as never,
      {},
      [
        {
          id: 'runtime-turn',
          sessionId: 'claude-session',
          runId: 'run-claude-history',
          userItemId: 'runtime-user',
          status: 'FAILED',
          model: null,
          effort: null,
          access: null,
          startedAt: 100,
          completedAt: 101,
          items: [
            {
              id: 'runtime-user',
              sessionId: 'claude-session',
              turnId: 'runtime-turn',
              runId: 'run-claude-history',
              parentItemId: null,
              sourceSequence: 1,
              revision: 0,
              kind: 'user_message',
              status: 'COMPLETED',
              payload: { text: 'hello', clientMessageId: 'message-1', attachments: [] },
              startedAt: 100,
              completedAt: 100
            },
            {
              id: 'runner-error:run-claude-history',
              sessionId: 'claude-session',
              turnId: 'runtime-turn',
              runId: 'run-claude-history',
              parentItemId: null,
              sourceSequence: 2,
              revision: 0,
              kind: 'error',
              status: 'FAILED',
              payload: {
                code: 'HTTP_429',
                httpStatus: 429,
                message: 'Too many requests.',
                recoverable: true,
                retryAfterMs: null
              },
              startedAt: 101,
              completedAt: 101
            }
          ]
        }
      ]
    );

    expect(page.turns[0]).toEqual(
      expect.objectContaining({
        runId: 'run-claude-history',
        status: 'FAILED',
        items: expect.arrayContaining([
          expect.objectContaining({
            kind: 'error',
            payload: expect.objectContaining({ httpStatus: 429, message: 'Too many requests.' })
          })
        ])
      })
    );

    const beforeNativeWrite = nativeConversationPage(
      {
        id: 'claude-session',
        workspaceId: 'workspace-1',
        runner: 'claude-code',
        cwd: '/workspace',
        externalSessionId: 'claude-session'
      } as never,
      { items: [] } as never,
      {},
      page.turns[0] === undefined
        ? []
        : [
            {
              ...page.turns[0],
              id: 'runtime-turn',
              items: page.turns[0].items.map((item) =>
                item.kind === 'user_message'
                  ? {
                      ...item,
                      payload: { text: 'hello', clientMessageId: 'message-1', attachments: [] }
                    }
                  : item
              )
            }
          ]
    );
    expect(beforeNativeWrite.turns).toEqual([]);
  });
});
