import type { DirectTransferDescriptor } from '@myagentroam/protocol';
import { emitAudit, type AuditObserver } from '@myagentroam/server-core/audit';
import type { UserNodeAuthorization } from '@myagentroam/server-core/node-access-contracts';
import { NodeRequestAdmissionError } from '@myagentroam/server-core/node-request-error';
import { FileStreamTickets } from './file-stream-tickets.js';

type Ticket = {
  readonly nodeId: string;
  readonly user: UserNodeAuthorization;
  readonly descriptor: DirectTransferDescriptor;
  readonly share?: { readonly allowed: () => Promise<boolean>; readonly sessionId: string };
};

/** Supplies Workspace authorization and audit policy to the shared Relay ticket owner. */
export class WorkspaceFileStreamTickets extends FileStreamTickets<Ticket> {
  constructor(options: {
    allowed(userId: number, nodeId: string, workspaceId: string): boolean | Promise<boolean>;
    prepare(ticket: Ticket, signal: AbortSignal): Promise<unknown>;
    audits?: AuditObserver;
  }) {
    super({
      kind: ({ descriptor }) =>
        descriptor.direction === 'UPLOAD' ? 'file-upload' : 'file-download',
      allowed: async ({ user, nodeId, descriptor, share }) =>
        (share === undefined || (await share.allowed())) &&
        options.allowed(user.userId, nodeId, descriptor.resource.workspaceId),
      prepare: async (ticket, signal) => {
        if (ticket.share !== undefined && !(await ticket.share.allowed().catch(() => false)))
          throw new NodeRequestAdmissionError('RESOURCE_DENIED');
        signal.throwIfAborted();
        return options.prepare(ticket, signal);
      },
      onEnd: (ticket) =>
        options.audits !== undefined &&
        ticket.descriptor.direction === 'UPLOAD' &&
        ticket.descriptor.uploadId === undefined
          ? (code) => auditUpload(options.audits!, ticket, code)
          : undefined
    });
  }
}

function auditUpload(audits: AuditObserver, ticket: Ticket, code?: string): void {
  const { descriptor, nodeId, user } = ticket;
  const workspaceId = descriptor.resource.workspaceId;
  emitAudit(audits, {
    eventType: 'workspace.files.upload.complete',
    actorUserId: user.userId,
    nodeId,
    workspaceId,
    targetType: 'WORKSPACE',
    targetId: workspaceId,
    result: code === undefined ? 'SUCCESS' : 'FAILED',
    ...(code === undefined ? {} : { errorCode: code }),
    metadata: JSON.stringify({
      action: 'workspace.files.upload.complete',
      relativePath: descriptor.resource.path,
      fileName: descriptor.fileName,
      sizeBytes: descriptor.size
    })
  });
}
