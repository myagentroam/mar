import { describe, expect, it, vi } from 'vitest';
import { SessionInputService } from '../../src/session-input-service.js';
import type {
  MarctlServerUrlForNode,
  MarctlUserCredentials
} from '../../src/marctl-user-credentials.js';

function fixture(
  overrides: {
    readonly publicOrigin?: string;
    readonly marctlServerUrlForNode?: MarctlServerUrlForNode;
    readonly userCredentials?: MarctlUserCredentials;
  } = {}
) {
  const requestNode = vi.fn().mockResolvedValue({
    accepted: true,
    auditReceipt: { sessionId: 'new-session', inputMode: 'NEW_SESSION' }
  });
  const resolve = vi.fn().mockResolvedValue({ TOKEN: 'private', MAR_USERNAME: 'forged' });
  const prepare = vi.fn().mockResolvedValue({ runtimeScopeId: 'scope', models: [] });
  const recordSharedConversation = vi.fn().mockResolvedValue(undefined);
  const service = new SessionInputService({
    nodeControl: { requestNode },
    secrets: { resolve },
    publicOrigin: overrides.publicOrigin,
    ...(overrides.marctlServerUrlForNode === undefined
      ? {}
      : { marctlServerUrlForNode: overrides.marctlServerUrlForNode }),
    ...(overrides.userCredentials === undefined
      ? {}
      : { userCredentials: overrides.userCredentials }),
    marAgentRuntimeModels: { prepare },
    audits: { recordSharedConversation }
  });
  const context = {
    nodeId: 'node',
    workspaceId: 'workspace',
    user: { userId: 7, username: 'alice', sessionHash: 'fingerprint' }
  };
  return { service, context, requestNode, resolve, prepare, recordSharedConversation };
}

describe('SessionInputService execution entry', () => {
  it('starts with a new runtime scope and retains trusted CLI metadata without returning secrets', async () => {
    const f = fixture();
    const result = await f.service.startSession(
      f.context,
      {
        runner: 'mar-agent',
        cwd: '/fixture',
        content: 'hello',
        clientMessageId: 'message',
        modelId: 'selected',
        customTitle: 'CLI title',
        parentSessionId: 'parent'
      },
      { marctlOrigin: { sessionId: 'source', name: 'Source' }, suppressNotifications: true }
    );
    expect(f.prepare).toHaveBeenCalledWith({
      userId: 7,
      nodeId: 'node',
      workspaceId: 'workspace',
      selectedModelId: 'selected'
    });
    expect(f.requestNode).toHaveBeenLastCalledWith(
      'node',
      'session.start',
      expect.objectContaining({
        customTitle: 'CLI title',
        parentSessionId: 'parent',
        modelId: 'selected',
        secretEnvironment: { TOKEN: 'private', MAR_USERNAME: 'alice' },
        marAgentRuntimeScopeId: 'scope',
        __marctlOrigin: { sessionId: 'source', name: 'Source' },
        __suppressNotifications: true
      }),
      { userId: 7, sessionHash: 'fingerprint', workspaceId: 'workspace' },
      undefined
    );
    expect(result).not.toHaveProperty('secretEnvironment');
    await vi.waitFor(() => expect(f.recordSharedConversation).toHaveBeenCalledTimes(1));
  });

  it('preserves a non-MAR start model without preparing MAR credentials', async () => {
    const f = fixture();
    await f.service.startSession(f.context, {
      runner: 'codex',
      cwd: '/fixture',
      content: 'hello',
      clientMessageId: 'message',
      modelId: 'codex-model'
    });
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.requestNode.mock.calls[0]?.[2]).toMatchObject({ modelId: 'codex-model' });
  });

  it('uses a managed Node URL only for its exact node identity', async () => {
    const publicOrigin = 'https://public.invalid';
    const localServerUrl = 'http://127.0.0.1:5190';
    const environment = vi.fn(async (_user: unknown, serverUrl?: string) => ({
      MAR_CTL_SERVER_URL: serverUrl ?? ''
    }));
    const f = fixture({
      publicOrigin,
      marctlServerUrlForNode: (nodeId) => (nodeId === 'managed-node' ? localServerUrl : undefined),
      userCredentials: { environment } as unknown as MarctlUserCredentials
    });

    for (const [nodeId, expectedServerUrl] of [
      ['managed-node', localServerUrl],
      ['remote-node', publicOrigin]
    ] as const) {
      await f.service.startSession(
        { ...f.context, nodeId },
        {
          runner: 'codex',
          cwd: '/fixture',
          content: 'hello',
          clientMessageId: `message-${nodeId}`
        }
      );

      const forwarded = f.requestNode.mock.calls.at(-1)?.[2] as {
        readonly secretEnvironment?: Readonly<Record<string, string>>;
      };
      expect(forwarded.secretEnvironment?.MAR_CTL_SERVER_URL).toBe(expectedServerUrl);
      expect(f.requestNode.mock.calls.at(-1)?.[0]).toBe(nodeId);
      expect(f.requestNode.mock.calls.at(-1)?.[3]).toMatchObject({
        userId: 7,
        sessionHash: 'fingerprint',
        workspaceId: 'workspace'
      });
    }
  });

  it('audits preparation failure once and never dispatches the execution', async () => {
    const f = fixture();
    f.resolve.mockRejectedValue(new Error('RESOURCE_ACCESS_DENIED'));
    await expect(
      f.service.startSession(f.context, {
        runner: 'codex',
        cwd: '/fixture',
        content: 'private input',
        clientMessageId: 'message'
      })
    ).rejects.toThrow('RESOURCE_ACCESS_DENIED');
    expect(f.requestNode).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(f.recordSharedConversation).toHaveBeenCalledTimes(1));
    expect(f.recordSharedConversation.mock.calls[0]?.[0]).toMatchObject({
      eventType: 'shared_conversation_input_rejected',
      receipt: { inputMode: 'NEW_SESSION' }
    });
    expect(f.recordSharedConversation.mock.calls[0]?.[0]).not.toHaveProperty('userMessage');
  });

  it('retains optional Workspace command scope and keeps interruption lightweight', async () => {
    const f = fixture();
    const target = { nodeId: f.context.nodeId, sessionId: 'session', user: f.context.user };
    await f.service.executeCommand(target, { commandId: 'compact', input: '/compact' });
    expect(f.resolve).toHaveBeenCalledWith(7, 'node', undefined);
    expect(f.requestNode.mock.calls[0]?.[2]).toEqual({
      sessionId: 'session',
      commandId: 'compact',
      input: '/compact',
      secretEnvironment: { TOKEN: 'private', MAR_USERNAME: 'alice' }
    });
    f.resolve.mockClear();
    await f.service.interrupt(target);
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.recordSharedConversation).not.toHaveBeenCalled();
    expect(f.requestNode.mock.calls[1]?.[2]).toEqual({ sessionId: 'session' });
  });

  it('uses the target Session for message model scope and contains audit write failures', async () => {
    const f = fixture();
    f.recordSharedConversation.mockRejectedValue(new Error('AUDIT_UNAVAILABLE'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(
        f.service.submitMessage(
          { ...f.context, sessionId: 'target' },
          { clientMessageId: 'message', content: 'hello', modelId: 'selected' }
        )
      ).resolves.toMatchObject({ accepted: true });
      expect(f.prepare).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'target' }));
      await vi.waitFor(() => expect(warning).toHaveBeenCalledWith('AUDIT_WRITE_FAILED'));
      expect(f.requestNode).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
    }
  });
});
