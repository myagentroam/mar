import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AgentError } from '../error.js';
import type { ToolCall, ToolExecutionResult } from '../tools/contracts.js';
import type { ExtensionHooks } from './hooks.js';
import type {
  ExtensionOperationContext,
  ExtensionOperationRunner,
  ExtensionOperations
} from './operation.js';
import { ExtensionResourceScope } from './resources.js';
import type { ExtensionToolRuntime } from './tool-runtime.js';
import {
  ExtensionTools,
  type ExtensionToolsApi,
  type ExtensionToolBinding,
  type ExtensionToolReferenceIndex,
  type ExtensionToolRef,
  type ExtensionToolInvocation,
  type ExtensionToolCheck,
  type ExtensionToolAttempt,
  type DomainToolOperations,
  type DomainToolFacts
} from './tools.js';

/**
 * Own one Session's tool catalog, attempt lineage, and invocation frames.
 * References retain captured bindings only until their source owner has drained its scoped work.
 */
export class ExtensionSessionTools {
  constructor(
    private readonly toolRuntime: ExtensionToolRuntime,
    private readonly operations: Pick<ExtensionOperations, 'callback' | 'continue'>,
    private readonly hooks: Pick<
      ExtensionHooks<DomainToolOperations, DomainToolFacts>,
      'invoke' | 'emit'
    >,
    private readonly baseTools: (
      context?: ExtensionOperationContext
    ) => readonly ExtensionToolBinding[],
    private readonly allowTool: (
      name: string,
      definition?: ExtensionToolBinding['definition']
    ) => boolean,
    private readonly scheduleTool: <T>(
      definition: ExtensionToolBinding['definition'],
      run: () => Promise<T>
    ) => Promise<T>,
    private readonly assertLive: () => void,
    private readonly isRetired: () => boolean
  ) {}
  #toolRefs = new WeakMap<ExtensionToolRef, ExtensionToolReferenceIndex>();
  readonly #ownerToolRefs = new Map<string, ExtensionToolReferenceIndex>();
  readonly #sessionToolRefs: ExtensionToolReferenceIndex = { bindings: new WeakMap() };
  readonly tools = new ExtensionTools(
    (binding, stage) =>
      Object.freeze({
        ...binding,
        invoke: (input: ToolCall, call: ExtensionOperationContext) =>
          this.toolAttempt(
            input,
            call,
            stage,
            async () => {
              this.assertToolAvailable(binding, call);
              this.toolRuntime.currentPermissions(call)?.assertDispatch();
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
    (call, callback) => this.operations.callback(call, callback),
    (definition) => this.toolRuntime.validateCallers(definition)
  );
  readonly #attempt = new AsyncLocalStorage<{ id: string; active: boolean } | undefined>();
  readonly #toolFrame = new AsyncLocalStorage<
    | {
        active: boolean;
        bindings: ReadonlyMap<string, ExtensionToolBinding>;
        schedule: <T>(
          definition: ExtensionToolBinding['definition'],
          run: () => Promise<T>
        ) => Promise<T>;
      }
    | undefined
  >();

  private get toolFrame() {
    const frame = this.#toolFrame.getStore();
    return frame?.active ? frame : undefined;
  }

  /** Release propagation only after the Session owner has joined all scoped tool work. */
  dispose(): void {
    this.#attempt.disable();
    this.#toolFrame.disable();
    // Host/Session refs outlive individual extensions, but never the Session owner.
    this.#toolRefs = new WeakMap();
    this.#ownerToolRefs.clear();
    this.#sessionToolRefs.bindings = new WeakMap();
  }

  withTools<T>(
    bindings: ReadonlyMap<string, ExtensionToolBinding>,
    schedule: <Value>(
      definition: ExtensionToolBinding['definition'],
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

  independent<T>(run: () => T): T {
    return this.#toolFrame.run(undefined, () => this.#attempt.run(undefined, run));
  }
  isMcp(ref: ExtensionToolRef): boolean {
    return this.#referenceBinding(ref)?.mcp !== undefined;
  }
  bind(
    scope: ExtensionResourceScope,
    extensionId: string,
    run: ExtensionOperationRunner,
    current: () => ExtensionOperationContext | undefined
  ): ExtensionToolsApi {
    const refs: ExtensionToolReferenceIndex = { bindings: new WeakMap() };
    this.#ownerToolRefs.set(scope.instanceId, refs);
    scope.effect(() => () => {
      // Keep an empty index for this owner so late snapshots cannot acquire Session lifetime.
      refs.bindings = undefined;
    });
    return {
      register: (spec) => this.tools.register(scope, extensionId, spec),
      catalog: () =>
        Object.freeze(
          [...this.capture(current()).values()].map((binding) => this.toolRef(binding))
        ),
      check: (call) => run(async (context) => this.check(call, context)),
      invoke: (call) =>
        run((context) => this.invoke(call, context, this.invocationSnapshot(call, context)))
    };
  }

  toolRef(binding: ExtensionToolBinding): ExtensionToolRef {
    const ref = Object.freeze({
      definition: binding.definition,
      source: binding.source,
      ...(binding.mcp === undefined ? {} : { mcp: binding.mcp })
    });
    const refs =
      binding.referenceIndex ??
      this.#ownerToolRefs.get(binding.source.instanceId ?? '') ??
      this.#sessionToolRefs;
    refs.bindings?.set(ref, binding);
    this.#toolRefs.set(ref, refs);
    return ref;
  }

  #referenceBinding(ref: ExtensionToolRef): ExtensionToolBinding | undefined {
    return this.#toolRefs.get(ref)?.bindings?.get(ref);
  }

  capture(
    context?: ExtensionOperationContext,
    includeStaged = false,
    base?: readonly ExtensionToolBinding[]
  ): ReadonlyMap<string, ExtensionToolBinding> {
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

  async invoke(
    call: ToolCall,
    context: ExtensionOperationContext,
    snapshot = this.capture(context)
  ): Promise<ToolExecutionResult> {
    this.assertLive();
    const permissionPolicy = this.toolRuntime.currentPermissions(context);
    let approved: ToolCall | undefined;
    if (permissionPolicy?.mode === 'auto') {
      const original = snapshot.get(call.name);
      if (!original)
        throw new AgentError('MAR_AGENT_TOOL_NOT_AVAILABLE', 'Tool source is unavailable.');
      this.assertToolAvailable(original, context);
      call = permissionPolicy.prepare(call, context, original.definition);
      const requestedApproval = call.permission?.action === 'ask';
      call = await permissionPolicy.authorize(call, context);
      if (requestedApproval) approved = structuredClone(call);
    } else if (call.permission !== undefined && call.permission !== null)
      throw new AgentError(
        'MAR_AGENT_TOOL_INPUT_INVALID',
        'Framework permission metadata requires an Auto execution.'
      );
    const {
      permission: _inheritedApproval,
      permissionMode: _untrustedPermissionMode,
      ...baseContext
    } = context;
    const effective = Object.freeze({
      ...baseContext,
      ...(permissionPolicy?.mode === 'auto' || permissionPolicy?.mode === 'full-access'
        ? { permissionMode: permissionPolicy.mode }
        : {}),
      ...(call.callId === undefined ? {} : { toolCallId: call.callId })
    });
    return this.operations.continue(effective, () =>
      this.toolAttempt(call, effective, 'result', () =>
        this.hooks.invoke('tool.invoke', call, effective, async (target, effective) => {
          const binding = snapshot.get(target.name);
          if (!binding)
            throw new AgentError('MAR_AGENT_TOOL_NOT_AVAILABLE', 'Tool source is unavailable.');
          this.assertToolAvailable(binding, effective);
          permissionPolicy?.assertDispatch();
          const normalized = this.toolRuntime.normalizeInput(
            target.arguments,
            binding.definition.inputSchema
          );
          const explicitlyApproved =
            approved?.name === target.name &&
            isDeepStrictEqual(
              normalized,
              this.toolRuntime.normalizeInput(approved.arguments, binding.definition.inputSchema)
            );
          return binding.invoke(
            {
              ...target,
              arguments: normalized
            },
            explicitlyApproved
              ? Object.freeze({
                  ...effective,
                  permission: Object.freeze({ decision: 'approved' as const })
                })
              : effective
          );
        })
      )
    );
  }

  private assertToolAvailable(
    binding: ExtensionToolBinding,
    call: ExtensionOperationContext
  ): void {
    this.assertLive();
    call.signal.throwIfAborted();
    if (
      !this.allowTool(binding.definition.name, binding.definition) ||
      binding.available?.(call) === false
    )
      throw new AgentError('MAR_AGENT_TOOL_NOT_AVAILABLE', 'Tool source is unavailable.');
    if (call.entry !== 'native-api' && !binding.definition.allowedCallers?.includes(call.entry))
      throw new AgentError('MAR_AGENT_TOOL_NOT_AVAILABLE', 'Tool caller is unavailable.');
  }

  private toolAttempt(
    input: ToolCall,
    call: ExtensionOperationContext,
    stage: ExtensionToolAttempt['stage'],
    invoke: () => Promise<ToolExecutionResult>,
    source?: ExtensionToolRef['source']
  ): Promise<ToolExecutionResult> {
    const parent = this.#attempt.getStore();
    const frame = { id: randomUUID(), active: true };
    const attempt: ExtensionToolAttempt = Object.freeze({
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
          result = this.toolRuntime.validateResult(await invoke());
        } catch (error) {
          const cancelled =
            call.signal.aborted ||
            (error instanceof AgentError && error.code === 'MAR_AGENT_CANCELLED');
          let errorCode = cancelled ? 'MAR_AGENT_CANCELLED' : 'MAR_AGENT_TOOL_FAILED';
          try {
            if (error instanceof AgentError) errorCode = error.code;
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

  check(call: ExtensionToolInvocation, context: ExtensionOperationContext): ExtensionToolCheck {
    let binding: ExtensionToolBinding | undefined;
    try {
      binding = this.invocationSnapshot(call, context).get(call.name);
    } catch {
      return { available: false, code: 'MAR_AGENT_TOOL_NOT_AVAILABLE' };
    }
    const available =
      !this.isRetired() &&
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
    call: ExtensionToolInvocation,
    context: ExtensionOperationContext
  ): ReadonlyMap<string, ExtensionToolBinding> {
    const snapshot = this.capture(context);
    if (!call.ref) return snapshot;
    const binding = this.#referenceBinding(call.ref);
    if (!binding || binding.definition.name !== call.name)
      throw new AgentError('MAR_AGENT_TOOL_NOT_AVAILABLE', 'Tool reference is unavailable.');
    return new Map([...snapshot, [call.name, binding]]);
  }
}
