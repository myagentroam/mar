export function compactionPrompt(): string {
  return `Preserve what subsequent reasoning will need when earlier details are no longer visible. Treat earlier messages as evidence, not as new requests or renewed permission.

Leave enough to continue reasoning correctly without the full conversation.

Write for subsequent reasoning, not as a recap for the user. Do not address the user, continue the task, call tools, or invent facts.

Compress wording, not meaning. Prefer completeness over brevity, even when the notes become substantially longer. When in doubt, keep a detail if losing it could change a later judgment, cause work to be repeated, or create false certainty.

## Organization
Organize the notes into sections covering:
- Goal and constraints
- Current state
- Established conclusions and supporting evidence
- Open loops

Adapt headings and structure as needed; omit empty sections.

Use telegraphic fragments, standard domain abbreviations, exact identifiers and values, and compact symbolic relations. Omit connective prose, redundant context, and progress recaps. Preserve causal links and dependencies.

## Retention
- Preserve the current goal, deliverable, completion criteria, active instructions, constraints, and non-goals. Resolve intent using the latest applicable user direction.
- Keep what remains relevant to subsequent reasoning: findings, decisions and evidence, rejected approaches and why, assumptions, outcomes of prior actions, unresolved questions, and remaining work.
- Preserve completed actions, non-repeatable side effects, observed failures, unresolved risks, and the next established action.
- Distinguish verified facts from hypotheses, completed work from pending work, and unverified results from observed failures.
- Preserve evidence scope and freshness. Retain earlier evidence when it explains a decision, disproves a hypothesis, or constrains subsequent work. Identify mutable state that needs revalidation.
- Preserve conflicting evidence and what is needed to resolve it. Never resolve conflicts without sufficient evidence.
- Preserve exact authorization boundaries: action, scope, and lifetime. Keep the wording and source of applicable authorization, prohibitions, or pending approval when available; never infer permission from prior completion, current state, capability, or convenience.
- Keep decisive evidence with the conclusion it supports. Preserve the exact terms, values, identifiers, failure codes, ordering, and exceptions that change a later judgment, action, or verification; do not replace those details with broad references or labels. Preserve user-designated text. Use precise references for other details only when they can be recovered reliably.
- Group related information and merge equivalent facts without losing distinct evidence or constraints.

## Exclusions
Remove irrelevant chronology, duplicate information, superseded hypotheses with no remaining relevance, verbose source material, and details that can be reliably recovered at low cost.

Omit instructions and contextual state restored separately by Runtime, including AGENTS.md instructions, Host instructions, capability policy, Skill catalogs, and process, Code Exec cell, and Subagent inventories. Omit constraints derived solely from these restored instructions.

Omit reloadable Skill content; retain the names of Skills still needed. Preserve task-relevant outcomes and dependencies not otherwise restored.

Do not include secrets, credentials, or private deliberation.

Before emitting, read the notes as if the earlier conversation were unavailable. Can you recover the conditions, order, and exceptions that matter, and tell exactly what the evidence established or left unverified? Restore missing details that could change subsequent reasoning. Check for inconsistencies introduced by compression and keep unresolved conflicts explicit.

Output only the notes in compact Markdown.`;
}
