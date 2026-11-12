import Fastify from 'fastify';
import { remoteDesktopCapabilitySchema } from '@myagentroam/protocol';
import { describe, expect, it, vi } from 'vitest';
import { registerRemoteDesktopDiscoveryRoute } from '../../src/route/remote-desktop-discovery-route.js';

const capability = {
  apiVersion: 1,
  available: true,
  nodeGeneration: 'generation-a',
  backend: 'TIGERVNC_X0',
  supportsView: true,
  supportsMultiDisplay: true,
  supportsControl: true,
  supportsUnicodePaste: true,
  transports: ['DIRECT', 'RELAY']
} as const;
const description = {
  desktopGeneration: 'desktop-a',
  topologyRevision: 1,
  framebuffer: { width: 800, height: 600 },
  displays: [
    {
      displayId: 'display-a',
      name: 'Primary',
      primary: true,
      nativeBounds: { x: 0, y: 0, width: 800, height: 600 },
      framebufferBounds: { x: 0, y: 0, width: 800, height: 600 },
      nativeToFramebuffer: [1, 0, 0, 1, 0, 0]
    }
  ]
};

function fixture() {
  const app = Fastify();
  const session = {
    userId: 7,
    username: 'user',
    isAdmin: false,
    sessionHash: 'session-hash',
    mustChangePassword: false,
    csrfTokenHash: 'csrf'
  };
  const lookup = vi.fn(() => session as typeof session | undefined);
  const canUseNode = vi.fn(async () => true);
  const nodeCapabilities = vi.fn(() => ({ remoteDesktop: capability }) as unknown);
  const requestNode = vi.fn(async () => description as unknown);
  const node = {
    id: 'node-a',
    displayName: 'Studio desktop' as string | null,
    registeredAddress: '192.0.2.10'
  };
  const listNodes = vi.fn(async () => [node]);
  registerRemoteDesktopDiscoveryRoute({
    app,
    publicOrigin: 'http://trusted.test',
    database: { findCurrentUserSession: lookup },
    nodeControl: { nodeCapabilities, requestNode, listNodes } as never,
    resources: { canUseNode }
  });
  const get = (headers: Record<string, string> = {}) =>
    app.inject({
      method: 'GET',
      url: '/api/nodes/node-a/desktop',
      headers: { cookie: 'mar_user_session=session', ...headers }
    });
  return { app, get, lookup, canUseNode, nodeCapabilities, requestNode, node, listNodes };
}

describe('Remote Desktop discovery route', () => {
  it('uses the registered address when the Node has no display name, never its internal ID', async () => {
    const f = fixture();
    f.node.displayName = null;
    try {
      const response = await f.get();
      expect(response.statusCode).toBe(200);
      expect(response.json().nodeName).toBe('192.0.2.10');
    } finally {
      await f.app.close();
    }
  });

  it('rechecks the Session after the Node-name lookup without dispatching after revocation', async () => {
    const f = fixture();
    f.listNodes.mockImplementationOnce(async () => {
      f.lookup.mockReturnValue(undefined);
      return [f.node];
    });
    try {
      const response = await f.get();
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain('Studio desktop');
      expect(f.requestNode).not.toHaveBeenCalled();
    } finally {
      await f.app.close();
    }
  });

  it('returns the live capability and validated description for a Node user', async () => {
    expect(remoteDesktopCapabilitySchema.parse(capability)).toEqual(capability);
    const f = fixture();
    try {
      const response = await f.get({ origin: 'http://trusted.test' });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toEqual({ capability, description, nodeName: 'Studio desktop' });
      expect(f.requestNode).toHaveBeenCalledWith(
        'node-a',
        'desktop.describe',
        {},
        {
          userId: 7,
          sessionHash: 'session-hash'
        },
        undefined
      );
      expect(f.canUseNode).toHaveBeenCalledTimes(2);
    } finally {
      await f.app.close();
    }
  });

  it('rejects an untrusted Origin, missing session, no Node permission and unavailable Node', async () => {
    const f = fixture();
    try {
      expect((await f.get({ origin: 'http://untrusted.test' })).statusCode).toBe(403);
      f.lookup.mockReturnValueOnce(undefined);
      expect((await f.get()).statusCode).toBe(401);
      f.canUseNode.mockResolvedValueOnce(false);
      expect((await f.get()).statusCode).toBe(403);
      f.nodeCapabilities.mockReturnValueOnce(undefined);
      expect((await f.get()).statusCode).toBe(409);
      expect(f.requestNode).not.toHaveBeenCalled();
    } finally {
      await f.app.close();
    }
  });

  it('does not return an in-flight description after session, permission or generation changes', async () => {
    for (const change of ['session', 'permission', 'generation'] as const) {
      const f = fixture();
      try {
        let release!: (value: unknown) => void;
        f.requestNode.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
        const pending = f.get();
        await vi.waitFor(() => expect(release).toBeDefined());
        if (change === 'session') f.lookup.mockReturnValue(undefined);
        if (change === 'permission') f.canUseNode.mockResolvedValue(false);
        if (change === 'generation')
          f.nodeCapabilities.mockReturnValue({
            remoteDesktop: { ...capability, nodeGeneration: 'generation-b' }
          });
        release(description);
        const response = await pending;
        expect(response.statusCode).toBe(
          change === 'session' ? 401 : change === 'permission' ? 403 : 409
        );
        expect(response.body).not.toContain('desktop-a');
      } finally {
        await f.app.close();
      }
    }
  });

  it('does not dispatch to Node after the session expires during authorization', async () => {
    const f = fixture();
    try {
      let release!: (allowed: boolean) => void;
      f.canUseNode.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
      const pending = f.get();
      await vi.waitFor(() => expect(release).toBeDefined());
      f.lookup.mockReturnValue(undefined);
      release(true);
      expect((await pending).statusCode).toBe(401);
      expect(f.requestNode).not.toHaveBeenCalled();
    } finally {
      await f.app.close();
    }
  });

  it('rejects a malformed description without echoing it', async () => {
    const f = fixture();
    try {
      f.requestNode.mockResolvedValueOnce({ secret: 'untrusted-node-content' });
      const response = await f.get();
      expect(response.statusCode).toBe(502);
      expect(response.body).not.toContain('untrusted-node-content');
    } finally {
      await f.app.close();
    }
  });

  it.each(['revoked', 'replaced'] as const)(
    'does not return a description when the session is %s during the final authorization',
    async (change) => {
      const f = fixture();
      try {
        let release!: (allowed: boolean) => void;
        f.canUseNode
          .mockResolvedValueOnce(true)
          .mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
        const pending = f.get();
        await vi.waitFor(() => expect(release).toBeDefined());
        f.lookup.mockReturnValue(
          change === 'revoked' ? undefined : { ...f.lookup()!, sessionHash: 'replacement-session' }
        );
        release(true);
        const response = await pending;
        expect(response.statusCode).toBe(401);
        expect(response.body).not.toContain('desktop-a');
        expect(f.requestNode).toHaveBeenCalledOnce();
        expect(f.canUseNode).toHaveBeenCalledTimes(2);
      } finally {
        await f.app.close();
      }
    }
  );
});
