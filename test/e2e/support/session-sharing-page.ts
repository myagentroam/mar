import type { Page } from '@playwright/test';
import { json } from './web-console-api.js';

export async function mockSharedConversation(
  page: Page,
  locale: string,
  assistantText?: string
): Promise<void> {
  await page.addInitScript((language) => {
    localStorage.setItem('mar.locale.v2', language);
    localStorage.setItem(
      'mar:session-share:participants-test',
      JSON.stringify({ credential: 'a'.repeat(43) })
    );
    class ShareSocket extends EventTarget {
      static readonly OPEN = 1;
      static current: ShareSocket;
      readonly readyState = 1;
      constructor() {
        super();
        ShareSocket.current = this;
        queueMicrotask(() => {
          this.dispatchEvent(new Event('open'));
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                type: 'workbench.ready',
                workbenchConnectionId: 'share-connection',
                workbenchResumeToken: 'share-resume'
              })
            })
          );
        });
      }
      send(): void {}
      close(): void {}
    }
    Object.defineProperty(window, 'WebSocket', { value: ShareSocket });
  }, locale);
  await page.route('**/api/session-shares/participants-test/auth', (route) =>
    json(route, {
      share: {
        id: 'participants-test',
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        createdAt: Date.now(),
        expiresAt: null
      },
      credential: 'a'.repeat(43),
      sharerName: 'admin',
      workspaceName: 'Project Alpha'
    })
  );
  await page.route('**/api/session-shares/participants-test/profiles', (route) =>
    json(route, { profiles: [] })
  );
  const session = {
    id: 'session-1',
    workspaceId: 'workspace-1',
    runner: 'mar-agent',
    runnerTitle: 'Shared session',
    model: 'test-model',
    effort: 'high',
    access: 'auto',
    activity: 'MANAGED_ACTIVE',
    capabilities: []
  };
  await page.route('**/api/session-shares/participants-test/session', (route) =>
    json(route, { session })
  );
  await page.route('**/api/session-shares/participants-test/watch', async (route) => {
    if (route.request().method() !== 'POST') return json(route, {});
    const watch = route.request().postDataJSON();
    await json(route, { nodeGeneration: 'share-generation' });
    await page.evaluate(
      ({ watch, session, assistantText }) => {
        const Socket = window.WebSocket as typeof WebSocket & { current: EventTarget };
        Socket.current.dispatchEvent(
          new MessageEvent('message', {
            data: JSON.stringify({
              type: 'watch.event',
              event: {
                type: 'watch.session.snapshot',
                nodeId: 'node-1',
                workspaceId: 'workspace-1',
                sessionId: 'session-1',
                workbenchConnectionId: 'share-connection',
                watchId: watch.watchId,
                nodeGeneration: 'share-generation',
                payload: {
                  kind: 'session-watch-snapshot',
                  sequence: 1,
                  session,
                  runs: [
                    {
                      id: 'run-1',
                      sessionId: 'session-1',
                      workspaceId: 'workspace-1',
                      status: 'RUNNING',
                      createdAt: Date.now() - 45000,
                      recoveryState: 'ACTIVE',
                      clientMessageId: 'message-1'
                    }
                  ],
                  unit: 'SEGMENT',
                  segments: assistantText
                    ? [
                        {
                          id: 'turn-1:segment:0',
                          sessionId: session.id,
                          turnId: 'turn-1',
                          runId: 'run-1',
                          index: 0,
                          status: 'RUNNING',
                          startedAt: 1,
                          completedAt: null,
                          items: [
                            {
                              id: 'preview-message',
                              sessionId: session.id,
                              turnId: 'turn-1',
                              runId: 'run-1',
                              parentItemId: null,
                              sourceSequence: null,
                              revision: 1,
                              kind: 'assistant_message',
                              status: 'IN_PROGRESS',
                              startedAt: 1,
                              completedAt: null,
                              payload: { text: assistantText, format: 'markdown', model: null }
                            }
                          ]
                        }
                      ]
                    : [],
                  nextCursor: null
                }
              }
            })
          })
        );
      },
      { watch, session, assistantText }
    );
  });
}
