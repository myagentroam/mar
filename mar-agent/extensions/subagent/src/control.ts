import { randomUUID } from 'node:crypto';
import {
  AgentError,
  type Agent,
  type AgentReasoningEffort,
  type AgentSession,
  type ExecutionResult
} from '@myagentroam/agent';
import type {
  ExtensionOperationContext,
  SessionExtensionContext
} from '@myagentroam/agent/extensions';
import type { SessionObservations } from './observations.js';
import type { StartAdmission } from './start.js';
import { publicChildSnapshot } from './snapshot.js';
import { historicalExecutionStatus } from './history.js';

async function relation(agent: Agent, actorId: string, id: string) {
  const [actor, other] = await Promise.all([agent.getSession(actorId), agent.getSession(id)]);
  if (actor.workspace !== other.workspace || actorId === id)
    throw new AgentError('MAR_AGENT_SUBAGENT_NOT_FOUND', 'Session is not available.');
  const child = other.source.parentSessionId === actorId;
  const parent = actor.source.parentSessionId === id;
  if (!child && !parent)
    throw new AgentError('MAR_AGENT_SUBAGENT_NOT_FOUND', 'Session is not available.');
  return { summary: other, child, parent };
}

export async function target(agent: Agent, actorId: string, id: string) {
  const resolved = await relation(agent, actorId, id);
  if (!resolved.child)
    throw new AgentError('MAR_AGENT_SUBAGENT_NOT_FOUND', 'Session is not available.');
  return { ...resolved, session: await agent.openSession(id) };
}

function active(session: AgentSession) {
  const snapshot = session.subscribe(() => {});
  snapshot.unsubscribe();
  return snapshot;
}

async function join(promise: Promise<ExecutionResult>, signal: AbortSignal) {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([promise, cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

function origin(id: string, parent: boolean, message: string) {
  const relation = parent ? 'other session' : 'parent session';
  return `<mar_session_origin sessionId="${id}" relation="${parent ? 'other' : 'parent'}">\n  <instruction>Message from the ${relation}.</instruction>\n</mar_session_origin>\n\n${message}`;
}

/** Local operations use the Session owner for all execution and input transitions. */
export function registerControlTools(
  context: SessionExtensionContext,
  agent: Agent,
  observations: SessionObservations,
  warmObservations: ReadonlyMap<string, SessionObservations>,
  admission: StartAdmission
): void {
  context.tools.register({
    name: 'agent_send',
    description: 'Send a message to a direct child or report to the direct parent.',
    allowedCallers: ['direct', 'programmatic'],
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', minLength: 1 },
        content: { type: 'string', minLength: 1 },
        delivery: { type: 'string', enum: ['append', 'replace'] }
      },
      required: ['agentId', 'content'],
      additionalProperties: false
    },
    async execute(value, call) {
      const input = value as { agentId: string; content: string; delivery?: 'append' | 'replace' };
      const data = await sendChild(
        context,
        agent,
        observations,
        warmObservations,
        admission,
        input,
        call,
        'model'
      );
      return { data, content: JSON.stringify(data) };
    }
  });
  context.tools.register({
    name: 'agent_stop',
    description: 'Stop a direct child execution and wait for its cleanup.',
    allowedCallers: ['direct', 'programmatic'],
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', minLength: 1 },
        executionId: { type: 'string', minLength: 1 }
      },
      required: ['agentId'],
      additionalProperties: false
    },
    async execute(value, call) {
      const input = value as { agentId: string; executionId?: string };
      const data = await stopChild(context, agent, observations, input, call);
      return { data, content: JSON.stringify(data) };
    }
  });
}

export async function sendChild(
  context: SessionExtensionContext,
  agent: Agent,
  observations: SessionObservations,
  warmObservations: ReadonlyMap<string, SessionObservations>,
  admission: StartAdmission,
  input: { agentId: string; content: string; delivery?: 'append' | 'replace' },
  call: ExtensionOperationContext,
  mode: 'model' | 'native'
) {
  if (!input.content.trim() || (mode === 'model' && Buffer.byteLength(input.content) > 131072))
    throw new AgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Message is invalid.');
  const { summary, child, parent } = await relation(agent, context.sessionId, input.agentId);
  if (parent && input.delivery === 'replace')
    throw new AgentError('MAR_AGENT_SUBAGENT_NOT_FOUND', 'Session is not available.');
  call.signal.throwIfAborted();
  if (parent) {
    const receiver = warmObservations.get(input.agentId);
    if (
      !call.executionId ||
      !receiver?.report(
        context.sessionId,
        call.executionId,
        origin(context.sessionId, true, input.content)
      )
    )
      throw new AgentError(
        'MAR_AGENT_SUBAGENT_PARENT_IDLE',
        'Parent Session is not available for reports.'
      );
    const data = { agentId: input.agentId, delivery: 'reported', clientMessageId: randomUUID() };
    return data;
  }
  const session = await agent.openSession(input.agentId);
  call.signal.throwIfAborted();
  const current = active(session);
  const acknowledgePrevious = observations.acknowledgement(session.id);
  const content = origin(context.sessionId, parent, input.content);
  const clientMessageId = randomUUID();
  if (current.activeExecutionId && !current.terminalEvent && input.delivery !== 'replace') {
    const receipt = await session.steer({
      expectedExecutionId: current.activeExecutionId,
      prompt: content,
      clientMessageId
    });
    if (receipt.status !== 'notAccepted') {
      acknowledgePrevious();
      if (receipt.status === 'accepted')
        (mode === 'native'
          ? observations
          : (warmObservations.get(context.sessionId) ?? observations)
        ).rememberReceipt(session.id, { clientMessageId, executionId: current.activeExecutionId });
      const data = {
        agentId: session.id,
        executionId: current.activeExecutionId,
        delivery: receipt.status,
        clientMessageId,
        ...(receipt.status === 'accepted'
          ? { messageId: clientMessageId, turnId: receipt.entry.turnId, deliveryStatus: 'accepted' }
          : {})
      };
      return data;
    }
    const after = active(session);
    if (after.activeExecutionId && !after.terminalEvent)
      throw new AgentError(
        'MAR_AGENT_SUBAGENT_INPUT_NOT_ACCEPTED',
        'Target did not accept the message.'
      );
  }
  if (!child) throw new AgentError('MAR_AGENT_SUBAGENT_NOT_FOUND', 'Session is not available.');
  if (current.activeExecutionId) {
    const completion = session.joinExecution(current.activeExecutionId);
    if (!current.terminalEvent && input.delivery === 'replace')
      await session.cancel(current.activeExecutionId);
    if (completion) await join(completion, call.signal);
  }
  const models = context.models!.list();
  const model = models.find(
    (item) => item.id === (summary.modelId ?? models.find((item) => item.isDefault)?.id)
  );
  if (!model?.conversationModel || !model.subagentModel)
    throw new AgentError(
      'MAR_AGENT_SUBAGENT_MODEL_INVALID',
      'Target model is not available for child Sessions.'
    );
  const effort =
    summary.reasoningEffort &&
    model.reasoningEfforts.includes(summary.reasoningEffort as AgentReasoningEffort)
      ? (summary.reasoningEffort as AgentReasoningEffort)
      : model.defaultReasoningEffort;
  call.signal.throwIfAborted();
  const executionInput = {
    prompt: content,
    clientMessageId,
    modelId: model.id,
    reasoningEffort: effort,
    permissionMode: call.permissionMode ?? ('auto' as const)
  };
  const release = admission.reserveResume(agent, context.sessionId);
  let execution: ReturnType<AgentSession['run']>;
  try {
    execution =
      summary.source.type === 'subagent' && summary.source.role === 'explore'
        ? session.plan(executionInput)
        : session.run(executionInput);
  } finally {
    release();
  }
  acknowledgePrevious();
  (mode === 'native'
    ? observations
    : (warmObservations.get(context.sessionId) ?? observations)
  ).rememberReceipt(session.id, { clientMessageId, executionId: execution.executionId });
  const data = {
    agentId: session.id,
    executionId: execution.executionId,
    delivery: 'started',
    clientMessageId,
    messageId: clientMessageId,
    deliveryStatus: 'accepted',
    ...(execution.turnId === undefined ? {} : { turnId: execution.turnId })
  };
  return data;
}

/** Stop through the Session owner; native callers use their own observation cursor. */
export async function stopChild(
  context: SessionExtensionContext,
  agent: Agent,
  observations: SessionObservations,
  input: { agentId: string; executionId?: string },
  call: ExtensionOperationContext
) {
  const { child, session } = await target(agent, context.sessionId, input.agentId);
  if (!child) throw new AgentError('MAR_AGENT_SUBAGENT_NOT_FOUND', 'Session is not available.');
  const current = active(session);
  if (!current.activeExecutionId && !input.executionId) {
    const state = await historicalExecutionStatus(agent, session.id, call.signal);
    return { agentId: session.id, ...state };
  }
  if (
    !current.activeExecutionId ||
    (input.executionId && input.executionId !== current.activeExecutionId)
  )
    throw new AgentError('MAR_AGENT_SUBAGENT_EXECUTION_STALE', 'Execution is not active.');
  const completion = session.joinExecution(current.activeExecutionId);
  if (!completion)
    throw new AgentError('MAR_AGENT_SUBAGENT_EXECUTION_STALE', 'Execution is not active.');
  if (!current.terminalEvent) await session.cancel(current.activeExecutionId);
  const result = await join(completion, call.signal);
  call.signal.throwIfAborted();
  const observation = observations.capture(session.id, current.activeExecutionId);
  const data = {
    agentId: session.id,
    executionId: current.activeExecutionId,
    status: result.status,
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    ...(result.permissionStop ? { permissionStop: result.permissionStop } : {}),
    ...publicChildSnapshot(observations.snapshot(session.id, current.activeExecutionId)),
    ...(observation?.updates.length ? { updates: observation.updates } : {})
  };
  observation?.acknowledge();
  return data;
}
