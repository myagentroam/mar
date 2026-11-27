import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { NodeConnector } from '../../mar-node/src/connector.js';
import { unavailableCapabilities } from '../../mar-node/src/capabilities.js';
import type { WorkspaceUploadService } from '../../mar-node/src/workspace/workspace-upload-service.js';
import { workspaceUploadTemporaryName } from '../../mar-node/src/workspace/files.js';
import type { harness } from '../../packages/web-core/test/e2e/workspace-upload-flow.js';
import { NODE_STREAM_CHUNK_BYTES } from '../../packages/protocol/src/node-stream-wire.js';
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

test('Workspace streams preserve direct upload recovery and reuse the Relay carrier for file round trips', async ({
  page,
  baseURL
}, testInfo) => {
  test.setTimeout(90_000);
  page.on('pageerror', (error) => console.log('Upload fixture error:', error.message));
  const directory = await mkdtemp(join(tmpdir(), 'mar-workspace-upload-flow-'));
  try {
    const historyBytes = Buffer.alloc(600_013, 0xd2);
    for (let i = 0; i < historyBytes.length; i++) historyBytes[i] = i % 251;
    const historyImage = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64'
    );
    const workingImage = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGP47NtIEmIY1TCqYfhqAAAlYMEQZSHRQgAAAABJRU5ErkJggg==',
      'base64'
    );
    const git = (...args: string[]) => promisify(execFile)('git', ['-C', directory, ...args]);
    await git('init', '--initial-branch=main');
    await writeFile(join(directory, 'history.bin'), historyBytes);
    await writeFile(join(directory, 'history.txt'), 'Committed text: 汉字\n');
    await writeFile(join(directory, 'history.png'), historyImage);
    await git('add', 'history.bin', 'history.txt', 'history.png');
    await git(
      '-c',
      'user.name=Workspace Test',
      '-c',
      'user.email=workspace@example.test',
      '-c',
      'commit.gpgSign=false',
      'commit',
      '-m',
      'Add history fixture'
    );
    const commit = (await git('rev-parse', 'HEAD')).stdout.trim();
    await writeFile(join(directory, 'history.bin'), 'Changed after the commit');
    await writeFile(join(directory, 'history.txt'), 'Working text: 汉字\n');
    await writeFile(join(directory, 'history.png'), workingImage);
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
      workspaceUploadService: WorkspaceUploadService;
      nodeGeneration: string;
    };
    const uploads = internals.workspaceUploadService;
    let stagedId = '';
    let stagedHash: unknown;
    let completeCalls = 0;
    const firstWrite = gate();
    const firstWritten = gate();
    const lastWritten = gate();
    const continueLastWrite = gate();
    let pauseWrite = true;
    let pauseLastWrite = false;
    const write = uploads.writeDirect.bind(uploads);
    uploads.writeDirect = async (...args) => {
      const offset = await write(...args);
      if (pauseWrite) {
        pauseWrite = false;
        firstWritten.release();
        await firstWrite.promise;
      } else if (pauseLastWrite && offset === uploads.status(args[0]).size) {
        lastWritten.release();
        await continueLastWrite.promise;
      }
      return offset;
    };
    const create = uploads.create.bind(uploads);
    uploads.create = async (...args) => {
      const result = await create(...args);
      if (args[1].streamStaging) {
        stagedId = result.uploadId;
        stagedHash = args[1].sha256;
      }
      return result;
    };
    const complete = uploads.complete.bind(uploads);
    uploads.complete = (...args) => {
      completeCalls++;
      return complete(...args);
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
        const fixture = await page.goto(fixturePath);
        expect(fixture?.ok(), 'The Vite upload fixture must be served').toBe(true);
        await expect(page).toHaveTitle('Workspace upload functional fixture');
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
      const staged = uploads.status(stagedId);
      const temporaryPath = join(directory, workspaceUploadTemporaryName(staged.uploadId));
      const resumeOffset = staged.receivedBytes;
      expect(resumeOffset).toBe(NODE_STREAM_CHUNK_BYTES);
      expect(stagedHash).toBe(sha256);
      expect(completeCalls).toBe(0);
      await expect(readFile(join(directory, 'resumed.bin'))).rejects.toMatchObject({
        code: 'ENOENT'
      });
      expect(await readFile(temporaryPath)).toEqual(bytes.subarray(0, staged.receivedBytes));
      await page.evaluate(() => window.uploadFlow.interrupt());
      await expect
        .poll(() => page.evaluate(() => window.uploadFlow.snapshot().tasks[0]?.status))
        .toBe('FAILED');
      firstWrite.release();
      const failed = await page.evaluate(() => window.uploadFlow.snapshot());
      expect(failed.tasks[0]?.error).toBeTruthy();
      expect(failed.prepares.filter((message) => message.purpose === 'TRANSFER')).toHaveLength(1);
      expect(failed.prepares.find((message) => message.purpose === 'TRANSFER')).toMatchObject({
        transfer: { sha256, size: bytes.length, uploadId: staged.uploadId }
      });
      expect(failed.progress[0]).toBe(0);
      expect(failed.grants).toHaveLength(1);
      expect(failed.channels).toEqual(['mar-node-stream']);
      expect(failed.httpUploadCalls).toBe(0);
      await page.getByRole('button', { name: 'Sessions & notifications' }).click();
      await page.getByRole('tab', { name: 'Notifications', exact: true }).click();
      const row = page.locator('.workbench-notification-upload');
      await expect(row).toContainText('resumed.bin');
      await expect(row.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled();
      expect(uploads.status(staged.uploadId)).toEqual(staged);
      // No automatic reauthorization or relay while the user reads the error.
      await page.waitForTimeout(750);
      expect((await page.evaluate(() => window.uploadFlow.snapshot())).prepares).toHaveLength(
        failed.prepares.length
      );
      expect(uploads.status(staged.uploadId).receivedBytes).toBe(resumeOffset);
      await page.evaluate(() => window.uploadFlow.dispose());
      await initialize();
      await page.getByRole('button', { name: 'Sessions & notifications' }).click();
      await page.getByRole('tab', { name: 'Notifications', exact: true }).click();
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
      expect(resumed.channels).toEqual(['mar-node-stream']);
      expect(resumed.grants[0]).not.toBe(failed.grants[0]);
      expect(resumed.completed).toEqual(resumed.grants);
      expect(resumed.progress[0]).toBe(resumeOffset);
      expect(resumed.httpUploadCalls).toBe(0);
      expect(resumed.tasks[0]?.cleanupUnconfirmed).toBe(false);
      expect(completeCalls).toBe(1);
      expect(await readFile(join(directory, 'resumed.bin'))).toEqual(bytes);
      expect(() => uploads.status(staged.uploadId)).toThrow('UPLOAD_NOT_FOUND');
      await expect(row).toHaveCount(0);

      const relaySockets: string[] = [];
      page.on('websocket', (socket) => {
        if (new URL(socket.url()).pathname.startsWith('/api/relay/'))
          relaySockets.push(socket.url());
      });
      const direct = await page.evaluate(() => window.uploadFlow.fileRoundtrip('direct'));
      const directComposer = await page.evaluate(() =>
        window.uploadFlow.uploadComposerAttachment('direct')
      );
      expect(await page.evaluate(() => window.uploadFlow.previewText('direct'))).toBe(
        'Working text: 汉字\n'
      );
      expect(await page.evaluate(() => window.uploadFlow.previewImage())).toEqual({
        bytes: [...workingImage],
        width: 16
      });
      expect(relaySockets).toHaveLength(0);
      expect((await page.evaluate(() => window.uploadFlow.snapshot())).channels).toEqual(
        resumed.channels
      );
      const relayed = await page.evaluate(() => window.uploadFlow.fileRoundtrip('relay'));
      expect(relaySockets).toHaveLength(1);
      expect(
        await page.evaluate((sha) => window.uploadFlow.previewText('relay', sha), commit)
      ).toBe('Committed text: 汉字\n');
      expect(await page.evaluate((sha) => window.uploadFlow.previewImage(sha), commit)).toEqual({
        bytes: [...historyImage],
        width: 1
      });
      const attachmentDownload = page.waitForEvent('download');
      const composer = await page.evaluate(() =>
        window.uploadFlow.uploadComposerAttachment('relay', true)
      );
      const attachmentSaved = await attachmentDownload;
      expect(attachmentSaved.suggestedFilename()).toBe('composer.txt');
      expect(await readFile((await attachmentSaved.path())!, 'utf8')).toBe(
        'composer stream bytes\n'
      );
      expect(directComposer).toEqual(composer);
      expect(composer).toEqual({
        receivedBytes: 22,
        body: 'composer stream bytes\n',
        uploadCalls: []
      });
      expect(relaySockets).toHaveLength(1);
      await expect(readFile(join(directory, 'composer.txt'))).rejects.toMatchObject({
        code: 'ENOENT'
      });
      const range = bytes.subarray(17, -15);
      for (const [path, result] of [
        ['direct', direct],
        ['relay', relayed]
      ] as const) {
        expect(result.calls).toEqual([
          expect.stringMatching(/\/uploads$/u),
          expect.stringMatching(/\/uploads\/[^/]+\/complete$/u)
        ]);
        expect(result.tail).toEqual([...bytes.subarray(-13)]);
        expect(result.sha256).toBe(createHash('sha256').update(range).digest('hex'));
        expect(await readFile(join(directory, `${path}-staged.bin`))).toEqual(range);
      }

      const fileDownload = page.waitForEvent('download');
      await expect(
        page.evaluate(() => window.uploadFlow.downloadToBrowser('resumed.bin'))
      ).resolves.toBe('COMPLETED');
      const saved = await fileDownload;
      expect(saved.suggestedFilename()).toBe('resumed.bin');
      expect(await readFile((await saved.path())!)).toEqual(bytes);
      const gitDownload = page.waitForEvent('download');
      await expect(
        page.evaluate((sha) => window.uploadFlow.downloadToBrowser('history.bin', sha), commit)
      ).resolves.toBe('COMPLETED');
      const historySaved = await gitDownload;
      expect(historySaved.suggestedFilename()).toBe('history.bin');
      expect(await readFile((await historySaved.path())!)).toEqual(historyBytes);
      const imageDownload = page.waitForEvent('download');
      await expect(
        page.evaluate(() => window.uploadFlow.downloadToBrowser('history.png'))
      ).resolves.toBe('COMPLETED');
      const imageSaved = await imageDownload;
      expect(imageSaved.suggestedFilename()).toBe('history.png');
      expect(await readFile((await imageSaved.path())!)).toEqual(workingImage);
      expect(relaySockets).toHaveLength(1);
      await expect(
        page.evaluate((sha) => window.uploadFlow.readGitRange(sha, ['refs/heads/other']), commit)
      ).rejects.toThrow('GIT_HISTORY_REF_INVALID');
      await expect(
        page.evaluate((sha) => window.uploadFlow.readGitRange(sha, ['refs/heads/main']), commit)
      ).resolves.toEqual([...historyBytes.subarray(524_319, 524_402)]);

      const beforeCancel = await page.evaluate(() => window.uploadFlow.snapshot());
      // ICE reused the carrier for two explicit ranges, text preview, staged upload, and
      // both the Composer attachment upload and its read-only preview.
      expect(beforeCancel.completed).toHaveLength(resumed.completed.length + 6);
      const completeBeforeCancel = completeCalls;
      pauseLastWrite = true;
      await page.getByLabel('Upload source').setInputFiles({
        name: 'cancelled.bin',
        mimeType: 'application/octet-stream',
        buffer: bytes
      });
      await expect.poll(lastWritten.ready).toBe(true);
      const verifying = uploads.status(stagedId);
      const verifyingPath = join(directory, workspaceUploadTemporaryName(verifying.uploadId));
      expect(await readFile(verifyingPath)).toEqual(bytes);
      await row.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect
        .poll(() => page.evaluate(() => window.uploadFlow.snapshot().bodyAborted))
        .toBe(true);
      continueLastWrite.release();
      await expect
        .poll(() => page.evaluate(() => window.uploadFlow.snapshot().tasks[1]?.status))
        .toBe('CANCELLED');
      expect(completeCalls).toBe(completeBeforeCancel);
      await expect(readFile(join(directory, 'cancelled.bin'))).rejects.toMatchObject({
        code: 'ENOENT'
      });
      const cancelled = await page.evaluate(() => window.uploadFlow.snapshot());
      expect(cancelled.completed).toEqual(beforeCancel.completed);
      expect(cancelled.tasks[1]?.cleanupUnconfirmed).toBe(false);
      expect(cancelled.httpUploadCalls).toBe(0);
      expect(() => uploads.status(verifying.uploadId)).toThrow('UPLOAD_NOT_FOUND');
      await expect(readFile(verifyingPath)).rejects.toMatchObject({ code: 'ENOENT' });

      // The independent window owns its own connection and must work without an ICE-capable peer.
      await page.route('**/workbench-capabilities', (route) => route.fulfill({ json: {} }));
      const unexpectedHttpBody: string[] = [];
      page.on('request', (request) => {
        if (/\/files\/(content|read)$/u.test(new URL(request.url()).pathname))
          unexpectedHttpBody.push(request.url());
      });
      const standaloneDownload = page.waitForEvent('download');
      await expect(
        page.evaluate(() => window.uploadFlow.roundTripFromStandalone('resumed.bin'))
      ).resolves.toEqual({ preview: [...bytes.subarray(0, 16)], download: 'COMPLETED' });
      const standaloneSaved = await standaloneDownload;
      expect(standaloneSaved.suggestedFilename()).toBe('resumed.bin');
      expect(await readFile((await standaloneSaved.path())!)).toEqual(bytes);
      expect(relaySockets).toHaveLength(2);
      expect(unexpectedHttpBody).toEqual([]);
      await testInfo.attach('upload-functional-summary', {
        body: JSON.stringify({
          sha256,
          offset: resumeOffset,
          freshGrant: true,
          bodyCancelledBeforeCommit: cancelled.bodyAborted,
          normalCompleteEvents: resumed.completed.length,
          cancelledCompleteEvents: cancelled.completed.length,
          httpUploadCalls: cancelled.httpUploadCalls
        }),
        contentType: 'application/json'
      });
    } finally {
      firstWrite.release();
      continueLastWrite.release();
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
