import { AgentError } from '../error.js';
import type { ToolCall, ToolExecutionResult } from '../tools/contracts.js';
import type { ExtensionToolRuntime } from './tool-runtime.js';
import type {
  ExtensionDomainFacts,
  ExtensionDomainOperations,
  ExtensionDiagnostic,
  AgentExtension,
  SessionExtensionContext,
  ExtensionCapabilitySnapshot
} from './contracts.js';
import { ExtensionHooks } from './hooks.js';
import type { ExtensionPromptComposition } from './prompt-composition.js';
import { ExtensionPrompts } from './prompts.js';
import type { ExtensionModelEvent } from './model-stream.js';
import { bindCoreFiles } from './files.js';
import { bindCoreNetwork } from './network.js';
import { ExtensionMcp } from './mcp.js';
import { bindCoreProcesses } from './processes.js';
import { bindCoreEnvironment } from './environment.js';
import { bindCoreSettings, coreSettingsBinding, settingsCapabilities } from './settings.js';
import type { AgentHostExtensionPorts } from './host-ports.js';
import { ExtensionOperations, type ExtensionOperationContext } from './operation.js';
import { ExtensionResourceScope } from './resources.js';
import { ExtensionServices } from './services.js';
import type { ExtensionToolBinding } from './tools.js';
import { ExtensionSessionTools } from './session-tools.js';
import { bindCoreModels, type ExtensionModelsBackend } from './models.js';
import {
  bindCoreData,
  ExtensionState,
  type ExtensionCheckpointBackend,
  type ExtensionStoreBackend
} from './data.js';
import type { ExtensionSessionBackend } from './session-input.js';
import { bindCoreSession } from './session-api.js';
import { ExtensionCommands } from './commands.js';

/** Session-local definitions and facades; SDK supplies real Host sources for each operation. */
export class ExtensionSession {
  isEnding = false;
  readonly mcp: ExtensionMcp;
  readonly hooks: ExtensionHooks<ExtensionDomainOperations, ExtensionDomainFacts>;
  readonly services: ExtensionServices;
  readonly #commands = new ExtensionCommands((call, callback) =>
    this.operations.callback(call, callback)
  );
  readonly #promptDomain: ExtensionPrompts;
  readonly scopes: ExtensionResourceScope[] = [];
  readonly #toolDomain: ExtensionSessionTools;
  #references = 0;
  #retired = false;
  #ready = false;

  /** The SDK calls this after admission, outside the composition manager's serial lane. */
  async ready(call: ExtensionOperationContext): Promise<void> {
    this.assertLive();
    call.signal.throwIfAborted();
    if (this.#ready) return;
    // Mark before dispatch so nested work cannot recursively initialize the same generation.
    this.#ready = true;
    await this.hooks.emit('session.ready', { sessionId: this.id }, call);
  }

  assertLive(): void {
    if (this.#retired)
      throw new AgentError('MAR_AGENT_TOOL_NOT_AVAILABLE', 'Session runtime is retired.');
  }

  retire(): void {
    this.#retired = true;
    for (const scope of this.scopes) scope.retire();
  }

  get hasReferences(): boolean {
    return this.#references > 0;
  }
  pin(): () => void {
    this.assertLive();
    this.#references++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.#references--;
      }
    };
  }
  constructor(
    readonly toolRuntime: ExtensionToolRuntime,
    readonly id: string,
    readonly epoch: number,
    agentServices: ExtensionServices,
    readonly operations: ExtensionOperations,
    readonly capabilities: ExtensionCapabilitySnapshot,
    readonly diagnose: (diagnostic: ExtensionDiagnostic) => void,
    readonly baseTools: (
      context?: ExtensionOperationContext
    ) => readonly ExtensionToolBinding[] = () => [],
    readonly models?: ExtensionModelsBackend,
    readonly checkpoint?: ExtensionCheckpointBackend,
    readonly sessionBackend?: ExtensionSessionBackend,
    readonly hostPorts?: AgentHostExtensionPorts,
    readonly allowTool: (
      name: string,
      definition?: ExtensionToolBinding['definition']
    ) => boolean = () => true,
    readonly scheduleTool: <T>(
      definition: ExtensionToolBinding['definition'],
      run: () => Promise<T>
    ) => Promise<T> = (_definition, run) => run(),
    readonly store?: ExtensionStoreBackend
  ) {
    this.services = new ExtensionServices('session', agentServices);
    this.hooks = new ExtensionHooks(diagnose, (call, callback, settled) =>
      this.operations.callback(call, callback, settled)
    );
    this.#promptDomain = new ExtensionPrompts(this.hooks, () => this.assertLive());
    this.#toolDomain = new ExtensionSessionTools(
      this.toolRuntime,
      this.operations,
      this.hooks,
      this.baseTools,
      this.allowTool,
      this.scheduleTool,
      () => this.assertLive(),
      () => this.#retired
    );
    this.mcp = new ExtensionMcp(
      this.#toolDomain.tools,
      this.hooks,
      (call) => this.capture(call, false, this.baseTools(call)),
      (binding) => this.#toolDomain.toolRef(binding),
      (ref) => this.#toolDomain.isMcp(ref),
      (input, call) =>
        this.#toolDomain.invoke(input, call, this.#toolDomain.invocationSnapshot(input, call)),
      () => this.diagnose({ code: 'MAR_AGENT_MCP_CLEANUP_FAILED', sessionId: this.id }),
      (catalog) => this.toolRuntime.validateMcpCatalog(catalog)
    );
  }

  context(extension: AgentExtension, scope: ExtensionResourceScope): SessionExtensionContext {
    const instanceId = scope.instanceId;
    const settings = coreSettingsBinding(extension.bindings);
    if (this.sessionBackend) scope.effect(() => this.sessionBackend!.own(instanceId));
    const state = new ExtensionState(
      scope,
      () =>
        this.diagnose({
          code: 'MAR_AGENT_EXTENSION_STATE_OBSERVER_FAILED',
          extensionId: extension.id,
          sessionId: this.id
        }),
      (call, callback) => this.operations.callback(call, callback)
    );
    const run = <T>(
      operation: (call: ExtensionOperationContext) => Promise<T>,
      signal?: AbortSignal
    ): Promise<T> => {
      const parentSignal = this.operations.current()?.signal;
      const inherited =
        signal && parentSignal ? AbortSignal.any([signal, parentSignal]) : (signal ?? parentSignal);
      return scope.run(async (signal) => {
        const parent = this.operations.current();
        return this.operations.run(
          {
            sessionId: this.id,
            sessionEpoch: this.epoch,
            ownerInstanceId: instanceId,
            extensionId: extension.id,
            actor: 'extension',
            entry: 'native-api',
            signal,
            ...(parent?.executionId ? { executionId: parent.executionId } : {}),
            ...(parent?.turnId ? { turnId: parent.turnId } : {})
          },
          operation
        );
      }, inherited);
    };
    const callback =
      (handler: (call: ExtensionOperationContext) => void | Promise<void>) =>
      async (signal: AbortSignal) => {
        await this.#toolDomain.independent(() =>
          this.hooks.independent(() =>
            this.toolRuntime.independent(() =>
              this.operations.enter(
                {
                  sessionId: this.id,
                  sessionEpoch: this.epoch,
                  ownerInstanceId: instanceId,
                  extensionId: extension.id,
                  actor: 'extension',
                  entry: 'native-api',
                  signal
                },
                (call) => this.operations.callback(call, handler)
              )
            )
          )
        );
      };
    return {
      sessionId: this.id,
      ...(settings ? { settings: bindCoreSettings(settings, run, this.hooks) } : {}),
      ...(this.hostPorts?.environment
        ? { environment: bindCoreEnvironment(this.hostPorts.environment, run, this.hooks) }
        : {}),
      ...(this.hostPorts?.processes
        ? {
            processes: bindCoreProcesses(this.hostPorts.processes, run, scope, this.hooks, () =>
              this.diagnose({
                code: 'MAR_AGENT_PROCESS_CLEANUP_FAILED',
                extensionId: extension.id,
                sessionId: this.id
              })
            )
          }
        : {}),
      ...(this.sessionBackend
        ? {
            session: bindCoreSession(this.sessionBackend, scope, run, this.operations, this.hooks)
          }
        : {}),
      ...(this.hostPorts?.files
        ? { files: bindCoreFiles(this.hostPorts.files, run, this.hooks) }
        : {}),
      ...(this.hostPorts?.network
        ? {
            network: bindCoreNetwork(this.hostPorts.network, run, scope, this.hooks, () =>
              this.diagnose({
                code: 'MAR_AGENT_NETWORK_CLEANUP_FAILED',
                extensionId: extension.id,
                sessionId: this.id
              })
            )
          }
        : {}),
      data: bindCoreData(
        state,
        this.store,
        extension.dataDirectory,
        this.checkpoint,
        extension.id,
        run
      ),
      ...(this.models
        ? {
            models: bindCoreModels(
              this.models,
              run,
              this.hooks,
              (event, call) => this.modelEvent(event, call),
              (code, call) =>
                this.diagnose({
                  code,
                  sessionId: this.id,
                  extensionId: extension.id,
                  operationId: call.operationId
                })
            )
          }
        : {}),
      ...(this.hostPorts?.mcp
        ? { mcp: this.mcp.bind(scope, extension.id, this.hostPorts.mcp, run) }
        : {}),
      resources: scope,
      services: this.services.bind(scope, run),
      capabilities: settingsCapabilities(this.capabilities, settings !== undefined),
      bindings: Object.freeze({ ...(extension.bindings ?? {}) }),
      observability: {
        log: (message) =>
          this.diagnose({
            code: 'MAR_AGENT_EXTENSION_LOG',
            extensionId: extension.id,
            sessionId: this.id,
            message: message.slice(0, 1000)
          })
      },
      hooks: {
        intercept: (key, handler, options) => this.hooks.intercept(scope, key, handler, options),
        observe: (key, handler, options) => this.hooks.observe(scope, key, handler, options)
      },
      tools: this.#toolDomain.bind(scope, extension.id, run, () => this.operations.current()),
      commands: this.#commands.bind(scope, run),
      prompts: this.#promptDomain.bind(scope, run, this.sessionBackend),
      clock: {
        now: () => Date.now(),
        sleep: (input) => run((call) => scope.sleep(input.durationMs, call.signal), input.signal),
        after: (duration, handler) =>
          scope.after(duration, callback(handler), () =>
            this.diagnose({
              code: 'MAR_AGENT_EXTENSION_TIMER_FAILED',
              extensionId: extension.id,
              sessionId: this.id
            })
          ),
        every: (duration, handler) =>
          scope.every(duration, callback(handler), () =>
            this.diagnose({
              code: 'MAR_AGENT_EXTENSION_TIMER_FAILED',
              extensionId: extension.id,
              sessionId: this.id
            })
          )
      }
    };
  }

  withTools<T>(
    bindings: ReadonlyMap<string, ExtensionToolBinding>,
    schedule: <Value>(
      definition: ExtensionToolBinding['definition'],
      run: () => Promise<Value>
    ) => Promise<Value>,
    run: () => T
  ): T {
    return this.#toolDomain.withTools(bindings, schedule, run);
  }
  capture(
    context?: ExtensionOperationContext,
    includeStaged = false,
    base?: readonly ExtensionToolBinding[]
  ): ReadonlyMap<string, ExtensionToolBinding> {
    return this.#toolDomain.capture(context, includeStaged, base);
  }
  invoke(
    call: ToolCall,
    context: ExtensionOperationContext,
    snapshot?: ReadonlyMap<string, ExtensionToolBinding>
  ): Promise<ToolExecutionResult> {
    return this.#toolDomain.invoke(call, context, snapshot);
  }

  async modelEvent(
    event: ExtensionModelEvent,
    call: ExtensionOperationContext
  ): Promise<ExtensionModelEvent | undefined> {
    await this.hooks.emit('model.event', event, call);
    return this.hooks.invoke('model.event', event, call, async (view) => view);
  }

  composeModelSystem(system: string | ExtensionPromptComposition, call: ExtensionOperationContext) {
    return this.#promptDomain.composeModelSystem(system, call);
  }

  activate(): void {
    for (const scope of this.scopes) scope.activate();
  }

  async dispose(): Promise<void> {
    this.retire();
    let failures = 0;
    for (const scope of [...this.scopes].reverse()) {
      try {
        await scope.dispose();
      } catch {
        failures++;
      }
    }
    this.mcp.dispose();
    this.#toolDomain.dispose();
    this.hooks.dispose();
    if (failures)
      throw new AgentError(
        'MAR_AGENT_EXTENSION_CLEANUP_FAILED',
        'Session extension cleanup failed.',
        { details: { failures } }
      );
  }
}
