import { readFile, readdir } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ignored = new Set(['.git', '.env', '.mar', 'node_modules', 'dist', 'runs', 'data']);
const sourceExtensions = new Set([
  '.cjs',
  '.cts',
  '.js',
  '.json',
  '.jsonc',
  '.jsx',
  '.mjs',
  '.mts',
  '.ts',
  '.tsx',
  '.vue'
]);
const chineseText = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const privateIdentifier =
  /(?:my-agent-roam-enterprise|mar-server-enterprise|mar-web-enterprise|packages\/enterprise-[a-z0-9-]+|\bharness\/|docs\/design\/|\.plan\/|\.tasks\/)/u;
const privateIdentifierCheckers = new Set([
  'scripts/check-public-boundary.mjs',
  'scripts/check-release-artifacts.mjs'
]);

function allowsLocalizedText(path) {
  const parts = path.split('/');
  const name = parts.at(-1) ?? '';
  return (
    (parts.length === 1 && /^README(?:\.[a-zA-Z0-9-]+)?\.md$/u.test(name)) ||
    path.startsWith('docs/help/') ||
    path === 'ee/server/src/cli-messages.zh-CN.ts' ||
    (path.startsWith('mar-web-console/docs/') && /\.zh-CN\.ts$/u.test(name)) ||
    parts.includes('i18n') ||
    (parts.includes('test') &&
      (/\.(?:test|spec|cases)\.[cm]?[jt]sx?$/u.test(name) ||
        (parts.includes('support') && /\.[cm]?[jt]sx?$/u.test(name))))
  );
}

function decodeText(buffer) {
  if (buffer.includes(0)) return '';
  try {
    const source = utf8Decoder.decode(buffer);
    const controls = [...source].filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 && character !== '\n' && character !== '\r' && character !== '\t';
    }).length;
    return controls > Math.max(8, source.length / 100) ? '' : source;
  } catch {
    return '';
  }
}

export function publicSourceViolations(path, source, directory = root) {
  const failures = [];
  const name = path.split('/').at(-1);
  const core = /^(?:packages\/|mar-agent\/|mar-node\/|marctl\/)/u.test(path);
  if (/^(?:harness\/|docs\/design\/|\.env\/|\.plan\/|\.tasks\/)/u.test(path))
    failures.push('PUBLIC_PRIVATE_FILE_FORBIDDEN');
  if (name?.toLowerCase() === 'agents.md') failures.push('PUBLIC_AGENT_INSTRUCTIONS_FORBIDDEN');
  if (
    path.includes('/') &&
    /^(?:readme|readme(?:\.[a-z0-9-]+)*\.(?:md|markdown|rst|txt|html?))$/iu.test(name ?? '')
  )
    failures.push('PUBLIC_NESTED_README_FORBIDDEN');
  if (!allowsLocalizedText(path) && chineseText.test(source))
    failures.push('PUBLIC_NON_I18N_CHINESE_FORBIDDEN');
  if (
    !path.split('/').includes('test') &&
    path !== '.dockerignore' &&
    !privateIdentifierCheckers.has(path) &&
    privateIdentifier.test(source)
  )
    failures.push('PUBLIC_PRIVATE_IDENTIFIER_FORBIDDEN');
  if (!sourceExtensions.has(extname(path))) return failures;
  const imports = [];
  const code =
    extname(path) === '.vue'
      ? [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gu)]
          .map((match) => match[1])
          .join('\n')
      : source;
  const ast = ts.createSourceFile(path, code, ts.ScriptTarget.Latest, true);
  const testSource = path.split('/').includes('test');
  let nonEnglishTestDescription = false;
  function visit(node) {
    if (testSource) {
      const comments = [
        ...(ts.getLeadingCommentRanges(code, node.pos) ?? []),
        ...(ts.getTrailingCommentRanges(code, node.end) ?? [])
      ];
      if (comments.some(({ pos, end }) => chineseText.test(code.slice(pos, end))))
        nonEnglishTestDescription = true;
      if (ts.isCallExpression(node)) {
        let callee = node.expression;
        while (ts.isPropertyAccessExpression(callee) || ts.isCallExpression(callee))
          callee = callee.expression;
        const title = node.arguments[0];
        if (
          ts.isIdentifier(callee) &&
          ['test', 'it', 'describe'].includes(callee.text) &&
          title &&
          (ts.isStringLiteralLike(title) || ts.isTemplateExpression(title)) &&
          chineseText.test(title.getText(ast))
        )
          nonEnglishTestDescription = true;
      }
    }
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      imports.push(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      imports.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  }
  if (extname(path) !== '.json') visit(ast);
  if (nonEnglishTestDescription) failures.push('PUBLIC_TEST_DESCRIPTION_CHINESE_FORBIDDEN');
  for (const specifier of imports) {
    if (core && specifier.startsWith('@myagentroam-enterprise/'))
      failures.push('PUBLIC_CORE_EE_IMPORT_FORBIDDEN');
    if (specifier.startsWith('.') || isAbsolute(specifier)) {
      const target = relative(directory, resolve(directory, dirname(path), specifier));
      if (core && target.startsWith('ee/')) failures.push('PUBLIC_CORE_EE_IMPORT_FORBIDDEN');
      if (isAbsolute(target) || target === '..' || target.startsWith('../'))
        failures.push('PUBLIC_OUTSIDE_IMPORT_FORBIDDEN');
    }
  }
  if (name === 'package.json') {
    const pkg = JSON.parse(source);
    for (const section of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies'
    ]) {
      for (const name of Object.keys(pkg[section] ?? {}))
        if (core && name.startsWith('@myagentroam-enterprise/'))
          failures.push('PUBLIC_CORE_EE_DEPENDENCY_FORBIDDEN');
    }
    if (pkg.engines?.node && /(?:<|\|\|)/u.test(pkg.engines.node))
      failures.push('PUBLIC_NODE_RUNTIME_UPPER_BOUND_FORBIDDEN');
  }
  return failures;
}

export async function checkPublicBoundary(directory = root) {
  const failures = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const absolute = resolve(path, entry.name);
      const local = relative(directory, absolute).split('\\').join('/');
      if (local.endsWith('/.vitepress/cache')) continue;
      if (entry.isSymbolicLink()) {
        failures.push(`${relative(directory, absolute)}: PUBLIC_SOURCE_SYMLINK_FORBIDDEN`);
      } else if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        const source = decodeText(await readFile(absolute));
        for (const code of publicSourceViolations(local, source, directory))
          failures.push(`${local}: ${code}`);
      }
    }
  }
  await visit(directory);
  if (failures.length) throw new Error(failures.join('\n'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await checkPublicBoundary();
  console.log('Public source boundary check passed.');
}
