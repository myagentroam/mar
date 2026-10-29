import { describe, expect, it } from 'vitest';
import {
  conversationItemSchema,
  marAgentNodeModelSummarySchema,
  marAgentRuntimeModelConfigurationSchema,
  NODE_PROTOCOL_VERSION,
  nodeEnvelopeSchema
} from '../../src/index.js';

const model = {
  id: 'model',
  name: 'Model',
  protocol: 'OPENAI_RESPONSES',
  baseUrl: 'https://example.com/v1',
  modelId: 'model',
  contextWindowTokens: 10000,
  maxOutputTokens: 1000,
  inputCapabilities: ['TEXT'],
  outputCapabilities: ['TEXT'],
  reasoningEfforts: [],
  hostedWebSearch: false,
  enabled: true
};
const item = {
  id: 'item',
  sessionId: 'session',
  turnId: 'turn',
  runId: null,
  parentItemId: null,
  sourceSequence: 1,
  revision: 0,
  status: 'COMPLETED',
  startedAt: 1,
  completedAt: 2
};

describe('Node 0.11.39 protocol baseline', () => {
  it('retains wire v3 and rejects v2 and unknown versions', () => {
    expect(NODE_PROTOCOL_VERSION).toBe(3);
    for (const version of [2, 3, 4]) {
      expect(
        nodeEnvelopeSchema.safeParse({ version, id: 'request', type: 'heartbeat', payload: {} })
          .success
      ).toBe(version === 3);
    }
  });

  it('uses one runtime credential representation and rejects a bare static key', () => {
    expect(
      marAgentRuntimeModelConfigurationSchema.safeParse({ ...model, apiKey: 'fixture' }).success
    ).toBe(false);
    const credential = { type: 'INLINE_API_KEY', value: 'fixture' };
    expect(marAgentRuntimeModelConfigurationSchema.parse({ ...model, credential })).toMatchObject({
      credential
    });
  });

  it('drops the obsolete model flag from baseline Node summaries', () => {
    const parsed = marAgentNodeModelSummarySchema.parse({
      ...model,
      sortOrder: 0,
      apiKeyConfigured: true,
      credentialType: 'INLINE_API_KEY',
      credentialConfigured: true
    });
    expect(parsed).not.toHaveProperty('apiKeyConfigured');
    expect(parsed).toMatchObject({ credentialType: 'INLINE_API_KEY', credentialConfigured: true });
  });

  it('accepts command payloads both with and without the obsolete baseline output reference', () => {
    const payload = {
      command: 'echo ok',
      cwd: null,
      outputPreview: 'ok',
      exitCode: 0,
      durationMs: 1,
      truncated: false
    };
    for (const input of [payload, { ...payload, outputRef: null }]) {
      expect(
        conversationItemSchema.parse({ ...item, kind: 'command_execution', payload: input }).payload
      ).toEqual(payload);
    }
  });

  it('drops the baseline conversation diff flag without discarding change facts', () => {
    const change = { path: 'file.ts', change: 'MODIFIED', additions: 1, deletions: 0 };
    for (const input of [change, { ...change, diffAvailable: false }]) {
      expect(
        conversationItemSchema.parse({
          ...item,
          kind: 'file_change',
          payload: { changes: [input] }
        }).payload
      ).toEqual({ changes: [change] });
    }
  });
});
