import { describe, expect, it } from 'vitest';
import {
  NODE_PROTOCOL_VERSION,
  capabilityAvailabilitySchema,
  codexCredentialSummarySchema,
  conversationItemDeltaSchema,
  conversationItemSchema,
  conversationImageAttachmentSchema,
  runImageReadInputSchema,
  eventCursorSchema,
  hostedConversationImageReadInputSchema,
  hostedConversationRollbackInputSchema,
  httpErrorResponseSchema,
  nodeErrorSchema,
  nodeEnvelopeSchema,
  nodeResponseErrorPayloadSchema,
  safePublicError,
  nodeCapabilitiesSchema,
  runnerCommandDescriptorSchema,
  runnerDefaultConfigurationSchema,
  runnerNameSchema,
  marAgentModelSummarySchema,
  marAgentNodeModelSummarySchema,
  marAgentRuntimeModelConfigurationSchema,
  agentRunStatusSchema,
  runEventSchema,
  runPerformanceSchema,
  runnerUsageSchema,
  runnerUsageStatusSchema,
  sessionRuntimeCapabilitySchema,
  serverWorkbenchCapabilitiesSchema,
  terminalAttachTicketSchema,
  terminalDataFrameSchema,
  watchAcceptedSchema,
  watchEventSchema,
  workspaceQueueSchema,
  workspaceFileListSchema,
  workspaceContentSearchSchema,
  workspaceFileReferenceSchema,
  workspaceSymbolDefinitionSchema,
  workspaceSymbolIndexPreparationSchema,
  workspaceChangesSummarySchema,
  workspaceGitTrackingSchema,
  workspaceSessionCleanupResultSchema,
  workbenchNodeOperationSchema
} from '../../src/index.js';

describe('Workbench protocol contracts', () => {
  it.each(['summary', 'visible_thinking', 'unspecified'] as const)(
    'preserves reasoning source %s and authoritative process identity',
    (representation) => {
      const item = {
        id: 'reasoning-one',
        sessionId: 'session',
        turnId: 'turn',
        runId: null,
        parentItemId: null,
        sourceSequence: null,
        revision: 0,
        status: 'COMPLETED',
        startedAt: null,
        completedAt: null,
        kind: 'reasoning',
        processGroup: { id: 'process-one', isStart: true },
        payload: { representation, sections: [{ index: 0, text: 'Public reasoning.' }] }
      };
      expect(conversationItemSchema.parse(item)).toEqual(item);
      expect(conversationItemSchema.safeParse({ ...item, kind: 'reasoning_summary' }).success).toBe(
        false
      );
      expect(conversationItemSchema.safeParse({ ...item, payload: { sections: [] } }).success).toBe(
        false
      );
      expect(
        conversationItemSchema.safeParse({ ...item, processGroup: { id: 'x'.repeat(129) } }).success
      ).toBe(false);
      expect(
        conversationItemSchema.safeParse({ ...item, processGroup: { id: 'p', isStart: false } })
          .success
      ).toBe(false);
    }
  );
  it('preserves optional bounded command titles without changing existing command payloads', () => {
    const item = {
      id: 'command',
      sessionId: 'session',
      turnId: 'turn',
      runId: null,
      parentItemId: null,
      sourceSequence: 1,
      revision: 0,
      kind: 'command_execution',
      status: 'COMPLETED',
      startedAt: 1,
      completedAt: 2,
      payload: {
        command: 'source',
        cwd: null,
        outputPreview: '',
        outputRef: null,
        exitCode: null,
        durationMs: null,
        truncated: false
      }
    };
    expect(conversationItemSchema.parse(item).payload).toEqual(item.payload);
    const titled = { ...item.payload, title: 'Code execution' };
    expect(conversationItemSchema.parse({ ...item, payload: titled }).payload).toEqual(titled);
    for (const title of ['', 'x'.repeat(129)])
      expect(
        conversationItemSchema.safeParse({ ...item, payload: { ...item.payload, title } }).success
      ).toBe(false);
  });
  it('preserves bounded upstream error codes without interpreting plain error text as codes', () => {
    const failure = safePublicError({
      code: 'service_unavailable_error',
      publicMessage: 'The model service is too busy.',
      publicDetails: 'Provider request ID: provider-request-1'
    });
    expect(failure.code).toBe('service_unavailable_error');
    expect(
      nodeResponseErrorPayloadSchema.parse({ error: failure.code, message: failure.message })
    ).toEqual({ error: 'service_unavailable_error', message: 'The model service is too busy.' });
    expect(
      httpErrorResponseSchema.parse({ error: { ...failure, requestId: 'req-1' } }).error
    ).toMatchObject(failure);
    expect(safePublicError(new Error('unavailable')).code).toBe('INTERNAL_ERROR');
    for (const code of ['not a code', 'a\0b', 'a'.repeat(129), '123']) {
      expect(safePublicError({ code }).code).toBe('INTERNAL_ERROR');
      expect(
        nodeResponseErrorPayloadSchema.safeParse({ error: code, message: 'Invalid.' }).success
      ).toBe(false);
    }
  });

  it('validates bounded local upstream tracking counts', () => {
    expect(
      workspaceGitTrackingSchema.parse({ upstream: 'origin/main', ahead: 2, behind: 3 })
    ).toEqual({ upstream: 'origin/main', ahead: 2, behind: 3 });
    for (const count of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
      expect(
        workspaceGitTrackingSchema.safeParse({ upstream: 'origin/main', ahead: count, behind: 0 })
          .success
      ).toBe(false);
      expect(
        workspaceGitTrackingSchema.safeParse({ upstream: 'origin/main', ahead: 0, behind: count })
          .success
      ).toBe(false);
    }
    expect(
      workspaceGitTrackingSchema.safeParse({ upstream: '', ahead: 0, behind: 0 }).success
    ).toBe(false);
  });

  it('registers session rollback as a fixed operation and runtime capability', () => {
    expect(workbenchNodeOperationSchema.parse('session.rollback')).toBe('session.rollback');
    expect(sessionRuntimeCapabilitySchema.parse('session.rollback')).toBe('session.rollback');
  });

  it('accepts independent transient performance metrics and rejects invalid facts', () => {
    for (const metrics of [
      { latencyMs: 0 },
      { tokensPerSecond: 0 },
      { latencyMs: 420, tokensPerSecond: 42 }
    ])
      expect(runPerformanceSchema.safeParse({ runId: 'run', ...metrics }).success).toBe(true);
    for (const metrics of [
      {},
      { latencyMs: -1 },
      { latencyMs: 1.5 },
      { ttftMs: 0 },
      { ttftMs: -1 },
      { ttftMs: 1.5 },
      { tokensPerSecond: -1 },
      { tokensPerSecond: Infinity },
      { tokensPerSecond: NaN }
    ])
      expect(runPerformanceSchema.safeParse({ runId: 'run', ...metrics }).success).toBe(false);
    expect(runPerformanceSchema.parse({ runId: 'run', latencyMs: 1, outputTokens: 8 })).toEqual({
      runId: 'run',
      latencyMs: 1
    });
  });

  it('accepts the destructive command interaction for Node-declared session mutations', () => {
    expect(
      runnerCommandDescriptorSchema.parse({
        id: 'clear',
        runner: 'mar-agent',
        label: '/clear',
        description: 'Clear the session.',
        inputHint: '/clear',
        source: 'MAR_RUNTIME',
        interaction: 'DESTRUCTIVE_ACTION',
        available: true,
        reasonCode: null
      })
    ).toMatchObject({ interaction: 'DESTRUCTIVE_ACTION' });
  });

  it('requires Runner deletion counts to reconcile a Workspace session cleanup result', () => {
    expect(
      workspaceSessionCleanupResultSchema.parse({
        deleted: 2,
        skipped: 3,
        failed: 0,
        deletedByRunner: { codex: 1, 'claude-code': 1 }
      })
    ).toMatchObject({ deleted: 2, deletedByRunner: { codex: 1, 'claude-code': 1 } });
    expect(
      workspaceSessionCleanupResultSchema.safeParse({
        deleted: 2,
        skipped: 3,
        failed: 0,
        deletedByRunner: { codex: 1 }
      }).success
    ).toBe(false);
  });

  it('accepts accurate partial cleanup counts without treating unfinished candidates as failures', () => {
    const partial = {
      deleted: 2,
      skipped: 3,
      failed: 0,
      deletedByRunner: { codex: 2 },
      timedOut: true,
      remaining: 4
    };
    expect(workspaceSessionCleanupResultSchema.parse(partial)).toEqual(partial);
    const { remaining: _remaining, ...unknownTotal } = partial;
    expect(workspaceSessionCleanupResultSchema.parse(unknownTotal)).toEqual(unknownTotal);
    const { timedOut: _timedOut, ...invalid } = partial;
    expect(workspaceSessionCleanupResultSchema.safeParse(invalid).success).toBe(false);
    expect(workspaceSessionCleanupResultSchema.safeParse({ ...partial, deleted: 3 }).success).toBe(
      false
    );
  });

  it('requires a bounded Node failure summary and preserves diagnostics and correlation', () => {
    expect(nodeResponseErrorPayloadSchema.safeParse({ error: 'FILE_NOT_FOUND' }).success).toBe(
      false
    );
    expect(
      nodeResponseErrorPayloadSchema.parse({
        error: 'INTERNAL_ERROR',
        message: 'An internal error occurred.',
        details: 'Git exited with status 128.',
        parameters: { operation: 'workspace.changes', attempt: 1 }
      })
    ).toEqual({
      error: 'INTERNAL_ERROR',
      message: 'An internal error occurred.',
      details: 'Git exited with status 128.',
      parameters: { operation: 'workspace.changes', attempt: 1 }
    });
    expect(
      httpErrorResponseSchema.parse({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An internal error occurred.',
          details: 'Git exited with status 128.',
          requestId: 'server-request-1',
          upstreamRequestId: 'node-request-1'
        }
      })
    ).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An internal error occurred.',
        details: 'Git exited with status 128.',
        requestId: 'server-request-1',
        upstreamRequestId: 'node-request-1'
      }
    });
  });

  it('distinguishes continuous Runs, Turns, and pending QueueItems', () => {
    expect(runnerNameSchema.parse('mar-agent')).toBe('mar-agent');
    expect(agentRunStatusSchema.safeParse('QUEUED').success).toBe(false);
    expect(
      workspaceQueueSchema.safeParse({
        version: 1,
        paused: false,
        items: [
          {
            queueItemId: 'queue-1',
            sessionId: 'session-1',
            workspaceId: 'workspace-1',
            runner: 'codex',
            clientMessageId: 'message-1',
            sessionTitle: 'Session',
            content: 'Next turn',
            createdAt: 1
          }
        ]
      }).success
    ).toBe(true);
    expect(
      workspaceQueueSchema.safeParse({
        version: 1,
        paused: false,
        items: [
          {
            run: { id: 'run-1', status: 'QUEUED' },
            sessionId: 'session-1',
            sessionTitle: 'Session',
            content: 'Legacy queue item'
          }
        ]
      }).success
    ).toBe(false);
  });

  it('rejects keys in MAR Agent model summaries and strictly validates independent runtime capabilities', () => {
    const summary = {
      id: 'coding',
      name: 'Coding',
      protocol: 'OPENAI_RESPONSES',
      baseUrl: 'https://example.test',
      modelId: 'coding',
      contextWindowTokens: 200000,
      maxOutputTokens: 16384,
      inputCapabilities: ['TEXT', 'IMAGE'],
      outputCapabilities: ['TEXT'],
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      defaultReasoningEffort: 'medium',
      hostedWebSearch: true,
      enabled: true,
      sortOrder: 0,
      access: 'PUBLIC',
      apiKeyConfigured: true
    };
    expect(marAgentModelSummarySchema.safeParse(summary).success).toBe(true);
    expect(
      marAgentModelSummarySchema.safeParse({ ...summary, reasoningEfforts: ['extreme'] }).success
    ).toBe(false);
    expect(
      marAgentModelSummarySchema.safeParse({ ...summary, reasoningEfforts: ['low', 'low'] }).success
    ).toBe(false);
    expect(
      marAgentModelSummarySchema.safeParse({
        ...summary,
        reasoningEfforts: ['low', 'high'],
        defaultReasoningEffort: 'medium'
      }).success
    ).toBe(false);
    expect(
      marAgentModelSummarySchema.safeParse({
        ...summary,
        reasoningEfforts: [],
        defaultReasoningEffort: 'medium'
      }).success
    ).toBe(true);
    expect(
      marAgentModelSummarySchema.safeParse({ ...summary, protocol: 'ANTHROPIC_MESSAGES' }).success
    ).toBe(false);
    expect(marAgentModelSummarySchema.safeParse({ ...summary, access: 'PRIVATE' }).success).toBe(
      false
    );
    expect(marAgentModelSummarySchema.safeParse({ ...summary, apiKey: 'secret' }).success).toBe(
      false
    );
    const { apiKeyConfigured, sortOrder, access, ...runtime } = summary;
    expect(apiKeyConfigured).toBe(true);
    expect(sortOrder).toBe(0);
    expect(access).toBe('PUBLIC');
    expect(
      marAgentNodeModelSummarySchema.safeParse({ ...runtime, apiKeyConfigured, sortOrder }).success
    ).toBe(true);
    expect(marAgentNodeModelSummarySchema.safeParse(summary).success).toBe(false);
    expect(
      marAgentNodeModelSummarySchema.parse({
        ...runtime,
        sortOrder,
        futureDisplayHint: { label: 'preview' }
      })
    ).not.toHaveProperty('futureDisplayHint');
    for (const field of ['access', 'apiKey', 'credential', 'imageGeneration']) {
      expect(
        marAgentNodeModelSummarySchema.safeParse({
          ...runtime,
          sortOrder,
          [field]: 'unexpected'
        }).success
      ).toBe(false);
    }
    expect(
      marAgentNodeModelSummarySchema.safeParse({
        ...runtime,
        sortOrder,
        serviceTier: 'invalid'
      }).success
    ).toBe(false);
    expect(
      marAgentRuntimeModelConfigurationSchema.safeParse({
        ...runtime,
        apiKey: 'secret'
      }).success
    ).toBe(true);
    expect(
      marAgentRuntimeModelConfigurationSchema.safeParse({
        ...runtime,
        apiKey: 'secret',
        inputCapabilities: ['IMAGE']
      }).success
    ).toBe(false);
  });

  it('strictly rejects removed extension fields in Codex credential summaries', () => {
    const summary = {
      id: 'credential-1',
      name: 'Team Codex',
      type: 'CODEX_OAUTH',
      ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 },
      status: 'ACTIVE',
      accessTokenExpiresAt: 1,
      lastRefreshAt: 1,
      lastCheckedAt: 1,
      accountId: 'account-secret',
      proxy: { configured: false },
      revision: 1
    };

    expect(codexCredentialSummarySchema.safeParse(summary).success).toBe(true);
    expect(
      codexCredentialSummarySchema.safeParse({
        ...summary,
        fedramp: false
      }).success
    ).toBe(false);
    expect(
      codexCredentialSummarySchema.safeParse({
        ...summary,
        custom: {}
      }).success
    ).toBe(false);
    expect(
      codexCredentialSummarySchema.safeParse({
        ...summary,
        importedModelCount: 0
      }).success
    ).toBe(false);
  });

  it('requires explicit Git repository origins and allows flat worktree groups with safe operation targets', () => {
    const grouped = workspaceChangesSummarySchema.parse({
      branch: 'develop',
      changes: [],
      repositories: [
        {
          repositoryPath: '',
          repositoryName: 'my-agent-roam',
          source: 'ROOT',
          physicalPath: '/workspace/my-agent-roam',
          current: true,
          branch: 'develop',
          tracking: { upstream: 'origin/develop', ahead: 2, behind: 3 },
          head: 'a'.repeat(40),
          status: 'DIRTY',
          locked: false,
          prunable: false,
          changes: []
        },
        {
          repositoryPath: '',
          repositoryName: 'review',
          source: 'WORKTREE',
          worktreePath: '/private/review',
          physicalPath: '/private/review',
          current: false,
          branch: 'agent/review',
          head: 'b'.repeat(40),
          status: 'CLEAN',
          locked: true,
          prunable: false,
          changes: []
        }
      ],
      worktrees: [
        {
          directoryName: 'my-agent-roam',
          branch: 'develop',
          head: 'a'.repeat(40),
          current: true,
          status: 'DIRTY',
          locked: false,
          prunable: false
        },
        {
          directoryName: 'review',
          branch: null,
          head: 'b'.repeat(64),
          current: false,
          status: 'UNAVAILABLE',
          locked: true,
          prunable: true
        }
      ],
      worktreesTruncated: false
    });
    expect(grouped.repositories[0]?.tracking).toEqual({
      upstream: 'origin/develop',
      ahead: 2,
      behind: 3
    });
    expect(grouped.repositories[1]?.tracking).toBeUndefined();
    expect(
      workspaceChangesSummarySchema.safeParse({
        branch: 'develop',
        changes: [],
        repositories: [
          {
            repositoryPath: '',
            repositoryName: 'review',
            source: 'WORKTREE',
            physicalPath: '/private/review',
            current: false,
            branch: 'agent/review',
            head: 'a'.repeat(40),
            status: 'CLEAN',
            locked: false,
            prunable: false,
            changes: []
          }
        ]
      }).success
    ).toBe(false);
    expect(
      workspaceChangesSummarySchema.safeParse({
        branch: 'develop',
        changes: [],
        repositories: [],
        worktrees: [
          {
            directoryName: 'review',
            path: '/private/review',
            branch: 'agent/review',
            head: 'a'.repeat(40),
            current: false,
            status: 'CLEAN',
            locked: false,
            prunable: false
          }
        ],
        worktreesTruncated: false
      }).success
    ).toBe(false);
    expect(
      workspaceChangesSummarySchema.safeParse({
        branch: 'develop',
        changes: [],
        repositories: [
          {
            repositoryPath: '',
            repositoryName: 'root',
            physicalPath: '/workspace/root',
            current: true,
            status: 'CLEAN',
            locked: false,
            prunable: false,
            branch: 'develop',
            changes: []
          }
        ]
      }).success
    ).toBe(false);
  });

  it('defines asynchronous Watch acceptance acknowledgements and page-targeted snapshots', () => {
    expect(workbenchNodeOperationSchema.parse('session.unwatch')).toBe('session.unwatch');
    expect(
      watchAcceptedSchema.safeParse({
        accepted: true,
        watchId: 'watch-id-1',
        nodeGeneration: 'generation-1',
        expiresAt: Date.now() + 1
      }).success
    ).toBe(true);
    expect(
      watchEventSchema.safeParse({
        type: 'watch.workspace.snapshot',
        workbenchConnectionId: 'connection-1',
        watchId: 'watch-id-1',
        nodeGeneration: 'generation-1',
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        topic: 'sessions',
        revision: 1,
        snapshotSequence: 1,
        expiresAt: Date.now() + 1,
        payload: { sessions: [] }
      }).success
    ).toBe(true);
    expect(
      watchEventSchema.safeParse({
        type: 'watch.workspace.snapshot',
        workbenchConnectionId: 'connection-1',
        watchId: 'watch-id-1',
        nodeGeneration: 'generation-1',
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        topic: 'sessions',
        revision: 1,
        snapshotSequence: 1,
        expiresAt: Date.now() + 1,
        payload: { sessions: [] },
        unexpected: true
      }).success
    ).toBe(false);
  });
  it('accepts an optional authoritative Run event timestamp', () => {
    expect(
      runEventSchema.parse({
        runId: 'run-old-node',
        sequence: 1,
        eventType: 'text.delta',
        payload: { text: 'hello' }
      }).createdAt
    ).toBeUndefined();
    expect(
      runEventSchema.parse({
        runId: 'run-1',
        sequence: 1,
        eventType: 'text.delta',
        payload: { text: 'hello' },
        createdAt: 1_700_000_000_000
      }).createdAt
    ).toBe(1_700_000_000_000);
  });

  it('accepts OpenCode as a product Runner', () => {
    expect(runnerNameSchema.parse('opencode')).toBe('opencode');
    expect(
      nodeCapabilitiesSchema.safeParse({
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: 'v24.0.0',
        codex: { available: false },
        claudeCode: { available: false },
        openCode: { available: true, version: '1.18.20' }
      }).success
    ).toBe(true);
    expect(
      runnerDefaultConfigurationSchema.safeParse({
        runner: 'opencode',
        model: 'openrouter/anthropic/claude-sonnet-4.5',
        effort: 'high',
        access: 'default'
      }).success
    ).toBe(true);
  });

  it('uses Node protocol v2 and rejects other envelopes', () => {
    expect(NODE_PROTOCOL_VERSION).toBe(2);
    expect(
      nodeEnvelopeSchema.safeParse({
        version: 2,
        id: 'node-request',
        type: 'node.request',
        payload: {}
      }).success
    ).toBe(true);
    for (const version of [1, 3, 4])
      expect(
        nodeEnvelopeSchema.safeParse({
          version,
          id: 'node-request',
          type: 'node.request',
          payload: {}
        }).success
      ).toBe(false);
  });

  it('requires an explanatory reason for unavailable capability', () => {
    expect(
      capabilityAvailabilitySchema.safeParse({ available: true, reasonCode: null }).success
    ).toBe(true);
    expect(
      nodeCapabilitiesSchema.safeParse({
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: 'v24.0.0',
        metadata: Object.fromEntries(
          Array.from({ length: 17 }, (_, index) => [`key${index}`, 'x'])
        ),
        codex: { available: false },
        claudeCode: { available: false }
      }).success
    ).toBe(false);
    expect(
      capabilityAvailabilitySchema.safeParse({ available: false, reasonCode: 'PTY_UNAVAILABLE' })
        .success
    ).toBe(true);
    expect(
      capabilityAvailabilitySchema.safeParse({ available: true, reasonCode: 'STALE' }).success
    ).toBe(false);
    expect(
      capabilityAvailabilitySchema.safeParse({ available: false, reasonCode: null }).success
    ).toBe(false);
  });

  it('rejects incompatible Workbench protocol versions', () => {
    const capability = {
      workbenchProtocolVersion: 1,
      serverVersion: '0.1.4',
      conversationItemVersions: [2],
      supportsSessionDetailStream: true,
      supportsTerminalBrowserRelay: true,
      supportsTerminalNodeDataChannel: true,
      maxSseSubscriptionsPerUser: 8,
      maxTerminalBrowserConnectionsPerUser: 2
    };
    expect(serverWorkbenchCapabilitiesSchema.safeParse(capability).success).toBe(true);
    expect(
      serverWorkbenchCapabilitiesSchema.safeParse({ ...capability, workbenchProtocolVersion: 2 })
        .success
    ).toBe(false);
  });

  it('accepts Node and Server application version metadata while keeping it optional', () => {
    expect(
      nodeCapabilitiesSchema.safeParse({
        platform: 'linux',
        architecture: 'x64',
        nodeAppVersion: '0.1.4',
        nodeVersion: 'v24.0.0',
        metadata: {
          osRelease: '6.8.0',
          osVersion: 'Linux',
          runtimeCommands: [
            {
              id: 'npx',
              command: 'npx',
              available: true,
              version: '10.9.2',
              path: '/usr/bin/npx'
            }
          ]
        },
        codex: { available: false },
        claudeCode: { available: false }
      }).success
    ).toBe(true);
    expect(
      nodeCapabilitiesSchema.safeParse({
        platform: 'windows',
        architecture: 'x64',
        nodeVersion: 'v24.0.0',
        codex: { available: false },
        claudeCode: { available: false }
      }).success
    ).toBe(true);
    expect(
      nodeCapabilitiesSchema.safeParse({
        platform: 'macos',
        architecture: 'arm64',
        nodeVersion: 'v24.0.0',
        codex: { available: false },
        claudeCode: { available: false }
      }).success
    ).toBe(true);
    expect(
      nodeCapabilitiesSchema.safeParse({
        platform: 'win32',
        architecture: 'x64',
        nodeVersion: 'v24.0.0',
        codex: { available: false },
        claudeCode: { available: false }
      }).success
    ).toBe(false);
    expect(
      serverWorkbenchCapabilitiesSchema.safeParse({
        workbenchProtocolVersion: 1,
        serverVersion: '0.1.4',
        conversationItemVersions: [2],
        supportsSessionDetailStream: false,
        supportsTerminalBrowserRelay: true,
        supportsTerminalNodeDataChannel: true,
        maxSseSubscriptionsPerUser: 8,
        maxTerminalBrowserConnectionsPerUser: 10
      }).success
    ).toBe(true);
  });

  it('requires a stable reason when a runner command is unavailable', () => {
    const command = {
      id: 'compact',
      runner: 'codex',
      label: 'Compact context',
      description: 'Compact the current session',
      inputHint: '/compact [instructions]',
      source: 'CODEX_APP_SERVER',
      interaction: 'IMMEDIATE_ACTION',
      available: false,
      reasonCode: 'RUNNER_COMMAND_UNSUPPORTED'
    };
    expect(runnerCommandDescriptorSchema.safeParse(command).success).toBe(true);
    expect(runnerCommandDescriptorSchema.safeParse({ ...command, reasonCode: null }).success).toBe(
      false
    );
  });

  it('types account usage separately from runner execution and closes its Node operations', () => {
    expect(
      runnerUsageStatusSchema.safeParse({
        runner: 'codex',
        available: false,
        reasonCode: 'OFFICIAL_OAUTH_REQUIRED'
      }).success
    ).toBe(true);
    expect(
      runnerUsageSchema.safeParse({
        runner: 'claude-code',
        windows: [
          {
            id: 'five_hour',
            label: '5-hour allowance',
            usedPercentage: 35,
            resetsAt: 1_000
          }
        ],
        fetchedAt: 500,
        cached: false
      }).success
    ).toBe(true);
    expect(workbenchNodeOperationSchema.safeParse('runner.usage.status').success).toBe(true);
    expect(workbenchNodeOperationSchema.safeParse('runner.usage.read').success).toBe(true);
  });

  it('accepts only typed conversation items and deltas', () => {
    const base = {
      id: 'item-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      runId: 'run-1',
      parentItemId: null,
      sourceSequence: 1,
      revision: 0,
      status: 'IN_PROGRESS',
      startedAt: 1,
      completedAt: null
    };
    const assistant = conversationItemSchema.parse({
      ...base,
      kind: 'assistant_message',
      status: 'COMPLETED',
      payload: {
        text: 'hello',
        format: 'markdown',
        model: null,
        performance: { latencyMs: 420, tokensPerSecond: 42 }
      }
    });
    expect(assistant.payload).not.toHaveProperty('performance');
    expect(
      conversationItemSchema.safeParse({
        ...base,
        kind: 'tool_call',
        payload: {
          namespace: 'mar-agent',
          toolName: 'agent_wait',
          title: 'agent_wait',
          inputSummary: '{"agentId":"task-1"}',
          outputSummary: null,
          progressLabel: null,
          errorCode: null,
          truncated: false,
          subagentOperation: 'STATUS',
          subagentWait: true,
          subagentId: 'task-1',
          subagentModelId: 'review',
          subagentModelName: 'Review Agent',
          subagentReasoningEffort: 'high',
          subagentLatestMessage: {
            itemId: 'message-1',
            turnId: 'turn-child-1',
            phase: 'final_answer',
            text: 'Inspection completed.',
            timestamp: '2026-09-12T00:00:00.000Z',
            truncated: false
          }
        }
      }).data
    ).toMatchObject({ payload: { subagentWait: true } });
    expect(
      conversationItemSchema.safeParse({
        ...base,
        kind: 'tool_call',
        payload: {
          namespace: 'mar-agent',
          toolName: 'agent_wait',
          title: 'agent_wait',
          inputSummary: null,
          outputSummary: null,
          progressLabel: null,
          errorCode: null,
          truncated: false,
          subagentOperation: 'STATUS',
          subagentLatestMessage: {
            itemId: 'message-1',
            turnId: 'turn-child-1',
            phase: 'final_answer',
            text: 'x'.repeat(10_001),
            timestamp: '2026-09-12T00:00:00.000Z'
          }
        }
      }).success
    ).toBe(false);
    expect(
      conversationItemSchema.safeParse({
        ...base,
        kind: 'tool_call',
        payload: {
          namespace: 'mar-agent',
          toolName: 'agent_wait',
          title: 'agent_wait',
          inputSummary: null,
          outputSummary: null,
          progressLabel: null,
          errorCode: null,
          truncated: false,
          subagentOperation: 'STATUS',
          subagentLatestMessage: {
            itemId: 'message-1',
            turnId: 'turn-child-1',
            phase: 'commentary',
            text: '\u{1F680}'.repeat(10_000),
            timestamp: '2026-09-12T00:00:00.000Z'
          }
        }
      }).success
    ).toBe(true);
    expect(
      conversationItemSchema.safeParse({
        ...base,
        kind: 'tool_call',
        payload: {
          namespace: 'mar-agent',
          toolName: 'agent_wait',
          title: 'agent_wait',
          inputSummary: null,
          outputSummary: null,
          progressLabel: null,
          errorCode: null,
          truncated: false,
          subagentOperation: 'UNKNOWN'
        }
      }).success
    ).toBe(false);
    expect(
      conversationItemSchema.safeParse({
        ...base,
        kind: 'error',
        status: 'FAILED',
        payload: {
          code: 'RUNNER_FAILED',
          message: 'x'.repeat(1001),
          recoverable: true,
          retryAfterMs: null
        }
      }).success
    ).toBe(false);
    expect(
      conversationItemSchema.safeParse({ ...base, kind: 'assistant_message', payload: {} }).success
    ).toBe(false);
    expect(
      conversationItemSchema.safeParse({
        ...base,
        kind: 'error',
        status: 'FAILED',
        payload: {
          code: 'HTTP_429',
          message: 'Too many requests.',
          httpStatus: 429,
          recoverable: true,
          retryAfterMs: null
        }
      }).success
    ).toBe(true);
    expect(
      conversationItemDeltaSchema.safeParse({
        kind: 'assistant_text_append',
        itemId: 'item-1',
        itemRevision: 1,
        text: 'world'
      }).success
    ).toBe(true);
    expect(conversationItemDeltaSchema.safeParse({ kind: 'raw_json', payload: {} }).success).toBe(
      false
    );
  });

  it('keeps compact lifecycle phases closed while accepting optional async state facts', () => {
    const base = {
      id: 'compact-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      runId: 'run-1',
      parentItemId: null,
      sourceSequence: 1,
      revision: 0,
      startedAt: 1,
      completedAt: null,
      kind: 'context_compaction'
    };
    const legacy = {
      ...base,
      status: 'IN_PROGRESS',
      payload: { phase: 'STARTED', summary: null }
    };
    expect(conversationItemSchema.parse(legacy).payload).toEqual(legacy.payload);

    const background = {
      ...base,
      status: 'IN_PROGRESS',
      payload: {
        phase: 'STARTED',
        summary: null,
        mode: 'BACKGROUND',
        stage: 'WAITING',
        anchorItemId: 'mar-agent-message:prefix'
      }
    };
    expect(conversationItemSchema.parse(background).payload).toEqual(background.payload);

    const retained = {
      ...base,
      status: 'COMPLETED',
      completedAt: 2,
      payload: {
        phase: 'COMPLETED',
        summary: null,
        mode: 'BACKGROUND',
        anchorItemId: 'mar-agent-message:prefix',
        retainedContext: true
      }
    };
    expect(conversationItemSchema.parse(retained).payload).toEqual(retained.payload);

    const failed = {
      ...base,
      status: 'FAILED',
      completedAt: 2,
      payload: {
        phase: 'STARTED',
        summary: null,
        mode: 'BACKGROUND',
        code: 'MAR_AGENT_COMPACT_FAILED'
      }
    };
    expect(conversationItemSchema.parse(failed).status).toBe('FAILED');
    expect(
      conversationItemSchema.safeParse({
        ...background,
        payload: { ...background.payload, stage: 'FAILED' }
      }).success
    ).toBe(false);
    expect(
      conversationItemSchema.safeParse({
        ...background,
        payload: { ...background.payload, phase: 'FAILED' }
      }).success
    ).toBe(false);
  });

  it('keeps controlled references for user image attachments and rejects host paths', () => {
    const item = {
      id: 'image-user',
      sessionId: 'session-1',
      turnId: 'turn-1',
      runId: null,
      parentItemId: null,
      sourceSequence: 1,
      revision: 0,
      kind: 'user_message',
      status: 'COMPLETED',
      startedAt: 1,
      completedAt: 2,
      payload: {
        clientMessageId: null,
        text: '',
        contexts: [],
        delivery: 'ACCEPTED',
        attachments: [
          {
            name: 'image.png',
            mime: 'image/png',
            runId: 'native-history:session-1',
            imageIndex: 0
          },
          { name: 'unavailable.png', mime: 'image/png' }
        ]
      }
    };
    expect(conversationItemSchema.parse(item).payload).toEqual(item.payload);
    expect(
      conversationItemSchema.safeParse({
        ...item,
        payload: {
          ...item.payload,
          attachments: [{ ...item.payload.attachments[0], localPath: '/private/image.png' }]
        }
      }).success
    ).toBe(false);
  });

  it('keeps controlled references for tool image attachments and rejects host paths', () => {
    const base = {
      id: 'image-item-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      runId: 'run-1',
      parentItemId: null,
      sourceSequence: 1,
      revision: 0,
      kind: 'tool_call' as const,
      status: 'COMPLETED' as const,
      startedAt: 1,
      completedAt: 2
    };
    const payload = {
      namespace: 'mar-agent',
      toolName: 'codex_image_gen',
      title: 'codex_image_gen',
      inputSummary: '{"prompt":"A lighthouse in a storm."}',
      outputSummary: 'image-call.png',
      progressLabel: null,
      errorCode: null,
      truncated: false,
      toolCategory: 'IMAGE_GENERATION' as const,
      attachments: [
        {
          name: 'image-call.png',
          mime: 'image/png',
          byteSize: 68,
          runId: 'native-history:session-1',
          imageIndex: 0
        }
      ]
    };

    expect(conversationItemSchema.parse({ ...base, payload }).payload).toEqual(payload);
    expect(
      conversationItemSchema.safeParse({
        ...base,
        payload: {
          ...payload,
          attachments: [
            {
              ...payload.attachments[0],
              localPath:
                '/private/home/.mar/agent/sessions/session-1/generated_images/image-call.png'
            }
          ]
        }
      }).success
    ).toBe(false);
    expect(
      conversationItemSchema.safeParse({
        ...base,
        payload: {
          ...payload,
          attachments: [{ name: 'image-call.png', mime: 'image/png', runId: 'run-1' }]
        }
      }).success
    ).toBe(false);
    expect(
      conversationItemSchema.safeParse({
        ...base,
        payload: { ...payload, toolCategory: 'SCREENSHOT' }
      }).success
    ).toBe(false);
  });

  it('keeps cursors scoped and terminal frames bounded', () => {
    expect(
      eventCursorSchema.safeParse({ scope: 'SESSION', streamId: 'session-1', cursor: 'opaque' })
        .success
    ).toBe(true);
    expect(
      eventCursorSchema.safeParse({ scope: 'UNKNOWN', streamId: 'session-1', cursor: 'opaque' })
        .success
    ).toBe(false);
    expect(
      terminalDataFrameSchema.safeParse({ type: 'input', terminalId: 'terminal-1', data: 'ls\n' })
        .success
    ).toBe(true);
    expect(
      terminalDataFrameSchema.safeParse({
        type: 'input',
        terminalId: 'terminal-1',
        data: 'x'.repeat(65537)
      }).success
    ).toBe(false);
    expect(
      terminalAttachTicketSchema.safeParse({
        ticket: 'a'.repeat(32),
        nodeId: 'node-1',
        terminalId: 'terminal-1',
        userSessionFingerprint: 'fingerprint',
        issuedAt: 10,
        expiresAt: 20
      }).success
    ).toBe(true);
    expect(
      terminalAttachTicketSchema.safeParse({
        ticket: 'a'.repeat(32),
        nodeId: 'node-1',
        terminalId: 'terminal-1',
        userSessionFingerprint: 'fingerprint',
        issuedAt: 20,
        expiresAt: 10
      }).success
    ).toBe(false);
  });

  it('keeps Workbench Node operations a closed allowlist', () => {
    expect(workbenchNodeOperationSchema.safeParse('session.graph').success).toBe(true);
    expect(workbenchNodeOperationSchema.safeParse('session.schedule.list').success).toBe(true);
    expect(workbenchNodeOperationSchema.safeParse('session.schedule.agent.save').success).toBe(
      true
    );
    expect(workbenchNodeOperationSchema.safeParse('session.schedule.agent.delete').success).toBe(
      false
    );
    expect(workbenchNodeOperationSchema.safeParse('workspace.files.list').success).toBe(true);
    expect(workbenchNodeOperationSchema.safeParse('workspace.files.mutate').success).toBe(true);
    expect(workbenchNodeOperationSchema.safeParse('workspace.sessions.cleanup').success).toBe(true);
    expect(workbenchNodeOperationSchema.safeParse('session.command.execute').success).toBe(true);
    expect(workbenchNodeOperationSchema.safeParse('session.context.read').success).toBe(true);
    expect(workbenchNodeOperationSchema.safeParse('runner.defaults.save').success).toBe(true);
    expect(workbenchNodeOperationSchema.safeParse('run.image.read').success).toBe(true);
    expect(workbenchNodeOperationSchema.safeParse('conversation.hosted.image.read').success).toBe(
      true
    );
    expect(workbenchNodeOperationSchema.safeParse('conversation.hosted.rollback').success).toBe(
      true
    );
    expect(workbenchNodeOperationSchema.safeParse('shell.execute').success).toBe(false);
  });

  it('keeps Hosted Conversation image reads owner-scoped and strict', () => {
    expect(
      hostedConversationImageReadInputSchema.safeParse({
        conversationId: 'conversation-1',
        runId: 'native-history:hosted:conversation-1',
        imageRef: 'file:session%3Agenerated.png'
      }).success
    ).toBe(true);
    expect(
      hostedConversationImageReadInputSchema.safeParse({
        conversationId: 'conversation-1',
        runId: 'native-history:hosted:conversation-1',
        imageIndex: -1
      }).success
    ).toBe(false);
    expect(
      hostedConversationImageReadInputSchema.safeParse({
        conversationId: 'conversation-1',
        runId: 'native-history:hosted:conversation-1',
        imageRef: 'file:session%3Agenerated.png',
        nodeId: 'node-1'
      }).success
    ).toBe(false);
  });

  it('pairs a controlled image namespace with exactly one selector', () => {
    const attachment = {
      name: 'generated.png',
      mime: 'image/png',
      runId: 'native-history:session',
      imageRef: 'file:session%3Agenerated.png'
    };
    expect(conversationImageAttachmentSchema.parse(attachment)).toEqual(attachment);
    for (const invalid of [
      { ...attachment, imageIndex: 0 },
      { ...attachment, runId: undefined },
      { ...attachment, imageRef: undefined },
      { ...attachment, imageRef: '/arbitrary/path.png' }
    ])
      expect(conversationImageAttachmentSchema.safeParse(invalid).success).toBe(false);
    expect(runImageReadInputSchema.safeParse({ runId: 'run-1', imageIndex: 0 }).success).toBe(true);
    expect(
      runImageReadInputSchema.safeParse({ runId: attachment.runId, imageRef: attachment.imageRef })
        .success
    ).toBe(true);
    expect(
      runImageReadInputSchema.safeParse({
        runId: attachment.runId,
        imageRef: attachment.imageRef,
        imageIndex: 0
      }).success
    ).toBe(false);
    expect(
      hostedConversationImageReadInputSchema.safeParse({
        conversationId: 'conversation-1',
        runId: 'native-history:hosted:conversation-1',
        imageIndex: 0
      }).success
    ).toBe(false);
  });

  it('keeps Hosted Conversation rollback owner-scoped and strict', () => {
    expect(
      hostedConversationRollbackInputSchema.safeParse({
        conversationId: 'conversation-1',
        turnId: 'turn-2',
        boundary: 'turn-1'
      }).success
    ).toBe(true);
    expect(
      hostedConversationRollbackInputSchema.safeParse({
        conversationId: 'conversation-1',
        turnId: 'turn-2',
        boundary: null,
        nodeId: 'node-1'
      }).success
    ).toBe(false);
  });

  it('types Node-local Composer defaults without creating a Runner default option', () => {
    expect(
      runnerDefaultConfigurationSchema.safeParse({
        runner: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'medium',
        access: 'on-request'
      }).success
    ).toBe(true);
    expect(
      runnerDefaultConfigurationSchema.safeParse({
        runner: 'codex',
        model: '',
        effort: 'medium',
        access: 'on-request'
      }).success
    ).toBe(false);
  });

  it('types Files results and stable Workbench errors', () => {
    expect(
      workspaceFileListSchema.safeParse({
        entries: [],
        nextCursor: null,
        truncated: false,
        indexState: 'BUILDING'
      }).success
    ).toBe(true);
    expect(
      workspaceFileListSchema.safeParse({
        entries: [
          {
            path: 'deep/foo.ts',
            name: 'foo.ts',
            kind: 'FILE',
            size: 10,
            modifiedAt: 1,
            score: 999.98
          }
        ],
        nextCursor: null,
        truncated: false,
        indexState: 'READY'
      }).success
    ).toBe(true);
    expect(
      workspaceFileListSchema.safeParse({
        entries: [],
        nextCursor: null,
        truncated: false,
        indexState: 'WAIT_FOREVER'
      }).success
    ).toBe(false);
    expect(
      workspaceFileListSchema.safeParse({
        entries: [
          { path: 'foo.ts', name: 'foo.ts', kind: 'FILE', size: 10, modifiedAt: 1, score: Infinity }
        ],
        nextCursor: null,
        truncated: false
      }).success
    ).toBe(false);
    expect(
      workspaceFileListSchema.safeParse({
        entries: [{ path: 'src/main.ts', name: 'main.ts', kind: 'FILE', size: 10, modifiedAt: 1 }],
        nextCursor: null,
        truncated: false
      }).success
    ).toBe(true);
    expect(
      workspaceFileListSchema.safeParse({
        entries: [{ path: '/etc/passwd' }],
        nextCursor: null,
        truncated: false
      }).success
    ).toBe(false);
    expect(
      workspaceContentSearchSchema.safeParse({
        matches: [{ path: 'src/main.ts', line: 2, column: 1, preview: 'needle' }],
        engine: 'RIPGREP',
        truncated: false,
        skippedFiles: 0
      }).success
    ).toBe(true);
    expect(workbenchNodeOperationSchema.safeParse('workspace.content.search').success).toBe(true);
    expect(workbenchNodeOperationSchema.safeParse('workspace.symbol.definition').success).toBe(
      true
    );
    expect(
      workspaceFileReferenceSchema.safeParse({
        languageId: 'c-family',
        extractorId: 'c-family.include',
        kind: 'include',
        value: 'hal/ZOSHalMisc.h',
        from: 10,
        to: 26,
        sourceContext: { text: '#include "hal/ZOSHalMisc.h"', position: 10 }
      }).success
    ).toBe(true);
    expect(
      workspaceFileReferenceSchema.safeParse({
        languageId: 'markdown',
        extractorId: 'markdown.inline',
        kind: 'relative-file',
        value: '../guide.md',
        anchor: 'install',
        from: 10,
        to: 26,
        sourceContext: { text: '[Guide](../guide.md#install)', position: 10 }
      }).success
    ).toBe(true);
    expect(
      workspaceFileReferenceSchema.safeParse({
        languageId: 'c-family',
        extractorId: 'c-family.include',
        kind: 'include',
        value: 'hal/ZOSHalMisc.h',
        from: 26,
        to: 10,
        sourceContext: { text: '#include "hal/ZOSHalMisc.h"', position: 10 }
      }).success
    ).toBe(false);
    expect(
      workspaceFileReferenceSchema.safeParse({
        languageId: 'c-family',
        extractorId: 'c-family.include',
        kind: 'include',
        value: 'hal/ZOSHalMisc.h',
        from: 10,
        to: 26,
        sourceContext: { text: '#include "hal/ZOSHalMisc.h"', position: 28 }
      }).success
    ).toBe(true);
    expect(
      workspaceFileReferenceSchema.safeParse({
        languageId: 'c-family',
        extractorId: 'c-family.include',
        kind: 'include',
        value: 'hal/ZOSHalMisc.h',
        from: 10,
        to: 26,
        sourceContext: { text: 'a'.repeat(8 * 1024 + 1), position: 10 }
      }).success
    ).toBe(false);
    expect(workbenchNodeOperationSchema.safeParse('workspace.symbol.prepare').success).toBe(true);
    expect(workspaceSymbolIndexPreparationSchema.safeParse({ state: 'BUILDING' }).success).toBe(
      true
    );
    expect(
      workspaceSymbolDefinitionSchema.safeParse({
        state: 'STALE',
        targets: [
          {
            path: 'src/main.ts',
            line: 2,
            kind: 'function',
            preview: 'export function example() {}'
          }
        ],
        truncated: false
      }).success
    ).toBe(true);
    expect(
      workspaceSymbolDefinitionSchema.safeParse({
        state: 'FAILED',
        targets: [],
        truncated: false,
        failureCode: 'SYMBOL_INDEX_BUILD_FAILED'
      }).success
    ).toBe(true);
    expect(nodeErrorSchema.safeParse({ code: 'TERMINAL_REPLAY_GAP' }).success).toBe(true);
    expect(nodeErrorSchema.safeParse({ code: 'SHELL_EXECUTE' }).success).toBe(false);
  });
});
