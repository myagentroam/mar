import type { AgentExtension } from '@myagentroam/agent/extensions';
import type {
  AgentNetworkAction,
  AgentNetworkInvoke
} from '../../service/agent-network-service.js';
import { agentNetworkWaitModelOutput } from './agent-network-wait-output.js';

const text = { type: 'string', minLength: 1 } as const;
const attachmentIds = {
  type: 'array',
  items: text,
  maxItems: 32,
  description: 'Existing composer attachment IDs.'
} as const;
const attachments = {
  type: 'array',
  maxItems: 5,
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'mime', 'dataBase64'],
    properties: { name: text, mime: text, dataBase64: text }
  }
} as const;
const goal = {
  anyOf: [
    { type: 'null' },
    {
      type: 'object',
      properties: { objective: text },
      required: ['objective'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: { clear: { type: 'boolean', const: true } },
      required: ['clear'],
      additionalProperties: false
    }
  ]
} as const;

const tools: readonly {
  action: AgentNetworkAction;
  description: string;
  properties: Record<string, unknown>;
  required?: readonly string[];
}[] = [
  {
    action: 'start',
    description:
      'Start a child Agent with a message or image and optional Goal; returns without waiting.',
    properties: {
      content: { type: 'string' },
      attachments,
      attachmentIds,
      runner: text,
      model: text,
      effort: text,
      title: text,
      goal,
      clientMessageId: text
    },
    required: ['title']
  },
  {
    action: 'send',
    description:
      'Send input, decide a child approval or update a Goal; goal:null leaves it unchanged, goal:{clear:true} clears it. Prefer REPLACE_CURRENT for timely communication or course correction. QUEUE is consumed only after current work and earlier queued inputs finish; an active Goal must exit first. Sending to a non-child does not subscribe to its updates.',
    properties: {
      agentId: text,
      content: { type: 'string' },
      attachments,
      attachmentIds,
      goal,
      approval: {
        type: 'object',
        additionalProperties: false,
        required: ['approvalId', 'decision'],
        properties: { approvalId: text, decision: { type: 'string', enum: ['approve', 'reject'] } }
      },
      deliveryIntent: { type: 'string', enum: ['SEND', 'QUEUE', 'REPLACE_CURRENT'] },
      clientMessageId: text
    },
    required: ['agentId']
  },
  {
    action: 'wait',
    description:
      'Wait for completion or messages; defaults to direct children, completion and 30 seconds. Use waitMs 0 for a snapshot. Non-child targets are observed only during this call.',
    properties: {
      agentId: text,
      agentIds: { type: 'array', items: text, minItems: 1, maxItems: 8 },
      mode: { type: 'string', enum: ['any', 'all'] },
      waitFor: { type: 'string', enum: ['message', 'completion'] },
      waitMs: { type: 'integer', minimum: 0, maximum: 300000 }
    }
  },
  {
    action: 'stop',
    description: 'Stop the specified Agent Execution and clear its Goal.',
    properties: { agentId: text, executionId: text },
    required: ['agentId', 'executionId']
  },
  {
    action: 'list',
    description: 'List Sessions, descendants or a Runner profile.',
    properties: {
      scope: { type: 'string', enum: ['workspace', 'children', 'descendants', 'profile'] },
      agentId: text,
      parent: text,
      runner: text,
      query: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      cursor: text
    }
  },
  {
    action: 'view',
    description: 'View an Agent session, Goal and recent history.',
    properties: {
      agentId: text,
      includeHistory: { type: 'boolean' },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      cursor: text
    },
    required: ['agentId']
  }
];

export function agentNetworkExtension(
  invoke: AgentNetworkInvoke,
  currentExecution: () => string | undefined
): AgentExtension {
  return {
    id: 'mar.node.agent-network',
    apiVersion: '1.0',
    attachSession(context) {
      for (const tool of tools)
        context.tools.register({
          name: `agent_${tool.action}`,
          description: tool.description,
          allowedCallers: ['direct', 'programmatic'],
          eventInputFields: [
            'agentId',
            'title',
            'executionId',
            'runner',
            'model',
            'effort',
            'waitFor',
            'waitMs',
            'scope'
          ],
          inputSchema: {
            type: 'object',
            properties: tool.properties,
            ...(tool.required ? { required: [...tool.required] } : {}),
            additionalProperties: false
          },
          async execute(input, call) {
            const executionId = currentExecution();
            if (!executionId) throw new Error('AGENT_ACTOR_NOT_ACTIVE');
            const result = await invoke(
              executionId,
              tool.action,
              input as Record<string, unknown>,
              call
            );
            const value =
              result !== null && typeof result === 'object' && !Array.isArray(result)
                ? (result as Record<string, unknown>)
                : undefined;
            const id = value?.agentId;
            const eventData =
              ['start', 'send', 'stop', 'wait'].includes(tool.action) &&
              typeof id === 'string' &&
              id.length > 0 &&
              id.length <= 128
                ? { agentId: id, productSessionId: id }
                : undefined;
            const modelResult =
              tool.action === 'wait' ? agentNetworkWaitModelOutput(result) : result;
            return {
              data: result,
              content: JSON.stringify(modelResult),
              eventSummary: JSON.stringify(eventData ?? {}),
              eventData: eventData ?? {}
            };
          }
        });
    }
  };
}
