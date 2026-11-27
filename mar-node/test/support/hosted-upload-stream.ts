import { readUploadOffsets } from '@myagentroam/protocol/file-upload-stream';
import { NodeStreamMux } from '@myagentroam/protocol/node-stream-mux';
import type { HostedConversationNodeService } from '../../src/hosting/hosted-conversation-node-service.js';

export async function openHostedUploadBody(
  service: HostedConversationNodeService,
  target: unknown
) {
  const { grant } = (await service.operations()['conversation.hosted.files.upload.stream.prepare']!(
    target
  )) as { grant: string };
  const transfer = await openHostedFileStream(service, 'hosted-file-upload', grant);
  return { ...transfer, offsets: readUploadOffsets(transfer.body), grant };
}

export async function openHostedFileStream(
  service: HostedConversationNodeService,
  kind: 'hosted-file-upload' | 'hosted-file-download',
  grant: string
) {
  const done = Promise.withResolvers<void>();
  const client = new NodeStreamMux({
    maxStreams: 1,
    async send(bytes) {
      receiver.receive(bytes);
    }
  });
  const receiver = new NodeStreamMux({
    maxStreams: 1,
    async send(bytes) {
      client.receive(bytes);
    },
    accept: async ({ kind, grant: value }) => {
      const handler = service.consumeFileStream(kind, value);
      return handler === undefined
        ? undefined
        : (stream, signal) => handler(stream, signal).finally(() => done.resolve());
    }
  });
  const body = await client.openStream({ kind, grant });
  if (body === undefined) throw new Error('Expected Hosted file stream');
  return { body, client, receiver, done: done.promise };
}

export async function sendHostedUploadBody(
  service: HostedConversationNodeService,
  target: unknown,
  bytes: Uint8Array
): Promise<void> {
  const transfer = await openHostedUploadBody(service, target);
  await transfer.offsets.next();
  await transfer.body.write(bytes);
  await transfer.body.endWrite();
  for await (const _offset of transfer.offsets) {
    /* Drain persisted offsets through FIN. */
  }
  await transfer.done;
}
