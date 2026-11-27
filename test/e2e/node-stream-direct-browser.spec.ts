import { expect, test } from '@playwright/test';
import type * as Path from '../../packages/protocol/dist/node-stream-path.js';
import type * as Terminal from '../../packages/protocol/src/byte-frame.js';
import type * as Records from '../../packages/protocol/src/terminal-stream.js';
import type * as Client from '../../packages/web-core/src/service/terminal-direct-client.js';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

test('Browser Terminal and a byte stream share one real ICE channel', async ({ page }) => {
  const fixture = await startCustomThemeFixture(
    'packages/web-core/src/service/terminal-direct-client.ts'
  );
  try {
    const origin = new URL(fixture.url).origin;
    await page.route(`${origin}/stream-test`, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Node stream test</title>'
      })
    );
    await page.goto(`${origin}/stream-test`);
    const result = await page.evaluate(
      async (modules) => {
        const { bindNodeDirectPath, rtcNodeStreamCarrier, NODE_STREAM_CHANNEL_LABEL } =
          (await import(modules.path)) as typeof Path;
        const { encodeTerminalMessage, decodeTerminalMessage } = (await import(
          modules.terminal
        )) as typeof Terminal;
        const { readTerminalRecords, writeTerminalRecord } = (await import(
          modules.records
        )) as typeof Records;
        const { createTerminalDirectClient } = (await import(modules.client)) as typeof Client;
        const local = new RTCPeerConnection();
        const remote = new RTCPeerConnection();
        const scope = AbortSignal.timeout(12_000);
        const channel = local.createDataChannel(NODE_STREAM_CHANNEL_LABEL, { ordered: true });
        const localPath = bindNodeDirectPath({
          carrier: rtcNodeStreamCarrier(channel),
          maxStreams: 4
        });
        const accepted: string[] = [];
        let remoteChannels = 0;
        const terminalId = 'browser-terminal';
        const input = Promise.withResolvers<unknown>();
        const sendFrame = (frame: object) => writeTerminalRecord(encodeTerminalMessage(frame));
        remote.ondatachannel = ({ channel: incoming }) => {
          remoteChannels += 1;
          bindNodeDirectPath({
            carrier: rtcNodeStreamCarrier(incoming),
            maxStreams: 4,
            async accept({ kind, grant }) {
              accepted.push(kind);
              if (kind === 'terminal' && grant === 'terminal-grant') {
                return async (stream) => {
                  await stream.write(sendFrame({ type: 'attach', terminalId, afterSequence: 0 }));
                  for await (const record of readTerminalRecords(stream)) {
                    const frame = decodeTerminalMessage(record);
                    if (frame.type === 'input' && frame.data instanceof Uint8Array)
                      input.resolve(Array.from(frame.data));
                  }
                };
              }
              if (kind === 'file' && grant === 'file-grant') {
                return async (stream) => {
                  for await (const bytes of stream) await stream.write(bytes);
                  await stream.endWrite();
                };
              }
              return undefined;
            }
          });
        };
        const ready = new Promise<void>((resolve) =>
          channel.addEventListener('open', () => resolve(), { once: true })
        );
        async function gather(peer: RTCPeerConnection) {
          if (peer.iceGatheringState !== 'complete') {
            await new Promise<void>((resolve) => {
              peer.addEventListener(
                'icegatheringstatechange',
                () => {
                  if (peer.iceGatheringState === 'complete') resolve();
                },
                { signal: scope }
              );
            });
          }
          return peer.localDescription!;
        }
        const client = createTerminalDirectClient({
          send(message) {
            if (message.type === 'terminal.direct.prepare') {
              queueMicrotask(() =>
                client.handle({
                  type: 'terminal.direct.prepared',
                  requestId: message.requestId,
                  directSessionId: 'fixture-lease',
                  grant: 'terminal-grant',
                  openExpiresAt: Date.now() + 15_000,
                  expiresAt: Date.now() + 30_000
                })
              );
            }
            return true;
          }
        });
        const verify = async () => {
          await local.setLocalDescription(await local.createOffer());
          await remote.setRemoteDescription(await gather(local));
          await remote.setLocalDescription(await remote.createAnswer());
          await local.setRemoteDescription(await gather(remote));
          await ready;
          const terminal = (await client.openStream(
            'fixture',
            { terminalId, afterSequence: 0 },
            {
              nodeGeneration: 'fixture-generation',
              transportSessionId: 'fixture-peer'
            },
            localPath,
            scope
          ))!;
          const reader = readTerminalRecords(terminal);
          const attach = decodeTerminalMessage((await reader.next()).value!);
          if (attach.type !== 'attach') throw new Error('Unexpected terminal attachment');
          const bytes = Uint8Array.of(0, 255, 42);
          await terminal.write(sendFrame({ type: 'input', terminalId, data: bytes }));
          const sent = await input.promise;
          const file = await localPath.openStream({ kind: 'file', grant: 'file-grant' }, scope);
          const revoked = reader.next().then(
            () => 'unexpected record',
            (error: Error) => error.message
          );
          client.handle({
            type: 'terminal.direct.closed',
            directSessionId: 'fixture-lease',
            code: 'RESOURCE_DENIED'
          });
          await file!.write(bytes);
          await file!.endWrite();
          const echoed: number[] = [];
          for await (const chunk of file!) echoed.push(...chunk);
          return {
            sent,
            echoed,
            revoked: await revoked,
            accepted,
            remoteChannels,
            carrier: channel.readyState
          };
        };
        try {
          const expired = new Promise<never>((_, reject) =>
            scope.addEventListener('abort', () => reject(scope.reason), { once: true })
          );
          return await Promise.race([verify(), expired]);
        } finally {
          client.invalidate();
          localPath.close();
          local.close();
          remote.close();
        }
      },
      {
        path: '/packages/protocol/src/node-stream-path.ts',
        terminal: '/packages/protocol/src/byte-frame.ts',
        records: '/packages/protocol/src/terminal-stream.ts',
        client: '/packages/web-core/src/service/terminal-direct-client.ts'
      }
    );
    expect(result).toEqual({
      sent: [0, 255, 42],
      echoed: [0, 255, 42],
      revoked: 'RESOURCE_DENIED',
      accepted: ['terminal', 'file'],
      remoteChannels: 1,
      carrier: 'open'
    });
  } finally {
    await fixture.close();
  }
});
