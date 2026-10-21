import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeDatabase } from '../../src/database.js';
import { nodeDatabasePath } from '../../src/config.js';
import {
  acquireNodeProcessLock,
  NODE_OWNER_CONFLICT_EXIT_CODE
} from '../../src/node-process-lock.js';

const directories: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = once(child, 'close');
      if (process.platform === 'win32' && child.pid !== undefined) {
        try {
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true
          });
          await once(killer, 'close');
        } catch {
          child.kill('SIGKILL');
        }
      } else if (process.platform !== 'win32' && child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      } else {
        child.kill('SIGKILL');
      }
      await closed;
    })
  );
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mar-node-owner-'));
  directories.push(root);
  return root;
}
function launch(args: string[], environment: NodeJS.ProcessEnv = process.env): ChildProcess {
  const loader = createRequire(import.meta.url).resolve('tsx');
  const inheritedOptions = environment['NODE_OPTIONS']?.trim() ?? '';
  const child = spawn(process.execPath, ['--import', 'tsx', ...args], {
    cwd: resolve('..'),
    detached: process.platform !== 'win32',
    env: { ...environment, NODE_OPTIONS: `${inheritedOptions} --import ${loader}`.trim() },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  children.push(child);
  return child;
}
async function exit(child: ChildProcess): Promise<{ code: number | null; output: string }> {
  let output = '';
  const append = (chunk: unknown) => {
    output = (output + String(chunk)).slice(-8000);
  };
  child.stdout!.on('data', append);
  child.stderr!.on('data', append);
  child.once('error', (error) => append(error.message));
  const [code] = await once(child, 'close');
  return { code, output };
}
async function isolatedEnvironment(root: string): Promise<NodeJS.ProcessEnv> {
  const home = join(root, 'home');
  const paths = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_DATA_HOME: join(home, '.local', 'share')
  };
  await Promise.all(Object.values(paths).map((path) => mkdir(path, { recursive: true })));
  return { ...process.env, ...paths };
}

describe('Node data directory ownership', () => {
  it('rejects directory aliases while leaving the independent business database writable', async () => {
    const root = await directory();
    const data = join(root, 'data');
    const release = await acquireNodeProcessLock(data);
    const alias = join(root, 'alias');
    await symlink(data, alias, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      await expect(acquireNodeProcessLock(alias)).rejects.toMatchObject({
        code: 'NODE_DATA_DIRECTORY_IN_USE'
      });
      const database = new NodeDatabase(join(data, 'business.sqlite'), 'owner-fixture');
      try {
        database.saveWorkspace({ path: root, kind: 'DIRECTORY', gitSummary: null });
        expect(database.listWorkspaces()).toHaveLength(1);
      } finally {
        database.close();
      }
      const other = await acquireNodeProcessLock(join(root, 'independent'));
      other();
    } finally {
      release();
    }
    release();
    const next = await acquireNodeProcessLock(alias);
    next();
  });

  it('releases operating-system ownership after the owner process is killed', async () => {
    const root = await directory();
    const module = pathToFileURL(resolve('src/node-process-lock.ts')).href;
    const source = `import {acquireNodeProcessLock} from ${JSON.stringify(module)}; await acquireNodeProcessLock(${JSON.stringify(root)}); process.stdout.write('ready'); setInterval(()=>{},1000);`;
    const child = launch(['--input-type=module', '-e', source]);
    expect(String((await once(child.stdout!, 'data'))[0])).toBe('ready');
    await expect(acquireNodeProcessLock(root)).rejects.toMatchObject({
      code: 'NODE_DATA_DIRECTORY_IN_USE'
    });
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    const release = await acquireNodeProcessLock(root);
    release();
  });

  it('preserves filesystem errors rather than reporting an ownership conflict', async () => {
    const root = await directory();
    const file = join(root, 'not-a-directory');
    await writeFile(file, 'fixture');
    await expect(acquireNodeProcessLock(file)).rejects.not.toMatchObject({
      code: 'NODE_DATA_DIRECTORY_IN_USE'
    });
  });

  it.each(['run', 'supervise'])(
    'rejects duplicate CLI %s before terminal recovery or configuration writes',
    async (command) => {
      const root = await directory();
      const data = join(root, 'data');
      const env = await isolatedEnvironment(root);
      const release = await acquireNodeProcessLock(data);
      const database = new NodeDatabase(
        nodeDatabasePath({
          serverUrl: 'http://127.0.0.1:1',
          allowedRoots: [root],
          dataDirectory: data
        }),
        'owner-fixture'
      );
      database.saveTerminalSession({
        id: 'active-terminal',
        workspaceId: null,
        profileId: 'shell',
        state: 'RUNNING',
        exitCode: null,
        rows: 24,
        cols: 80,
        latestSequence: 0,
        createdAt: 1,
        updatedAt: 1
      });
      const config = join(root, 'node.json');
      const content = JSON.stringify({
        serverUrl: 'http://127.0.0.1:1',
        dataDirectory: data,
        allowedRoots: [root],
        nodeId: 'test-node',
        credential: 'test-credential'
      });
      await writeFile(config, content);
      try {
        const result = await exit(
          launch([resolve('src/main.ts'), command, '--config', config], env)
        );
        expect(result.code, result.output).toBe(NODE_OWNER_CONFLICT_EXIT_CODE);
        expect(result.output).toContain('NODE_DATA_DIRECTORY_IN_USE');
        expect(result.output.match(/NODE_DATA_DIRECTORY_IN_USE/gu)).toHaveLength(1);
        expect(database.getTerminalSession('active-terminal')?.state).toBe('RUNNING');
        expect(await readFile(config, 'utf8')).toBe(content);
      } finally {
        database.close();
        release();
      }
    },
    15_000
  );
});
