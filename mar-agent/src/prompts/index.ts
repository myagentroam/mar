import type { ExecutionMode } from '../runtime/contracts.js';
import { renderPromptSections, type PromptPart } from './prompt-sections.js';
import { compactionPrompt } from './compact.js';
import {
  environmentPrompt,
  identityPrompt,
  instructionPriorityPrompt,
  progressCommunicationPrompt,
  securityPrompt
} from './core.js';
import { modePrompt } from './modes.js';
import { toolUsagePrompt } from './workflow.js';

export const MAR_AGENT_PROMPT_VERSION = '1.83';

interface SystemPromptInput {
  mode: ExecutionMode;
  platform: string;
  architecture?: string;
  shell?: { readonly name: string; readonly path: string };
  guaranteedCommands?: Readonly<Record<string, string>>;
  workspace: string;
  worktreeRoot?: string;
  tools: readonly string[];
  directTools?: readonly string[];
  extension?: string | undefined;
}

export function buildSystemPrompt(input: SystemPromptInput): string {
  return renderPromptSections(buildSystemPromptSections(input));
}

export function buildSystemPromptSections(input: SystemPromptInput): readonly PromptPart[] {
  const toolNames = new Set(input.tools);

  const values: readonly (readonly [string, string | null])[] = [
    ['identity', identityPrompt()],
    ['instruction-priority', instructionPriorityPrompt],
    ['safety', securityPrompt],
    ['environment-rules', environmentPrompt(input)],
    ['tools', input.tools.length > 0 ? toolUsagePrompt(input.tools, input.directTools) : ''],
    ['interaction', input.mode === 'compact' ? null : progressCommunicationPrompt],
    [
      'mode',
      modePrompt(input.mode, {
        questionAvailable: toolNames.has('question')
      })
    ],
    ['compaction', input.mode === 'compact' ? compactionPrompt() : ''],
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
