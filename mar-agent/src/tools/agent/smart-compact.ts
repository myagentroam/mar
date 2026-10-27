import type { ClientToolDefinition } from '../contracts.js';
import { AgentError } from '../../error.js';

import { SMART_COMPACTION_MARKER } from '../../runtime/compaction/smart.js';
import type { ToolRuntimeContext } from '../runtime-context.js';

export const smartCompactToolDefinition: ClientToolDefinition = {
  name: 'smart_compact',
  allowedCallers: ['direct', 'programmatic'],
  parallelSafety: 'safe',
  description:
    'Request background context compaction only when the current real user message includes this runtime note: ' +
    SMART_COMPACTION_MARKER +
    ' The note indicates capacity eligibility, not a recommendation; historical notes do not qualify the current input. Judge the phase transition from the conversation; call only if key state can be retained in a summary. Do not call merely because context is long, for a one-off question, or while continuing unresolved work that still needs prior evidence. A new user message or completed reply alone is not a phase transition. If uncertain, skip. Prefer calling alongside the first necessary tools. Acceptance does not wait for generation or installation.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false }
};

export function executeSmartCompact(arguments_: unknown, context: ToolRuntimeContext) {
  if (
    !arguments_ ||
    typeof arguments_ !== 'object' ||
    Array.isArray(arguments_) ||
    Object.keys(arguments_).length
  )
    throw new AgentError(
      'MAR_AGENT_TOOL_INPUT_INVALID',
      'Smart Compaction input must be an empty object.'
    );
  if (!context.requestSmartCompact)
    throw new AgentError(
      'MAR_AGENT_SMART_COMPACT_DENIED',
      'The current user input is not eligible for Smart Compaction.'
    );
  context.requestSmartCompact();
  const data = { status: 'accepted' };
  return Promise.resolve({ content: JSON.stringify(data), data });
}
