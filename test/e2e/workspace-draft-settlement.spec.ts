import { expect, test, type Page } from '@playwright/test';
import { fulfillMockSessionWatch, json, mockConsoleApi } from './support/web-console-api.js';

// @test-covers packages/web-core/src/service/session-draft-service.ts
// @test-covers packages/web-core/src/service/workbench-session-message-service.ts
// @test-covers packages/web-core/src/service/workspace-session-pane-state.ts
// @test-covers packages/web-core/src/service/workspace-queue-service.ts

async function openSession(page: Page) {
  const tree = page.locator('.workspace-tree');
  const project = tree.getByRole('button', { name: 'project', exact: true });
  if (!(await project.isVisible())) await tree.getByRole('button', { name: /node-1/ }).click();
  await project.click();
  await page.locator('.session-list button').first().click();
  await expect(page.getByRole('textbox', { name: '输入消息' })).toBeVisible();
}

for (const operation of ['message', 'queue'] as const) {
  for (const reopenBeforeSuccess of [false, true]) {
    test(`Workspace ${operation} settles after actual close; new edit ${reopenBeforeSuccess}`, async ({
      page
    }) => {
      await mockConsoleApi(page, 'MANAGED', ['history.read', 'turn.start']);
      const session = {
        id: 'session-1',
        workspaceId: 'workspace-1',
        runner: 'codex',
        externalSessionId: 'vscode-thread-1',
        nativeControl: 'EXTERNAL',
        activity: 'IDLE',
        control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
      };
      const queue = {
        version: 0,
        paused: false,
        items:
          operation === 'queue'
            ? [
                {
                  queueItemId: 'item-1',
                  sessionId: session.id,
                  workspaceId: session.workspaceId,
                  runner: 'codex',
                  clientMessageId: 'queued-message',
                  content: 'Original item',
                  createdAt: 1
                }
              ]
            : []
      };
      await page.route('**/api/agent-sessions/session-1/watch*', (route) =>
        fulfillMockSessionWatch(page, route, session, {
          kind: 'session-watch-snapshot',
          sequence: 1,
          session,
          runs: [],
          queue,
          context: null,
          conversation: {
            unit: 'SEGMENT',
            source: 'official',
            readAt: 1,
            latestVisibleAt: 1,
            nextCursor: null,
            snapshotSequence: 1,
            segments: []
          }
        })
      );
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      let requested = false;
      await page.route(
        operation === 'message'
          ? '**/api/agent-sessions/session-1/messages'
          : '**/api/queue-items/item-1',
        async (route) => {
          requested = true;
          await pending;
          await json(
            route,
            operation === 'message'
              ? {
                  session,
                  run: {
                    id: 'sent-run',
                    sessionId: session.id,
                    workspaceId: session.workspaceId,
                    status: 'RUNNING',
                    recoveryState: 'ACTIVE',
                    clientMessageId: 'sent-message'
                  }
                }
              : {}
          );
        }
      );
      const composer = page.getByRole('textbox', { name: '输入消息' });
      const edit = page.locator('.queue-item.editing textarea');
      const storageKey =
        operation === 'message'
          ? 'mar.workbench.draft.node-1.workspace-1'
          : 'mar.workbench.queue-edit.' +
            JSON.stringify(['node-1', 'workspace-1', 'session', 'session-1']);
      const durable = () => page.evaluate((key) => sessionStorage.getItem(key), storageKey);
      try {
        await page.goto('/console');
        await page.getByRole('button', { name: '进入控制台' }).click();
        await openSession(page);
        if (operation === 'message') {
          await composer.fill('Submitted draft');
          await page.getByRole('button', { name: '发送', exact: true }).click();
        } else {
          await composer.fill('Unsubmitted composer');
          await page
            .locator('.queue-item')
            .getByRole('button', { name: '编辑', exact: true })
            .click();
          await edit.fill('Submitted draft');
          await page
            .locator('.queue-item')
            .getByRole('button', { name: '保存', exact: true })
            .click();
        }
        await expect.poll(() => requested).toBe(true);
        await page
          .getByRole('tab', { name: /project/ })
          .locator('..')
          .locator('.tab-close')
          .click();
        await expect(page.getByRole('tab', { name: /project/ })).toHaveCount(0);
        await expect.poll(durable).toContain('Submitted draft');
        if (reopenBeforeSuccess) {
          await openSession(page);
          if (operation === 'message') await composer.fill('New edit');
          else await edit.fill('New edit');
        }
        const response = page.waitForResponse((response) =>
          response.url().includes(operation === 'message' ? '/messages' : '/queue-items/item-1')
        );
        release();
        await (await response).finished();
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
            )
        );
        await expect.poll(durable).not.toContain('Submitted draft');
        if (!reopenBeforeSuccess) await openSession(page);
        await expect(composer).toHaveValue(
          operation === 'queue' ? 'Unsubmitted composer' : reopenBeforeSuccess ? 'New edit' : ''
        );
        if (operation === 'queue') {
          if (reopenBeforeSuccess) await expect(edit).toHaveValue('New edit');
          else await expect(edit).toHaveCount(0);
        }
        // Reload creates a new page/owner over the same sessionStorage, not just the old refs.
        await page.reload();
        await expect(composer).toHaveValue(
          operation === 'queue' ? 'Unsubmitted composer' : reopenBeforeSuccess ? 'New edit' : ''
        );
        if (operation === 'queue') {
          if (reopenBeforeSuccess) await expect(edit).toHaveValue('New edit');
          else await expect(edit).toHaveCount(0);
        }
      } finally {
        release();
      }
    });
  }
}
