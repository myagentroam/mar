import type { Page } from '@playwright/test';
import type { DirectTransferDescriptor } from '../../../packages/protocol/src/direct-transfer.js';
import { encodeUploadOffset } from '../../../packages/protocol/src/file-upload-stream.js';
import { NodeStreamMux } from '../../../packages/protocol/src/node-stream-mux.js';
import { encodeNodeRelayHandshake } from '../../../packages/protocol/src/node-stream-wire.js';

type Upload = Extract<DirectTransferDescriptor, { direction: 'UPLOAD' }>;

/** Simulates the Node file handler, while the browser uses its real Relay and upload services. */
export async function mockWorkspaceUploadRelay(
  page: Page,
  options: {
    offset?: (upload: Upload) => number;
    beforeBody?: (upload: Upload) => void | Promise<void>;
    received?: (upload: Upload, body: Buffer) => void;
    error?: (upload: Upload) => string | undefined;
  } = {}
) {
  const uploads: Upload[] = [];
  await page.route('**/api/workspaces/*/file-stream-ticket', async (route) => {
    const { descriptor } = route.request().postDataJSON() as {
      descriptor: DirectTransferDescriptor;
    };
    if (descriptor.direction !== 'UPLOAD') return route.fallback();
    uploads.push(descriptor);
    await route.fulfill({ json: { ticket: String(uploads.length - 1) } });
  });
  await page.routeWebSocket('**/api/relay/node-1', (socket) => {
    const mux = new NodeStreamMux({
      maxStreams: 8,
      async send(frame) {
        socket.send(Buffer.from(frame));
      },
      async accept({ kind, grant }) {
        const upload = uploads[Number(grant)];
        if (kind !== 'file-upload' || upload === undefined) return undefined;
        return async (stream) => {
          const error = options.error?.(upload);
          if (error !== undefined) return stream.reset(error);
          await options.beforeBody?.(upload);
          let offset = options.offset?.(upload) ?? 0;
          const chunks: Buffer[] = [];
          await stream.write(encodeUploadOffset(offset));
          for await (const chunk of stream) {
            chunks.push(Buffer.from(chunk));
            offset += chunk.byteLength;
            await stream.write(encodeUploadOffset(offset));
          }
          options.received?.(upload, Buffer.concat(chunks));
          await stream.endWrite();
        };
      }
    });
    socket.onMessage((message) => mux.receive(message));
    socket.onClose(() => mux.disconnect());
    socket.send(Buffer.from(encodeNodeRelayHandshake({ type: 'RELAY_READY' })));
  });
}
