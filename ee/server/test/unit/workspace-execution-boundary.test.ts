import { testNodeBrokerServices } from '../../../../test/support/node-broker-services.js';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createEnvelope, type NodeEnvelope } from '@myagentroam/protocol';
import { SessionInputService } from '../../../../packages/server-core/src/session-input-service.js';
import { NodeConnector } from '../../../../mar-node/src/connector.js';
import { NodeDatabase } from '../../../../mar-node/src/database.js';
import { FakeRunner } from '../../../../mar-node/src/fake-runner.js';
import type { NodeRuntimeState } from '../../../../mar-node/src/runtime-state.js';
import { NodeRequestService } from '../../../../mar-node/src/service/node-request-service.js';
import {
  capabilities,
  codexProfileClientFactory
} from '../../../../mar-node/test/unit/support/codex-connector.js';
import { ResourceAccessService } from '../../src/rbac/resource-access-service.js';
import { NodeRequestBroker } from '../../src/service/node-request-broker.js';

describe('Workspace execution boundary across Server and Node', () => {
  it('requires a registered, non-disabled Node and a current Workspace grant for schedule reads', async () => {
    let disabled = false;
    const execute = vi.fn(async (sql: string) => {
      if (sql.includes('FROM nodes')) {
        expect(sql).toContain('disabled=FALSE');
        return [disabled ? [] : [{ owner_type: 'PERSONAL', owner_user_id: 8 }], []];
      }
      if (sql.includes('FROM workspaces'))
        return [[{ owner_type: 'PERSONAL', owner_user_id: 7 }], []];
      throw new Error('UNEXPECTED_QUERY');
    });
    const access = new ResourceAccessService({ raw: { execute } } as never, {} as never);
    expect(await access.canRelay(7, 'node-a', 'schedule.task.list', {}, 'workspace-a')).toBe(true);
    expect(await access.canRelay(8, 'node-a', 'schedule.task.list', {}, 'workspace-a')).toBe(false);
    expect(await access.canRelay(7, 'node-a', 'schedule.task.list', {})).toBe(false);
    disabled = true;
    expect(await access.canUseScheduledWorkspace(7, 'node-a', 'workspace-a')).toBe(false);
    expect(await access.canRelay(7, 'node-a', 'schedule.task.update', {}, 'workspace-a')).toBe(
      false
    );
  });

  it.each(['desktop.describe', 'computer.use.open', 'computer.use.attach'])(
    'requires Node use, not Node management or Workspace use, for %s',
    async (operation) => {
      const access = new ResourceAccessService(
        {
          raw: {
            execute: async (sql: string) => {
              const owner = sql.includes('FROM nodes')
                ? 8
                : sql.includes('FROM workspaces')
                  ? 7
                  : 0;
              if (!owner) throw new Error('UNEXPECTED_QUERY');
              return [[{ owner_type: 'PERSONAL', owner_user_id: owner }], []];
            }
          }
        } as never,
        { authorize: async () => ({ allowed: false }) } as never
      );
      expect(await access.canUseWorkspace(7, 'node-a', 'workspace-a')).toBe(true);
      expect(await access.canRelay(7, 'node-a', operation, {}, 'workspace-a')).toBe(false);
      expect(await access.canRelay(7, 'node-a', operation, {})).toBe(false);
      expect(await access.canRelay(8, 'node-a', operation, {}, 'workspace-a')).toBe(true);
      expect(await access.canRelay(8, 'node-a', operation, {})).toBe(true);
    }
  );

  it('allows a granted organization member to use the remote desktop without management rights', async () => {
    let granted = true;
    const access = new ResourceAccessService(
      {
        raw: {
          execute: async (sql: string, values: readonly unknown[]) => {
            if (sql.includes('FROM nodes'))
              return [[{ owner_type: 'ORGANIZATION', owner_organization_id: 2 }], []];
            if (sql.includes('FROM resource_grants')) {
              expect(values).toEqual([7, 'NODE', 'NODE:node-a:', 7]);
              return [granted ? [{}] : [], []];
            }
            throw new Error('UNEXPECTED_QUERY');
          }
        }
      } as never,
      {
        isPersonalAdmin: async () => false,
        authorize: async (_actor: number, permission: string, resource: { granted?: boolean }) => ({
          allowed: permission === 'RESOURCE_USE' && resource.granted === true
        })
      } as never
    );
    expect(await access.canManageNode(7, 'node-a')).toBe(false);
    for (const operation of ['computer.use.open', 'computer.use.attach'])
      expect(await access.canRelay(7, 'node-a', operation, {})).toBe(true);
    granted = false;
    for (const operation of ['computer.use.open', 'computer.use.attach'])
      expect(await access.canRelay(7, 'node-a', operation, {})).toBe(false);
  });

  it('preserves personal Workspace authorization while rejecting a foreign execution directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-workspace-boundary-'));
    const a = join(root, 'a');
    const b = join(root, 'b');
    await Promise.all([mkdir(a), mkdir(b)]);
    const database = new NodeDatabase(':memory:', 'workspace-boundary');
    const workspaceA = database.saveWorkspace({ path: a, kind: 'DIRECTORY', gitSummary: null });
    const workspaceB = database.saveWorkspace({ path: b, kind: 'DIRECTORY', gitSummary: null });
    const script = vi.fn(() => [{ type: 'success' as const }]);
    const connector = new NodeConnector({
      database,
      reconnect: false,
      capabilities: capabilities(),
      codexProfileClientFactory,
      fakeRunner: new FakeRunner(),
      fakeScript: script
    });
    const node = connector as unknown as {
      runtime: NodeRuntimeState;
      controlMessages: { handle(raw: string): unknown };
      executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
    };
    // Only persistence and transport are substitutes; authorization and admission are real.
    const access = new ResourceAccessService(
      {
        raw: {
          execute: async (sql: string, values: readonly unknown[]) => {
            if (!sql.includes('FROM workspaces')) throw new Error('UNEXPECTED_QUERY');
            const owner =
              values[0] === workspaceA.id ? 7 : values[0] === workspaceB.id ? 8 : undefined;
            return [
              owner === undefined ? [] : [{ owner_type: 'PERSONAL', owner_user_id: owner }],
              []
            ];
          }
        }
      } as never,
      {
        authorize: async () => {
          throw new Error('UNEXPECTED_ORGANIZATION_POLICY');
        }
      } as never
    );
    let requests!: NodeRequestService;
    const sent: NodeEnvelope[] = [];
    const socket = {
      OPEN: 1,
      readyState: 1,
      send: (raw: string) => {
        const envelope = JSON.parse(raw) as NodeEnvelope;
        sent.push(envelope);
        void requests.handle(envelope);
      }
    };
    const broker = new NodeRequestBroker(
      { audit: async () => undefined },
      access.canRelay.bind(access),
      () => socket as never,
      { allows: () => true },
      testNodeBrokerServices()
    );
    requests = new NodeRequestService({
      nodeId: () => 'node-boundary',
      databaseAvailable: () => true,
      execute: node.executeNodeOperation.bind(connector),
      send: (_type, payload, replyTo) => {
        broker.resolve(
          'node-boundary',
          createEnvelope('node.response', payload, { replyTo: replyTo! })
        );
      }
    });
    const inputs = new SessionInputService({
      nodeControl: { requestNode: broker.request.bind(broker) },
      secrets: { resolve: async () => ({}) },
      publicOrigin: undefined
    });
    const context = {
      nodeId: 'node-boundary',
      workspaceId: workspaceA.id,
      user: { userId: 7, sessionHash: 'a'.repeat(43) }
    };
    const control = vi.spyOn(node.controlMessages, 'handle');
    try {
      expect(await access.canUseWorkspace(7, context.nodeId, workspaceA.id)).toBe(true);
      expect(await access.canUseWorkspace(7, context.nodeId, workspaceB.id)).toBe(false);
      const input = {
        runner: 'codex',
        modelId: 'test-model',
        content: 'Run the fixture',
        cwd: b,
        clientMessageId: 'foreign-cwd'
      };
      await expect(inputs.startSession(context, input)).rejects.toMatchObject({
        code: 'SESSION_EXECUTION_DIRECTORY_INVALID'
      });
      expect(sent).toHaveLength(1);
      expect(node.runtime.listAgentSessions()).toEqual([]);
      expect(script).not.toHaveBeenCalled();
      await expect(
        inputs.startSession(
          { ...context, workspaceId: workspaceB.id },
          { ...input, clientMessageId: 'foreign-workspace' }
        )
      ).rejects.toThrow('NODE_ACCESS_DENIED');
      expect(sent).toHaveLength(1);
      await inputs.startSession(context, { ...input, cwd: a, clientMessageId: 'valid-cwd' });
      await vi.waitFor(() => expect(script).toHaveBeenCalledOnce());
      const starts = control.mock.calls
        .map(([raw]) => JSON.parse(raw) as NodeEnvelope)
        .filter((envelope) => envelope.type === 'run.start');
      expect(starts).toHaveLength(1);
      expect(starts[0]!.payload).toMatchObject({ cwd: a, workspaceId: workspaceA.id });
    } finally {
      broker.close();
      control.mockRestore();
      await connector.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
