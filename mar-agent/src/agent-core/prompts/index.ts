import type { ExecutionMode } from '../runtime/contracts.js';
import { renderPromptSections, type CorePromptPart } from '../extensions/prompt-composition.js';
import { compactionPrompt } from './compact.js';
import {
  environmentPrompt,
  identityPrompt,
  instructionPriorityPrompt,
  workspaceDisciplinePrompt
} from './core.js';
import { modePrompt } from './modes.js';
import { outputStylePrompt } from './output.js';
import { subagentPrompt } from './subagent.js';
import {
  interactionPrompt,
  longRunningPrompt,
  safetyPrompt,
  toolUsagePrompt,
  workflowPrompt
} from './workflow.js';

export const MAR_AGENT_PROMPT_VERSION = '1.67';

interface SystemPromptInput {
  mode: ExecutionMode;
  platform: string;
  architecture?: string;
  shell?: { readonly name: string; readonly path: string };
  guaranteedCommands?: Readonly<Record<string, string>>;
  workspace: string;
  tools: readonly string[];
  directTools?: readonly string[];
  extension?: string | undefined;
}

export function buildSystemPrompt(input: SystemPromptInput): string {
  return renderPromptSections(buildSystemPromptSections(input));
}

export function buildSystemPromptSections(input: SystemPromptInput): readonly CorePromptPart[] {
  const toolNames = new Set(input.tools);
  const hasLongRunningCapability = [
    'exec',
    'todo_read',
    'todo_write',
    'agent_start',
    'agent_wait',
    'agent_cancel'
  ].some((name) => toolNames.has(name));

  const values: readonly (readonly [string, string])[] = [
    ['identity', identityPrompt()],
    ['instruction-priority', instructionPriorityPrompt],
    ['workspace-discipline', workspaceDisciplinePrompt],
    ['workflow', workflowPrompt],
    ['interaction', interactionPrompt],
    ['safety', safetyPrompt],
    ['output-style', outputStylePrompt],
    ['environment-rules', environmentPrompt(input)],
    ['tools', input.tools.length > 0 ? toolUsagePrompt(input.tools, input.directTools) : ''],
    ['long-running', hasLongRunningCapability ? longRunningPrompt(input.tools) : ''],
    [
      'mode',
      modePrompt(input.mode, {
        questionAvailable: toolNames.has('question')
      })
    ],
    ['compaction', input.mode === 'compact' ? compactionPrompt() : ''],
    ['subagent', toolNames.has('agent_start') ? subagentPrompt : ''],
    [
      'caller-instructions',
      input.extension
        ? `# Caller, project, and selected Skill instructions\n${input.extension}`
        : ''
    ]
  ];
  return Object.freeze(
    values.map(([id, text]) => Object.freeze({ id: `core:${id}`, text: text || null }))
  );
}
