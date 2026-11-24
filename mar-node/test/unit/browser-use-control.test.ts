import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalAgentHost } from '@myagentroam/agent/host';
import { createEnvelope } from '@myagentroam/protocol';
import { describe, expect, it, vi } from 'vitest';
import { BrowserUseControl } from '../../src/browser/browser-use-control.js';
import { createBrowserUseExtensions } from '../../src/runner/mar-agent/browser-use-extensions.js';

const scope = { workspaceId: 'workspace', userId: 7 };

describe('Browser Use account authorization', () => {
  it('checks the current scope and accepts only its matching response', async () => {
    const send = vi.fn();
    const control = new BrowserUseControl(send);
    const signal = new AbortController().signal;
    await expect(control.allowed(scope, signal)).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
    control.setFeatures({ browserUse: { apiVersion: 1 } });
    const first = control.allowed(scope, signal);
    const second = control.allowed({ ...scope, userId: 8 }, signal);
    const one = send.mock.calls[0]![0];
    const two = send.mock.calls[1]![0];
    expect(one).toMatchObject({ type: 'browser.use.check', payload: scope });
    control.handle(createEnvelope('browser.use.result', { enabled: false }, { replyTo: two.id }));
    control.handle(createEnvelope('browser.use.result', { enabled: true }, { replyTo: one.id }));
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(false);
  });

  it('fails closed on cancellation or a disconnected account authority', async () => {
    const control = new BrowserUseControl(vi.fn());
    control.setFeatures({ browserUse: { apiVersion: 1 } });
    const cancellation = new AbortController();
    const aborted = control.allowed(scope, cancellation.signal);
    cancellation.abort();
    await expect(aborted).resolves.toBe(false);
    const signal = new AbortController().signal;
    const disconnected = control.allowed(scope, signal);
    control.disconnect();
    await expect(disconnected).resolves.toBe(false);
    await expect(control.allowed(scope, signal)).resolves.toBe(false);
  });
});

it('publishes a model-compatible shared tool for access and tab selection, not page commands', async () => {
  const execute = vi.fn().mockResolvedValue({ content: 'current page' });
  const extensions = createBrowserUseExtensions({
    runId: 'execution-a',
    cliScope: 'a'.repeat(32),
    execute
  });
  const [definition] = extensions.tools!;
  expect(extensions.environment?.['PLAYWRIGHT_CLI_SESSION']).toBe('mar-execution-a');
  expect(extensions.skills?.[0]).toMatchObject({
    name: 'mar-browser-use',
    requiredTools: ['exec', 'mar_browser']
  });
  expect(definition).toMatchObject({
    name: 'mar_browser',
    allowedCallers: ['direct'],
    inputSchema: { type: 'object', required: ['command'], additionalProperties: false }
  });
  const signal = new AbortController().signal;
  const context = {
    mode: 'run',
    sessionId: 'session-a',
    executionId: 'execution-a',
    signal
  } as const;
  const invoke = (command: unknown) =>
    extensions.executeTool!({ name: definition!.name, arguments: { command } }, context);
  await expect(invoke({ action: 'cdp', method: 'Browser.getVersion' })).rejects.toMatchObject({
    code: 'MAR_AGENT_TOOL_INPUT_INVALID'
  });
  expect(execute).not.toHaveBeenCalled();
  await expect(invoke({ action: 'describe' })).resolves.toEqual({ content: 'current page' });
  expect(execute).toHaveBeenCalledWith({ action: 'describe' }, signal);
  execute.mockRejectedValueOnce(new Error('BROWSER_USE_HUMAN_CONTROL'));
  await expect(invoke({ action: 'acquire' })).rejects.toMatchObject({
    code: 'BROWSER_USE_HUMAN_CONTROL'
  });
  execute.mockRejectedValueOnce(new Error('BROWSER_USE_NOT_ATTACHED'));
  await expect(
    invoke({ action: 'select', tabId: 'c102fe42-e5ac-47ee-abf4-ed84ce4f3b83' })
  ).rejects.toMatchObject({
    code: 'BROWSER_USE_NOT_ATTACHED'
  });
});

it('exposes mar_browser and its skill through the execution Host only while bound', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mar-browser-host-'));
  const host = new LocalAgentHost({ homeDirectory: directory, workspace: directory });
  const execute = vi.fn().mockResolvedValue({ content: 'shared page' });
  const context = { sessionId: 'session-a', executionId: 'execution-a', claimExecutionScope: true };
  const binding = host.bindExecutionExtensions(
    createBrowserUseExtensions({ runId: context.executionId, cliScope: 'b'.repeat(32), execute })
  );
  try {
    const { skills, tools } = await host.listExecutionExtensions(context);
    expect(tools?.map(({ name }) => name)).toContain('mar_browser');
    expect(skills?.find(({ name }) => name === 'mar-browser-use')?.requiredTools).toEqual([
      'exec',
      'mar_browser'
    ]);
    const signal = new AbortController().signal;
    await expect(
      host.executeTool(
        { name: 'mar_browser', arguments: { command: { action: 'describe' } } },
        { ...context, mode: 'run', signal }
      )
    ).resolves.toEqual({ content: 'shared page' });
    expect(execute).toHaveBeenCalledWith({ action: 'describe' }, signal);
    host.unbindExecutionMcp(binding);
    const next = await host.listExecutionExtensions({ ...context, executionId: 'execution-b' });
    expect(next.tools?.some(({ name }) => name === 'mar_browser') ?? false).toBe(false);
    expect(next.skills?.some(({ name }) => name === 'mar-browser-use') ?? false).toBe(false);
  } finally {
    host.unbindExecutionMcp(binding);
    await host.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
