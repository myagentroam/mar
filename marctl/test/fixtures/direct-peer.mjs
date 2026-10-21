import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
const native = await import('node-datachannel');
const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
await new Promise((resolve) => server.once('listening', resolve));
const peers = [];
const channels = [];
server.on('connection', (socket) => {
  const peer = new native.PeerConnection(`fixture-${peers.length}`, { iceServers: [] });
  peers.push(peer);
  const send = (message) => {
    if (socket.readyState === 1) socket.send(JSON.stringify(message));
  };
  peer.onLocalDescription((sdp) =>
    send({
      type: 'direct.signal',
      directSessionId: 'transport-1',
      signal: {
        kind: 'ANSWER',
        sdp,
        fingerprint: sdp.match(/^a=fingerprint:(.*)\r?$/m)[1].trim()
      }
    })
  );
  peer.onLocalCandidate((candidate, mid) => {
    if (candidate.includes(' typ host'))
      send({
        type: 'direct.signal',
        directSessionId: 'transport-1',
        signal: { kind: 'CANDIDATE', candidate: { candidate, sdpMid: mid } }
      });
  });
  peer.onDataChannel((channel) => {
    channels.push(channel);
    if (!channel.getLabel().startsWith('mar-terminal-')) return;
    channel.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'OPEN') {
        assert.equal(message.grant, 'fixture-grant');
        channel.sendMessage(
          JSON.stringify({ type: 'ATTACHED', terminalId: 'terminal-1', afterSequence: 0 })
        );
        channel.sendMessage(
          JSON.stringify({
            type: 'output',
            terminalId: 'terminal-1',
            sequence: 1,
            data: 'handoff'
          })
        );
      } else if (message.type === 'input') {
        channel.sendMessage(
          JSON.stringify({
            type: 'output',
            terminalId: 'terminal-1',
            sequence: 2,
            data: message.data
          })
        );
      }
    });
  });
  socket.on('message', (raw) => {
    const message = JSON.parse(String(raw));
    if (message.type === 'resume')
      send({ type: 'workbench.ready', workbenchConnectionId: 'workbench-1' });
    if (message.type === 'direct.prepare')
      send({
        type: 'direct.prepared',
        requestId: message.requestId,
        directSessionId: 'transport-1',
        purpose: 'TRANSPORT'
      });
    if (message.type === 'direct.signal' && message.signal.kind === 'OFFER')
      peer.setRemoteDescription(message.signal.sdp, 'Offer');
    if (message.type === 'direct.signal' && message.signal.kind === 'CANDIDATE')
      peer.addRemoteCandidate(message.signal.candidate.candidate, message.signal.candidate.sdpMid);
    if (message.type === 'direct.connected')
      send({ type: 'direct.opened', directSessionId: 'transport-1' });
    if (message.type === 'terminal.direct.prepare')
      send({
        type: 'terminal.direct.prepared',
        requestId: message.requestId,
        directSessionId: 'terminal-direct-1',
        grant: 'fixture-grant'
      });
    if (message.type === 'direct.cancel')
      send({ type: 'direct.closed', directSessionId: 'transport-1' });
    if (message.type === 'terminal.direct.cancel')
      send({ type: 'terminal.direct.closed', directSessionId: 'terminal-direct-1' });
  });
});

process.send({ port: server.address().port });
process.on('message', async (message) => {
  if (message.type !== 'stop') return;
  for (const channel of channels) channel.close();
  for (const peer of peers) peer.close();
  for (const socket of server.clients) socket.terminate();
  await new Promise((resolve) => server.close(resolve));
  try {
    native.cleanup();
  } finally {
    process.exit(0);
  }
});
