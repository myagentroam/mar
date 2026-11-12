import RFB from '@novnc/novnc';
import { RemoteDesktopChannel } from '../../src/service/remote-desktop-channel';
import { remoteDesktopEncodings } from '../../src/service/remote-desktop-encodings';

// The channel is a controllable RFB peer; the renderer is the actual noVNC build.
class Channel extends EventTarget {
  binaryType = 'arraybuffer';
  readyState = 'open';
  protocol = '';
  bufferedAmount = 0;
  onmessage = null;
  onopen = null;
  onclose = null;
  onerror = null;
  sent = [];
  send(data) {
    this.sent.push([...new Uint8Array(data.buffer, data.byteOffset, data.byteLength)]);
  }
  close() {
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
  }
  receive(bytes) {
    const data = Uint8Array.from(bytes);
    this.dispatchEvent(new MessageEvent('message', { data: data.buffer }));
  }
}

const be16 = (n) => [(n >>> 8) & 255, n & 255];
const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const rect = (x, y, width, height, encoding, payload = []) => [
  ...be16(x),
  ...be16(y),
  ...be16(width),
  ...be16(height),
  ...be32(encoding),
  ...payload
];
const fbu = (rectangles) => [0, 0, ...be16(rectangles.length), ...rectangles.flat()];
const extendedClipboard = (payload) => [3, 0, 0, 0, ...be32(-payload.length), ...payload];
const channel = new Channel();
const transfer = (peer) =>
  new RemoteDesktopChannel(peer, {
    preRead: [new TextEncoder().encode('RFB 003.008\n').buffer],
    maxMessageBytes: 16384,
    maxQueuedBytes: 1024 * 1024,
    highWaterBytes: 1024 * 1024,
    onFailure: (code) => {
      events.transportFailure++;
      events.lastTransportFailure = code;
    }
  });
const options = {
  manualClipboard: true,
  requestDrivenUpdates: true,
  allowedEncodings: remoteDesktopEncodings('CONTROL')
};
const events = {
  connected: 0,
  firstframe: 0,
  frame: 0,
  clipboard: 0,
  imageLoaded: 0,
  clipboardRead: 0,
  clipboardWrite: 0,
  replacementFirstframe: 0,
  transportFailure: 0,
  lastTransportFailure: null
};
const rfb = new RFB(document.querySelector('#desktop'), transfer(channel), options);
let releaseImage;
let replacementChannel;
let clipboardClientCaps = 0;
let nativeRfb;
for (const type of ['connected', 'firstframe', 'frame', 'clipboard'])
  rfb.addEventListener(type === 'connected' ? 'connect' : type, () => events[type]++);
Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: {
    readText: async () => {
      events.clipboardRead++;
      return 'browser secret';
    },
    writeText: async () => {
      events.clipboardWrite++;
    }
  }
});

function handshake(peer) {
  peer.receive([1, 1]);
  peer.receive([0, 0, 0, 0]);
  peer.receive([
    ...be16(2),
    ...be16(2),
    32,
    24,
    0,
    1,
    0,
    255,
    0,
    255,
    0,
    255,
    16,
    8,
    0,
    0,
    0,
    0,
    ...be32(3),
    86,
    78,
    67
  ]);
}

window.fixture = {
  events,
  nativeConnected: false,
  connectNative(url) {
    nativeRfb = new RFB(document.querySelector('#desktop'), url, options);
    nativeRfb.addEventListener('connect', () => (window.fixture.nativeConnected = true));
  },
  pasteNative(text) {
    nativeRfb.clipboardPasteFrom(text);
  },
  closeNative() {
    nativeRfb.disconnect();
  },
  connect() {
    handshake(channel);
    channel.sent.length = 0;
  },
  async sendText(text, viewOnly = false) {
    rfb.viewOnly = viewOnly;
    channel.sent.length = 0;
    const accepted = rfb.sendText(text);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { accepted, messages: channel.sent.filter((message) => message[0] === 4) };
  },
  offeredEncodings() {
    const message = channel.sent.find((data) => data[0] === 2 && data.length >= 4);
    if (!message) return [];
    const view = new DataView(Uint8Array.from(message).buffer);
    return Array.from({ length: view.getUint16(2) }, (_, index) => view.getInt32(4 + index * 4));
  },
  async setQuality(value) {
    channel.sent.length = 0;
    rfb.qualityLevel = value;
    await new Promise((resolve) => setTimeout(resolve, 0));
    return this.offeredEncodings();
  },
  async endContinuousUpdates() {
    channel.sent.length = 0;
    channel.receive([150]);
    await Promise.resolve();
    return channel.sent;
  },
  async overflowNoVncReceiveQueue() {
    channel.receive([3, 0, 0, 0, ...be32(50 * 1024 * 1024)]);
    await Promise.resolve();
    const chunk = new Uint8Array(1024 * 1024);
    for (let i = 0; i < 45 && events.transportFailure === 0; i++) {
      channel.receive(chunk);
      await Promise.resolve();
    }
    return events.lastTransportFailure;
  },
  pseudo() {
    channel.receive(fbu([rect(0, 0, 2, 2, -223), rect(0, 0, 0, 0, -239), rect(0, 0, 0, 0, -224)]));
  },
  empty() {
    channel.receive(fbu([]));
  },
  raw() {
    channel.receive(
      fbu([rect(0, 0, 2, 2, 0, [0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0])])
    );
  },
  async clipboardNotify() {
    const flags = (1 << 24) | (1 << 25) | (1 << 27) | (1 << 28) | 1;
    channel.receive(extendedClipboard([...be32(flags), ...be32(0)]));
    await Promise.resolve();
    const caps = channel.sent.find((message) => message[0] === 6 && message.length >= 12);
    if (!caps) throw new Error('Client did not send clipboard capabilities');
    clipboardClientCaps = new DataView(Uint8Array.from(caps).buffer).getUint32(8);
    channel.sent.length = 0;
    window.dispatchEvent(new Event('focus'));
    channel.receive(extendedClipboard(be32((1 << 27) | 1)));
    await Promise.resolve();
    return channel.sent;
  },
  clipboardProvide() {
    channel.receive(extendedClipboard([...be32((1 << 28) | 1), 1, 2, 3]));
  },
  async pasteOnce() {
    rfb.clipboardPasteFrom('中文');
    const notify = channel.sent.find((message) => message[0] === 6 && message.length >= 12);
    const notifyFlags = notify ? new DataView(Uint8Array.from(notify).buffer).getUint32(8) : 0;
    channel.sent.length = 0;
    // TigerVNC requests clipboard data only when the client advertises Request.
    if (!(clipboardClientCaps & (1 << 25)) || !(notifyFlags & (1 << 27))) return [false, 0, 0];
    channel.receive(extendedClipboard(be32((1 << 25) | 1)));
    await Promise.resolve();
    const sent = channel.sent.length;
    channel.sent.length = 0;
    channel.receive(extendedClipboard(be32((1 << 25) | 1)));
    await Promise.resolve();
    return [true, sent, channel.sent.length];
  },
  close() {
    rfb.disconnect();
  },
  replace() {
    rfb.disconnect();
    replacementChannel = new Channel();
    const next = new RFB(document.querySelector('#desktop'), transfer(replacementChannel), options);
    next.addEventListener('firstframe', () => events.replacementFirstframe++);
    handshake(replacementChannel);
  },
  replacementRaw() {
    replacementChannel.receive(
      fbu([rect(0, 0, 2, 2, 0, [0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0])])
    );
  },
  async delayedImage() {
    const OriginalImage = window.Image;
    const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    const complete = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'complete');
    window.Image = function () {
      const image = new OriginalImage();
      let released = false;
      image.addEventListener('load', () => events.imageLoaded++);
      Object.defineProperty(image, 'complete', {
        configurable: true,
        get() {
          return released && complete.get.call(image);
        }
      });
      Object.defineProperty(image, 'src', {
        configurable: true,
        set(value) {
          releaseImage = () => {
            released = true;
            descriptor.set.call(image, value);
          };
        }
      });
      return image;
    };
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    canvas.getContext('2d').fillRect(0, 0, 1, 1);
    const jpeg = [
      ...Uint8Array.from(atob(canvas.toDataURL('image/jpeg').split(',')[1]), (c) => c.charCodeAt(0))
    ];
    channel.receive(fbu([rect(0, 0, 1, 1, 21, jpeg)]));
    await Promise.resolve();
    window.Image = OriginalImage;
  },
  releaseImage() {
    releaseImage();
  }
};
