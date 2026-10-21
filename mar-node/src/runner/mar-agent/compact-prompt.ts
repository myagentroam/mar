export function highDensityCompactionPrompt(): string {
  return `Compile the visible conversation into Textual Continuation IR that lets the next agent continue correctly after the transcript is discarded. Transfer state; do not recap, address the user, call tools, advance the task, or invent facts.

Optimize for continuation fidelity first and density second. Prefer sufficient continuation state over brevity; never omit information required to resume correctly.

## Output contract
Use these English section names when applicable; omit empty sections:
1. Goal contract
2. Current state
3. Settled matters
4. Necessary evidence
5. Open loops

IR grammar and vocabulary are English: headings, keys, enums, state atoms, and control terms. Natural-language values may follow the task's dominant language. Preserve exact user-designated text and established domain terms; do not translate identifiers or invent localized IR terminology.

Prefer records over prose:
<object> | <key>=<value> | <key>=<value>
<event/condition> -> <object>.<key>=<value> | <effect>

Use | for parallel facts, = for current state, and -> only for causality, invalidation, or transition. Keep enums lowercase and semantic: required, forbidden, pending; never YES/NO. Omit empty or irrelevant unknown fields. Keep pending, not run, unverified, and failed distinct. Use a sentence only when records cannot express a multi-object cause, conflict, authorization, or safety boundary unambiguously.

Examples:
src/discount.js | cause=verified | edit=pending | tests=not run
patch(src/discount.js) -> prior_read=stale | next=re-evidence
authorization | action=<exact> | scope=<exact> | lifetime=<exact> | status=active

## Compiler
1. Resolve intent. The latest user correction overrides older intent. Extract the primary objective, current deliverable, completion criteria, non-goals, and boundaries.
2. Reduce time. Convert before -> event -> after into the latest evidenced state. Source mutation or base/branch change makes only affected evidence stale. History replacement invalidates Responses continuation, not factual evidence. Without an invalidating event, a verified claim remains current.
3. Build objects. Emit one current record per file, symbol, feature, migration, test, worktree axis, selected Skill, Todo/plan item, external decision, or external side effect. Deduplicate equivalent facts.
4. Separate status axes when needed:
   - completion=pending|in_progress|completed|blocked
   - epistemic=observed|verified|inferred|proposed|disproved
   - freshness=current|stale|superseded
   - scope=turn|worktree|base|branch|external
5. Bind evidence to the claim it proves. Prefer a verified conclusion over raw snapshots or intermediate hypotheses.
6. Select under budget. Protect, in order: objective, progress, boundaries and authorization, non-repeatable side effects, open loops, then necessary evidence. Remove provenance and recoverable detail only after those remain sufficient.

## Retention rules
- Preserve active caller/user instructions outside filesystem-loaded AGENTS.md, exact authorization boundaries, confirmed decisions and exclusions, completed edits and side effects, verification actually run, reproducible failures, failed approaches that constrain the next step, unresolved risks, and the smallest established next action.
- Authorization is valid only for its exact action, scope, and lifetime in the active request. Completed or superseded scopes cannot revive it. Object state, completion, tool availability, and convenience never imply permission.
- Preserve decisive values, or an exact artifact path/command that deterministically recovers them, when a result controls later work. Counts or schemas alone are insufficient.
- Preserve paths, symbols, APIs, tools, models, providers, JSON keys, protocol fields, commands, arguments, error codes, commit hashes, call IDs, sequences, versions, numbers, and user-designated text verbatim.
- Preserve selected Skill names with only continuation-critical constraints. Preserve Todo/plan revision, item/status, and current minimum step.
- Keep observed HEAD, validated base, target commit, and current worktree as separate axes. Evidence updates only what it directly proves; cross-axis, cross-base, and cross-branch inference remains unverified.
- If evidence conflicts, use state=conflict | candidates=<short values> | next=re-evidence. Never choose a side without evidence.

## Exclusions
Remove greetings, progress chatter, chronology that does not affect current state, duplicate facts, superseded hypotheses without remaining constraints, long logs, source bodies, verbose payloads, cheap-to-recover content, local-only integrity hashes, hidden reasoning, secrets, credentials, and unrelated content.

Remove user/project/directory AGENTS.md text and constraints derived only from those files; the next Execution reloads them. Remove retained process/Subagent inventory, IDs, status, commands, cwd, and reuse instructions; Runtime reloads them.

Before emitting, verify that objective, current progress, authorization/boundaries, completed versus unverified work, decisive evidence, open loops, and next action are explicit and non-contradictory.

Output only compact Markdown IR.`;
}
