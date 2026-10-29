import { readFileSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const packageSourceRoot = fileURLToPath(new URL('../../src/', import.meta.url));
const sourceRoot = packageSourceRoot;
const contracts = new Set([
  'host/contracts.ts',
  'process/contracts.ts',
  'runtime/contracts.ts',
  'runtime/events.ts',
  'runtime/execution-handle.ts',
  'runtime/context/contracts.ts',
  'tools/contracts.ts'
]);
// Public DTOs may reference domain-owned support types, never their implementations.
const contractSupportDependencies: Readonly<Record<string, readonly string[]>> = {
  'host/contracts.ts': [
    'extensions/host-ports.ts',
    'host/skill-contract.ts',
    'extensions/environment.ts',
    'extensions/files.ts',
    'extensions/mcp.ts',
    'extensions/network.ts',
    'extensions/operation.ts',
    'extensions/processes.ts',
    'extensions/tools.ts',
    'host/description.ts',
    'model/usage.ts',
    'session/resource-contract.ts',
    'tools/permission-contract.ts'
  ],
  'runtime/contracts.ts': ['model/image-contract.ts', 'tools/permission-contract.ts'],
  'runtime/events.ts': [
    'tools/result-extension-contract.ts',
    'session/user-history.ts',
    'tools/agent/sleep.ts',
    'tools/permission-contract.ts',
    'runtime/public-tool-metadata.ts',
    'tools/result-extensions.ts'
  ],
  'tools/contracts.ts': [
    'model/contracts.ts',
    'model/image-contract.ts',
    'tools/result-extension-contract.ts',
    'session/code-observation-contract.ts',
    'session/code-state.ts',
    'session/todo.ts',
    'tools/permission-contract.ts',
    'tools/result-extensions.ts',
    'tools/wait.ts'
  ]
};

function source(path: string): string {
  return readFileSync(join(sourceRoot, path), 'utf8');
}

function collectDependencies(path: string, text: string): { path: string; typeOnly: boolean }[] {
  const result: { path: string; typeOnly: boolean }[] = [];
  const add = (specifier: string, typeOnly: boolean) => {
    if (specifier.startsWith('.'))
      result.push({
        path: posix.normalize(posix.join(posix.dirname(path), specifier.replace(/\.js$/, '.ts'))),
        typeOnly
      });
  };
  const walk = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const typeOnly =
        !!clause &&
        (clause.isTypeOnly ||
          (!clause.name &&
            !!bindings &&
            ts.isNamedImports(bindings) &&
            bindings.elements.every((element) => element.isTypeOnly)));
      add(node.moduleSpecifier.text, typeOnly);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const named = node.exportClause;
      add(
        node.moduleSpecifier.text,
        node.isTypeOnly ||
          (!!named &&
            ts.isNamedExports(named) &&
            named.elements.every((element) => element.isTypeOnly))
      );
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      add(node.argument.literal.text, true);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      add(node.arguments[0].text, false);
    }
    ts.forEachChild(node, walk);
  };
  walk(ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true));
  return result;
}

function dependencies(path: string, text = source(path)): string[] {
  return collectDependencies(path, text).map((dependency) => dependency.path);
}

function files(directory = ''): string[] {
  return readdirSync(join(sourceRoot, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = posix.join(directory, entry.name);
    return entry.isDirectory() ? files(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('Agent structure boundaries', () => {
  it('keeps the migrated capability edges directed toward their owning contracts', () => {
    const forbidden: Record<string, string[]> = {
      'host/contracts.ts': ['session/store/jsonl/resources.ts'],
      'host/network.ts': ['model/http.ts', 'model/runtime-credential.ts'],
      'host/local-shell.ts': ['host/local-process-executor.ts'],
      'model/contracts.ts': ['model/usage-observer.ts'],
      'runtime/execution.ts': ['tools/execution.ts', 'tools/runtime-context.ts'],
      'session/catalog.ts': ['session/store/jsonl/jsonl-store.ts'],
      'session/store/contracts.ts': ['session/context-gc-checkpoint.ts'],
      'sdk/session-execution-factory.ts': ['sdk/session.ts'],
      'tools/runtime-context.ts': ['host/contracts.ts', 'subagent/session-controller.ts']
    };
    for (const [consumer, targets] of Object.entries(forbidden))
      for (const target of targets) expect(dependencies(consumer), consumer).not.toContain(target);
    for (const consumer of ['session/store/contracts.ts', 'session/store/types.ts'])
      expect(
        dependencies(consumer).filter((target) => target.startsWith('session/store/jsonl/')),
        consumer
      ).toEqual([]);
    const neutralFacts = [
      'session/context-gc-contract.ts',
      'session/inline-media-contract.ts',
      'session/resource-contract.ts'
    ];
    for (const path of neutralFacts)
      for (const dependency of collectDependencies(path, source(path))) {
        expect(dependency.typeOnly, `${path} -> ${dependency.path}`).toBe(true);
        expect(neutralFacts, path).toContain(dependency.path);
      }
  });

  it('keeps network independent of model implementations and transport errors neutral', () => {
    for (const path of files('network'))
      expect(
        dependencies(path).filter((dependency) => dependency.startsWith('model/')),
        path
      ).toEqual([]);
    for (const path of ['network/http.ts', 'network/transport-error.ts'])
      expect(source(path), path).not.toMatch(
        /MAR_AGENT_MODEL_|MODEL_(?:CONNECTION|TRANSPORT|STREAM|PROGRESS)_/
      );
  });

  it('keeps Tools independent of foreign implementations', () => {
    for (const path of files()) {
      const deps = dependencies(path);
      if (path.startsWith('tools/')) {
        expect(
          deps.filter((dependency) => /^(host|extensions|sdk|session\/store)\//.test(dependency)),
          path
        ).toEqual([]);
        expect(deps, path).not.toContain('runtime/execution.ts');
      }
    }
  });

  it('enforces model, runtime, extension, host and tool composition directions', () => {
    const runtimeFacts = new Set([
      'tools/contracts.ts',
      'tools/permission-contract.ts',
      'tools/result-extension-contract.ts',
      'host/skill-contract.ts'
    ]);
    const extensionFacts = new Set(['tools/contracts.ts', 'tools/permission-contract.ts']);
    for (const path of files()) {
      for (const dependency of collectDependencies(path, source(path))) {
        const target = dependency.path;
        expect(target, `${path} -> ${target}`).not.toMatch(/^subagent\//);
        if (path.startsWith('model/')) {
          expect(target, `${path} -> ${target}`).not.toMatch(
            /^(host|tools|extensions|sdk|session|runtime|subagent)\//
          );
        }
        if (path.startsWith('runtime/') && /^(tools|subagent|extensions|sdk|host)\//.test(target)) {
          expect(dependency.typeOnly && runtimeFacts.has(target), `${path} -> ${target}`).toBe(
            true
          );
        }
        if (path.startsWith('runtime/') && target.startsWith('session/store/')) {
          expect(
            dependency.typeOnly && target === 'session/store/contracts.ts',
            `${path} -> ${target}`
          ).toBe(true);
        }
        if (
          path.startsWith('extensions/') &&
          /^(tools|subagent|sdk|host|session\/store)\//.test(target)
        ) {
          expect(dependency.typeOnly && extensionFacts.has(target), `${path} -> ${target}`).toBe(
            true
          );
        }
        if (path.startsWith('host/')) {
          expect(target, `${path} -> ${target}`).not.toMatch(/^(sdk|session\/store)\//);
        }
        if (path.startsWith('session/store/')) {
          expect(target, `${path} -> ${target}`).not.toMatch(
            /^(host|sdk)\/|^session\/catalog\.ts$/
          );
          if (/^(tools|extensions|subagent|runtime)\//.test(target)) {
            const facts = new Set([
              'tools/contracts.ts',
              'tools/result-extension-contract.ts',
              'runtime/context/contracts.ts'
            ]);
            expect(dependency.typeOnly && facts.has(target), `${path} -> ${target}`).toBe(true);
          }
        }
      }
    }
  });
  it('classifies static, inline, re-export and import type dependencies', () => {
    expect(
      collectDependencies(
        'a/main.ts',
        `
      import type { A } from './one.js';
      import { type B, C } from './two.js';
      import { type D } from './three.js';
      export type { E } from './four.js';
      export { type F } from './five.js';
      type G = import('./six.js').G;
      void import('./seven.js');
    `
      )
    ).toEqual([
      { path: 'a/one.ts', typeOnly: true },
      { path: 'a/two.ts', typeOnly: false },
      { path: 'a/three.ts', typeOnly: true },
      { path: 'a/four.ts', typeOnly: true },
      { path: 'a/five.ts', typeOnly: true },
      { path: 'a/six.ts', typeOnly: true },
      { path: 'a/seven.ts', typeOnly: false }
    ]);
  });
  it('groups Agent state tools separately from local side effects while keeping shared dispatch at the root', () => {
    const paths = new Set(files());
    for (const name of ['question', 'skill', 'todo', 'todo-read', 'todo-write']) {
      expect(paths.has(`tools/agent/${name}.ts`), name).toBe(true);
      expect(paths.has(`tools/${name}.ts`), name).toBe(false);
    }
    for (const name of ['agent-start', 'agent-wait', 'agent-message', 'agent-cancel'])
      expect(paths.has(`tools/agent/${name}.ts`), name).toBe(false);
    expect(paths.has('subagent/session-controller.ts')).toBe(false);
    for (const name of ['apply-patch', 'exec', 'read', 'view-image']) {
      expect(paths.has(`tools/local/${name}.ts`), name).toBe(true);
      expect(paths.has(`tools/${name}.ts`), name).toBe(false);
    }
    expect(paths.has('prompts/read-context.ts')).toBe(true);
    for (const name of ['web-fetch', 'web-search']) {
      expect(paths.has(`tools/local/${name}.ts`), name).toBe(false);
      expect(paths.has(`tools/${name}.ts`), name).toBe(false);
    }
    expect(paths.has('host/local-tool-registry.ts')).toBe(true);
    expect(paths.has('host/local-workspace-tools.ts')).toBe(false);
    expect(paths.has('tools/registry.ts')).toBe(true);
    expect(paths.has('tools/runtime.ts')).toBe(true);
    expect(source('host/local-tool-registry.ts')).not.toContain('function formatBatchRead');
    expect(source('host/local-tool-registry.ts')).not.toContain('function fetchWebUrl');
    expect(source('host/local-tool-registry.ts')).not.toContain('Search query is required.');
    expect(source('host/local-tool-registry.ts')).not.toContain('Patch is required.');
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
      'cli',
      'error.ts',
      'extensions',
      'extensions.ts',
      'host',
      'host.ts',
      'index.ts',
      'model',
      'network',
      'process',
      'prompts',
      'runtime',
      'sandbox',
      'sdk',
      'session',
      'session-store.ts',
      'shared',
      'storage',
      'subagent',
      'tools'
    ]);
    for (const path of files().filter(
      (path) =>
        /^(sdk|runtime|model|session|extensions|subagent|host|network|storage|process|tools|prompts)\//.test(
          path
        ) || path === 'error.ts'
    )) {
      expect(
        dependencies(path).filter(
          (dependency) => dependency.startsWith('../') || /^(cli|shared|sandbox)\//.test(dependency)
        ),
        path
      ).toEqual([]);
    }
    const neutral = new Set([
      'error.ts',
      'process/contracts.ts',
      'host/contracts.ts',
      'host/local-process-executor.ts',
      'host/local-shell.ts'
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

  it('keeps CLI composition on public roles and neutral transport or error helpers', () => {
    // Internal reuse is restricted to package-wide diagnostics and transport identity.
    const entries = new Set(['index.ts', 'host.ts', 'error.ts', 'network/product-user-agent.ts']);
    for (const entry of readdirSync(join(packageSourceRoot, 'cli')).filter((name) =>
      name.endsWith('.ts')
    )) {
      const path = `cli/${entry}`;
      const contents = readFileSync(join(packageSourceRoot, path), 'utf8');
      for (const dependency of collectDependencies(path, contents)) {
        expect(
          entries.has(dependency.path) ||
            (dependency.typeOnly && dependency.path === 'extensions.ts') ||
            dependency.path.startsWith('cli/') ||
            dependency.path.startsWith('shared/'),
          `${path} -> ${dependency.path}`
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
      for (const dependency of collectDependencies(path, source(path)).filter(
        (dependency) => !allowed.has(dependency.path)
      ))
        expect(
          dependency.typeOnly,
          `${path} must only reference ${dependency.path} as a type`
        ).toBe(true);
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
    expect(dependencies('sdk/agent.ts')).not.toContain('runtime/execution.ts');
    expect(dependencies('sdk/session.ts')).not.toContain('runtime/execution.ts');
    expect(dependencies('sdk/session-execution.ts')).toContain('runtime/execution.ts');
    expect(dependencies('sdk/session.ts')).not.toContain('tools/output-projection.ts');
    expect(dependencies('runtime/execution.ts')).not.toContain('tools/execution.ts');
    expect(dependencies('tools/execution.ts')).toContain('tools/output-projection.ts');
    expect(dependencies('tools/code-mode/dispatch.ts')).toContain('tools/output-projection.ts');
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
      'SessionExecution',
      'SessionRegistry',
      'AgentSessionComposition',
      'JsonlSessionStore',
      'ModelAdapter',
      'createAgentWithAdapter'
    ]) {
      expect(exports).not.toContain(name);
    }
  });
});
