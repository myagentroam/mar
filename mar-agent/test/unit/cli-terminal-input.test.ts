import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline/promises';
import { expect, it } from 'vitest';
import { TerminalInput, TerminalInputClosed } from '../../src/cli/terminal-input.js';

it('serializes whole requests and retains lines received in one input chunk', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const terminal = new TerminalInput(() => createInterface({ input, output, terminal: false }));
  try {
    const first = terminal.run(undefined, async (ask) => [
      await ask('first: '),
      await ask('second: ')
    ]);
    const second = terminal.run(undefined, (ask) => ask('third: '));
    await Promise.resolve();
    input.write('one\ntwo\nthree\n');
    await expect(first).resolves.toEqual(['one', 'two']);
    await expect(second).resolves.toBe('three');
  } finally {
    terminal.close();
    input.destroy();
    output.destroy();
  }
});

it('cancels active and queued requests and continues after failures', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const terminal = new TerminalInput(() => createInterface({ input, output, terminal: false }));
  try {
    const active = new AbortController();
    const queued = new AbortController();
    const first = terminal.run(active.signal, (ask) => ask('first: '));
    const second = terminal.run(queued.signal, (ask) => ask('second: '));
    await Promise.resolve();
    queued.abort(new Error('queued cancelled'));
    active.abort(new Error('active cancelled'));
    await expect(first).rejects.toThrow('active cancelled');
    await expect(second).rejects.toThrow('queued cancelled');
    await expect(
      terminal.run(undefined, async () => {
        throw new Error('failed');
      })
    ).rejects.toThrow('failed');
    const next = terminal.run(undefined, (ask) => ask('next: '));
    await Promise.resolve();
    input.write('recovered\n');
    await expect(next).resolves.toBe('recovered');
  } finally {
    terminal.close();
    input.destroy();
    output.destroy();
  }
});

it('closes admission before lazy terminal creation, including an already queued first ask', async () => {
  let created = false;
  const terminal = new TerminalInput(() => {
    created = true;
    throw new Error('should not create terminal');
  });
  const queued = terminal.run(undefined, (ask) => ask('first: '));
  terminal.close();
  await expect(queued).rejects.toBeInstanceOf(TerminalInputClosed);
  await expect(terminal.run(undefined, (ask) => ask('later: '))).rejects.toBeInstanceOf(
    TerminalInputClosed
  );
  expect(created).toBe(false);
});

it('drains lines already received before EOF and rejects a later read', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const terminal = new TerminalInput(() => createInterface({ input, output, terminal: false }));
  try {
    const answers = terminal.run(undefined, async (ask) => [
      await ask('first: '),
      await ask('second: ')
    ]);
    await Promise.resolve();
    input.end('one\ntwo\n');
    await expect(answers).resolves.toEqual(['one', 'two']);
    await expect(terminal.run(undefined, (ask) => ask('later: '))).rejects.toBeInstanceOf(
      TerminalInputClosed
    );
  } finally {
    terminal.close();
    input.destroy();
    output.destroy();
  }
});
