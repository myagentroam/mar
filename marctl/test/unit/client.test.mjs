import assert from 'node:assert/strict';
import test from 'node:test';
import { MarctlClient } from '../../src/client.mjs';

function response(payload, { ok = true } = {}) {
  return {
    ok,
    async json() {
      return payload;
    }
  };
}

test('calls the marctl HTTP API with bearer authentication and bounded request bodies', async () => {
  const requests = [];
  const client = new MarctlClient({
    serverUrl: 'https://server.test',
    key: 'do-not-print',
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      if (requests.length === 1)
        return response({ nodes: [{ id: 'node-1', connected: true, platform: 'linux' }] });
      if (requests.length === 2) return response({ terminalId: 'terminal-1' });
      if (requests.length === 3) return response({ ticket: 'ticket-value' });
      return response(undefined);
    }
  });

  assert.deepEqual(await client.listNodes(), [
    { id: 'node-1', connected: true, platform: 'linux' }
  ]);
  assert.equal(
    await client.createTerminal({
      nodeId: 'node-1',
      rows: 24,
      cols: 80,
      command: 'echo hello && date'
    }),
    'terminal-1'
  );
  assert.equal(
    await client.createAttachTicket({ nodeId: 'node-1', terminalId: 'terminal-1' }),
    'ticket-value'
  );
  await client.deleteTerminal({ nodeId: 'node-1', terminalId: 'terminal-1' });

  assert.equal(requests[0].url, 'https://server.test/api/marctl/nodes');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer do-not-print');
  assert.ok(requests.every(({ options }) => options.signal instanceof AbortSignal));
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    nodeId: 'node-1',
    rows: 24,
    cols: 80,
    command: 'echo hello && date'
  });
  assert.deepEqual(JSON.parse(requests[2].options.body), { nodeId: 'node-1' });
  assert.deepEqual(JSON.parse(requests[3].options.body), { nodeId: 'node-1' });
});

test('requests the direct manifest and opens the management live channel', async () => {
  const requests = [];
  const client = new MarctlClient({
    serverUrl: 'https://server.test',
    key: 'secret-key',
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return response({
        manifest: {
          nodeGeneration: 'generation-1',
          terminalDirect: { apiVersion: 1, transport: true }
        }
      });
    }
  });

  assert.deepEqual(await client.getTerminalManifest('node/1'), {
    nodeGeneration: 'generation-1',
    terminalDirect: { apiVersion: 1, transport: true }
  });
  assert.equal(requests[0].url, 'https://server.test/api/marctl/nodes/node%2F1/manifest');

  class FakeWebSocket {
    constructor(url, options) {
      this.url = url;
      this.options = options;
    }
  }
  const socket = client.openWorkbenchWebSocket(FakeWebSocket);
  assert.equal(socket.url, 'wss://server.test/api/marctl/live');
  assert.equal(socket.options.headers.Authorization, 'Bearer secret-key');
});

test('returns the Server binary-mode handshake instead of assuming a pipe terminal', async () => {
  for (const binary of [true, false]) {
    const client = new MarctlClient({
      serverUrl: 'https://server.test',
      key: 'secret-key',
      fetchImpl: async () =>
        response({ terminalId: 'terminal-1', ...(binary ? { binary: true } : {}) })
    });
    assert.deepEqual(
      await client.createTerminal({
        nodeId: 'node-1',
        rows: 24,
        cols: 80,
        command: 'node -e "test"',
        binary: true
      }),
      { terminalId: 'terminal-1', binary }
    );
  }
});

test('does not expose response bodies or credentials in request failures', async () => {
  const client = new MarctlClient({
    serverUrl: 'https://server.test',
    key: 'secret-key',
    fetchImpl: async () => response({ detail: 'secret-key' }, { ok: false })
  });
  await assert.rejects(client.listNodes(), (error) => {
    assert.equal(error.message, 'The marctl server rejected the request.');
    assert.equal(error.message.includes('secret-key'), false);
    return true;
  });
});

test('bounds JSON response reading as part of connection setup', async () => {
  const client = new MarctlClient({
    serverUrl: 'https://server.test',
    key: 'secret-key',
    requestTimeoutMs: 10,
    fetchImpl: async (_url, options) => ({
      ok: true,
      json: () =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true
          });
        })
    })
  });
  await assert.rejects(client.listNodes(), /control request timeout/u);
});
