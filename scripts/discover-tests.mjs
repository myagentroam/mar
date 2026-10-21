import { execFileSync } from 'node:child_process';
import { readFile, lstat } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const testPattern = /\.(?:test|spec|cases)\.[cm]?[jt]sx?$/u;
const slash = (path) => path.replaceAll('\\', '/');
const normalize = (value) => value.toLowerCase().replaceAll(/[^\p{L}\p{N}]+/gu, ' ');

// Parse declarations only; never import test modules or runner configuration.
export function parseCases(text, path) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const names = new Map();
  const imports = [];
  const runtimeImports = [];
  let runner = 'unknown';
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      const onlyTypes =
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause) &&
        statement.exportClause.elements.length > 0 &&
        statement.exportClause.elements.every((item) => item.isTypeOnly);
      if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        imports.push(statement.moduleSpecifier.text);
        if (!statement.isTypeOnly && !onlyTypes)
          runtimeImports.push(statement.moduleSpecifier.text);
      }
      continue;
    }
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    const specifier = statement.moduleSpecifier.text;
    imports.push(specifier);
    if (statement.importClause?.isTypeOnly) continue;
    const bindings = statement.importClause?.namedBindings;
    if (
      !statement.importClause?.name &&
      bindings &&
      ts.isNamedImports(bindings) &&
      bindings.elements.length > 0 &&
      bindings.elements.every((item) => item.isTypeOnly)
    )
      continue;
    runtimeImports.push(specifier);
    if (specifier === 'node:test') runner = 'node';
    if (specifier === 'vitest') runner = 'vitest';
    if (specifier === '@playwright/test') runner = 'playwright';
    const clause = statement.importClause;
    if (clause?.name && specifier === 'node:test') names.set(clause.name.text, 'test');
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const binding of clause.namedBindings.elements) {
        const original = (binding.propertyName ?? binding.name).text;
        if (['test', 'it', 'describe', 'suite'].includes(original))
          names.set(binding.name.text, original);
      }
    }
  }
  const comments = new Set();
  function collectComments(node) {
    for (const range of ts.getLeadingCommentRanges(text, node.pos) ?? [])
      comments.add(text.slice(range.pos, range.end));
    ts.forEachChild(node, collectComments);
  }
  collectComments(source);
  const metadata = [...comments].join('\n');
  const contracts = [...metadata.matchAll(/(?:\/\/|\*)\s*@test-contract\s+([^\r\n]+)/gu)].map((m) =>
    m[1].trim()
  );
  const covers = [...metadata.matchAll(/(?:\/\/|\*)\s*@test-covers\s+([^\s*]+)/gu)].map(
    (m) => m[1]
  );
  const arrays = {};
  for (const statement of source.statements)
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.initializer &&
          ts.isArrayLiteralExpression(declaration.initializer)
        )
          arrays[declaration.name.text] = declaration.initializer.elements
            .filter(ts.isStringLiteral)
            .map((item) => item.text);
      }
    }
  const cases = [];
  function callInfo(expression) {
    if (ts.isIdentifier(expression)) return { name: expression.text, modifiers: [] };
    if (ts.isPropertyAccessExpression(expression)) {
      const info = callInfo(expression.expression);
      return info && { ...info, modifiers: [...info.modifiers, expression.name.text] };
    }
    if (ts.isCallExpression(expression) || ts.isTaggedTemplateExpression(expression)) {
      const info = callInfo(
        ts.isCallExpression(expression) ? expression.expression : expression.tag
      );
      return info && { ...info, modifiers: [...info.modifiers, 'dynamic'] };
    }
    return null;
  }
  function visit(node, suites = [], inherited = []) {
    if (
      ts.isForStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isIfStatement(node)
    ) {
      ts.forEachChild(node, (child) => visit(child, suites, [...inherited, 'dynamic']));
      return;
    }
    if (ts.isCallExpression(node)) {
      const info = callInfo(node.expression);
      const rootKind =
        info &&
        (names.get(info.name) ??
          (['test', 'it', 'describe', 'suite'].includes(info.name) ? info.name : undefined));
      const kind = rootKind && info.modifiers.includes('describe') ? 'describe' : rootKind;
      if (
        kind &&
        info.modifiers.every((m) =>
          [
            'describe',
            'skip',
            'only',
            'todo',
            'each',
            'for',
            'concurrent',
            'sequential',
            'serial',
            'parallel',
            'fails',
            'skipIf',
            'runIf',
            'dynamic'
          ].includes(m)
        )
      ) {
        const first = node.arguments[0];
        const literal =
          first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first));
        if (
          !literal &&
          !node.arguments.some(
            (argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)
          )
        )
          return;
        const title = literal ? first.text : '<dynamic title>';
        const flags = [...inherited, ...info.modifiers];
        const position = source.getLineAndCharacterOfPosition(node.getStart(source));
        if (kind === 'describe' || kind === 'suite') {
          for (const argument of node.arguments) {
            if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument))
              visit(argument.body, [...suites, title], flags);
          }
          return;
        }
        if (!info.modifiers.includes('each') || info.modifiers.includes('dynamic')) {
          cases.push({
            title: [...suites, title].join(' > '),
            line: position.line + 1,
            column: position.character + 1,
            status: flags.includes('skip')
              ? 'skip'
              : flags.includes('todo')
                ? 'todo'
                : flags.includes('only')
                  ? 'only'
                  : 'declared',
            dynamic:
              !literal ||
              flags.some((m) => ['each', 'for', 'dynamic', 'skipIf', 'runIf'].includes(m)) ||
              suites.includes('<dynamic title>')
          });
          return;
        }
      }
    }
    ts.forEachChild(node, (child) => visit(child, suites, inherited));
  }
  visit(source);
  return {
    cases,
    imports,
    runtimeImports,
    contracts,
    covers,
    arrays,
    runner,
    parseErrors: source.parseDiagnostics.map((d) =>
      ts.flattenDiagnosticMessageText(d.messageText, ' ')
    )
  };
}

export async function discoverTests(root) {
  root = resolve(root);
  const listed = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: root, maxBuffer: 16 * 1024 * 1024 }
  )
    .toString()
    .split('\0');
  const excluded =
    /(?:^|\/)(?:node_modules|dist|build|coverage|\.git|\.worktrees|runs|fixtures|__fixtures__)(?:\/|$)/u;
  const files = [...new Set(listed)]
    .filter((p) => p && /\.(?:[cm]?[jt]s|tsx|jsx)$/u.test(p) && !excluded.test(p))
    .sort();
  const available = new Set(files);
  const packages = new Map();
  for (const path of listed.filter((p) => /(?:^|\/)package\.json$/u.test(p) && !excluded.test(p))) {
    try {
      const pkg = JSON.parse(await readFile(resolve(root, path), 'utf8'));
      if (pkg.name) packages.set(pkg.name, dirname(path));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const records = new Map();
  const assets = [];
  const diagnostics = [];
  function localImport(path, specifier) {
    if (!specifier.startsWith('.')) {
      const name = [...packages.keys()].find(
        (name) => specifier === name || specifier.startsWith(name + '/')
      );
      return name ? packages.get(name) : null;
    }
    const base = slash(relative(root, resolve(root, dirname(path), specifier)));
    if (base.startsWith('../')) return null;
    const stem = base.replace(/\.[cm]?js$/u, '');
    const mappedExtension = base.endsWith('.mjs') ? '.mts' : base.endsWith('.cjs') ? '.cts' : '.ts';
    return (
      [
        base,
        stem + mappedExtension,
        stem + '.ts',
        stem + '.mts',
        stem + '.tsx',
        base + '.ts',
        base + '.mjs',
        base + '/index.ts'
      ].find((p) => available.has(p)) ?? base
    );
  }
  for (const path of files) {
    let stat;
    try {
      stat = await lstat(resolve(root, path));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (!stat.isFile()) continue;
    const parsed = parseCases(await readFile(resolve(root, path), 'utf8'), path);
    records.set(path, {
      ...parsed,
      dependencies: parsed.imports.map((p) => localImport(path, p)).filter(Boolean),
      runtimeDependencies: parsed.runtimeImports.map((p) => localImport(path, p)).filter(Boolean)
    });
  }
  const reverse = new Map();
  for (const [path, record] of records)
    for (const dependency of record.runtimeDependencies) {
      if (!reverse.has(dependency)) reverse.set(dependency, []);
      reverse.get(dependency).push(path);
    }
  function entrypoints(path) {
    if (!path.includes('.cases.')) return [path];
    const seen = new Set([path]);
    const queue = [path];
    const found = [];
    while (queue.length)
      for (const importer of reverse.get(queue.shift()) ?? []) {
        if (seen.has(importer)) continue;
        seen.add(importer);
        if (/\.spec\./u.test(importer)) found.push(importer);
        else queue.push(importer);
      }
    return found.sort();
  }
  function runnerCommands(path, runner, entries, item) {
    if (runner === 'node')
      return [
        {
          kind: 'execute',
          cwd: '.',
          command: 'node',
          args: [...(/\.tsx?$/u.test(path) ? ['--import', 'tsx'] : []), '--test', path]
        }
      ];
    if (runner === 'vitest') {
      let directory = dirname(path);
      while (true) {
        const config = ['vitest.config.ts', 'vitest.config.mts'].find((name) =>
          available.has(slash(directory === '.' ? name : directory + '/' + name))
        );
        if (config) {
          const file = slash(relative(directory, path));
          return [
            {
              kind: 'discover',
              cwd: directory,
              command: 'pnpm',
              args: ['exec', 'vitest', 'list', '--config', config, file, '--json']
            }
          ];
        }
        if (directory === '.') break;
        directory = dirname(directory);
      }
    }
    if (runner === 'playwright' && available.has('scripts/test-e2e.mjs')) {
      // The wrapper owns database/build isolation; listing is not execution evidence.
      const integrationFiles =
        records.get('scripts/test-e2e-policy.mjs')?.arrays.integrationTestFiles ?? [];
      return entries.map((entry) => ({
        kind: 'discover',
        cwd: '.',
        command: 'pnpm',
        args: [
          integrationFiles.includes(entry.replace(/^test\/e2e\//u, ''))
            ? 'test:integration'
            : entry.endsWith('/release-smoke.spec.ts')
              ? 'test:smoke'
              : 'test:e2e',
          '--list',
          entry,
          ...(!item.dynamic
            ? [
                '--grep',
                item.title
                  .split(' > ')
                  .at(-1)
                  .replace(/[.*+?^$()|[\]\\]/gu, '\\$&')
              ]
            : [])
        ]
      }));
    }
    return [];
  }
  for (const [path, record] of records) {
    const standalone = /(?:^|\/)test\/(?:live|manual)\//u.test(path) && !path.includes('/support/');
    if (!testPattern.test(path) && !standalone) continue;
    const entries = entrypoints(path);
    if (record.parseErrors.length || !record.cases.length || !entries.length)
      diagnostics.push({
        path,
        reason: record.parseErrors.length
          ? 'parse-error'
          : !record.cases.length
            ? 'no-static-cases'
            : 'missing-aggregate-entrypoint'
      });
    const cases = record.cases.length
      ? record.cases
      : [
          {
            title: '<runner discovery required>',
            line: 1,
            column: 1,
            status: 'unknown',
            dynamic: true
          }
        ];
    const occurrences = new Map();
    for (const item of cases) {
      const occurrence = (occurrences.get(item.title) ?? 0) + 1;
      occurrences.set(item.title, occurrence);
      if (occurrence > 1 && !item.dynamic)
        diagnostics.push({ path, reason: 'duplicate-static-title', title: item.title });
      assets.push({
        id: path + '::' + item.title + (occurrence > 1 ? '::occurrence-' + occurrence : ''),
        source: path,
        ...item,
        runner: record.runner,
        type: standalone
          ? 'live/manual'
          : path.includes('/e2e/')
            ? 'e2e-candidate'
            : 'unit-candidate',
        contract: record.contracts.join(' '),
        implementationPaths: [path, ...record.dependencies, ...record.covers],
        entrypoints: entries,
        discovery: 'static-candidate',
        requiresRunnerConfirmation: true,
        commands: runnerCommands(path, record.runner, entries, item)
      });
    }
  }
  return {
    version: 2,
    mode: 'source-discovery',
    assets,
    diagnostics,
    sourceFileCount: records.size
  };
}

export function searchTests(index, { paths = [], query = [] } = {}) {
  paths = paths.map((path) => slash(path).replace(/^\.\//u, '').replace(/\/$/u, ''));
  const words = query.flatMap((q) => normalize(q).split(' ').filter(Boolean));
  return index.assets.filter((asset) => {
    const pathMatch = paths.some((path) =>
      asset.implementationPaths.some(
        (p) => p === path || p.startsWith(path + '/') || path.startsWith(p + '/')
      )
    );
    const text = normalize(
      [asset.source, asset.title, asset.contract, ...asset.implementationPaths].join(' ')
    );
    return (
      pathMatch ||
      (words.length > 0 && words.every((word) => text.includes(word))) ||
      (!paths.length && !words.length && !query.length)
    );
  });
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const options = { paths: [], query: [] };
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') json = true;
    else if (
      ['--path', '--query'].includes(args[i]) &&
      args[i + 1] &&
      !args[i + 1].startsWith('--')
    )
      options[args[i] === '--path' ? 'paths' : 'query'].push(args[++i]);
    else throw new Error('Unknown or incomplete option: ' + args[i]);
  }
  const index = await discoverTests(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  const assets = searchTests(index, options);
  if (json) console.log(JSON.stringify({ ...index, assets }, null, 2));
  else {
    console.log(
      'Static candidates: ' + assets.length + '; runner confirmation required. No tests executed.'
    );
    for (const asset of assets.slice(0, 30)) {
      console.log(
        asset.source +
          ':' +
          asset.line +
          ' [' +
          asset.runner +
          '/' +
          asset.status +
          (asset.dynamic ? '/dynamic' : '') +
          '] ' +
          asset.title +
          '\n  entries: ' +
          (asset.entrypoints.join(', ') || 'unresolved')
      );
      for (const command of asset.commands)
        console.log(
          '  ' +
            command.kind +
            ' cwd=' +
            command.cwd +
            ': ' +
            JSON.stringify([command.command, ...command.args])
        );
    }
    if (assets.length > 30)
      console.log('More matches omitted; narrow --path/--query or use --json.');
    if (index.diagnostics.length)
      console.log(index.diagnostics.length + ' unresolved files; inspect diagnostics with --json.');
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
