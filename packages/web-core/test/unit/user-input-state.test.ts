import { workspaceTargetRef } from './support/workspace-fixture.js';
import { describe, expect, it, vi } from 'vitest';
import {
  createConversationUserInputService,
  userInputOtherAnswerId
} from '../../src/service/ConversationUserInputService.js';
import { userInputQuestions } from '../../src/util/conversation-user-input.js';

describe('Web Conversation user input state', () => {
  it('keeps only valid questions and options while applying defaults for legacy fields', () => {
    expect(userInputQuestions(null)).toEqual([]);
    expect(userInputQuestions({ questions: [null, { id: 1, prompt: 'invalid' }] })).toEqual([]);
    expect(
      userInputQuestions({
        questions: [
          {
            id: 'q1',
            prompt: 'Choose',
            options: [{ value: 'a', label: 'A' }, null, { value: 2, label: 'invalid' }]
          }
        ]
      })
    ).toEqual([
      {
        id: 'q1',
        prompt: 'Choose',
        input: 'SINGLE_SELECT',
        multiSelect: false,
        allowOther: false,
        options: [{ value: 'a', label: 'A', description: null }]
      }
    ]);
  });

  it.each(['missing-answer', 'failure', 'timeout'] as const)(
    'does not mark an answer complete when submission fails: %s',
    async (scenario) => {
      const notice = { value: '' };
      const request = vi.fn(async () => {
        throw new Error('denied');
      });
      const state = createConversationUserInputService({
        workspaceTarget: workspaceTargetRef({ value: 'node-1' }),
        notice: notice as never,
        request,
        errorMessage: String,
        missingRunError: () => false,
        recoverMissingRun: vi.fn(),
        beginSubmission: () => () => scenario !== 'timeout'
      });
      if (scenario !== 'missing-answer') state.setAnswer('item-1', 'q1', 'yes');
      await state.submit(
        { runId: 'run/1', sessionId: 'session-1' } as never,
        {
          id: 'item-1',
          status: 'PENDING',
          payload: {
            requestId: 'request/1',
            questions: [{ id: 'q1', prompt: 'Continue?', input: 'SHORT_TEXT' }]
          }
        } as never
      );
      expect(state.submitted('item-1')).toBe(false);
      if (scenario === 'missing-answer') {
        expect(request).not.toHaveBeenCalled();
        expect(notice.value).toBe('Answer every question before submitting.');
      } else {
        expect(request).toHaveBeenCalledWith(
          '/api/agent-runs/run%2F1/user-input/request%2F1',
          expect.anything()
        );
        expect(state.answer('item-1', 'q1')).toBe('yes');
        if (scenario === 'failure') expect(notice.value).toContain('denied');
        else expect(notice.value).toBe('');
      }
    }
  );

  it('isolates answers by item and question and can roll back submission state', () => {
    const state = createConversationUserInputService();
    state.setAnswer('item-1', 'question-1', 'Allowed');
    state.markSubmitted('item-1');
    expect(state.answer('item-1', 'question-1')).toBe('Allowed');
    expect(state.submitted('item-1')).toBe(true);

    state.clearSubmitted('item-1');
    expect(state.submitted('item-1')).toBe(false);
    state.reset();
    expect(state.answer('item-1', 'question-1')).toBe('');
  });

  it('submits preset and custom answers together for a multi-select question', async () => {
    const requestCalls = vi.fn<(path: string, init?: RequestInit) => void>();
    const request = async <T = unknown>(path: string, init?: RequestInit): Promise<T> => {
      requestCalls(path, init);
      return undefined as T;
    };
    const state = createConversationUserInputService({
      workspaceTarget: workspaceTargetRef({ value: 'node-1' }),
      notice: { value: '' } as never,
      request,
      errorMessage: String,
      missingRunError: () => false,
      recoverMissingRun: () => undefined,
      beginSubmission: () => () => true
    });
    state.setAnswer('input-1', 'question-1', ['Option A']);
    state.setAnswer('input-1', userInputOtherAnswerId('question-1'), 'Custom option');

    await state.submit(
      { runId: 'run-1' } as never,
      {
        id: 'input-1',
        kind: 'user_input_request',
        status: 'PENDING',
        payload: {
          requestId: 'request-1',
          questions: [
            {
              id: 'question-1',
              prompt: 'Choose an option',
              input: 'MULTI_SELECT',
              options: [{ value: 'Option A', label: 'Option A', description: null }],
              allowOther: true
            }
          ]
        }
      } as never
    );

    expect(requestCalls).toHaveBeenCalledWith('/api/agent-runs/run-1/user-input/request-1', {
      method: 'POST',
      body: JSON.stringify({
        nodeId: 'node-1',
        answers: { 'question-1': ['Option A', 'Custom option'] }
      })
    });
    expect(state.submitted('input-1')).toBe(true);
  });

  it('does not send an Agent question answer while another Conversation submission is in progress', async () => {
    const request = vi.fn();
    const state = createConversationUserInputService({
      workspaceTarget: workspaceTargetRef({ value: 'node-1' }),
      notice: { value: '' } as never,
      request,
      errorMessage: String,
      missingRunError: () => false,
      recoverMissingRun: () => undefined,
      beginSubmission: () => undefined
    });
    state.setAnswer('input-1', 'question-1', 'Continue');

    await state.submit(
      { runId: 'run-1' } as never,
      {
        id: 'input-1',
        status: 'PENDING',
        payload: {
          requestId: 'request-1',
          questions: [
            {
              id: 'question-1',
              prompt: 'Continue?',
              input: 'SHORT_TEXT',
              options: [],
              allowOther: true
            }
          ]
        }
      } as never
    );

    expect(request).not.toHaveBeenCalled();
    expect(state.submitted('input-1')).toBe(false);
  });

  it('allows a multi-select question to submit only a custom answer', async () => {
    const requestCalls = vi.fn<(path: string, init?: RequestInit) => void>();
    const request = async <T = unknown>(path: string, init?: RequestInit): Promise<T> => {
      requestCalls(path, init);
      return undefined as T;
    };
    const state = createConversationUserInputService({
      workspaceTarget: workspaceTargetRef({ value: 'node-1' }),
      notice: { value: '' } as never,
      request,
      errorMessage: String,
      missingRunError: () => false,
      recoverMissingRun: () => undefined,
      beginSubmission: () => () => true
    });
    state.setAnswer('input-1', userInputOtherAnswerId('question-1'), 'Custom only');
    await state.submit(
      { runId: 'run-1' } as never,
      {
        id: 'input-1',
        kind: 'user_input_request',
        status: 'PENDING',
        payload: {
          requestId: 'request-1',
          questions: [
            {
              id: 'question-1',
              prompt: 'Choose an option',
              input: 'MULTI_SELECT',
              options: [{ value: 'Option A', label: 'Option A', description: null }],
              allowOther: true
            }
          ]
        }
      } as never
    );
    expect(JSON.parse(String(requestCalls.mock.calls[0]?.[1]?.body))).toEqual({
      nodeId: 'node-1',
      answers: { 'question-1': ['Custom only'] }
    });
  });

  it('silently recovers the conversation when its Run has ended', async () => {
    const notice = { value: '' };
    const recoverMissingRun = vi.fn();
    const state = createConversationUserInputService({
      workspaceTarget: workspaceTargetRef({ value: 'node-1' }),
      notice: notice as never,
      request: async () => {
        throw Object.assign(new Error('The run has ended.'), { code: 'RUN_NOT_FOUND' });
      },
      errorMessage: String,
      missingRunError: (error) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'RUN_NOT_FOUND',
      recoverMissingRun,
      beginSubmission: () => () => true
    });
    state.setAnswer('input-1', 'question-1', 'Continue');

    await state.submit(
      { runId: 'run-1' } as never,
      {
        id: 'input-1',
        kind: 'user_input_request',
        status: 'PENDING',
        payload: {
          requestId: 'request-1',
          questions: [
            {
              id: 'question-1',
              prompt: 'Continue?',
              input: 'SHORT_TEXT',
              options: [],
              allowOther: true
            }
          ]
        }
      } as never
    );

    expect(recoverMissingRun).toHaveBeenCalledWith('run-1');
    expect(notice.value).toBe('');
    expect(state.submitted('input-1')).toBe(false);
  });
});
