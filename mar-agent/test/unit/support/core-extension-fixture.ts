import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalAgentHost } from '../../../src/host.js';
import { SecretValue, type AgentModelConfiguration } from '../../../src/index.js';
import { createAgentWithAdapter } from '../../../src/sdk/agent.js';
import type { Agent } from '../../../src/sdk/types.js';
import type { ModelAdapter, ModelEvent, ModelRequest } from '../../../src/model/contracts.js';
import type { ExtensionSnapshot, AgentExtension } from '../../../src/extensions/contracts.js';

const model: AgentModelConfiguration = {
  id: 'test',
  name: 'Test',
  protocol: 'ANTHROPIC_MESSAGES',
  baseUrl: 'https://example.test',
  apiKey: new SecretValue('test'),
  modelId: 'test',
  contextWindowTokens: 200_000,
  maxOutputTokens: 4096,
  inputCapabilities: ['TEXT'],
  outputCapabilities: ['TEXT'],
  reasoningEfforts: [],
  defaultReasoningEffort: 'medium',
  titleGeneration: false,
  codeMode: false,
  hostedWebSearch: false,
  responsesPreviousResponseId: false,
  enabled: true
};
export const agents: Agent[] = [];
export const homes: string[] = [];
export async function cleanupCoreFixtures() {
  const results = await Promise.allSettled(agents.splice(0).map((agent) => agent.dispose()));
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}
class Adapter implements ModelAdapter {
  readonly requests: ModelRequest[] = [];
  constructor(
    readonly configuration: AgentModelConfiguration,
    readonly script: (request: ModelRequest, index: number) => ModelEvent[]
  ) {}
  async *start(request: ModelRequest, _signal: AbortSignal): AsyncIterable<ModelEvent> {
    const index = this.requests.length;
    this.requests.push(request);
    yield* this.script(request, index);
  }
}
export const answer = (): ModelEvent[] => [
  { type: 'text.completed', itemId: 'answer', text: 'done' },
  { type: 'completed', reason: 'completed' }
];
export const call = (name: string, args: unknown): ModelEvent[] => [
  { type: 'client_tool.call', callId: 'call', name, arguments: args },
  { type: 'completed', reason: 'tool_use' }
];
export async function fixture(
  extensions:
    | readonly AgentExtension[]
    | { resolve(input: { signal: AbortSignal }): Promise<ExtensionSnapshot> },
  script: Adapter['script'],
  codeMode = false,
  retainAdapter = false,
  hostOptions: Pick<
    ConstructorParameters<typeof LocalAgentHost>[0],
    | 'network'
    | 'approval'
    | 'modelUsage'
    | 'processExecutor'
    | 'environment'
    | 'mcp'
    | 'operationTools'
    | 'beforeOperationToolExecute'
    | 'beforeToolExecute'
    | 'mcpTools'
    | 'mcpCatalog'
    | 'callMcpOperation'
    | 'extensions'
    | 'callMcp'
  > = {},
  protocol: AgentModelConfiguration['protocol'] = model.protocol,
  inputCapabilities: AgentModelConfiguration['inputCapabilities'] = model.inputCapabilities
) {
  const home = await mkdtemp(join(tmpdir(), 'mar-core-sdk-'));
  homes.push(home);
  await writeFile(join(home, 'input.txt'), 'extension-data');
  const adapter = new Adapter({ ...model, codeMode, protocol, inputCapabilities }, script);
  if (retainAdapter)
    Object.assign(adapter, {
      createTurnSession: () => ({ start: adapter.start.bind(adapter), close: async () => {} })
    });
  const host = new LocalAgentHost({ ...hostOptions, homeDirectory: home, workspace: home });
  const agent = await createAgentWithAdapter(
    {
      mode: 'normal',
      host,
      models: [adapter.configuration],
      extensions: extensions
    },
    () => adapter
  );
  agents.push(agent);
  const session = await agent.createSession({ workspace: home, title: 'Extension test' });
  return { agent, session, adapter, home, host };
}
