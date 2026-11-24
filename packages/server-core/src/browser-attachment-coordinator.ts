import { randomBytes, randomUUID } from 'node:crypto';
import {
  browserResourceCommandSchema,
  type BrowserResourceCommand,
  type BrowserAttachmentOpen,
  type BrowserAttachmentPrepare,
  type BrowserAttachmentRoute
} from '@myagentroam/protocol';

export type BrowserAttachmentIdentity = {
  userId: number;
  sessionFingerprint: string;
  connectionId: string;
};
type Identity = BrowserAttachmentIdentity;
type Scope = { nodeId: string; workspaceId: string };
type Target = Scope & { browserId: string };
type Request = Target & { transportId?: string | undefined; replaces?: string | undefined };
type Lease = {
  identity: Identity;
  target: Target;
  generation: string;
  grant: BrowserAttachmentPrepare;
  closing?: Promise<void>;
};
const LEASE_MS = 15_000;

export class BrowserScopeRevoked extends Error {
  constructor() {
    super('BROWSER_NOT_AUTHORIZED');
  }
}

/** Owns authorized Browser leases on both paths. The host checks its current
 * session/Workbench connection and supplies authoritative ICE and Node RPC;
 * relay pairing and the Node's browser registry stay outside this owner.
 */
export class BrowserAttachmentCoordinator {
  private readonly leases = new Map<string, Lease>();
  private readonly sweep: ReturnType<typeof setInterval>;
  private stopped = false;

  constructor(
    private readonly options: {
      authorize(identity: Identity, target: Scope): Promise<{ generation: string } | undefined>;
      direct(
        identity: Identity,
        target: Target,
        generation: string,
        transportId: string
      ): string | undefined;
      prepare(
        nodeId: string,
        generation: string,
        grant: BrowserAttachmentPrepare,
        identity: Identity
      ): Promise<void>;
      renew(
        nodeId: string,
        generation: string,
        attachmentId: string,
        expiresAt: number,
        identity: Identity
      ): Promise<boolean>;
      revoke(
        target: Target,
        generation: string,
        attachmentId: string,
        code: string,
        identity: Identity
      ): Promise<void>;
      closeRelay(attachmentId: string): void;
      resource(
        nodeId: string,
        generation: string,
        data: { workspaceId: string; __requestUserId: number; command: BrowserResourceCommand },
        identity: Identity
      ): Promise<{ browserId?: string }>;
      failed(error: unknown): void;
    }
  ) {
    this.sweep = setInterval(() => {
      for (const [id, lease] of this.leases)
        if (lease.grant.expiresAt <= Date.now()) {
          void this.close(id, 'BROWSER_LEASE_EXPIRED').catch(options.failed);
        }
    }, 1_000);
    this.sweep.unref();
  }

  async resource(identity: Identity, scope: Scope, data: unknown) {
    const parsed = browserResourceCommandSchema.safeParse(data);
    if (!parsed.success) throw new Error('BROWSER_RESOURCE_INVALID');
    const { generation } = await this.authorize(identity, scope);
    return this.options.resource(
      scope.nodeId,
      generation,
      {
        workspaceId: scope.workspaceId,
        __requestUserId: identity.userId,
        command: parsed.data
      },
      identity
    );
  }

  async prepare(identity: Identity, target: Request): Promise<BrowserAttachmentOpen> {
    const node = await this.authorize(identity, target);
    let route: BrowserAttachmentRoute = { type: 'relay' };
    if (target.transportId !== undefined) {
      const fingerprint = this.options.direct(
        identity,
        target,
        node.generation,
        target.transportId
      );
      if (!fingerprint) throw new Error('BROWSER_ICE_UNAVAILABLE');
      route = { type: 'ice', transportId: target.transportId, fingerprint };
    }
    const grant: BrowserAttachmentPrepare = {
      attachmentId: randomUUID(),
      ticket: randomBytes(32).toString('base64url'),
      sessionId: identity.sessionFingerprint,
      connectionId: identity.connectionId,
      userId: identity.userId,
      workspaceId: target.workspaceId,
      browserId: target.browserId,
      route,
      expiresAt: Date.now() + LEASE_MS,
      ...(target.replaces ? { replaces: target.replaces } : {})
    };
    if (this.stopped) throw new Error('BROWSER_STOPPED');
    this.leases.set(grant.attachmentId, { identity, target, generation: node.generation, grant });
    try {
      await this.options.prepare(target.nodeId, node.generation, grant, identity);
      const current = await this.authorize(identity, target);
      const lease = this.leases.get(grant.attachmentId);
      if (!lease || !this.live(lease) || current.generation !== node.generation)
        throw new Error('BROWSER_NOT_AUTHORIZED');
      return { type: 'OPEN', attachmentId: grant.attachmentId, ticket: grant.ticket };
    } catch (error) {
      await this.close(grant.attachmentId, 'BROWSER_PREPARE_FAILED');
      throw error;
    }
  }

  relayNode(id: string, nodeId: string, generation: string): boolean {
    const lease = this.leases.get(id);
    return (
      !!lease &&
      this.live(lease) &&
      lease.grant.route.type === 'relay' &&
      lease.target.nodeId === nodeId &&
      lease.generation === generation
    );
  }

  async relayBrowser(identity: Identity, open: BrowserAttachmentOpen): Promise<boolean> {
    const lease = this.owned(identity, open.attachmentId);
    if (!lease || lease.grant.route.type !== 'relay' || lease.grant.ticket !== open.ticket)
      return false;
    const node = await this.options.authorize(identity, lease.target);
    return this.live(lease) && node?.generation === lease.generation;
  }

  async renew(identity: Identity, id: string): Promise<void> {
    const lease = this.owned(identity, id);
    if (!lease) throw new Error('BROWSER_LEASE_ENDED');
    try {
      const current = await this.authorize(identity, lease.target);
      const route = lease.grant.route;
      if (
        !this.live(lease) ||
        current.generation !== lease.generation ||
        (route.type === 'ice' &&
          route.fingerprint !==
            this.options.direct(identity, lease.target, lease.generation, route.transportId))
      ) {
        throw new Error('BROWSER_LEASE_ENDED');
      }
      const expiresAt = Date.now() + LEASE_MS;
      if (
        !(await this.options.renew(
          lease.target.nodeId,
          lease.generation,
          id,
          expiresAt,
          identity
        )) ||
        !this.live(lease)
      ) {
        throw new Error('BROWSER_LEASE_ENDED');
      }
      lease.grant.expiresAt = Math.max(lease.grant.expiresAt, expiresAt);
    } catch (error) {
      await this.close(
        id,
        error instanceof BrowserScopeRevoked ? 'BROWSER_NOT_AUTHORIZED' : 'BROWSER_LEASE_ENDED'
      );
      throw error;
    }
  }

  release(identity: Identity, id: string): Promise<void> {
    return this.owned(identity, id) ? this.close(id, 'BROWSER_RELEASED') : Promise.resolve();
  }

  async fileTarget(identity: Identity, id: string) {
    const lease = this.owned(identity, id);
    if (!lease) throw new Error('BROWSER_LEASE_ENDED');
    try {
      const node = await this.authorize(identity, lease.target);
      if (!this.live(lease) || node.generation !== lease.generation)
        throw new Error('BROWSER_LEASE_ENDED');
      return { ...lease.target, generation: lease.generation };
    } catch (error) {
      if (error instanceof BrowserScopeRevoked) await this.close(id, 'BROWSER_NOT_AUTHORIZED');
      throw error;
    }
  }

  async revokeWhere(
    matches: (identity: Identity, target: Target, generation: string) => boolean,
    code: string
  ): Promise<void> {
    const results = await Promise.allSettled(
      [...this.leases]
        .filter(([, lease]) => matches(lease.identity, lease.target, lease.generation))
        .map(([id]) => this.close(id, code))
    );
    for (const result of results)
      if (result.status === 'rejected') this.options.failed(result.reason);
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    clearInterval(this.sweep);
    await this.revokeWhere(() => true, 'BROWSER_STOPPED');
  }

  private async authorize(identity: Identity, target: Scope) {
    const node = await this.options.authorize(identity, target);
    if (this.stopped || !node) throw new Error('BROWSER_NOT_AUTHORIZED');
    return node;
  }

  private owned(identity: Identity, id: string): Lease | undefined {
    const lease = this.leases.get(id);
    if (
      lease &&
      this.live(lease) &&
      lease.identity.userId === identity.userId &&
      lease.identity.sessionFingerprint === identity.sessionFingerprint &&
      lease.identity.connectionId === identity.connectionId
    )
      return lease;
  }

  private live(lease: Lease) {
    return !lease.closing && lease.grant.expiresAt > Date.now();
  }

  private close(id: string, code: string): Promise<void> {
    const lease = this.leases.get(id);
    if (!lease) return Promise.resolve();
    return (lease.closing ??= Promise.resolve().then(async () => {
      try {
        this.options.closeRelay(id);
      } finally {
        try {
          await this.options.revoke(lease.target, lease.generation, id, code, lease.identity);
        } finally {
          this.leases.delete(id);
        }
      }
    }));
  }
}
