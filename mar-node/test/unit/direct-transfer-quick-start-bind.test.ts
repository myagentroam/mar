import { afterEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ construct: vi.fn(), stop: vi.fn() }));
vi.mock('node-datachannel', () => ({
  IceUdpMuxListener: class {
    constructor(port: number, address?: string) {
      native.construct(port, address);
    }
    port() {
      return 50_000;
    }
    stop() {
      native.stop();
    }
  }
}));

import { DirectTransferService } from '../../src/connection/direct-transfer-service.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  native.construct.mockClear();
  native.stop.mockClear();
});

describe('Quick Start direct transfer listener', () => {
  it.each([
    ['win32', '1', '0.0.0.0'],
    ['win32', undefined, undefined],
    ['linux', '1', undefined]
  ])('uses the intended bind for %s and owner %s', async (platform, owner, address) => {
    vi.stubEnv('MAR_QUICK_START_OWNER', owner);
    vi.stubGlobal(
      'process',
      new Proxy(process, {
        get: (target, key, receiver) =>
          key === 'platform' ? platform : Reflect.get(target, key, receiver)
      })
    );
    const service = await DirectTransferService.create({
      nodeGeneration: () => 'generation',
      send: () => {},
      udpPortRange: () => ({ begin: 50_000, end: 50_000 }),
      probeUdp4Port: async () => {}
    });
    expect(native.construct).toHaveBeenCalledWith(50_000, address);
    service.dispose();
    expect(native.stop).toHaveBeenCalledOnce();
  });
});
