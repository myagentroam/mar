import {
  AgentError,
  type Agent,
  type AgentReasoningEffort,
  type ExecutionHandle
} from '@myagentroam/agent';
import type {
  ExtensionOperationContext,
  SessionExtensionContext
} from '@myagentroam/agent/extensions';

export interface StartInput {
  readonly description: string;
  readonly title?: string;
  readonly prompt: string;
  readonly role: 'general-purpose' | 'explore';
  readonly modelId?: string;
  readonly reasoningEffort?: AgentReasoningEffort;
  readonly turnSignal?: AbortSignal;
}

/** Admission reservations are bounded quota accounting, not Execution state. */
export class StartAdmission {
  readonly #pending = new Map<string, number>();
  readonly #perExecution = new Map<string, number>();

  finish(executionId: string): void {
    this.#perExecution.delete(executionId);
  }

  reserve(agent: Agent, parentSessionId: string, executionId: string): (created: boolean) => void {
    return this.#reserve(agent, parentSessionId, executionId);
  }

  reserveResume(agent: Agent, parentSessionId: string): () => void {
    const release = this.#reserve(agent, parentSessionId);
    return () => release(false);
  }

  #reserve(
    agent: Agent,
    parentSessionId: string,
    executionId?: string
  ): (created: boolean) => void {
    const registration = agent.observeSessionExecutions(() => {});
    const active = registration.sessions.filter(
      (session) => session.source.parentSessionId === parentSessionId
    ).length;
    registration.unsubscribe();
    const used = executionId === undefined ? 0 : (this.#perExecution.get(executionId) ?? 0);
    const pending = this.#pending.get(parentSessionId) ?? 0;
    if (used >= 16 || active + pending >= 16)
      throw new AgentError('MAR_AGENT_SUBAGENT_LIMIT', 'Subagent admission limit was reached.');
    this.#pending.set(parentSessionId, pending + 1);
    if (executionId !== undefined) this.#perExecution.set(executionId, used + 1);
    let released = false;
    return (created) => {
      if (released) return;
      released = true;
      const remaining = (this.#pending.get(parentSessionId) ?? 1) - 1;
      if (remaining === 0) this.#pending.delete(parentSessionId);
      else this.#pending.set(parentSessionId, remaining);
      if (!created && executionId !== undefined)
        this.#perExecution.set(executionId, (this.#perExecution.get(executionId) ?? 1) - 1);
    };
  }
}

export function registerStart(
  context: SessionExtensionContext,
  agent: Agent,
  admission: StartAdmission
): void {
  context.tools.register({
    name: 'agent_start',
    description: 'Start a child Session and return its identity without waiting for completion.',
    allowedCallers: ['direct', 'programmatic'],
    parallelSafety: 'serial',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 80 },
        description: { type: 'string', minLength: 1, maxLength: 80 },
        prompt: { type: 'string', minLength: 1 },
        role: { type: 'string', enum: ['general-purpose', 'explore'] },
        modelId: { type: 'string', minLength: 1 },
        reasoningEffort: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
        }
      },
      required: ['title', 'prompt', 'role'],
      additionalProperties: false
    },
    async execute(raw, call) {
      const input = raw as Omit<StartInput, 'description'> & { description?: string };
      const { data } = await startChild(
        context,
        agent,
        admission,
        { ...input, description: input.description ?? input.title ?? '' },
        call,
        'model'
      );
      return { content: JSON.stringify(data), data, eventData: { agentId: data.agentId } };
    }
  });
}

/** Both adapters enter this Session-owned creation path with their actual Core operation. */
export async function startChild(
  context: SessionExtensionContext,
  agent: Agent,
  admission: StartAdmission,
  input: StartInput,
  call: ExtensionOperationContext,
  mode: 'model' | 'native'
): Promise<{ data: Record<string, unknown>; execution?: ExecutionHandle }> {
  if ((mode === 'model' && !call.executionId) || !context.session || !context.models)
    throw new AgentError('MAR_AGENT_SUBAGENT_LIMIT', 'An active parent Execution is required.');
  if (mode === 'model' && (typeof input.title !== 'string' || !input.title.trim()))
    throw new AgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Child title is required.');
  if (
    !input.description.trim() ||
    !input.prompt.trim() ||
    (mode === 'model' && Buffer.byteLength(input.prompt) > 131_072)
  )
    throw new AgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Child description or prompt is invalid.');
  const parent = await agent.getSession(context.sessionId);
  let root = parent;
  let depth = 1;
  const visited = new Set([root.id]);
  while (root.source.parentSessionId !== undefined) {
    if (depth >= 3 || visited.has(root.source.parentSessionId))
      throw new AgentError('MAR_AGENT_SUBAGENT_LIMIT', 'Child Session depth limit was reached.');
    root = await agent.getSession(root.source.parentSessionId);
    if (root.workspace !== parent.workspace)
      throw new AgentError('MAR_AGENT_SUBAGENT_LIMIT', 'Child ancestry is invalid.');
    visited.add(root.id);
    depth++;
  }
  if (depth >= 3)
    throw new AgentError('MAR_AGENT_SUBAGENT_LIMIT', 'Child Session depth limit was reached.');
  const request = mode === 'model' ? await context.session.captureRequest() : undefined;
  const selected =
    input.modelId ??
    request?.request.modelId ??
    (mode === 'native'
      ? (parent.modelId ?? context.models.list().find((candidate) => candidate.isDefault)?.id)
      : undefined);
  if (!selected)
    throw new AgentError('MAR_AGENT_MODEL_CONFIG_INVALID', 'Child model is unavailable.');
  const effort =
    input.reasoningEffort ??
    request?.request.reasoningEffort ??
    (mode === 'native' ? parent.reasoningEffort : undefined);
  const validate = () => {
    const model = context.models!.list().find((candidate) => candidate.id === selected);
    if (!model?.conversationModel || !model.subagentModel)
      throw new AgentError('MAR_AGENT_MODEL_DISABLED', 'The selected child model is not eligible.');
    if (input.reasoningEffort && !model.reasoningEfforts.includes(input.reasoningEffort))
      throw new AgentError(
        'MAR_AGENT_SUBAGENT_REASONING_EFFORT_UNAVAILABLE',
        'The selected child effort is unavailable.'
      );
    const effectiveEffort =
      input.reasoningEffort ??
      model.reasoningEfforts.find((candidate) => candidate === effort) ??
      model.defaultReasoningEffort;
    return { model, effectiveEffort };
  };
  validate();
  call.signal.throwIfAborted();
  input.turnSignal?.throwIfAborted();
  const nativeRelease = mode === 'native' ? admission.reserveResume(agent, parent.id) : undefined;
  const release = nativeRelease
    ? (_created: boolean) => nativeRelease()
    : admission.reserve(agent, parent.id, call.executionId!);
  let childId: string | undefined;
  try {
    const child = await agent.createSession({
      workspace: parent.workspace,
      ...(mode === 'model' ? { title: input.title!.trim() } : {}),
      source: {
        type: 'subagent',
        parentSessionId: parent.id,
        rootSessionId: root.id,
        ...(call.executionId ? { parentExecutionId: call.executionId } : {}),
        parentOperationId: call.operationId,
        ...(call.ownerInstanceId ? { ownerInstanceId: call.ownerInstanceId } : {}),
        ...(call.extensionId ? { extensionId: call.extensionId } : {}),
        role: input.role,
        description: input.description.trim()
      }
    });
    childId = child.id;
    call.signal.throwIfAborted();
    input.turnSignal?.throwIfAborted();
    const { model, effectiveEffort } = validate();
    const originId = parent.id.replace(
      /[&<>"']/g,
      (character) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&apos;'
        })[character]!
    );
    const prompt = `<mar_session_origin sessionId="${originId}" relation="parent">\n  <instruction>Message from the parent session.</instruction>\n</mar_session_origin>\n${input.prompt}`;
    const executionInput = {
      prompt,
      modelId: model.id,
      reasoningEffort: effectiveEffort,
      permissionMode: call.permissionMode ?? ('auto' as const)
    };
    const execution =
      input.role === 'explore' ? child.plan(executionInput) : child.run(executionInput);
    if (input.turnSignal) {
      const turnSignal = input.turnSignal;
      const cancel = () => execution.cancel();
      turnSignal.addEventListener('abort', cancel, { once: true });
      if (turnSignal.aborted) cancel();
      void execution
        .result()
        .finally(() => turnSignal.removeEventListener('abort', cancel))
        .catch(() => {});
    } else void execution.result().catch(() => {});
    const result = {
      agentId: child.id,
      executionId: execution.executionId,
      status: 'running',
      modelId: model.id,
      modelName: model.name,
      reasoningEffort: effectiveEffort,
      description: input.description.trim(),
      role: input.role
    };
    return { data: result, execution };
  } catch (error) {
    if (childId === undefined) throw error;
    const result = {
      agentId: childId,
      status: 'not-started',
      description: input.description.trim(),
      role: input.role,
      errorCode: error instanceof AgentError ? error.code : 'MAR_AGENT_SUBAGENT_START_FAILED'
    };
    return { data: result };
  } finally {
    release(childId !== undefined);
  }
}
