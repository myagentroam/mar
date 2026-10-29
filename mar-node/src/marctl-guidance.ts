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
  'Use marctl for model and effort configuration, renaming, persistent prompts, schedules, authorized Node discovery, remote commands, and file transfer.';

const marctlSafety =
  'Acceptance is not completion. If a request result is unknown, inspect history before retrying. Session IDs and parent relationships do not grant authorization.';

export const marctlManagementInstructions = [
  '## MAR Workspace management',
  'Use native agent_* tools for Agent discovery, creation, communication, observation, waiting and stopping. Do not switch to marctl when a native operation fails.',
  'Use marctl agents config <id> --model <id> --effort <effort> to change future model settings; agents rename <id> --title <title> changes a title.',
  'Use agents prompt get/set/clear for persistent instructions; set accepts -m or --message-file. Use agents schedule list/get/create/update for scheduled tasks; update requires --expected-revision.',
  'marctl nodes lists authorized Nodes; marctl ssh executes remote commands and marctl scp transfers files. Use marctl help agents, nodes, ssh or scp for options.',
  marctlSafety
].join('\n\n');

export const marctlDescription =
  'Use marctl agents to create, send to, wait for, stop, list and view Agents, configure models and effort, rename Sessions, manage prompts and schedules, or make explicitly authorized approval decisions; use nodes, ssh and scp for authorized Node operations.';

export const marctlInstructions = [
  '## MAR Workspace CLI',
  'Run marctl from the shell. Commands use the authenticated Node and Workspace; marctl help agents, nodes, ssh or scp shows options.',
  'Use agents start --title <title> -m <text> [--runner <runner>] [--model <id>] [--effort <effort>] [--goal <objective>]. An Agent must supply a nonblank title; a manual terminal may omit it. The default Runner is the current Session Runner; a terminal without a current Session must specify --runner or an explicit --parent. Start returns without waiting.',
  'Use agents send <id> -m <text> [--steer|--queue], agents wait [<id>] [--wait-for message|completion] [--timeout <duration>], agents stop <id> --execution <execution-id>, agents list [--scope children|descendants|workspace|profile], and agents view <id> [--history]. Wait defaults to direct-child completion for 30 seconds; --timeout 0ms takes a snapshot. Stop clears the target Session Goal.',
  'Start and send accept repeated --image <local-path> for PNG, JPEG, GIF or WebP; limits are five images, 5 MiB each and 10 MiB total. Send can update a Goal alone with --goal <objective> or --clear-goal; omitted Goal leaves it unchanged. Decide a direct child approval with send <id> --approval <approval-id> --decision approve|reject.',
  'List accepts --agent <id> for a relation root, --query, --parent, --limit and --cursor. Use --scope profile [--runner <runner>] for Runner models; configured profiles do not guarantee account availability.',
  'Use agents config, rename, prompt and schedule for management. marctl nodes, ssh and scp use authorized Nodes.',
  marctlSafety
].join('\n\n');
