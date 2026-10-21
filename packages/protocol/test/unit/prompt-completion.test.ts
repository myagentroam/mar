import { describe, expect, it } from 'vitest';
import {
  promptCompletionTargetSchema,
  promptCompletionConfigurationSchema,
  promptCompletionPreferencesSchema,
  promptCompletionRequestSchema,
  usagePurposeSchema,
  nodeCapabilitiesSchema
} from '../../src/index.js';

const request = {
  trigger: 'MANUAL',
  completionMode: 'COMPLETE',
  draft: 'Check the API',
  cursorPosition: 13,
  draftRevision: 1,
  contextVersion: 'context-1',
  historyGeneration: 'history-1',
  requestId: 'request-1',
  pageEpoch: 'page-1',
  intentSequence: 1,
  runner: 'mar-agent',
  sessionId: null
};

describe('Prompt completion wire contract', () => {
  it('accepts whole-prompt rewrite intent independently of cursor position', () => {
    expect(
      promptCompletionRequestSchema.parse({
        ...request,
        completionMode: 'REWRITE',
        cursorPosition: 0
      }).completionMode
    ).toBe('REWRITE');
    expect(
      promptCompletionRequestSchema.safeParse({
        ...request,
        completionMode: 'REWRITE',
        draft: '',
        cursorPosition: 0
      }).success
    ).toBe(false);
  });
  it('preserves the advertised Node capability at the capability root', () => {
    const capabilities = {
      platform: 'linux',
      architecture: 'x64',
      nodeVersion: 'v22.14.0',
      metadata: {},
      codex: { available: false },
      claudeCode: { available: false }
    };
    expect(
      nodeCapabilitiesSchema.parse({ ...capabilities, promptCompletion: { apiVersion: 1 } })
        .promptCompletion
    ).toEqual({ apiVersion: 1 });
    expect(nodeCapabilitiesSchema.parse(capabilities).promptCompletion).toBeUndefined();
    expect(
      nodeCapabilitiesSchema.safeParse({ ...capabilities, promptCompletion: { apiVersion: 2 } })
        .success
    ).toBe(false);
  });
  it('rejects hosted targets at the wire boundary', () => {
    expect(
      promptCompletionTargetSchema.safeParse({
        kind: 'HOSTED_CONVERSATION',
        conversationId: 'conversation'
      }).success
    ).toBe(false);
    expect(
      promptCompletionTargetSchema.parse({ kind: 'WORKSPACE', workspaceId: 'workspace' })
    ).toEqual({ kind: 'WORKSPACE', workspaceId: 'workspace' });
  });

  it('distinguishes auxiliary completion usage from the source Runner conversation', () => {
    expect(usagePurposeSchema.parse('prompt_completion')).toBe('prompt_completion');
  });

  it('keeps an enabled but unconfigured default representable', () => {
    expect(
      promptCompletionConfigurationSchema.parse({
        enabled: true,
        modelId: null,
        reasoningEffort: null
      })
    ).toEqual({ enabled: true, modelId: null, reasoningEffort: null });
    expect(promptCompletionPreferencesSchema.parse({ work: false })).toEqual({
      work: false
    });
    expect(
      promptCompletionPreferencesSchema.safeParse({ work: true, conversation: true }).success
    ).toBe(false);
  });

  it('preserves drafts and rejects automatic draft rewriting or replacement input', () => {
    expect(promptCompletionRequestSchema.parse(request).draft).toBe(request.draft);
    expect(
      promptCompletionRequestSchema.parse({
        ...request,
        trigger: 'AUTO',
        draft: '',
        cursorPosition: 0,
        completionMode: 'NEXT'
      }).trigger
    ).toBe('AUTO');
    expect(
      nodeCapabilitiesSchema.parse({
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: 'v22.14.0',
        metadata: {},
        codex: { available: false },
        claudeCode: { available: false },
        promptCompletion: { apiVersion: 1, automaticTriggers: true }
      }).promptCompletion?.automaticTriggers
    ).toBe(true);

    expect(promptCompletionRequestSchema.safeParse({ ...request, trigger: 'AUTO' }).success).toBe(
      false
    );
    expect(promptCompletionRequestSchema.safeParse({ ...request, selectionEnd: 2 }).success).toBe(
      false
    );
    expect(
      promptCompletionRequestSchema.safeParse({ ...request, cursorPosition: 14 }).success
    ).toBe(false);
    expect(
      promptCompletionRequestSchema.safeParse({ ...request, completionMode: 'NEXT' }).success
    ).toBe(false);
  });

  it('checks UTF-16 boundaries and UTF-8 byte budgets without trimming', () => {
    expect(
      promptCompletionRequestSchema.safeParse({ ...request, draft: '😀', cursorPosition: 1 })
        .success
    ).toBe(false);
    expect(
      promptCompletionRequestSchema.parse({ ...request, draft: '  😀\n', cursorPosition: 4 }).draft
    ).toBe('  😀\n');
    expect(
      promptCompletionRequestSchema.safeParse({
        ...request,
        draft: '界'.repeat(3000),
        cursorPosition: 0
      }).success
    ).toBe(false);
  });
});
