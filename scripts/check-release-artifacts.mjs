import { spawnSync } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const sourceMap = /\.map$/u;
const rawTypeScript = /(?<!\.d)\.ts$/u;
const declaration = /\.d\.ts$/u;
const protectionMarker = '/* mar-release-protected */';
const privateIdentifier =
  /(?:my-agent-roam-enterprise|mar-server-enterprise|mar-web-enterprise|packages\/enterprise-[a-z0-9-]+|harness\/|docs\/design\/)/u;
const inspectableReleaseText = /\.(?:js|mjs|css|html|json|webmanifest|txt)$/u;
const nodeVendorAllowlist = new Set([
  'vendor/ripgrep/linux-x64/rg',
  'vendor/ripgrep/linux-arm64/rg',
  'vendor/ripgrep/darwin-x64/rg',
  'vendor/ripgrep/darwin-arm64/rg',
  'vendor/ripgrep/win32-x64/rg.exe',
  'vendor/ripgrep/win32-arm64/rg.exe',
  'vendor/ripgrep/LICENSE-MIT',
  'vendor/ripgrep/UNLICENSE',
  'vendor/ripgrep/manifest.json',
  'vendor/ctags/darwin-arm64/ctags',
  'vendor/ctags/darwin-x64/ctags',
  'vendor/ctags/linux-x64/ctags',
  'vendor/ctags/linux-arm64/ctags',
  'vendor/ctags/win32-x64/ctags.exe',
  'vendor/ctags/source/universal-ctags-ab95af198f8eaeb6d50dc96e3adf52e769d3e5f0.tar.gz',
  'vendor/ctags/licenses/COPYING',
  'vendor/ctags/licenses/COPYING.MinGW-w64-runtime.txt',
  'vendor/ctags/licenses/LICENSE.janssen',
  'vendor/ctags/licenses/LICENSE.libyaml',
  'vendor/ctags/licenses/win32-x64/COPYING',
  'vendor/ctags/licenses/win32-x64/COPYING.MinGW-w64-runtime.txt',
  'vendor/ctags/licenses/win32-x64/Copyright.libxml2',
  'vendor/ctags/licenses/win32-x64/LICENCE.pcre2',
  'vendor/ctags/licenses/win32-x64/LICENSE.janssen',
  'vendor/ctags/licenses/win32-x64/LICENSE.libyaml',
  'vendor/ctags/licenses/official-snapshot/darwin-arm64/COPYING',
  'vendor/ctags/licenses/official-snapshot/darwin-arm64/RECEIPT.yml',
  'vendor/ctags/licenses/official-snapshot/darwin-arm64/dependencies/libiconv.yml',
  'vendor/ctags/licenses/official-snapshot/darwin-arm64/dependencies/libjansson.yml',
  'vendor/ctags/licenses/official-snapshot/darwin-arm64/dependencies/libxml2.yml',
  'vendor/ctags/licenses/official-snapshot/darwin-arm64/dependencies/libyaml.yml',
  'vendor/ctags/licenses/official-snapshot/darwin-arm64/dependencies/libz.yml',
  'vendor/ctags/licenses/official-snapshot/darwin-x64/COPYING',
  'vendor/ctags/licenses/official-snapshot/darwin-x64/RECEIPT.yml',
  'vendor/ctags/licenses/official-snapshot/darwin-x64/dependencies/libiconv.yml',
  'vendor/ctags/licenses/official-snapshot/darwin-x64/dependencies/libjansson.yml',
  'vendor/ctags/licenses/official-snapshot/darwin-x64/dependencies/libxml2.yml',
  'vendor/ctags/licenses/official-snapshot/darwin-x64/dependencies/libyaml.yml',
  'vendor/ctags/licenses/official-snapshot/darwin-x64/dependencies/libz.yml',
  'vendor/ctags/licenses/official-snapshot/linux-arm64/COPYING',
  'vendor/ctags/licenses/official-snapshot/linux-arm64/RECEIPT.yml',
  'vendor/ctags/licenses/official-snapshot/linux-arm64/dependencies/libiconv.yml',
  'vendor/ctags/licenses/official-snapshot/linux-arm64/dependencies/libjansson.yml',
  'vendor/ctags/licenses/official-snapshot/linux-arm64/dependencies/libxml2.yml',
  'vendor/ctags/licenses/official-snapshot/linux-arm64/dependencies/libyaml.yml',
  'vendor/ctags/licenses/official-snapshot/linux-arm64/dependencies/libz.yml',
  'vendor/ctags/licenses/official-snapshot/linux-x64/COPYING',
  'vendor/ctags/licenses/official-snapshot/linux-x64/RECEIPT.yml',
  'vendor/ctags/licenses/official-snapshot/linux-x64/dependencies/libiconv.yml',
  'vendor/ctags/licenses/official-snapshot/linux-x64/dependencies/libjansson.yml',
  'vendor/ctags/licenses/official-snapshot/linux-x64/dependencies/libxml2.yml',
  'vendor/ctags/licenses/official-snapshot/linux-x64/dependencies/libyaml.yml',
  'vendor/ctags/licenses/official-snapshot/linux-x64/dependencies/libz.yml',
  'vendor/ctags/NOTICE',
  'vendor/ctags/manifest.json'
]);

function check(value, message) {
  if (!value) throw new Error(message);
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? walk(path) : [path];
    })
  );
  return nested.flat();
}

async function checkBuildDirectory(directory) {
  check(
    (await stat(directory)).isDirectory(),
    `Missing build directory: ${relative(root, directory)}`
  );
  const files = (await walk(directory)).map((path) =>
    relative(directory, path).split(sep).join('/')
  );
  check(!files.some((path) => sourceMap.test(path)), `${directory} contains source maps`);
  check(
    !files.some((path) => rawTypeScript.test(path)),
    `${directory} contains TypeScript source files`
  );
  const JavaScript = files.filter((path) => path.endsWith('.js'));
  check(JavaScript.length > 0, `${directory} is missing JavaScript output`);
  const inspectable = files.filter((path) => inspectableReleaseText.test(path));
  const sources = await Promise.all(
    inspectable.map((path) => readFile(resolve(directory, path), 'utf8'))
  );
  check(
    sources.every(
      (source) => !privateIdentifier.test(source) && !source.includes(protectionMarker)
    ),
    `${directory} contains private or enterprise-protected JavaScript`
  );
}

export function unexpectedNpmPackageFiles(packageName, files) {
  const isAgent =
    packageName === '@myagentroam/agent' || packageName === '@myagentroam/agent-extension-subagent';
  const isProtocol = packageName === '@myagentroam/protocol';
  const isCodeNavigation = packageName === '@myagentroam/code-navigation';
  const isNode = packageName === '@myagentroam/node';
  return files.filter(
    (path) =>
      !['package.json', 'README.md', 'README.zh-CN.md', 'LICENSE', 'NOTICE'].includes(path) &&
      !(isNode && path === 'scripts/install-web-browser.mjs') &&
      !(isNode && path === 'dist/config.d.ts') &&
      !(isNode && nodeVendorAllowlist.has(path)) &&
      (!path.startsWith('dist/') ||
        sourceMap.test(path) ||
        rawTypeScript.test(path) ||
        (!isAgent && !isProtocol && !isCodeNavigation && declaration.test(path)))
  );
}

async function checkNpmPackage(directory) {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: directory,
    encoding: 'utf8'
  });
  check(result.status === 0, result.stderr || `npm pack --dry-run failed: ${directory}`);
  const report = JSON.parse(result.stdout)[0];
  const files = report.files.map(({ path }) => path);
  const packageName = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8')).name;
  const isAgent =
    packageName === '@myagentroam/agent' || packageName === '@myagentroam/agent-extension-subagent';
  const isProtocol = packageName === '@myagentroam/protocol';
  const isCodeNavigation = packageName === '@myagentroam/code-navigation';
  const isNode = packageName === '@myagentroam/node';
  const unexpected = unexpectedNpmPackageFiles(packageName, files);
  check(
    unexpected.length === 0,
    `${directory} contains files outside the release allowlist: ${unexpected.join(', ')}`
  );
  if (isNode)
    for (const resource of nodeVendorAllowlist)
      check(files.includes(resource), `${directory} is missing bundled resource: ${resource}`);
  if (isNode)
    check(
      files.every((path) => !path.startsWith('vendor/computer-use/')),
      `${directory} contains a bundled Computer Use runtime`
    );
  check(
    files.some((path) => path.endsWith('.js')),
    `${directory} is missing JavaScript output`
  );
  if (isAgent || isProtocol || isCodeNavigation)
    check(
      files.some((path) => declaration.test(path)),
      `${directory} is missing public type declarations`
    );
}

export async function checkProductReleaseArtifacts(directory = root) {
  await Promise.all(
    [
      'packages/protocol/dist',
      'packages/code-navigation/dist',
      'mar-agent/dist',
      'mar-agent/extensions/subagent/dist',
      'mar-node/dist',
      'mar-server/dist',
      'ee/server/dist',
      'packages/server-core/dist',
      'mar-web-console/dist'
    ].map((path) => checkBuildDirectory(resolve(directory, path)))
  );
  await Promise.all(
    [
      'packages/protocol',
      'packages/code-navigation',
      'mar-agent',
      'mar-agent/extensions/subagent',
      'mar-node'
    ].map((path) => checkNpmPackage(resolve(directory, path)))
  );
  const notices = await readFile(
    resolve(directory, 'mar-web-console/dist/THIRD_PARTY_NOTICES.txt'),
    'utf8'
  );
  check(notices.trim().length > 0, 'Product Web third-party notices are missing');
  const dockerfile = await readFile(resolve(directory, 'Dockerfile'), 'utf8');
  const serverStart = dockerfile.search(/^FROM[^\n]+ AS server\s*$/mu);
  check(serverStart >= 0, 'Product Server image stage is missing');
  const buildStage = dockerfile.slice(0, serverStart);
  check(
    buildStage.includes("find /runtime/server -type f -name '*.map' -delete"),
    'Product Server runtime does not remove source maps'
  );
  check(
    buildStage.includes("find /runtime/server -type f -name '*.d.ts' -delete"),
    'Product Server runtime does not remove type declarations'
  );
  const remaining = dockerfile.slice(serverStart);
  const nextStage = remaining.indexOf('\nFROM ');
  const serverStage = nextStage < 0 ? remaining : remaining.slice(0, nextStage);
  check(serverStage.includes('/runtime/server'), 'Product Server image is not pruned');
  check(!serverStage.includes('/workspace'), 'Product Server image copies the build workspace');
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await checkProductReleaseArtifacts();
  process.stdout.write('Product release artifact check passed.\n');
}
