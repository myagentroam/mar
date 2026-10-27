import { truncateModelText } from '../runtime/token-budget.js';

export interface RetainedSessionResources {
  codeCells?: import('../host/contracts.js').HostSessionResourceSnapshot['codeCells'];
  idleTtlMs?: number;
  processes: readonly {
    processId: string;
    status: 'running' | 'completed' | 'cancelled';
    command: string;
    cwd: string;
  }[];
  subagents: readonly {
    agentId: string;
    status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
    description: string;
  }[];
}

export function retainedSessionResourcesSnapshot(
  input: RetainedSessionResources
): string | undefined {
  if (input.processes.length === 0 && input.subagents.length === 0 && !input.codeCells?.length)
    return undefined;
  const processes = [...input.processes].sort((left, right) =>
    left.processId.localeCompare(right.processId)
  );
  const subagents = [...input.subagents];
  return [
    '# Retained Session resources',
    'These resources belong to this Session. Reuse their stable IDs instead of starting duplicate processes or subagents. This list is not the tool catalog. Terminal entries need no cleanup; reuse recorded results unless you need missing output.',
    ...(input.codeCells?.length
      ? [
          'Code Exec cells: use direct code_exec_wait with the retained cellId for ongoing work or needed output; cancelling a wait does not terminate the cell.',
          ...input.codeCells.map((cell) => `- cellId: ${cell.cellId}; status: ${cell.status}`)
        ]
      : []),
    processes.length === 0
      ? ''
      : 'Use exec_wait with processId to wait, write stdin or cancel; in Code Mode use tools.exec_wait. Cancelling a wait leaves the process running; explicit cancel releases the process resource.',
    subagents.length === 0
      ? ''
      : 'agent_cancel stops only the current child turn and retains its Session for later messages or explicit deletion.',
    input.idleTtlMs === undefined
      ? ''
      : `When the Session becomes idle again, unclaimed resources are retained for up to ${input.idleTtlMs} ms.`,
    processes.length === 0
      ? ''
      : [
          'Managed processes:',
          ...processes.map(
            (process) =>
              `- processId: ${process.processId}; status: ${process.status}; cwd: ${truncateModelText(process.cwd, 64, 'resource cwd').content}; command: ${truncateModelText(process.command, 128, 'resource command').content}`
          )
        ].join('\n'),
    subagents.length === 0
      ? ''
      : [
          'Subagents:',
          ...subagents.map(
            (task) =>
              `- agentId: ${task.agentId}; status: ${task.status}; description: ${truncateModelText(task.description, 96, 'resource description').content}`
          )
        ].join('\n')
  ]
    .filter(Boolean)
    .join('\n');
}
