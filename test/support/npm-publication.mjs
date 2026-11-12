import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicationPackagePaths } from '../../scripts/npm-publication.mjs';

export const digest = (bytes, algorithm = 'sha256') =>
  createHash(algorithm).update(bytes).digest('hex');
export const sourceCommit = 'a'.repeat(40);
export const repository = 'myagentroam/mar';
export const version = '1.2.3';
export const integrity = (sha512) => `sha512-${Buffer.from(sha512, 'hex').toString('base64')}`;

export function commitFixtureSource(source) {
  const git = (...args) =>
    execFileSync(
      'git',
      [
        '-C',
        source,
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Publication Test',
        '-c',
        'user.email=publication@example.invalid',
        ...args
      ],
      { encoding: 'utf8', stdio: 'pipe' }
    ).trim();
  git('init');
  git('add', '.');
  git('commit', '-m', 'fixture');
  return git('rev-parse', 'HEAD');
}

export async function fixture(t, unit = 'common') {
  const root = await mkdtemp(join(tmpdir(), 'mar-npm-publication-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const directory = join(root, 'delivery');
  await mkdir(source);
  await mkdir(directory);
  const lockfile = 'lockfileVersion: 9.0\n';
  await writeFile(join(source, 'pnpm-lock.yaml'), lockfile);
  const names = Object.keys(publicationPackagePaths).filter((name) =>
    unit === 'common'
      ? ['@myagentroam/protocol', '@myagentroam/agent', '@myagentroam/node'].includes(name)
      : unit === 'runtime'
        ? name.startsWith('@myagentroam/computer-runtime-')
        : unit === 'binaries'
          ? name === '@myagentroam/binaries' || name.startsWith('@myagentroam/binaries-')
          : name === `@myagentroam/${unit}`
  );
  const packages = [];
  for (const name of names) {
    const path = publicationPackagePaths[name];
    const metadata = {
      name,
      version,
      repository: { type: 'git', url: `git+https://github.com/${repository}.git`, directory: path },
      publishConfig: { access: 'public' }
    };
    await mkdir(join(source, path), { recursive: true });
    await writeFile(join(source, path, 'package.json'), JSON.stringify(metadata));
    const stage = join(root, name.slice(name.indexOf('/') + 1));
    await mkdir(join(stage, 'package'), { recursive: true });
    await writeFile(join(stage, 'package/package.json'), JSON.stringify(metadata));
    const file = `${name.slice(1).replace('/', '-')}-${version}.tgz`;
    execFileSync('tar', ['-czf', join(directory, file), '-C', stage, 'package']);
    packages.push({
      name,
      version,
      file,
      sha512: digest(await readFile(join(directory, file)), 'sha512')
    });
  }
  const manifest = {
    formatVersion: 1,
    repository,
    sourceCommit,
    lockfileSha256: digest(lockfile),
    unit,
    version,
    tag: `${unit}-v${version}`,
    packages
  };
  const bytes = JSON.stringify(manifest);
  await writeFile(join(directory, 'npm-publication.json'), bytes);
  return {
    root,
    source,
    directory,
    manifest,
    expected: { sourceCommit, tag: manifest.tag, manifestSha256: digest(bytes) }
  };
}
