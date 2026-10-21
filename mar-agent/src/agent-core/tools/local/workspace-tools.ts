import { ApplyPatchTool } from './apply-patch.js';
import { ExecTool, type ExecInput } from './exec.js';
export type { ExecInput, ExecResult } from './exec.js';
import { ReadTool } from './read.js';
import { WorkspacePathResolver } from '../shared/path-resolver.js';

/** @deprecated Use the individual tool modules or LocalAgentHost. */
export class LocalWorkspaceTools {
  readonly #read: ReadTool;
  readonly #applyPatch: ApplyPatchTool;
  readonly #exec: ExecTool;

  constructor(root: string, maxOutputBytes = 1_000_000) {
    const paths = new WorkspacePathResolver(root);
    this.#read = new ReadTool(paths);
    this.#applyPatch = new ApplyPatchTool(paths);
    this.#exec = new ExecTool(paths, maxOutputBytes);
  }

  read(input: Parameters<ReadTool['execute']>[0]) {
    return this.#read.execute(input);
  }

  applyPatch(patch: string) {
    return this.#applyPatch.execute(patch);
  }

  exec(input: ExecInput) {
    return this.#exec.execute(input);
  }

  dispose() {
    return this.#exec.dispose();
  }
}
