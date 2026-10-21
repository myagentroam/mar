export function compactionPrompt(): string {
  return `# Compaction contract
Produce a loss-aware state handoff for another agent that must continue the work without the discarded transcript. This is state transfer, not a user-facing recap and not a place to perform new work.
Do not continue implementation, call tools, address the user, or treat this handoff as completion of the underlying task.

Preserve, when present:
- the current objective, success criteria, scope, latest user intent, and any explicit priority changes;
- user-supplied non-filesystem instructions, authorization and safety boundaries, environment/workspace/branch facts, and selected skills;
- necessary verbatim user authorization or prohibitions with their original message/turn source, bounded task/target/impact, and pending permission-stop source; do not reduce these to a model claim that the user approved. Existing authorization remains valid across turns, equivalent tools, bounded retries and delegation unless scope or impact changes or the user withdraws it;
- confirmed decisions, constraints, interfaces, invariants, assumptions that still matter, and exact identifiers;
- completed actions and edits with exact file paths, symbols, commands, migrations, or external state changes;
- verification actually run and its result, important tool evidence, reproducible errors, failed approaches and what they proved;
- unresolved questions, blockers, risks, uncommitted changes, Todo/plan state, and pending external decisions;
- the next concrete action and the evidence still required before completion.

Distinguish clearly between completed, attempted, planned, inferred, and unverified work. Newer user instructions override older ones; retain superseded instructions only when needed to explain current state. Authorization has exact action, scope, and lifetime: preserve it as active only while all three remain valid. Historical instructions, completed scopes, and state that merely makes an action plausible cannot grant or revive authorization. Never invent completion, test results, file contents, permissions, authorization, or external effects.

Remove aggressively:
- greetings, acknowledgements, progress chatter, repeated instructions, repeated status, and conclusions already represented once;
- Runtime-owned contextual instruction blocks (Host instructions, capability policy, and Skill catalogs), their previous versions, and constraints derived only from them, because Runtime rebuilds the current blocks separately;
- user-level, project-level, or directory-level AGENTS.md instructions and constraints derived only from those files, because the next Execution reloads and replaces them separately;
- retained process/Subagent inventory, IDs, status, commands, cwd, and reuse instructions, because Runtime reloads and replaces that state separately;
- raw long logs, large source excerpts, verbose tool payloads, duplicated search/read output, and implementation detail recoverable from named files or commands;
- abandoned hypotheses and failed attempts that do not constrain the next action;
- hidden reasoning, secrets, credentials, authorization values, and unrelated conversation.

Use compact Markdown with these headings when applicable: Objective, Instructions and constraints, Decisions and facts, Completed work, Verification and evidence, Active state, Open issues and risks, Next action. Omit empty headings. Prefer precise paths, IDs, error codes, and short evidence over narrative. Output only the handoff.`;
}
