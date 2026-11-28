import { randomUUID } from 'node:crypto';
import type {
  NodeStreamAdmission,
  NodeStreamAuthorizer
} from '@myagentroam/server-core/node-relay-channel';
import {
  decodeTcpForward,
  tcpForwardConnectionId,
  tcpForwardControlKind,
  tcpForwardDataKind,
  tcpForwardRequest
} from '@myagentroam/protocol/tcp-forward';

type Registration = {
  readonly nodeId: string;
  readonly userId: number;
  readonly canUseNode: () => Promise<boolean>;
  readonly scope: AbortController;
  readonly id: string;
  readonly direction: 'local' | 'reverse';
  ready: boolean;
};

export interface TcpForwardAdmissionChecks {
  readonly canUseNode: () => Promise<boolean>;
  readonly authenticate: () => Promise<boolean>;
}

/** Owns forwarding admissions and revocation, not listener sockets or payload. */
export class TcpForwardRelay {
  private readonly active = new Set<Registration>();

  forCarrier(
    nodeId: string,
    userId: number,
    { canUseNode, authenticate }: TcpForwardAdmissionChecks
  ): NodeStreamAuthorizer {
    let owner: Registration | undefined;
    return async ({ kind, grant }, signal) => {
      if (signal.aborted) return undefined;
      if (kind === tcpForwardDataKind) {
        const connection = decodeTcpForward(tcpForwardConnectionId, grant);
        if (
          owner?.ready !== true ||
          owner.scope.signal.aborted ||
          connection === undefined ||
          (owner.direction === 'local' ? connection !== 0 : connection === 0)
        )
          return undefined;
        // Never accept a registration ID, address, or port on a data OPEN from the CLI.
        return {
          grant: JSON.stringify({ id: owner.id, connection }),
          revoked: owner.scope.signal
        };
      }
      if (kind !== tcpForwardControlKind || owner !== undefined) return undefined;
      const request = decodeTcpForward(tcpForwardRequest, grant);
      if (request === undefined) return undefined;
      const entry: Registration = {
        nodeId,
        userId,
        id: randomUUID(),
        direction: request.direction,
        canUseNode,
        scope: new AbortController(),
        ready: false
      };
      owner = entry;
      const release = () => {
        this.active.delete(entry);
        signal.removeEventListener('abort', release);
        entry.scope.abort();
      };
      this.active.add(entry);
      signal.addEventListener('abort', release, { once: true });
      if (
        !(await canUseNode().catch(() => false)) ||
        entry.scope.signal.aborted ||
        !(await authenticate().catch(() => false)) ||
        entry.scope.signal.aborted
      ) {
        release();
        return undefined;
      }
      entry.ready = true;
      const admission: NodeStreamAdmission = {
        grant: JSON.stringify({ ...request, id: entry.id }),
        revoked: entry.scope.signal
      };
      return admission;
    };
  }

  revokeUser(userId: number): void {
    for (const entry of this.active) if (entry.userId === userId) entry.scope.abort();
  }

  async revalidate(
    scope: { readonly nodeId?: string; readonly userId?: number } = {}
  ): Promise<void> {
    // An existing forwarding lease depends on resource access, not on the original login.
    await Promise.all(
      [...this.active]
        .filter(
          (entry) =>
            (scope.nodeId === undefined || entry.nodeId === scope.nodeId) &&
            (scope.userId === undefined || entry.userId === scope.userId)
        )
        .map(async (entry) => {
          if (!(await entry.canUseNode().catch(() => false))) entry.scope.abort();
        })
    );
  }
}
