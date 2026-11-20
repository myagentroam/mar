import type { ClientToolDefinition } from '../contracts.js';
import { AgentError } from '../../error.js';

import { SMART_COMPACTION_MARKER } from '../../runtime/compaction/smart.js';
import type { ToolRuntimeContext } from '../runtime-context.js';

export const smartCompactToolDefinition: ClientToolDefinition = {
  name: 'smart_compact',
  allowedCallers: ['direct', 'programmatic'],
  parallelSafety: 'safe',
  description:
    'Request background context compaction only when the Runtime marks the current real user message with this note: ' +
    SMART_COMPACTION_MARKER +
    ' The note indicates eligibility, not a recommendation; historical notes do not qualify the current input. Call only if the transition is clear and a summary can preserve the key state needed to continue. Acceptance does not wait for generation or installation.',
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
