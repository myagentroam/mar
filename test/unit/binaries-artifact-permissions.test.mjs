import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { binariesTargets } from '../../scripts/binaries-packages.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const executableNames = new Set([
  'rg',
  'ctags',
  'macVNC',
  'macos-topology',
  'x0vncserver',
  'x11-topology'
]);

async function executableResources(directory, prefix = 'vendor') {
  const resources = [];
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) resources.push(...(await executableResources(directory, path)));
    else if (executableNames.has(basename(path))) resources.push(path);
  }
  return resources;
}

for (const target of binariesTargets.filter(({ id }) => !id.startsWith('win32'))) {
  test(`packed ${target.name} retains executable native resources`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'mar-binaries-permissions-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const source = join(directory, 'source');
    await cp(join(root, target.path), source, { recursive: true });
    for (const file of ['LICENSE', 'NOTICE']) await cp(join(root, file), join(source, file));
    const resources = await executableResources(source);
    assert.ok(resources.length >= 2, 'Ripgrep and Ctags must be present');
    execFileSync('pnpm', ['pack', '--pack-destination', directory], { cwd: source, stdio: 'pipe' });
    const archive = (await readdir(directory)).find((file) => file.endsWith('.tgz'));
    const entries = execFileSync(
      'tar',
      ['-tvzf', join(directory, archive), ...resources.map((file) => `package/${file}`)],
      { encoding: 'utf8' }
    )
      .trim()
      .split('\n');
    assert.equal(entries.length, resources.length);
    for (const entry of entries) assert.match(entry, /^-rwxr-xr-x\s/u, entry);
    if (target.id === `${process.platform}-${process.arch}`) {
      const consumer = join(directory, 'consumer');
      await mkdir(consumer);
      execFileSync('tar', ['-xzf', join(directory, archive), '-C', consumer]);
      for (const binary of ['ripgrep', 'ctags']) {
        const executable = binary === 'ripgrep' ? 'rg' : 'ctags';
        assert.ok(
          execFileSync(
            join(consumer, 'package/vendor', binary, target.id, executable),
            ['--version'],
            { encoding: 'utf8' }
          ).length > 0
        );
      }
    }
  });
}
