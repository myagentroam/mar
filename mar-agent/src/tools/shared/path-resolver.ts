import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, posix, relative, resolve, sep } from 'node:path';
import { AgentError } from '../../error.js';

export interface WorkspacePathMount {
  readonly logicalPath: string;
  readonly physicalPath: string;
  readonly writable: boolean;
}

interface WorkspacePathResolverOptions {
  readonly restrictPaths?: boolean;
  readonly rootWritable?: boolean;
  readonly mounts?: readonly WorkspacePathMount[];
}

interface ResolvedRoot {
  readonly logicalPath?: string;
  readonly physicalPath: string;
  readonly writable: boolean;
}

interface ResolvedWorkspacePath {
  readonly physicalPath: string;
  readonly displayPath: string;
}

export class WorkspacePathResolver {
  readonly root: string;
  readonly #restrictPaths: boolean;
  readonly #roots: readonly ResolvedRoot[];
  readonly #logicalWorkspacePath: string | undefined;

  constructor(root: string, options: WorkspacePathResolverOptions = {}) {
    this.root = resolve(root);
    this.#restrictPaths = options.restrictPaths === true;
    this.#roots = [
      { physicalPath: this.root, writable: options.rootWritable !== false },
      ...(options.mounts ?? []).map((mount) => ({
        logicalPath: logicalRoot(mount.logicalPath),
        physicalPath: resolve(mount.physicalPath),
        writable: mount.writable
      }))
    ];
    const logicalPaths = this.#roots
      .flatMap((candidate) => (candidate.logicalPath === undefined ? [] : [candidate.logicalPath]))
      .sort();
    if (new Set(logicalPaths).size !== logicalPaths.length)
      throw denied('Logical mount paths must be unique.');
    const logicalMounts = this.#roots.filter(
      (candidate): candidate is ResolvedRoot & { readonly logicalPath: string } =>
        candidate.logicalPath !== undefined
    );
    for (const [index, mount] of logicalMounts.entries()) {
      if (
        logicalMounts
          .slice(index + 1)
          .some(
            (candidate) =>
              candidate.physicalPath === mount.physicalPath && candidate.writable !== mount.writable
          )
      )
        throw denied('Logical aliases for one physical path must use the same access mode.');
    }
    this.#logicalWorkspacePath = logicalMounts.find(
      (candidate) => candidate.physicalPath === this.root
    )?.logicalPath;
  }

  async resolve(
    input: string,
    allowMissing = false,
    access: 'read' | 'write' = 'read'
  ): Promise<string> {
    return (await this.resolveWithDisplay(input, allowMissing, access)).physicalPath;
  }

  async resolveWithDisplay(
    input: string,
    allowMissing = false,
    access: 'read' | 'write' = 'read'
  ): Promise<ResolvedWorkspacePath> {
    const selected = this.#select(input);
    if (access === 'write' && !selected.root.writable)
      throw denied('The requested path is read-only.');
    const target = selected.target;
    if (this.#restrictPaths && !withinOrEqual(selected.root.physicalPath, target))
      throw denied('The requested path is outside the allowed roots.');
    try {
      const resolved = await realpath(target);
      await lstat(resolved);
      if (
        this.#restrictPaths &&
        !withinOrEqual(await realpath(selected.root.physicalPath), resolved)
      )
        throw denied('The requested path escapes the allowed root.');
    } catch (error) {
      if (error instanceof AgentError) throw error;
      if (!allowMissing) throw error;
      const parent = await nearestExistingParent(dirname(target));
      if (
        this.#restrictPaths &&
        !withinOrEqual(await realpath(selected.root.physicalPath), await realpath(parent))
      )
        throw denied('The requested path escapes the allowed root.');
    }
    return {
      physicalPath: target,
      displayPath: this.#display(selected)
    };
  }

  #select(input: string): { readonly root: ResolvedRoot; readonly target: string } {
    if (!isAbsolute(input)) {
      if (this.#logicalWorkspacePath !== undefined)
        return this.#selectAbsolute(
          posix.join(this.#logicalWorkspacePath, input.replaceAll('\\', '/'))
        );
      const root = this.#roots[0]!;
      return { root, target: resolve(root.physicalPath, input) };
    }
    return this.#selectAbsolute(input);
  }

  #display(selected: { readonly root: ResolvedRoot; readonly target: string }): string {
    if (selected.root.logicalPath === undefined) return selected.target;
    const suffix = relative(selected.root.physicalPath, selected.target).split(sep).filter(Boolean);
    return suffix.length === 0
      ? selected.root.logicalPath
      : posix.join(selected.root.logicalPath, ...suffix);
  }

  #selectAbsolute(input: string): { readonly root: ResolvedRoot; readonly target: string } {
    const normalized = posix.normalize(input.replaceAll('\\', '/'));
    const mount = this.#roots
      .filter(
        (candidate): candidate is ResolvedRoot & { readonly logicalPath: string } =>
          candidate.logicalPath !== undefined
      )
      .sort((left, right) => right.logicalPath.length - left.logicalPath.length)
      .find(
        (candidate) =>
          normalized === candidate.logicalPath || normalized.startsWith(`${candidate.logicalPath}/`)
      );
    if (mount !== undefined) {
      const suffix = normalized.slice(mount.logicalPath.length).replace(/^\/+/u, '');
      return {
        root: mount,
        target: resolve(mount.physicalPath, ...suffix.split('/').filter(Boolean))
      };
    }
    if (this.#restrictPaths) throw denied('The requested path is outside the allowed roots.');
    return {
      root: { physicalPath: dirname(resolve(input)), writable: true },
      target: resolve(input)
    };
  }
}

function logicalRoot(value: string): string {
  const normalized = posix.normalize(value.replaceAll('\\', '/'));
  if (!normalized.startsWith('/') || normalized === '/' || normalized.includes('\0'))
    throw denied('Logical mount path is invalid.');
  return normalized.replace(/\/+$/u, '');
}

function withinOrEqual(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return relation === '' || (relation !== '..' && !relation.startsWith(`..${sep}`));
}

async function nearestExistingParent(path: string): Promise<string> {
  let candidate = path;
  for (;;) {
    try {
      await lstat(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

function denied(message: string): AgentError {
  return new AgentError('MAR_AGENT_FILE_ACCESS_DENIED', message);
}
