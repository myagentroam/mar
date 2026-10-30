import { expect, test } from '@playwright/test';
import { fulfillMockSessionWatch, json, mockConsoleApi, write } from './support/web-console-api.js';

const runners = [
  { runner: 'mar-agent', initialAccess: 'auto', goalAccess: 'auto' },
  { runner: 'codex', initialAccess: 'on-request', goalAccess: 'full-access' },
  { runner: 'claude-code', initialAccess: 'default', goalAccess: 'bypass' },
  { runner: 'opencode', initialAccess: 'default', goalAccess: 'auto' }
] as const;

for (const language of ['zh-CN', 'en-US'] as const) {
  for (const { runner, initialAccess, goalAccess } of runners) {
    for (const mode of ['draft', 'existing'] as const) {
      test(`Mobile Goal switching is silent and starts sessions with effective permissions ${runner} ${language} ${mode}`, async ({
        page
      }) => {
        const english = language === 'en-US';
        await page.addInitScript(
          (locale) => localStorage.setItem('mar.locale.v2', locale),
          language
        );
        const writes: { url: string; csrf: string | undefined; body: string }[] = [];
        await mockConsoleApi(
          page,
          'MANAGED',
          ['history.read', 'turn.start'],
          writes,
          undefined,
          undefined,
          undefined,
          undefined,
          '0.10.25'
        );
        await page.route(/\/api\/runner-profiles\?/, (route) =>
          json(route, {
            profiles: [
              {
                runner,
                models: [{ id: 'goal-model', label: 'Goal model', supportedEfforts: ['medium'] }],
                accessOptions: [...new Set([initialAccess, goalAccess])].map((id) => ({
                  id,
                  label: id
                })),
                capabilities: ['history.read', 'turn.start'],
                commands: [
                  {
                    runner,
                    id: 'goal',
                    label: '/goal',
                    description: 'Start Goal mode',
                    inputHint: '/goal',
                    source: 'MAR_RUNTIME',
                    interaction: 'TOGGLE',
                    available: true,
                    reasonCode: null
                  }
                ]
              }
            ],
            defaults: [{ runner, modelId: 'goal-model', effort: 'medium', access: initialAccess }]
          })
        );
        const initialSession = {
          id: 'session-1',
          externalSessionId: 'native-goal-session',
          workspaceId: 'workspace-1',
          runner,
          modelId: 'goal-model',
          effort: 'medium',
          access: initialAccess,
          activity: 'IDLE',
          nativeControl: 'MAR_MANAGED',
          runnerTitle: 'Goal session',
          commandStates: [],
          control: { level: 'MANAGED', capabilities: ['history.read', 'turn.start'] }
        };
        let currentSession: Record<string, unknown> = initialSession;
        const goalState = {
          commandId: 'goal',
          active: true,
          label: 'Goal',
          detail: 'Goal is active.',
          source: 'MAR_RUNTIME',
          closable: true,
          closeInput: '/goal --clear',
          goal: {
            id: '11111111-1111-4111-8111-111111111111',
            objective: 'Implement the requested feature',
            revision: 1,
            status: 'active',
            turns: 1,
            retryRequired: false,
            retryStartedAtTurn: null
          }
        };
        await page.route('**/api/agent-sessions/session-1?nodeId=node-1', (route) =>
          json(route, { session: currentSession })
        );
        await page.route('**/api/agent-sessions/session-1/watch', (route) =>
          fulfillMockSessionWatch(page, route, initialSession, {
            session: currentSession,
            runs: [],
            turns: [],
            nextCursor: null,
            queue: [],
            pendingQuestions: []
          })
        );
        await page.route('**/api/agent-sessions/start', (route) => {
          const body = route.request().postDataJSON() as { access: string };
          if (body.access !== goalAccess) {
            writes.push({
              url: route.request().url(),
              csrf: undefined,
              body: route.request().postData() ?? ''
            });
            return json(
              route,
              { error: { code: 'SESSION_INVALID', message: 'Session is invalid.' } },
              400
            );
          }
          currentSession = { ...initialSession, access: goalAccess, commandStates: [goalState] };
          return write(route, writes, {
            session: currentSession,
            run: {
              id: 'run-1',
              sessionId: initialSession.id,
              runner,
              status: 'RUNNING',
              task: goalState.goal.objective
            },
            delivery: 'STARTED'
          });
        });
        await page.route('**/api/agent-sessions/session-1/commands', (route) => {
          currentSession = { ...initialSession, access: goalAccess, commandStates: [goalState] };
          return write(route, writes, {
            session: currentSession,
            goalAccessChanged: runner !== 'mar-agent'
          });
        });

        await page.goto('/console');
        await page.getByRole('button', { name: english ? 'Open console' : '进入控制台' }).click();
        await page.getByRole('button', { name: english ? 'Work' : '工作', exact: true }).click();
        await page
          .locator('.workspace-tree')
          .getByRole('button', { name: /node-1/ })
          .click();
        await page.locator('.workspace-tree').getByRole('button', { name: 'project' }).click();
        if (mode === 'draft')
          await page
            .getByRole('button', { name: english ? 'New session' : '新建会话', exact: true })
            .click();
        else await page.locator('.session-list .session-link').first().click();
        await page.setViewportSize({ width: 390, height: 844 });
        const composer = page.getByRole('textbox', {
          name: english ? 'Message' : '输入消息',
          exact: true
        });
        await composer.fill('/goal');
        await page.getByRole('option', { name: /\/goal/ }).click();
        if (mode === 'draft') {
          await expect(page.locator('.composer-command-state')).toContainText(
            english ? 'Goal' : '目标'
          );
          await composer.fill(goalState.goal.objective);
          await page.locator('.composer-send-button').click();
          await expect
            .poll(
              () => writes.filter((entry) => entry.url.endsWith('/api/agent-sessions/start')).length
            )
            .toBe(1);
          const start = JSON.parse(
            writes.find((entry) => entry.url.endsWith('/api/agent-sessions/start'))!.body
          );
          expect(start).toMatchObject({
            runner,
            access: goalAccess,
            content: goalState.goal.objective,
            deferredCommands: [{ commandId: 'goal', input: '/goal' }]
          });
        } else {
          await expect
            .poll(() => writes.filter((entry) => entry.url.endsWith('/commands')).length)
            .toBe(1);
          const command = JSON.parse(writes.find((entry) => entry.url.endsWith('/commands'))!.body);
          expect(command).toMatchObject({ commandId: 'goal', input: '/goal' });
        }
        await expect(composer).toHaveValue('');
        await expect(page.locator('.goal-card')).toContainText(goalState.goal.objective);
        await expect(page.locator('.el-message--success')).toHaveCount(0);
        await expect(page.locator('.el-message--error')).toHaveCount(0);
        await expect(page.getByText(/goal\.permissionChanged/)).toHaveCount(0);
      });
    }
  }
}
