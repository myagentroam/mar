import { AgentError } from '../../error.js';
import type { ClientToolDefinition } from '../contracts.js';

export const THOUGHT_TOOL_NAME = 'thought';
const maxTitleLength = 256;
const maxContentBytes = 32 * 1024;

export const thoughtToolDefinition: ClientToolDefinition = {
  name: THOUGHT_TOOL_NAME,
  autoPermission: 'omit',
  allowedCallers: ['direct'],
  parallelSafety: 'safe',
  eventInputFields: [],
  description: 'Record reusable insights for subsequent reasoning.',
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description:
          "A concise, human-readable title capturing the key insight in the user's language.",
        minLength: 1,
        maxLength: maxTitleLength
      },
      content: {
        type: 'string',
        description: `Record reusable insights not yet captured in durable artifacts: findings,
decisions and evidence, rejected approaches and why, assumptions, and open
questions.

Write for reuse in subsequent reasoning: telegraphic fragments, standard
domain abbreviations, exact identifiers and values, and compact symbolic
relations. Omit connective prose, redundant context, and progress recaps.
Compress wording, not meaning: preserve causal links and dependencies,
and distinguish verified facts from hypotheses. Do not include secrets
or private deliberation.`,
        minLength: 1,
        maxLength: maxContentBytes
      }
    },
    required: ['title', 'content'],
    additionalProperties: false
  }
};

/** Validate the note fields independently of the invocation's framework metadata. */
export function readThoughtInput(input: unknown): { title: string; content: string } {
  const { title, content } =
    input && typeof input === 'object' ? (input as { title?: unknown; content?: unknown }) : {};
  if (typeof title !== 'string' || !title.trim() || [...title].length > maxTitleLength)
    throw new AgentError(
      'MAR_AGENT_TOOL_INPUT_INVALID',
      'Thought title must be non-blank and at most 256 characters.'
    );
  if (
    typeof content !== 'string' ||
    !content.trim() ||
    Buffer.byteLength(content) > maxContentBytes
  )
    throw new AgentError(
      'MAR_AGENT_TOOL_INPUT_INVALID',
      'Thought content must be non-blank and at most 32 KiB (UTF-8).'
    );
  return { title, content };
}

export async function executeThought(input: unknown) {
  readThoughtInput(input);
  return { content: '{"status":"recorded"}' };
}
