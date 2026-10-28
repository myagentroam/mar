import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import { WebPushConfiguration } from '@myagentroam/server-core/web-push-configuration';
import { createEnvelope } from '@myagentroam/protocol';
import {
  WebPushDispatcher,
  type WebPushTransportInput
} from '@myagentroam/server-core/web-push-dispatcher';
import { createServerApp, type ServerApplication } from '../../../src/app.js';
import { MysqlServerDatabase } from '../../../src/mysql/server-database.js';
import * as sessions from '../../../src/route/session-run-routes.js';
import { ResourceAccessService } from '../../../src/rbac/resource-access-service.js';

import { mysql } from './server-notification-pools.js';

let app: ServerApplication | undefined;
let directory: string;
const releases: (() => void)[] = [];

export function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  releases.push(release);
  return { promise, release };
}

export async function setup() {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  mysql.pools.length = 0;
  mysql.events.length = 0;
  mysql.createMysqlPool.mockClear();
  vi.spyOn(MysqlServerDatabase.prototype, 'initialize').mockResolvedValue(undefined);
  vi.spyOn(ResourceAccessService.prototype, 'canRelay').mockResolvedValue(true);
  vi.spyOn(WebPushConfiguration.prototype, 'delivery').mockResolvedValue({
    publicKey: 'public',
    privateKey: 'private',
    subject: 'https://console.example.test'
  });
  directory = await mkdtemp(join(tmpdir(), 'mar-notification-close-'));
}

export async function teardown() {
  releases.splice(0).forEach((release) => release());
  try {
    await app?.close();
  } finally {
    app = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  }
}

export async function ready(configure?: (app: ServerApplication) => void) {
  const pending = gate();
  const started = gate();
  const sessionRoutes = vi.spyOn(sessions, 'registerSessionRunRoutes');
  const enqueue = vi.spyOn(WebPushDispatcher.prototype, 'enqueue');
  const transport = vi.fn(async (input: WebPushTransportInput) => {
    mysql.events.push('transport-start');
    input.signal.addEventListener('abort', () => mysql.events.push('transport-abort'), {
      once: true
    });
    started.release();
    await pending.promise;
    mysql.events.push('transport-settle');
    // A late 410 still needs the database to expire this exact subscription.
    return { statusCode: 410 };
  });
  // Retain the actual MySQL notification assembly, dispatcher, and Fastify hooks.
  app = (
    await createServerApp({
      dataDirectory: directory,
      productUuid: null,
      webPushTransport: transport
    })
  ).app;
  configure?.(app);
  const warnings = vi.spyOn(app.log, 'warn');
  await app.ready();
  expect(mysql.createMysqlPool).toHaveBeenCalledTimes(2);
  expect(sessionRoutes).toHaveBeenCalledOnce();
  const control = sessionRoutes.mock.calls[0]![0].nodeControl as unknown as {
    close(): void;
    attach: import('../../../src/node-control.js').NodeControl['attach'];
    isNodeConnected(nodeId: string): boolean;
    messageProjector: {
      project(nodeId: string, socket: never, envelope: ReturnType<typeof createEnvelope>): void;
      enqueueSessionProjection(nodeId: string, work: () => Promise<unknown>): Promise<void>;
    };
  };
  control.messageProjector.project(
    'node-1',
    { send() {} } as never,
    createEnvelope('workbench.event', {
      sequence: 1,
      category: 'conversation',
      payload: {
        event: {
          eventType: 'notification',
          payload: {
            userId: 1,
            notificationId: 'notice-1',
            kind: 'AGENT_MESSAGE',
            message: 'Finished',
            workspaceId: 'workspace-1',
            sessionId: 'session-1',
            sessionTitle: 'Session',
            runId: 'run-1',
            occurredAt: Date.now()
          }
        }
      }
    })
  );
  await started.promise;
  expect(enqueue).toHaveBeenCalledOnce();
  const dispatcher = enqueue.mock.contexts[0];
  if (!(dispatcher instanceof WebPushDispatcher)) throw new Error('Push dispatcher not assembled');
  return { app, pending, transport, warnings, dispatcher, control };
}
