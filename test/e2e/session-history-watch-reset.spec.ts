import { expect, test, type Page } from '@playwright/test';
import type { NodeConversationTurn } from '../../mar-node/src/runtime-model.js';
import type { NodeAgentSession } from '../../mar-node/src/session/contracts.js';
import { createTestSessionWatch } from '../../mar-node/test/unit/support/conversation-watch.js';
import {
  ConversationSegmentService,
  conversationSegments
} from '../../mar-node/src/service/conversation-segment-service.js';
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

for (const multipleInputs of [false, true]) {
  test(`terminal Watch bounds recent message actions and supports older rollback after explicit reload ${multipleInputs ? 'within one long Turn' : 'across Turns'}`, async ({
    page
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const session = {
      id: 'session-1',
      workspaceId: 'workspace-1',
      runner: 'mar-agent',
      externalSessionId: 'native-1',
      cwd: '/workspace',
      createdAt: 1
    } as NodeAgentSession;
    let active = true;
    const initialCount = multipleInputs ? 36 : 30;
    let count = initialCount;
    let sequence = 0;
    const turn = (index: number, persisted: boolean): NodeConversationTurn => ({
      id: `turn-${index}`,
      sessionId: session.id,
      runId: null,
      userItemId: `message-${index}`,
      status: 'SUCCEEDED',
      model: null,
      effort: null,
      access: null,
      startedAt: index,
      completedAt: index,
      ...(persisted
        ? { rewind: { before: index === 0 ? null : `turn-${index - 1}`, after: `turn-${index}` } }
        : {}),
      items: [
        {
          id: `message-${index}`,
          sessionId: session.id,
          turnId: `turn-${index}`,
          runId: null,
          parentItemId: null,
          sourceSequence: null,
          revision: 0,
          kind: 'user_message',
          status: 'COMPLETED',
          payload: { text: `Input ${index}` },
          startedAt: index,
          completedAt: index
        }
      ]
    });
    const historyTurns = (persisted: boolean): NodeConversationTurn[] => {
      const turns = Array.from({ length: count }, (_, index) => turn(index, persisted));
      if (!multipleInputs) return turns;
      return [
        {
          ...turns[0]!,
          items: turns.flatMap((entry, index) => {
            const input = { ...entry.items[0]!, turnId: 'turn-0' };
            return [
              input,
              {
                ...input,
                id: `reply-${index}`,
                kind: 'assistant_message',
                payload: { text: `Reply ${index}` }
              }
            ];
          })
        }
      ];
    };
    const deliveries: Promise<unknown>[] = [];
    const segments = new ConversationSegmentService(async () => ({
      source: active ? 'runtime' : 'official',
      snapshotSequence: sequence,
      readAt: 30,
      latestVisibleAt: count - 1,
      nextCursor: null,
      turns: historyTurns(!active)
    }));
    const watch = createTestSessionWatch({
      nodeId: () => 'node-1',
      nodeGeneration: () => 'generation-1',
      resolve: async () => session,
      hasActiveRun: () => active,
      refreshActivity: async () => undefined,
      present: () => session,
      projectInitialPage: (value, history, _unit, limit) =>
        segments.projectInitial(value, history, limit),
      readPage: async (_session, limit) => ({
        source: active ? 'runtime' : 'official',
        snapshotSequence: sequence,
        nextCursor: !multipleInputs && count > limit ? String(count - limit) : null,
        turns: historyTurns(!active).slice(-limit)
      }),
      emitSession: () => undefined,
      emitPage: () => undefined,
      emitWatchEvent: (frame) => {
        deliveries.push(
          page.evaluate((detail) => {
            window.dispatchEvent(new CustomEvent('fixture-watch-frame', { detail }));
          }, frame)
        );
      }
    });
    const rewind = page.getByRole('button', {
      name: 'Create a session branch before this message',
      exact: true
    });
    const rollback = page.getByRole('button', {
      name: 'Permanently delete this user message and all later conversation history',
      exact: true
    });
    try {
      await page.goto(`${fixture.url}session-history-watch-reset.html?boundary-backfill`);
      await page.route('**/api/agent-sessions/session-1/turns?**', async (route) => {
        const query = new URL(route.request().url()).searchParams;
        const cursor = query.get('cursor');
        await route.fulfill({
          json: await segments.read(session, {
            ...(cursor === null ? {} : { cursor }),
            limit: Number(query.get('limit'))
          })
        });
      });
      await expect(page.getByTestId('watch-identity')).toContainText('watchId');
      const identity = JSON.parse((await page.getByTestId('watch-identity').textContent())!);
      await watch.operations()['session.watch']!({ ...identity, sessionId: session.id });
      await expect(page.getByText(`Input ${initialCount - 6}`, { exact: true })).toBeVisible();
      for (let index = initialCount - 9; index >= (multipleInputs ? 6 : 0); index -= 3) {
        await page.getByRole('button', { name: 'Load earlier', exact: true }).click();
        await expect(page.getByText(`Input ${index}`, { exact: true })).toBeVisible();
      }
      await expect(rewind).toHaveCount(0);
      active = false;
      watch.emitRealtime(session.id, {
        sequence: ++sequence,
        category: 'session',
        payload: { session: { ...session, activity: 'IDLE' } }
      });
      await expect(rewind).toHaveCount(6);
      await expect(rollback).toHaveCount(6);
      await expect(
        page.getByText(`Input ${multipleInputs ? 6 : 0}`, { exact: true })
      ).toBeVisible();
      const old = multipleInputs ? historyTurns(false)[0]! : turn(initialCount - 5, false);
      watch.emitRealtime(session.id, {
        sequence: ++sequence,
        category: 'conversation',
        payload: { sessionId: session.id, turn: old, segments: conversationSegments(old) }
      });
      await Promise.all(deliveries.splice(0));
      await expect(rewind).toHaveCount(6);
      await expect(rollback).toHaveCount(6);
      // A user-requested reload and history paging obtain authoritative older boundaries.
      await page.reload();
      const terminalIdentity = JSON.parse(
        (await page.getByTestId('watch-identity').textContent())!
      );
      await watch.operations()['session.watch']!({ ...terminalIdentity, sessionId: session.id });
      await expect(page.getByText(`Input ${initialCount - 6}`, { exact: true })).toBeVisible();
      for (let index = initialCount - 9; index >= 0; index -= 3) {
        await page.getByRole('button', { name: 'Load earlier', exact: true }).click();
        await expect(page.getByText(`Input ${index}`, { exact: true })).toBeVisible();
      }
      await expect(rewind).toHaveCount(initialCount);
      await expect(rollback).toHaveCount(initialCount);
      await page.route('**/api/agent-sessions/session-1/rollback', async (route) => {
        expect(route.request().postDataJSON()).toMatchObject({
          turnId: multipleInputs ? 'turn-0' : 'turn-5',
          itemId: 'message-5',
          boundary: multipleInputs ? null : 'turn-4'
        });
        count = 5;
        sequence += 1;
        watch.invalidate(session.id);
        await route.fulfill({ json: { session } });
      });
      await page.getByRole('textbox', { name: 'Draft' }).fill('Keep my unsent draft');
      await rollback.nth(5).click();
      await expect(page.getByRole('textbox', { name: 'Draft' })).toHaveValue(
        'Keep my unsent draft'
      );
      await expect(page.getByText('Input 4', { exact: true })).toBeVisible();
      await expect(page.getByText('Input 5', { exact: true })).toHaveCount(0);
      await expect(page.getByText(`Input ${initialCount - 1}`, { exact: true })).toHaveCount(0);
      await expect(rewind).toHaveCount(5);
      expect(errors).toEqual([]);
    } finally {
      watch.clear();
      await Promise.all(deliveries);
    }
  });
}

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
  const rollbackResponse = Promise.withResolvers<void>();
  const watch = createTestSessionWatch({
    nodeId: () => 'node-1',
    nodeGeneration: () => 'generation-1',
    resolve: async () => session,
    hasActiveRun: () => true,
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
    await page.getByRole('textbox', { name: 'Draft' }).fill('Keep the initiating draft');
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
      await rollbackResponse.promise;
      await route.fulfill({ json: { session } });
    });
    await page
      .getByRole('button', {
        name: 'Permanently delete this user message and all later conversation history',
        exact: true
      })
      .click();
    await expect(page.getByText('Input to roll back', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Draft' })).toHaveValue(
      'Keep the initiating draft'
    );
    await expect(observer.getByRole('textbox', { name: 'Draft' })).toHaveValue(
      'Keep my unsent input'
    );
    await expect(page.getByRole('main')).toHaveAttribute('aria-busy', 'true');
    rollbackResponse.resolve();
    // An unchanged draft is not a completion signal: wait for HTTP application and reopening.
    await expect(page.getByRole('main')).toHaveAttribute('aria-busy', 'false');
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
          sessionId: session.id,
          turnId: 'next-turn',
          runId: 'next-run',
          parentItemId: null,
          sourceSequence: null,
          revision: 0,
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
        delta: {
          runId: 'next-run',
          itemId: 'next-assistant',
          segmentId: conversationSegments(nextTurn)[0]!.id,
          segmentIndex: 0,
          text: 'continues',
          createdAt: 11
        }
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
    rollbackResponse.resolve();
    watch.clear();
    await Promise.all(deliveries);
    await observer.close();
  }
});
