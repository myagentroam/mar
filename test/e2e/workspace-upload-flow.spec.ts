import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { NodeConnector } from '../../mar-node/src/connector.js';
import { unavailableCapabilities } from '../../mar-node/src/capabilities.js';
import type { WorkspaceDomainState } from '../../mar-node/src/service/workspace-domain-state.js';
import type { WorkspaceUploadService } from '../../mar-node/src/service/workspace-upload-service.js';
import type { harness } from '../../packages/web-core/test/e2e/workspace-upload-flow.js';
import { INITIAL_ADMIN_PASSWORD } from '../../packages/server-core/src/password.js';

declare global {
  interface Window {
    uploadFlow: typeof harness;
  }
}

function gate() {
  let release!: () => void;
  let ready = false;
  return {
    promise: new Promise<void>((resolve) => {
      release = resolve;
    }),
    ready: () => ready,
    release: () => {
      ready = true;
      release();
    }
  };
}

test('Workspace direct upload uses fresh Server grants, real Node offsets, explicit recovery and cancellation during verification', async ({
  page,
  baseURL
}, testInfo) => {
  test.setTimeout(90_000);
  page.on('pageerror', (error) => console.log('Upload fixture error:', error.message));
  const directory = await mkdtemp(join(tmpdir(), 'mar-workspace-upload-flow-'));
  try {
    const password = 'upload-flow-test-password-123';
    const login = await page.request.post('/api/auth/login', {
      data: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
    });
    expect(login.ok()).toBe(true);
    const changed = await page.request.post('/api/auth/change-password', {
      headers: { 'x-csrf-token': (await login.json()).csrfToken },
      data: { currentPassword: INITIAL_ADMIN_PASSWORD, password }
    });
    expect(changed.ok()).toBe(true);
    const csrfToken = (await changed.json()).csrfToken as string;
    const headers = { 'x-csrf-token': csrfToken };
    const token = await page.request.post('/api/node-registration-tokens', {
      headers,
      data: { displayName: 'Upload functional test Node' }
    });
    expect(token.ok(), await token.text()).toBe(true);
    const serverUrl = new URL(baseURL!);
    serverUrl.port = process.env.MAR_E2E_SERVER_PORT ?? String(Number(serverUrl.port) + 1);
    const connector = new NodeConnector({
      configPath: join(directory, 'node.json'),
      config: {
        serverUrl: serverUrl.origin,
        allowedRoots: [directory],
        registrationToken: (await token.json()).token,
        directTransfer: { udpPortRangeBegin: 50180, udpPortRangeEnd: 50240 }
      },
      capabilities: unavailableCapabilities(),
      capabilityDetector: async () => unavailableCapabilities(),
      reconnect: false
    });
    // Observe and schedule real production operations; do not replace the transport, grants or bytes.
    const internals = connector as unknown as {
      workspaceState: WorkspaceDomainState;
      workspaceUploadService: WorkspaceUploadService;
      nodeGeneration: string;
    };
    const uploads = internals.workspaceUploadService;
    const firstWrite = gate();
    const firstWritten = gate();
    const hashing = gate();
    const continueHash = gate();
    const completionSettled = gate();
    let pauseWrite = true;
    let pauseHash = false;
    let completionSignal: AbortSignal | undefined;
    let completionError: string | undefined;
    const write = uploads.writeDirect.bind(uploads);
    uploads.writeDirect = async (...args) => {
      const offset = await write(...args);
      if (pauseWrite) {
        pauseWrite = false;
        firstWritten.release();
        await firstWrite.promise;
      }
      return offset;
    };
    const create = uploads.createDirect.bind(uploads);
    uploads.createDirect = async (...args) => {
      const result = await create(...args);
      if (pauseHash) {
        const upload = internals.workspaceState.uploads.get(result.uploadId)!;
        const readStream = upload.handle.createReadStream.bind(upload.handle);
        upload.handle.createReadStream = (...options) => {
          const stream = readStream(...options);
          const iterate = stream[Symbol.asyncIterator].bind(stream);
          stream[Symbol.asyncIterator] = async function* () {
            for await (const bytes of { [Symbol.asyncIterator]: iterate }) {
              hashing.release();
              await continueHash.promise;
              yield bytes;
            }
            return undefined;
          };
          return stream;
        };
      }
      return result;
    };
    const complete = uploads.completeDirect.bind(uploads);
    uploads.completeDirect = async (id, size, signal) => {
      if (pauseHash) completionSignal = signal;
      try {
        await complete(id, size, signal);
      } catch (error) {
        completionError = (error as Error).message;
        throw error;
      } finally {
        if (pauseHash) completionSettled.release();
      }
    };
    try {
      await connector.start();
      let nodeId = '';
      await expect
        .poll(async () => {
          const nodes = (await (await page.request.get('/api/nodes')).json()).nodes as {
            id: string;
            connected: boolean;
          }[];
          nodeId = nodes.find((node) => node.connected)?.id ?? '';
          return nodeId;
        })
        .not.toBe('');
      const registered = await page.request.post('/api/workspaces', {
        headers,
        data: { nodeId, path: directory }
      });
      expect(registered.ok()).toBe(true);
      const workspaceId = (await registered.json()).workspace.id as string;
      const fixturePath = `/@fs/${resolve('test/e2e/support/workspace-upload-flow.html')}`;
      const initialize = async () => {
        await page.goto(fixturePath);
        await page.waitForFunction(() => window.uploadFlow !== undefined, undefined, {
          timeout: 15_000
        });
        await page.evaluate((input) => window.uploadFlow.initialize(input), {
          nodeId,
          workspaceId,
          generation: internals.nodeGeneration,
          csrfToken
        });
        await expect.poll(() => page.evaluate(() => window.uploadFlow.ready())).toBe(true);
        expect(await page.evaluate(() => window.uploadFlow.connect())).toBe('DIRECT_AVAILABLE');
      };
      await initialize();
      const bytes = Buffer.alloc(700_003);
      for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      await page.getByLabel('Upload source').setInputFiles({
        name: 'resumed.bin',
        mimeType: 'application/octet-stream',
        buffer: bytes
      });
      await expect.poll(firstWritten.ready).toBe(true);
      const staged = [...internals.workspaceState.uploads.values()][0]!;
      const resumeOffset = staged.receivedBytes;
      expect(resumeOffset).toBe(256 * 1024);
      expect(staged.directSha256).toBe(sha256);
      expect(await readFile(staged.temporaryPath)).toEqual(bytes.subarray(0, staged.receivedBytes));
      await page.evaluate(() => window.uploadFlow.interrupt());
      await expect
        .poll(() => page.evaluate(() => window.uploadFlow.snapshot().tasks[0]?.status))
        .toBe('FAILED');
      firstWrite.release();
      const failed = await page.evaluate(() => window.uploadFlow.snapshot());
      expect(failed.tasks[0]?.error).toBeTruthy();
      expect(failed.prepares.filter((message) => message.purpose === 'TRANSFER')).toHaveLength(1);
      expect(failed.prepares.find((message) => message.purpose === 'TRANSFER')).toMatchObject({
        transfer: { sha256, size: bytes.length }
      });
      expect(failed.progress[0]).toBe(0);
      expect(failed.grants).toHaveLength(1);
      expect(failed.httpUploadCalls).toBe(0);
      await page.getByRole('button', { name: 'Open notification center' }).click();
      const row = page.locator('.workbench-notification-upload');
      await expect(row).toContainText('resumed.bin');
      await expect(row.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled();
      expect(internals.workspaceState.uploads.get(staged.id)).toBe(staged);
      // No automatic reauthorization or relay while the user reads the error.
      await page.waitForTimeout(750);
      expect((await page.evaluate(() => window.uploadFlow.snapshot())).prepares).toHaveLength(
        failed.prepares.length
      );
      expect(staged.receivedBytes).toBe(resumeOffset);
      await page.evaluate(() => window.uploadFlow.dispose());
      await initialize();
      await page.getByRole('button', { name: 'Open notification center' }).click();
      await expect(row).toContainText('resumed.bin');
      expect((await page.evaluate(() => window.uploadFlow.snapshot())).tasks[0]?.status).toBe(
        'INTERRUPTED'
      );
      const chooser = page.waitForEvent('filechooser');
      await row.getByRole('button', { name: 'Resume', exact: true }).click();
      await (
        await chooser
      ).setFiles({ name: 'resumed.bin', mimeType: 'application/octet-stream', buffer: bytes });
      await expect
        .poll(() => page.evaluate(() => window.uploadFlow.snapshot().tasks[0]?.status))
        .toBe('COMPLETED');
      const resumed = await page.evaluate(() => window.uploadFlow.snapshot());
      expect(resumed.grants).toHaveLength(1);
      expect(resumed.grants[0]).not.toBe(failed.grants[0]);
      expect(resumed.completed).toEqual(resumed.grants);
      expect(resumed.progress[0]).toBe(resumeOffset);
      expect(resumed.httpUploadCalls).toBe(0);
      expect(resumed.tasks[0]?.cleanupUnconfirmed).toBe(false);
      expect(await readFile(join(directory, 'resumed.bin'))).toEqual(bytes);
      expect(internals.workspaceState.uploads.size).toBe(0);
      await expect(row).toHaveCount(0);

      pauseHash = true;
      await page.getByLabel('Upload source').setInputFiles({
        name: 'cancelled.bin',
        mimeType: 'application/octet-stream',
        buffer: bytes
      });
      await expect.poll(hashing.ready).toBe(true);
      expect(completionSignal).toBeDefined();
      expect(completionSignal!.aborted).toBe(false);
      const verifying = [...internals.workspaceState.uploads.values()][0]!;
      expect(await readFile(verifying.temporaryPath)).toEqual(bytes);
      await row.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect.poll(() => completionSignal?.aborted).toBe(true);
      continueHash.release();
      await expect.poll(completionSettled.ready).toBe(true);
      expect(completionError).toBe('UPLOAD_CANCELLED');
      await expect(readFile(join(directory, 'cancelled.bin'))).rejects.toMatchObject({
        code: 'ENOENT'
      });
      // Channel closure can arrive before control-plane cancel. Without a cleanup receipt,
      // either remote outcome must remain visible as uncertainty until explicit deletion.
      const retainedAfterCancellation = internals.workspaceState.uploads.has(verifying.id);
      const cancelled = await page.evaluate(() => window.uploadFlow.snapshot());
      expect(cancelled.completed).toEqual(resumed.completed);
      expect(cancelled.tasks[1]?.status).toBe('FAILED');
      expect(cancelled.tasks[1]?.cleanupUnconfirmed).toBe(true);
      expect(cancelled.httpUploadCalls).toBe(0);
      await expect(row).toContainText('cancelled.bin');
      await expect(row).toContainText('Temporary upload cleanup could not be confirmed');
      // Deleting a failed record is local and must not depend on a remote cleanup receipt.
      await row.getByRole('button', { name: 'Delete cancelled.bin', exact: true }).click();
      await expect(row).toHaveCount(0);
      expect(
        (await page.evaluate(() => window.uploadFlow.snapshot())).tasks.map((task) => task.name)
      ).not.toContain('cancelled.bin');
      // Fixture teardown uses the actual Node cleanup API; this is not a browser cleanup receipt.
      if (internals.workspaceState.uploads.has(verifying.id)) await uploads.cancel(verifying.id);
      expect(internals.workspaceState.uploads.size).toBe(0);
      await expect(readFile(verifying.temporaryPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await testInfo.attach('upload-functional-summary', {
        body: JSON.stringify({
          sha256,
          offset: resumeOffset,
          freshGrant: true,
          productionSignalAborted: completionSignal!.aborted,
          completionError,
          retainedAfterCancellation,
          normalCompleteEvents: resumed.completed.length,
          cancelledCompleteEvents: cancelled.completed.length,
          httpUploadCalls: cancelled.httpUploadCalls
        }),
        contentType: 'application/json'
      });
    } finally {
      firstWrite.release();
      continueHash.release();
      await page.evaluate(() => window.uploadFlow?.dispose()).catch(() => undefined);
      await connector.stop();
      await page.request.post('/api/auth/change-password', {
        headers,
        data: { currentPassword: password, password: INITIAL_ADMIN_PASSWORD }
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
