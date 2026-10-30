export function hasMarctlContext(environment: Readonly<Record<string, string>>): boolean {
  return (
    environment['MAR_CTL_CONTEXT_REQUIRED'] === '1' &&
    !!environment['MAR_CTL_USER_TOKEN'] &&
    !!environment['MAR_CTL_SERVER_URL'] &&
    !!environment['MAR_CTL_NODE_ID'] &&
    !!environment['MAR_CTL_WORKSPACE_ID']
  );
}

export const marctlManagementDescription =
  'Use marctl to manage MAR Agent session settings (model, effort, title, persistent prompts, and schedules), discover authorized MAR Nodes, and execute commands or transfer files on those Nodes. Use native agent_* tools for other Agent lifecycle and collaboration operations.';

const marctlSafety =
  'Acceptance is not completion. If a request result is unknown, inspect history before retrying. Session IDs and parent relationships do not grant authorization.';

export const marctlManagementInstructions = [
  '## MAR Workspace management',
  'Use native agent_* tools for Agent discovery, creation, communication, observation, waiting and stopping. Do not switch to marctl when a native operation fails.',
  'Use marctl agents config <id> --model-id <id> --effort <effort> to change future model settings; agents rename <id> --title <title> changes a title.',
  'Use agents prompt get/set/clear for persistent instructions; set accepts -m or --message-file. Use agents schedule list/get/create/update for scheduled tasks; update requires --expected-revision.',
  'marctl nodes lists authorized Nodes; marctl ssh executes remote commands and marctl scp transfers files. Use marctl help agents, nodes, ssh or scp for options.',
  marctlSafety
].join('\n\n');

export const marctlDescription =
  'Use marctl agents to create, send to, wait for, stop, list and view Agents, configure models and effort, rename Sessions, manage prompts and schedules, or make explicitly authorized approval decisions; use nodes, ssh and scp for authorized Node operations.';

export const marctlInstructions = [
  '## MAR Workspace CLI',
  'Run marctl from the shell. Commands use the authenticated Node and Workspace; marctl help agents, nodes, ssh or scp shows options.',
  'Use agents start --title <title> -m <text> [--runner <runner>] [--model-id <id>] [--effort <effort>] [--goal <objective>]. An Agent must supply a nonblank title; a manual terminal may omit it. The default Runner is the current Session Runner; a terminal without a current Session must specify --runner or an explicit --parent. Start returns without waiting.',
  'Use agents send <id> -m <text> [--steer|--queue], agents wait [<id>] [--wait-for message|completion] [--timeout <duration>], agents stop <id> --execution <execution-id>, agents list [--scope tree|active], and agents view <id> [--history]. Wait defaults to direct-child completion for 30 seconds; --timeout 0ms takes a snapshot. Stop clears the target Session Goal.',
  'Prefer agents send <id> --steer -m <text> for timely communication or course correction. Use --queue only for deliberately deferred input: it is consumed after current work and earlier queued inputs finish, and with an active Goal it is not consumed until that Goal exits. Acceptance is not a guarantee of immediate processing.',
  'Start and send accept repeated --image <local-path> for PNG, JPEG, GIF or WebP; limits are five images, 5 MiB each and 10 MiB total. Send can update a Goal alone with --goal <objective> or --clear-goal; omitted Goal leaves it unchanged. Decide a direct child approval with send <id> --approval <approval-id> --decision approve|reject.',
  'List accepts only --scope tree|active, optional --query <title-fragment> and --limit <1..100> (default 100). With a current Session it defaults to the containing collaboration tree, including idle Sessions; without one it defaults to active Workspace Sessions (running or sleeping), and explicit tree is rejected. Returns currentAgentId (null without a Session), flat sessions with id, parentSessionId, title, runner and status, and truncated; no cursor or pagination. Reuse known IDs directly.',
  'Only direct-child updates are collected automatically. Sending to a non-child never subscribes; an explicit wait observes it only for that call.',
  'Use agents config, rename, prompt and schedule for management. marctl nodes, ssh and scp use authorized Nodes.',
  marctlSafety
].join('\n\n');
