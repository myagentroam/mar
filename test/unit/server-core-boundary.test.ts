import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('Server Core workspace boundary', () => {
  it('uses a product-versioned public core without copying authentication primitives', () => {
    const core = JSON.parse(read('packages/server-core/package.json'));
    const server = JSON.parse(read('ee/server/package.json'));
    expect(core.name).toBe('@myagentroam/server-core');
    expect(core.version).toBe(server.version);
    expect(server.dependencies[core.name]).toBe('workspace:*');
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
    expect(files).toContain('session.ts');
    for (const file of sourceFiles) {
      const source = readFileSync(resolve(directory, file), 'utf8');
      const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const imports: string[] = [];
      const visit = (node: ts.Node): void => {
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)
        ) {
          imports.push(node.moduleSpecifier.text);
        }
        if (
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          node.arguments[0] &&
          ts.isStringLiteral(node.arguments[0])
        ) {
          imports.push(node.arguments[0].text);
        }
        ts.forEachChild(node, visit);
      };
      visit(syntax);
      for (const specifier of imports) {
        const target = posix.normalize(posix.join(posix.dirname(file), specifier));
        expect(
          specifier.startsWith('node:') ||
            specifier === 'fastify' ||
            specifier === 'mysql2/promise' ||
            specifier === 'ws' ||
            specifier === 'undici' ||
            specifier === 'zod' ||
            specifier === 'nodemailer' ||
            specifier === '@fastify/websocket' ||
            specifier === '@myagentroam/protocol' ||
            specifier === '@myagentroam/protocol/package.json' ||
            (specifier.startsWith('.') &&
              !target.startsWith('../') &&
              (files.includes(target) || files.includes(target.replace(/\.js$/u, '.ts')))),
          `${file}: ${specifier}`
        ).toBe(true);
      }
      expect(source).not.toMatch(/LicenseService|MysqlServerDatabase|@myagentroam-enterprise/u);
    }
  });
});
