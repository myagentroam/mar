import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AgentError } from '../error.js';
import type {
  ClientToolDefinition,
  McpCatalogTool,
  ToolCall,
  ToolExecutionResult
} from '../tools/contracts.js';
import { fromJSONSchema } from 'zod';
import type { ExtensionCallbackRunner, ExtensionOperationContext } from './operation.js';
import { ExtensionResourceScope, type ExtensionResourceRegistration } from './resources.js';

export interface ExtensionToolSpec extends ClientToolDefinition {
  readonly override?: 'replace' | 'wrap';
  /** Optional native validator/parser for schema features outside the built-in converter. */
  readonly parseInput?: (input: unknown) => unknown | Promise<unknown>;
  readonly validateOutput?: (data: unknown) => void | Promise<void>;
  execute(
    input: unknown,
    call: ExtensionOperationContext,
    next: (input: unknown) => Promise<ToolExecutionResult>
  ): ToolExecutionResult | Promise<ToolExecutionResult>;
}
export interface ExtensionToolRef {
  readonly mcp?: McpCatalogTool;
  readonly definition: ClientToolDefinition;
  readonly source: Readonly<{
    id: string;
    revision: string;
    kind: 'builtin' | 'host' | 'mcp' | 'extension';
    instanceId?: string;
  }>;
}
export interface ExtensionToolInvocation extends ToolCall {
  readonly ref?: ExtensionToolRef;
}
export interface ExtensionToolCheck {
  readonly available: boolean;
  readonly code?: string;
  readonly source?: ExtensionToolRef['source'];
}
export interface ExtensionToolAttempt {
  readonly attemptId: string;
  readonly parentAttemptId?: string;
  readonly name: string;
  readonly callId?: string;
  readonly stage: 'leaf' | 'wrapper' | 'result';
  readonly source?: ExtensionToolRef['source'];
}
export interface ExtensionToolCompletion extends ExtensionToolAttempt {
  readonly result: ToolExecutionResult;
}
export interface ExtensionToolFailure extends ExtensionToolAttempt {
  readonly status: 'failed' | 'cancelled';
  readonly errorCode: string;
}
export interface ExtensionToolBinding extends ExtensionToolRef {
  readonly mcp?: McpCatalogTool;
  registered?(): boolean;
  available?(context: ExtensionOperationContext): boolean;
  invoke(call: ToolCall, context: ExtensionOperationContext): Promise<ToolExecutionResult>;
}

export interface ExtensionToolsApi {
  register(spec: ExtensionToolSpec): ExtensionResourceRegistration;
  catalog(): readonly ExtensionToolRef[];
  check(call: ExtensionToolInvocation): Promise<ExtensionToolCheck>;
  invoke(call: ExtensionToolInvocation): Promise<ToolExecutionResult>;
}

interface Contribution {
  readonly spec: ExtensionToolSpec;
  readonly owner: ExtensionResourceScope;
  readonly id: string;
  readonly revision: string;
  readonly parse: (input: unknown) => unknown | Promise<unknown>;
  readonly validateOutput?: (input: unknown) => unknown | Promise<unknown>;
}

/** Builds one immutable catalog from real sources; snapshots keep their captured handlers. */
export class ExtensionTools {
  readonly #entries: Contribution[] = [];
  readonly #sources: Array<{ owner: ExtensionResourceScope; binding: ExtensionToolBinding }> = [];
  #revision = 0;

  constructor(
    readonly trace: (
      binding: ExtensionToolBinding,
      stage: 'leaf' | 'wrapper'
    ) => ExtensionToolBinding = (binding) => binding,
    readonly callback: ExtensionCallbackRunner = async (call, run) => run(call),
    readonly validateCallers: (definition: ClientToolDefinition) => void
  ) {}

  get revision(): number {
    return this.#revision;
  }

  /** Internal bridge for a real owner-bound backend, not an author-supplied handler authority. */
  contributeSource(
    owner: ExtensionResourceScope,
    source: ExtensionToolBinding
  ): ExtensionResourceRegistration {
    const entry = {
      owner,
      binding: Object.freeze({
        ...source,
        definition: deepFreeze(copyDefinition(source.definition)),
        source: Object.freeze({ ...source.source }),
        ...(source.mcp === undefined ? {} : { mcp: deepFreeze(structuredClone(source.mcp)) })
      })
    };
    const registration = owner.effect(() => () => {
      const index = this.#sources.indexOf(entry);
      if (index !== -1) {
        this.#sources.splice(index, 1);
        this.#revision++;
      }
    });
    this.#sources.push(entry);
    this.#revision++;
    return registration;
  }

  register(
    owner: ExtensionResourceScope,
    id: string,
    spec: ExtensionToolSpec
  ): ExtensionResourceRegistration {
    if (
      typeof spec.name !== 'string' ||
      !spec.name.trim() ||
      typeof spec.description !== 'string' ||
      typeof spec.execute !== 'function' ||
      !spec.inputSchema ||
      typeof spec.inputSchema !== 'object' ||
      Array.isArray(spec.inputSchema) ||
      (spec.override !== undefined && spec.override !== 'replace' && spec.override !== 'wrap')
    )
      throw new AgentError(
        'MAR_AGENT_EXTENSION_TOOL_INVALID',
        'Extension tool definition or handler is invalid.'
      );
    const definition = copyDefinition(spec);
    const parse =
      spec.parseInput ?? schemaValidator(spec.inputSchema, 'MAR_AGENT_TOOL_INPUT_INVALID');
    const validateOutput =
      spec.validateOutput ??
      (spec.outputSchema
        ? schemaValidator(spec.outputSchema, 'MAR_AGENT_TOOL_OUTPUT_INVALID')
        : undefined);
    this.validateCallers({
      ...definition,
      allowedCallers: spec.allowedCallers ?? ['direct', 'programmatic']
    });
    const entry: Contribution = {
      owner,
      id,
      revision: randomUUID(),
      parse,
      ...(validateOutput ? { validateOutput } : {}),
      spec: Object.freeze({
        ...definition,
        ...(spec.override ? { override: spec.override } : {}),
        execute: spec.execute
      })
    };
    const registration = owner.effect(() => () => {
      const index = this.#entries.indexOf(entry);
      if (index !== -1) {
        this.#entries.splice(index, 1);
        this.#revision++;
      }
    });
    this.#entries.push(entry);
    this.#revision++;
    return registration;
  }

  capture(
    base: readonly ExtensionToolBinding[] = [],
    includeStaged = false
  ): ReadonlyMap<string, ExtensionToolBinding> {
    const bindings = new Map<string, ExtensionToolBinding>();
    const sources = this.#sources
      .filter(
        ({ owner }) => owner.state === 'ACTIVE' || (includeStaged && owner.state === 'STAGED')
      )
      .filter(({ binding }) => binding.registered?.() !== false)
      .map(({ binding }) => binding);
    for (const original of [...base, ...sources]) {
      const binding = Object.freeze({
        ...original,
        definition: deepFreeze(copyDefinition(original.definition)),
        source: Object.freeze({ ...original.source }),
        ...(original.mcp === undefined ? {} : { mcp: deepFreeze(structuredClone(original.mcp)) })
      });
      if (bindings.has(binding.definition.name))
        throw new AgentError('MAR_AGENT_EXTENSION_TOOL_CONFLICT', 'Tool sources conflict.');
      bindings.set(binding.definition.name, this.trace(binding, 'leaf'));
    }
    for (const entry of this.#entries) {
      if (entry.owner.state !== 'ACTIVE' && !(includeStaged && entry.owner.state === 'STAGED'))
        continue;
      if (
        this.#entries
          .slice(this.#entries.indexOf(entry) + 1)
          .some((later) => later.owner === entry.owner && later.spec.name === entry.spec.name)
      )
        continue;
      const lower = bindings.get(entry.spec.name);
      if (lower && !entry.spec.override)
        throw new AgentError(
          'MAR_AGENT_EXTENSION_TOOL_CONFLICT',
          'Tool replacement must be explicit.'
        );
      if (!lower && entry.spec.override === 'wrap') {
        if (entry.owner.state === 'ACTIVE') continue;
        throw new AgentError(
          'MAR_AGENT_EXTENSION_DEPENDENCY_MISSING',
          'Tool wrapper has no lower implementation.'
        );
      }
      const definition = copyDefinition(entry.spec);
      definition.allowedCallers ??= lower
        ? (lower.definition.allowedCallers ??
          (lower.source.kind === 'mcp' ? ['direct', 'programmatic'] : ['direct']))
        : ['direct', 'programmatic'];
      if (entry.spec.override === 'wrap' && lower?.definition.agentScope !== undefined)
        definition.agentScope ??= lower.definition.agentScope;
      if (entry.spec.override === 'wrap' && lower?.definition.codeModeExposure !== undefined)
        definition.codeModeExposure ??= lower.definition.codeModeExposure;
      const binding: ExtensionToolBinding = Object.freeze({
        definition: deepFreeze(definition),
        ...(entry.spec.override === 'wrap' && lower?.mcp ? { mcp: lower.mcp } : {}),
        source: Object.freeze({
          kind: 'extension' as const,
          id: entry.id,
          revision: entry.revision,
          instanceId: entry.owner.instanceId
        }),
        available: () =>
          entry.owner.state === 'ACTIVE' ||
          (entry.owner.state === 'STAGED' && ExtensionResourceScope.initializing),
        invoke: async (call: ToolCall, context: ExtensionOperationContext) =>
          entry.owner.run(
            (signal) =>
              this.callback(
                Object.freeze({
                  ...context,
                  signal,
                  extensionId: entry.id,
                  ownerInstanceId: entry.owner.instanceId
                }),
                async (context) => {
                  const signal = context.signal;
                  const approvedArguments =
                    context.permission === undefined ? undefined : structuredClone(call.arguments);
                  const input = await entry.parse(call.arguments);
                  const { permission: _permission, ...unapproved } = context;
                  const parsedContext: ExtensionOperationContext =
                    context.permission !== undefined && !isDeepStrictEqual(input, approvedArguments)
                      ? unapproved
                      : context;
                  signal.throwIfAborted();
                  const controller = new AbortController();
                  const effective = AbortSignal.any([signal, controller.signal]);
                  const pending = new Set<Promise<void>>();
                  let open = true;
                  let output: ToolExecutionResult;
                  try {
                    output = await entry.spec.execute(
                      input,
                      Object.freeze({
                        ...parsedContext,
                        signal: effective,
                        ownerInstanceId: entry.owner.instanceId
                      }),
                      (input) => {
                        const result = Promise.resolve().then(() => {
                          effective.throwIfAborted();
                          if (!open)
                            throw new AgentError(
                              'MAR_AGENT_TOOL_NOT_AVAILABLE',
                              'Tool continuation has finished.'
                            );
                          if (!lower || entry.spec.override !== 'wrap')
                            throw new AgentError(
                              'MAR_AGENT_EXTENSION_DEPENDENCY_MISSING',
                              'Tool has no wrapper continuation.'
                            );
                          return lower.invoke(
                            { ...call, arguments: input },
                            Object.freeze({
                              ...(parsedContext.permission !== undefined &&
                              isDeepStrictEqual(input, approvedArguments)
                                ? parsedContext
                                : unapproved),
                              signal: effective
                            })
                          );
                        });
                        const settled = result.then(
                          () => undefined,
                          () => undefined
                        );
                        pending.add(settled);
                        void settled.then(() => pending.delete(settled));
                        return result;
                      }
                    );
                  } catch (error) {
                    controller.abort();
                    throw error;
                  } finally {
                    while (pending.size) await Promise.all([...pending]);
                    open = false;
                  }
                  if (!output || typeof output.content !== 'string')
                    throw new AgentError(
                      'MAR_AGENT_TOOL_OUTPUT_INVALID',
                      'Tool result must contain string content.'
                    );
                  await entry.validateOutput?.(output.data);
                  return output;
                }
              ),
            context.signal
          )
      });
      bindings.set(
        definition.name,
        this.trace(binding, entry.spec.override === 'wrap' ? 'wrapper' : 'leaf')
      );
    }
    const view: ReadonlyMap<string, ExtensionToolBinding> = Object.freeze({
      get size() {
        return bindings.size;
      },
      get: (name: string) => bindings.get(name),
      has: (name: string) => bindings.has(name),
      entries: () => bindings.entries(),
      keys: () => bindings.keys(),
      values: () => bindings.values(),
      [Symbol.iterator]: () => bindings[Symbol.iterator](),
      forEach: (
        callback: (
          value: ExtensionToolBinding,
          key: string,
          map: ReadonlyMap<string, ExtensionToolBinding>
        ) => void,
        thisArg?: unknown
      ) => {
        for (const [key, value] of bindings) callback.call(thisArg, value, key, view);
      }
    });
    return view;
  }
}

function schemaValidator(
  schema: Record<string, unknown>,
  code: string
): (input: unknown) => unknown {
  let validator;
  try {
    validator = fromJSONSchema(withoutDefaults(schema));
  } catch {
    throw new AgentError(
      'MAR_AGENT_EXTENSION_TOOL_SCHEMA_UNSUPPORTED',
      'Schema requires an explicit native parser.'
    );
  }
  return (input) => {
    if (!validator.safeParse(input).success)
      throw new AgentError(code, 'Tool value does not match its declared schema.');
    return input;
  };
}

/** JSON Schema defaults are annotations, not permission to insert missing input values. */
function withoutDefaults(
  schema: Record<string, unknown> | boolean
): Record<string, unknown> | boolean {
  if (typeof schema === 'boolean') return schema;
  const copied = structuredClone(schema);
  delete copied.default;
  for (const key of ['properties', 'patternProperties', '$defs', 'definitions']) {
    const children = copied[key];
    if (children && typeof children === 'object')
      for (const [name, child] of Object.entries(children)) {
        if (child && typeof child === 'object' && !Array.isArray(child))
          (children as Record<string, unknown>)[name] = withoutDefaults(child);
      }
  }
  for (const key of ['anyOf', 'allOf', 'oneOf', 'prefixItems', 'items']) {
    const children = copied[key];
    if (Array.isArray(children))
      copied[key] = children.map((child: Record<string, unknown>) => withoutDefaults(child));
  }
  for (const key of [
    'items',
    'additionalItems',
    'additionalProperties',
    'contains',
    'not',
    'propertyNames'
  ]) {
    const child = copied[key];
    if (child && typeof child === 'object' && !Array.isArray(child))
      copied[key] = withoutDefaults(child as Record<string, unknown>);
  }
  return copied;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function copyDefinition(spec: ClientToolDefinition): ClientToolDefinition {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: structuredClone(spec.inputSchema),
    ...(spec.nativeType ? { nativeType: spec.nativeType } : {}),
    ...(spec.outputSchema ? { outputSchema: structuredClone(spec.outputSchema) } : {}),
    ...(spec.allowedCallers ? { allowedCallers: [...spec.allowedCallers] } : {}),
    ...(spec.eventInputFields ? { eventInputFields: [...spec.eventInputFields] } : {}),
    ...(spec.codeModeExposure !== undefined ? { codeModeExposure: spec.codeModeExposure } : {}),
    ...(spec.inputMode ? { inputMode: spec.inputMode } : {}),
    ...(spec.parallelSafety ? { parallelSafety: spec.parallelSafety } : {}),
    ...(spec.agentScope ? { agentScope: spec.agentScope } : {})
  };
}

export interface DomainToolOperations {
  'tool.invoke': { input: ToolCall; output: ToolExecutionResult };
}
export interface DomainToolFacts {
  'tool.completed': ExtensionToolCompletion;
  'tool.failed': ExtensionToolFailure;
  'tool.attempt.completed': ExtensionToolCompletion;
  'tool.attempt.failed': ExtensionToolFailure;
}
