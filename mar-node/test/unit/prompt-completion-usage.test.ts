import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ModelUsageOutbox } from '../../src/service/model-usage-outbox.js';
import { NodeModelUsageService } from '../../src/service/model-usage-service.js';

describe('Prompt completion usage attribution', () => {
  it('records auxiliary consumption without creating or emitting a main Run event', async () => {
    const record = vi.fn();
    const service = new NodeModelUsageService(
      () => ({ record }) as unknown as ModelUsageOutbox,
      () => 'node'
    );
    const scopeId = randomUUID();
    const claims = {
      audience: 'model-usage-v1',
      scopeId,
      nodeId: 'node',
      userId: 42,
      mode: 'work',
      issuedAt: 1_000,
      expiresAt: 60_000
    };
    const grant = {
      scopeId,
      token: `${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fixture`
    };
    const observer = service.completion('auxiliary-execution', grant, 'codex-source-session', 42);
    await observer.onModelUsage?.({
      recordId: 'record',
      requestId: 'provider-request',
      revision: 1,
      modelConfigurationId: 'model',
      modelName: 'Completion',
      provider: 'openai',
      requestedModel: 'model',
      startedAt: 1_000,
      endedAt: 2_000,
      state: 'cancelled',
      inputTokens: '20'
    });
    expect(record).toHaveBeenCalledExactlyOnceWith(
      grant,
      expect.objectContaining({
        scopeId,
        runner: 'mar-agent',
        purpose: 'prompt_completion',
        agentRole: 'root',
        runId: 'auxiliary-execution',
        sessionId: 'codex-source-session',
        state: 'cancelled',
        inputTokens: '20'
      })
    );
    expect(record.mock.calls[0]![1]).not.toHaveProperty('outputTokens');
    observer.release();
    expect(() => service.completion('wrong-user', grant, 'session', 43)).toThrow(
      'PROMPT_COMPLETION_USAGE_GRANT_REQUIRED'
    );
    expect(() => service.completion('invalid', undefined, 'session')).toThrow(
      'PROMPT_COMPLETION_USAGE_GRANT_REQUIRED'
    );
  });
});
