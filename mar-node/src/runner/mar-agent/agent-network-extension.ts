import { AgentError } from '@myagentroam/agent';
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

const deliveryGuidance =
  'STEER is the default and preferred for timely communication. QUEUE is best reserved for deferred delivery explicitly requested by the user or recipient, not merely to avoid interruption or send a report.';

const tools: readonly {
  action: AgentNetworkAction;
  parallelSafety: 'safe' | 'serial';
  description: string;
  properties: Record<string, unknown>;
  required?: readonly string[];
}[] = [
  {
    action: 'start',
    parallelSafety: 'safe',
    description:
      'Start a child Agent with a task and optional Goal; returns without waiting for completion.',
    properties: {
      content: text,
      runner,
      modelId: {
        ...text,
        description: 'Model configuration ID; omit to use the target Runner default.'
      },
      effort: text,
      title: text,
      goal,
      clientMessageId: text
    },
    required: ['title', 'content']
  },
  {
    action: 'send',
    parallelSafety: 'safe',
    description: 'Send a message to an Agent, update its Goal, or decide an approval.',
    properties: {
      agentId: text,
      content: { type: 'string' },
      goal,
      approval: {
        type: 'object',
        additionalProperties: false,
        required: ['approvalId', 'decision'],
        properties: { approvalId: text, decision: { type: 'string', enum: ['approve', 'reject'] } }
      },
      delivery: {
        type: 'string',
        enum: ['STEER', 'QUEUE'],
        description: `${deliveryGuidance} QUEUE is consumed only after current work and earlier queued inputs finish; an active Goal must exit first.`
      },
      clientMessageId: text
    },
    required: ['agentId']
  },
  {
    action: 'wait',
    parallelSafety: 'safe',
    description: 'Wait for Agent messages or execution completion.',
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
    parallelSafety: 'safe',
    description: 'Stop the Agent’s current execution and clear its Goal.',
    properties: { agentId: text },
    required: ['agentId']
  },
  {
    action: 'list',
    parallelSafety: 'safe',
    description: 'List the current collaboration tree or active Agents in the Workspace.',
    properties: {
      scope: {
        type: 'string',
        enum: ['tree', 'active'],
        description:
          'Defaults to tree: the containing tree, including ancestors, peers and descendants.'
      },
      query: {
        type: 'string',
        maxLength: 160,
        description: 'Optional case-insensitive title fragment within the scope.'
      },
      limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Defaults to 10.' }
    }
  },
  {
    action: 'view',
    parallelSafety: 'safe',
    description: "View an Agent's state, Goal and recent activity.",
    properties: {
      agentId: text
    },
    required: ['agentId']
  }
];

const delegationPrompt = [
  '# Delegation and coordination',
  'Prefer handling focused or tightly coupled work locally.',
  'Consider delegating a clearly separable subtask when parallel progress or context savings materially outweigh coordination overhead.',
  'Avoid splitting work merely because agents are available.',
  'A useful handoff includes an objective, necessary context, expected output, and a read-only boundary or non-overlapping write scope.',
  'Prefer following up through the direct delegate; deeper Session inspection is usually useful only when a concrete issue needs independent verification.',
  'While children run, prefer advancing meaningful, non-overlapping task work rather than duplicating delegated work. Waiting is generally useful once no meaningful local task work remains and a required result is needed to unblock or finish the task.',
  'Verify consequential findings and changes. Join or stop task-required child work before final delivery, and retain responsibility for the final result.'
].join('\n\n');

const collaborationPrompt = [
  '# Workspace collaboration',
  "Use native agent_* tools to collaborate within the Agent Network when another Session's context or ongoing work materially helps. Prefer focused requests and avoid unnecessary cross-Session coordination. Peer Sessions retain their own work and lifecycle; do not treat them as task-owned children or stop them merely for task cleanup.",
  'Prefer reusing known Session IDs rather than rediscovering them. Updates are most useful when requested or when the recipient needs to decide or change course; prefer combining related updates.',
  'An accepted message normally needs no separate acknowledgment. Requests for receipt-only replies and immediate agent_view calls solely to confirm receipt are usually unnecessary.',
  'For delegated work, prefer a concise final handoff over routine progress reports or duplicate completion messages. Early contact is most useful for requested updates, blockers, scope conflicts, or information needed for a decision.'
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
      // Reject retired input before generic unknown-field normalization can discard it.
      context.hooks.intercept(
        'tool.invoke',
        (input, _call, next) => {
          if (
            (input.name === 'agent_start' || input.name === 'agent_send') &&
            input.arguments !== null &&
            typeof input.arguments === 'object' &&
            ('attachments' in input.arguments || 'attachmentIds' in input.arguments)
          )
            throw new AgentError(
              'MAR_AGENT_TOOL_INPUT_INVALID',
              'Agent collaboration accepts text input only.'
            );
          return next(input);
        },
        { reentry: 'allow' }
      );
      context.hooks.intercept('prompt.sections', (input, _call, next) => {
        const available = new Set(input.facts?.tools);
        const enabled = input.facts?.mode !== 'compact';
        const delegate = enabled && available.has('agent_start');
        const models = delegate
          ? (context.models
              ?.list()
              .filter((model) => model.conversationModel && model.subagentModel)
              .map((model) => ({
                id: model.id,
                name: model.name,
                supportedEfforts: model.reasoningEfforts,
                defaultEffort: model.defaultReasoningEffort
              })) ?? [])
          : [];
        return next({
          ...input,
          sections: [
            ...input.sections,
            {
              id: 'mar.node.agent-network:delegation',
              text: delegate
                ? `${delegationPrompt}\n\nAvailable subagent models:\n${JSON.stringify({ runner: 'mar-agent', models })}`
                : null
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
          parallelSafety: tool.parallelSafety,
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
            let operationInput = args;
            if (tool.action === 'send') {
              const { delivery, ...sendInput } = args;
              const hasMessage = typeof args.content === 'string' && !!args.content.trim();
              operationInput =
                delivery !== undefined || hasMessage
                  ? {
                      ...sendInput,
                      deliveryIntent: delivery === 'QUEUE' ? 'QUEUE' : 'REPLACE_CURRENT'
                    }
                  : sendInput;
            }
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
