import { browserRecordWriter, readBrowserRecords } from '@myagentroam/protocol/browser-stream';
import type { NodeStream } from '@myagentroam/protocol/node-stream';

export interface BrowserMessageLink {
  send(text: string): void;
  close(): void;
  subscribe(message: (data: string | Uint8Array<ArrayBuffer>) => void, close: () => void): void;
}

/** Wraps one Browser child stream without owning or closing its carrier. */
export class BrowserRecordLink implements BrowserMessageLink {
  private readonly write;

  constructor(private readonly stream: NodeStream) {
    this.write = browserRecordWriter(stream);
  }

  send(text: string): void {
    void this.write(text).catch(() => this.stream.reset('BROWSER_LINK_UNAVAILABLE'));
  }

  close(): void {
    this.stream.close();
  }

  subscribe(message: (data: string | Uint8Array<ArrayBuffer>) => void, close: () => void): void {
    void (async () => {
      for await (const record of readBrowserRecords(this.stream)) message(record);
    })().then(close, close);
  }
}
