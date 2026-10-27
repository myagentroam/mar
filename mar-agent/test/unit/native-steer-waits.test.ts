import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../src/index.js';
import type { ExtensionAgentsApi } from '../../src/extensions.js';
import type { ToolExecutionContext } from '../../src/tools/contracts.js';
import { fixture, answer, call, cleanupCoreFixtures } from './support/core-extension-fixture.js';

afterEach(cleanupCoreFixtures);
const command = (script: string) =>
  `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
const childCommand = command(
  "process.stdin.once('data', () => { process.stdout.write('finished'); process.exit(0); }); process.stdin.resume();"
);

describe.each(['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'] as const)(
  'steer resumes managed waits %s',
  (protocol) => {
    it.each(['single', 'any', 'all', 'untargeted'] as const)(
      'wakes a %s child wait while retaining the child Turn',
      async (target) => {
        const entered = Promise.withResolvers<void>();
        const waiting = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let api: ExtensionAgentsApi | undefined;
        let parentRound = 0;
        let agentId: string | undefined;
        const f = await fixture(
          [
            {
              id: 'wait-owner',
              apiVersion: '1.0',
              attachSession(context) {
                api ??= context.agents;
              }
            }
          ],
          (request) => {
            const child = request.messages.some(
              (message) =>
                message.role === 'user' && JSON.stringify(message.content).includes('child worker')
            );
            if (child)
              return request.messages.some((message) => message.role === 'tool')
                ? answer()
                : call('read', { reads: [{ path: 'input.txt' }] });
            if (parentRound++ === 0)
              return call('agent_start', {
                description: 'Retained child',
                prompt: 'child worker',
                role: 'explore'
              });
            if (parentRound === 2) {
              const receipt = request.messages.findLast(
                (message) => message.role === 'tool' && message.name === 'agent_start'
              );
              agentId = JSON.parse(receipt!.content as string).agentId;
              return call(
                'agent_wait',
                target === 'untargeted'
                  ? { waitMs: 300000, waitFor: 'message' }
                  : target === 'single'
                    ? { agentId, waitMs: 300000 }
                    : { agentIds: [agentId], mode: target, waitMs: 300000 }
              );
            }
            return answer();
          },
          false,
          false,
          {
            beforeToolExecute: async (call) => {
              if (call.name === 'read') {
                entered.resolve();
                await release.promise;
              }
            }
          },
          protocol
        );
        try {
          const execution = f.session.run({
            prompt: 'wait for children',
            permissionMode: 'full-access'
          });
          const events: AgentEvent[] = [];
          const collecting = (async () => {
            for await (const event of execution) {
              events.push(event);
              if (event.type === 'tool.started' && event.toolName === 'agent_wait')
                waiting.resolve();
            }
          })();
          await Promise.all([entered.promise, waiting.promise]);
          expect(
            (
              await f.session.steer({
                expectedExecutionId: execution.executionId,
                prompt: 'stop waiting for child',
                clientMessageId: 'child-steer'
              })
            ).status
          ).toBe('accepted');
          expect(await execution.result()).toMatchObject({ status: 'completed' });
          await collecting;
          const event = events.find(
            (value) => value.type === 'tool.completed' && value.toolName === 'agent_wait'
          );
          expect(event).toMatchObject({ data: { waitOutcome: 'interrupted', reason: 'steer' } });
          if (target === 'single' || target === 'untargeted')
            expect(event).toMatchObject({ data: { status: 'running', agentId } });
          else
            expect(event).toMatchObject({
              data: {
                pendingAgentIds: [agentId],
                agents: [{ status: 'running', waitOutcome: 'interrupted', reason: 'steer' }]
              }
            });
          expect(events.some((value) => value.type === 'tool.failed')).toBe(false);
          release.resolve();
          expect(await api!.wait({ agentId, untilSettled: true })).toMatchObject({
            status: 'completed',
            waitOutcome: 'completion'
          });
        } finally {
          release.resolve();
        }
      }
    );
    it.each([false, true])(
      'wakes the foreground wait without cancelling retained work (code mode: %s)',
      async (codeMode) => {
        const entered = Promise.withResolvers<void>();
        const events: AgentEvent[] = [];
        const code = `const process = await tools.exec(${JSON.stringify({ command: childCommand, yieldMs: 0 })}); observe.result(process); const final = await tools.exec_wait({ processId: process.data.processId, yieldMs: 300000 }); observe.result(final);`;
        const f = await fixture(
          [],
          (_request, index) =>
            index === 0
              ? call(
                  codeMode ? 'code_exec' : 'exec',
                  codeMode ? code : { command: childCommand, yieldMs: 30000 }
                )
              : answer(),
          codeMode,
          false,
          {},
          protocol
        );
        const execution = f.session.run({
          prompt: 'start retained work',
          permissionMode: 'full-access'
        });
        let processId: string | undefined;
        let cellId: string | undefined;
        const collecting = (async () => {
          for await (const event of execution) {
            events.push(event);
            if (
              event.type === 'tool.started' &&
              event.toolName === (codeMode ? 'exec_wait' : 'exec')
            )
              entered.resolve();
            if (event.type === 'tool.completed' && event.toolName === 'exec')
              processId = (event.data as { processId: string }).processId;
            if (event.type === 'tool.completed' && event.toolName === 'code_exec')
              cellId = (event.data as { cellId: string }).cellId;
          }
        })();
        await entered.promise;
        const receipt = await f.session.steer({
          expectedExecutionId: execution.executionId,
          prompt: 'stop waiting now',
          clientMessageId: 'steer-retained'
        });
        expect(receipt.status).toBe('accepted');
        expect(await execution.result()).toMatchObject({ status: 'completed' });
        await collecting;
        const foreground = events.find(
          (event) =>
            event.type === 'tool.completed' && event.toolName === (codeMode ? 'code_exec' : 'exec')
        );
        expect(foreground).toMatchObject({
          data: { status: 'running', waitOutcome: 'interrupted', reason: 'steer' }
        });
        expect(events.some((event) => event.type === 'tool.failed')).toBe(false);
        expect(f.adapter.requests).toHaveLength(2);
        const next = f.adapter.requests[1]!;
        const toolIndex = next.messages.findIndex((message) => message.role === 'tool');
        const steerIndex = next.messages.findIndex(
          (message) =>
            message.role === 'user' && JSON.stringify(message.content).includes('stop waiting now')
        );
        expect(toolIndex).toBeGreaterThanOrEqual(0);
        expect(steerIndex).toBeGreaterThan(toolIndex);
        expect(JSON.parse(next.messages[toolIndex]!.content as string)).toMatchObject({
          status: 'running',
          waitOutcome: 'interrupted',
          reason: 'steer'
        });
        const ctx: ToolExecutionContext = {
          sessionId: f.session.id,
          executionId: execution.executionId,
          mode: 'run',
          signal: new AbortController().signal
        };
        if (codeMode) {
          expect(cellId).toBeTruthy();
          expect(
            events.some(
              (event) => event.type === 'tool.completed' && event.toolName === 'exec_wait'
            )
          ).toBe(false);
        }
        expect(processId).toBeTruthy();
        const snapshot = await f.host.executeTool(
          { name: 'exec_wait', arguments: { processId, yieldMs: 0 } },
          ctx
        );
        expect(snapshot.data).toMatchObject({ status: 'running', waitOutcome: 'snapshot' });
        await f.host.executeTool(
          { name: 'exec_wait', arguments: { processId, action: 'write', data: 'finish' } },
          ctx
        );
        if (codeMode) {
          const final = await f.host.executeTool(
            { name: 'code_exec_wait', arguments: { cellId, yieldMs: 300000 } },
            ctx
          );
          expect(final.data).toMatchObject({ status: 'completed', waitOutcome: 'completion' });
          expect(final.data).not.toHaveProperty('reason');
          const finalProcess = final.observations?.find(
            (entry) => entry.type === 'tool_result' && entry.source.toolName === 'exec_wait'
          );
          const processResult =
            finalProcess?.type === 'tool_result' && JSON.parse(finalProcess.result.content);
          expect(processResult).toMatchObject({ stdout: 'finished' });
          expect(processResult.waitOutcome).toBe(
            processResult.status === 'running' ? 'yield' : 'completion'
          );
        } else {
          const final = await f.host.executeTool(
            { name: 'exec_wait', arguments: { processId, yieldMs: 10000 } },
            ctx
          );
          const processResult = final.data as { status: string; waitOutcome: string };
          expect(final.data).toMatchObject({ stdout: 'finished' });
          expect(processResult.waitOutcome).toBe(
            processResult.status === 'running' ? 'yield' : 'completion'
          );
          expect(final.data).not.toHaveProperty('reason');
        }
        const terminal = await f.host.executeTool(
          { name: 'exec_wait', arguments: { processId, yieldMs: 10000 } },
          ctx
        );
        expect(terminal.data).toMatchObject({
          status: 'completed',
          waitOutcome: 'completion',
          exitCode: 0
        });
      }
    );
  }
);
