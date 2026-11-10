import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { MysqlInstallation } from './config.js';
import { downloadPinnedFile } from './download.js';
import { runChild, runChildWithOutput } from './owned-preparation.js';

// Oracle's signed 8.4.7 Linux x64 archive and Debian bookworm's libaio1.
const mysqlUrl =
  'https://cdn.mysql.com/archives/mysql-8.4/mysql-8.4.7-linux-glibc2.28-x86_64-minimal.tar.xz';
const mysqlSha256 = '543ec7d310c4f0786344d243663e5db9e985b03e741ee935370ab08b3274f05a';
const libaioUrl = 'https://deb.debian.org/debian/pool/main/liba/libaio/libaio1_0.3.113-4_amd64.deb';
const libaioSha256 = 'd1476e4beab3d85f8a7d31de94c27472711ed3ef399ce70708e24b259426125b';
// Oracle release archive, verified against its detached signature before pinning.
const windowsMysqlUrl = 'https://cdn.mysql.com/archives/mysql-8.4/mysql-8.4.7-winx64.zip';
const windowsMysqlSha256 = 'fd9bdbd4b5a878d31c8e4067078bd60665b1b3c4677fa1f099416d194b458aff';
const installation: MysqlInstallation = {
  version: '8.4.7',
  platform: 'linux',
  arch: 'x64',
  directory: 'components/mysql-8.4.7-linux-x64',
  libraryVersion: '0.3.113-4',
  libraryDirectory: 'components/libaio-0.3.113-4-linux-x64/usr/lib/x86_64-linux-gnu'
};
const windowsInstallation: MysqlInstallation = {
  version: '8.4.7',
  platform: 'win32',
  arch: 'x64',
  directory: 'components/mysql-8.4.7-win32-x64',
  libraryVersion: 'builtin',
  libraryDirectory: 'components/mysql-8.4.7-win32-x64/bin'
};

/** Prepares only the recorded deployment's MySQL binaries and private native dependency. */
export async function prepareMysqlInstallation(
  root: string,
  existing?: MysqlInstallation,
  signal?: AbortSignal
): Promise<MysqlInstallation> {
  if (existing !== undefined) {
    if (
      existing.platform !== process.platform ||
      existing.arch !== process.arch ||
      !/^8\.4\./u.test(existing.version)
    )
      throw new Error('QUICK_START_MYSQL_INSTALLATION_INCOMPATIBLE');
    await assertInstallation(root, existing);
    return existing;
  }
  if (process.platform === 'win32' && process.arch === 'x64') {
    try {
      await runChild('tar.exe', ['--version'], process.env, signal);
    } catch (error) {
      if (isReclaimFailure(error)) throw error;
      signal?.throwIfAborted();
      throw new Error(
        'QUICK_START_MYSQL_TOOLS_MISSING: Windows tar.exe must already be available on PATH.'
      );
    }
    const components = join(root, 'components');
    await mkdir(components, { recursive: true, mode: 0o700 });
    await prepareComponent(
      components,
      'mysql-8.4.7-win32-x64',
      windowsMysqlUrl,
      windowsMysqlSha256,
      async (archive, target) => {
        const listing = await runChildWithOutput(
          'tar.exe',
          ['-tf', archive],
          process.env,
          signal,
          'QUICK_START_DOWNLOAD_INVALID',
          1024 * 1024
        );
        for (const entry of listing.split(/\r?\n/u).filter(Boolean)) {
          if (
            !entry.startsWith('mysql-8.4.7-winx64/') ||
            entry.includes('\\') ||
            entry.includes(':') ||
            entry.split('/').includes('..')
          )
            throw new Error('QUICK_START_DOWNLOAD_INVALID');
        }
        await runChild(
          'tar.exe',
          ['-xf', archive, '-C', target, '--strip-components=1'],
          process.env,
          signal,
          'QUICK_START_MYSQL_INSTALL_FAILED'
        );
      },
      signal
    );
    await assertInstallation(root, windowsInstallation);
    return windowsInstallation;
  }
  if (process.platform !== 'linux' || process.arch !== 'x64')
    throw new Error('QUICK_START_MYSQL_PLATFORM_UNSUPPORTED');
  const report = process.report.getReport();
  const glibc =
    typeof report === 'string'
      ? undefined
      : (report as { header?: { glibcVersionRuntime?: string } }).header?.glibcVersionRuntime;
  const match = /^(\d+)\.(\d+)/u.exec(glibc ?? '');
  if (!match || Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 28))
    throw new Error('QUICK_START_MYSQL_GLIBC_UNSUPPORTED: Linux x64 requires glibc 2.28 or newer.');
  try {
    await runChild('tar', ['--version'], process.env, signal);
    await runChild('dpkg-deb', ['--version'], process.env, signal);
  } catch (error) {
    if (isReclaimFailure(error)) throw error;
    signal?.throwIfAborted();
    throw new Error(
      'QUICK_START_MYSQL_TOOLS_MISSING: tar and dpkg-deb must already be available on PATH.'
    );
  }
  const components = join(root, 'components');
  await mkdir(components, { recursive: true, mode: 0o700 });
  await prepareComponent(
    components,
    'mysql-8.4.7-linux-x64',
    mysqlUrl,
    mysqlSha256,
    async (archive, target) => {
      await runChild(
        'tar',
        ['-xJf', archive, '-C', target, '--strip-components=1'],
        process.env,
        signal,
        'QUICK_START_MYSQL_INSTALL_FAILED'
      );
    },
    signal
  );
  await prepareComponent(
    components,
    'libaio-0.3.113-4-linux-x64',
    libaioUrl,
    libaioSha256,
    async (archive, target) => {
      await runChild(
        'dpkg-deb',
        ['-x', archive, target],
        process.env,
        signal,
        'QUICK_START_MYSQL_INSTALL_FAILED'
      );
    },
    signal
  );
  await assertInstallation(root, installation);
  return installation;
}

async function assertInstallation(root: string, value: MysqlInstallation): Promise<void> {
  try {
    if (value.platform === 'win32') {
      await access(resolve(root, value.directory, 'bin/mysqld.exe'));
    } else {
      await Promise.all([
        access(resolve(root, value.directory, 'bin/mysqld')),
        access(resolve(root, value.libraryDirectory, 'libaio.so.1'))
      ]);
    }
  } catch {
    throw new Error('QUICK_START_MYSQL_INSTALLATION_MISSING');
  }
}

async function prepareComponent(
  components: string,
  name: string,
  url: string,
  digest: string,
  extract: (archive: string, target: string) => Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  const target = join(components, name);
  const marker = join(target, '.mar-installed');
  try {
    const existing = await readFile(marker, 'utf8');
    if (existing !== `${digest}\n`) throw new Error('QUICK_START_COMPONENT_INCOMPLETE');
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = await mkdtemp(join(components, '.download-'));
  let created = false;
  let retain = false;
  try {
    const archive = join(temporary, 'archive');
    await downloadPinnedFile(url, digest, archive, signal);
    try {
      await mkdir(target, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new Error('QUICK_START_COMPONENT_INCOMPLETE');
      throw error;
    }
    await extract(archive, target);
    await writeFile(marker, `${digest}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    retain = isReclaimFailure(error);
    if (created && !retain) await rm(target, { recursive: true, force: true });
    throw error;
  } finally {
    if (!retain) await rm(temporary, { recursive: true, force: true });
  }
}

function isReclaimFailure(error: unknown): boolean {
  return error instanceof Error && error.message === 'QUICK_START_NODE_RECLAIM_FAILED';
}
