import { normalizeToolInput } from '../tools/input.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { currentToolPermissions } from '../tools/permissions.js';
import { randomUUID } from 'node:crypto';
import { MarAgentError } from '../error.js';
import type { ToolCall, ToolExecutionResult } from '../tools/contracts.js';
import { validateToolResult } from '../tools/output-projection.js';
import { withIndependentSessionTools } from '../tools/scheduler.js';
import type {
  CoreCommandSpec,
  CoreDomainFacts,
  CoreDomainOperations,
  CoreExtensionDiagnostic,
  CorePromptSection,
  CoreRuntimeExtension,
  CoreSessionExtensionContext,
  CoreCapabilitySnapshot
} from './contracts.js';
import { ExtensionHooks } from './hooks.js';
import {
  composePromptSections,
  normalizePromptComposition,
  renderPromptSections,
  type CorePromptPart,
  type CorePromptComposition
} from './prompt-composition.js';
import type { CoreModelEvent } from './model-stream.js';
import type { ModelTextBlock } from '../model/contracts.js';
import { resolveModelTextBlocks } from '../model/text-blocks.js';
import { ExtensionStore } from './store.js';
import { bindCoreFiles } from './files.js';
import { bindCoreNetwork } from './network.js';
import { ExtensionMcp } from './mcp.js';
import { bindCoreProcesses } from './processes.js';
import { bindCoreEnvironment } from './environment.js';
import {
  bindAgentController,
  bindCoreAgents,
  invokeCoreAgentOperation,
  type CoreAgentsBackend
} from './agents.js';
import type { SubagentController } from '../subagent/contracts.js';
import { bindCoreSettings, coreSettingsBinding, settingsCapabilities } from './settings.js';
import type { CoreHostExtensionPorts } from '../host/contracts.js';
import { ExtensionOperations, type CoreOperationContext } from './operation.js';
import { ExtensionResourceScope, type CoreResourceRegistration } from './resources.js';
import { ExtensionServices } from './services.js';
import {
  ExtensionTools,
  type CoreToolBinding,
  type CoreToolRef,
  type CoreToolInvocation,
  type CoreToolCheck,
  type CoreToolAttempt
} from './tools.js';
import type { CoreModelsBackend } from './models.js';
import { ExtensionState, type CoreCheckpointBackend } from './data.js';
import type { CoreSessionBackend, CoreSessionAction, CoreSessionReceipt } from './session-input.js';
import { invokeCorePromptSubmission } from './prompt-input.js';

interface Owned<Value> {
  readonly value: Value;
  readonly scope: ExtensionResourceScope;
}

/** Session-local definitions and facades; SDK supplies real Host sources for each operation. */
export class ExtensionSession {
  isEnding = false;
  readonly mcp: ExtensionMcp;
  readonly tools = new ExtensionTools(
    (binding, stage) =>
      Object.freeze({
        ...binding,
        invoke: (input: ToolCall, call: CoreOperationContext) =>
          this.toolAttempt(
            input,
            call,
            stage,
            async () => {
              this.assertToolAvailable(binding, call);
              currentToolPermissions(call)?.assertDispatch();
              const invoke = () => {
                this.assertToolAvailable(binding, call);
                return binding.invoke(input, call);
              };
              const schedule = this.toolFrame?.schedule ?? this.scheduleTool;
              return binding.definition.name === 'code_exec' ||
                binding.definition.name === 'code_exec_wait'
                ? invoke()
                : schedule(binding.definition, invoke);
            },
            binding.source
          )
      }),
    (call, callback) => this.operations.callback(call, callback)
  );
  readonly #attempt = new AsyncLocalStorage<{ id: string; active: boolean } | undefined>();
  readonly hooks: ExtensionHooks<CoreDomainOperations, CoreDomainFacts>;
  readonly services: ExtensionServices;
  readonly #commands: Owned<CoreCommandSpec>[] = [];
  readonly #prompts: Owned<CorePromptSection>[] = [];
  readonly scopes: ExtensionResourceScope[] = [];
  readonly #toolRefs = new WeakMap<CoreToolRef, CoreToolBinding>();
  #references = 0;
  #retired = false;
  #ready = false;

  /** The SDK calls this after admission, outside the composition manager's serial lane. */
  async ready(call: CoreOperationContext): Promise<void> {
    this.assertLive();
    call.signal.throwIfAborted();
    if (this.#ready) return;
    // Mark before dispatch so nested work cannot recursively initialize the same generation.
    this.#ready = true;
    await this.hooks.emit('session.ready', { sessionId: this.id }, call);
  }

  assertLive(): void {
    if (this.#retired)
      throw new MarAgentError('MAR_AGENT_TOOL_NOT_AVAILABLE', 'Session runtime is retired.');
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
  readonly #toolFrame = new AsyncLocalStorage<
    | {
        active: boolean;
        bindings: ReadonlyMap<string, CoreToolBinding>;
        schedule: <T>(
          definition: CoreToolBinding['definition'],
          run: () => Promise<T>
        ) => Promise<T>;
      }
    | undefined
  >();

  private get toolFrame() {
    const frame = this.#toolFrame.getStore();
    return frame?.active ? frame : undefined;
  }

  withTools<T>(
    bindings: ReadonlyMap<string, CoreToolBinding>,
    schedule: <Value>(
      definition: CoreToolBinding['definition'],
      run: () => Promise<Value>
    ) => Promise<Value>,
    run: () => T
  ): T {
    this.assertLive();
    const frame = { bindings, schedule, active: true };
    return this.#toolFrame.run(frame, () => {
      try {
        const result = run();
        if (result instanceof Promise)
          return result.finally(() => {
            frame.active = false;
          }) as T;
        frame.active = false;
        return result;
      } catch (error) {
        frame.active = false;
        throw error;
      }
    });
  }

  constructor(
    readonly id: string,
    readonly epoch: number,
    agentServices: ExtensionServices,
    readonly operations: ExtensionOperations,
    readonly capabilities: CoreCapabilitySnapshot,
    readonly diagnose: (diagnostic: CoreExtensionDiagnostic) => void,
    readonly baseTools: (context?: CoreOperationContext) => readonly CoreToolBinding[] = () => [],
    readonly models?: CoreModelsBackend,
    readonly checkpoint?: CoreCheckpointBackend,
    readonly sessionBackend?: CoreSessionBackend,
    readonly hostPorts?: CoreHostExtensionPorts,
    readonly agentsBackend?: CoreAgentsBackend,
    readonly allowTool: (
      name: string,
      definition?: CoreToolBinding['definition']
    ) => boolean = () => true,
    readonly scheduleTool: <T>(
      definition: CoreToolBinding['definition'],
      run: () => Promise<T>
    ) => Promise<T> = (_definition, run) => run()
  ) {
    this.services = new ExtensionServices('session', agentServices);
    this.hooks = new ExtensionHooks(diagnose, (call, callback, settled) =>
      this.operations.callback(call, callback, settled)
    );
    this.mcp = new ExtensionMcp(
      this.tools,
      this.hooks,
      (call) => this.capture(call, false, this.baseTools(call)),
      (binding) => this.toolRef(binding),
      (ref) => this.#toolRefs.get(ref)?.mcp !== undefined,
      (input, call) => this.invoke(input, call, this.invocationSnapshot(input, call)),
      () => this.diagnose({ code: 'MAR_AGENT_MCP_CLEANUP_FAILED', sessionId: this.id })
    );
  }

  context(
    extension: CoreRuntimeExtension,
    scope: ExtensionResourceScope
  ): CoreSessionExtensionContext {
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
      operation: (call: CoreOperationContext) => Promise<T>,
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
    const sessionAction: CoreSessionAction = (request, call, leaf) =>
      this.operations.continue(call, async () => {
        if (request.kind === 'append')
          return this.hooks.invoke('session.append', request.input, call, (input, effective) =>
            leaf({ kind: 'append', input }, effective)
          );
        return leaf(request, call);
      });
    const register = <Value>(entries: Owned<Value>[], value: Value): CoreResourceRegistration => {
      const entry = { value, scope };
      const registration = scope.effect(() => () => {
        const index = entries.indexOf(entry);
        if (index !== -1) entries.splice(index, 1);
      });
      entries.push(entry);
      return registration;
    };
    const callback =
      (handler: (call: CoreOperationContext) => void | Promise<void>) =>
      async (signal: AbortSignal) => {
        await this.#toolFrame.run(undefined, () =>
          this.#attempt.run(undefined, () =>
            this.hooks.independent(() =>
              withIndependentSessionTools(() =>
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
          )
        );
      };
    return {
      sessionId: this.id,
      ...(this.agentsBackend
        ? {
            agents: bindCoreAgents(this.agentsBackend, scope, run, this.hooks)
          }
        : {}),
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
            session: {
              captureRequest: (input = {}) =>
                run((call) => this.sessionBackend!.captureRequest(call, input)),
              inspect: () => run((call) => this.sessionBackend!.inspect(call)),
              describe: () =>
                run((call) => {
                  if (!this.sessionBackend?.describe)
                    throw new MarAgentError(
                      'MAR_AGENT_SESSION_INPUT_UNAVAILABLE',
                      'Session metadata is unavailable.'
                    );
                  return this.sessionBackend.describe(call);
                }),
              messages: (input: import('./session-messages.js').CoreSessionMessagesInput = {}) =>
                run((call) => this.sessionBackend!.messages(input, call)),
              append: (input: import('./session-input.js').CoreAppendInput) =>
                run((call) =>
                  this.sessionBackend!.enqueue({ kind: 'append', input }, call, sessionAction)
                ),
              submit: (input: import('./session-input.js').CoreSubmitInput) =>
                run(async (call) => {
                  const { queueSignal, ...request } = input;
                  if (queueSignal !== undefined && !(queueSignal instanceof AbortSignal))
                    throw new MarAgentError(
                      'MAR_AGENT_SESSION_INPUT_INVALID',
                      'Session input lifetime must be an AbortSignal.'
                    );
                  // Admission uses the caller's cancellation; accepted work may outlive it.
                  call.signal.throwIfAborted();
                  const accepted = queueSignal
                    ? Object.freeze({
                        ...call,
                        signal: AbortSignal.any([scope.signal, queueSignal])
                      })
                    : call;
                  let receipt: CoreSessionReceipt | undefined;
                  const admission = await invokeCorePromptSubmission(
                    this.hooks,
                    request,
                    call,
                    async (content, effective) => {
                      effective.signal.throwIfAborted();
                      receipt = await this.sessionBackend!.enqueue(
                        {
                          kind: 'submit',
                          input: {
                            ...content,
                            ...(request.provenance === undefined
                              ? {}
                              : { provenance: request.provenance }),
                            ...(request.modelAttribution === undefined
                              ? {}
                              : { modelAttribution: request.modelAttribution }),
                            ...(request.delivery === undefined
                              ? {}
                              : { delivery: request.delivery }),
                            ...(request.waitFor === undefined ? {} : { waitFor: request.waitFor })
                          }
                        },
                        queueSignal ? accepted : effective,
                        sessionAction
                      );
                      return {};
                    }
                  );
                  return (
                    receipt ?? this.sessionBackend!.handled(request, call, admission.result.value)
                  );
                }),
              compact: (input: import('./session-input.js').CoreCompactInput = {}) =>
                run((call) =>
                  this.sessionBackend!.enqueue({ kind: 'compact', input }, call, sessionAction)
                )
            }
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
      data: {
        ...(extension.dataDirectory === undefined
          ? {}
          : {
              store: new ExtensionStore(extension.dataDirectory).bind((operation) =>
                run((call) => operation(call.signal))
              )
            }),
        state: {
          read: (key) => run(async () => state.read(key)),
          write: (key, value) => run((call) => state.write(key, value, call)),
          delete: (key) => run((call) => state.write(key, undefined, call)),
          watch: (handler) => state.watch(handler)
        },
        ...(this.checkpoint
          ? {
              checkpoint: {
                get: (input: { key: string }) =>
                  run((call) => this.checkpoint!.read(extension.id, input.key, call)),
                set: (input: {
                  key: string;
                  value: import('./data.js').CoreJsonValue;
                  expectedRevision?: number;
                }) =>
                  run((call) =>
                    this.checkpoint!.write(
                      extension.id,
                      input.key,
                      input.value,
                      input.expectedRevision,
                      call
                    )
                  ),
                delete: (input: { key: string; expectedRevision?: number }) =>
                  run((call) =>
                    this.checkpoint!.write(
                      extension.id,
                      input.key,
                      undefined,
                      input.expectedRevision,
                      call
                    )
                  )
              }
            }
          : {})
      },
      ...(this.models
        ? {
            models: {
              list: () => this.models!.list(),
              generate: (input: import('./models.js').CoreGenerateInput) =>
                run((call) => {
                  return this.models!.generate(
                    input,
                    call,
                    (request) =>
                      this.hooks.invoke('model.request', request, call, async (view) => view),
                    (event, signal) => this.modelEvent(event, Object.freeze({ ...call, signal })),
                    (code) =>
                      this.diagnose({
                        code,
                        sessionId: this.id,
                        extensionId: extension.id,
                        operationId: call.operationId
                      })
                  );
                }, input.signal)
            }
          }
        : {}),
      ...(this.hostPorts?.mcp
        ? { mcp: this.mcp.bind(scope, extension.id, this.hostPorts.mcp, run) }
        : {}),
      resources: scope,
      services: this.services.bind(scope),
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
      tools: {
        register: (spec) => this.tools.register(scope, extension.id, spec),
        catalog: () =>
          Object.freeze(
            [...this.capture(this.operations.current()).values()].map((binding) => {
              return this.toolRef(binding);
            })
          ),
        check: (call) => run(async (context) => this.check(call, context)),
        invoke: (call) =>
          run((context) => this.invoke(call, context, this.invocationSnapshot(call, context)))
      },
      commands: {
        register: (spec) => {
          if (
            typeof spec.name !== 'string' ||
            !spec.name.trim() ||
            typeof spec.handler !== 'function' ||
            (spec.override !== undefined && spec.override !== 'replace')
          )
            throw new MarAgentError(
              'MAR_AGENT_EXTENSION_COMMAND_INVALID',
              'Command definition is invalid.'
            );
          if (
            spec.override !== 'replace' &&
            this.#commands.some((entry) => entry.value.name === spec.name)
          )
            throw new MarAgentError(
              'MAR_AGENT_EXTENSION_COMMAND_CONFLICT',
              'Command name conflicts.'
            );
          return register(this.#commands, Object.freeze({ ...spec }));
        },
        list: () =>
          [
            ...new Map(
              this.#commands
                .filter((entry) => entry.scope.state === 'ACTIVE')
                .map((entry) => [entry.value.name, entry] as const)
            ).values()
          ].map(({ value }) => ({
            name: value.name,
            ...(value.description ? { description: value.description } : {})
          })),
        run: (input) =>
          run(async (context) => {
            const entry = this.#commands.findLast(
              (entry) => entry.scope.state === 'ACTIVE' && entry.value.name === input.name
            );
            if (!entry)
              throw new MarAgentError(
                'MAR_AGENT_EXTENSION_COMMAND_UNAVAILABLE',
                'Command is unavailable.'
              );
            return entry.scope.run(
              (signal) =>
                this.operations.callback(
                  Object.freeze({ ...context, signal, ownerInstanceId: entry.scope.instanceId }),
                  (call) => entry.value.handler(input.args, call)
                ),
              context.signal
            );
          })
      },
      prompts: {
        register: (input) => {
          const section = normalizePromptComposition({ sections: [input] }).sections[0]!;
          if (section.text === null)
            throw new MarAgentError(
              'MAR_AGENT_EXTENSION_PROMPT_INVALID',
              'Prompt section is invalid.'
            );
          if (this.#prompts.some((entry) => entry.value.id === section.id))
            throw new MarAgentError(
              'MAR_AGENT_EXTENSION_PROMPT_CONFLICT',
              'Prompt section id conflicts.'
            );
          return register(this.#prompts, Object.freeze({ id: section.id, text: section.text }));
        },
        sections: () => this.sections(),
        compose: (system) => run((call) => this.compose(system, call)),
        composeSections: (input) => {
          const snapshot = normalizePromptComposition(input);
          return run((call) => this.composeSections(snapshot, call));
        },
        composeDefault: (facts = {}) => {
          const snapshot = normalizePromptComposition({ sections: [], facts });
          return run(async (call) => {
            if (!this.sessionBackend?.composePrompt)
              throw new MarAgentError(
                'MAR_AGENT_EXTENSION_PROMPT_UNAVAILABLE',
                'Session default prompt composition is unavailable.'
              );
            return this.composeSections(
              await this.sessionBackend.composePrompt(snapshot.facts!, call),
              call
            );
          });
        }
      },
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

  toolRef(binding: CoreToolBinding): CoreToolRef {
    const ref = Object.freeze({
      definition: binding.definition,
      source: binding.source,
      ...(binding.mcp === undefined ? {} : { mcp: binding.mcp })
    });
    this.#toolRefs.set(ref, binding);
    return ref;
  }

  capture(
    context?: CoreOperationContext,
    includeStaged = false,
    base?: readonly CoreToolBinding[]
  ): ReadonlyMap<string, CoreToolBinding> {
    this.assertLive();
    if (!base && !includeStaged && this.toolFrame) return this.toolFrame.bindings;
    const tools = this.tools.capture(
      base ?? this.baseTools(context),
      includeStaged || ExtensionResourceScope.initializing
    );
    return new Map(
      [...tools].filter(([name, binding]) => this.allowTool(name, binding.definition))
    );
  }

  sections(): readonly CorePromptSection[] {
    return this.#prompts
      .filter((entry) => entry.scope.state === 'ACTIVE')
      .map((entry) => entry.value);
  }

  bindAgents(controller: SubagentController): SubagentController {
    return bindAgentController(controller, (key, input, leaf) => {
      const call = this.operations.current();
      if (!call)
        throw new MarAgentError(
          'MAR_AGENT_SUBAGENT_FAILED',
          'Agent operation context is unavailable.'
        );
      return invokeCoreAgentOperation(this.hooks, key, input, call, leaf);
    });
  }

  async modelEvent(
    event: CoreModelEvent,
    call: CoreOperationContext
  ): Promise<CoreModelEvent | undefined> {
    await this.hooks.emit('model.event', event, call);
    return this.hooks.invoke('model.event', event, call, async (view) => view);
  }

  composeSections(
    input: CorePromptComposition,
    call: CoreOperationContext
  ): Promise<CorePromptComposition> {
    this.assertLive();
    return composePromptSections(this.hooks, input, this.sections(), call);
  }

  async compose(
    system: string | CorePromptComposition,
    call: CoreOperationContext
  ): Promise<string> {
    return (await this.composeModelSystem(system, call)).text;
  }

  async composeModelSystem(
    system: string | CorePromptComposition,
    call: CoreOperationContext
  ): Promise<{
    text: string;
    blocks?: readonly ModelTextBlock[];
    sections?: readonly CorePromptPart[];
  }> {
    if (typeof system !== 'string' && (system === null || typeof system !== 'object'))
      throw new MarAgentError(
        'MAR_AGENT_EXTENSION_PROMPT_INVALID',
        'Prompt composition is invalid.'
      );
    const input =
      typeof system === 'string'
        ? { sections: [{ id: 'core:base', text: system }] }
        : normalizePromptComposition(system);
    const sections = await this.composeSections(input, call);
    const composed = renderPromptSections(sections.sections);
    const result = await this.hooks.invoke(
      'prompt.compose',
      composed,
      call,
      async (value) => value
    );
    call.signal.throwIfAborted();
    if (typeof result !== 'string')
      throw new MarAgentError(
        'MAR_AGENT_EXTENSION_PROMPT_INVALID',
        'Prompt composition is invalid.'
      );
    if (!sections.sections.some((part) => part.scope !== undefined))
      return { text: result, sections: sections.sections };
    const shared = sections.sections
      .filter((part) => part.scope === 'shared' && part.text)
      .map((part) => part.text!)
      .join('\n\n');
    const session = sections.sections
      .filter((part) => part.scope !== 'shared' && part.text)
      .map((part) => part.text!)
      .join('\n\n');
    const blocks: ModelTextBlock[] = [];
    if (shared) blocks.push({ text: shared, cache: true });
    if (session) blocks.push({ text: `${shared ? '\n\n' : ''}${session}` });
    return { text: result, blocks: resolveModelTextBlocks(result, blocks) };
  }

  async invoke(
    call: ToolCall,
    context: CoreOperationContext,
    snapshot = this.capture(context)
  ): Promise<ToolExecutionResult> {
    this.assertLive();
    const permissionPolicy = currentToolPermissions(context);
    if (permissionPolicy?.mode === 'auto') {
      const original = snapshot.get(call.name);
      if (!original)
        throw new MarAgentError('MAR_AGENT_TOOL_NOT_AVAILABLE', 'Tool source is unavailable.');
      this.assertToolAvailable(original, context);
      call = permissionPolicy.prepare(call, context, original.definition);
      call = await permissionPolicy.authorize(call, context);
    } else if (call.permission !== undefined && call.permission !== null)
      throw new MarAgentError(
        'MAR_AGENT_TOOL_INPUT_INVALID',
        'Framework permission metadata requires an Auto execution.'
      );
    const effective = Object.freeze({
      ...context,
      ...(call.callId === undefined ? {} : { toolCallId: call.callId })
    });
    return this.operations.continue(effective, () =>
      this.toolAttempt(call, effective, 'result', () =>
        this.hooks.invoke('tool.invoke', call, effective, async (target, effective) => {
          const binding = snapshot.get(target.name);
          if (!binding)
            throw new MarAgentError('MAR_AGENT_TOOL_NOT_AVAILABLE', 'Tool source is unavailable.');
          this.assertToolAvailable(binding, effective);
          permissionPolicy?.assertDispatch();
          return binding.invoke(
            {
              ...target,
              arguments: normalizeToolInput(target.arguments, binding.definition.inputSchema)
            },
            effective
          );
        })
      )
    );
  }

  private assertToolAvailable(binding: CoreToolBinding, call: CoreOperationContext): void {
    this.assertLive();
    call.signal.throwIfAborted();
    if (
      !this.allowTool(binding.definition.name, binding.definition) ||
      binding.available?.(call) === false
    )
      throw new MarAgentError('MAR_AGENT_TOOL_NOT_AVAILABLE', 'Tool source is unavailable.');
    if (call.entry !== 'native-api' && !binding.definition.allowedCallers?.includes(call.entry))
      throw new MarAgentError('MAR_AGENT_TOOL_NOT_AVAILABLE', 'Tool caller is unavailable.');
  }

  private toolAttempt(
    input: ToolCall,
    call: CoreOperationContext,
    stage: CoreToolAttempt['stage'],
    invoke: () => Promise<ToolExecutionResult>,
    source?: CoreToolRef['source']
  ): Promise<ToolExecutionResult> {
    const parent = this.#attempt.getStore();
    const frame = { id: randomUUID(), active: true };
    const attempt: CoreToolAttempt = Object.freeze({
      attemptId: frame.id,
      ...(parent?.active ? { parentAttemptId: parent.id } : {}),
      name: input.name,
      ...(input.callId === undefined ? {} : { callId: input.callId }),
      stage,
      ...(source === undefined ? {} : { source })
    });
    return this.#attempt.run(frame, async () => {
      try {
        let result: ToolExecutionResult;
        try {
          result = validateToolResult(await invoke());
        } catch (error) {
          const cancelled =
            call.signal.aborted ||
            (error instanceof MarAgentError && error.code === 'MAR_AGENT_CANCELLED');
          let errorCode = cancelled ? 'MAR_AGENT_CANCELLED' : 'MAR_AGENT_TOOL_FAILED';
          try {
            if (error instanceof MarAgentError) errorCode = error.code;
            else if (
              error &&
              typeof error === 'object' &&
              'code' in error &&
              typeof error.code === 'string'
            )
              errorCode = error.code.slice(0, 80);
          } catch {
            /* A diagnostic getter must not replace the real failure. */
          }
          await this.hooks.emit(
            stage === 'result' ? 'tool.failed' : 'tool.attempt.failed',
            { ...attempt, status: cancelled ? 'cancelled' : 'failed', errorCode },
            call,
            true
          );
          throw error;
        }
        await this.hooks.emit(
          stage === 'result' ? 'tool.completed' : 'tool.attempt.completed',
          { ...attempt, result },
          call
        );
        return result;
      } finally {
        frame.active = false;
      }
    });
  }

  check(call: CoreToolInvocation, context: CoreOperationContext): CoreToolCheck {
    let binding: CoreToolBinding | undefined;
    try {
      binding = this.invocationSnapshot(call, context).get(call.name);
    } catch {
      return { available: false, code: 'MAR_AGENT_TOOL_NOT_AVAILABLE' };
    }
    const available =
      !this.#retired &&
      binding !== undefined &&
      this.allowTool(call.name, binding.definition) &&
      binding.available?.(context) !== false &&
      (context.entry === 'native-api' ||
        binding.definition.allowedCallers?.includes(context.entry) === true);
    return {
      available,
      ...(available ? { source: binding!.source } : { code: 'MAR_AGENT_TOOL_NOT_AVAILABLE' })
    };
  }

  invocationSnapshot(
    call: CoreToolInvocation,
    context: CoreOperationContext
  ): ReadonlyMap<string, CoreToolBinding> {
    const snapshot = this.capture(context);
    if (!call.ref) return snapshot;
    const binding = this.#toolRefs.get(call.ref);
    if (!binding || binding.definition.name !== call.name)
      throw new MarAgentError('MAR_AGENT_TOOL_NOT_AVAILABLE', 'Tool reference is unavailable.');
    return new Map([...snapshot, [call.name, binding]]);
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
    if (failures)
      throw new MarAgentError(
        'MAR_AGENT_EXTENSION_CLEANUP_FAILED',
        'Session extension cleanup failed.',
        { details: { failures } }
      );
  }
}
