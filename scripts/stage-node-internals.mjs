import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'mar-node/dist');
const navigation = resolve(dist, 'code-navigation');
const cli = resolve(dist, 'marctl');

await cp(
  resolve(root, 'mar-node/src/terminal-pty-host.mjs'),
  resolve(dist, 'terminal-pty-host.mjs')
);
await cp(
  resolve(root, 'mar-node/src/terminal-pty-tree.mjs'),
  resolve(dist, 'terminal-pty-tree.mjs')
);

await mkdir(navigation, { recursive: true });
await cp(resolve(root, 'packages/code-navigation/dist'), navigation, {
  recursive: true,
  filter: (path) => !path.endsWith('.d.ts')
});
await cp(resolve(root, 'marctl/src'), resolve(cli, 'src'), {
  recursive: true,
  filter: (path) => !path.endsWith('.d.mts')
});
await cp(resolve(root, 'marctl/bin'), resolve(cli, 'bin'), { recursive: true });
const nodePackage = JSON.parse(await readFile(resolve(root, 'mar-node/package.json'), 'utf8'));
await writeFile(
  resolve(cli, 'package.json'),
  `${JSON.stringify({ type: 'module', version: nodePackage.version })}\n`
);

async function rewrite(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (path !== navigation && path !== cli) await rewrite(path);
      continue;
    }
    if (!entry.name.endsWith('.js')) continue;
    const source = await readFile(path, 'utf8');
    const output = source.replace(
      /@myagentroam\/(code-navigation(?:\/symbol-navigation)?|marctl\/(?:bin\/(?:marctl|marnodes|marssh|marscp)\.mjs|src\/terminal-relay-sender\.mjs))(?=['"])/gu,
      (_, target) => {
        const destination = target.startsWith('code-navigation')
          ? resolve(
              navigation,
              target.endsWith('/symbol-navigation') ? 'symbol-navigation.js' : 'index.js'
            )
          : resolve(dist, target);
        const pathFromFile = relative(dirname(path), destination).split(sep).join('/');
        return pathFromFile.startsWith('.') ? pathFromFile : `./${pathFromFile}`;
      }
    );
    if (/@myagentroam\/(?:code-navigation|marctl)(?:\/|['"])/u.test(output))
      throw new Error(`Unstaged internal dependency in ${path}`);
    if (source !== output) await writeFile(path, output);
  }
}
await rewrite(dist);
