import { describe, expect, it, vi } from 'vitest';
import {
  agentNetworkExecutionCommand,
  executionAgentActor
} from '../../src/service/agent-network-invoke.js';
import type { NodeRuntimeState } from '../../src/runtime-state.js';
import type { ContinuousRunCoordinator } from '../../src/service/continuous-run-coordinator.js';
import type {
  AgentNetworkActor,
  AgentNetworkService
} from '../../src/service/agent-network-service.js';
import type { AgentNetworkObservations } from '../../src/service/agent-network-observations.js';
import { captureMarAgentExecutionInput } from '../../src/runner/mar-agent/execution-input.js';

function fixture(available?: boolean) {
  const runtime = {
    getAgentSessionById: () => ({ id: 's', workspaceId: 'w' }),
    getAgentSession: () => ({ id: 's', workspaceId: 'w' }),
    executionSnapshot: () => ({ sessionId: 's', runId: 'r', status: 'RUNNING' }),
    getRun: () => ({ id: 'r', initiatedByUserId: 7 }),
    activeSessionRun: () => ({ id: 'r' }),
    currentExecutionId: () => 'e'
  } as unknown as NodeRuntimeState;
  const coordinator = {
    pending: () => ({
      sessionId: 's',
      executionContext: { runner: 'mar-agent', runnerInput: { searchBackendAvailable: available } }
    })
  } as unknown as ContinuousRunCoordinator<unknown>;
  const start = vi.fn(async (_actor: AgentNetworkActor) => ({}));
  const command = agentNetworkExecutionCommand({
    runtime,
    coordinator,
    service: { start } as unknown as AgentNetworkService,
    observations: { attach: () => ({ close: () => {} }) } as unknown as AgentNetworkObservations
  });
  return { runtime, coordinator, start, command };
}

describe('Agent Network search projection', () => {
  it('retains the caller execution search snapshot for native children', () => {
    const f = fixture(false);
    const actor = executionAgentActor({ ...f, sessionId: 's', executionId: 'e' });
    expect(captureMarAgentExecutionInput(actor.runnerConfiguration ?? {})).toHaveProperty(
      'searchBackendAvailable',
      false
    );
  });

  it('retains the Server search projection for terminal callers', async () => {
    const f = fixture();
    await f.command({
      workspaceId: 'w',
      action: 'start',
      input: { title: 'child', content: 'work' },
      __requestUserId: 7,
      __marctlCaller: { type: 'terminal' },
      searchBackendAvailable: false
    });
    const actor = f.start.mock.calls[0]![0];
    expect(captureMarAgentExecutionInput(actor.runnerConfiguration ?? {})).toHaveProperty(
      'searchBackendAvailable',
      false
    );
  });

  it('uses the trusted Server projection for a marctl execution target', async () => {
    const f = fixture(true);
    await f.command({
      workspaceId: 'w',
      action: 'start',
      input: { title: 'child', content: 'work' },
      __requestUserId: 7,
      __marctlCaller: { type: 'execution', sessionId: 's', executionId: 'e' },
      __marctlExecutionResources: { searchBackendAvailable: false }
    });
    const actor = f.start.mock.calls[0]![0];
    expect(captureMarAgentExecutionInput(actor.runnerConfiguration ?? {})).toHaveProperty(
      'searchBackendAvailable',
      false
    );
  });
});
