import type { BrowserContext, Page } from '@playwright/test';
import { NodeStreamMux } from '../../../packages/protocol/src/node-stream-mux.js';
import { encodeNodeRelayHandshake } from '../../../packages/protocol/src/node-stream-wire.js';

type Descriptor = {
  resource: { path: string };
  revision: string;
  range?: { offset: number; length: number };
};

/** Serves file fixtures through the real client-side mux with a simulated Relay peer. */
export async function mockWorkspaceFileRelay(
  target: Page | BrowserContext,
  nodeId: string,
  workspaceId: string,
  read: (path: string) => Buffer | Promise<Buffer>
) {
  const descriptors: Descriptor[] = [];
  let carriers = 0;
  const workspace = `**/api/workspaces/${encodeURIComponent(workspaceId)}`;
  await target.route(`${workspace}/files/direct-metadata?**`, async (route) => {
    const path = new URL(route.request().url()).searchParams.get('path') ?? '';
    const bytes = await read(path);
    await route.fulfill({ json: { file: { size: bytes.byteLength, revision: 'r1' } } });
  });
  await target.route(`${workspace}/file-stream-ticket`, async (route) => {
    const { descriptor } = route.request().postDataJSON() as { descriptor: Descriptor };
    if (descriptor.revision !== 'r1') return route.fulfill({ status: 409 });
    descriptors.push(descriptor);
    return route.fulfill({ json: { ticket: String(descriptors.length - 1) } });
  });
  await target.routeWebSocket(`**/api/relay/${encodeURIComponent(nodeId)}`, (socket) => {
    carriers++;
    const mux = new NodeStreamMux({
      maxStreams: 8,
      async send(frame) {
        socket.send(Buffer.from(frame));
      },
      async accept({ kind, grant }) {
        const descriptor = descriptors[Number(grant)];
        if (kind !== 'file-download' || descriptor === undefined) return undefined;
        return async (stream) => {
          const bytes = await read(descriptor.resource.path);
          const { offset, length } = descriptor.range ?? { offset: 0, length: bytes.byteLength };
          await stream.write(bytes.subarray(offset, offset + length));
          await stream.endWrite();
          for await (const _chunk of stream) throw new Error('Unexpected reverse DATA');
        };
      }
    });
    socket.onMessage((message) => mux.receive(message));
    socket.onClose(() => mux.disconnect());
    socket.send(Buffer.from(encodeNodeRelayHandshake({ type: 'RELAY_READY' })));
  });
  return () => ({ carriers, descriptors });
}
