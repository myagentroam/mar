import { describe, expect, it, vi } from 'vitest';
import { composeWorkspaceApplication } from '../../src/application/workspace-application.js';

describe('Workspace application Session publication', () => {
  it('invalidates the Session cache and watch before publishing without waiting for the watch', () => {
    const order: string[] = [];
    const pending = new Promise<void>(() => {});
    const input = {
      config: () => undefined,
      database: () => undefined,
      runtime: {},
      terminals: {},
      resources: {
        sessions: { markCacheStale: (id: string) => order.push(`cache:${id}`) },
        watch: {},
        files: {},
        uploads: {},
        invalidateFiles: () => undefined
      },
      changes: {},
      listSessions: async () => [],
      invalidatePrompt: () => undefined,
      nodeId: () => 'node',
      nodeGeneration: () => 'generation',
      send: () => undefined,
      emitWatchEvent: () => undefined,
      publishSession: () => order.push('publish')
    } as unknown as Parameters<typeof composeWorkspaceApplication>[0];
    const app = composeWorkspaceApplication(input);
    vi.spyOn(app.workbench, 'invalidateTopic').mockImplementation((id, topic) => {
      order.push(`watch:${id}:${topic}`);
      return pending;
    });

    app.publishSession({ session: { workspaceId: 'workspace-1' } });
    expect(order).toEqual(['cache:workspace-1', 'watch:workspace-1:sessions', 'publish']);
    app.publishSession({ session: {} });
    expect(order).toEqual([
      'cache:workspace-1',
      'watch:workspace-1:sessions',
      'publish',
      'publish'
    ]);
  });
});
