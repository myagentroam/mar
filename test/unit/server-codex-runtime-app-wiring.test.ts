import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServerApp, type ServerApplication } from '../../ee/server/src/app.js';
import { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';
import { CodexCredentialService } from '../../ee/server/src/service/codex-credential-service.js';
import { CODEX_CREDENTIAL_MAINTENANCE_INTERVAL_MS } from '../../packages/server-core/src/codex-credential-service.js';
import { RuntimeCredentialService } from '../../packages/server-core/src/runtime-credential-service.js';
import * as sessions from '../../ee/server/src/route/session-run-routes.js';
import * as runs from '../../ee/server/src/route/run-control-routes.js';
import * as hosted from '../../ee/server/src/route/hosted-conversation-routes.js';
import * as credentials from '../../ee/server/src/route/codex-credential-routes.js';

// Keep the real app, services, route registrations and lifecycle. Only the SQL transport is fake.
const mysql = vi.hoisted(() => {
  const connection = {
    execute: vi.fn(async () => [[], []]),
    beginTransaction: vi.fn(async () => undefined),
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    release: vi.fn()
  };
  return {
    createMysqlPool: vi.fn(() => ({
      ...connection,
      getConnection: vi.fn(async () => connection),
      end: vi.fn(async () => undefined)
    })),
    prepareMysqlDatabase: vi.fn(async () => undefined)
  };
});
vi.mock('../../ee/server/src/mysql/connection.js', () => mysql);
const runtime = vi.hoisted(() => ({ tickets: [] as unknown[], keyDirectories: [] as string[] }));
vi.mock('../../packages/server-core/src/mar-agent-runtime-model-service.js', async (original) => {
  const module =
    await original<
      typeof import('../../packages/server-core/src/mar-agent-runtime-model-service.js')
    >();
  return {
    ...module,
    MarAgentRuntimeModelService: class extends module.MarAgentRuntimeModelService {
      constructor(...args: ConstructorParameters<typeof module.MarAgentRuntimeModelService>) {
        super(...args);
        runtime.tickets.push(args[0].tickets);
      }
    }
  };
});
vi.mock('../../packages/server-core/src/runtime-credential-service.js', async (original) => {
  const module =
    await original<typeof import('../../packages/server-core/src/runtime-credential-service.js')>();
  return {
    ...module,
    loadOrCreateRuntimeCredentialHmacKey: (directory: string) => {
      runtime.keyDirectories.push(directory);
      return module.loadOrCreateRuntimeCredentialHmacKey(directory);
    }
  };
});

let app: ServerApplication | undefined;
let directory: string;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  runtime.tickets.length = 0;
  runtime.keyDirectories.length = 0;
  vi.spyOn(MysqlServerDatabase.prototype, 'initialize').mockResolvedValue();
  directory = await mkdtemp(join(tmpdir(), 'mar-runtime-wiring-'));
});
afterEach(async () => {
  try {
    await app?.close();
  } finally {
    app = undefined;
    vi.restoreAllMocks();
    vi.useRealTimers();
    await rm(directory, { recursive: true, force: true });
  }
});

describe('Server Codex runtime app wiring', () => {
  it('shares one runtime credential chain across Node control and registered Agent routes, and stops maintenance on close', async () => {
    const activate = vi.spyOn(RuntimeCredentialService.prototype, 'activateNodeConnection');
    const sessionRoutes = vi.spyOn(sessions, 'registerSessionRunRoutes');
    const runRoutes = vi.spyOn(runs, 'registerRunControlRoutes');
    const hostedRoutes = vi.spyOn(hosted, 'registerHostedConversationRoutes');
    const credentialRoutes = vi.spyOn(credentials, 'registerCodexCredentialRoutes');
    const closeLogins = vi.spyOn(CodexCredentialService.prototype, 'closeChatgptLogins');
    const maintain = vi
      .spyOn(CodexCredentialService.prototype, 'maintain')
      .mockResolvedValue({ attempted: 0, deferred: 0, failed: 0 });
    app = (await createServerApp({ dataDirectory: directory, productUuid: null })).app;
    await app.ready();
    expect(sessionRoutes).toHaveBeenCalledOnce();
    const control = sessionRoutes.mock.calls[0]![0].nodeControl as unknown as {
      onNodeConnected(nodeId: string, replaced: boolean): void;
    };
    control.onNodeConnected('test-node', false);
    expect(activate).toHaveBeenCalledWith('test-node');
    expect(runtime.tickets).toEqual([activate.mock.contexts[0]]);
    expect(runtime.keyDirectories).toContain(directory);
    expect(sessionRoutes).toHaveBeenCalledOnce();
    expect(runRoutes).toHaveBeenCalledOnce();
    expect(hostedRoutes).toHaveBeenCalledOnce();
    const models = sessionRoutes.mock.calls[0]![0].marAgentRuntimeModels;
    expect(models).toBeDefined();
    expect(runRoutes.mock.calls[0]![0].marAgentRuntimeModels).toBe(models);
    expect(hostedRoutes.mock.calls[0]![0].marAgentRuntimeModels).toBe(models);
    expect(credentialRoutes).toHaveBeenCalledOnce();
    expect(maintain).toHaveBeenCalledExactlyOnceWith('STARTUP');
    expect(maintain.mock.contexts[0]).toBe(credentialRoutes.mock.calls[0]![0].credentials);
    await vi.advanceTimersByTimeAsync(CODEX_CREDENTIAL_MAINTENANCE_INTERVAL_MS);
    expect(maintain).toHaveBeenLastCalledWith('EXPIRING');
    expect(maintain).toHaveBeenCalledTimes(2);
    await app.close();
    expect(closeLogins).toHaveBeenCalledOnce();
    expect(closeLogins.mock.contexts[0]).toBe(credentialRoutes.mock.calls[0]![0].credentials);
    await vi.advanceTimersByTimeAsync(CODEX_CREDENTIAL_MAINTENANCE_INTERVAL_MS);
    expect(maintain).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
