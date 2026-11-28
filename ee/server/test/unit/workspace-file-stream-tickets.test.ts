import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { DirectTransferDescriptor } from '@myagentroam/protocol';
import { NodeRequestAdmissionError } from '@myagentroam/server-core/node-request-error';
import { WorkspaceFileStreamTickets } from '../../src/service/workspace-file-stream-tickets.js';

const user = { userId: 7, sessionHash: 'test-session' };
const descriptor = {
  direction: 'DOWNLOAD',
  resource: { kind: 'WORKSPACE_FILE', workspaceId: 'workspace', path: 'file' },
  fileName: 'file',
  size: 1,
  revision: 'revision'
} satisfies DirectTransferDescriptor;

describe('Workspace file stream tickets', () => {
  it('restricts a share ticket to its share principal and rejects a revoked share before Node preparation', async () => {
    const prepare = vi.fn(async () => ({ grant: randomUUID() }));
    const tickets = new WorkspaceFileStreamTickets({ allowed: () => true, prepare });
    const scope = new AbortController();
    const share = { sessionId: 'original-session', allowed: vi.fn(async () => true) };
    const principal = { ...user, sessionHash: 'share-fingerprint' };
    try {
      const ticket = await tickets.issue({ nodeId: 'node', user: principal, descriptor, share });
      expect(
        await tickets.authorize('file-download', ticket, 'node', user, scope.signal)
      ).toBeUndefined();
      share.allowed.mockRejectedValue(new Error('SESSION_SHARE_NOT_FOUND'));
      expect(
        await tickets.authorize('file-download', ticket, 'node', principal, scope.signal)
      ).toEqual({ code: 'RESOURCE_DENIED' });
      expect(prepare).not.toHaveBeenCalled();
      expect(
        await tickets.authorize('file-download', ticket, 'node', principal, scope.signal)
      ).toBeUndefined();
    } finally {
      scope.abort();
      tickets.close();
    }
  });

  it('binds preparation to one user session, node, Workspace and direction', async () => {
    const grant = randomUUID();
    const prepare = vi.fn(async () => ({ grant }));
    const tickets = new WorkspaceFileStreamTickets({ allowed: () => true, prepare });
    const ticket = await tickets.issue({ nodeId: 'node', user, descriptor });
    expect(prepare).not.toHaveBeenCalled();
    const scope = new AbortController();
    const signal = scope.signal;
    expect(await tickets.authorize('file-download', ticket, 'other', user, signal)).toBeUndefined();
    expect(
      await tickets.authorize(
        'file-download',
        ticket,
        'node',
        { ...user, sessionHash: 'other' },
        signal
      )
    ).toBeUndefined();
    expect(await tickets.authorize('file-upload', ticket, 'node', user, signal)).toBeUndefined();
    expect(prepare).not.toHaveBeenCalled();
    const admitted = await tickets.authorize('file-download', ticket, 'node', user, signal);
    expect(admitted).toEqual({ grant, revoked: expect.any(AbortSignal) });
    expect(await tickets.authorize('file-download', ticket, 'node', user, signal)).toBeUndefined();
    expect(prepare).toHaveBeenCalledOnce();
    scope.abort();
    expect(admitted && 'revoked' in admitted && admitted.revoked.aborted).toBe(true);
    tickets.close();
  });

  it('preserves admitted ordinary downloads but denies new opens and revokes private attachments', async () => {
    const scope = new AbortController();
    let revoked: string | undefined;
    const allowed = vi.fn(
      (_user: number, _node: string, workspace: string) => workspace !== revoked
    );
    const tickets = new WorkspaceFileStreamTickets({
      allowed,
      prepare: async (ticket) => {
        if (!allowed(ticket.user.userId, ticket.nodeId, ticket.descriptor.resource.workspaceId))
          throw new NodeRequestAdmissionError('WORKSPACE_ACCESS_DENIED');
        return { grant: randomUUID() };
      }
    });
    const issue = (workspaceId: string, path = 'file') =>
      tickets.issue({
        nodeId: 'node',
        user,
        descriptor: {
          ...descriptor,
          resource: { ...descriptor.resource, workspaceId, path }
        }
      });
    const admit = async (ticket: string) => {
      const result = await tickets.authorize('file-download', ticket, 'node', user, scope.signal);
      if (result === undefined || !('revoked' in result)) throw new Error('Expected a grant');
      return result.revoked;
    };
    const attachment = `mar-attachment://${randomUUID()}/file`;
    try {
      const ordinary = await admit(await issue('first'));
      const privateFile = await admit(await issue('first', attachment));
      const other = await admit(await issue('second', attachment));
      const pending = await issue('first');
      revoked = 'first';
      allowed.mockClear();
      await tickets.revalidateResource({ nodeId: 'node', workspaceId: 'first' });
      expect(allowed).toHaveBeenCalledExactlyOnceWith(user.userId, 'node', 'first');
      expect(ordinary.aborted).toBe(false);
      expect(privateFile.aborted).toBe(true);
      expect(other.aborted).toBe(false);
      expect(await tickets.authorize('file-download', pending, 'node', user, scope.signal)).toEqual(
        { code: 'WORKSPACE_ACCESS_DENIED' }
      );
      await expect(issue('first')).rejects.toThrow('RESOURCE_DENIED');
      scope.abort();
      expect(ordinary.aborted).toBe(true);
    } finally {
      scope.abort();
      tickets.close();
    }
  });

  it('audits Composer at stream completion and leaves staged upload audit to its task', async () => {
    const audit = vi.fn();
    const tickets = new WorkspaceFileStreamTickets({
      allowed: () => true,
      prepare: async () => ({ grant: randomUUID() }),
      audits: { audit }
    });
    const transfer = {
      direction: 'UPLOAD',
      resource: descriptor.resource,
      fileName: descriptor.fileName,
      size: descriptor.size,
      sha256: '0'.repeat(64)
    } satisfies DirectTransferDescriptor;
    const scope = new AbortController();
    const staged = await tickets.issue({
      nodeId: 'node',
      user,
      descriptor: { ...transfer, uploadId: randomUUID() }
    });
    const stagedAdmission = await tickets.authorize(
      'file-upload',
      staged,
      'node',
      user,
      scope.signal
    );
    expect(stagedAdmission).toHaveProperty('grant');
    expect(stagedAdmission).not.toHaveProperty('onEnd', expect.any(Function));
    const ticket = await tickets.issue({
      nodeId: 'node',
      user,
      descriptor: { ...transfer, composerAttachment: { id: 'attachment-01', mime: 'text/plain' } }
    });
    const admission = await tickets.authorize('file-upload', ticket, 'node', user, scope.signal);
    expect(audit).not.toHaveBeenCalled();
    if (admission === undefined || !('grant' in admission)) throw new Error('Expected a grant');
    admission.onEnd?.();
    expect(audit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        actorUserId: user.userId,
        workspaceId: descriptor.resource.workspaceId,
        eventType: 'workspace.files.upload.complete',
        result: 'SUCCESS'
      })
    );
    scope.abort();
    tickets.close();
  });
});
