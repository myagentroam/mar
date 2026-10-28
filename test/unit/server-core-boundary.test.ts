import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

function moduleSpecifiers(file: string, source: string): string[] {
  const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      imports.push(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      imports.push(node.arguments[0].text);
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      imports.push(node.argument.literal.text);
    ts.forEachChild(node, visit);
  };
  visit(syntax);
  return imports;
}

describe('Server Core workspace boundary', () => {
  it('uses a product-versioned public core without copying authentication primitives', () => {
    const core = JSON.parse(read('packages/server-core/package.json'));
    const server = JSON.parse(read('ee/server/package.json'));
    expect(core.name).toBe('@myagentroam/server-core');
    expect(core.version).toBe(server.version);
    expect(server.dependencies[core.name]).toBe('workspace:*');
    expect(core.exports['.']).toBeUndefined();
    expect(core.exports['./scheduled-run-authorization-channel']).toBeDefined();
    expect(existsSync(resolve('ee/server/src/password.ts'))).toBe(false);
    expect(existsSync(resolve('ee/server/src/auth.ts'))).toBe(false);
    expect(read('ee/server/src/route/auth-routes.ts')).toContain(
      '@myagentroam/server-core/auth-routes'
    );
    expect(read('ee/server/src/route/auth-routes.ts')).not.toContain("'/api/auth/");
    expect(read('Dockerfile')).toContain(
      'COPY packages/server-core/package.json packages/server-core/package.json'
    );
  });

  it('keeps the core source dependency graph closed over runtime, framework and protocol', () => {
    const directory = resolve('packages/server-core/src');
    const collectFiles = (relativeDirectory = ''): string[] =>
      readdirSync(resolve(directory, relativeDirectory), { withFileTypes: true }).flatMap(
        (entry) => {
          const relativePath = relativeDirectory
            ? `${relativeDirectory}/${entry.name}`
            : entry.name;
          if (entry.isDirectory()) return collectFiles(relativePath);
          return entry.isFile() ? [relativePath] : [];
        }
      );
    const files = collectFiles();
    const sourceFiles = files.filter((file) => file.endsWith('.ts'));
    const graph = new Map<string, string[]>();
    expect(files).toContain('session.ts');
    for (const file of sourceFiles) {
      const source = readFileSync(resolve(directory, file), 'utf8');
      const imports = moduleSpecifiers(file, source);
      const dependencies: string[] = [];
      for (const specifier of imports) {
        const target = posix.normalize(posix.join(posix.dirname(file), specifier));
        if (file === 'session-run-contracts.ts')
          expect(target).not.toBe('runner-profile-context.js');
        if (file === 'mysql-schema-support.ts') expect(target).not.toBe('mysql-migrations.js');
        expect(
          specifier.startsWith('node:') ||
            specifier === 'fastify' ||
            specifier === 'mysql2/promise' ||
            specifier === 'ws' ||
            specifier === 'undici' ||
            specifier === 'zod' ||
            specifier === 'nodemailer' ||
            specifier === 'web-push' ||
            specifier === '@fastify/websocket' ||
            specifier === '@myagentroam/protocol' ||
            specifier === '@myagentroam/protocol/package.json' ||
            (specifier.startsWith('.') &&
              !target.startsWith('../') &&
              (files.includes(target) || files.includes(target.replace(/\.js$/u, '.ts')))),
          `${file}: ${specifier}`
        ).toBe(true);
        if (specifier.startsWith('.')) {
          const sourceTarget = target.replace(/\.js$/u, '.ts');
          if (sourceFiles.includes(sourceTarget)) dependencies.push(sourceTarget);
        }
      }
      graph.set(file, dependencies);
      expect(source).not.toMatch(/LicenseService|MysqlServerDatabase|@myagentroam-enterprise/u);
    }
    const complete = new Set<string>();
    const visiting = new Set<string>();
    const check = (file: string, path: readonly string[]): void => {
      expect(visiting.has(file), `dependency cycle: ${[...path, file].join(' -> ')}`).toBe(false);
      if (complete.has(file)) return;
      visiting.add(file);
      for (const dependency of graph.get(file) ?? []) check(dependency, [...path, file]);
      visiting.delete(file);
      complete.add(file);
    };
    for (const file of sourceFiles) check(file, []);
  });

  it('keeps Node access contracts independent from transport and relay implementations', () => {
    const directory = resolve('packages/server-core/src');
    const contract = readFileSync(resolve(directory, 'node-access-contracts.ts'), 'utf8');
    expect(contract).toContain('export interface UserNodeAuthorization');
    expect(contract).toContain('export type NodeRequestAuthorization');
    for (const file of ['node-request-channel.ts', 'workbench-relay-service.ts']) {
      const source = readFileSync(resolve(directory, file), 'utf8');
      expect(source, file).not.toMatch(
        /export\s+(?:type\s*\{[^}]*\b(?:UserNodeAuthorization|NodeRequestAuthorization)\b|(?:interface|type)\s+(?:UserNodeAuthorization|NodeRequestAuthorization))/u
      );
      expect(moduleSpecifiers(file, source)).toContain('./node-access-contracts.js');
    }
  });

  it('does not route Node access policy through MySQL storage', () => {
    const source = readFileSync(resolve('ee/server/src/mysql/server-database.ts'), 'utf8');
    expect(source).not.toMatch(/\b(?:setNodeAccessResolver|setNodeRequestAccessResolver)\b/u);
    expect(source).not.toMatch(/\buserCanRequestNode\b/u);
  });

  it('keeps Server domains independent of composition and entry points for every import form', () => {
    const directory = resolve('ee/server/src');
    const collectFiles = (relativeDirectory = ''): string[] =>
      readdirSync(resolve(directory, relativeDirectory), { withFileTypes: true }).flatMap(
        (entry) => {
          const path = posix.join(relativeDirectory, entry.name);
          return entry.isDirectory() ? collectFiles(path) : entry.isFile() ? [path] : [];
        }
      );
    for (const file of collectFiles().filter((path) => path.endsWith('.ts'))) {
      for (const specifier of moduleSpecifiers(
        file,
        readFileSync(resolve(directory, file), 'utf8')
      )) {
        const target = specifier.startsWith('.')
          ? posix.normalize(posix.join(posix.dirname(file), specifier))
          : specifier;
        expect(target, `${file}: ${specifier}`).not.toMatch(
          /^(?:@myagentroam\/server(?:\/|$)|(?:\.\.\/)+mar-server\/)/u
        );
        if (file !== 'app.ts' && !file.startsWith('composition/'))
          expect(target, `${file}: ${specifier}`).not.toMatch(/^(?:app\.js|composition\/)/u);
      }
    }
    expect(
      moduleSpecifiers(
        'example.ts',
        "import type { A } from '../app.js'; type B = import('../composition/x.js').B; void import('../composition/x.js'); export { C } from '../app.js';"
      )
    ).toEqual(['../app.js', '../composition/x.js', '../composition/x.js', '../app.js']);
  });
});
