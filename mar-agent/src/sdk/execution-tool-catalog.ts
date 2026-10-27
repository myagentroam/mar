import { createHash } from 'node:crypto';
import { AgentError } from '../error.js';
import { coreMcpCatalog } from '../extensions/mcp.js';
import type { ExtensionToolBinding } from '../extensions/tools.js';
import type { AgentHost } from '../host/contracts.js';
import type {
  ClientToolDefinition,
  McpToolCatalog,
  McpToolCatalogContext
} from '../tools/contracts.js';
import { assertMcpToolCatalog } from '../tools/mcp/catalog.js';
import { DeferredMcpRegistry } from '../tools/mcp/tool-search.js';
import { discoveredMcpToolNames, rebindMcpToolSearchOutputs } from '../tools/mcp/history.js';
import { BUILTIN_TOOL_DEFINITIONS } from '../tools/registry.js';
import { agentStartToolDefinitionWithModels } from '../tools/agent/agent-start.js';
import { toolCallers } from '../tools/callers.js';
import type { SessionModelMessage } from '../session/model-request.js';
import type { ExecutionMode } from './types.js';
import type { ResolvedModelConfiguration } from './model-runtime.js';
import { ExecutionToolSources } from './extension-tools.js';

/** Initializes one Execution's catalog before Extension attachment owns its bindings. */
export async function initializeExecutionToolCatalog(input: {
  host: Pick<AgentHost, 'listMcpToolCatalog' | 'listMcpTools' | 'listExecutionExtensions'>;
  context: McpToolCatalogContext;
  models: ReadonlyMap<string, ResolvedModelConfiguration>;
  messages: SessionModelMessage[];
  supplemental(names: ReadonlySet<string>): readonly ExtensionToolBinding[];
}) {
  const { host, context } = input;
  let catalog: McpToolCatalog;
  if (host.listMcpToolCatalog) {
    catalog = await host.listMcpToolCatalog(context);
    assertMcpToolCatalog(catalog);
  } else {
    const definitions = (await host.listMcpTools?.(context)) ?? [];
    catalog = {
      revision: createHash('sha256').update(JSON.stringify(definitions)).digest('hex'),
      servers: [{ id: 'legacy', name: 'External MCP' }],
      tools: definitions.map((definition) => ({
        definition,
        serverId: 'legacy',
        rawName: definition.name,
        sourceIdentity: `legacy:${context.executionId}`,
        definitionRevision: createHash('sha256').update(JSON.stringify(definition)).digest('hex'),
        lifetime: 'execution',
        exposure: 'deferred'
      }))
    };
  }
  const registry = new DeferredMcpRegistry(discoveredMcpToolNames(input.messages));
  const extensions = (await host.listExecutionExtensions?.(context)) ?? {};
  if (extensions.tools?.some((tool) => tool.name.startsWith('mcp__')))
    throw new AgentError(
      'MAR_AGENT_TOOL_INPUT_INVALID',
      'Host tools cannot use the MCP namespace.'
    );
  const builtins = BUILTIN_TOOL_DEFINITIONS.map((tool) =>
    tool.name === 'agent_start'
      ? agentStartToolDefinitionWithModels(
          [...input.models.values()]
            .filter((configuration) => configuration.conversationModel !== false)
            .map(({ id, name, reasoningEfforts }) => ({ id, name, reasoningEfforts }))
        )
      : tool
  );
  const tools = [
    ...builtins,
    ...(extensions.tools ?? []),
    ...catalog.tools.map((tool) => tool.definition)
  ];
  const names = new Set(tools.map((tool) => tool.name));
  if (names.size !== tools.length)
    throw new AgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Tool names conflict.');
  const supplemental = input.supplemental(names);
  const sources = new ExecutionToolSources(
    context.executionId,
    context.sessionId,
    tools,
    builtins,
    catalog,
    supplemental
  );
  return { catalog, registry, extensions, supplemental, sources };
}

/** Owns the live MCP projection while source identities remain tied to one Execution. */
export class ExecutionToolCatalog {
  #tools: readonly ClientToolDefinition[] = [];
  constructor(
    private readonly input: {
      catalog: McpToolCatalog;
      registry: DeferredMcpRegistry;
      messages: SessionModelMessage[];
      model: ResolvedModelConfiguration;
      child: boolean;
      mode: ExecutionMode;
      codeExecute: boolean;
      capture(): ReadonlyMap<string, ExtensionToolBinding>;
      servers(): McpToolCatalog['servers'];
      hasSkills(): boolean;
    }
  ) {}
  eligible(tool: ClientToolDefinition): boolean {
    toolCallers(tool);
    if (
      this.input.child &&
      (tool.agentScope === 'ROOT_ONLY' ||
        tool.name.startsWith('agent_') ||
        tool.name === 'question')
    )
      return false;
    if (tool.name === 'tool_search') return this.input.registry.hasDeferred;
    return tool.name === 'code_exec' || tool.name === 'code_exec_wait'
      ? this.input.model.codeMode && this.input.codeExecute
      : tool.name === 'question'
        ? this.input.mode === 'plan'
        : tool.name !== 'view_image' || this.input.model.inputCapabilities.includes('IMAGE');
  }
  updateRegistry(): void {
    this.input.registry.update(
      coreMcpCatalog(
        [...this.input.catalog.servers, ...this.input.servers()],
        this.input.capture()
      ),
      (tool) => this.eligible(tool.definition),
      { nativeToolNames: true }
    );
  }
  available(): ClientToolDefinition[] {
    return [...this.input.capture().values()]
      .map((binding) => binding.definition)
      .filter((tool) => this.eligible(tool));
  }
  base(): ClientToolDefinition[] {
    return [...this.input.capture().values()]
      .filter((binding) => binding.mcp === undefined)
      .map((binding) => binding.definition)
      .filter((tool) => this.eligible(tool) && (tool.name !== 'skill' || this.input.hasSkills()));
  }
  refresh(): void {
    this.#tools = this.input.registry.project(this.base());
  }
  get tools(): readonly ClientToolDefinition[] {
    return this.#tools;
  }
  restore(): void {
    this.input.registry.restore(discoveredMcpToolNames(this.input.messages));
    rebindMcpToolSearchOutputs(this.input.messages, this.input.registry);
    this.refresh();
  }
}
