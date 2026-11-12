import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { X11TopologySource } from '../../src/remote-desktop/x11-topology-source.js';

const directories: string[] = [];
const sources: X11TopologySource[] = [];
afterEach(async () => {
  await Promise.all(sources.splice(0).map((source) => source.stop().catch(() => {})));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

const snapshot = {
  type: 'snapshot',
  width: 800,
  height: 600,
  monitors: [
    {
      id: 1,
      name: 'screen',
      primary: true,
      x: 0,
      y: 0,
      width: 800,
      height: 600,
      mmWidth: 200,
      mmHeight: 150,
      outputs: [
        {
          id: 2,
          name: 'screen',
          x: 0,
          y: 0,
          width: 800,
          height: 600,
          rotation: 1,
          transform: [65536, 0, 0, 0, 65536, 0, 0, 0, 65536]
        }
      ]
    }
  ]
};

async function fixture(
  mode: 'normal' | 'malformed' | 'overflow' | 'stalled' | 'disconnect' | 'eof' | 'partial-eof'
) {
  const directory = await mkdtemp(join(tmpdir(), 'mar-xrandr-test-'));
  directories.push(directory);
  const executable = join(directory, 'topology');
  const pidFile = join(directory, 'pid');
  const script = `#!${process.execPath}
const fs = require('node:fs');
const snapshot = ${JSON.stringify(JSON.stringify(snapshot) + '\n')};
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const mode = ${JSON.stringify(mode)};
if (mode === 'malformed') process.stdout.write('{bad}\\n');
else if (mode !== 'stalled') process.stdout.write(snapshot.slice(0, 5), () => process.stdout.write(snapshot.slice(5)));
process.on('SIGUSR1', () => {
  if (mode === 'overflow') process.stdout.write('x'.repeat(262145));
  else if (mode === 'eof') process.stdout.end();
  else if (mode === 'partial-eof') process.stdout.end('{"type":"invalid');
  else process.stdout.write((mode === 'disconnect' ? '{"type":"invalidated","resetOutput":2}\\n' : '{"type":"invalidated"}\\n') + snapshot);
});
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
`;
  await writeFile(executable, script, { mode: 0o700 });
  return { binaryPath: executable, display: ':1', xAuthority: join(directory, 'auth'), pidFile };
}

describe.skipIf(process.platform !== 'linux')('X11 topology source owner', () => {
  it('orders invalidation before replacement snapshot and stops only its helper', async () => {
    const f = await fixture('normal');
    const events: string[] = [];
    const unavailable = vi.fn();
    const source = await X11TopologySource.start(
      {
        ...f,
        onInvalidated: () => events.push('invalidated'),
        onSnapshot: () => events.push('snapshot'),
        onUnavailable: unavailable
      },
      AbortSignal.timeout(5_000)
    );
    sources.push(source);
    process.kill(Number(await readFile(f.pidFile, 'utf8')), 'SIGUSR1');
    await vi.waitFor(() => expect(events).toEqual(['snapshot', 'invalidated', 'snapshot']));
    await source.stop();
    expect(unavailable).not.toHaveBeenCalled();
  });

  it('fails closed when initial native data is malformed', async () => {
    const f = await fixture('malformed');
    await expect(
      X11TopologySource.start(
        { ...f, onInvalidated: vi.fn(), onSnapshot: vi.fn(), onUnavailable: vi.fn() },
        AbortSignal.timeout(5_000)
      )
    ).rejects.toMatchObject({
      code: 'DESKTOP_TOPOLOGY_UNAVAILABLE',
      message: 'The native desktop topology is unavailable.'
    });
  });

  it('does not deliver a queued replacement after its owner stops during invalidation', async () => {
    const f = await fixture('normal');
    const onSnapshot = vi.fn();
    let source: X11TopologySource;
    const onInvalidated = vi.fn(() => {
      void source.stop();
    });
    source = await X11TopologySource.start(
      { ...f, onInvalidated, onSnapshot, onUnavailable: vi.fn() },
      AbortSignal.timeout(5_000)
    );
    sources.push(source);
    process.kill(Number(await readFile(f.pidFile, 'utf8')), 'SIGUSR1');
    await vi.waitFor(() => expect(onInvalidated).toHaveBeenCalledOnce());
    await source.stop();
    expect(onSnapshot).toHaveBeenCalledOnce();
  });

  it('preserves an output identity reset even if a replacement snapshot already arrived', async () => {
    const f = await fixture('disconnect');
    const onInvalidated = vi.fn();
    const source = await X11TopologySource.start(
      { ...f, onInvalidated, onSnapshot: vi.fn(), onUnavailable: vi.fn() },
      AbortSignal.timeout(5_000)
    );
    sources.push(source);
    process.kill(Number(await readFile(f.pidFile, 'utf8')), 'SIGUSR1');
    await vi.waitFor(() =>
      expect(onInvalidated).toHaveBeenCalledExactlyOnceWith({ resetOutput: 2 })
    );
  });

  it('invalidates availability once and stops the helper on oversized output', async () => {
    const f = await fixture('overflow');
    const unavailable = vi.fn();
    const source = await X11TopologySource.start(
      { ...f, onInvalidated: vi.fn(), onSnapshot: vi.fn(), onUnavailable: unavailable },
      AbortSignal.timeout(5_000)
    );
    sources.push(source);
    process.kill(Number(await readFile(f.pidFile, 'utf8')), 'SIGUSR1');
    await vi.waitFor(() => expect(unavailable).toHaveBeenCalledOnce());
    await source.stop();
    expect(unavailable).toHaveBeenCalledOnce();
  });

  it.each(['eof', 'partial-eof'] as const)(
    'fails once and reaps a live helper when the subscription ends with %s',
    async (mode) => {
      const f = await fixture(mode);
      const unavailable = vi.fn();
      const snapshots = vi.fn();
      const source = await X11TopologySource.start(
        { ...f, onInvalidated: vi.fn(), onSnapshot: snapshots, onUnavailable: unavailable },
        AbortSignal.timeout(5_000)
      );
      sources.push(source);
      const pid = Number(await readFile(f.pidFile, 'utf8'));
      process.kill(pid, 'SIGUSR1');
      await vi.waitFor(() => expect(unavailable).toHaveBeenCalledOnce());
      await source.stop();
      expect(unavailable).toHaveBeenCalledOnce();
      expect(snapshots).toHaveBeenCalledOnce();
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    }
  );

  it('cancels a stalled initial discovery without advertising availability', async () => {
    const f = await fixture('stalled');
    const onSnapshot = vi.fn();
    const onUnavailable = vi.fn();
    const controller = new AbortController();
    const pending = X11TopologySource.start(
      { ...f, onInvalidated: vi.fn(), onSnapshot, onUnavailable },
      controller.signal
    );
    await vi.waitFor(async () => expect(await readFile(f.pidFile, 'utf8')).toBeTruthy());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'DESKTOP_TOPOLOGY_UNAVAILABLE' });
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(onUnavailable).not.toHaveBeenCalled();
  });
});
