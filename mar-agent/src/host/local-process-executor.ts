import { spawn } from 'node:child_process';
import { prepareLocalShellProcess } from './local-shell.js';

import type { LocalProcessExecutor } from '../process/contracts.js';
export type { LocalProcessExecutor, LocalProcessSpawnRequest } from '../process/contracts.js';

/** Preserves the direct local execution behavior used by the CLI and normal Node Workbench. */
export const directLocalProcessExecutor: LocalProcessExecutor = {
  async spawn(request) {
    request = prepareLocalShellProcess(request);
    return spawn(request.command, [...(request.args ?? [])], {
      cwd: request.cwd,
      shell: request.shell ?? false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: request.detached,
      env: request.environment
    });
  }
};

export { signalProcessTree } from './process-control.js';
