import { expect, test, type Page } from '@playwright/test';
import type { NodeAgentSession, NodeConversationTurn } from '../../mar-node/src/runtime-model.js';
import { createTestSessionWatch } from '../../mar-node/test/unit/support/conversation-watch.js';
import { conversationSegments } from '../../mar-node/src/service/conversation-segment-service.js';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

let fixture: Awaited<ReturnType<typeof startCustomThemeFixture>>;
test.beforeAll(async () => {
  fixture = await startCustomThemeFixture('test/e2e/support/session-history-watch-reset.html', {
    protocolSource: true
  });
});
test.afterAll(async () => {
  await fixture?.close();
});

test('Rollback resets a second browser page immediately without losing its unsent draft', async ({
  page,
  context
}) => {
  const observer = await context.newPage();
  const pages = new Map<string, Page>();
  const deliveries: Promise<unknown>[] = [];
  const session: NodeAgentSession = {
    id: 'session-1',
    workspaceId: 'workspace-1',
    runner: 'codex',
    externalSessionId: 'native-1',
    cwd: '/workspace',
    createdAt: 1
  } as NodeAgentSession;
  let removed = false;
  const watch = createTestSessionWatch({
    nodeId: () => 'node-1',
    nodeGeneration: () => 'generation-1',
    resolve: async () => session,
    managedActive: () => true,
    refreshActivity: async () => undefined,
    present: () => session,
    projectInitialPage: (_session, value) => ({
      ...value,
      unit: 'SEGMENT',
      segments: value.turns.flatMap(conversationSegments)
    }),
    readPage: async () => ({
      snapshotSequence: removed ? 2 : 1,
      turns: removed
        ? []
        : [
            {
              id: 'turn-1',
              status: 'SUCCEEDED',
              rewind: { before: null, after: 'native-turn-1' },
              items: [
                {
                  id: 'message-1',
                  kind: 'user_message',
                  status: 'COMPLETED',
                  payload: { text: 'Input to roll back' }
                }
              ]
            }
          ]
    }),
    emitSession: () => undefined,
    emitPage: () => undefined,
    emitWatchEvent: (frame) => {
      const event = frame as { workbenchConnectionId: string };
      const target = pages.get(event.workbenchConnectionId);
      if (target)
        deliveries.push(
          target.evaluate((detail) => {
            window.dispatchEvent(new CustomEvent('fixture-watch-frame', { detail }));
          }, frame)
        );
    }
  });
  const errors: string[] = [];
  try {
    for (const [index, target] of [page, observer].entries()) {
      target.on('pageerror', (error) => errors.push(error.message));
      await target.goto(`${fixture.url}session-history-watch-reset.html?page-${index}`);
      await expect(target.getByTestId('watch-identity')).toContainText('watchId');
      const identity = JSON.parse((await target.getByTestId('watch-identity').textContent())!);
      pages.set(identity.workbenchConnectionId, target);
      await watch.operations()['session.watch']!({ ...identity, sessionId: session.id });
      await expect(target.getByText('Input to roll back', { exact: true })).toBeVisible();
    }
    await observer.getByRole('textbox', { name: 'Draft' }).fill('Keep my unsent input');
    await page.route('**/api/agent-sessions/session-1/rollback', async (route) => {
      expect(route.request().postDataJSON()).toMatchObject({
        turnId: 'turn-1',
        itemId: 'message-1',
        boundary: null
      });
      removed = true;
      watch.invalidate(session.id);
      // Exercise the real Watch-before-HTTP ordering, without a renewal or page reload.
      await expect(observer.getByText('Input to roll back', { exact: true })).toHaveCount(0);
      await route.fulfill({ json: { session } });
    });
    await page
      .getByRole('button', {
        name: 'Permanently delete this user message and all later conversation history',
        exact: true
      })
      .click();
    await expect(page.getByText('Input to roll back', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Draft' })).toHaveValue('Input to roll back');
    await expect(observer.getByRole('textbox', { name: 'Draft' })).toHaveValue(
      'Keep my unsent input'
    );
    const nextTurn: NodeConversationTurn = {
      id: 'next-turn',
      sessionId: session.id,
      runId: 'next-run',
      status: 'RUNNING',
      userItemId: null,
      model: null,
      effort: null,
      access: null,
      items: [
        {
          id: 'next-assistant',
          runId: 'next-run',
          kind: 'assistant_message',
          status: 'IN_PROGRESS',
          payload: { text: 'Fresh ' },
          startedAt: 10,
          completedAt: null
        }
      ],
      startedAt: 10,
      completedAt: null
    };
    watch.emitRealtime(session.id, {
      sequence: 10,
      category: 'conversation',
      payload: {
        sessionId: session.id,
        turn: nextTurn,
        segments: conversationSegments(nextTurn)
      }
    });
    watch.emitRealtime(session.id, {
      sequence: 11,
      category: 'conversation',
      payload: {
        sessionId: session.id,
        delta: { runId: 'next-run', itemId: 'next-assistant', text: 'continues', createdAt: 11 }
      }
    });
    await Promise.all(deliveries.splice(0));
    for (const target of [page, observer])
      await expect(target.getByText('Fresh continues', { exact: true })).toBeVisible();
    for (const target of [page, observer]) {
      const identity = JSON.parse((await target.getByTestId('watch-identity').textContent())!);
      await expect(
        watch.operations()['session.watch']!({
          ...identity,
          mode: 'renew',
          nodeGeneration: 'generation-1',
          sessionId: session.id
        })
      ).resolves.toHaveProperty('expiresAt');
    }
    expect(errors).toEqual([]);
  } finally {
    watch.clear();
    await Promise.all(deliveries);
    await observer.close();
  }
});
