import { describe, expect, it } from 'vitest';
import {
  captureRestartExecution,
  openRestartState,
  sealRestartState
} from '../../src/service/restart-execution-state.js';
import type { PreparedExecutionInput } from '../../src/service/continuous-run-coordinator.js';

const credential = 'test-node-credential';
const secret = 'inline-model-api-key-do-not-log';
const usageToken = 'usage-grant-token-do-not-log';

function preparedInput(): PreparedExecutionInput {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    input: 'resume this task',
    attachments: [],
    attachmentPaths: [],
    cwd: '/workspace',
    externalSessionId: 'native-session-1',
    modelId: 'model-1',
    effort: 'high',
    access: 'full-access',
    collaborationMode: 'default',
    secretEnvironment: { MODEL_API_SECRET: 'mcp-secret-do-not-log' },
    personalInstructions: 'private per-user instructions',
    executionContext: {
      runner: 'mar-agent',
      runnerInput: {
        model: {
          id: 'model-1',
          credential: { type: 'INLINE_API_KEY', value: secret }
        },
        models: [{ id: 'model-1' }],
        compact: { enabled: true, modelId: 'compact-1' },
        runtimeScopeId: 'runtime-scope-1'
      }
    },
    usageGrant: {
      scopeId: '00000000-0000-4000-8000-000000000001',
      token: usageToken
    }
  };
}

describe('restart execution state', () => {
  it('captures the original execution context, environment, usage grant, and optional attribution', () => {
    const input = preparedInput();
    const captured = captureRestartExecution(input, 41);

    expect(captured).toEqual({
      executionContext: input.executionContext,
      secretEnvironment: input.secretEnvironment,
      personalInstructions: input.personalInstructions,
      usageGrant: input.usageGrant,
      initiatedByUserId: 41
    });
    expect(captured?.executionContext).not.toBe(input.executionContext);

    const withoutAttribution = captureRestartExecution(input);
    expect(withoutAttribution).toMatchObject({
      executionContext: input.executionContext,
      secretEnvironment: input.secretEnvironment,
      personalInstructions: input.personalInstructions,
      usageGrant: input.usageGrant
    });
    expect(withoutAttribution).not.toHaveProperty('initiatedByUserId');
    expect(captureRestartExecution(undefined)).toBeUndefined();
  });

  it('round-trips a sealed execution state without exposing its contents', () => {
    const state = captureRestartExecution(preparedInput(), 41)!;
    const sealed = sealRestartState(state, credential);

    expect(sealed).not.toContain(secret);
    expect(sealed).not.toContain(usageToken);
    expect(openRestartState(sealed, credential)).toEqual(state);
  });

  it('uses a fresh nonce for each sealing operation', () => {
    const state = captureRestartExecution(preparedInput());
    const first = JSON.parse(sealRestartState(state, credential)) as { nonce: string };
    const second = JSON.parse(sealRestartState(state, credential)) as { nonce: string };

    expect(first.nonce).not.toBe(second.nonce);
  });

  it('rejects a sealed state opened with the wrong Node credential', () => {
    const sealed = sealRestartState(captureRestartExecution(preparedInput()), credential);

    expect(() => openRestartState(sealed, 'different-node-credential')).toThrow();
  });

  it('rejects authenticated ciphertext tampering', () => {
    const sealed = JSON.parse(
      sealRestartState(captureRestartExecution(preparedInput()), credential)
    ) as { ciphertext: string };
    const ciphertext = Buffer.from(sealed.ciphertext, 'base64');
    ciphertext[0] = ciphertext[0]! ^ 1;
    sealed.ciphertext = ciphertext.toString('base64');

    expect(() => openRestartState(JSON.stringify(sealed), credential)).toThrow();
  });
});
