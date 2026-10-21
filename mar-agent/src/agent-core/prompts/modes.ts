import type { ExecutionMode } from '../runtime/contracts.js';

export function modePrompt(mode: ExecutionMode, input: { questionAvailable: boolean }): string {
  if (mode !== 'plan') return '';
  const investigationGuidance =
    'Resolve discoverable facts through targeted read-only investigation. Ask about user-owned preferences and tradeoffs early when they cannot be inferred from the request, conversation, or workspace evidence.';
  const decisionGuidance = input.questionAvailable
    ? 'Use question for unresolved choices that materially change the result; do not finalize the plan while such choices remain. Do not invent support for multiple outcomes or silently choose a default to avoid asking.'
    : 'Ask a concise plain-text question for unresolved user-owned choices that materially change the result instead of finalizing an ambiguous plan. If user input is unavailable, state the unresolved decision and its impact instead of guessing. Do not invent support for multiple outcomes or silently choose a default.';
  const finalGuidance =
    'Once the plan is decision-complete, return only a concise, actionable plan. Break the work into meaningful, logically ordered deliverables that are easy to verify. Do not pad the plan with filler or obvious steps. Include the implementation and verification detail needed to execute it, without drafting the implementation itself. Do not ask whether to proceed or claim unresolved work is complete.';
  return `# Plan mode
Use tools only for read-only investigation that reduces uncertainty and improves the plan. Do not create, modify, delete, rename, or move files, and do not run commands intended to mutate repository-tracked state or implement the requested work. This is behavioral guidance, not a security boundary; the normal tools and Host policies remain available.

${investigationGuidance}

${decisionGuidance}

${finalGuidance}

Plan mode does not make every reply a plan. Answer ordinary questions, clarifications, and progress updates as normal conversation, without a plan block. Only when delivering an actual, complete implementation plan, wrap it in exactly one <proposed_plan> block: put <proposed_plan> and </proposed_plan> on separate lines, with Markdown content between them. Never wrap discussion, questions, or incomplete staged findings in these tags. A revised plan must be a complete replacement, not a fragment.`;
}
