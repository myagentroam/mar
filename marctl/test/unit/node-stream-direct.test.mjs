import assert from 'node:assert/strict';
import test from 'node:test';
import nodeDataChannel from 'node-datachannel';
import { RTCPeerConnection } from 'node-datachannel/polyfill';
import { NodeConnection } from '@myagentroam/protocol/node-connection';
import { bindNodeDirectPath } from '@myagentroam/protocol/node-stream-path';
import { NODE_STREAM_WINDOW_BYTES } from '@myagentroam/protocol/node-stream-wire';

test(
  'shares one real ordered ICE DataChannel across binary streams',
  { timeout: 10_000 },
  async () => {
    const client = new RTCPeerConnection({ iceServers: [] });
    const node = new RTCPeerConnection({ iceServers: [] });
    const incoming = Promise.withResolvers();
    const releaseFile = Promise.withResolvers();
    const pendingCandidates = new Map([
      [client, []],
      [node, []]
    ]);
    function signal(from, to) {
      from.onicecandidate = ({ candidate }) => {
        if (!candidate) return;
        if (!to.remoteDescription) pendingCandidates.get(to).push(candidate);
        else void to.addIceCandidate(candidate).catch(incoming.reject);
      };
    }
    signal(client, node);
    signal(node, client);
    async function setRemote(peer, description) {
      await peer.setRemoteDescription(description);
      for (const candidate of pendingCandidates.get(peer).splice(0))
        await peer.addIceCandidate(candidate);
    }
    const used = new Set();
    node.ondatachannel = ({ channel }) => {
      incoming.resolve(
        bindNodeDirectPath({
          carrier: carrier(channel),
          maxStreams: 4,
          async accept({ kind, grant }) {
            if (!['file', 'terminal'].includes(kind) || grant !== kind || used.has(grant)) return;
            used.add(grant);
            return async (stream) => {
              if (kind === 'file') await releaseFile.promise;
              for await (const chunk of stream) await stream.write(chunk);
              await stream.endWrite();
            };
          }
        })
      );
    };
    const channel = client.createDataChannel('mar-node-stream', { ordered: true });
    const opened = Promise.withResolvers();
    channel.onopen = opened.resolve;
    channel.onclose = () => opened.reject(new Error('DataChannel closed before opening'));
    let connection;
    try {
      await client.setLocalDescription(await client.createOffer());
      await setRemote(node, client.localDescription);
      await node.setLocalDescription(await node.createAnswer());
      await setRemote(client, node.localDescription);
      const [remotePath] = await Promise.all([incoming.promise, opened.promise]);
      const localPath = bindNodeDirectPath({ carrier: carrier(channel), maxStreams: 4 });
      connection = new NodeConnection({ direct: async () => localPath });
      const file = await connection.openStream({ kind: 'file', grant: 'file' });
      const source = Buffer.alloc(NODE_STREAM_WINDOW_BYTES * 2 + 3, 0xba);
      let uploaded = false;
      const upload = file.write(source).then(async () => {
        await file.endWrite();
        uploaded = true;
      });
      void upload.catch(() => {});
      // The file's read window stays exhausted until the interactive stream finishes.
      const terminal = await connection.openStream({ kind: 'terminal', grant: 'terminal' });
      assert.notEqual(terminal.id, file.id);
      await terminal.write(Buffer.from('hello'));
      await terminal.endWrite();
      assert.equal((await collect(terminal)).toString(), 'hello');
      assert.equal(uploaded, false);
      await assert.rejects(connection.openStream({ kind: 'terminal', grant: 'terminal' }), {
        code: 'RESOURCE_DENIED'
      });
      releaseFile.resolve();
      assert.deepEqual(await collect(file), source);
      await upload;
      remotePath.close();
    } finally {
      releaseFile.resolve();
      connection?.close();
      client.close();
      node.close();
      nodeDataChannel.cleanup();
    }
  }
);

function carrier(channel) {
  channel.binaryType = 'arraybuffer';
  return {
    async send(bytes) {
      channel.send(bytes);
    },
    close: () => channel.close(),
    onMessage: (receive) => {
      channel.onmessage = ({ data }) => receive(data);
    },
    onClose: (receive) => {
      channel.onclose = receive;
    }
  };
}

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
