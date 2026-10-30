import { executionActivity } from './support/execution-activity.js';
import { describe, expect, it, vi } from 'vitest';
import type { NodeEnvelope, MarAgentRuntimeModelConfiguration } from '@myagentroam/protocol';
import type { NodeAgentSession } from '../../src/database.js';
import { MarAgentRunner } from '../../src/runner/mar-agent-runner.js';
import { CodexRunner } from '../../src/runner/codex-runner.js';
import type { RunnerExecutionContext } from '../../src/runner/execution-context.js';
import {
  marAgentEnvelopeInput,
  resolveMarAgentExecutionInput
} from '../../src/runner/mar-agent/execution-input.js';
import { MarAgentManagedRunController } from '../../src/runner/mar-agent/managed-run-controller.js';

const model: MarAgentRuntimeModelConfiguration = {
  id: 'coding',
  name: 'Coding',
  protocol: 'ANTHROPIC_MESSAGES',
  baseUrl: 'https://example.test',
  credential: { type: 'INLINE_API_KEY', value: 'synthetic-key' },
  modelId: 'coding',
  contextWindowTokens: 200_000,
  maxOutputTokens: 4096,
  inputCapabilities: ['TEXT'],
  outputCapabilities: ['TEXT'],
  reasoningEfforts: [],
  hostedWebSearch: false,
  enabled: true
};

function fixture() {
  const runner = new MarAgentRunner();
  const emit = vi.fn();
  const controller = new MarAgentManagedRunController(runner, {
    ...executionActivity(),
    adopt: vi.fn(),
    promote: vi.fn(),
    syncTitle: vi.fn(),
    emit,
    emitItem: vi.fn(),
    run: vi.fn(),
    commandState: vi.fn(),
    setCommandState: vi.fn(),
    clearCommandState: vi.fn(),
    commandStates: vi.fn(() => []),
    webSearch: vi.fn()
  });
  const run = vi
    .spyOn(controller as unknown as { run(input: unknown): Promise<void> }, 'run')
    .mockResolvedValue();
  return { runner, controller, emit, run };
}

describe('Runner execution input boundary', () => {
  it('keeps the discriminator exclusive and drops foreign configuration for other Runners', () => {
    const input = { model, models: [model] };
    // @ts-expect-error MAR execution data cannot be attached to Codex.
    const invalid: RunnerExecutionContext = { runner: 'codex', runnerInput: input };
    expect(invalid.runner).toBe('codex');
    expect(new CodexRunner().prepareExecutionContext({ marAgentModel: model })).toEqual({
      runner: 'codex'
    });
  });

  it('snapshots all MAR values without parsing and preserves model list precedence', () => {
    const wire = {
      marAgentModel: structuredClone(model),
      marAgentModels: [{ ...model, modelId: 'catalog-first' }, null, { id: 'invalid' }],
      marAgentCompact: { model: { ...model, id: 'compact', modelId: 'coding' }, enabled: true },
      marAgentRuntimeScopeId: 'scope-before'
    };
    const context = new MarAgentRunner().prepareExecutionContext(wire);
    wire.marAgentModel.modelId = 'mutated';
    wire.marAgentModels.length = 0;
    wire.marAgentCompact.model.modelId = 'mutated';
    wire.marAgentRuntimeScopeId = 'scope-after';
    const resolved = resolveMarAgentExecutionInput(marAgentEnvelopeInput(context), 'coding');
    expect(resolved).toMatchObject({
      model: { modelId: 'coding' },
      models: [{ modelId: 'catalog-first' }],
      compact: { model: { id: 'compact', modelId: 'coding' }, enabled: true },
      runtimeScopeId: 'scope-before'
    });
    expect(resolved?.models).toHaveLength(1);
    const next = new MarAgentRunner().prepareExecutionContext(wire);
    expect(resolveMarAgentExecutionInput(marAgentEnvelopeInput(next), 'coding')).toMatchObject({
      model: { modelId: 'mutated' },
      runtimeScopeId: 'scope-after'
    });
  });

  it.each([undefined, null, {}, { ...model, id: 'other' }])(
    'retains invalid input until run rejection and command refusal: %j',
    async (value) => {
      const { runner, controller, emit, run } = fixture();
      const executionContext = runner.prepareExecutionContext({ marAgentModel: value });
      expect(emit).not.toHaveBeenCalled();
      controller.start({
        payload: {
          ...executionContext,
          runId: 'invalid-run',
          sessionId: 'session',
          cwd: '/workspace',
          input: 'accepted input',
          model: 'coding'
        }
      } as NodeEnvelope);
      expect(emit).toHaveBeenCalledWith(
        'invalid-run',
        'run.rejected',
        { code: 'MAR_AGENT_MODEL_CONFIG_INVALID' },
        'FAILED'
      );
      await expect(
        controller.executeCommand(
          { id: 'session', modelId: 'coding', nativeControl: 'MAR_MANAGED' } as NodeAgentSession,
          { id: 'compact' } as never,
          '/compact',
          { secretEnvironment: {}, executionContext }
        )
      ).rejects.toThrow('RUNNER_COMMAND_UNAVAILABLE');
      expect(run).not.toHaveBeenCalled();
    }
  );
});
