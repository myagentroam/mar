import { browserRecordWriter, readBrowserRecords } from '@myagentroam/protocol/browser-stream';
import type { BrowserAttachmentOpen, BrowserAttachmentRoute } from '@myagentroam/protocol';
import type { NodeStream } from '@myagentroam/protocol/node-stream';
import type {
  BrowserAttachmentChannel,
  BrowserAttachmentService
} from './browser-attachment-service.js';

/** Bridges Browser records; the attachment service owns activation, commands and its lease. */
export async function serveBrowserStream(
  service: BrowserAttachmentService,
  open: BrowserAttachmentOpen,
  route: BrowserAttachmentRoute,
  stream: NodeStream
): Promise<void> {
  const write = browserRecordWriter(stream);
  const channel: BrowserAttachmentChannel = {
    sendControl(event) {
      void write(JSON.stringify(event)).catch(() => stream.reset('BROWSER_LINK_UNAVAILABLE'));
    },
    sendFrame: write,
    close: (code) => stream.reset(code)
  };
  try {
    await service.open(open, route, channel);
    for await (const record of readBrowserRecords(stream)) {
      if (typeof record !== 'string') throw new Error('BROWSER_INVALID_MESSAGE');
      service.receive(open.attachmentId, channel, JSON.parse(record));
    }
  } catch {
    stream.reset('BROWSER_DISCONNECTED');
  } finally {
    await service.disconnected(open.attachmentId, channel);
  }
}
