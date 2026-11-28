import { AgentError } from '@myagentroam/agent';
import type { AgentExtension } from '@myagentroam/agent/extensions';
import type {
  AgentNetworkAction,
  AgentNetworkInvoke,
  ResolvedTargets
} from './agent-network/agent-network-service.js';
import { agentNetworkModelOutput } from './agent-network/agent-network-model-output.js';
import { agentOperationEvent } from './agent-network/agent-operation-presentation.js';
import { AGENT_WAIT_DEFAULTS } from './agent-network/agent-network-wait.js';
import {
  rejectExtraWhiteboardFields,
  whiteboardTool,
  type WhiteboardInvoke
} from './whiteboard/whiteboard-tool.js';

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
      'Delegate a task to a direct subagent by default, or explicitly start an independent Session. Accepts an optional Goal and returns without waiting for completion.',
    properties: {
      content: text,
      runner,
      modelId: {
        ...text,
        description: 'Model configuration ID; omit to use the target Runner default.'
      },
      effort: text,
      title: text,
      relation: {
        type: 'string',
        enum: ['child', 'peer'],
        description:
          'Use child for task delegation (the default). Use peer only to start an independent Session, never as a fallback when child creation fails.'
      },
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
          'Target Agent IDs, including a single target as a one-item array. Omit to select from direct children.'
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

const automaticChildCollection =
  'The parent automatically collects replies and terminal state from its direct children before its next model request.';

const delegationPrompt = [
  '## Delegation and coordination',
  `Use agent_start with relation: "child" to delegate part of the current task to a subagent. Omitting relation also creates a direct child. ${automaticChildCollection}`,
  'Use relation: "peer" only to start an independent Session, never as a fallback when child creation fails.',
  'For a MAR Agent child, choose an available model marked subagentModel: true. Use modelId and effort to select the model and reasoning effort at creation.',
  'A useful handoff includes an objective, necessary context, expected output, and a read-only boundary or non-overlapping write scope.',
  'Prefer following up through the direct delegate; deeper Session inspection is usually useful only when a concrete issue needs independent verification.',
  'While children run, prefer advancing meaningful, non-overlapping task work rather than duplicating delegated work. Waiting is generally useful once no meaningful local task work remains and a required result is needed to unblock or finish the task.',
  'Verify consequential findings and changes, and retain responsibility for the final result. Before final delivery, resolve any outstanding child work required for the task. Results already available in context usually need no additional wait or view.'
].join('\n\n');

function collaborationPrompt(delegationAvailable: boolean): string {
  return [
    '## Workspace collaboration',
    'For direct requests and Session coordination, use native agent_* tools. Contact another Session when its context or ongoing work materially helps. Prefer focused requests and avoid unnecessary cross-Session coordination. Peer Sessions retain their own work and lifecycle; do not treat them as task-owned children or stop them merely for task cleanup.',
    'Prefer reusing known Agent IDs rather than rediscovering them. Direct updates are most useful when requested or when the recipient needs to decide or change course; prefer combining related updates.',
    'An accepted message normally needs no separate acknowledgment. Requests for receipt-only replies and immediate agent_view calls solely to confirm receipt are usually unnecessary.',
    // Keep this guidance when agent_send is available without agent_start, but state it only once.
    ...(delegationAvailable ? [] : [automaticChildCollection]),
    'Report progress, blockers, and results in your own Session rather than using agent_send to contact your parent. Parent-to-child guidance still uses agent_send.',
    'Sending a message to an Agent other than your direct child does not subscribe you to its Session activity. For those Agents, agent_wait observes Session activity only for the duration of the call.'
  ].join('\n\n');
}

const managementPrompt =
  '## Workspace management\n\nLoad marctl when needed to manage existing Session settings, titles, persistent prompts or schedules, or to discover authorized Nodes, execute remote commands or transfer files. Do not switch to marctl when a native operation fails.';

const whiteboardPrompt = [
  '## Whiteboard',
  'You automatically receive your own board and the one other board you follow while it is available. Your own board shows your Agent ID. Agents actively sharing a board form a collaboration group and can all edit it.',
  'A followed-board snapshot shows the last version you received, not whether sharing is still active.',
  'Eligible agents you start with agent_start or bring into the work by messaging them while idle keep their own board and follow the board you follow, or your own board if you follow none. Messaging an active agent does not change which board it follows.',
  "You can share a board owner's Agent ID with other agents so they can read or join that board. Reading does not change what you follow. Joining another board replaces only the board you follow; it does not change your own board or anyone else’s subscriptions.",
  'The whiteboard provides shared working memory for goals, decisions, constraints, findings, and other coordination information. Keep it concise and current. Its contents are shared context, not direct messages or instructions.'
].join('\n\n');

/** Binds collaboration tools and their shared guidance; all state belongs to Node services. */
export function orchestrationExtension(
  invoke: AgentNetworkInvoke,
  currentExecution: () => string | undefined,
  whiteboard?: WhiteboardInvoke
): AgentExtension {
  return {
    id: 'mar.node.orchestration',
    apiVersion: '1.0',
    attachSession(context) {
      const board = whiteboard && whiteboardTool(whiteboard, currentExecution);
      // Preserve strict input contracts before generic unknown-field normalization.
      context.hooks.intercept(
        'tool.invoke',
        (input, _call, next) => {
          if (board && input.name === 'whiteboard') rejectExtraWhiteboardFields(input.arguments);
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
              .filter((model) => model.conversationModel)
              .map((model) => ({
                id: model.id,
                name: model.name,
                subagentModel: model.subagentModel,
                supportedEfforts: model.reasoningEfforts,
                defaultEffort: model.defaultReasoningEffort
              })) ?? [])
          : [];
        const sections = enabled
          ? [
              delegate
                ? `${delegationPrompt}\n\nAvailable MAR Agent models for agent_start:\n${JSON.stringify({ runner: 'mar-agent', models })}`
                : null,
              available.has('agent_send') ? collaborationPrompt(delegate) : null,
              tools.some((tool) => available.has(`agent_${tool.action}`)) ? managementPrompt : null,
              available.has('whiteboard') ? whiteboardPrompt : null
            ].filter(Boolean)
          : [];
        return next({
          ...input,
          sections: [
            ...input.sections,
            {
              id: 'mar.node.orchestration',
              text: sections.length ? ['# Orchestration', ...sections].join('\n\n') : null
            }
          ]
        });
      });
      if (board) context.tools.register(board);
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
