import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import type { AgentEvent } from '../../src/runtime/events.js';
import type { ToolExecutionContext, ToolExecutionResult } from '../../src/tools/contracts.js';
import { answer, call, cleanupCoreFixtures, fixture } from './support/core-extension-fixture.js';

afterEach(cleanupCoreFixtures);

it.each([
  { toolName: 'exec_wait', cancel: false },
  { toolName: 'exec_wait', cancel: true },
  { toolName: 'code_exec_wait', cancel: false },
  { toolName: 'code_exec_wait', cancel: true }
] as const)(
  'persists owner sources before $toolName finishes (cancel=$cancel)',
  async ({ toolName, cancel }) => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null
    });
    const codeMode = toolName === 'code_exec_wait';
    let input: unknown;
    let release!: (value: ToolExecutionResult) => void;
    const gate = new Promise<ToolExecutionResult>((resolve) => {
      release = resolve;
    });
    const { agent, session, host, adapter } = await fixture(
      [],
      (_request, index) => (index === 0 ? call(toolName, input) : answer()),
      codeMode,
      false,
      codeMode
        ? {}
        : {
            processExecutor: {
              async spawn() {
                return child as unknown as ChildProcessWithoutNullStreams;
              }
            }
          }
    );
    const context: ToolExecutionContext = {
      sessionId: session.id,
      executionId: 'creator-execution',
      mode: 'run',
      signal: new AbortController().signal,
      codeMode: {
        tools: [
          {
            name: 'hold',
            description: 'Wait for the fixture.',
            inputSchema: { type: 'object', properties: {} }
          }
        ],
        invoke: () => gate
      }
    };
    const source = codeMode
      ? '// @options: {"yieldMs":0}\nobserve.text(await tools.hold({}));'
      : 'original command';
    const finish = () => {
      release({ content: 'finished' });
      child.exitCode = 0;
      child.emit('close', 0, null);
    };
    try {
      const started = await host.executeTool(
        {
          name: codeMode ? 'code_exec' : 'exec',
          arguments: codeMode ? source : { command: source, yieldMs: 0 }
        },
        context
      );
      const data = started.data as { processId?: string; cellId?: string };
      input = {
        ...(codeMode ? { cellId: data.cellId } : { processId: data.processId }),
        yieldMs: 300000
      };
      const run = session.run({ prompt: 'Wait for the retained resource.' });
      const events: AgentEvent[] = [];
      let updated = false;
      for await (const event of run) {
        events.push(event);
        if (event.type !== 'tool.updated' || event.toolName !== toolName) continue;
        expect(updated).toBe(false);
        updated = true;
        expect(event.data).toMatchObject({
          executionSource: {
            kind: codeMode ? 'CODE' : 'SHELL',
            text: source,
            truncated: false
          }
        });
        expect(
          events.some((entry) => entry.type === 'tool.completed' && entry.toolName === toolName)
        ).toBe(false);
        if (cancel) await session.cancel(run.executionId);
        else finish();
      }
      expect(updated).toBe(true);
      expect((await run.result()).status).toBe(cancel ? 'cancelled' : 'completed');
      const history = await agent.sessionHistory(session.id);
      expect(
        history.entries.filter((entry) => entry.kind === 'event').map((entry) => entry.event)
      ).toContainEqual(
        events.find((event) => event.type === 'tool.updated' && event.toolName === toolName)
      );
      const results = adapter.requests.flatMap((request) =>
        request.messages.filter((message) => message.role === 'tool')
      );
      if (!cancel) expect(results.length).toBeGreaterThan(0);
      expect(JSON.stringify(results)).not.toContain('executionSource');
    } finally {
      finish();
    }
  }
);
