import {
  conversationFileProjectionSchema,
  type ConversationFileProjection,
  type HostedConversationFileStreamInput
} from '@myagentroam/protocol';
import type { ScopedHttpService } from './scoped-http-service.js';
import type { OpenWorkbenchNodeStream } from './workbench-node-connection-service.js';
import {
  receiveFileDownloadBody,
  type WorkspaceDownloadSink
} from './workspace-download-stream.js';
import { downloadWorkspaceFileToBrowser } from './workspace-direct-download-stream-service.js';
import { readWorkspaceFileObjectUrl } from './workspace-direct-object-url-service.js';
import { MAX_BINARY_PREVIEW_BYTES } from '../util/file-preview.js';

interface HostedFileTarget {
  readonly nodeId: string;
  readonly conversationId: string;
  readonly fileId: string;
}

/** Provides Hosted snapshot metadata and bytes; its page owns the shared connection and lifetime. */
export function createHostedFileDownloadService(options: {
  readonly http: ScopedHttpService;
  readonly openStream: OpenWorkbenchNodeStream;
  readonly activeWorker?: () => Promise<ServiceWorker | undefined>;
}) {
  async function describe(
    target: HostedFileTarget,
    signal: AbortSignal
  ): Promise<ConversationFileProjection> {
    const { nodeId, conversationId, fileId } = target;
    const file = conversationFileProjectionSchema.parse(
      await options.http.request<unknown>(
        `/api/nodes/${encodeURIComponent(nodeId)}/hosted-conversations/${encodeURIComponent(conversationId)}/files/${encodeURIComponent(fileId)}/metadata`,
        { signal }
      )
    );
    if (file.id !== fileId || file.conversationId !== conversationId)
      throw new Error('HOSTED_CONVERSATION_RESPONSE_INVALID');
    return file;
  }

  function receive(
    nodeId: string,
    file: ConversationFileProjection,
    sink: WorkspaceDownloadSink,
    signal: AbortSignal,
    range?: HostedConversationFileStreamInput['range']
  ): Promise<void> {
    return receiveFileDownloadBody(
      () =>
        options.openStream(
          nodeId,
          {
            kind: 'hosted-file-download',
            descriptor: {
              conversationId: file.conversationId,
              fileId: file.id,
              revision: `${file.updatedAt}-${file.size}`,
              ...(range === undefined ? {} : { range })
            }
          },
          signal
        ),
      sink,
      range?.length ?? file.size,
      signal
    );
  }

  async function readRange(
    nodeId: string,
    file: ConversationFileProjection,
    offset: number,
    limit: number,
    signal: AbortSignal
  ): Promise<Uint8Array<ArrayBuffer>> {
    const length = Math.min(limit, file.size - offset);
    if (length < 0) throw new Error('HOSTED_CONVERSATION_FILE_RANGE_INVALID');
    const bytes = new Uint8Array(length);
    let written = 0;
    await receive(
      nodeId,
      file,
      {
        async write(chunk) {
          bytes.set(chunk, written);
          written += chunk.byteLength;
        },
        async close() {},
        async abort() {}
      },
      signal,
      { offset, length }
    );
    return bytes;
  }

  async function download(target: HostedFileTarget, signal: AbortSignal): Promise<void> {
    const file = await describe(target, signal);
    signal.throwIfAborted();
    await downloadWorkspaceFileToBrowser({
      fileName: file.displayName,
      size: file.size,
      ...(options.activeWorker === undefined ? {} : { activeWorker: options.activeWorker }),
      download: (sink, sinkSignal) =>
        receive(
          target.nodeId,
          file,
          sink,
          sinkSignal === undefined ? signal : AbortSignal.any([signal, sinkSignal])
        )
    });
  }

  function objectUrl(
    nodeId: string,
    file: ConversationFileProjection,
    signal: AbortSignal
  ): Promise<string | undefined> {
    if (file.size > MAX_BINARY_PREVIEW_BYTES) return Promise.resolve(undefined);
    return readWorkspaceFileObjectUrl(file.displayName, signal, (sink) =>
      receive(nodeId, file, sink, signal)
    );
  }

  return { describe, readRange, download, objectUrl };
}
