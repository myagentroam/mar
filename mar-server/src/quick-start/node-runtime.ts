import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { resolveQuickStartNetwork, type QuickStartConfig } from './config.js';
import { serverNodeEntrypoint } from './node-dependency.js';

interface Bootstrap {
  issue(previousToken?: string): Promise<{ token: string }>;
  online(nodeId: string): boolean;
}

/** Reads only the complete managed Node identity from Quick Start's private Node data. */
export async function readQuickStartLocalNodeId(root: string): Promise<string | undefined> {
  let serialized: string;
  try {
    serialized = await readFile(join(root, 'node-data', 'node.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw Object.assign(new Error('QUICK_START_NODE_CONFIG_READ_FAILED'), {
      code: 'QUICK_START_NODE_CONFIG_READ_FAILED'
    });
  }

  let config: unknown;
  try {
    config = JSON.parse(serialized);
  } catch {
    throw Object.assign(new Error('QUICK_START_NODE_CONFIG_INVALID'), {
      code: 'QUICK_START_NODE_CONFIG_INVALID'
    });
  }
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return undefined;

  const record = config as Record<string, unknown>;
  const nodeId = record['nodeId'];
  const credential = record['credential'];
  if (
    typeof nodeId === 'string' &&
    nodeId.trim().length > 0 &&
    typeof credential === 'string' &&
    credential.trim().length > 0
  )
    return nodeId;
  return undefined;
}

/** Owns one Supervisor. Credentials remain in the existing Node configuration. */
export async function startLocalNode(
  root: string,
  config: QuickStartConfig,
  bootstrap: Bootstrap,
  stopTimeoutMs = 45_000,
  ownedExitTimeoutMs = 30_000,
  nodeDependency: typeof serverNodeEntrypoint = serverNodeEntrypoint
) {
  const entrypoint = await nodeDependency();
  const data = join(root, 'node-data');
  const workspace = join(root, 'workspace');
  const path = join(data, 'node.json');
  const { localServerUrl: serverUrl } = resolveQuickStartNetwork(config);
  await mkdir(data, { recursive: true, mode: 0o700 });
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  let created = false;
  try {
    await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const { token } = await bootstrap.issue();
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporary,
        JSON.stringify(
          {
            serverUrl,
            allowedRoots: [workspace],
            dataDirectory: data,
            conversationHosting: { enabled: false },
            registrationToken: token
          },
          null,
          2
        ) + '\n',
        { mode: 0o600, flag: 'wx' }
      );
      await link(temporary, path);
      created = true;
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  const nodeConfig: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (
    typeof nodeConfig !== 'object' ||
    nodeConfig === null ||
    Array.isArray(nodeConfig) ||
    typeof (nodeConfig as Record<string, unknown>)['serverUrl'] !== 'string'
  )
    throw Object.assign(new Error('QUICK_START_NODE_CONFIG_INVALID'), {
      code: 'QUICK_START_NODE_CONFIG_INVALID'
    });
  const record = nodeConfig as Record<string, unknown>;
  const nonempty = (value: unknown): value is string =>
    typeof value === 'string' && value.trim().length > 0;
  const hasIdentity = nonempty(record['nodeId']) && nonempty(record['credential']);
  if (!hasIdentity && (record['nodeId'] !== undefined || record['credential'] !== undefined))
    throw Object.assign(new Error('QUICK_START_NODE_CONFIG_INVALID'), {
      code: 'QUICK_START_NODE_CONFIG_INVALID'
    });
  if (!hasIdentity && !nonempty(record['registrationToken']))
    throw Object.assign(new Error('QUICK_START_NODE_CONFIG_INVALID'), {
      code: 'QUICK_START_NODE_CONFIG_INVALID'
    });
  const token =
    !created && !hasIdentity
      ? (await bootstrap.issue(record['registrationToken'] as string)).token
      : undefined;
  if (
    record['serverUrl'] !== serverUrl ||
    (token !== undefined && token !== record['registrationToken'])
  ) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporary,
        `${JSON.stringify({ ...record, serverUrl, ...(token === undefined ? {} : { registrationToken: token }) }, null, 2)}\n`,
        {
          mode: 0o600,
          flag: 'wx'
        }
      );
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  const child = spawn(process.execPath, [entrypoint, 'supervise', '--config', path], {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: {
      ...process.env,
      MAR_QUICK_START_OWNER: '1'
    }
  });
  const ownedPids = new Set<number>();
  child.on('message', (message: unknown) => {
    if (typeof message !== 'object' || message === null) return;
    const value = message as Record<string, unknown>;
    if (!Number.isSafeInteger(value['pid']) || (value['pid'] as number) <= 1) return;
    if (value['type'] === 'node-quick-start-child') ownedPids.add(value['pid'] as number);
    if (value['type'] === 'node-quick-start-child-exited') ownedPids.delete(value['pid'] as number);
  });
  let exited = false;
  const exit = new Promise<number | null>((resolveExit) => {
    child.on('error', () => {
      if (child.pid === undefined) {
        exited = true;
        resolveExit(null);
      }
    });
    child.once('exit', (code) => {
      exited = true;
      resolveExit(code);
    });
  });
  let stopped: Promise<void> | undefined;
  return {
    exited: exit,
    async online(signal: Promise<void>): Promise<boolean> {
      const deadline = Date.now() + 60_000;
      while (!exited && Date.now() < deadline) {
        try {
          const node = JSON.parse(await readFile(path, 'utf8')) as {
            nodeId?: unknown;
            credential?: unknown;
          };
          if (
            typeof node.nodeId === 'string' &&
            typeof node.credential === 'string' &&
            bootstrap.online(node.nodeId)
          )
            return true;
        } catch {
          /* Registration has not completed. */
        }
        const interrupted = await Promise.race([
          new Promise<boolean>((resolveWait) => setTimeout(() => resolveWait(false), 250)),
          signal.then(() => true),
          exit.then(() => true)
        ]);
        if (interrupted) return false;
      }
      return false;
    },
    stop(): Promise<void> {
      return (stopped ??= (async () => {
        if (exited) {
          if (!(await waitForOwnedChildren(ownedPids, ownedExitTimeoutMs)))
            throw new Error('QUICK_START_NODE_RECLAIM_FAILED');
          throw new Error('QUICK_START_NODE_STOP_FAILED');
        }
        if (child.connected) child.send({ type: 'node-quick-start-stop' }, () => {});
        let timer: NodeJS.Timeout | undefined;
        const result = await Promise.race([
          exit,
          new Promise<'timeout'>((resolveTimeout) => {
            timer = setTimeout(() => resolveTimeout('timeout'), stopTimeoutMs);
            timer.unref();
          })
        ]);
        if (timer) clearTimeout(timer);
        if (result === 'timeout') {
          try {
            if (child.pid !== undefined) await reclaimTree(child.pid);
          } catch {
            throw new Error('QUICK_START_NODE_RECLAIM_FAILED');
          }
          let reapTimer: NodeJS.Timeout | undefined;
          const reaped = await Promise.race([
            exit.then(() => true),
            new Promise<false>((resolveTimeout) => {
              reapTimer = setTimeout(() => resolveTimeout(false), 10_000);
              reapTimer.unref();
            })
          ]);
          if (reapTimer) clearTimeout(reapTimer);
          if (!reaped) throw new Error('QUICK_START_NODE_RECLAIM_FAILED');
          if (!(await waitForOwnedChildren(ownedPids, ownedExitTimeoutMs)))
            throw new Error('QUICK_START_NODE_RECLAIM_FAILED');
          throw new Error('QUICK_START_NODE_STOP_TIMEOUT');
        }
        if (!(await waitForOwnedChildren(ownedPids, ownedExitTimeoutMs)))
          throw new Error('QUICK_START_NODE_RECLAIM_FAILED');
        if (result !== 0) throw new Error('QUICK_START_NODE_STOP_FAILED');
      })());
    }
  };
}

async function waitForOwnedChildren(
  pids: ReadonlySet<number>,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let remaining = false;
    for (const pid of pids) {
      try {
        if (process.platform === 'linux') {
          const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
          if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ')) continue;
        } else process.kill(pid, 0);
        remaining = true;
      } catch (error) {
        if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? ''))
          return false;
      }
    }
    if (!remaining) return true;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100));
  }
  return false;
}

/** Emergency-only reclamation: inspect only descendants of our Supervisor. */
async function reclaimTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await promisify(execFile)('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  if (process.platform !== 'linux') throw new Error('QUICK_START_NODE_RECLAIM_UNSUPPORTED');
  const killDescendants = async (parent: number): Promise<void> => {
    let children: string;
    try {
      children = await readFile(`/proc/${parent}/task/${parent}/children`, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const text of children.trim().split(/\s+/u).filter(Boolean)) {
      const child = Number(text);
      if (!Number.isSafeInteger(child) || child <= 1) continue;
      await killDescendants(child);
      try {
        const stat = await readFile(`/proc/${child}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (Number(fields[1]) === parent) process.kill(child, 'SIGKILL');
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
          (error as NodeJS.ErrnoException).code !== 'ESRCH'
        )
          throw error;
      }
    }
  };
  await killDescendants(pid);
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}
