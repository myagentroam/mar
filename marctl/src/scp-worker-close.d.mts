import type { ChildProcessWithoutNullStreams } from 'node:child_process';

export function closeScpWorker(
  child: ChildProcessWithoutNullStreams,
  closed: Promise<void>
): Promise<void>;
