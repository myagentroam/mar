import RFB from '@novnc/novnc';
import { createRemoteDesktopRelayClient } from '../../src/service/remote-desktop-relay-client';
import { createRemoteDesktopPageAttachments } from '../../src/service/remote-desktop-page-attachments';

// The control messages are isolated test adapters; the Relay client and data path are production code.
const state = { firstframe: false, failure: null, messages: [] };
let rfb;
let handle;
let client;
let owner;
let target;
let request = 0;
async function start(layout) {
  client = createRemoteDesktopRelayClient({
    connectionId: () => 'page-12345678',
    randomId: () => `request-${++request}`,
    send: (message) => {
      state.messages.push(message);
      void globalThis.desktopRelayControl(message).catch(() => {
        state.failure = 'TEST_CONTROL_ERROR';
      });
      return true;
    }
  });
  owner = createRemoteDesktopPageAttachments({
    direct: { attach: async () => undefined, close() {} },
    relay: client
  });
  target = {
    nodeId: 'node-a',
    nodeGeneration: 'generation-1',
    desktopGeneration: layout.desktopGeneration,
    topologyRevision: layout.topologyRevision,
    mode: 'CONTROL',
    signal: new AbortController().signal,
    onDisconnected: (code) => {
      state.failure = code;
    }
  };
  await attach('CONTROL');
}
async function attach(mode) {
  state.firstframe = false;
  const next = await owner.select({ ...target, mode });
  handle = next;
  rfb = new RFB(document.getElementById('desktop'), next.channel, {
    manualClipboard: true,
    requestDrivenUpdates: true,
    allowedEncodings:
      mode === 'CONTROL' ? [0, 21, -223, -224, -239, 0xc0a1e5ce] : [0, 21, -223, -224, -239]
  });
  rfb.viewOnly = mode === 'VIEW';
  rfb.addEventListener(
    'firstframe',
    () => {
      state.firstframe = true;
      next.ready();
    },
    { once: true }
  );
}
globalThis.desktopRelayProbe = {
  start,
  state,
  deliver(message) {
    client.handle(message);
  },
  key() {
    rfb.sendKey(0x61, 'KeyA', true);
  },
  switchToView() {
    return attach('VIEW');
  },
  close() {
    return handle.close();
  }
};
