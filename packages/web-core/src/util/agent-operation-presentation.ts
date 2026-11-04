import {
  agentOperationPresentationSchema,
  subagentCallDetailSchema,
  type AgentOperationPresentation
} from '@myagentroam/protocol';
import { conversationPayload } from './conversation-history.js';
import { readToolOutput } from './tool-presentation.js';

export function agentOperation(payload: unknown) {
  const value = conversationPayload(payload);
  const parsed = agentOperationPresentationSchema.safeParse(value?.agentOperation);
  return parsed.success ? parsed.data : undefined;
}

/** Runner IDs are not product Session mappings. Legacy fields remain read-only evidence. */
export function agentOperationTargets(payload: unknown) {
  const operation = agentOperation(payload);
  if (operation) return operation.targets;
  const value = conversationPayload(payload);
  if (typeof value?.subagentId !== 'string' || !value.subagentId) return [];
  return [{ agentId: value.subagentId }];
}

/** A card exists only for source-projected facts; old records retain generic details. */
export function agentOperationDetail(
  payload: unknown,
  status: string
):
  | {
      action: 'START' | 'SEND' | 'WAIT' | 'STOP' | 'LIST' | 'VIEW';
      targets: { title?: string; status?: string; message?: string; messageTruncated?: true }[];
      title?: string;
      message?: string;
      messageTruncated?: true;
      delivery?: 'QUEUE' | 'STEER';
      wait?: NonNullable<AgentOperationPresentation['detail']>['wait'];
      error?: string;
      targetsTruncated?: true;
      output?: string;
      outputTruncation?: 'HEAD' | 'SOURCE';
    }
  | undefined {
  if (['FAILED', 'DECLINED', 'CANCELLED', 'INTERRUPTED'].includes(status)) return undefined;
  const operation = agentOperation(payload);
  const value = conversationPayload(payload);
  if (!operation && value) {
    const detail = subagentCallDetailSchema.safeParse(value.subagentCallDetail);
    if (
      detail.success &&
      (value.subagentOperation === 'START' || value.subagentOperation === 'MESSAGE')
    )
      return {
        action: value.subagentOperation === 'START' ? 'START' : 'SEND',
        targets:
          value.subagentOperation === 'MESSAGE' &&
          typeof value.title === 'string' &&
          typeof value.toolName === 'string' &&
          value.title !== value.toolName
            ? [{ title: value.title }]
            : [],
        ...(value.subagentOperation === 'START' &&
        typeof value.title === 'string' &&
        value.title !== value.toolName
          ? { title: value.title }
          : {}),
        message: detail.data.message,
        ...(detail.data.messageTruncated ? { messageTruncated: true } : {})
      };
  }
  if (!operation?.detail || (operation.detail.failed && !operation.detail.message))
    return undefined;
  const output = operation.action === 'STOP' && value ? readToolOutput(value) : undefined;
  const targets = operation.targets.map((target) => ({
    ...(target.title ? { title: target.title } : {}),
    ...(target.status ? { status: target.status } : {}),
    ...(target.message ? { message: target.message } : {}),
    ...(target.messageTruncated ? { messageTruncated: true as const } : {})
  }));
  return {
    action: operation.action,
    targets,
    ...(operation.detail.title ? { title: operation.detail.title } : {}),
    ...(operation.detail.message ? { message: operation.detail.message } : {}),
    ...(operation.detail.messageTruncated ? { messageTruncated: true as const } : {}),
    ...(operation.detail.delivery ? { delivery: operation.detail.delivery } : {}),
    ...(operation.action === 'WAIT' && operation.detail.wait
      ? { wait: operation.detail.wait }
      : {}),
    ...(operation.detail.error ? { error: operation.detail.error } : {}),
    ...(operation.targetsTruncated ? { targetsTruncated: true as const } : {}),
    ...(output !== undefined
      ? { output: output.blocks.map((block) => block.text).join('\n') }
      : {}),
    ...(output?.truncation ? { outputTruncation: output.truncation } : {})
  };
}
