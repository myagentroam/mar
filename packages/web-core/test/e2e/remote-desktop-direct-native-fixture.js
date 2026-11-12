import RFB from '@novnc/novnc';
import { createRemoteDesktopDirectClient } from '../../src/service/remote-desktop-direct-client';

// Real Chromium/noVNC and production Direct client; control-plane delivery is isolated by the test peer.
const messages = [];
const incoming = new Map();
const waiters = new Map();
const state = { firstframe: false, disconnected: null, ordered: false };
let rfb;
let handle;
let peer;
const transport = {
  transportSessionId: 'transport-1',
  nodeGeneration: 'generation-1',
  maxMessageBytes: 16384,
  waitChannel(id, signal) {
    const label = `mar-desktop-${id}`;
    if (incoming.has(label)) {
      const channel = incoming.get(label);
      incoming.delete(label);
      return Promise.resolve(channel);
    }
    return new Promise((resolve, reject) => {
      const abort = () => {
        waiters.delete(label);
        reject(new Error('cancelled'));
      };
      signal.addEventListener('abort', abort, { once: true });
      waiters.set(label, (channel) => {
        signal.removeEventListener('abort', abort);
        resolve(channel);
      });
      if (signal.aborted) abort();
    });
  },
  release() {}
};
const client = createRemoteDesktopDirectClient({
  acquire: () => transport,
  randomId: () => 'request-12345678',
  send: (message) => {
    messages.push(message);
    return true;
  }
});

window.desktopProbe = {
  state,
  async offer() {
    peer = new RTCPeerConnection({ iceServers: [] });
    peer.ondatachannel = (event) => {
      const channel = event.channel;
      state.ordered =
        channel.ordered && channel.maxRetransmits === null && channel.maxPacketLifeTime === null;
      const waiter = waiters.get(channel.label);
      if (waiter) {
        waiters.delete(channel.label);
        waiter(channel);
      } else incoming.set(channel.label, channel);
    };
    peer.createDataChannel('bootstrap');
    await peer.setLocalDescription(await peer.createOffer());
    if (peer.iceGatheringState !== 'complete')
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ICE timeout')), 8000);
        peer.onicegatheringstatechange = () => {
          if (peer.iceGatheringState === 'complete') {
            clearTimeout(timer);
            resolve();
          }
        };
      });
    return peer.localDescription.toJSON();
  },
  answer(value) {
    return peer.setRemoteDescription(value);
  },
  start(description = {}) {
    const controller = new AbortController();
    void client
      .attach({
        nodeId: 'node-1',
        nodeGeneration: 'generation-1',
        desktopGeneration: description.desktopGeneration ?? 'desktop-1',
        topologyRevision: description.topologyRevision ?? 1,
        mode: 'CONTROL',
        signal: controller.signal,
        onDisconnected: (code) => {
          state.disconnected = code;
        }
      })
      .then((result) => {
        handle = result;
        rfb = new RFB(document.querySelector('#desktop'), handle.channel, {
          manualClipboard: true,
          requestDrivenUpdates: true,
          allowedEncodings: [0, 21, -223, -224, -239, 0xc0a1e5ce]
        });
        rfb.addEventListener('firstframe', () => {
          state.firstframe = true;
          handle.ready();
        });
      })
      .catch((error) => {
        state.disconnected = error.code || 'ERROR';
      });
  },
  prepared(message) {
    client.handle(message);
  },
  messages() {
    return messages.splice(0);
  },
  key() {
    rfb.sendKey(97, 'KeyA', true);
  },
  close() {
    handle?.close();
    client.close();
    peer.close();
  }
};
