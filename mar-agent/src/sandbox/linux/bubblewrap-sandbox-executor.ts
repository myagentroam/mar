import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { LocalProcessExecutor, LocalProcessSpawnRequest } from '../../process/contracts.js';
import { AgentError } from '../../error.js';
import { launchBubblewrap } from './bubblewrap-launch.js';
import { compileBubblewrapPolicy } from './bubblewrap-policy.js';
import type { BubblewrapSandboxExecutorOptions } from './profile.js';
import { policyInvalid, unavailable } from './sandbox-error.js';

export class BubblewrapSandboxExecutor implements LocalProcessExecutor {
  readonly #bubblewrapPath: string;

  constructor(private readonly options: BubblewrapSandboxExecutorOptions) {
    this.#bubblewrapPath = options.bubblewrapPath ?? '/usr/bin/bwrap';
  }

  async spawn(request: LocalProcessSpawnRequest): Promise<ChildProcessWithoutNullStreams> {
    const signal = request.signal;
    let spec;
    try {
      spec = await compileBubblewrapPolicy(this.options, this.#bubblewrapPath, request);
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof AgentError && error.code === 'SANDBOX_POLICY_INVALID')
        throw policyInvalid();
      throw unavailable();
    }
    return launchBubblewrap(spec);
  }
}
