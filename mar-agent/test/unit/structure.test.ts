import { readFileSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageSourceRoot = fileURLToPath(new URL('../../src/', import.meta.url));
const sourceRoot = join(packageSourceRoot, 'agent-core');
const contracts = new Set([
  'host/contracts.ts',
  'runtime/contracts.ts',
  'runtime/events.ts',
  'runtime/execution-handle.ts',
  'runtime/context/contracts.ts',
  'tools/contracts.ts',
  'subagent/contracts.ts'
]);
// Public DTOs may reference domain-owned support types, never their implementations.
const contractSupportDependencies: Readonly<Record<string, readonly string[]>> = {
  'host/contracts.ts': [
    'extensions/environment.ts',
    'extensions/files.ts',
    'extensions/mcp.ts',
    'extensions/network.ts',
    'extensions/operation.ts',
    'extensions/processes.ts',
    'extensions/tools.ts',
    'model/usage-observer.ts',
    'tools/permissions.ts'
  ],
  'runtime/contracts.ts': ['tools/permissions.ts'],
  'runtime/events.ts': [
    'session/catalog.ts',
    'tools/agent/sleep.ts',
    'tools/permissions.ts',
    'tools/public-metadata.ts',
    'tools/result-extensions.ts'
  ],
  'tools/contracts.ts': [
    'tools/code-mode/observations.ts',
    'tools/permissions.ts',
    'tools/result-extensions.ts',
    'tools/wait.ts'
  ],
  'subagent/contracts.ts': ['tools/permissions.ts', 'tools/wait.ts']
};

function source(path: string): string {
  return readFileSync(join(sourceRoot, path), 'utf8');
}

function dependencies(path: string, text = source(path)): string[] {
  return [...text.matchAll(/(?:\bfrom\s+|\bimport\(\s*)['"]([^'"]+)['"]/g)]
    .map((match) => match[1]!)
    .filter((specifier) => specifier.startsWith('.'))
    .map((specifier) =>
      posix.normalize(posix.join(posix.dirname(path), specifier.replace(/\.js$/, '.ts')))
    );
}

function typeDependencies(path: string): string[] {
  const text = source(path);
  const imports = [
    ...text.matchAll(/\bimport\s+type\s+[\s\S]*?\bfrom\s+['"][^'"]+['"]/g),
    ...text.matchAll(/\bimport\(\s*['"][^'"]+['"]\s*\)\.[A-Z]\w*/g)
  ];
  return dependencies(path, imports.map((match) => match[0]).join('\n'));
}

function files(directory = ''): string[] {
  return readdirSync(join(sourceRoot, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = posix.join(directory, entry.name);
    return entry.isDirectory() ? files(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('Agent structure boundaries', () => {
  it('groups Agent state tools separately from local side effects while keeping shared dispatch at the root', () => {
    const paths = new Set(files());
    for (const name of [
      'agent-start',
      'agent-wait',
      'agent-message',
      'agent-cancel',
      'question',
      'skill',
      'todo',
      'todo-read',
      'todo-write'
    ]) {
      expect(paths.has(`tools/agent/${name}.ts`), name).toBe(true);
      expect(paths.has(`tools/${name}.ts`), name).toBe(false);
    }
    for (const name of ['apply-patch', 'exec', 'read', 'read-context', 'view-image']) {
      expect(paths.has(`tools/local/${name}.ts`), name).toBe(true);
      expect(paths.has(`tools/${name}.ts`), name).toBe(false);
    }
    for (const name of ['web-fetch', 'web-search']) {
      expect(paths.has(`tools/local/${name}.ts`), name).toBe(false);
      expect(paths.has(`tools/${name}.ts`), name).toBe(false);
    }
    expect(paths.has('tools/local/registry.ts')).toBe(true);
    expect(paths.has('tools/local/workspace-tools.ts')).toBe(true);
    expect(paths.has('tools/registry.ts')).toBe(true);
    expect(paths.has('tools/runtime.ts')).toBe(true);
    expect(source('tools/local/registry.ts')).not.toContain('function formatBatchRead');
    expect(source('tools/local/registry.ts')).not.toContain('function fetchWebUrl');
    expect(source('tools/local/registry.ts')).not.toContain('Search query is required.');
    expect(source('tools/local/registry.ts')).not.toContain('Patch is required.');
  });

  it('keeps MCP discovery and Code Mode entry points in their complete tool families', () => {
    const paths = new Set(files());
    expect(paths.has('tools/mcp/tool-search.ts')).toBe(true);
    expect(paths.has('tools/code-mode/index.ts')).toBe(true);
    expect(paths.has('tools/tool-search.ts')).toBe(false);
    expect(paths.has('tools/code-mode.ts')).toBe(false);
  });

  it('groups contextual loading and normalization while separating compaction operation from history transforms', () => {
    const paths = new Set(files());
    expect(paths.has('runtime/context/instructions.ts')).toBe(true);
    expect(paths.has('runtime/context/normalize.ts')).toBe(true);
    expect(paths.has('runtime/compaction/operation.ts')).toBe(true);
    expect(paths.has('runtime/compaction/history.ts')).toBe(true);
    expect(paths.has('runtime/instructions.ts')).toBe(false);
    expect(paths.has('runtime/normalize.ts')).toBe(false);
    expect(paths.has('runtime/compact.ts')).toBe(false);
  });

  it('keeps CLI, shared application capabilities and Sandbox outside the core without reverse dependencies', () => {
    expect(readdirSync(packageSourceRoot).sort()).toEqual([
      'agent-core',
      'cli',
      'index.ts',
      'sandbox',
      'shared'
    ]);
    for (const path of files()) {
      expect(
        dependencies(path).filter((dependency) => dependency.startsWith('../')),
        path
      ).toEqual([]);
    }
    const neutral = new Set([
      'agent-core/error.ts',
      'agent-core/host/contracts.ts',
      'agent-core/host/local-process-executor.ts',
      'agent-core/host/local-shell.ts'
    ]);
    const sandbox = join(packageSourceRoot, 'sandbox/linux');
    for (const entry of readdirSync(sandbox).filter((name) => name.endsWith('.ts'))) {
      const path = `sandbox/linux/${entry}`;
      const contents = readFileSync(join(packageSourceRoot, path), 'utf8');
      for (const match of contents.matchAll(/(?:\bfrom\s+|\bimport\(\s*)['"]([^'"]+)['"]/g)) {
        if (!match[1]!.startsWith('.')) continue;
        const dependency = posix.normalize(
          posix.join(posix.dirname(path), match[1]!.replace(/\.js$/, '.ts'))
        );
        expect(
          dependency.startsWith('sandbox/') || neutral.has(dependency),
          `${path} -> ${dependency}`
        ).toBe(true);
      }
    }
  });

  it('keeps domain modules independent of the SDK facade and root barrel', () => {
    for (const path of files().filter((path) =>
      /^(host|model|runtime|session|subagent|tools|prompts)\//.test(path)
    )) {
      const imports = dependencies(path);
      expect(
        imports.filter((dependency) => dependency.startsWith('sdk/') || dependency === 'index.ts'),
        path
      ).toEqual([]);
    }
  });

  it('keeps contract DTOs independent of implementations without introducing contract cycles', () => {
    const allowed = new Set([...contracts, 'model/configuration.ts', 'error.ts']);
    for (const path of contracts) {
      const allowedDependencies = new Set([
        ...allowed,
        ...(contractSupportDependencies[path] ?? [])
      ]);
      expect(
        dependencies(path).filter((dependency) => !allowedDependencies.has(dependency)),
        path
      ).toEqual([]);
      for (const dependency of dependencies(path).filter((dependency) => !allowed.has(dependency)))
        expect(
          typeDependencies(path),
          `${path} must only reference ${dependency} as a type`
        ).toContain(dependency);
    }
    const visit = (path: string, ancestors: string[]) => {
      expect(ancestors, `Contract cycle through ${path}`).not.toContain(path);
      for (const dependency of dependencies(path).filter((dependency) =>
        contracts.has(dependency)
      )) {
        visit(dependency, [...ancestors, path]);
      }
    };
    for (const path of contracts) visit(path, []);
  });

  it('keeps SDK lifecycle ownership separate from the model/tool loop and tool result formats', () => {
    const agent = source('sdk/agent.ts');
    const session = source('sdk/session.ts');
    const loop = source('runtime/execution.ts');
    expect(agent).toContain('createSessionOpener');
    expect(agent).not.toContain('for await (const event');
    expect(session).toContain('new ExecutionLoop');
    expect(session).not.toContain('structuredToolEventData');
    expect(loop).toContain('executeRoundTools');
    expect(loop).not.toMatch(/type:\s*['"]execution\.(completed|failed|cancelled)['"]/);
    expect(source('tools/execution.ts')).toContain('structuredToolEventData');
    expect(source('tools/code-mode/dispatch.ts')).toContain('structuredToolEventData');
  });

  it('does not expose loop, storage, adapter or session coordinator implementations from the package root', () => {
    const entry = readFileSync(join(packageSourceRoot, 'index.ts'), 'utf8');
    const exports = [...entry.matchAll(/export\s+(?:type\s+)?\{([^}]+)\}/g)].flatMap((match) =>
      match[1]!.split(',').map((name) => name.trim())
    );
    for (const name of [
      'ExecutionLoop',
      'ExecutionLoopInput',
      'SessionRuntime',
      'AgentSessionRegistry',
      'JsonlSessionStore',
      'ModelAdapter',
      'createMarAgentWithAdapter'
    ]) {
      expect(exports).not.toContain(name);
    }
  });
});
