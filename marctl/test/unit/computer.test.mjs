import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import {
  decodeTerminalMessage,
  encodeByteFrame,
  encodeTerminalMessage
} from '@myagentroam/protocol/byte-frame';
import { runComputer } from '../../src/computer.mjs';
import { main } from '../../src/cli.mjs';

const terminalId = 'desktop';

async function fixture(t, onInput, args = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'marctl-computer-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requests = [];
  const deletions = [];
  let output = '';
  let sequence = 0;
  const socket = Object.assign(new EventEmitter(), {
    readyState: 1,
    bufferedAmount: 0,
    close() {
      this.emit('close');
    },
    send(raw, callback) {
      const frame = decodeTerminalMessage(raw);
      callback?.();
      if (frame.type === 'eof') return emit({ type: 'exit', exitCode: 0 });
      assert.equal(frame.type, 'input');
      requests.push(JSON.parse(Buffer.from(frame.data).toString()));
      onInput(reply, () => this.emit('close'));
    }
  });
  const emit = (frame) =>
    socket.emit('message', encodeTerminalMessage({ ...frame, terminalId }), true);
  const reply = (metadata, bytes) => {
    const binary = encodeByteFrame(metadata, bytes);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(binary.length);
    const packet = Buffer.concat([size, binary]);
    // The inner length prefix and body need not share an outer Terminal frame.
    for (const data of [packet.subarray(0, 2), packet.subarray(2)])
      emit({ type: 'output', sequence: ++sequence, data });
  };
  const options = {
    client: {
      async listNodes() {
        return [{ id: 'linux', connected: true }];
      },
      async openComputer() {
        return { terminalId, ticket: 'ticket' };
      },
      openTerminalWebSocket() {
        queueMicrotask(() => emit({ type: 'attach', afterSequence: 0 }));
        return socket;
      },
      async deleteTerminal(args) {
        deletions.push(args);
      }
    },
    nodeId: 'linux',
    directory,
    stdin: Readable.from([args.input ?? '{"code":""}\n']),
    stdout: new Writable({
      write(chunk, _encoding, done) {
        output += chunk;
        done();
      }
    }),
    translate: (key) => key
  };
  let errorOutput = '';
  const run = args.cli
    ? main(['computer', 'linux', directory], {
        ...options,
        WebSocketClass: class {},
        env: {
          LANG: 'en_US.UTF-8',
          MAR_CTL_CONTEXT_REQUIRED: '1',
          MAR_CTL_SERVER_URL: 'http://localhost',
          MAR_CTL_USER_TOKEN: `marctl_user_fixture.${'x'.repeat(43)}`
        },
        stderr: new Writable({
          write(chunk, _encoding, done) {
            errorOutput += chunk;
            done();
          }
        })
      })
    : runComputer(options);
  return {
    directory,
    run,
    requests,
    deletions,
    output: () => output,
    errorOutput: () => errorOutput
  };
}

test('computer writes the binary PNG to disk and only its path to stdout', async (t) => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPp8AAAAASUVORK5CYII=',
    'base64'
  );
  const f = await fixture(t, (reply) => {
    const report = Buffer.from('{"logs":["ready"]}');
    reply({
      type: 'result',
      status: 'COMPLETED',
      outcome: 'SUCCEEDED',
      observationId: 'observed',
      reportBytes: report.length,
      imageCount: 1
    });
    reply({ type: 'report' }, report);
    reply({ type: 'image', index: 0, size: png.length });
    reply({ type: 'png' }, png);
    reply({ type: 'complete' });
  });
  assert.equal(await f.run, 0);
  const result = JSON.parse(f.output());
  assert.equal(result.observationId, 'observed');
  assert.deepEqual(result.logs, ['ready']);
  assert.equal(result.images.length, 1);
  assert.deepEqual(await readFile(result.images[0]), png);
  assert.deepEqual(f.requests, [{ code: '' }]);
});

test('computer reports a definitive request failure and publishes no success', async (t) => {
  const f = await fixture(t, (reply) =>
    reply({ type: 'error', code: 'COMPUTER_REQUEST_INVALID', message: 'Rejected' })
  );
  await assert.rejects(f.run, { code: 'COMPUTER_REQUEST_INVALID', message: 'Rejected' });
  assert.equal(f.output(), '');
  assert.deepEqual(await readdir(f.directory), []);
  assert.deepEqual(f.deletions, [{ nodeId: 'linux', terminalId }]);
});

test('computer never replays a request after a disconnect after dispatch', async (t) => {
  const f = await fixture(t, (_reply, disconnect) => disconnect());
  await assert.rejects(f.run, { code: 'OUTCOME_UNKNOWN' });
  assert.deepEqual(f.requests, [{ code: '' }]);
  assert.equal(f.output(), '');
  assert.deepEqual(f.deletions, [{ nodeId: 'linux', terminalId }]);
});

test('computer exits with an unknown outcome when the runtime reports uncertainty', async (t) => {
  const f = await fixture(
    t,
    (reply) => {
      const report = Buffer.from('{"logs":[],"message":"The runtime lost the result."}');
      reply({
        type: 'result',
        status: 'COMPLETED',
        outcome: 'OUTCOME_UNKNOWN',
        observationId: '',
        reportBytes: report.length,
        imageCount: 0
      });
      reply({ type: 'report' }, report);
      reply({ type: 'complete' });
    },
    { cli: true, input: '{"code":"first"}\n{"code":"next"}\n' }
  );
  assert.equal(await f.run, 6);
  assert.deepEqual(f.requests, [{ code: 'first' }]);
  assert.equal(f.output(), '');
  assert.match(f.errorOutput(), /\[OUTCOME_UNKNOWN\]/u);
  assert.deepEqual(f.deletions, [{ nodeId: 'linux', terminalId }]);
});

test('computer reports failed cleanup without treating the completed script as unknown', async (t) => {
  const f = await fixture(
    t,
    (reply) => {
      const report = Buffer.from('{"logs":[]}');
      reply({
        type: 'result',
        status: 'COMPLETED',
        outcome: 'SUCCEEDED',
        cleanupFailed: true,
        observationId: '',
        reportBytes: report.length,
        imageCount: 0
      });
      reply({ type: 'report' }, report);
      reply({ type: 'complete' });
    },
    { cli: true, input: '{"code":"first"}\n{"code":"next"}\n' }
  );
  assert.equal(await f.run, 1);
  assert.deepEqual(f.requests, [{ code: 'first' }]);
  assert.equal(f.output(), '');
  assert.match(f.errorOutput(), /\[COMPUTER_CLEANUP_FAILED\]/u);
  assert.deepEqual(f.deletions, [{ nodeId: 'linux', terminalId }]);
});
