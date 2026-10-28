import type { NodeConnectorOptions } from './node-connector-options.js';
import { CodexRunner } from '../runner/codex-runner.js';
import { ClaudeCodeRunner } from '../runner/claude-code-runner.js';
import { OpenCodeRunner } from '../runner/opencode-runner.js';
import { MarAgentRunner } from '../runner/mar-agent-runner.js';
import { FakeTestRunner } from '../runner/fake-test-runner.js';
import { RunnerRegistry } from '../runner/runner-registry.js';

/** Builds the runner registry from the same concrete instances used by controllers. */
export function composeRunners(
  options: Pick<
    NodeConnectorOptions,
    | 'codexClient'
    | 'codexProfileClientFactory'
    | 'codexRunClientFactory'
    | 'claudeClient'
    | 'openCodeClient'
    | 'fakeRunner'
  >
) {
  const fake =
    options.fakeRunner === undefined ? undefined : new FakeTestRunner(options.fakeRunner);
  const codex = new CodexRunner(
    options.codexClient,
    options.codexProfileClientFactory,
    options.codexRunClientFactory
  );
  const claude = new ClaudeCodeRunner(options.claudeClient);
  const openCode = new OpenCodeRunner(options.openCodeClient);
  const marAgent = new MarAgentRunner();
  const registry = new RunnerRegistry([
    openCode,
    marAgent,
    codex,
    claude,
    ...(fake === undefined ? [] : [fake])
  ]);
  return { codex, claude, openCode, marAgent, fake, registry };
}
