import { AgentError } from '@myagentroam/agent';
import type { AgentExtension } from '@myagentroam/agent/extensions';
import type {
  AgentNetworkAction,
  AgentNetworkInvoke,
  ResolvedTargets
} from '../../service/agent-network-service.js';
import { agentNetworkModelOutput } from './agent-network-model-output.js';
import { agentOperationEvent } from './agent-operation-presentation.js';
import { AGENT_WAIT_DEFAULTS } from '../../service/agent-network-wait.js';

const text = { type: 'string', minLength: 1 } as const;
const runner = {
  ...text,
  description:
    'Runner type (for example mar-agent), not a model name; defaults to the current Runner.'
} as const;
const goal = {
  description:
    'Optional persistent objective for continued work across executions, separate from the task message. Omit or use null to leave it unchanged; objective sets or replaces it, clear removes it but does not stop the current execution.',
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
      agentIds: {
        type: 'array',
        items: text,
        minItems: 1,
        maxItems: 8,
        description:
          'Target Session IDs, including a single target as a one-item array. Omit to select from direct children.'
      },
      mode: {
        type: 'string',
        enum: ['any', 'all'],
        description:
          'For explicit agentIds: return when any or all targets meet the wait condition.'
      },
      waitFor: {
        type: 'string',
        enum: ['message', 'completion'],
        description:
          'message waits for unread public output or a terminal execution; completion waits for a terminal execution, not necessarily success.'
      },
      waitMs: {
        type: 'integer',
        minimum: 0,
        maximum: 300000,
        description:
          'Maximum wait in milliseconds; 0 returns a snapshot. Timeout ends only this wait, not the target execution.'
      }
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
  'Verify consequential findings and changes, and retain responsibility for the final result. Before final delivery, resolve any outstanding child work required for the task. Results already available in context usually need no additional wait or view.'
].join('\n\n');

const collaborationPrompt = [
  '# Workspace collaboration',
  "Use native agent_* tools to collaborate within the Agent Network when another Session's context or ongoing work materially helps. Prefer focused requests and avoid unnecessary cross-Session coordination. Peer Sessions retain their own work and lifecycle; do not treat them as task-owned children or stop them merely for task cleanup.",
  'Prefer reusing known Session IDs rather than rediscovering them. Updates are most useful when requested or when the recipient needs to decide or change course; prefer combining related updates.',
  'An accepted message normally needs no separate acknowledgment. Requests for receipt-only replies and immediate agent_view calls solely to confirm receipt are usually unnecessary.',
  'The parent automatically collects the latest unread public reply and terminal state from each observed direct child before its next natural model request. Usually reply in the child Session itself rather than sending duplicate progress or completion reports with agent_send.',
  'Sending to a non-child Agent does not subscribe to future updates; waiting for a non-child observes it only for that call.',
  'Contact the parent proactively when timely action or a decision is needed, such as a blocker, scope conflict or major risk, or when explicitly asked to report. Routine child updates usually need no reply; prefer combining related guidance.'
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
            input.name === 'agent_wait' &&
            input.arguments !== null &&
            typeof input.arguments === 'object' &&
            'agentId' in input.arguments
          )
            throw new AgentError(
              'MAR_AGENT_TOOL_INPUT_INVALID',
              'Agent wait accepts agentIds, including for a single target.'
            );
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
            if (tool.action === 'wait')
              operationInput = {
                ...args,
                waitFor: args.waitFor ?? AGENT_WAIT_DEFAULTS.waitFor,
                waitMs: args.waitMs ?? AGENT_WAIT_DEFAULTS.waitMs,
                ...(Array.isArray(args.agentIds)
                  ? { mode: args.mode ?? AGENT_WAIT_DEFAULTS.mode }
                  : {})
              };
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
                    agentOperationEvent(tool.action, operationInput, result).eventData
                  );
                }
              : undefined;
            const result = await invoke(executionId, tool.action, operationInput, call, onResolved);
            const modelResult = agentNetworkModelOutput(tool.action, result);
            return {
              data: modelResult,
              content: JSON.stringify(modelResult),
              ...agentOperationEvent(tool.action, operationInput, result)
            };
          }
        });
    }
  };
}
