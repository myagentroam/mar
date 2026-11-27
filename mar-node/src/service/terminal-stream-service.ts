import { randomUUID } from 'node:crypto';
import {
  decodeTerminalMessage,
  encodeTerminalMessage,
  terminalDataFrameSchema,
  type TerminalDataFrame
} from '@myagentroam/protocol';
import type { NodeStream } from '@myagentroam/protocol/node-stream';
import type { NodeStreamHandler } from '@myagentroam/protocol/node-stream-mux';
import { readTerminalRecords, writeTerminalRecord } from '@myagentroam/protocol/terminal-stream';
import type { TerminalManager } from '../terminal.js';

type Attachment = {
  terminalId: string;
  workspaceId: string | null;
  afterSequence: number;
  readonly: boolean;
  closeOnDisconnect: boolean;
};

/** Owns pending Terminal grants and stream attachments, never the carrier or Terminal process. */
export class TerminalStreamService {
  private readonly grants = new Map<string, { request: Attachment; expiry: NodeJS.Timeout }>();

  constructor(private readonly manager: TerminalManager) {}

  issue(request: Attachment): string {
    const grant = randomUUID();
    const expiry = setTimeout(() => this.grants.delete(grant), 15_000);
    expiry.unref();
    this.grants.set(grant, { request, expiry });
    return grant;
  }

  consume(grant: string): NodeStreamHandler | undefined {
    const pending = this.grants.get(grant);
    if (pending === undefined) return undefined;
    this.grants.delete(grant);
    clearTimeout(pending.expiry);
    return (stream, signal) => this.attach(pending.request, stream, signal);
  }

  clear(): void {
    for (const { expiry } of this.grants.values()) clearTimeout(expiry);
    this.grants.clear();
  }

  /** Starts the domain handler only after its carrier has consumed a bound grant. */
  async attach(
    request: Attachment,
    stream: NodeStream,
    signal: AbortSignal,
    onAttached?: () => void
  ): Promise<void> {
    const { terminalId, afterSequence } = request;
    if (signal.aborted) return;
    let attachment: ReturnType<TerminalManager['authorizeAttach']>;
    try {
      if (this.manager.get(terminalId).workspaceId !== request.workspaceId)
        throw new Error('TERMINAL_WORKSPACE_MISMATCH');
      attachment = this.manager.authorizeAttach(request);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      stream.reset(
        [
          'TERMINAL_ATTACH_CONFLICT',
          'TERMINAL_CLOSED',
          'TERMINAL_NOT_FOUND',
          'TERMINAL_WORKSPACE_MISMATCH'
        ].includes(code)
          ? code
          : 'TERMINAL_ATTACH_FAILED'
      );
      return;
    }

    const { attachmentId } = attachment;
    let queued = 0;
    const finished = Promise.withResolvers<void>();
    const finish = () => finished.resolve();
    signal.addEventListener('abort', finish, { once: true });
    const disconnected = () => stream.reset('TERMINAL_STREAM_DISCONNECTED');
    // Replay is already bounded by the manager. Encode one record at a time and let
    // the stream window pace it; only new output competes for the live queue budget.
    let output = Promise.resolve()
      .then(async () => {
        if (signal.aborted) return;
        await stream.write(
          writeTerminalRecord(encodeTerminalMessage({ type: 'attach', terminalId, afterSequence }))
        );
        for (const frame of attachment.frames) {
          if (signal.aborted) return;
          await stream.write(writeTerminalRecord(encodeTerminalMessage(frame)));
        }
      })
      .catch(disconnected);
    const enqueue = (frame: TerminalDataFrame) => {
      if (signal.aborted) return;
      const bytes = writeTerminalRecord(encodeTerminalMessage(frame));
      queued += bytes.length;
      if (queued > 2 * 1024 * 1024) {
        stream.reset('TERMINAL_BACKPRESSURE');
        return;
      }
      if (queued > 512 * 1024) this.manager.setAttachmentBackpressure(attachmentId, true);
      output = output
        .then(async () => {
          if (signal.aborted) return;
          await stream.write(bytes);
          if (frame.type === 'exit') {
            await stream.endWrite();
            finish();
          }
          queued -= bytes.length;
          if (queued <= 256 * 1024) this.manager.setAttachmentBackpressure(attachmentId, false);
        })
        .catch(disconnected);
    };
    const stop = this.manager.onFrame((frame) => {
      if (frame.terminalId === terminalId) enqueue(frame);
    });

    try {
      if (!signal.aborted) {
        this.manager.startCommand(terminalId);
        onAttached?.();
      }
      await Promise.all([
        receiveInput(this.manager, attachmentId, terminalId, stream),
        finished.promise
      ]);
    } finally {
      signal.removeEventListener('abort', finish);
      stop();
      this.manager.releaseTransportAttachment(attachmentId);
    }
  }
}

async function receiveInput(
  manager: TerminalManager,
  attachmentId: string,
  terminalId: string,
  stream: NodeStream
) {
  for await (const record of readTerminalRecords(stream)) {
    const frame = terminalDataFrameSchema.parse(decodeTerminalMessage(record));
    if (
      frame.terminalId !== terminalId ||
      !['input', 'eof', 'resize', 'close'].includes(frame.type)
    )
      throw new Error('TERMINAL_FRAME_INVALID');
    await manager.acceptFrame(attachmentId, frame);
  }
}
