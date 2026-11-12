import { expect, it, vi } from 'vitest';
import { startDesktopTopologyNotifications } from '../../src/remote-desktop/desktop-topology-notifications.js';

function options(script: string) {
  return {
    binary: process.execPath,
    args: ['-e', script],
    invalidate: vi.fn(),
    unavailable: vi.fn()
  };
}

it('receives split native display notifications and owns the observer until stopped', async () => {
  const input = options(`
    process.stdout.write('rea');
    setImmediate(() => process.stdout.write('dy\\ninvalid'));
    setImmediate(() => process.stdout.write('ated\\ninvalidated\\n'));
    setInterval(() => {}, 1000);
  `);
  const source = await startDesktopTopologyNotifications(input, AbortSignal.timeout(5_000));
  try {
    await vi.waitFor(() => expect(input.invalidate).toHaveBeenCalledTimes(2));
    expect(source.isAvailable()).toBe(true);
  } finally {
    await Promise.all([source.stop(), source.stop()]);
  }
  expect(source.isAvailable()).toBe(false);
  expect(input.unavailable).not.toHaveBeenCalled();
});

it.each(['garbage\n', 'x'.repeat(4097)])(
  'invalidates discovery on malformed or unbounded notification output',
  async (output) => {
    const input = options(`
      console.log('ready');
      setImmediate(() => process.stdout.write(${JSON.stringify(output)}));
      setInterval(() => {}, 1000);
    `);
    const source = await startDesktopTopologyNotifications(input, AbortSignal.timeout(5_000));
    try {
      await vi.waitFor(() => expect(input.unavailable).toHaveBeenCalledOnce());
      expect(source.isAvailable()).toBe(false);
    } finally {
      await source.stop();
    }
  }
);

it('rejects an observer that exits without establishing its event subscription', async () => {
  const input = options('');
  await expect(
    startDesktopTopologyNotifications(input, AbortSignal.timeout(5_000))
  ).rejects.toMatchObject({ code: 'DESKTOP_TOPOLOGY_UNAVAILABLE' });
  expect(input.unavailable).toHaveBeenCalledOnce();
});

it('does not start a native process for an already cancelled discovery', async () => {
  const input = options('');
  await expect(startDesktopTopologyNotifications(input, AbortSignal.abort())).rejects.toMatchObject(
    { code: 'DESKTOP_SETUP_CANCELLED' }
  );
  expect(input.unavailable).not.toHaveBeenCalled();
});
