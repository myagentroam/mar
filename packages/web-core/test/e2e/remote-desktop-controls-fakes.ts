// Controlled transport/render boundaries; the page, layout, and controls are real.
const modes: string[] = [];
let current: RFB | undefined;
let activeChannel: ReturnType<typeof channel>;
const settings = new URLSearchParams(location.search);
function channel() {
  const bytes = { receivedBytes: 0, sentBytes: 0 };
  return { bytes, getStatistics: () => ({ ...bytes }) };
}

export default class RFB extends EventTarget {
  viewOnly = true;
  scaleViewport = true;
  qualityLevel = 6;
  constructor(target: HTMLElement) {
    super();
    current = this;
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 600;
    canvas.style.cssText = 'width:100%;height:100%;background:#1d2634';
    target.append(canvas);
  }
  disconnect() {}
}

export function createStandaloneRemoteDesktopService() {
  return {
    async discover() {
      return {
        capability: { supportsControl: !settings.has('viewOnly'), supportsUnicodePaste: true },
        description: {
          framebuffer: { width: 800, height: 600 },
          displays: [
            {
              displayId: 'screen',
              name: 'Display',
              primary: true,
              framebufferBounds: { x: 0, y: 0, width: 800, height: 600 }
            }
          ]
        }
      };
    },
    async select(input: { mode: string }) {
      modes.push(input.mode);
      activeChannel = channel();
      return {
        path: settings.get('path') === 'relay' ? 'relay' : 'direct',
        channel: activeChannel,
        controlRoundTripMs: 24,
        ready() {},
        async close() {
          return true;
        }
      };
    },
    async close() {
      return true;
    }
  };
}

declare global {
  interface Window {
    desktopControls: { modes: string[]; paint(): void };
  }
}
window.desktopControls = {
  modes,
  paint() {
    activeChannel.bytes.receivedBytes += 2048;
    activeChannel.bytes.sentBytes += 128;
    current!.dispatchEvent(new Event('frame'));
    current!.dispatchEvent(new Event('firstframe'));
  }
};
