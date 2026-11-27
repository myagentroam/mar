import assert from 'node:assert/strict';
import test from 'node:test';
import { NodeStreamError } from '@myagentroam/protocol/node-stream';
import { openDirectTerminalStream } from '../../src/direct-terminal-stream.mjs';
import { DirectFallbackError, DirectRejectedError } from '../../src/direct-errors.mjs';

const grant = { directSessionId: 'stream-1', grant: 'granted-1' };

function fixture(prepare, dispatch) {
  const sent = [];
  const open = [];
  const listeners = new Set();
  const controller = new AbortController();
  const options = {
    live: {
      request: prepare,
      send(message) {
        sent.push(message);
        return true;
      },
      onControl(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      }
    },
    path: {
      closed: false,
      openStream(input, signal) {
        open.push(input);
        return dispatch(signal);
      }
    },
    request: { terminalId: 'terminal-1' },
    signal: controller.signal,
    nodeId: 'node-1',
    nodeGeneration: 'generation-1',
    transportSessionId: 'peer-1',
    timeoutMs: 1_000,
    heartbeatMs: 10_000
  };
  return { run: () => openDirectTerminalStream(options), sent, open, listeners, controller };
}

test('retains the pre-OPEN fallback boundary and does not convert admission or stream errors into fallback', async () => {
  const unavailable = fixture(() => {
    throw new DirectFallbackError();
  });
  assert.equal(await unavailable.run(), undefined);
  assert.deepEqual(unavailable.open, []);

  const rejected = new DirectRejectedError('TERMINAL_NOT_AUTHORIZED');
  const denied = fixture(async () => {
    throw rejected;
  });
  await assert.rejects(denied.run(), (error) => error === rejected);
  assert.deepEqual(denied.open, []);

  const disconnected = new NodeStreamError('NODE_STREAM_DISCONNECTED');
  const dispatched = fixture(
    async () => grant,
    async () => {
      throw disconnected;
    }
  );
  await assert.rejects(dispatched.run(), (error) => error === disconnected);
  assert.deepEqual(dispatched.open, [{ kind: 'terminal', grant: grant.grant }]);
  assert.deepEqual(dispatched.sent, [
    { type: 'terminal.direct.cancel', directSessionId: grant.directSessionId }
  ]);
  assert.equal(dispatched.listeners.size, 0);
});

test('cancels a Direct grant returned after the caller has already left', async () => {
  const ready = Promise.withResolvers();
  const f = fixture(() => ready.promise);
  const pending = f.run();
  f.controller.abort();
  await assert.rejects(pending, { code: 'DIRECT_RACE_CANCELLED' });
  ready.resolve(grant);
  await ready.promise;
  assert.deepEqual(f.open, []);
  assert.deepEqual(f.sent, [
    { type: 'terminal.direct.cancel', directSessionId: grant.directSessionId }
  ]);
});
