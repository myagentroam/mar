import { vi } from 'vitest';
import * as sessionSdk from '../../../src/agent-core/sdk/session.js';
import {
  ExecutionLoop,
  type ExecutionLoopInput
} from '../../../src/agent-core/runtime/execution.js';

/** Observe the real SDK's existing owner and loop input without replacing their behavior. */
export function captureExecutionContext() {
  let registry!: sessionSdk.AgentSessionRegistry;
  let loopInput!: ExecutionLoopInput;
  const open = sessionSdk.createSessionOpener;
  vi.spyOn(sessionSdk, 'createSessionOpener').mockImplementation((services) => {
    registry = services.registry;
    return open(services);
  });
  const run = ExecutionLoop.prototype.run;
  vi.spyOn(ExecutionLoop.prototype, 'run').mockImplementation(function (this: ExecutionLoop) {
    loopInput = (this as unknown as { input: ExecutionLoopInput }).input;
    return run.call(this);
  });
  return {
    runtime: (sessionId: string) => registry.sessionRuntimes.get(sessionId)!,
    messages: () => loopInput.messages
  };
}
