import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStandaloneRemoteDesktopService } from '../../src/service/standalone-remote-desktop-service.js';

afterEach(() => vi.unstubAllGlobals());

describe('standalone desktop live authentication', () => {
  it.each([
    { code: 4001, reason: 'UNAUTHENTICATED', expected: 'UNAUTHENTICATED' },
    { code: 1006, reason: '', expected: 'DESKTOP_CONTROL_UNAVAILABLE' }
  ])('reports $expected for live close $code', async ({ code, reason, expected }) => {
    class FakeWebSocket extends EventTarget {
      static readonly OPEN = 1;
      static instance: FakeWebSocket;
      readyState = FakeWebSocket.OPEN;
      constructor() {
        super();
        FakeWebSocket.instance = this;
      }
      send() {}
      close() {}
    }
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('window', { location: { origin: 'https://desktop.example' } });
    const onDisconnected = vi.fn();
    const service = createStandaloneRemoteDesktopService({ nodeId: 'node-a', onDisconnected });
    try {
      const socket = FakeWebSocket.instance;
      socket.dispatchEvent(new Event('open'));
      socket.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'workbench.ready',
            workbenchConnectionId: 'page-connection',
            workbenchResumeToken: 'resume-token'
          })
        })
      );
      socket.dispatchEvent(Object.assign(new Event('close'), { code, reason }));
      expect(onDisconnected).toHaveBeenCalledExactlyOnceWith(expected);
    } finally {
      await service.close();
    }
  });
});
