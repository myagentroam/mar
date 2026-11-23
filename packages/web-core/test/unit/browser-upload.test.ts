import { randomUUID } from 'node:crypto';
import type { BrowserUpload } from '@myagentroam/protocol';
import { expect, it } from 'vitest';
import { uploadBrowserFiles } from '../../src/service/browser-upload.js';
import type { WorkbenchHttpService } from '../../src/service/workbench-http-service.js';
import { ApiError } from '../../src/util/api-error.js';

it.each(['NETWORK_UNAVAILABLE', 'NODE_REQUEST_TIMEOUT'])(
  'does not replay a finish after %s',
  async (code) => {
    const actions: string[] = [];
    const http = (async (_path, init) => {
      const { command } = JSON.parse(init!.body as string) as BrowserUpload;
      actions.push(command.action);
      if (command.action === 'finish') throw new ApiError(code, 'Response not received.');
      return {};
    }) as WorkbenchHttpService['request'];

    await expect(
      uploadBrowserFiles(
        http,
        'workbench',
        { attachmentId: randomUUID(), chooserId: randomUUID() },
        [new File(['text'], 'upload.txt')],
        { signal: new AbortController().signal, finishing: () => actions.push('finishing') }
      )
    ).rejects.toThrow('BROWSER_OUTCOME_UNKNOWN');
    expect(actions).toEqual(['begin', 'file', 'chunk', 'finishing', 'finish']);
  }
);
