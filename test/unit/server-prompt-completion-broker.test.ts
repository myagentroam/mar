import { describe, expect, it, vi } from 'vitest';
import {
  createEnvelope,
  marAgentRuntimeModelConfigurationSchema,
  type ModelUsageGrant
} from '../../packages/protocol/src/index.js';
import { ModelUsageGrants } from '../../packages/server-core/src/model-usage-grant.js';
import { NodeRequestBroker } from '../../ee/server/src/service/node-request-broker.js';
import { testNodeBrokerServices } from '../support/node-broker-services.js';
import { PromptCompletionNodeService } from '../../mar-node/src/service/prompt-completion-node-service.js';

interface SentNodeRequest {
  readonly id: string;
  readonly payload: {
    readonly operation: string;
    readonly data: unknown;
    readonly userAuthorization: {
      readonly userId: number;
      readonly sessionHash: string;
      readonly usageGrant?: ModelUsageGrant;
    };
  };
}

describe('Prompt completion Node broker and identity', () => {
  it('issues verifiable work usage grants bound to the authenticated user, not payload fields', async () => {
    const sent: SentNodeRequest[] = [];
    const database = { userCanRequestNode: vi.fn(async () => true) };
    const grants = new ModelUsageGrants(Buffer.from('fake-test-signing-key'), () => 1_000);
    const broker = brokerFixture(database, sent, grants);
    const user = {
      userId: 7,
      sessionHash: 'fake-cookie-session-hash',
      workspaceId: 'authorized-workspace'
    };
    const forgedPayload = {
      userId: 999,
      sessionHash: 'fake-forged-session-hash',
      usageGrant: { scopeId: 'fake', token: 'fake' },
      workspaceId: 'authorized-workspace',
      request: { requestId: 'fake-request' }
    };

    const workPending = broker.request('node-1', 'prompt-completion.generate', forgedPayload, user);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const work = sent[0]!.payload.userAuthorization;
    expect(work).toMatchObject({ userId: 7, sessionHash: 'fake-cookie-session-hash' });
    expect(grants.verify('node-1', work.usageGrant)).toMatchObject({ userId: 7, mode: 'work' });
    expect(work.usageGrant).not.toEqual(forgedPayload.usageGrant);
    expect(sent[0]!.payload.data).toEqual(forgedPayload);

    broker.resolve(
      'node-1',
      createEnvelope('node.response', { result: { accepted: true } }, { replyTo: sent[0]!.id })
    );
    await expect(workPending).resolves.toEqual({ accepted: true });
    expect(database.userCanRequestNode).toHaveBeenCalledWith(
      7,
      'node-1',
      'prompt-completion.generate',
      forgedPayload,
      'authorized-workspace'
    );
    broker.close();
  });

  it('rejects a conflicting Workspace hint without forwarding or issuing a usage grant', async () => {
    const sent: SentNodeRequest[] = [];
    const database = { userCanRequestNode: vi.fn(async () => true) };
    const grants = { issue: vi.fn() };
    const broker = brokerFixture(database, sent, grants);
    await expect(
      broker.request(
        'node-1',
        'prompt-completion.generate',
        { workspaceId: 'forged-workspace' },
        { userId: 7, sessionHash: 'fake-cookie-session-hash', workspaceId: 'authorized-workspace' }
      )
    ).rejects.toThrow('NODE_ACCESS_DENIED');
    expect(sent).toHaveLength(0);
    expect(grants.issue).not.toHaveBeenCalled();
    expect(database.userCanRequestNode).not.toHaveBeenCalled();
    broker.close();
  });

  it('allows identity-checked cancel through revoked resource access but still requires caller identity', async () => {
    const sent: SentNodeRequest[] = [];
    const database = { userCanRequestNode: vi.fn(async () => false) };
    const broker = brokerFixture(database, sent);
    const user = { userId: 7, sessionHash: 'fake-cookie-session-hash' };
    const pending = broker.request(
      'node-1',
      'prompt-completion.cancel',
      {
        requestId: 'request-1',
        pageEpoch: 'page-1',
        intentSequence: 2
      },
      user
    );
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    expect(database.userCanRequestNode).not.toHaveBeenCalled();
    expect(sent[0]!.payload.userAuthorization).toMatchObject({
      userId: 7,
      sessionHash: user.sessionHash
    });
    broker.resolve(
      'node-1',
      createEnvelope('node.response', { result: { cancelled: true } }, { replyTo: sent[0]!.id })
    );
    await expect(pending).resolves.toEqual({ cancelled: true });
    await expect(
      broker.request(
        'node-1',
        'prompt-completion.cancel',
        {},
        {
          userId: 0,
          sessionHash: user.sessionHash
        }
      )
    ).rejects.toThrow('USER_AUTHORIZATION_REQUIRED');
    expect(sent).toHaveLength(1);
    broker.close();
  });

  it('cancels a Node generation only for the matching user, cookie session and page epoch', async () => {
    const model = marAgentRuntimeModelConfigurationSchema.parse({
      id: 'fake-model',
      name: 'Fake Model',
      protocol: 'OPENAI_RESPONSES',
      modelId: 'fake-model',
      baseUrl: 'https://model.invalid/v1',
      credential: { type: 'INLINE_API_KEY', value: 'fake-fixture-key' },
      contextWindowTokens: 32_000,
      maxOutputTokens: 512,
      inputCapabilities: ['TEXT'],
      outputCapabilities: ['TEXT'],
      reasoningEfforts: ['low'],
      hostedWebSearch: false,
      responsesPreviousResponseId: false,
      enabled: true
    });
    let generationSignal: AbortSignal | undefined;
    const generate = vi.fn(async (input: { readonly signal: AbortSignal }) => {
      generationSignal = input.signal;
      return new Promise<{ suggestion: string }>((resolve) => {
        input.signal.addEventListener('abort', () => resolve({ suggestion: 'Fake completion' }), {
          once: true
        });
      });
    });
    const service = new PromptCompletionNodeService({
      generation: () => 'fake-node-generation',
      observed: () => true,
      readPage: async () => [],
      references: async () => [],
      modelFactory: { create: () => [{} as never] },
      usage: { completion: vi.fn(() => ({ release: vi.fn() })) },
      generate: generate as never,
      now: () => 1_000
    });
    const operations = service.operations();
    const actor = { __requestUserId: 7, __workspaceWatchSessionHash: 'fake-cookie-session-a' };
    const target = { kind: 'WORKSPACE', workspaceId: 'workspace-1' } as const;
    try {
      const context = (await operations['prompt-completion.context']!({
        ...actor,
        target,
        runner: 'codex',
        sessionId: null,
        workbenchConnectionId: 'connection-1',
        pageEpoch: 'page-1'
      })) as { contextVersion: string; historyGeneration: string };
      const generation = operations['prompt-completion.generate']!({
        ...actor,
        target,
        workbenchConnectionId: 'connection-1',
        request: {
          trigger: 'MANUAL',
          completionMode: 'COMPLETE',
          draft: 'Please ',
          cursorPosition: 7,
          draftRevision: 1,
          contextVersion: context.contextVersion,
          historyGeneration: context.historyGeneration,
          requestId: 'request-1',
          pageEpoch: 'page-1',
          intentSequence: 1,
          runner: 'codex',
          sessionId: null
        },
        runtime: {
          workspaceId: 'workspace-1',
          authorizationView: 'fake-authorization-view',
          expiresAt: 31_000,
          runtimeScopeId: 'fake-runtime-scope',
          modelRevision: 'fake-model-revision',
          credentialScope: 'fake-credential-scope',
          model,
          reasoningEffort: 'low'
        },
        __usageGrant: { scopeId: '00000000-0000-4000-8000-000000000001', token: 'fake-usage-grant' }
      });
      await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());

      await operations['prompt-completion.cancel']!({
        __requestUserId: 8,
        __workspaceWatchSessionHash: 'fake-cookie-session-a',
        requestId: 'request-1',
        pageEpoch: 'page-1',
        intentSequence: 1
      });
      await operations['prompt-completion.cancel']!({
        __requestUserId: 7,
        __workspaceWatchSessionHash: 'fake-cookie-session-b',
        requestId: 'request-1',
        pageEpoch: 'page-1',
        intentSequence: 1
      });
      await operations['prompt-completion.cancel']!({
        ...actor,
        requestId: 'request-1',
        pageEpoch: 'other-page',
        intentSequence: 1
      });
      expect(generationSignal?.aborted).toBe(false);

      await operations['prompt-completion.cancel']!({
        ...actor,
        requestId: 'request-1',
        pageEpoch: 'page-1',
        intentSequence: 1
      });
      await expect(generation).resolves.toMatchObject({
        status: 'cancelled',
        requestId: 'request-1'
      });
      expect(generationSignal?.aborted).toBe(true);
    } finally {
      service.dispose();
    }
  });
});

function brokerFixture(
  database: { userCanRequestNode: () => Promise<boolean> },
  sent: SentNodeRequest[],
  usageGrants: Pick<ModelUsageGrants, 'issue'> = testNodeBrokerServices().usageGrants
): NodeRequestBroker {
  const socket = {
    readyState: 1,
    OPEN: 1,
    send(raw: string) {
      sent.push(JSON.parse(raw) as SentNodeRequest);
    }
  };
  return new NodeRequestBroker(
    database as never,
    database.userCanRequestNode,
    () => socket as never,
    { allows: () => true },
    { ...testNodeBrokerServices(), usageGrants }
  );
}
