import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunAttachmentService } from '../../src/service/run-attachment-service.js';
import { SessionIdentityService } from '../../src/session/session-identity-service.js';

const directories: string[] = [];
const services: RunAttachmentService[] = [];
const file = { name: 'notes.txt', mime: 'text/plain', dataBase64: 'aGVsbG8=' };

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), 'mar-session-attachments-'));
  directories.push(workspace);
  let busy = false;
  const service = new RunAttachmentService(
    () => [],
    () => busy,
    () => join(workspace, 'node-data', 'temp-files')
  );
  services.push(service);
  return {
    workspace,
    service,
    setBusy: (value: boolean) => {
      busy = value;
    }
  };
}

afterEach(async () => {
  for (const service of services.splice(0)) service.dispose();
  vi.useRealTimers();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('Session attachment retention', () => {
  it('preserves earlier batches when subsequent persistence fails', async () => {
    const { workspace, service } = await fixture();
    const [path] = await service.persistFiles('workspace-id', 'run-opencode-images', [file]);
    service.retainSessionFiles('session', 'run-opencode-images');
    await expect(
      service.persistFiles('workspace-id', 'run-opencode-images', [
        file,
        { ...file, name: `${'x'.repeat(300)}.txt` }
      ])
    ).rejects.toThrow();
    expect(await readFile(path!, 'utf8')).toBe('hello');
    expect(service.fileResource('workspace-id', service.resourcePath(path!))).toBe(path);
    expect(await readdir(join(workspace, 'node-data', 'temp-files'))).toHaveLength(1);
    await service.releaseSession('session');
    expect(await readdir(join(workspace, 'node-data', 'temp-files'))).toEqual([]);
  });
  it('retains and releases every batch persisted under the same Run storage key', async () => {
    const { workspace, service } = await fixture();
    const first = await service.persistFiles('workspace-id', 'run-opencode-images', [file]);
    service.retainSessionFiles('session', 'run-opencode-images');
    const second = await service.persistFiles('workspace-id', 'run-opencode-images', [file]);
    service.retainSessionFiles('session', 'run-opencode-images');
    for (const path of [...first, ...second])
      expect(service.fileResource('workspace-id', service.resourcePath(path))).toBe(path);
    await service.releaseSession('session');
    for (const path of [...first, ...second]) {
      expect(service.fileResource('workspace-id', service.resourcePath(path))).toBeUndefined();
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(await readdir(join(workspace, 'node-data', 'temp-files'))).toEqual([]);
  });
  it('isolates same-name inline files and removes their resource indexes on release', async () => {
    const { workspace, service } = await fixture();
    const paths = await service.persistFiles('workspace-id', 'input', [
      file,
      { ...file, dataBase64: 'd29ybGQ=' }
    ]);
    expect(paths[0]).not.toBe(paths[1]);
    expect(await Promise.all(paths.map((path) => readFile(path, 'utf8')))).toEqual([
      'hello',
      'world'
    ]);
    expect(paths.every((path) => path.startsWith(join(workspace, 'node-data', 'temp-files')))).toBe(
      true
    );
    const resources = paths.map((path) => service.resourcePath(path));
    expect(service.fileResource('workspace-id', resources[0]!)).toBe(paths[0]);
    expect(service.fileResource('other', resources[0]!)).toBeUndefined();
    service.retainSessionFiles('session', 'input');
    await service.releaseSession('session');
    expect(service.fileResource('workspace-id', resources[0]!)).toBeUndefined();
    expect(await readdir(join(workspace, 'node-data', 'temp-files'))).toEqual([]);
  });
  it('retains accepted files after execution cleanup and removes them after 30 idle minutes', async () => {
    vi.useFakeTimers();
    const { workspace, service } = await fixture();
    const [path] = await service.persistFiles(workspace, 'input', [file]);
    service.retainSessionFiles('session', 'input');
    service.cleanup('input');
    service.refreshSession('session');
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect(await readFile(path!, 'utf8')).toBe('hello');
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(async () => {
      await expect(readFile(path!)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('protects queued and running work, then renews all retained files on a new accepted message', async () => {
    vi.useFakeTimers();
    const { workspace, service, setBusy } = await fixture();
    const [path] = await service.persistFiles(workspace, 'input', [file]);
    service.retainSessionFiles('session', 'input');
    setBusy(true);
    service.refreshSession('session');
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(await readFile(path!, 'utf8')).toBe('hello');
    setBusy(false);
    service.refreshSession('session');
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    const release = service.protectSession('session');
    service.acceptSessionInput('session');
    release();
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect(await readFile(path!, 'utf8')).toBe('hello');
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(async () => {
      await expect(readFile(path!)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('protects asynchronous preparation but restores the original deadline when it fails', async () => {
    vi.useFakeTimers();
    const { workspace, service } = await fixture();
    const [path] = await service.persistFiles(workspace, 'input', [file]);
    service.retainSessionFiles('session', 'input');
    service.refreshSession('session');
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    const release = service.protectSession('session');
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(await readFile(path!, 'utf8')).toBe('hello');
    release();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(async () => {
      await expect(readFile(path!)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('migrates session and execution ownership without changing paths and isolates discarded queue inputs', async () => {
    vi.useFakeTimers();
    const { workspace, service } = await fixture();
    const [oldPath] = await service.persistFiles(workspace, 'old-input', [file]);
    service.retainSessionFiles('bootstrap', 'old-input');
    service.move('old-input', 'execution');
    service.migrateSession('bootstrap', 'native');
    service.cleanup('execution');
    const [queuedPath] = await service.persistFiles(workspace, 'queued', [file]);
    service.retainSessionFiles('native', 'queued');
    await service.discardFiles('queued');
    await vi.advanceTimersByTimeAsync(1);
    expect(await readFile(oldPath!, 'utf8')).toBe('hello');
    await vi.waitFor(async () => {
      await expect(readFile(queuedPath!)).rejects.toMatchObject({
        code: 'ENOENT'
      });
    });
    await service.releaseSession('native');
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(async () => {
      await expect(readFile(oldPath!)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('rejects late preparation after stop and removes directories created across the stop boundary', async () => {
    const { workspace, service } = await fixture();
    const writing = service.persistFiles(workspace, 'late', [file]);
    service.dispose();
    await expect(writing).rejects.toThrow('NODE_STOPPED');
    expect(service.state.runFileDirectories.size).toBe(0);
    expect(service.state.sessionRetentions.size).toBe(0);
    expect(await readdir(join(workspace, 'node-data', 'temp-files'))).toEqual([]);
    expect(() => service.protectSession('late')).toThrow('NODE_STOPPED');
    expect(() => service.retainSessionFiles('late', 'late')).toThrow('NODE_STOPPED');
  });

  it('reclaims accepted bootstrap attachments when native Session startup is rejected', async () => {
    const { workspace, service } = await fixture();
    const [path] = await service.persistFiles(workspace, 'bootstrap-input', [file]);
    service.retainSessionFiles('bootstrap', 'bootstrap-input');
    service.move('bootstrap-input', 'execution');
    const removeAgentSession = vi.fn();
    const releaseAttachments = vi.fn((id: string) => {
      void service.releaseSession(id);
    });
    const identity = new SessionIdentityService({
      runtime: {
        removeAgentSession,
        getAgentSession: () => ({ id: 'bootstrap' }),
        listRunsForSession: () => []
      } as never,
      releaseAttachments
    } as never);
    identity.markBootstrap('bootstrap');
    const wait = expect(identity.wait('bootstrap')).rejects.toThrow('SESSION_START_FAILED');
    identity.reject('bootstrap', 'SESSION_START_FAILED');
    await wait;
    expect(releaseAttachments).toHaveBeenCalledWith('bootstrap');
    expect(removeAgentSession).toHaveBeenCalledWith('bootstrap');
    expect(service.state.sessionRetentions.size).toBe(0);
    await vi.waitFor(async () => {
      await expect(readFile(path!)).rejects.toMatchObject({ code: 'ENOENT' });
    });
    identity.dispose();
  });

  it('keeps sessions isolated and does not resurrect expired files', async () => {
    vi.useFakeTimers();
    const { workspace, service } = await fixture();
    const [first] = await service.persistFiles(workspace, 'first', [file]);
    const [second] = await service.persistFiles(workspace, 'second', [file]);
    service.retainSessionFiles('one', 'first');
    service.retainSessionFiles('two', 'second');
    const release = service.protectSession('two');
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await vi.waitFor(async () => {
      await expect(readFile(first!)).rejects.toMatchObject({ code: 'ENOENT' });
    });
    expect(await readFile(second!, 'utf8')).toBe('hello');
    service.acceptSessionInput('one');
    expect(service.state.runFileDirectories.has('first')).toBe(false);
    release();
  });
});
