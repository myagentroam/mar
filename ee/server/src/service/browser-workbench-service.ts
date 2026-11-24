import type { IncomingHttpHeaders } from 'node:http';
import type { WebSocket } from 'ws';
import {
  BROWSER_RELAY_READY,
  type BrowserControlRequest,
  type BrowserCapability,
  type BrowserSettingsSnapshot,
  type BrowserUpload,
  browserDownloadInfoSchema,
  browserDownloadChunkSchema,
  type BrowserDownloadRequest,
  type BrowserNodeAttachmentCommand
} from '@myagentroam/protocol';
import {
  BrowserAttachmentCoordinator,
  BrowserScopeRevoked,
  type BrowserAttachmentIdentity
} from '@myagentroam/server-core/browser-attachment-coordinator';
import { BrowserRelayService } from '@myagentroam/server-core/browser-relay-service';
import type { DirectTransferCoordinator } from '@myagentroam/server-core/direct-transfer-coordinator';
import type {
  NodeRequestAuthorization,
  UserNodeAuthorization
} from '@myagentroam/server-core/node-access-contracts';
import type {
  WorkbenchDirectTransferIdentity,
  WorkbenchRelayService
} from '@myagentroam/server-core/workbench-relay-service';
import type { NodeRequestBroker } from './node-request-broker.js';

type Scope = { nodeId: string; workspaceId: string };
const browserUser = (identity: BrowserAttachmentIdentity): UserNodeAuthorization => ({
  userId: identity.userId,
  sessionHash: identity.sessionFingerprint
});

/** Composes Browser authorization and transport adapters with the shared Node
 * request channel. The coordinator owns grants and the relay owns socket pairing. */
export class BrowserWorkbenchService {
  private readonly attachments: BrowserAttachmentCoordinator;
  private readonly relay: BrowserRelayService;

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
      authenticateNode: (nodeId: string, credential: string) => Promise<boolean>;
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
      closeRelay: (id) => this.relay.close(id),
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
    this.relay = new BrowserRelayService(this.attachments, options.failed);
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

  /** Admission binds one HTTP response to the exact live browser and file, not
   * to the disposable ICE/relay writer. Every pull still reauthorizes scope. */
  async openDownload(
    user: UserNodeAuthorization,
    connectionId: string,
    attachmentId: string,
    id: string
  ) {
    const identity = { userId: user.userId, sessionFingerprint: user.sessionHash, connectionId };
    const target = await this.attachments.fileTarget(identity, attachmentId);
    const { nodeId, workspaceId, browserId, generation } = target;
    const info = browserDownloadInfoSchema.parse(
      await this.options.request(
        nodeId,
        'download',
        generation,
        { attachmentId, command: { action: 'info', id } },
        user
      )
    );
    const { size, name, state } = info;
    if (state !== 'ready' || size === undefined) throw new Error('BROWSER_DOWNLOAD_NOT_READY');
    const read = async (offset: number, limit: number) => {
      if ((await this.authorize(identity, target))?.generation !== generation)
        throw new Error('BROWSER_LEASE_ENDED');
      const chunk = browserDownloadChunkSchema.parse(
        await this.options.request(
          nodeId,
          'download',
          generation,
          { workspaceId, browserId, command: { action: 'read', id, offset, limit } },
          user
        )
      );
      return { size, ...chunk };
    };
    return { name, size, read };
  }

  attachNode(socket: WebSocket, headers: IncomingHttpHeaders): void {
    const nodeId = headers['x-mar-node'];
    const generation = headers['x-mar-node-generation'];
    const id = headers['x-mar-browser-attachment'];
    const credential = headers.authorization?.startsWith('Bearer ')
      ? headers.authorization.slice(7)
      : undefined;
    socket.on('error', () => socket.terminate());
    if (
      typeof nodeId !== 'string' ||
      typeof generation !== 'string' ||
      typeof id !== 'string' ||
      !credential
    ) {
      socket.terminate();
      return;
    }
    void (async () => {
      if (
        this.options.capability(nodeId)?.nodeGeneration !== generation ||
        !(await this.options.authenticateNode(nodeId, credential)) ||
        this.options.capability(nodeId)?.nodeGeneration !== generation ||
        !this.relay.node(id, nodeId, generation, socket)
      ) {
        socket.terminate();
        return;
      }
      socket.send(BROWSER_RELAY_READY);
    })().catch(() => socket.terminate());
  }

  attachBrowser(socket: WebSocket, user: UserNodeAuthorization, connectionId: string): void {
    socket.on('error', () => socket.terminate());
    if (!this.options.workbench.ownsActiveConnection(user, connectionId)) {
      socket.terminate();
      return;
    }
    const deadline = setTimeout(() => socket.terminate(), 15_000);
    socket.once('close', () => clearTimeout(deadline));
    socket.once('message', (data, binary) => {
      if (binary) return socket.terminate();
      void this.relay
        .browser(
          { userId: user.userId, sessionFingerprint: user.sessionHash, connectionId },
          socket,
          data.toString()
        )
        .then((paired) => {
          clearTimeout(deadline);
          if (!paired) socket.terminate();
        })
        .catch(() => socket.terminate());
    });
  }

  revokeConnection(id: string): void {
    void this.attachments.revokeWhere(
      (identity) => identity.connectionId === id,
      'BROWSER_CONTROL_DISCONNECTED'
    );
  }

  revokeNode(id: string): void {
    void this.attachments.revokeWhere(
      (_identity, target) => target.nodeId === id,
      'BROWSER_NODE_CHANGED'
    );
  }

  close(): void {
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
