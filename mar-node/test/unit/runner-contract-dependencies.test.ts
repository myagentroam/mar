import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

function dependencies(source: string): string[] {
  const file = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      imports.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      imports.push(node.argument.literal.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return imports;
}

describe('Runner neutral contract dependency boundary', () => {
  it('discovers type-only imports, re-exports and dynamic imports', () => {
    expect(
      dependencies(
        "import type { A } from './a.js'; export type { B } from './b.js'; type C = import('./c.js').C; void import('./d.js');"
      )
    ).toEqual(['./a.js', './b.js', './c.js', './d.js']);
  });

  it('does not reach a concrete Runner through any local dependency', () => {
    const root = resolve(import.meta.dirname, '../../src');
    const pending = ['runner/contracts.ts', 'runner/execution-context.ts'].map((path) => ({
      file: resolve(root, path),
      chain: [path]
    }));
    const visited = new Set<string>();
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (visited.has(current.file)) continue;
      visited.add(current.file);
      for (const specifier of dependencies(readFileSync(current.file, 'utf8'))) {
        if (!specifier.startsWith('.')) continue;
        const target = resolve(dirname(current.file), specifier.replace(/\.js$/u, '.ts'));
        const name = relative(root, target).replaceAll('\\', '/');
        const chain = [...current.chain, name];
        expect(name, chain.join(' -> ')).not.toMatch(
          /^runner\/(?:mar-agent|codex|claude|opencode)\//u
        );
        expect(name, chain.join(' -> ')).not.toMatch(
          /^(?:database\.ts|fake-runner\.ts|(?:codex-app-server|claude-channel|opencode-server)\.ts|runner\/(?:mar-agent|codex|claude-code|opencode)-runner\.ts)$/u
        );
        expect(existsSync(target), chain.join(' -> ')).toBe(true);
        pending.push({ file: target, chain });
      }
    }
  });

  it('keeps domain services and hosted runtime contracts independent of connector dispatch', () => {
    const root = resolve(import.meta.dirname, '../../src');
    const sources = (directory: string): string[] =>
      readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const file = resolve(directory, entry.name);
        return entry.isDirectory() ? sources(file) : file.endsWith('.ts') ? [file] : [];
      });
    for (const file of ['service', 'hosting', 'session', 'workspace', 'runner'].flatMap((name) =>
      sources(resolve(root, name))
    )) {
      for (const specifier of dependencies(readFileSync(file, 'utf8'))) {
        if (!specifier.startsWith('.')) continue;
        const target = relative(root, resolve(dirname(file), specifier)).replaceAll('\\', '/');
        expect(target, `${relative(root, file)} -> ${target}`).not.toMatch(
          /^(?:connector\/|connection\/node-operation-router\.js)/u
        );
      }
    }
    const hostedContract = resolve(root, 'hosting/runtime-contracts.ts');
    for (const specifier of dependencies(readFileSync(hostedContract, 'utf8'))) {
      if (!specifier.startsWith('.')) continue;
      const target = relative(root, resolve(dirname(hostedContract), specifier)).replaceAll(
        '\\',
        '/'
      );
      expect(target).not.toMatch(/^(?:service\/|runner\/|connector\/)/u);
    }
  });
});
