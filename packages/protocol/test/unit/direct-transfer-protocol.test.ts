import { describe, expect, it } from 'vitest';
import {
  directBrowserMessageSchema,
  directNodeCommandSchema,
  directTransferDescriptorSchema,
  nodeCapabilitiesSchema,
  nodeWorkbenchCapabilitiesSchema,
  terminalDirectBrowserMessageSchema,
  terminalDirectNodeCommandSchema,
  terminalDirectOpenFrameSchema
} from '../../src/index.js';

describe('workspace direct transfer protocol', () => {
  it('retains explicit root Git download targets but never accepts them for uploads', () => {
    const resource = {
      kind: 'WORKSPACE_FILE',
      workspaceId: 'w',
      path: 'same.txt',
      repositoryPath: ''
    };
    const descriptor = {
      direction: 'DOWNLOAD',
      resource,
      fileName: 'same.txt',
      size: 4,
      revision: 'rev'
    };
    expect(directTransferDescriptorSchema.parse(descriptor).resource).toEqual(resource);
    expect(
      directTransferDescriptorSchema.safeParse({
        direction: 'UPLOAD',
        resource,
        fileName: 'same.txt',
        size: 4,
        sha256: 'a'.repeat(64)
      }).success
    ).toBe(false);
  });
  it('keeps terminal grants separate from file transfer and rejects extra frames', () => {
    const terminal = {
      type: 'terminal.direct.prepare',
      requestId: 'request-001',
      nodeId: 'node-1',
      nodeGeneration: 'generation-001',
      transportSessionId: 'transport-001',
      terminalId: 'terminal-1',
      afterSequence: 0,
      readonly: false
    };
    expect(terminalDirectBrowserMessageSchema.safeParse(terminal).success).toBe(true);
    expect(
      terminalDirectBrowserMessageSchema.safeParse({ ...terminal, takeover: true }).success
    ).toBe(false);
    expect(directBrowserMessageSchema.safeParse(terminal).success).toBe(false);
    expect(
      terminalDirectBrowserMessageSchema.safeParse({ ...terminal, transfer: {} }).success
    ).toBe(false);
    expect(
      terminalDirectOpenFrameSchema.safeParse({
        type: 'OPEN',
        directSessionId: 'terminal-session-01',
        grant: 'a'.repeat(32)
      }).success
    ).toBe(true);
    expect(
      terminalDirectNodeCommandSchema.safeParse({
        type: 'terminal.direct.cancel',
        directSessionId: 'terminal-session-01',
        code: 'TERMINAL_REVOKED',
        grant: 'a'.repeat(32)
      }).success
    ).toBe(false);
  });

  it('publishes a versioned Node capability in both capability projections', () => {
    const capability = {
      apiVersion: 3,
      transport: true,
      upload: true,
      download: true,
      range: true,
      gitCommitBlob: true,
      maxChunkBytes: 512 * 1024
    } as const;
    expect(
      nodeCapabilitiesSchema.parse({
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: 'v24.0.0',
        codex: { available: false },
        claudeCode: { available: false },
        workspaceDirectTransfer: capability
      }).workspaceDirectTransfer
    ).toEqual(capability);
    expect(
      nodeCapabilitiesSchema.parse({
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: 'v24.0.0',
        codex: { available: false },
        claudeCode: { available: false },
        workspaceDirectTransfer: { ...capability, apiVersion: 2 }
      }).workspaceDirectTransfer?.apiVersion
    ).toBe(2);
    expect(
      nodeWorkbenchCapabilitiesSchema.parse({
        manifestVersion: 1,
        revision: 1,
        observedAt: 1,
        platform: 'linux',
        architecture: 'x64',
        conversation: {
          available: false,
          reasonCode: 'UNAVAILABLE',
          itemVersions: [1],
          supportsSessionCursor: false,
          supportsHistoryPaging: false,
          supportsItemFinalSnapshots: false,
          maxPageSize: 1
        },
        runners: [],
        files: {
          available: true,
          reasonCode: null,
          supportsList: true,
          supportsReadRange: true,
          supportsSearch: true,
          maxDirectoryPageSize: 1,
          maxReadBytes: 1,
          maxSearchResults: 1
        },
        directTransfer: capability,
        git: {
          available: false,
          reasonCode: 'UNAVAILABLE',
          supportsCurrentChanges: false,
          supportsTurnChanges: false,
          maxDiffBytes: 1
        },
        terminal: {
          available: false,
          reasonCode: 'UNAVAILABLE',
          supportsPty: false,
          supportsConPty: false,
          supportsReplay: false,
          supportsReadonlyAttach: false,
          supportsTakeover: false,
          maxTerminals: 0,
          maxReplayBytes: 0,
          reconnectWindowMs: 0,
          profiles: []
        }
      }).directTransfer
    ).toEqual(capability);
  });

  it('accepts Workspace upload and bound Range download descriptors', () => {
    expect(
      directTransferDescriptorSchema.parse({
        direction: 'UPLOAD',
        sha256: '0'.repeat(64),
        resource: { kind: 'WORKSPACE_FILE', workspaceId: 'workspace-1', path: 'large.bin' },
        fileName: 'large.bin',
        size: 1024,
        overwrite: false
      })
    ).toMatchObject({ direction: 'UPLOAD', size: 1024 });
    expect(
      directTransferDescriptorSchema.parse({
        direction: 'DOWNLOAD',
        resource: { kind: 'WORKSPACE_FILE', workspaceId: 'workspace-1', path: 'large.bin' },
        fileName: 'large.bin',
        revision: 'revision-1',
        size: 1024,
        range: { offset: 256, length: 512 }
      })
    ).toMatchObject({ direction: 'DOWNLOAD', range: { offset: 256, length: 512 } });
    expect(() =>
      directTransferDescriptorSchema.parse({
        direction: 'DOWNLOAD',
        resource: { kind: 'WORKSPACE_FILE', workspaceId: 'workspace-1', path: 'large.bin' },
        fileName: 'large.bin',
        revision: 'revision-1',
        size: 1024,
        range: { offset: 900, length: 200 }
      })
    ).toThrow();
    expect(() =>
      directTransferDescriptorSchema.parse({
        direction: 'UPLOAD',
        sha256: '0'.repeat(64),
        resource: {
          kind: 'HOSTED_CONVERSATION_FILE',
          conversationId: 'conversation-1',
          path: 'large.bin'
        },
        fileName: 'large.bin',
        size: 1024
      })
    ).toThrow();
  });

  it('requires a bounded full-file SHA-256 for uploads', () => {
    const descriptor = {
      direction: 'UPLOAD',
      resource: { kind: 'WORKSPACE_FILE', workspaceId: 'workspace-1', path: 'large.bin' },
      fileName: 'large.bin',
      size: 1024
    };
    expect(() => directTransferDescriptorSchema.parse(descriptor)).toThrow();
    expect(() =>
      directTransferDescriptorSchema.parse({ ...descriptor, sha256: 'g'.repeat(64) })
    ).toThrow();
    expect(
      directTransferDescriptorSchema.parse({ ...descriptor, sha256: '0'.repeat(64) })
    ).toMatchObject({ sha256: '0'.repeat(64) });
  });

  it('accepts an ICE connection confirmation and rejects caller-supplied pair details', () => {
    expect(
      directBrowserMessageSchema.parse({
        type: 'direct.connected',
        directSessionId: 'direct_1234'
      })
    ).toBeTruthy();
    expect(() =>
      directBrowserMessageSchema.parse({
        type: 'direct.connected',
        directSessionId: 'direct_1234',
        pair: { localAddress: '198.18.0.1' }
      })
    ).toThrow();
  });

  it('separates transport setup from transfer authorization', () => {
    expect(
      directBrowserMessageSchema.parse({
        type: 'direct.prepare',
        requestId: 'request_1234',
        nodeId: 'node-1',
        nodeGeneration: 'generation_1',
        purpose: 'TRANSPORT'
      }).type
    ).toBe('direct.prepare');
    const command = directNodeCommandSchema.parse({
      type: 'direct.prepare',
      directSessionId: 'direct_1234',
      workbenchConnectionId: 'connection_1',
      nodeGeneration: 'generation_1',
      purpose: 'TRANSFER',
      transportSessionId: 'transport_1234',
      expiresAt: Date.now() + 60_000,
      transfer: {
        direction: 'DOWNLOAD',
        resource: { kind: 'WORKSPACE_FILE', workspaceId: 'workspace-1', path: 'large.bin' },
        fileName: 'large.bin',
        size: 1024,
        revision: 'revision-1'
      },
      userAuthorization: { userId: 1 }
    });
    expect(command.type).toBe('direct.prepare');
    if (command.type !== 'direct.prepare') throw new Error('DIRECT_PREPARE_EXPECTED');
    expect(command.purpose).toBe('TRANSFER');
    if (command.purpose !== 'TRANSFER') throw new Error('DIRECT_TRANSFER_EXPECTED');
    expect(command.transportSessionId).toBe('transport_1234');
  });
});
