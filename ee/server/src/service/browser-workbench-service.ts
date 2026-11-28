import { parseBrowserStreamGrant } from '@myagentroam/protocol/browser-stream';
import {
  type BrowserControlRequest,
  type BrowserCapability,
  type BrowserSettingsSnapshot,
  type BrowserUpload,
  type BrowserUploadStream,
  browserDownloadInfoSchema,
  type BrowserDownloadRequest,
  type BrowserNodeAttachmentCommand
} from '@myagentroam/protocol';
import {
  BrowserAttachmentCoordinator,
  BrowserScopeRevoked,
  type BrowserAttachmentIdentity
} from '@myagentroam/server-core/browser-attachment-coordinator';
import type { DirectTransferCoordinator } from '@myagentroam/server-core/direct-transfer-coordinator';
import {
  matchesNodeResource,
  type NodeResourceScope,
  type NodeRequestAuthorization,
  type UserNodeAuthorization
} from '@myagentroam/server-core/node-access-contracts';
import type {
  WorkbenchDirectTransferIdentity,
  WorkbenchRelayService
} from '@myagentroam/server-core/workbench-relay-service';
import type { NodeRequestBroker } from './node-request-broker.js';
import { FileStreamTickets } from './file-stream-tickets.js';

type Scope = { nodeId: string; workspaceId: string };
type FileTicket = Scope & {
  user: UserNodeAuthorization;
  connectionId: string;
  generation: string;
  browserId: string;
} & (
    | { kind: 'browser-file-download'; id: string; size: number }
    | { kind: 'browser-file-upload'; upload: BrowserUploadStream }
  );
const browserUser = (identity: BrowserAttachmentIdentity): UserNodeAuthorization => ({
  userId: identity.userId,
  sessionHash: identity.sessionFingerprint
});

/** Composes Browser authorization and transport adapters with the shared Node
 * request channel. The coordinator owns grants and stream admissions. */
export class BrowserWorkbenchService {
  private readonly attachments: BrowserAttachmentCoordinator;
  private readonly fileTickets = new FileStreamTickets<FileTicket>({
    kind: (ticket) => ticket.kind,
    allowed: (ticket) => this.canTransfer(ticket),
    prepare: (ticket, signal) => this.prepareFileStream(ticket, signal)
  });
  private readonly directFiles = new Map<
    string,
    { user: UserNodeAuthorization; scope: AbortController }
  >();

  private async prepareFileStream(ticket: FileTicket, signal: AbortSignal, transportId?: string) {
    if (!(await this.canTransfer(ticket))) throw new Error('BROWSER_LEASE_ENDED');
    signal.throwIfAborted();
    const { nodeId, workspaceId, browserId, generation, user, connectionId } = ticket;
    if (
      transportId !== undefined &&
      !this.options.direct.authorizedTransport(
        { ...user, workbenchConnectionId: connectionId },
        transportId,
        nodeId,
        generation
      )
    )
      throw new Error('BROWSER_ICE_UNAVAILABLE');
    const payload =
      ticket.kind === 'browser-file-upload'
        ? ticket.upload
        : {
            workspaceId,
            browserId,
            command: { action: 'stream', id: ticket.id, size: ticket.size }
          };
    const result = await this.options.request(
      nodeId,
      ticket.kind === 'browser-file-upload' ? 'upload' : 'download',
      generation,
      { ...payload, ...(transportId !== undefined && { transportId }) },
      user
    );
    if (
      transportId !== undefined &&
      result &&
      typeof result === 'object' &&
      'grant' in result &&
      typeof result.grant === 'string'
    ) {
      const grant = result.grant;
      const revoke = () => {
        void this.options
          .request(nodeId, 'attachment', generation, { action: 'revoke-file-stream', grant }, user)
          .catch(this.options.failed);
      };
      if (signal.aborted) revoke();
      else signal.addEventListener('abort', revoke, { once: true });
    }
    return result;
  }

  constructor(
    private readonly options: {
      workbench: WorkbenchRelayService;
      direct: DirectTransferCoordinator;
      request: NodeRequestBroker['requestBrowser'];
      authorize: NodeRequestAuthorization;
      capability: (nodeId: string) => BrowserCapability | undefined;
      settings: (
        nodeId: string,
        generation: string,
        userId: number
      ) => Promise<BrowserSettingsSnapshot> | undefined;
      failed: (error: unknown) => void;
    }
  ) {
    const attachment = (
      nodeId: string,
      generation: string,
      payload: BrowserNodeAttachmentCommand,
      identity: BrowserAttachmentIdentity
    ) => options.request(nodeId, 'attachment', generation, payload, browserUser(identity));
    this.attachments = new BrowserAttachmentCoordinator({
      authorize: (identity, scope) => this.authorize(identity, scope),
      direct: (identity, target, generation, transportId) => {
        if (!options.capability(target.nodeId)?.ice) return undefined;
        return options.direct.authorizedTransport(
          { ...browserUser(identity), workbenchConnectionId: identity.connectionId },
          transportId,
          target.nodeId,
          generation
        )?.browserFingerprint;
      },
      prepare: async (nodeId, generation, grant, identity) => {
        const settings = await options.settings(nodeId, generation, identity.userId);
        await attachment(
          nodeId,
          generation,
          { action: 'prepare', grant, ...(settings && { settings }) },
          identity
        );
      },
      renew: async (nodeId, generation, attachmentId, expiresAt, identity) =>
        (await attachment(
          nodeId,
          generation,
          { action: 'renew', attachmentId, expiresAt },
          identity
        )) === true,
      revoke: async (
        { nodeId, workspaceId, browserId },
        generation,
        attachmentId,
        code,
        identity
      ) => {
        if (options.capability(nodeId)?.nodeGeneration === generation) {
          await attachment(
            nodeId,
            generation,
            { action: 'revoke', attachmentId, workspaceId, browserId, code },
            identity
          );
        }
      },
      resource: async (nodeId, generation, { workspaceId, command }, identity) => {
        const settings =
          command.action === 'open'
            ? await options.settings(nodeId, generation, identity.userId)
            : undefined;
        return (await options.request(
          nodeId,
          'resource',
          generation,
          { workspaceId, command, ...(settings && { settings }) },
          browserUser(identity)
        )) as { browserId?: string };
      },
      failed: options.failed
    });
  }

  async message(
    user: WorkbenchDirectTransferIdentity,
    message: BrowserControlRequest
  ): Promise<void> {
    const identity = {
      userId: user.userId,
      sessionFingerprint: user.sessionHash,
      connectionId: user.workbenchConnectionId
    };
    const { request, requestId } = message;
    let response: { result?: unknown; error?: string };
    try {
      response = { result: await this.execute(identity, request) };
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      response = { error: /^[A-Z][A-Z0-9_]{0,63}$/u.test(code) ? code : 'BROWSER_FAILED' };
    }
    await this.options.workbench.sendDirectConnection(identity.connectionId, {
      type: 'browser.response',
      requestId,
      ...response
    });
  }

  async upload(
    user: UserNodeAuthorization,
    connectionId: string,
    upload: BrowserUpload
  ): Promise<void> {
    const identity = { userId: user.userId, sessionFingerprint: user.sessionHash, connectionId };
    const { nodeId, generation } = await this.attachments.fileTarget(identity, upload.attachmentId);
    await this.options.request(nodeId, 'upload', generation, upload, user);
  }

  async createUploadTicket(
    user: UserNodeAuthorization,
    connectionId: string,
    upload: BrowserUploadStream
  ) {
    const identity = { userId: user.userId, sessionFingerprint: user.sessionHash, connectionId };
    const target = await this.attachments.fileTarget(identity, upload.attachmentId);
    const ticket = await this.fileTickets.issue({
      ...target,
      kind: 'browser-file-upload',
      user,
      connectionId,
      upload
    });
    return { ticket };
  }

  async download(
    user: UserNodeAuthorization,
    connectionId: string,
    download: BrowserDownloadRequest
  ): Promise<unknown> {
    const identity = { userId: user.userId, sessionFingerprint: user.sessionHash, connectionId };
    const { nodeId, generation, workspaceId } = await this.attachments.fileTarget(
      identity,
      download.attachmentId
    );
    if (download.command.action === 'workspace')
      return this.options.request(nodeId, 'download', generation, download, user, workspaceId);
    return this.options.request(nodeId, 'download', generation, download, user);
  }

  /** Admit the exact Browser attachment, then bind the save to the live Browser instance. */
  async createDownloadTicket(
    user: UserNodeAuthorization,
    connectionId: string,
    attachmentId: string,
    id: string
  ) {
    const identity = { userId: user.userId, sessionFingerprint: user.sessionHash, connectionId };
    const target = await this.attachments.fileTarget(identity, attachmentId);
    const info = browserDownloadInfoSchema.safeParse(
      await this.options.request(
        target.nodeId,
        'download',
        target.generation,
        { attachmentId, command: { action: 'info', id } },
        user
      )
    );
    if (!info.success || info.data.id !== id) throw new Error('NODE_RESPONSE_INVALID');
    if (info.data.state !== 'ready' || info.data.size === undefined)
      throw new Error('BROWSER_DOWNLOAD_NOT_READY');
    const { name, size } = info.data;
    const ticket = await this.fileTickets.issue({
      ...target,
      kind: 'browser-file-download',
      user,
      connectionId,
      id,
      size
    });
    return { nodeId: target.nodeId, name, size, ticket };
  }

  authorizeFileStream(
    kind: string,
    grant: string,
    nodeId: string,
    user: UserNodeAuthorization,
    signal: AbortSignal
  ) {
    return this.fileTickets.authorize(kind, grant, nodeId, user, signal);
  }

  async openDirectFile(
    kind: FileTicket['kind'],
    ticket: string,
    nodeId: string,
    transportId: string,
    user: UserNodeAuthorization
  ) {
    if (this.directFiles.size >= 1024 || this.directFiles.has(ticket))
      throw new Error('NODE_STREAM_LIMIT');
    const scope = new AbortController();
    this.directFiles.set(ticket, { user, scope });
    scope.signal.addEventListener('abort', () => this.directFiles.delete(ticket), { once: true });
    try {
      const admission = await this.fileTickets.authorize(
        kind,
        ticket,
        nodeId,
        user,
        scope.signal,
        (target, signal) => this.prepareFileStream(target, signal, transportId)
      );
      if (admission === undefined) throw new Error('BROWSER_NOT_AUTHORIZED');
      if ('code' in admission) throw new Error(admission.code);
      if (admission.revoked.aborted) throw new Error('BROWSER_LEASE_ENDED');
      admission.revoked.addEventListener('abort', () => scope.abort(), { once: true });
      return { grant: admission.grant };
    } catch (error) {
      scope.abort();
      throw error;
    }
  }

  closeDirectFile(ticket: string, user: UserNodeAuthorization): void {
    const current = this.directFiles.get(ticket);
    if (current?.user.userId === user.userId && current.user.sessionHash === user.sessionHash)
      current.scope.abort();
  }

  async revalidateAuthorizations(scope: NodeResourceScope): Promise<void> {
    const matches = (target: Scope) => matchesNodeResource(scope, target);
    await Promise.all([
      this.attachments.revalidateAuthorizations(matches),
      this.fileTickets.revalidate(matches)
    ]);
  }

  private async canTransfer(ticket: FileTicket): Promise<boolean> {
    const { user, connectionId } = ticket;
    const identity = { userId: user.userId, sessionFingerprint: user.sessionHash, connectionId };
    if (ticket.kind === 'browser-file-upload') {
      const target = await this.attachments
        .fileTarget(identity, ticket.upload.attachmentId)
        .catch(() => undefined);
      return target?.generation === ticket.generation;
    }
    return (
      (await this.authorize(identity, ticket).catch(() => undefined))?.generation ===
      ticket.generation
    );
  }

  async authorizePictureStream(
    grant: string,
    nodeId: string,
    user: UserNodeAuthorization,
    signal: AbortSignal
  ) {
    const open = parseBrowserStreamGrant(grant);
    if (!open) return undefined;
    const admission = await this.attachments.authorizeRelayStream(
      { userId: user.userId, sessionFingerprint: user.sessionHash },
      nodeId,
      open,
      signal
    );
    if (admission) return { grant, ...admission };
  }

  revokeConnection(id: string): void {
    void this.fileTickets.revalidate((ticket) => ticket.connectionId === id);
    void this.attachments.revokeWhere(
      (identity) => identity.connectionId === id,
      'BROWSER_CONTROL_DISCONNECTED'
    );
  }

  revokeNode(id: string): void {
    void this.fileTickets.revalidate((ticket) => ticket.nodeId === id);
    void this.attachments.revokeWhere(
      (_identity, target) => target.nodeId === id,
      'BROWSER_NODE_CHANGED'
    );
  }

  close(): void {
    this.fileTickets.close();
    for (const { scope } of this.directFiles.values()) scope.abort();
    void this.attachments.shutdown().catch(this.options.failed);
  }

  private async authorize(identity: BrowserAttachmentIdentity, scope: Scope) {
    const { nodeId, workspaceId } = scope;
    const isConnected = () =>
      this.options.workbench.ownsActiveConnection(browserUser(identity), identity.connectionId);
    if (!isConnected()) return undefined;
    const allowed = await this.options.authorize(
      identity.userId,
      nodeId,
      'browser.resource',
      { workspaceId },
      workspaceId
    );
    if (!isConnected()) return undefined;
    if (!allowed) throw new BrowserScopeRevoked();
    const capability = this.options.capability(nodeId);
    return capability && { generation: capability.nodeGeneration };
  }

  private async execute(
    identity: BrowserAttachmentIdentity,
    request: BrowserControlRequest['request']
  ): Promise<unknown> {
    switch (request.action) {
      case 'resource':
        return this.attachments.resource(identity, request, request.command);
      case 'attach':
        return this.attachments.prepare(identity, request);
      case 'renew':
        return this.attachments.renew(identity, request.attachmentId);
      case 'release':
        return this.attachments.release(identity, request.attachmentId);
      case 'profile': {
        const node = await this.authorize(identity, request);
        if (!node) throw new Error('BROWSER_NOT_AUTHORIZED');
        return this.options.request(
          request.nodeId,
          'profile',
          node.generation,
          { workspaceId: request.workspaceId, command: request.command },
          browserUser(identity)
        );
      }
    }
  }
}
