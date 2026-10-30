import type { AgentExtension } from '@myagentroam/agent/extensions';
import type {
  AgentNetworkAction,
  AgentNetworkInvoke,
  ResolvedTargets
} from '../../service/agent-network-service.js';
import { agentNetworkWaitModelOutput } from './agent-network-wait-output.js';
import { agentOperationEvent } from './agent-operation-presentation.js';

const text = { type: 'string', minLength: 1 } as const;
const runner = {
  ...text,
  description:
    'Runner type (for example mar-agent), not a model name; defaults to the current Runner.'
} as const;
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
      runner,
      modelId: {
        ...text,
        description:
          'Model ID from the target Runner Profile models[].id, not a display name. For MAR Agent this is an internal configuration ID, not an upstream model ID; omit to use the Runner default.'
      },
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
      'Send input, decide an approval or update a Goal; goal:null leaves it unchanged, goal:{clear:true} clears it. Messages default to REPLACE_CURRENT (steer); use QUEUE only when deferred delivery is explicitly requested. QUEUE is consumed only after current work and earlier queued inputs finish; an active Goal must exit first.',
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
      deliveryIntent: {
        type: 'string',
        enum: ['SEND', 'QUEUE', 'REPLACE_CURRENT'],
        description:
          'Message delivery defaults to REPLACE_CURRENT (steer); explicit SEND remains supported.'
      },
      clientMessageId: text
    },
    required: ['agentId']
  },
  {
    action: 'wait',
    description:
      'Wait for completion or messages; defaults to direct children, completion and 30 seconds. Use waitMs 0 for a snapshot.',
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
    description:
      'List direct children by default, discover Workspace Sessions, inspect descendants or query a Runner profile.',
    properties: {
      scope: { type: 'string', enum: ['workspace', 'children', 'descendants', 'profile'] },
      agentId: {
        ...text,
        description: 'Root for children or descendants; defaults to the current Session.'
      },
      runner: {
        ...runner,
        description: 'Runner for profile scope; defaults to the current Runner, not a model name.'
      },
      query: { type: 'string', description: 'Search Sessions; not a model selector.' },
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

const delegationPrompt = [
  '# Delegation and coordination',
  'Delegate bounded, self-contained tasks when independent progress or context savings materially helps. Keep simple or tightly coupled work local.',
  'Give each child an objective, necessary context, expected output, and a read-only boundary or non-overlapping write scope.',
  'Follow up through the direct delegate by default; inspect deeper Sessions only when a concrete issue needs independent verification.',
  'While children run, continue meaningful non-overlapping work. Do not redo delegated work. Wait only when the next step needs the result.',
  'Verify consequential findings and changes. Join or stop task-required child work before final delivery, and retain responsibility for the final result.'
].join('\n\n');

const collaborationPrompt = [
  '# Workspace collaboration',
  "Use native agent_* tools to collaborate within the Agent Network when another Session's context or ongoing work materially helps. Keep requests focused and avoid unnecessary cross-Session coordination. Peer Sessions retain their own work and lifecycle; do not treat them as task-owned children or stop them merely for task cleanup. Explicitly wait when you need progress or completion.",
  "Reuse known Session IDs rather than rediscovering them. Send updates for meaningful progress, blockers, or changes that affect the recipient's work; combine related updates and avoid acknowledgment-only exchanges."
].join('\n\n');

const managementPrompt = [
  '# Workspace management',
  "Load marctl when needed to manage existing Session settings, titles, persistent prompts or schedules, or to discover authorized Nodes, execute remote commands or transfer files. Ordinary Agent collaboration and selecting a child's model or effort at creation use native agent_* tools. Do not switch to marctl when a native operation fails."
].join('\n\n');

export function agentNetworkExtension(
  invoke: AgentNetworkInvoke,
  currentExecution: () => string | undefined
): AgentExtension {
  return {
    id: 'mar.node.agent-network',
    apiVersion: '1.0',
    attachSession(context) {
      context.hooks.intercept('prompt.sections', (input, _call, next) => {
        const available = new Set(input.facts?.tools);
        const enabled = input.facts?.mode !== 'compact';
        return next({
          ...input,
          sections: [
            ...input.sections,
            {
              id: 'mar.node.agent-network:delegation',
              text: enabled && available.has('agent_start') ? delegationPrompt : null
            },
            {
              id: 'mar.node.agent-network:collaboration',
              text: enabled && available.has('agent_send') ? collaborationPrompt : null
            },
            {
              id: 'mar.node.agent-network:management',
              text:
                enabled && tools.some((tool) => available.has(`agent_${tool.action}`))
                  ? managementPrompt
                  : null
            }
          ]
        });
      });
      for (const tool of tools)
        context.tools.register({
          name: `agent_${tool.action}`,
          description: tool.description,
          allowedCallers: ['direct', 'programmatic'],
          eventInputFields: [
            'agentId',
            'agentIds',
            'title',
            'executionId',
            'runner',
            'modelId',
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
            const args = input as Record<string, unknown>;
            const operationInput =
              tool.action === 'send' &&
              args.deliveryIntent === undefined &&
              ((typeof args.content === 'string' && !!args.content.trim()) ||
                (Array.isArray(args.attachments) && args.attachments.length > 0) ||
                (Array.isArray(args.attachmentIds) && args.attachmentIds.length > 0))
                ? { ...args, deliveryIntent: 'REPLACE_CURRENT' }
                : args;
            const onResolved: ResolvedTargets | undefined = call.publishEventData
              ? async (sessions) => {
                  const rows = sessions.map((session) => ({
                    agentId: session.id,
                    title: session.customTitle ?? session.runnerTitle ?? undefined
                  }));
                  const result =
                    tool.action === 'wait'
                      ? { agents: rows }
                      : tool.action === 'view'
                        ? { session: rows[0] }
                        : (rows[0] ?? {});
                  await call.publishEventData!(
                    agentOperationEvent(tool.action, {}, result).eventData
                  );
                }
              : undefined;
            const result = await invoke(executionId, tool.action, operationInput, call, onResolved);
            const modelResult =
              tool.action === 'wait' ? agentNetworkWaitModelOutput(result) : result;
            return {
              data: result,
              content: JSON.stringify(modelResult),
              ...agentOperationEvent(tool.action, operationInput, result)
            };
          }
        });
    }
  };
}
