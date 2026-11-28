import { randomUUID } from 'node:crypto';
import type { BrowserUpload, BrowserUploadStream } from '@myagentroam/protocol';
import { encodeUploadOffset } from '@myagentroam/protocol/file-upload-stream';
import { NodeStream } from '@myagentroam/protocol/node-stream';
import { expect, it, vi } from 'vitest';
import { uploadBrowserFiles } from '../../src/service/browser-upload.js';
import type { WorkbenchHttpService } from '../../src/service/workbench-http-service.js';
import { ApiError } from '../../src/util/api-error.js';

it.each(['NETWORK_UNAVAILABLE', 'NODE_REQUEST_TIMEOUT'])(
  'does not replay a finish after %s',
  async (code) => {
    const actions: string[] = [];
    const http = (async (path, init) => {
      expect(typeof init!.body).toBe('string');
      const { command } = JSON.parse(init!.body as string) as BrowserUpload | BrowserUploadStream;
      actions.push(command.action);
      if (command.action === 'stream') {
        expect(path).toBe('/api/browser/uploads/stream-ticket?connectionId=workbench');
        expect(command.index).toBe(0);
        return { ticket: 'file-ticket' };
      }
      if (command.action === 'finish') throw new ApiError(code, 'Response not received.');
      return {};
    }) as WorkbenchHttpService['request'];

    await expect(
      uploadBrowserFiles(
        http,
        'workbench',
        { attachmentId: randomUUID(), chooserId: randomUUID() },
        [new File(['text'], 'upload.txt')],
        {
          signal: new AbortController().signal,
          finishing: () => actions.push('finishing'),
          async openStream(issueTicket, signal) {
            expect(await issueTicket(signal)).toBe('file-ticket');
            const stream = new NodeStream(
              1,
              async (frame) => {
                if (frame.type === 'DATA') {
                  expect(Buffer.from(frame.bytes).toString()).toBe('text');
                  actions.push('body');
                  stream.receive({ type: 'DATA', streamId: 1, bytes: encodeUploadOffset(4) });
                }
                if (frame.type === 'FIN') stream.receive({ type: 'FIN', streamId: 1 });
              },
              () => undefined
            );
            stream.receive({ type: 'DATA', streamId: 1, bytes: encodeUploadOffset(0) });
            return stream;
          }
        }
      )
    ).rejects.toThrow('BROWSER_OUTCOME_UNKNOWN');
    expect(actions).toEqual(['begin', 'file', 'stream', 'body', 'finishing', 'finish']);
  }
);

it('can reissue the same file ticket without restarting upload controls', async () => {
  const controls: BrowserUpload[] = [];
  const tickets: BrowserUploadStream[] = [];
  const http = (async (path, init) => {
    if (path.startsWith('/api/browser/uploads/stream-ticket?')) {
      tickets.push(JSON.parse(String(init?.body)) as BrowserUploadStream);
      return { ticket: `ticket-${tickets.length}` };
    }
    controls.push(JSON.parse(String(init?.body)) as BrowserUpload);
    return {};
  }) as WorkbenchHttpService['request'];
  const selection = { attachmentId: randomUUID(), chooserId: randomUUID() };
  const finishing = vi.fn();

  await expect(
    uploadBrowserFiles(http, 'workbench', selection, [new File(['text'], 'upload.txt')], {
      signal: new AbortController().signal,
      finishing,
      async openStream(issueTicket, signal) {
        expect(await issueTicket(signal)).toBe('ticket-1');
        expect(await issueTicket(signal)).toBe('ticket-2');
        throw new Error('STREAM_FAILED');
      }
    })
  ).rejects.toThrow('STREAM_FAILED');
  expect(finishing).not.toHaveBeenCalled();
  expect(controls.map(({ command }) => command.action)).toEqual(['begin', 'file']);
  const command = controls[0]!.command;
  if (command.action !== 'begin') throw new Error('Expected begin');
  const expected = {
    ...selection,
    command: { action: 'stream', transferId: command.transferId, index: 0 }
  };
  expect(tickets).toEqual([expected, expected]);
});
