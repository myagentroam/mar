import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '../../packages/protocol/src/index.js';
import { ServerDatabase } from '../../ee/server/src/database.js';
import { createTestNodeControl } from '../support/create-test-node-control.js';
import {
  loadOrCreateRuntimeCredentialHmacKey,
  RuntimeCredentialService
} from '../../packages/server-core/src/runtime-credential-service.js';

const NOW = 1_800_000_000_000;

function storedModel(credentialId = 'credential-1') {
  return {
    id: 'model-codex',
    name: 'Codex',
    protocol: 'OPENAI_RESPONSES' as const,
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    credential: { type: 'CREDENTIAL_REF' as const, credentialId },
    modelId: 'gpt-5.6-codex',
    contextWindowTokens: 200_000,
    maxOutputTokens: 32_000,
    inputCapabilities: ['TEXT', 'IMAGE'] as const,
    outputCapabilities: ['TEXT'] as const,
    reasoningEfforts: ['high'] as const,
    hostedWebSearch: true,
    responsesTransport: { transport: 'WEBSOCKET' as const },
    responsesPreviousResponseId: true,
    enabled: true
  };
}

function service(
  options: {
    readonly key?: Buffer;
    readonly now?: () => number;
    readonly credentialId?: string;
  } = {}
) {
  const resolveCredential = vi.fn(async () => ({
    bearer: 'access-secret',
    headers: {
      'ChatGPT-Account-ID': 'account-secret',
      originator: 'myagentroam'
    },
    expiresAt: NOW + 60 * 60 * 1000,
    revision: 7
  }));
  const readModel = vi.fn(async () => storedModel(options.credentialId));
  const canUseModel = vi.fn(async () => true);
  const canUseCredential = vi.fn(async () => undefined);
  const runtimeCredentials = new RuntimeCredentialService({
    resolveCredential,
    readModel,
    canUseModel,
    canUseCredential,
    now: options.now ?? (() => NOW),
    nonce: (() => {
      let next = 0;
      return () => `nonce-${++next}`;
    })(),
    hmacKey: options.key ?? Buffer.alloc(32, 1)
  });
  return {
    runtimeCredentials,
    resolveCredential,
    readModel,
    canUseModel,
    canUseCredential
  };
}

describe('Server MAR Agent runtime credential service', () => {
  it('persists one private runtime credential HMAC key in the Server data directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mar-runtime-credential-key-'));
    try {
      const first = loadOrCreateRuntimeCredentialHmacKey(directory);
      const second = loadOrCreateRuntimeCredentialHmacKey(directory);
      const path = join(directory, 'runtime-credential-hmac.key');

      expect(first).toHaveLength(32);
      expect(second).toEqual(first);
      expect(await readFile(path)).toEqual(first);
      if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('extends an active task across multiple ticket lifetimes while rechecking authorization', async () => {
    let now = NOW;
    const fixture = service({ now: () => now });
    fixture.runtimeCredentials.activateNodeConnection('node-1');
    let ticket = await fixture.runtimeCredentials.issue({
      userId: 7,
      credentialId: 'credential-1',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      runtimeScopeId: 'scope-1',
      allowedModelIds: ['model-codex']
    });
    const initialExpiry = ticket.expiresAt;

    for (let revision = 1; revision <= 3; revision++) {
      now += 23 * 60 * 60 * 1000;
      fixture.resolveCredential.mockResolvedValue({
        bearer: `access-${revision}`,
        headers: { 'ChatGPT-Account-ID': 'account-secret', originator: 'myagentroam' },
        expiresAt: now + 60 * 60 * 1000,
        revision
      });
      const result = await fixture.runtimeCredentials.resolve('node-1', {
        ticket,
        modelId: 'model-codex',
        runtimeScopeId: 'scope-1',
        executionId: 'execution-1',
        reason: 'REQUEST'
      });
      expect(result).not.toHaveProperty('error');
      if ('error' in result) throw new Error(result.error.code);
      expect(result.credential.revision).toBe(revision);
      expect(result.nextTicket).toMatchObject({
        userId: 7,
        credentialId: 'credential-1',
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        runtimeScopeId: 'scope-1',
        allowedModelIds: ['model-codex']
      });
      ticket = result.nextTicket;
      expect(ticket.expiresAt).toBe(now + 24 * 60 * 60 * 1000);
    }
    expect(now).toBeGreaterThan(initialExpiry);
    expect(fixture.canUseModel).toHaveBeenCalledTimes(4);
    expect(fixture.canUseCredential).toHaveBeenCalledTimes(4);
  });

  it('signs a 24-hour ticket and validates Node, Workspace, Session, scope and model bindings', async () => {
    const fixture = service();
    fixture.runtimeCredentials.activateNodeConnection('node-1');
    const ticket = await fixture.runtimeCredentials.issue({
      userId: 7,
      credentialId: 'credential-1',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      runtimeScopeId: 'scope-1',
      allowedModelIds: ['model-codex']
    });

    expect(ticket.expiresAt - ticket.issuedAt).toBe(24 * 60 * 60 * 1000);
    expect(fixture.resolveCredential).not.toHaveBeenCalled();
    await expect(
      fixture.runtimeCredentials.resolve('node-1', {
        ticket,
        modelId: 'model-codex',
        runtimeScopeId: 'scope-1',
        executionId: 'execution-1',
        reason: 'REQUEST'
      })
    ).resolves.toMatchObject({
      credential: {
        bearer: 'access-secret',
        headers: { 'ChatGPT-Account-ID': 'account-secret' },
        revision: 7
      },
      nextTicket: {
        credentialId: 'credential-1',
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        runtimeScopeId: 'scope-1',
        allowedModelIds: ['model-codex']
      }
    });

    for (const changed of [
      { ...ticket, nodeId: 'node-2' },
      { ...ticket, userId: 8 },
      { ...ticket, workspaceId: 'workspace-2' },
      { ...ticket, sessionId: 'session-2' },
      { ...ticket, runtimeScopeId: 'scope-2' },
      { ...ticket, allowedModelIds: ['model-other'] }
    ])
      await expect(
        fixture.runtimeCredentials.resolve('node-1', {
          ticket: changed,
          modelId: changed.allowedModelIds[0]!,
          runtimeScopeId: changed.runtimeScopeId,
          executionId: 'execution-1',
          reason: 'REQUEST'
        })
      ).resolves.toMatchObject({
        error: {
          code: 'MAR_AGENT_RUNTIME_CREDENTIAL_TICKET_INVALID',
          recoverable: false
        }
      });

    for (const request of [
      {
        ticket,
        modelId: 'model-codex',
        runtimeScopeId: 'scope-other',
        executionId: 'execution-1',
        reason: 'REQUEST' as const
      },
      {
        ticket,
        modelId: 'model-other',
        runtimeScopeId: 'scope-1',
        executionId: 'execution-1',
        reason: 'REQUEST' as const
      }
    ])
      await expect(fixture.runtimeCredentials.resolve('node-1', request)).resolves.toMatchObject({
        error: {
          code: 'MAR_AGENT_RUNTIME_CREDENTIAL_REQUEST_INVALID',
          recoverable: false
        }
      });
    expect(fixture.resolveCredential).toHaveBeenCalledOnce();
  });

  it('uses an independent credential-scope check for image generation tickets', async () => {
    const fixture = service();
    fixture.runtimeCredentials.activateNodeConnection('node-1');
    const ticket = await fixture.runtimeCredentials.issue({
      userId: 7,
      credentialId: 'credential-image',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      runtimeScopeId: 'scope-image',
      allowedModelIds: ['image-generation'],
      purpose: 'IMAGE_GENERATION'
    });

    expect(fixture.readModel).not.toHaveBeenCalled();
    expect(fixture.canUseModel).not.toHaveBeenCalled();
    expect(fixture.canUseCredential).toHaveBeenCalledWith(7, 'credential-image');
    await expect(
      fixture.runtimeCredentials.resolve('node-1', {
        ticket,
        modelId: 'image-generation',
        runtimeScopeId: 'scope-image',
        executionId: 'execution-image',
        reason: 'REQUEST'
      })
    ).resolves.toMatchObject({ credential: { bearer: 'access-secret' } });
    expect(fixture.canUseCredential).toHaveBeenCalledTimes(2);
  });

  it('keeps an unexpired 24-hour ticket across Server restart and Node reconnection, then rejects it after expiry', async () => {
    let now = NOW;
    const first = service({ now: () => now, key: Buffer.alloc(32, 1) });
    first.runtimeCredentials.activateNodeConnection('node-1');
    const ticket = await first.runtimeCredentials.issue({
      userId: 7,
      credentialId: 'credential-1',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      runtimeScopeId: 'scope-1',
      allowedModelIds: ['model-codex']
    });
    const request = {
      ticket,
      modelId: 'model-codex',
      runtimeScopeId: 'scope-1',
      executionId: 'execution-1',
      reason: 'REQUEST' as const
    };

    const restarted = service({ now: () => now, key: Buffer.alloc(32, 1) });
    restarted.runtimeCredentials.activateNodeConnection('node-1');
    await expect(restarted.runtimeCredentials.resolve('node-1', request)).resolves.toMatchObject({
      credential: { revision: 7 }
    });

    now = ticket.expiresAt + 60_001;
    await expect(first.runtimeCredentials.resolve('node-1', request)).resolves.toMatchObject({
      error: { code: 'MAR_AGENT_RUNTIME_CREDENTIAL_TICKET_EXPIRED', recoverable: false }
    });

    const wrongKey = service({ key: Buffer.alloc(32, 2) });
    wrongKey.runtimeCredentials.activateNodeConnection('node-1');
    await expect(wrongKey.runtimeCredentials.resolve('node-1', request)).resolves.toMatchObject({
      error: { code: 'MAR_AGENT_RUNTIME_CREDENTIAL_TICKET_INVALID', recoverable: false }
    });

    now = NOW;
    first.runtimeCredentials.activateNodeConnection('node-1');
    await expect(first.runtimeCredentials.resolve('node-1', request)).resolves.toMatchObject({
      credential: { revision: 7 }
    });

    const changedModel = service({ credentialId: 'credential-2' });
    changedModel.runtimeCredentials.activateNodeConnection('node-1');
    const changedTicket = await changedModel.runtimeCredentials.issue({
      userId: 7,
      credentialId: 'credential-2',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      runtimeScopeId: 'scope-1',
      allowedModelIds: ['model-codex']
    });
    changedModel.readModel.mockResolvedValueOnce(storedModel('credential-1'));
    await expect(
      changedModel.runtimeCredentials.resolve('node-1', {
        ...request,
        ticket: changedTicket
      })
    ).resolves.toMatchObject({
      error: {
        code: 'MAR_AGENT_RUNTIME_MODEL_CREDENTIAL_CHANGED',
        recoverable: false
      }
    });
  });

  it('rechecks the ticket user model authorization and credential scope on every resolve', async () => {
    const fixture = service();
    fixture.runtimeCredentials.activateNodeConnection('node-1');
    const ticket = await fixture.runtimeCredentials.issue({
      userId: 7,
      credentialId: 'credential-1',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      runtimeScopeId: 'scope-1',
      allowedModelIds: ['model-codex']
    });
    fixture.canUseModel.mockResolvedValue(false);

    await expect(
      fixture.runtimeCredentials.resolve('node-1', {
        ticket,
        modelId: 'model-codex',
        runtimeScopeId: 'scope-1',
        executionId: 'execution-1',
        reason: 'REQUEST'
      })
    ).resolves.toEqual({
      error: {
        code: 'MAR_AGENT_RUNTIME_MODEL_FORBIDDEN',
        message: 'The model is no longer authorized for this user.',
        recoverable: false
      }
    });
    expect(fixture.canUseModel).toHaveBeenLastCalledWith(7, 'model-codex');
    expect(fixture.resolveCredential).not.toHaveBeenCalled();
  });

  it('does not return credentials to a Node connection replaced during resolution', async () => {
    const resolution = deferred<{
      bearer: string;
      headers: Record<string, string>;
      expiresAt: number;
      revision: number;
    }>();
    const runtimeCredentials = new RuntimeCredentialService({
      resolveCredential: vi.fn(() => resolution.promise),
      readModel: vi.fn(async () => storedModel()),
      canUseModel: vi.fn(async () => true),
      now: () => NOW,
      nonce: (() => {
        let next = 0;
        return () => `nonce-${++next}`;
      })(),
      hmacKey: Buffer.alloc(32, 1)
    });
    runtimeCredentials.activateNodeConnection('node-1');
    const ticket = await runtimeCredentials.issue({
      userId: 7,
      credentialId: 'credential-1',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      runtimeScopeId: 'scope-1',
      allowedModelIds: ['model-codex']
    });

    const result = runtimeCredentials.resolve('node-1', {
      ticket,
      modelId: 'model-codex',
      runtimeScopeId: 'scope-1',
      executionId: 'execution-1',
      reason: 'REQUEST'
    });
    await vi.waitFor(() => expect(resolution.pending()).toBe(true));
    runtimeCredentials.activateNodeConnection('node-1');
    resolution.resolve({
      bearer: 'access-secret',
      headers: { 'ChatGPT-Account-ID': 'account-secret' },
      expiresAt: NOW + 60_000,
      revision: 1
    });

    await expect(result).resolves.toEqual({
      error: {
        code: 'MAR_AGENT_RUNTIME_CREDENTIAL_CONNECTION_INVALID',
        message: 'The Node control connection is no longer valid.',
        recoverable: false
      }
    });
    expect(JSON.stringify(await result)).not.toContain('access-secret');
  });

  it('maps credential failures to a safe stable response without leaking upstream details', async () => {
    const fixture = service();
    fixture.runtimeCredentials.activateNodeConnection('node-1');
    const ticket = await fixture.runtimeCredentials.issue({
      userId: 7,
      credentialId: 'credential-1',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      runtimeScopeId: 'scope-1',
      allowedModelIds: ['model-codex']
    });
    fixture.resolveCredential.mockRejectedValueOnce(
      new Error('CODEX_CREDENTIAL_REFRESH_TRANSIENT: upstream-secret')
    );

    const result = await fixture.runtimeCredentials.resolve('node-1', {
      ticket,
      modelId: 'model-codex',
      runtimeScopeId: 'scope-1',
      executionId: 'execution-1',
      reason: 'RECONNECT'
    });

    expect(result).toEqual({
      error: {
        code: 'CODEX_CREDENTIAL_REFRESH_TRANSIENT',
        message: 'The runtime credential is temporarily unavailable.',
        recoverable: true,
        retryAfterMs: 60_000
      }
    });
    expect(JSON.stringify(result)).not.toContain('upstream-secret');
  });

  it('accepts credential.resolve only from the current authenticated capable Node connection', async () => {
    const database = new ServerDatabase(':memory:');
    const runtimeCredentials = {
      activateNodeConnection: vi.fn(),
      deactivateNodeConnection: vi.fn(),
      resolve: vi.fn(async () => ({
        credential: {
          bearer: 'access-secret',
          headers: {},
          expiresAt: NOW + 60_000,
          revision: 1
        },
        nextTicket: {
          userId: 1,
          credentialId: 'credential-1',
          nodeId: 'node-1',
          workspaceId: 'workspace-1',
          runtimeScopeId: 'scope-1',
          allowedModelIds: ['model-codex'],
          issuedAt: NOW,
          expiresAt: NOW + 3_600_000,
          nonce: 'nonce-2',
          signature: 'a'.repeat(64)
        }
      }))
    };
    const control = createTestNodeControl(
      database,
      (userId, nodeId) => database.userOwnsNode(userId, nodeId),
      undefined,
      undefined,
      runtimeCredentials as never
    );
    const registration = database.createNodeRegistrationToken(database.getAdmin().id);
    const sent: Array<Record<string, unknown>> = [];
    type TestSocket = {
      readyState: number;
      OPEN: number;
      send(raw: string): void;
      close: ReturnType<typeof vi.fn>;
    };
    const socket: TestSocket = {
      readyState: 1,
      OPEN: 1,
      send(raw: string) {
        sent.push(JSON.parse(raw) as Record<string, unknown>);
      },
      close: vi.fn()
    };
    let nodeId: string | undefined;
    const handle = (target: TestSocket, envelope: ReturnType<typeof createEnvelope>) =>
      (
        control as unknown as {
          handleMessage(
            socket: TestSocket,
            raw: string,
            setNodeId: (value: string) => void,
            getNodeId: () => string | undefined
          ): Promise<void>;
        }
      ).handleMessage(
        target,
        JSON.stringify(envelope),
        (value) => {
          nodeId = value;
        },
        () => nodeId
      );
    const request = createEnvelope('credential.resolve', {
      ticket: {
        userId: 1,
        credentialId: 'credential-1',
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        runtimeScopeId: 'scope-1',
        allowedModelIds: ['model-codex'],
        issuedAt: NOW,
        expiresAt: NOW + 3_600_000,
        nonce: 'nonce-1',
        signature: 'b'.repeat(64)
      },
      modelId: 'model-codex',
      runtimeScopeId: 'scope-1',
      executionId: 'execution-1',
      reason: 'REQUEST'
    });

    await handle(socket, request);
    expect(sent.at(-1)).toMatchObject({
      type: 'error',
      payload: { code: 'NODE_UNAUTHENTICATED' }
    });

    sent.length = 0;
    await handle(
      socket,
      createEnvelope('register', {
        registrationToken: registration.token,
        capabilities: {
          platform: 'linux',
          architecture: 'x64',
          nodeAppVersion: '0.11.38',
          nodeVersion: 'v24.15.0',
          codex: { available: true },
          claudeCode: { available: true },
          marAgent: { available: true, version: '0.9.27' }
        }
      })
    );
    await handle(socket, request);
    expect(sent.at(-1)).toMatchObject({
      type: 'credential.response',
      payload: {
        error: {
          code: 'MAR_AGENT_RUNTIME_CREDENTIALS_UNSUPPORTED',
          recoverable: false
        }
      }
    });
    expect(runtimeCredentials.resolve).not.toHaveBeenCalled();

    sent.length = 0;
    await handle(
      socket,
      createEnvelope('capabilities', {
        platform: 'linux',
        architecture: 'x64',
        nodeAppVersion: '0.11.38',
        nodeVersion: 'v24.15.0',
        codex: { available: true },
        claudeCode: { available: true },
        marAgent: { available: true, version: '0.9.27' },
        marAgentRuntimeCredentials: {
          apiVersion: 1,
          websocket: true,
          httpVersions: ['1.1', '2']
        }
      })
    );
    await handle(socket, request);
    expect(runtimeCredentials.resolve).toHaveBeenCalledWith(nodeId, request.payload);
    expect(sent.at(-1)).toMatchObject({
      type: 'credential.response',
      replyTo: request.id,
      payload: { credential: { bearer: 'access-secret' } }
    });

    const staleSocket = { ...socket, send: vi.fn() };
    await (
      control as unknown as {
        handleMessage(
          socket: typeof staleSocket,
          raw: string,
          setNodeId: (value: string) => void,
          getNodeId: () => string | undefined
        ): Promise<void>;
      }
    ).handleMessage(
      staleSocket,
      JSON.stringify(request),
      () => undefined,
      () => nodeId
    );
    expect(staleSocket.send).toHaveBeenCalledOnce();
    expect(JSON.parse(staleSocket.send.mock.calls[0]![0])).toMatchObject({
      type: 'credential.response',
      replyTo: request.id,
      payload: {
        error: {
          code: 'MAR_AGENT_RUNTIME_CREDENTIAL_CONNECTION_INVALID',
          recoverable: false
        }
      }
    });
    expect(runtimeCredentials.resolve).toHaveBeenCalledOnce();
    control.close();
    database.close();
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  let pending = true;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = (value) => {
      pending = false;
      resolvePromise(value);
    };
    reject = (reason) => {
      pending = false;
      rejectPromise(reason);
    };
  });
  return { promise, resolve, reject, pending: () => pending };
}
