import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalAgentHost } from '../../../mar-agent/dist/host.js';
import { SecretValue, type AgentModelConfiguration } from '@myagentroam/agent';
import { createAgentWithAdapter } from '../../../mar-agent/dist/sdk/agent.js';
import type { ModelEvent } from '../../../mar-agent/dist/model/contracts.js';
import { NodeRuntimeState } from '../../src/runtime-state.js';
import { createNodeAgentNetwork } from '../../src/service/agent-network-bindings.js';
import { AgentNetworkObservations } from '../../src/service/agent-network-observations.js';
import { executionAgentActor, invokeAgentNetwork } from '../../src/service/agent-network-invoke.js';
import type { ContinuousRunCoordinator } from '../../src/service/continuous-run-coordinator.js';
import { agentNetworkExtension } from '../../src/runner/mar-agent/agent-network-extension.js';

function fixture() {
  const runtime = new NodeRuntimeState(
    () => 'node',
    (id) => ({ id, path: '/workspace', kind: 'DIRECTORY', gitSummary: null })
  );
  const parent = runtime.createAgentSession({
    workspaceId: 'workspace',
    runner: 'mar-agent',
    cwd: '/workspace'
  });
  const child = runtime.createAgentSession({
    workspaceId: 'workspace',
    runner: 'mar-agent',
    cwd: '/workspace',
    parentSessionId: parent.id
  });
  const observations = new AgentNetworkObservations();
  const ensureObservations = vi.fn(
    () => observations.get(parent.id) ?? observations.attach(parent.id)
  );
  const records = vi.fn(() => [child]);
  const service = createNodeAgentNetwork({
    runtime,
    observations,
    projection: { resolve: vi.fn(async () => undefined) },
    database: () => ({ listChildSessionRecords: records }),
    ensureObservations
  } as unknown as Parameters<typeof createNodeAgentNetwork>[0]);
  const actor = { sessionId: parent.id, requestUserId: 7 };
  const start = () => {
    const { run } = runtime.createMessageRun({
      sessionId: child.id,
      content: 'work',
      clientMessageId: 'first',
      initiatedByUserId: 7
    });
    return run;
  };
  return {
    runtime,
    parent,
    child,
    observations,
    ensureObservations,
    records,
    service,
    actor,
    start
  };
}

describe('Agent Network wait diagnostics', () => {
  it.each([0, 300_000])(
    'reports an idle target without entering a wait (%s ms)',
    async (waitMs) => {
      const f = fixture();
      await expect(f.service.wait(f.actor, { agentId: f.child.id, waitMs })).rejects.toMatchObject({
        code: 'AGENT_IDLE',
        publicMessage: 'Agent is idle; there is no execution to wait for.',
        details: { agentIds: [f.child.id], status: 'IDLE' }
      });
      expect(f.ensureObservations).not.toHaveBeenCalled();
      expect(f.runtime.activeSessionRun(f.child.id)).toBeUndefined();
    }
  );

  it('identifies idle members before subscribing to a mixed batch', async () => {
    const f = fixture();
    const run = f.start();
    const idle = f.runtime.createAgentSession({
      workspaceId: 'workspace',
      runner: 'mar-agent',
      cwd: '/workspace',
      parentSessionId: f.parent.id
    });
    await expect(
      f.service.wait(f.actor, { agentIds: [f.child.id, idle.id] })
    ).rejects.toMatchObject({
      code: 'AGENT_IDLE',
      details: { agentIds: [idle.id], status: 'IDLE' }
    });
    expect(f.ensureObservations).not.toHaveBeenCalled();
    expect(f.runtime.activeSessionRun(f.child.id)?.id).toBe(run.id);
  });

  it('distinguishes an empty child set from idle children', async () => {
    const f = fixture();
    await expect(f.service.wait(f.actor, {})).rejects.toMatchObject({
      code: 'AGENT_IDLE',
      publicMessage: `Agent is idle; there is no execution to wait for. Idle agent IDs: ${f.child.id}.`
    });
    f.records.mockReturnValue([]);
    await expect(f.service.wait(f.actor, {})).rejects.toMatchObject({
      code: 'AGENT_WAIT_NO_TARGETS',
      publicMessage: 'There are no child agents to wait for.'
    });
    expect(f.ensureObservations).not.toHaveBeenCalled();
  });

  it('does not confuse a missing target or inactive caller with an idle target', async () => {
    const f = fixture();
    await expect(f.service.wait(f.actor, { agentId: 'missing' })).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
      publicMessage: 'The target agent session was not found in this Workspace.'
    });
    expect(() =>
      executionAgentActor({
        sessionId: f.parent.id,
        executionId: 'expired',
        runtime: f.runtime,
        coordinator: { pending: () => undefined } as unknown as ContinuousRunCoordinator<unknown>
      })
    ).toThrow(
      expect.objectContaining({
        code: 'AGENT_ACTOR_NOT_ACTIVE',
        publicMessage: 'The calling agent execution is no longer active.'
      })
    );
    expect(f.ensureObservations).not.toHaveBeenCalled();
  });

  it('keeps a starting Run without an Execution waitable', async () => {
    const f = fixture();
    const run = f.start();
    expect(await f.service.wait(f.actor, { agentId: f.child.id, waitMs: 0 })).toMatchObject({
      agentId: f.child.id,
      runId: run.id,
      status: 'STARTING',
      waitOutcome: 'snapshot'
    });
  });

  it('preserves validation, ownership and observation errors instead of reporting idle', async () => {
    const f = fixture();
    await expect(f.service.wait(f.actor, { waitMs: 300_001 })).rejects.toMatchObject({
      code: 'AGENT_WAIT_INVALID'
    });
    await expect(
      f.service.wait({ ...f.actor, runId: 'expired' }, { agentId: f.child.id })
    ).rejects.toMatchObject({
      code: 'AGENT_ACTOR_INVALID'
    });
    const run = f.start();
    await expect(
      f.service.wait({ ...f.actor, requestUserId: 8 }, { agentId: f.child.id })
    ).rejects.toMatchObject({
      code: 'RUN_OWNED_BY_ANOTHER_USER',
      publicMessage: 'The run belongs to another user.'
    });
    vi.spyOn(f.observations, 'get').mockReturnValue(undefined);
    await expect(f.service.wait(f.actor, { agentId: f.child.id })).rejects.toMatchObject({
      code: 'AGENT_OBSERVATION_UNAVAILABLE'
    });
    expect(f.runtime.activeSessionRun(f.child.id)?.id).toBe(run.id);
  });

  it('returns retained completion even though the Session has become idle', async () => {
    const f = fixture();
    const run = f.start();
    const execution = f.runtime.createExecution(run.id);
    f.runtime.appendRunEvent({
      runId: execution.id,
      sequence: 1,
      eventType: 'run.completed',
      payload: {},
      status: 'SUCCEEDED'
    });
    f.runtime.finishRun(run.id, 'SUCCEEDED');
    expect(f.runtime.activeSessionRun(f.child.id)).toBeUndefined();
    expect(await f.service.wait(f.actor, { agentId: f.child.id })).toMatchObject({
      agentId: f.child.id,
      runId: run.id,
      executionId: execution.id,
      status: 'SUCCEEDED',
      waitOutcome: 'completion'
    });
  });

  it('does not relabel loss of a frozen execution as idle or silently time out', async () => {
    const f = fixture();
    const run = f.start();
    const execution = f.runtime.createExecution(run.id);
    await expect(
      f.service.wait(f.actor, { agentId: f.child.id, waitMs: 0 }, async () => {
        vi.spyOn(f.runtime, 'executionSnapshot').mockReturnValue(undefined);
      })
    ).rejects.toMatchObject({
      code: 'AGENT_EXECUTION_NOT_FOUND',
      publicMessage: 'The execution selected for this wait is no longer available.',
      details: { agentId: f.child.id, runId: run.id, executionId: execution.id }
    });
  });

  it('releases an active wait when its fixed execution becomes unavailable', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const run = f.start();
      const execution = f.runtime.createExecution(run.id);
      const pending = f.service.wait(f.actor, { agentId: f.child.id, waitMs: 300_000 });
      const checked = expect(pending).rejects.toMatchObject({ code: 'AGENT_EXECUTION_NOT_FOUND' });
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);
      vi.spyOn(f.runtime, 'executionSnapshot').mockReturnValue(undefined);
      f.observations.publishChild({
        parentId: f.parent.id,
        childId: f.child.id,
        runId: run.id,
        executionId: execution.id,
        kind: 'terminal',
        value: 'FAILED'
      });
      await checked;
      expect(vi.getTimerCount()).toBe(0);
      expect(f.runtime.activeSessionRun(f.child.id)?.id).toBe(run.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { nested: false, batch: false },
    { nested: true, batch: false },
    { nested: false, batch: true },
    { nested: true, batch: true }
  ])(
    'preserves idle diagnostics through the SDK tool boundary (nested=$nested, batch=$batch)',
    async ({ nested, batch }) => {
      const f = fixture();
      const idle = batch
        ? f.runtime.createAgentSession({
            workspaceId: 'workspace',
            runner: 'mar-agent',
            cwd: '/workspace',
            parentSessionId: f.parent.id
          })
        : f.child;
      if (batch) f.start();
      const input = batch
        ? { agentIds: [f.child.id, idle.id], waitMs: 300_000 }
        : { agentIds: [idle.id], waitMs: 300_000 };
      const directory = await mkdtemp(join(tmpdir(), 'mar-agent-wait-error-'));
      const configuration: AgentModelConfiguration = {
        id: 'fixture',
        name: 'Fixture',
        protocol: 'OPENAI_RESPONSES',
        baseUrl: 'https://example.test',
        apiKey: new SecretValue('fixture-secret'),
        modelId: 'fixture',
        contextWindowTokens: 200_000,
        maxOutputTokens: 4096,
        inputCapabilities: ['TEXT'],
        outputCapabilities: ['TEXT'],
        reasoningEfforts: [],
        titleGeneration: false,
        codeMode: nested,
        hostedWebSearch: false,
        responsesPreviousResponseId: false,
        enabled: true
      };
      let requests = 0;
      const agent = await createAgentWithAdapter(
        {
          mode: 'node',
          host: new LocalAgentHost({
            mode: 'node',
            homeDirectory: directory,
            workspace: directory
          }),
          models: [configuration],
          extensions: [
            agentNetworkExtension(
              (_execution, action, input, context, onResolved) =>
                invokeAgentNetwork(
                  f.service,
                  f.actor,
                  action,
                  input,
                  context,
                  undefined,
                  onResolved
                ),
              () => 'execution'
            )
          ]
        },
        () => ({
          configuration,
          async *start(): AsyncIterable<ModelEvent> {
            if (requests++ === 0) {
              yield {
                type: 'client_tool.call',
                callId: 'wait-call',
                name: nested ? 'code_exec' : 'agent_wait',
                arguments: nested
                  ? { code: `await tools.agent_wait(${JSON.stringify(input)});` }
                  : input
              };
              yield { type: 'completed', reason: 'tool_use' };
            } else {
              yield { type: 'text.completed', itemId: 'answer', text: 'The target is idle.' };
              yield { type: 'completed', reason: 'completed' };
            }
          }
        })
      );
      try {
        const session = await agent.createSession({ workspace: directory });
        const execution = session.run({ prompt: 'Check the target.' });
        const failures = [];
        for await (const event of execution) if (event.type === 'tool.failed') failures.push(event);
        expect(await execution.result()).toMatchObject({ status: 'completed' });
        expect(failures).toContainEqual(
          expect.objectContaining({
            toolName: 'agent_wait',
            code: 'AGENT_IDLE',
            message: `Agent is idle; there is no execution to wait for. Idle agent IDs: ${idle.id}.`
          })
        );
        expect(failures.every((event) => event.code !== 'MAR_AGENT_HOST_OPERATION_FAILED')).toBe(
          true
        );
      } finally {
        await agent.dispose();
        await rm(directory, { recursive: true, force: true });
      }
    }
  );
});
