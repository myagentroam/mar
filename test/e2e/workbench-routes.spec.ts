import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createEnvelope, type NodeEnvelope } from '../../packages/protocol/src/index.js';
import { createServerApp } from '../../ee/server/src/app.js';
import { RunAttachmentService } from '../../mar-node/src/service/run-attachment-service.js';
import { INITIAL_ADMIN_PASSWORD } from '../../packages/server-core/src/password.js';

test('Fixed Workbench routes require Admin authorization and Files and Changes never fall back to generic RPC', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-agent-roam-workbench-server-'));
  const app = createServerApp({
    databasePath: join(directory, 'server.sqlite'),
    secureCookies: false
  });
  let socket: WebSocket | undefined;
  const attachments = new RunAttachmentService(() => [directory]);
  try {
    expect(
      (await app.inject({ method: 'GET', url: '/api/workbench-capabilities' })).statusCode
    ).toBe(401);
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
    });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/workbench-capabilities',
          headers: { cookie: cookieFrom(login.headers['set-cookie']) }
        })
      ).statusCode
    ).toBe(403);

    const changed = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: {
        cookie: cookieFrom(login.headers['set-cookie']),
        'x-csrf-token': login.json<{ csrfToken: string }>().csrfToken
      },
      payload: {
        currentPassword: INITIAL_ADMIN_PASSWORD,
        password: 'workbench-server-password-123'
      }
    });
    const headers = {
      cookie: cookieFrom(changed.headers['set-cookie']),
      'x-csrf-token': changed.json<{ csrfToken: string }>().csrfToken
    };
    expect(
      (await app.inject({ method: 'GET', url: '/api/workbench-capabilities', headers })).json()
    ).toMatchObject({
      workbenchProtocolVersion: 1,
      supportsSessionDetailStream: false,
      supportsTerminalBrowserRelay: true,
      supportsTerminalNodeDataChannel: true
    });

    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const token = await app.inject({
      method: 'POST',
      url: '/api/node-registration-tokens',
      headers
    });
    socket = new WebSocket(`${baseUrl.replace('http', 'ws')}/api/node/connect`);
    await opened(socket);
    socket.send(
      JSON.stringify(
        createEnvelope('register', {
          registrationToken: token.json<{ token: string }>().token,
          capabilities: {
            platform: 'linux',
            architecture: 'x64',
            nodeVersion: process.version,
            codex: { available: true, version: 'test' },
            claudeCode: { available: true, version: 'test' }
          }
        })
      )
    );
    const registered = await message(socket);
    const nodeId = (registered.payload as { nodeId: string }).nodeId;

    const manifestRequest = app.inject({
      method: 'GET',
      url: `/api/nodes/${nodeId}/workbench-capabilities`,
      headers
    });
    const manifestCommand = await message(socket);
    expect(manifestCommand).toMatchObject({
      type: 'node.request',
      payload: {
        operation: 'node.workbench.capabilities',
        data: {},
        userAuthorization: { nodeId, operation: 'node.workbench.capabilities' }
      }
    });
    respond(socket, manifestCommand, { manifest: { revision: 7 } });
    expect((await manifestRequest).json()).toEqual({ manifest: { revision: 7 } });

    const imageRequest = app.inject({
      method: 'GET',
      url: `/api/agent-runs/run-image-1/images/0?nodeId=${encodeURIComponent(nodeId)}`,
      headers
    });
    const imageCommand = await message(socket);
    expect(imageCommand.payload).toMatchObject({
      operation: 'run.image.read',
      data: { runId: 'run-image-1', imageIndex: 0 }
    });
    respond(socket, imageCommand, {
      image: { mime: 'image/png', dataBase64: Buffer.from('cached-image').toString('base64') }
    });
    const imageResponse = await imageRequest;
    expect(imageResponse.statusCode).toBe(200);
    expect(imageResponse.headers['cache-control']).toBe('private, max-age=3600, must-revalidate');
    expect(imageResponse.headers.etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    expect(imageResponse.rawPayload.toString()).toBe('cached-image');

    const cachedImageResponse = await app.inject({
      method: 'GET',
      url: `/api/agent-runs/run-image-1/images/0?nodeId=${encodeURIComponent(nodeId)}`,
      headers: { ...headers, 'if-none-match': imageResponse.headers.etag! }
    });
    expect(cachedImageResponse.statusCode).toBe(304);
    expect(cachedImageResponse.rawPayload).toHaveLength(0);

    const nativeRunId = 'native-history:session-image-1';
    const old = { name: 'old.png', mime: 'image/png', localPath: join(directory, 'old.png') };
    const fresh = { name: 'fresh.png', mime: 'image/png', localPath: join(directory, 'fresh.png') };
    await writeFile(old.localPath, 'old-image');
    await writeFile(fresh.localPath, 'fresh-image');
    const registeredImages = attachments.registerNativeImages(
      nativeRunId,
      [directory],
      [old, fresh]
    );
    const freshRef = registeredImages[1]!.imageRef as string;
    attachments.state.nativeHistoryImages.delete(nativeRunId);
    expect(attachments.registerNativeImages(nativeRunId, [directory], [fresh, old])).toEqual(
      [...registeredImages].reverse()
    );
    for (const pixels of ['fresh-image', 'updated-image']) {
      await writeFile(fresh.localPath, pixels);
      const nativeRequest = app.inject({
        url: `/api/agent-runs/${encodeURIComponent(nativeRunId)}/images/${encodeURIComponent(freshRef)}?nodeId=${encodeURIComponent(nodeId)}`,
        headers: { ...headers, 'if-none-match': imageResponse.headers.etag! }
      });
      const nativeCommand = await message(socket);
      expect(nativeCommand.payload).toMatchObject({
        operation: 'run.image.read',
        data: { runId: nativeRunId, imageRef: freshRef }
      });
      respond(socket, nativeCommand, {
        image: await attachments.readNative(nativeRunId, freshRef)
      });
      const nativeResponse = await nativeRequest;
      expect(nativeResponse.statusCode).toBe(200);
      expect(nativeResponse.rawPayload.toString()).toBe(pixels);
      expect(nativeResponse.headers['cache-control']).toBe('private, no-store');
      expect(nativeResponse.headers.etag).toBeUndefined();
    }
    expect(
      (
        await app.inject({
          url: `/api/agent-runs/${encodeURIComponent(nativeRunId)}/images/0?nodeId=${encodeURIComponent(nodeId)}`,
          headers
        })
      ).statusCode
    ).toBe(400);

    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/workspaces/workspace-1?nodeId=${nodeId}`,
          headers: { cookie: headers.cookie }
        })
      ).statusCode
    ).toBe(403);
    const removeRequest = app.inject({
      method: 'DELETE',
      url: `/api/workspaces/workspace-1?nodeId=${nodeId}`,
      headers
    });
    const removeCommand = await message(socket);
    expect(removeCommand.payload).toMatchObject({
      operation: 'workspace.remove',
      data: { workspaceId: 'workspace-1' }
    });
    respond(socket, removeCommand, { workspace: { id: 'workspace-1' } });
    expect((await removeRequest).json()).toEqual({ workspace: { id: 'workspace-1' } });

    const directoryRequest = app.inject({
      method: 'GET',
      url: `/api/workspace-directories?nodeId=${nodeId}&path=%2Fhome%2Fnode`,
      headers
    });
    const directoryCommand = await message(socket);
    expect(directoryCommand.payload).toMatchObject({
      operation: 'workspace.directories.list',
      data: { path: '/home/node' }
    });
    respond(socket, directoryCommand, {
      directory: { currentPath: '/home/node', entries: [] }
    });
    expect((await directoryRequest).json()).toEqual({
      directory: { currentPath: '/home/node', entries: [] }
    });

    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/workspaces',
          headers,
          payload: { nodeId, path: '/home/node', createDirectoryName: '../invalid' }
        })
      ).statusCode
    ).toBe(400);
    const registrationRequest = app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers,
      payload: { nodeId, path: '/home/node', createDirectoryName: 'new-project' }
    });
    const registrationCommand = await message(socket);
    expect(registrationCommand.payload).toMatchObject({
      operation: 'workspace.register',
      data: { path: '/home/node', createDirectoryName: 'new-project' }
    });
    respond(socket, registrationCommand, {
      workspace: { id: 'workspace-new', path: '/home/node/new-project', kind: 'DIRECTORY' }
    });
    expect((await registrationRequest).json()).toMatchObject({
      workspace: { id: 'workspace-new', path: '/home/node/new-project' }
    });

    const profileRequest = app.inject({
      method: 'GET',
      url: `/api/runner-profiles?nodeId=${nodeId}`,
      headers
    });
    const profileCommand = await message(socket);
    expect(profileCommand.payload).toMatchObject({ operation: 'runner.profiles.list', data: {} });
    respond(socket, profileCommand, {
      profiles: [],
      defaults: [{ runner: 'codex', model: 'gpt-5.6-sol', effort: 'medium', access: 'on-request' }]
    });
    expect((await profileRequest).json()).toEqual({
      profiles: [],
      defaults: [{ runner: 'codex', model: 'gpt-5.6-sol', effort: 'medium', access: 'on-request' }]
    });

    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/runner-defaults',
          headers: { cookie: headers.cookie },
          payload: {
            nodeId,
            runner: 'codex',
            model: 'gpt-5.6-sol',
            effort: 'medium',
            access: 'on-request'
          }
        })
      ).statusCode
    ).toBe(403);
    const defaultsRequest = app.inject({
      method: 'PUT',
      url: '/api/runner-defaults',
      headers,
      payload: {
        nodeId,
        runner: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'high',
        access: 'full-access'
      }
    });
    const defaultsCommand = await message(socket);
    expect(defaultsCommand.payload).toMatchObject({
      operation: 'runner.defaults.save',
      data: {
        runner: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'high',
        access: 'full-access'
      }
    });
    respond(socket, defaultsCommand, {
      defaults: {
        runner: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'high',
        access: 'full-access'
      }
    });
    expect((await defaultsRequest).json()).toMatchObject({
      defaults: { runner: 'codex', effort: 'high', access: 'full-access' }
    });
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/runner-defaults',
          headers,
          payload: { nodeId, runner: 'unknown', model: 'any', effort: 'medium', access: 'any' }
        })
      ).json()
    ).toMatchObject({ error: { code: 'RUNNER_DEFAULT_INVALID', message: expect.any(String) } });

    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/agent-sessions/session-1/metadata',
          headers: { cookie: headers.cookie },
          payload: { nodeId, pinned: true }
        })
      ).statusCode
    ).toBe(403);
    const metadataRequest = app.inject({
      method: 'PATCH',
      url: '/api/agent-sessions/session-1/metadata',
      headers,
      payload: { nodeId, customTitle: 'Workbench', pinned: true }
    });
    const metadataCommand = await message(socket);
    expect(metadataCommand.payload).toMatchObject({
      operation: 'session.metadata.update',
      data: { sessionId: 'session-1', customTitle: 'Workbench', pinned: true }
    });
    respond(socket, metadataCommand, { session: { id: 'session-1', customTitle: 'Workbench' } });
    expect((await metadataRequest).json()).toMatchObject({ session: { id: 'session-1' } });

    const pinMoveRequest = app.inject({
      method: 'PATCH',
      url: '/api/agent-sessions/session-1/pin-order',
      headers,
      payload: { nodeId, direction: 'up' }
    });
    const pinMoveCommand = await message(socket);
    expect(pinMoveCommand.payload).toMatchObject({
      operation: 'session.pin.move',
      data: { sessionId: 'session-1', direction: 'up' }
    });
    respond(socket, pinMoveCommand, { moved: true });
    expect((await pinMoveRequest).json()).toEqual({ moved: true });

    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/agent-sessions/session-1/rewind',
          headers,
          payload: { nodeId, turnId: 'turn-1', position: 'BEFORE' }
        })
      ).statusCode
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/agent-sessions/session-1/rewind',
          headers,
          payload: {
            nodeId,
            turnId: 'turn-1',
            position: 'AFTER',
            boundary: 'x'.repeat(257)
          }
        })
      ).statusCode
    ).toBe(400);
    const rewindRequest = app.inject({
      method: 'POST',
      url: '/api/agent-sessions/session-1/rewind',
      headers,
      payload: { nodeId, turnId: 'turn-1', position: 'BEFORE', boundary: null }
    });
    const rewindCommand = await message(socket);
    expect(rewindCommand.payload).toMatchObject({
      operation: 'session.rewind',
      data: { sessionId: 'session-1', turnId: 'turn-1', position: 'BEFORE', boundary: null }
    });
    respond(socket, rewindCommand, { session: { id: 'forked-session' } });
    expect((await rewindRequest).json()).toEqual({ session: { id: 'forked-session' } });
    const lockedRewindRequest = app.inject({
      method: 'POST',
      url: '/api/agent-sessions/session-1/rewind',
      headers,
      payload: { nodeId, turnId: 'turn-1', position: 'AFTER', boundary: 'turn-1' }
    });
    const lockedRewindCommand = await message(socket);
    respondError(socket, lockedRewindCommand, 'MAR_AGENT_SESSION_LOCKED');
    expect((await lockedRewindRequest).json()).toMatchObject({
      error: { code: 'MAR_AGENT_SESSION_LOCKED', message: expect.any(String) }
    });

    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/agent-sessions/session-1/rollback',
          headers,
          payload: { nodeId, turnId: 'turn-1' }
        })
      ).statusCode
    ).toBe(400);
    const rollbackRequest = app.inject({
      method: 'POST',
      url: '/api/agent-sessions/session-1/rollback',
      headers,
      payload: { nodeId, turnId: 'turn-1', boundary: null }
    });
    const rollbackCommand = await message(socket);
    expect(rollbackCommand.payload).toMatchObject({
      operation: 'session.rollback',
      data: { sessionId: 'session-1', turnId: 'turn-1', boundary: null }
    });
    respond(socket, rollbackCommand, { session: { id: 'session-1' } });
    expect((await rollbackRequest).json()).toEqual({ session: { id: 'session-1' } });

    const sessionRemoveRequest = app.inject({
      method: 'DELETE',
      url: '/api/agent-sessions/session-1?nodeId=' + encodeURIComponent(nodeId),
      headers
    });
    const sessionRemoveCommand = await message(socket);
    expect(sessionRemoveCommand.payload).toMatchObject({
      operation: 'session.remove',
      data: { sessionId: 'session-1' }
    });
    respond(socket, sessionRemoveCommand, { deleted: true });
    expect((await sessionRemoveRequest).json()).toEqual({ deleted: true });

    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/workspaces/workspace-1/sessions/cleanup',
          headers,
          payload: { nodeId, inactiveDays: 0 }
        })
      ).statusCode
    ).toBe(400);
    const cleanupSessionsRequest = app.inject({
      method: 'POST',
      url: '/api/workspaces/workspace-1/sessions/cleanup',
      headers,
      payload: { nodeId, inactiveDays: 30 }
    });
    const cleanupSessionsCommand = await message(socket);
    expect(cleanupSessionsCommand.payload).toMatchObject({
      operation: 'workspace.sessions.cleanup',
      data: { workspaceId: 'workspace-1', inactiveDays: 30 }
    });
    respond(socket, cleanupSessionsCommand, {
      deleted: 2,
      skipped: 3,
      failed: 0,
      deletedByRunner: { codex: 1, 'claude-code': 1 }
    });
    expect((await cleanupSessionsRequest).json()).toEqual({
      deleted: 2,
      skipped: 3,
      failed: 0,
      deletedByRunner: { codex: 1, 'claude-code': 1 }
    });

    const configEnvelopePromise = message(socket);
    const configRequest = app
      .inject({
        method: 'PATCH',
        url: '/api/agent-sessions/session-1/config',
        headers,
        payload: {
          nodeId,
          model: 'gpt-5.6-terra',
          effort: '',
          access: 'workspace-write'
        }
      })
      .then((result) => result);
    const configCommand = await configEnvelopePromise;
    expect(configCommand.payload).toMatchObject({
      operation: 'session.config.update',
      data: {
        sessionId: 'session-1',
        model: 'gpt-5.6-terra',
        effort: '',
        access: 'workspace-write'
      }
    });
    respond(socket, configCommand, { session: { id: 'session-1', model: 'gpt-5.6-terra' } });
    expect((await configRequest).json()).toMatchObject({
      session: { id: 'session-1', model: 'gpt-5.6-terra' }
    });

    const turnsRequest = app.inject({
      method: 'GET',
      url: `/api/agent-sessions/session-1/turns?nodeId=${nodeId}&cursor=opaque-turn&limit=2`,
      headers
    });
    const turnsCommand = await message(socket);
    expect(turnsCommand.payload).toMatchObject({
      operation: 'session.turns.list',
      data: { sessionId: 'session-1', cursor: 'opaque-turn', limit: 2 }
    });
    respond(socket, turnsCommand, { turns: [], nextCursor: null });
    expect((await turnsRequest).json()).toEqual({ turns: [], nextCursor: null });

    const segmentsRequest = app.inject({
      method: 'GET',
      url: `/api/agent-sessions/session-1/turns?nodeId=${nodeId}&cursor=opaque-segment&limit=10&unit=SEGMENT`,
      headers
    });
    const segmentsCommand = await message(socket);
    expect(segmentsCommand.payload).toMatchObject({
      operation: 'session.turns.list',
      data: {
        sessionId: 'session-1',
        cursor: 'opaque-segment',
        limit: 10,
        unit: 'SEGMENT'
      }
    });
    respond(socket, segmentsCommand, { unit: 'SEGMENT', segments: [], nextCursor: null });
    expect((await segmentsRequest).json()).toEqual({
      unit: 'SEGMENT',
      segments: [],
      nextCursor: null
    });

    const eventsRequest = app.inject({
      method: 'GET',
      url: `/api/agent-sessions/session-1/events?nodeId=${nodeId}&after=opaque-event`,
      headers
    });
    const eventsCommand = await message(socket);
    expect(eventsCommand.payload).toMatchObject({
      operation: 'session.events.read',
      data: { sessionId: 'session-1', cursor: 'opaque-event' }
    });
    respond(socket, eventsCommand, { items: [], nextCursor: null });
    expect((await eventsRequest).json()).toEqual({ items: [], nextCursor: null });

    const commandEnvelopePromise = message(socket);
    const commandRequest = app.inject({
      method: 'POST',
      url: '/api/agent-sessions/session-1/commands',
      headers,
      payload: { nodeId, commandId: 'status', input: '/status workspace' }
    });
    const commandEnvelope = await commandEnvelopePromise;
    expect(commandEnvelope.payload).toMatchObject({
      operation: 'session.command.execute',
      data: {
        sessionId: 'session-1',
        commandId: 'status',
        input: '/status workspace'
      }
    });
    respond(socket, commandEnvelope, { accepted: true });
    expect((await commandRequest).json()).toEqual({ accepted: true });

    const fastCommandPromise = message(socket);
    const fastCommandRequest = app.inject({
      method: 'POST',
      url: '/api/runner-commands',
      headers,
      payload: { nodeId, runner: 'codex', commandId: 'fast', input: '/fast on' }
    });
    const fastCommand = await fastCommandPromise;
    expect(fastCommand.payload).toMatchObject({
      operation: 'runner.command.execute',
      data: { runner: 'codex', commandId: 'fast', input: '/fast on' }
    });
    respond(socket, fastCommand, { command: 'fast', enabled: true });
    expect((await fastCommandRequest).json()).toEqual({ command: 'fast', enabled: true });

    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/agent-sessions/session-1/turns?nodeId=${nodeId}&cursor=one&after=two`,
          headers
        })
      ).json()
    ).toMatchObject({ error: { code: 'EVENT_CURSOR_INVALID', message: expect.any(String) } });
    const filesRequest = app.inject({
      method: 'GET',
      url: `/api/workspaces/workspace-1/files?nodeId=${nodeId}&path=src&cursor=opaque-page&limit=2`,
      headers
    });
    const filesCommand = await message(socket);
    expect(filesCommand.payload).toMatchObject({
      operation: 'workspace.files.list',
      data: { workspaceId: 'workspace-1', path: 'src', cursor: 'opaque-page', limit: 2 }
    });
    respond(socket, filesCommand, { files: { entries: [], nextCursor: null, truncated: false } });
    expect((await filesRequest).json()).toEqual({
      files: { entries: [], nextCursor: null, truncated: false }
    });

    const readRequest = app.inject({
      method: 'GET',
      url: `/api/workspaces/workspace-1/files/read?nodeId=${nodeId}&path=src%2Fmain.ts&offset=0&limit=20`,
      headers
    });
    const readCommand = await message(socket);
    expect(readCommand.payload).toMatchObject({
      operation: 'workspace.file.read',
      data: { workspaceId: 'workspace-1', path: 'src/main.ts', offset: 0, limit: 20 }
    });
    respond(socket, readCommand, {
      file: {
        path: 'src/main.ts',
        encoding: 'utf-8',
        size: 2,
        content: 'ok',
        truncated: false,
        nextOffset: null
      }
    });
    expect((await readRequest).statusCode).toBe(200);

    const linkedWorktreePath = '/srv/worktrees/review';
    const worktreeReadRequest = app.inject({
      method: 'GET',
      url: `/api/workspaces/workspace-1/files/read?nodeId=${nodeId}&path=src%2Flinked.ts&worktreePath=${encodeURIComponent(linkedWorktreePath)}&offset=0&limit=20`,
      headers
    });
    const worktreeReadCommand = await message(socket);
    expect(worktreeReadCommand.payload).toMatchObject({
      operation: 'workspace.file.read',
      data: {
        workspaceId: 'workspace-1',
        worktreePath: linkedWorktreePath,
        path: 'src/linked.ts',
        offset: 0,
        limit: 20
      }
    });
    respond(socket, worktreeReadCommand, {
      file: {
        path: 'src/linked.ts',
        encoding: 'utf-8',
        size: 2,
        content: 'ok',
        truncated: false,
        nextOffset: null
      }
    });
    expect((await worktreeReadRequest).statusCode).toBe(200);

    const revision = 'a'.repeat(64);
    const writeRequest = app.inject({
      method: 'PUT',
      url: '/api/workspaces/workspace-1/files/write',
      headers,
      payload: {
        nodeId,
        path: 'src/main.ts',
        content: 'const value = 2;\n',
        expectedRevision: revision
      }
    });
    const writeCommand = await message(socket);
    expect(writeCommand.payload).toMatchObject({
      operation: 'workspace.file.write',
      data: {
        workspaceId: 'workspace-1',
        path: 'src/main.ts',
        content: 'const value = 2;\n',
        expectedRevision: revision
      }
    });
    respond(socket, writeCommand, { file: { path: 'src/main.ts', revision: 'b'.repeat(64) } });
    expect((await writeRequest).statusCode).toBe(200);

    const conflictingWriteRequest = app.inject({
      method: 'PUT',
      url: '/api/workspaces/workspace-1/files/write',
      headers,
      payload: {
        nodeId,
        path: 'src/main.ts',
        content: 'const value = 3;\n',
        expectedRevision: revision
      }
    });
    const conflictingWriteCommand = await message(socket);
    respondError(socket, conflictingWriteCommand, 'FILE_WRITE_CONFLICT');
    expect((await conflictingWriteRequest).statusCode).toBe(409);

    const contentRequest = app.inject({
      method: 'GET',
      url: `/api/workspaces/workspace-1/files/content?nodeId=${nodeId}&path=assets%2Flogo.png`,
      headers: { ...headers, range: 'bytes=1-2' }
    });
    const contentSizeCommand = await message(socket);
    expect(contentSizeCommand.payload).toMatchObject({
      operation: 'workspace.file.content.read',
      data: { workspaceId: 'workspace-1', path: 'assets/logo.png', offset: 0, limit: 1 }
    });
    respond(socket, contentSizeCommand, {
      file: { path: 'assets/logo.png', size: 4, offset: 0, contentBase64: 'AA==' }
    });
    const contentCommand = await message(socket);
    expect(contentCommand.payload).toMatchObject({
      operation: 'workspace.file.content.read',
      data: { workspaceId: 'workspace-1', path: 'assets/logo.png', offset: 1, limit: 2 }
    });
    respond(socket, contentCommand, {
      file: { path: 'assets/logo.png', size: 4, offset: 1, contentBase64: 'AQI=' }
    });
    const contentResponse = await contentRequest;
    expect(contentResponse.statusCode).toBe(206);
    expect(contentResponse.headers['content-range']).toBe('bytes 1-2/4');
    expect(contentResponse.rawPayload).toEqual(Buffer.from([1, 2]));

    const largeDownloadSize = 20 * 1024 * 1024 + 1;
    const largeDownloadRequest = app.inject({
      method: 'GET',
      url: `/api/workspaces/workspace-1/files/content?nodeId=${nodeId}&path=assets%2Flarge.bin&download=1`,
      headers
    });
    const largeDownloadSizeCommand = await message(socket);
    expect(largeDownloadSizeCommand.payload).toMatchObject({
      operation: 'workspace.file.content.read',
      data: { workspaceId: 'workspace-1', path: 'assets/large.bin', offset: 0, limit: 1 }
    });
    respond(socket, largeDownloadSizeCommand, {
      file: {
        path: 'assets/large.bin',
        size: largeDownloadSize,
        offset: 0,
        contentBase64: 'AA=='
      }
    });
    let downloadedBytes = 0;
    while (downloadedBytes < largeDownloadSize) {
      const chunkCommand = await message(socket, `large-download-${downloadedBytes}`);
      const data = (chunkCommand.payload as { data: { offset: number; limit: number } }).data;
      const length = Math.min(512 * 1024, largeDownloadSize - downloadedBytes);
      expect(data).toMatchObject({
        workspaceId: 'workspace-1',
        path: 'assets/large.bin',
        offset: downloadedBytes,
        limit: length
      });
      respond(socket, chunkCommand, {
        file: {
          path: 'assets/large.bin',
          size: largeDownloadSize,
          offset: downloadedBytes,
          contentBase64: Buffer.alloc(length).toString('base64')
        }
      });
      downloadedBytes += length;
    }
    const largeDownloadResponse = await largeDownloadRequest;
    expect(largeDownloadResponse.statusCode).toBe(200);
    expect(largeDownloadResponse.headers['content-disposition']).toBe(
      "attachment; filename*=UTF-8''large.bin"
    );
    expect(largeDownloadResponse.headers['content-length']).toBe(String(largeDownloadSize));
    expect(largeDownloadResponse.rawPayload).toHaveLength(largeDownloadSize);

    const worktreeContentRequest = app.inject({
      method: 'GET',
      url: `/api/workspaces/workspace-1/files/content?nodeId=${nodeId}&path=assets%2Flinked.png&worktreePath=${encodeURIComponent(linkedWorktreePath)}`,
      headers: { ...headers, range: 'bytes=0-1' }
    });
    const worktreeContentSizeCommand = await message(socket);
    expect(worktreeContentSizeCommand.payload).toMatchObject({
      operation: 'workspace.file.content.read',
      data: {
        workspaceId: 'workspace-1',
        worktreePath: linkedWorktreePath,
        path: 'assets/linked.png',
        offset: 0,
        limit: 1
      }
    });
    respond(socket, worktreeContentSizeCommand, {
      file: { path: 'assets/linked.png', size: 2, offset: 0, contentBase64: 'AA==' }
    });
    const worktreeContentCommand = await message(socket);
    expect(worktreeContentCommand.payload).toMatchObject({
      operation: 'workspace.file.content.read',
      data: {
        workspaceId: 'workspace-1',
        worktreePath: linkedWorktreePath,
        path: 'assets/linked.png',
        offset: 0,
        limit: 2
      }
    });
    respond(socket, worktreeContentCommand, {
      file: { path: 'assets/linked.png', size: 2, offset: 0, contentBase64: 'AAE=' }
    });
    expect((await worktreeContentRequest).rawPayload).toEqual(Buffer.from([0, 1]));

    const contentHeadRequest = app.inject({
      method: 'HEAD',
      url: `/api/workspaces/workspace-1/files/content?nodeId=${nodeId}&path=assets%2Flogo.png`,
      headers
    });
    const contentHeadCommand = await message(socket);
    expect(contentHeadCommand.payload).toMatchObject({
      operation: 'workspace.file.content.read',
      data: { workspaceId: 'workspace-1', path: 'assets/logo.png', offset: 0, limit: 1 }
    });
    respond(socket, contentHeadCommand, {
      file: { path: 'assets/logo.png', size: 4, offset: 0, contentBase64: 'AA==' }
    });
    const contentHeadResponse = await contentHeadRequest;
    expect(contentHeadResponse.statusCode).toBe(200);
    expect(contentHeadResponse.headers['content-length']).toBe('4');
    expect(contentHeadResponse.rawPayload).toHaveLength(0);

    const mutateRequest = app.inject({
      method: 'POST',
      url: '/api/workspaces/workspace-1/files/mutate',
      headers,
      payload: {
        nodeId,
        action: 'MOVE',
        path: 'src/main.ts',
        destination: 'src/renamed.ts'
      }
    });
    const mutateCommand = await message(socket);
    expect(mutateCommand.payload).toMatchObject({
      operation: 'workspace.files.mutate',
      data: {
        workspaceId: 'workspace-1',
        action: 'MOVE',
        path: 'src/main.ts',
        destination: 'src/renamed.ts'
      }
    });
    respond(socket, mutateCommand, { file: { path: 'src/renamed.ts' } });
    expect((await mutateRequest).statusCode).toBe(200);

    const contentSearchRequest = app.inject({
      method: 'GET',
      url: `/api/workspaces/workspace-1/content/search?nodeId=${nodeId}&q=hello&regex=true`,
      headers
    });
    const contentSearchCommand = await message(socket);
    expect(contentSearchCommand.payload).toMatchObject({
      operation: 'workspace.content.search',
      data: { workspaceId: 'workspace-1', query: 'hello', regex: true }
    });
    respond(socket, contentSearchCommand, {
      search: {
        matches: [{ path: 'src/main.ts', line: 1, column: 1, preview: 'hello' }],
        engine: 'RIPGREP',
        truncated: false,
        skippedFiles: 0
      }
    });
    expect((await contentSearchRequest).statusCode).toBe(200);

    const uploadPreflightRequest = app.inject({
      method: 'POST',
      url: '/api/workspaces/workspace-1/uploads/preflight',
      headers,
      payload: { nodeId, directory: 'src', files: [{ name: 'main.ts' }] }
    });
    const uploadPreflightCommand = await message(socket);
    expect(uploadPreflightCommand.payload).toMatchObject({
      operation: 'workspace.files.upload.preflight',
      data: { workspaceId: 'workspace-1', directory: 'src', files: [{ name: 'main.ts' }] }
    });
    respond(socket, uploadPreflightCommand, {
      uploads: [{ name: 'main.ts', status: 'READY', path: 'src/main.ts' }]
    });
    expect((await uploadPreflightRequest).statusCode).toBe(200);

    const uploadCreateRequest = app.inject({
      method: 'POST',
      url: '/api/workspaces/workspace-1/uploads',
      headers,
      payload: { nodeId, directory: 'src', name: 'main.ts', size: 2, overwrite: false }
    });
    const uploadCreateCommand = await message(socket);
    expect(uploadCreateCommand.payload).toMatchObject({
      operation: 'workspace.files.upload.create',
      data: {
        workspaceId: 'workspace-1',
        directory: 'src',
        name: 'main.ts',
        size: 2,
        overwrite: false
      }
    });
    respond(socket, uploadCreateCommand, {
      upload: {
        uploadId: '0b2df00e-39bf-4fbd-bb4a-af68dca11111',
        path: 'src/main.ts',
        receivedBytes: 0,
        size: 2
      }
    });
    expect((await uploadCreateRequest).statusCode).toBe(200);

    const uploadChunkRequest = app.inject({
      method: 'POST',
      url: `/api/workspaces/workspace-1/uploads/0b2df00e-39bf-4fbd-bb4a-af68dca11111/chunks?nodeId=${nodeId}&offset=0`,
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('ok')
    });
    const uploadChunkCommand = await message(socket);
    expect(uploadChunkCommand.payload).toMatchObject({
      operation: 'workspace.files.upload.chunk',
      data: {
        workspaceId: 'workspace-1',
        uploadId: '0b2df00e-39bf-4fbd-bb4a-af68dca11111',
        offset: 0,
        dataBase64: Buffer.from('ok').toString('base64')
      }
    });
    respond(socket, uploadChunkCommand, {
      upload: {
        uploadId: '0b2df00e-39bf-4fbd-bb4a-af68dca11111',
        path: 'src/main.ts',
        receivedBytes: 2,
        size: 2
      }
    });
    expect((await uploadChunkRequest).statusCode).toBe(200);

    const uploadCompleteRequest = app.inject({
      method: 'POST',
      url: '/api/workspaces/workspace-1/uploads/0b2df00e-39bf-4fbd-bb4a-af68dca11111/complete',
      headers,
      payload: { nodeId }
    });
    const uploadCompleteCommand = await message(socket);
    expect(uploadCompleteCommand.payload).toMatchObject({
      operation: 'workspace.files.upload.complete',
      data: { workspaceId: 'workspace-1', uploadId: '0b2df00e-39bf-4fbd-bb4a-af68dca11111' }
    });
    respond(socket, uploadCompleteCommand, { upload: { receivedBytes: 2 } });
    expect((await uploadCompleteRequest).statusCode).toBe(200);

    const changesRequest = app.inject({
      method: 'GET',
      url: `/api/workspaces/workspace-1/changes?nodeId=${nodeId}`,
      headers
    });
    const changesCommand = await message(socket);
    expect(changesCommand.payload).toMatchObject({
      operation: 'workspace.changes.current',
      data: { workspaceId: 'workspace-1' }
    });
    const partialChanges = {
      changes: [],
      partial: true,
      repositories: [
        {
          repositoryPath: 'lib-zos',
          repositoryName: 'lib-zos',
          source: 'SUBMODULE',
          branch: null,
          status: 'UNAVAILABLE',
          changes: [],
          error: { code: 'GIT_SUBMODULE_MAPPING_MISSING', message: 'Submodule mapping is missing.' }
        }
      ]
    };
    respond(socket, changesCommand, partialChanges);
    expect((await changesRequest).json()).toEqual(partialChanges);

    const changeDiffRequest = app.inject({
      method: 'GET',
      url: `/api/workspaces/workspace-1/changes/diff?nodeId=${nodeId}&path=src%2Fmain.ts`,
      headers
    });
    const changeDiffCommand = await message(socket);
    expect(changeDiffCommand.payload).toMatchObject({
      operation: 'workspace.change.diff',
      data: { workspaceId: 'workspace-1', path: 'src/main.ts' }
    });
    respond(socket, changeDiffCommand, { diff: { binary: false, text: 'safe file diff' } });
    expect((await changeDiffRequest).json()).toMatchObject({ diff: { text: 'safe file diff' } });

    const worktreeDiffRequest = app.inject({
      method: 'GET',
      url: `/api/workspaces/workspace-1/changes/diff?nodeId=${nodeId}&path=src%2Flinked.ts&worktreePath=${encodeURIComponent(linkedWorktreePath)}`,
      headers
    });
    const worktreeDiffCommand = await message(socket);
    expect(worktreeDiffCommand.payload).toMatchObject({
      operation: 'workspace.change.diff',
      data: {
        workspaceId: 'workspace-1',
        worktreePath: linkedWorktreePath,
        path: 'src/linked.ts'
      }
    });
    respond(socket, worktreeDiffCommand, { diff: { binary: false, text: 'worktree diff' } });
    expect((await worktreeDiffRequest).json()).toMatchObject({ diff: { text: 'worktree diff' } });

    const historyRef = 'refs/heads/main';
    const commit = 'a'.repeat(40);
    const refsRequest = app.inject({
      method: 'GET',
      url: `/api/workspaces/workspace-1/git/refs?nodeId=${nodeId}`,
      headers
    });
    const refsCommand = await message(socket);
    expect(refsCommand.payload).toMatchObject({
      operation: 'workspace.git.refs.list',
      data: { workspaceId: 'workspace-1' }
    });
    respond(socket, refsCommand, { refs: [] });
    expect((await refsRequest).statusCode).toBe(200);

    const historyRequest = app.inject({
      method: 'GET',
      url: `/api/workspaces/workspace-1/git/history?nodeId=${nodeId}&refs=${encodeURIComponent(historyRef)}&limit=50`,
      headers
    });
    const historyCommand = await message(socket);
    expect(historyCommand.payload).toMatchObject({
      operation: 'workspace.git.history.list',
      data: { workspaceId: 'workspace-1', refs: [historyRef], limit: 50 }
    });
    respond(socket, historyCommand, { commits: [], nextCursor: null });
    expect((await historyRequest).statusCode).toBe(200);

    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/workspaces/workspace-1/git/history?nodeId=${nodeId}&limit=invalid`,
          headers
        })
      ).json()
    ).toMatchObject({ error: { code: 'GIT_HISTORY_LIMIT_INVALID' } });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/workspaces/workspace-1/git/commits/not-a-commit/files?nodeId=${nodeId}`,
          headers
        })
      ).json()
    ).toMatchObject({ error: { code: 'GIT_HISTORY_COMMIT_INVALID' } });

    const commitFilesRequest = app.inject({
      method: 'GET',
      url: `/api/workspaces/workspace-1/git/commits/${commit}/files?nodeId=${nodeId}&refs=${encodeURIComponent(historyRef)}`,
      headers
    });
    const commitFilesCommand = await message(socket);
    expect(commitFilesCommand.payload).toMatchObject({
      operation: 'workspace.git.commit.files',
      data: { workspaceId: 'workspace-1', commit, refs: [historyRef] }
    });
    respond(socket, commitFilesCommand, { files: [] });
    expect((await commitFilesRequest).statusCode).toBe(200);

    const historyDiffRequest = app.inject({
      method: 'GET',
      url: `/api/workspaces/workspace-1/git/commits/${commit}/diff?nodeId=${nodeId}&refs=${encodeURIComponent(historyRef)}&path=src%2Fmain.ts`,
      headers
    });
    const historyDiffCommand = await message(socket);
    expect(historyDiffCommand.payload).toMatchObject({
      operation: 'workspace.git.commit.file.diff',
      data: { workspaceId: 'workspace-1', commit, refs: [historyRef], path: 'src/main.ts' }
    });
    respond(socket, historyDiffCommand, { diff: { binary: false, text: 'history diff' } });
    expect((await historyDiffRequest).json()).toMatchObject({ diff: { text: 'history diff' } });

    const historyContentRequest = app.inject({
      method: 'GET',
      url: `/api/workspaces/workspace-1/git/commits/${commit}/files/content?nodeId=${nodeId}&refs=${encodeURIComponent(historyRef)}&path=assets%2Flogo.png`,
      headers: { ...headers, range: 'bytes=0-1' }
    });
    const historyContentSizeCommand = await message(socket);
    expect(historyContentSizeCommand.payload).toMatchObject({
      operation: 'workspace.git.commit.file.content.read',
      data: {
        workspaceId: 'workspace-1',
        commit,
        refs: [historyRef],
        path: 'assets/logo.png',
        offset: 0,
        limit: 1
      }
    });
    respond(socket, historyContentSizeCommand, {
      file: { path: 'assets/logo.png', size: 2, offset: 0, contentBase64: 'AA==' }
    });
    const historyContentCommand = await message(socket);
    expect(historyContentCommand.payload).toMatchObject({
      operation: 'workspace.git.commit.file.content.read',
      data: { offset: 0, limit: 2 }
    });
    respond(socket, historyContentCommand, {
      file: { path: 'assets/logo.png', size: 2, offset: 0, contentBase64: 'AAE=' }
    });
    expect((await historyContentRequest).rawPayload).toEqual(Buffer.from([0, 1]));

    const historyDownloadSize = 512 * 1024 + 1;
    const historyDownloadRequest = app.inject({
      method: 'GET',
      url: `/api/workspaces/workspace-1/git/commits/${commit}/files/content?nodeId=${nodeId}&refs=${encodeURIComponent(historyRef)}&path=assets%2Fhistory-large.bin&download=1`,
      headers
    });
    const historyDownloadSizeCommand = await message(socket);
    expect(historyDownloadSizeCommand.payload).toMatchObject({
      operation: 'workspace.git.commit.file.content.read',
      data: {
        workspaceId: 'workspace-1',
        commit,
        refs: [historyRef],
        path: 'assets/history-large.bin',
        offset: 0,
        limit: 1
      }
    });
    respond(socket, historyDownloadSizeCommand, {
      file: {
        path: 'assets/history-large.bin',
        size: historyDownloadSize,
        offset: 0,
        contentBase64: 'AA=='
      }
    });
    for (const [offset, limit] of [
      [0, 512 * 1024],
      [512 * 1024, 1]
    ] as const) {
      const historyDownloadCommand = await message(socket, `history-download-${offset}`);
      expect(historyDownloadCommand.payload).toMatchObject({
        operation: 'workspace.git.commit.file.content.read',
        data: { offset, limit }
      });
      respond(socket, historyDownloadCommand, {
        file: {
          path: 'assets/history-large.bin',
          size: historyDownloadSize,
          offset,
          contentBase64: Buffer.alloc(limit).toString('base64')
        }
      });
    }
    const historyDownloadResponse = await historyDownloadRequest;
    expect(historyDownloadResponse.statusCode).toBe(200);
    expect(historyDownloadResponse.headers['content-disposition']).toBe(
      "attachment; filename*=UTF-8''history-large.bin"
    );
    expect(historyDownloadResponse.rawPayload).toHaveLength(historyDownloadSize);

    const restoreRequest = app.inject({
      method: 'POST',
      url: '/api/workspaces/workspace-1/changes/restore',
      headers,
      payload: { nodeId, path: 'src/main.ts', state: 'UNSTAGED' }
    });
    const restoreCommand = await message(socket);
    expect(restoreCommand.payload).toMatchObject({
      operation: 'workspace.change.restore',
      data: { workspaceId: 'workspace-1', path: 'src/main.ts', state: 'UNSTAGED' }
    });
    respond(socket, restoreCommand, { restored: true });
    expect((await restoreRequest).json()).toEqual({ restored: true });

    const worktreeRestoreRequest = app.inject({
      method: 'POST',
      url: '/api/workspaces/workspace-1/changes/restore',
      headers,
      payload: {
        nodeId,
        worktreePath: linkedWorktreePath,
        path: 'src/linked.ts',
        state: 'UNSTAGED'
      }
    });
    const worktreeRestoreCommand = await message(socket);
    expect(worktreeRestoreCommand.payload).toMatchObject({
      operation: 'workspace.change.restore',
      data: {
        workspaceId: 'workspace-1',
        worktreePath: linkedWorktreePath,
        path: 'src/linked.ts',
        state: 'UNSTAGED'
      }
    });
    respond(socket, worktreeRestoreCommand, { restored: true });
    expect((await worktreeRestoreRequest).json()).toEqual({ restored: true });

    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/workspaces/workspace-1/changes/restore',
          headers,
          payload: { nodeId, path: 'src/main.ts', state: 'UNKNOWN' }
        })
      ).json()
    ).toMatchObject({
      error: { code: 'GIT_CHANGE_RESTORE_UNAVAILABLE', message: expect.any(String) }
    });

    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/workspaces/workspace-1/files/read?nodeId=${nodeId}&path=src%2Fmain.ts&offset=-1`,
          headers
        })
      ).json()
    ).toMatchObject({ error: { code: 'FILE_RANGE_INVALID', message: expect.any(String) } });

    const unavailableProfile = app.inject({
      method: 'GET',
      url: `/api/runner-profiles?nodeId=${nodeId}`,
      headers
    });
    const unavailableCommand = await message(socket);
    respondError(socket, unavailableCommand, 'CAPABILITY_UNAVAILABLE');
    expect((await unavailableProfile).statusCode).toBe(409);
  } finally {
    attachments.dispose();
    socket?.close();
    await app.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

function respond(socket: WebSocket, command: NodeEnvelope, result: unknown): void {
  socket.send(JSON.stringify(createEnvelope('node.response', { result }, { replyTo: command.id })));
}

function respondError(socket: WebSocket, command: NodeEnvelope, error: string): void {
  socket.send(
    JSON.stringify(
      createEnvelope(
        'node.response',
        { error, message: 'The requested Node operation failed.' },
        { replyTo: command.id }
      )
    )
  );
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
    };
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new Error('SOCKET_ERROR'));
    };
    socket.addEventListener('open', onOpen, { once: true });
    socket.addEventListener('error', onError, { once: true });
  });
}

function message(socket: WebSocket, description = 'node-command'): Promise<NodeEnvelope> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('error', onError);
      socket.removeEventListener('close', onClose);
    };
    const onMessage = (event: MessageEvent): void => {
      cleanup();
      try {
        resolve(JSON.parse(String(event.data)) as NodeEnvelope);
      } catch (error) {
        reject(error);
      }
    };
    const onError = (): void => {
      cleanup();
      reject(new Error('SOCKET_ERROR'));
    };
    const onClose = (event: CloseEvent): void => {
      cleanup();
      reject(new Error(`SOCKET_CLOSED:${event.code}:${description}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`NODE_MESSAGE_TIMEOUT:${description}`));
    }, 5_000);
    socket.addEventListener('message', onMessage, { once: true });
    socket.addEventListener('error', onError, { once: true });
    socket.addEventListener('close', onClose, { once: true });
  });
}

function cookieFrom(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(';', 1)[0] ?? '';
}
