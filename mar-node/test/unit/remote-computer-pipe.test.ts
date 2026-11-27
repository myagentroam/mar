import { decodeByteFrame } from '@myagentroam/protocol';
import { describe, expect, it, vi } from 'vitest';
import { RemoteComputerPipe } from '../../src/computer-use/remote-pipe.js';
import type { ComputerUseBinding } from '../../src/computer-use/provider.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPp8AAAAASUVORK5CYII=',
  'base64'
);

function fixture(call: ComputerUseBinding['call']) {
  const release = vi.fn(async () => undefined);
  const bind = vi.fn(async () => ({ call, wait: vi.fn(), close: vi.fn() }));
  const pipe = new RemoteComputerPipe(bind, release);
  const output: ReturnType<typeof decodeByteFrame>[] = [];
  pipe.onData((bytes) => {
    expect(bytes.readUInt32BE()).toBe(bytes.length - 4);
    output.push(decodeByteFrame(bytes.subarray(4)));
  });
  const exit = new Promise<number>((resolve) => pipe.onExit(resolve));
  return { bind, release, pipe, output, exit };
}

describe('remote Computer Use pipe', () => {
  it('serializes coalesced and split JSONL and returns PNGs as opaque bytes before EOF', async () => {
    const call = vi.fn<ComputerUseBinding['call']>().mockImplementation(async ({ code }) => ({
      status: 'COMPLETED',
      taskId: 'task',
      outcome: 'SUCCEEDED',
      observationId: `observed:${code}`,
      runtimeGeneration: 1,
      logs: [code],
      images: [{ mimeType: 'image/png', dataBase64: png.toString('base64') }]
    }));
    const f = fixture(call);
    f.pipe.write(Buffer.from('{"code":"first"}\n{"co'));
    f.pipe.write(Buffer.from('de":"second","basedOnObservationId":"observed:first"}\n'));
    f.pipe.end();
    await expect(f.exit).resolves.toBe(0);
    expect(f.bind).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
    expect(call.mock.calls.map(([input]) => input)).toEqual([
      { code: 'first', timeoutMs: 30_000 },
      { code: 'second', basedOnObservationId: 'observed:first', timeoutMs: 30_000 }
    ]);
    expect(f.output.map(({ metadata }) => metadata.type)).toEqual([
      'result',
      'report',
      'image',
      'png',
      'complete',
      'result',
      'report',
      'image',
      'png',
      'complete'
    ]);
    for (const frame of f.output.filter(({ metadata }) => metadata.type === 'png'))
      expect(Buffer.from(frame.payload)).toEqual(png);
  });

  it('cancels pending work, discards queued requests and releases the binding after disconnect', async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const call = vi.fn<ComputerUseBinding['call']>().mockImplementation(async (_input, signal) => {
      entered();
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true })
      );
      throw signal.reason;
    });
    const f = fixture(call);
    f.pipe.write(Buffer.from('{"code":"active"}\n{"code":"queued"}\n'));
    await started;
    await f.pipe.close();
    expect(call).toHaveBeenCalledOnce();
    expect(f.output).toEqual([]);
    expect(f.release).toHaveBeenCalledOnce();
  });

  it.each([
    { outcome: 'OUTCOME_UNKNOWN', cleanupFailed: undefined },
    { outcome: 'SUCCEEDED', cleanupFailed: true }
  ] as const)('ends the pipe after an unusable desktop result: %j', async (result) => {
    const call = vi.fn<ComputerUseBinding['call']>().mockResolvedValue({
      status: 'COMPLETED',
      taskId: 'task',
      outcome: result.outcome,
      ...(result.cleanupFailed ? { cleanupFailed: true } : {}),
      observationId: '',
      runtimeGeneration: 2,
      logs: []
    });
    const f = fixture(call);
    f.pipe.write(Buffer.from('{"code":"first"}\n{"code":"queued"}\n'));
    f.pipe.end();
    const code = await f.exit;
    expect(call).toHaveBeenCalledOnce();
    expect(code).toBe(1);
    expect(f.output.map(({ metadata }) => metadata.type)).toEqual(['result', 'report', 'complete']);
    expect(f.output[0]!.metadata.outcome).toBe(result.outcome);
    expect(f.output[0]!.metadata.cleanupFailed).toBe(result.cleanupFailed);
    expect(f.release).toHaveBeenCalledOnce();
  });

  it('does not dispatch a truncated record at EOF', async () => {
    const call = vi.fn<ComputerUseBinding['call']>();
    const f = fixture(call);
    f.pipe.write(Buffer.from('{"code":"uncommitted"}'));
    expect(() => f.pipe.end()).toThrow('COMPUTER_REQUEST_INVALID');
    await f.pipe.close();
    expect(f.bind).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });
});
