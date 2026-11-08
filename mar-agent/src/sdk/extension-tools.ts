import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { AgentError } from '../error.js';
import type { ExtensionOperationContext } from '../extensions/operation.js';
import type { ExtensionToolBinding, ExtensionToolReferenceIndex } from '../extensions/tools.js';
import { toolCallers } from '../tools/callers.js';
import type { ClientToolDefinition, McpToolCatalog, ToolCall } from '../tools/contracts.js';
import { createRoundToolRuntimeContext, type RoundToolScope } from '../tools/execution.js';
import type { ToolRuntimeContext } from '../tools/runtime-context.js';
import { executeCapturedTool } from '../tools/runtime.js';

/**
 * Own one real Execution's sources and native-reference index.
 * Retained physical frames outlive the main round; release references only after the last one drains.
 */
export class ExecutionToolSources {
  readonly bindings: readonly ExtensionToolBinding[];
  readonly #referenceIndex: ExtensionToolReferenceIndex = { bindings: new WeakMap() };
  readonly #frame = new AsyncLocalStorage<{
    readonly context: ToolRuntimeContext;
    active: boolean;
  }>();
  #scope: RoundToolScope | undefined;
  #closed = false;
  #frames = 0;

  constructor(
    readonly executionId: string,
    readonly sessionId: string,
    definitions: readonly ClientToolDefinition[],
    builtins: readonly ClientToolDefinition[],
    catalog: McpToolCatalog,
    supplemental: readonly ExtensionToolBinding[] = []
  ) {
    this.bindings = Object.freeze([
      ...definitions.map((original): ExtensionToolBinding => {
        const captured = catalog.tools.find((tool) => tool.definition.name === original.name);
        const mcp = captured === undefined ? undefined : structuredClone(captured);
        const kind = mcp ? 'mcp' : builtins.includes(original) ? 'builtin' : 'host';
        const definition = Object.freeze({
          ...structuredClone(original),
          allowedCallers: Object.freeze([...toolCallers(original)])
        });
        return Object.freeze({
          definition,
          referenceIndex: this.#referenceIndex,
          source: Object.freeze({
            kind,
            id: mcp?.sourceIdentity ?? `${kind}:${executionId}:${definition.name}`,
            revision: mcp?.definitionRevision ?? executionId
          }),
          ...(mcp === undefined ? {} : { mcp }),
          available: (call: ExtensionOperationContext) => {
            const context = this.#context(call);
            if (!context) return false;
            if (definition.name === 'skill') return context.skills.size > 0;
            if (definition.name === 'tool_search')
              return (
                this.#currentFrame()?.searchMcpTools !== undefined || this.#scope !== undefined
              );
            return true;
          },
          invoke: async (input: ToolCall, call: ExtensionOperationContext) => {
            const context = this.#context(call);
            if (!context) throw unavailable();
            const frame = this.#currentFrame();
            const scope = this.#scope;
            const actual =
              frame ??
              (scope &&
                (await createRoundToolRuntimeContext(
                  scope,
                  { ...input, callId: input.callId ?? randomUUID() },
                  call.signal
                )));
            if (!actual || !this.#context(call)) throw unavailable();
            call.signal.throwIfAborted();
            return executeCapturedTool(kind, input, {
              ...actual,
              signal: call.signal,
              ...(mcp === undefined
                ? {}
                : {
                    expectedMcpTool: {
                      sourceIdentity: mcp.sourceIdentity,
                      definitionRevision: mcp.definitionRevision
                    }
                  })
            });
          }
        });
      }),
      ...supplemental
    ]);
  }

  bind(scope: RoundToolScope): void {
    if (
      this.#closed ||
      scope.context.executionId !== this.executionId ||
      scope.context.sessionId !== this.sessionId
    )
      throw unavailable();
    this.#scope = scope;
  }

  assertActive(): void {
    if (this.#closed) throw unavailable();
  }

  withFrame<Value>(context: ToolRuntimeContext, run: () => Value): Value {
    if (context.executionId !== this.executionId || context.sessionId !== this.sessionId)
      throw unavailable();
    // A later retained call gets a fresh index, never the refs released by an earlier frame.
    this.#referenceIndex.bindings ??= new WeakMap();
    const frame = { context, active: true };
    this.#frames++;
    const finish = () => {
      frame.active = false;
      if (--this.#frames === 0 && this.#closed) {
        this.#referenceIndex.bindings = undefined;
        this.#frame.disable();
      }
    };
    return this.#frame.run(frame, () => {
      try {
        const result = run();
        if (result instanceof Promise)
          return result.finally(() => {
            finish();
          }) as Value;
        finish();
        return result;
      } catch (error) {
        finish();
        throw error;
      }
    });
  }

  close(): void {
    this.#closed = true;
    this.#scope = undefined;
    // Retained physical callbacks may outlive the main round and must keep their own frame.
    if (this.#frames === 0) {
      this.#referenceIndex.bindings = undefined;
      this.#frame.disable();
    }
  }

  #context(call: ExtensionOperationContext): ToolRuntimeContext | undefined {
    if (call.executionId !== this.executionId || call.sessionId !== this.sessionId) return;
    const frame = this.#currentFrame();
    const context = frame ?? (this.#closed ? undefined : this.#scope?.context);
    return context && !context.signal.aborted ? context : undefined;
  }

  #currentFrame(): ToolRuntimeContext | undefined {
    const frame = this.#frame.getStore();
    return frame?.active ? frame.context : undefined;
  }
}

function unavailable(): AgentError {
  return new AgentError('MAR_AGENT_TOOL_NOT_AVAILABLE', 'Execution tool source is unavailable.');
}
