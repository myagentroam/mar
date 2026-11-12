import { RemoteDesktopChannel } from '../../src/service/remote-desktop-channel.js';

/** A controlled RFB peer for exercising the real page and noVNC input handlers. */
export function createDesktopInputPeer() {
  const pointerMasks: number[] = [];
  let phase = 0;
  class Wire extends EventTarget {
    readonly readyState = 'open';
    readonly bufferedAmount = 0;
    send(data: Uint8Array) {
      if (phase === 0) {
        phase++;
        this.receive([1, 1]);
      } else if (phase === 1) {
        phase++;
        this.receive([0, 0, 0, 0]);
      } else if (phase === 2) {
        phase++;
        this.receive([
          3, 32, 2, 88, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0, 0, 0, 0, 3, 77, 65,
          82
        ]);
      } else if (data[0] === 5) {
        pointerMasks.push(data[1]!);
      }
    }
    close() {
      this.dispatchEvent(new Event('close'));
    }
    receive(bytes: number[]) {
      this.dispatchEvent(new MessageEvent('message', { data: Uint8Array.from(bytes).buffer }));
    }
  }
  const wire = new Wire();
  const channel = new RemoteDesktopChannel(wire as unknown as RTCDataChannel, {
    preRead: [new TextEncoder().encode('RFB 003.008\n').buffer],
    maxMessageBytes: 16384,
    maxQueuedBytes: 1024 * 1024,
    highWaterBytes: 1024 * 1024,
    onFailure() {}
  });
  return {
    channel,
    pointerMasks,
    get ready() {
      return phase === 3;
    },
    paint() {
      // One Tight fill paints an 800x600 framebuffer without a large raw fixture.
      wire.receive([0, 0, 0, 1, 0, 0, 0, 0, 3, 32, 2, 88, 0, 0, 0, 7, 128, 29, 38, 52]);
    }
  };
}
