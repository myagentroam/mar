import { createSocket } from 'node:dgram';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { DirectTransferService } from '../../mar-node/src/connection/direct-transfer-service.js';
import type { NodeWorkspace } from '../../mar-node/src/database.js';
import { WorkspaceUploadService } from '../../mar-node/src/workspace/workspace-upload-service.js';
import type {
  DirectBrowserMessage,
  DirectServerMessage
} from '../../packages/protocol/src/index.js';
import { DirectTransferCoordinator } from '../../packages/server-core/src/direct-transfer-coordinator.js';
import type * as BrowserFiles from '../../packages/web-core/src/service/workspace-direct-transfer-service.js';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

test('Workspace upload and Range downloads reuse one ICE channel and preserve exact bytes', async ({
  page
}) => {
  const directory = await mkdtemp(join(tmpdir(), 'mar-workspace-stream-'));
  const modulePath = '/packages/web-core/src/service/workspace-direct-transfer-service.ts';
  const target = join(directory, 'sample.bin');
  const bytes = Buffer.from(Array.from({ length: 384 * 1024 + 17 }, (_, i) => i % 251));
  const uploadBytes = Buffer.from(Array.from({ length: 520 * 1024 + 7 }, (_, i) => i % 241));
  const sha256 = createHash('sha256').update(uploadBytes).digest('hex');
  const nodeId = 'fixture-node';
  const generation = 'fixture-generation';
  const identity = {
    userId: 7,
    sessionHash: 'fixture-session',
    workbenchConnectionId: 'fixture-page'
  };
  let endpoint: DirectTransferService | undefined;
  let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>> | undefined;
  const uploadService = new WorkspaceUploadService(
    () => undefined,
    () => directory
  );
  const workspace = { id: 'fixture-workspace', path: directory } as NodeWorkspace;
  const coordinator = new DirectTransferCoordinator({
    authorize: (_userId, id, workspace) =>
      id === nodeId && (workspace === undefined || workspace === 'fixture-workspace'),
    sendNode: (_id, _type, message) => endpoint?.handle(message) ?? false,
    sendBrowser: async (_id, message) => {
      await page.evaluate((value) => {
        const receive = (window as Window & { receiveDirect?: (m: DirectServerMessage) => void })
          .receiveDirect;
        receive?.(value);
      }, message);
      return 'delivered';
    }
  });
  try {
    await writeFile(target, bytes);
    const { uploadId } = await uploadService.create(workspace, {
      name: 'upload.bin',
      size: uploadBytes.length,
      overwrite: false,
      sha256,
      streamStaging: true
    });
    const probe = createSocket('udp4').bind(0, '127.0.0.1');
    await once(probe, 'listening');
    const { port } = probe.address();
    await new Promise<void>((resolve) => probe.close(resolve));
    endpoint = await DirectTransferService.create({
      nodeGeneration: () => generation,
      udpPortRange: () => ({ begin: port, end: port }),
      send: (_type, event) => coordinator.handleNodeMessage(nodeId, event),
      openUpload: async (descriptor) => {
        if (descriptor.direction !== 'UPLOAD' || descriptor.uploadId === undefined)
          throw new Error('DIRECT_TRANSFER_INVALID');
        return uploadService.openStreamUpload(workspace, {
          uploadId: descriptor.uploadId,
          path: descriptor.resource.path,
          size: descriptor.size,
          sha256: descriptor.sha256,
          overwrite: false
        });
      },
      openDownload: async (descriptor) => {
        if (descriptor.direction !== 'DOWNLOAD') throw new Error('DIRECT_TRANSFER_INVALID');
        const offset = descriptor.range?.offset ?? 0;
        const length = descriptor.range?.length ?? bytes.length;
        return {
          offset,
          chunks: createReadStream(target, { start: offset, end: offset + length - 1 })
        };
      }
    });
    fixture = await startCustomThemeFixture(modulePath.slice(1));
    const url = new URL('/file-stream-test', fixture.url).href;
    await page.route(url, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>File stream test</title>'
      })
    );
    await page.exposeFunction('sendDirect', (message: DirectBrowserMessage) =>
      coordinator.handleBrowserMessage(identity, message)
    );
    await page.goto(url);
    const ranges = [
      { offset: 7, length: 320 * 1024 + 3 },
      { offset: bytes.length - 19, length: 19 }
    ];
    const actual = await page.evaluate(
      async ({ modulePath, nodeId, generation, size, ranges, uploadId }) => {
        const host = window as unknown as Window & {
          sendDirect(message: DirectBrowserMessage): Promise<void>;
          receiveDirect(message: DirectServerMessage): void;
        };
        const { createWorkspaceDirectTransferService } = (await import(
          modulePath
        )) as typeof BrowserFiles;
        const channels: string[] = [];
        const service = createWorkspaceDirectTransferService({
          probeTimeoutMs: 8_000,
          createPeerConnection() {
            const peer = new RTCPeerConnection({ iceServers: [] });
            const create = peer.createDataChannel.bind(peer);
            peer.createDataChannel = (label, init) => {
              channels.push(label);
              return create(label, init);
            };
            return peer;
          },
          send(message) {
            void host.sendDirect(message);
            return true;
          }
        });
        host.receiveDirect = service.handle;
        try {
          const status = await service.ensureTransport(nodeId, generation);
          if (status !== 'DIRECT_AVAILABLE') throw new Error(`Direct connection failed: ${status}`);
          const uploadBytes = Uint8Array.from({ length: 520 * 1024 + 7 }, (_, i) => i % 241);
          const uploadHash = await crypto.subtle.digest('SHA-256', uploadBytes);
          const upload = service.upload({
            nodeId,
            nodeGeneration: generation,
            file: new File([uploadBytes], 'upload.bin'),
            descriptor: {
              direction: 'UPLOAD',
              uploadId,
              resource: {
                kind: 'WORKSPACE_FILE',
                workspaceId: 'fixture-workspace',
                path: 'upload.bin'
              },
              fileName: 'upload.bin',
              size: uploadBytes.length,
              sha256: Array.from(new Uint8Array(uploadHash), (b) =>
                b.toString(16).padStart(2, '0')
              ).join('')
            },
            signal: AbortSignal.timeout(8_000)
          });
          const downloads = ranges.map(async (range) => {
            const destination = new Uint8Array(range.length);
            let received = 0;
            let writes = 0;
            await service.download({
              nodeId,
              nodeGeneration: generation,
              descriptor: {
                direction: 'DOWNLOAD',
                resource: {
                  kind: 'WORKSPACE_FILE',
                  workspaceId: 'fixture-workspace',
                  path: 'sample.bin'
                },
                fileName: 'sample.bin',
                revision: 'fixture-revision',
                size,
                range
              },
              signal: AbortSignal.timeout(8_000),
              sink: {
                async write(chunk) {
                  destination.set(chunk, received);
                  received += chunk.byteLength;
                  writes++;
                },
                async close() {
                  if (received !== range.length) throw new Error('Truncated destination');
                },
                async abort() {}
              }
            });
            return {
              writes,
              checksum: Array.from(
                new Uint8Array(await crypto.subtle.digest('SHA-256', destination))
              )
            };
          });
          const [output] = await Promise.all([Promise.all(downloads), upload]);
          return { channels, output };
        } finally {
          service.close();
        }
      },
      { modulePath, nodeId, generation, size: bytes.length, ranges, uploadId }
    );
    expect(actual.channels).toEqual(['mar-node-stream']);
    await expect(readFile(join(directory, 'upload.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
    await uploadService.complete(uploadId);
    const uploaded = await readFile(join(directory, 'upload.bin'));
    expect(uploaded).toEqual(uploadBytes);
    expect(actual.output[0]?.writes).toBeGreaterThan(1);
    for (const [index, range] of ranges.entries()) {
      const expected = await crypto.subtle.digest(
        'SHA-256',
        bytes.subarray(range.offset, range.offset + range.length)
      );
      expect(actual.output[index]?.checksum).toEqual(Array.from(new Uint8Array(expected)));
    }
  } finally {
    coordinator.close();
    endpoint?.dispose();
    await uploadService.shutdown();
    await fixture?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
