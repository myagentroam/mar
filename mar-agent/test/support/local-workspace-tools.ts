import { ApplyPatchTool } from '../../src/tools/local/apply-patch.js';
import { ExecTool } from '../../src/host/local-exec-tool.js';
import type { ExecInput } from '../../src/tools/local/exec.js';
import { ReadTool } from '../../src/tools/local/read.js';
import { WorkspacePathResolver } from '../../src/tools/shared/path-resolver.js';

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
