import { EventEmitter } from 'node:events';
import fastify from 'fastify';
import type { Pool } from 'mysql2/promise';
import type { WebSocket } from 'ws';
import { vi } from 'vitest';
import { createEnvelope, type NodeEnvelope } from '@myagentroam/protocol';
import { ModelUsageGrants } from '@myagentroam/server-core/model-usage-grant';
import { ModelUsageStore } from '@myagentroam/server-core/model-usage-store';
import {
  createTestNodeControl,
  testNodeConsumers
} from '../../../../../test/support/create-test-node-control.js';
import { ServerMaintenance } from '../../../src/composition/server-maintenance.js';
import type { NodeControlStore } from '../../../src/node-control.js';

export const NOW = 10_000_000_000;
export const NODE_ID = 'fixture-node';
export const USER_ID = 42;
const CREDENTIAL = 'fixture-credential';

interface LedgerRow {
  revision: number;
  payload_hash: string;
  identity_hash: string;
}

/** Models only the SQL used by this fixture, publishing staged writes at commit. */
class UsageMysql {
  readonly rows = new Map<string, LedgerRow>();
  readonly cleanupRowCounts: number[] = [];
  failCleanup = false;
  failWrite: 'insert' | 'commit' | undefined;
  readonly pool = {
    execute: vi.fn(async (sql: string) => {
      if (!sql.startsWith('DELETE FROM model_usage_records ')) throw new Error('UNEXPECTED_SQL');
      this.cleanupRowCounts.push(this.rows.size);
      if (this.failCleanup) throw new Error('FIXTURE_CLEANUP_FAILED');
      return [{ affectedRows: 0 }, []];
    }),
    getConnection: vi.fn(async () => this.connection())
  };

  private connection() {
    let insert: [string, LedgerRow] | undefined;
    return {
      beginTransaction: async () => {},
      execute: async (sql: string, values: unknown[]) => {
        if (sql.startsWith('SELECT id FROM users ')) {
          return [values[0] === USER_ID ? [{ id: USER_ID }] : [], []];
        }
        const key = String(values[0]);
        if (sql.startsWith('SELECT revision,payload_hash,identity_hash ')) {
          const row = this.rows.get(key);
          return [row ? [row] : [], []];
        }
        if (sql.startsWith('INSERT INTO model_usage_records')) {
          if (this.failWrite === 'insert') throw new Error('FIXTURE_INSERT_FAILED');
          if (this.rows.has(key)) throw new Error('FIXTURE_DUPLICATE_INSERT');
          insert = [
            key,
            {
              revision: Number(values[4]),
              payload_hash: String(values[5]),
              identity_hash: String(values[6])
            }
          ];
          return [{ affectedRows: 1 }, []];
        }
        throw new Error('UNEXPECTED_SQL');
      },
      commit: async () => {
        if (this.failWrite === 'commit') throw new Error('FIXTURE_COMMIT_FAILED');
        if (insert !== undefined) this.rows.set(...insert);
      },
      rollback: async () => {
        insert = undefined;
      },
      release: () => {}
    };
  }
}

export async function withUsageControl(
  test: (fixture: {
    mysql: UsageMysql;
    grants: ModelUsageGrants;
    warnings: ReturnType<typeof vi.spyOn>;
    receive: (type: string, payload: unknown) => Promise<NodeEnvelope[]>;
  }) => Promise<void>
): Promise<void> {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const app = fastify();
  const mysql = new UsageMysql();
  const grants = new ModelUsageGrants(Buffer.from('fixture-usage-key'), () => NOW);
  const store = new ModelUsageStore(mysql.pool as unknown as Pool, grants, () => NOW);
  const maintenance = new ServerMaintenance(
    app,
    store,
    { maintain: vi.fn() },
    {
      cleanupBatch: vi.fn()
    },
    { cleanupCache: vi.fn() }
  );
  const warnings = vi.spyOn(app.log, 'warn');
  const database: NodeControlStore = {
    authenticateNode: (id, credential) =>
      id === NODE_ID && credential === CREDENTIAL
        ? {
            id,
            ownerUserId: USER_ID,
            displayName: null,
            registeredAddress: 'unknown',
            metadata: '{}',
            disabled: false,
            lastHeartbeatAt: null
          }
        : undefined,
    updateNodeHeartbeat: vi.fn(),
    registerNode: vi.fn(),
    listNodes: vi.fn(),
    listNodesForUser: vi.fn(),
    revokeNode: vi.fn(),
    deleteNode: vi.fn(),
    audit: vi.fn()
  };
  const control = createTestNodeControl(database, async () => false);
  testNodeConsumers(control).modelUsage = store;
  const sent: NodeEnvelope[] = [];
  const emitter = new EventEmitter();
  const socket = Object.assign(emitter, {
    OPEN: 1,
    readyState: 1,
    send(raw: string) {
      sent.push(JSON.parse(raw) as NodeEnvelope);
    },
    close() {
      this.readyState = 3;
      emitter.emit('close');
    }
  });
  const receive = async (type: string, payload: unknown) => {
    const envelope = createEnvelope(type, payload);
    socket.emit('message', JSON.stringify(envelope));
    await control.drainProjections();
    return sent.filter((reply) => reply.replyTo === envelope.id);
  };

  try {
    maintenance.registerModelUsage();
    await app.ready();
    control.attach(socket as unknown as WebSocket);
    await receive('authenticate', { nodeId: NODE_ID, credential: CREDENTIAL });
    await test({ mysql, grants, warnings, receive });
  } finally {
    try {
      maintenance.stop();
      try {
        control.close();
      } finally {
        await maintenance.drain();
        await app.close();
      }
    } finally {
      vi.useRealTimers();
    }
  }
}
