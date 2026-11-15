import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalAgentHost } from '../../src/host/local-agent-host.js';
import { codeModeToolDefinition } from '../../src/tools/code-mode/index.js';
import { normalizeToolInput } from '../../src/tools/input.js';
import { textToolInputError } from '../../src/tools/shared/text-input.js';
import {
  applyPatchToolDefinition,
  applyPatchToolInput
} from '../../src/tools/local/apply-patch.js';
import type { ToolExecutionContext } from '../../src/sdk/types.js';
import {
  answer,
  call,
  cleanupCoreFixtures,
  fixture as coreFixture
} from './support/core-extension-fixture.js';

const roots: string[] = [];
const hosts: LocalAgentHost[] = [];
afterEach(async () => {
  await cleanupCoreFixtures();
  await Promise.all(hosts.splice(0).map((host) => host.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'mar-text-input-'));
  roots.push(home);
  const workspace = join(home, 'workspace');
  await mkdir(workspace);
  const host = new LocalAgentHost({ homeDirectory: home, workspace });
  hosts.push(host);
  const context: ToolExecutionContext = {
    sessionId: 'text-input-session',
    executionId: 'text-input-execution',
    mode: 'run',
    signal: new AbortController().signal,
    codeMode: { tools: [], invoke: async () => ({ content: '' }) }
  };
  context.codeMode = {
    tools: [applyPatchToolDefinition],
    invoke: (call, signal) => host.executeTool(call, { ...context, signal })
  };
  return { host, workspace, context };
}

describe('freeform tool JSON input contracts', () => {
  it('declares input for patches and code for JavaScript without changing freeform transport', () => {
    expect(applyPatchToolDefinition.inputMode).toBe('freeform');
    expect(applyPatchToolDefinition.inputSchema).toMatchObject({
      properties: { input: { type: 'string', description: expect.any(String) } },
      required: ['input'],
      additionalProperties: false
    });
    expect(applyPatchToolDefinition.inputSchema.properties).not.toHaveProperty('patch');
    expect(codeModeToolDefinition.inputMode).toBe('freeform');
    expect(codeModeToolDefinition.inputSchema).toMatchObject({
      properties: { code: { type: 'string', description: expect.any(String) } },
      required: ['code'],
      additionalProperties: false
    });
  });

  it.each([false, true])('executes the input-wrapped patch with Code Mode=%s', async (codeMode) => {
    const { host, workspace, context } = await fixture();
    const patch =
      '*** Begin Patch\n*** Add File: output.txt\n+literal ${value} 中文😀\n*** End Patch';
    const arguments_ = { input: patch };
    await host.executeTool(
      codeMode
        ? {
            name: 'code_exec',
            arguments: {
              code: `observe.result(await tools.apply_patch(${JSON.stringify(arguments_)}));`
            }
          }
        : { name: 'apply_patch', arguments: arguments_ },
      context
    );
    expect(await readFile(join(workspace, 'output.txt'), 'utf8')).toBe('literal ${value} 中文😀\n');
    expect(applyPatchToolInput(patch)).toBe(patch);
  });

  it('rejects the old patch field without exposing its contents or writing files', async () => {
    const { host, workspace, context } = await fixture();
    const patch = '*** Begin Patch\n*** Add File: rejected.txt\n+private-value\n*** End Patch';
    await expect(
      host.executeTool({ name: 'apply_patch', arguments: { patch } }, context)
    ).rejects.toMatchObject({
      code: 'MAR_AGENT_TOOL_INPUT_INVALID',
      publicMessage: 'Missing required string field "input".'
    });
    expect(await readdir(workspace)).toEqual([]);
  });

  it.each(['command', 'cmd', 'input', 'arbitrary_future_field'])(
    'reports the missing code field when given %s without running its source',
    async (field) => {
      const { host, workspace, context } = await fixture();
      const source = 'await tools.apply_patch({input:"private-value"});';
      await expect(
        host.executeTool({ name: 'code_exec', arguments: { [field]: source } }, context)
      ).rejects.toMatchObject({
        code: 'MAR_AGENT_TOOL_INPUT_INVALID',
        publicMessage: 'Missing required string field "code".'
      });
      expect(await readdir(workspace)).toEqual([]);
    }
  );

  it.each([
    [null, 'null'],
    [[], 'array'],
    [42, 'number'],
    [false, 'boolean'],
    [{ secret: 'private-value' }, 'object']
  ])('reports the declared field type without echoing %j', (value, type) => {
    expect(
      textToolInputError('payload', { payload: value, unrelated: 'private-value' })
    ).toMatchObject({
      code: 'MAR_AGENT_TOOL_INPUT_INVALID',
      publicMessage: `Expected string field "payload"; received ${type}.`
    });
  });

  it.each([
    [null, 'null'],
    [undefined, 'undefined'],
    [[], 'array'],
    [42, 'number']
  ])('reports an invalid root type without coercing %j', (value, type) => {
    expect(textToolInputError('payload', value)).toMatchObject({
      code: 'MAR_AGENT_TOOL_INPUT_INVALID',
      publicMessage: `Expected a string or an object with string field "payload"; received ${type}.`
    });
  });

  it.each([
    ['code_exec', 'code'],
    ['apply_patch', 'input']
  ])('keeps declared-field type errors actionable through %s', async (name, field) => {
    const { host, workspace, context } = await fixture();
    await expect(
      host.executeTool({ name, arguments: { [field]: 42, unknown: 'private-value' } }, context)
    ).rejects.toMatchObject({
      code: 'MAR_AGENT_TOOL_INPUT_INVALID',
      publicMessage: `Expected string field "${field}"; received number.`
    });
    expect(await readdir(workspace)).toEqual([]);
  });

  it('does not copy unknown field names or argument values into diagnostics', () => {
    const arguments_ = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [
        `field-${index}-${'x'.repeat(100)}`,
        'private-value'
      ])
    );
    try {
      applyPatchToolInput(arguments_);
      throw new Error('Expected invalid input.');
    } catch (error) {
      expect(error).toMatchObject({ code: 'MAR_AGENT_TOOL_INPUT_INVALID' });
      const message = (error as Error).message;
      expect(message.length).toBeLessThan(800);
      expect(message).not.toContain('private-value');
      expect(message).not.toContain('field-');
    }
  });

  it('makes normalized input behave like the same plain input without hidden diagnostic provenance', async () => {
    const { host, context } = await fixture();
    const normalized = normalizeToolInput(
      { command: 'private-value' },
      codeModeToolDefinition.inputSchema
    );
    expect(JSON.stringify(normalized)).toBe('{}');
    for (const arguments_ of [
      normalized,
      {},
      normalizeToolInput(normalized, codeModeToolDefinition.inputSchema)
    ])
      await expect(
        host.executeTool({ name: 'code_exec', arguments: arguments_ }, context)
      ).rejects.toMatchObject({
        publicMessage: 'Missing required string field "code".'
      });
  });

  it('returns actionable field diagnostics to the model without echoing the rejected source', async () => {
    const { session, adapter } = await coreFixture(
      [],
      (_request, index) =>
        index === 0 ? call('code_exec', { command: 'observe.text("private-value");' }) : answer(),
      true,
      true
    );
    expect(await session.run({ prompt: 'Run the code.' }).result()).toMatchObject({
      status: 'completed'
    });
    const feedback = adapter.requests[1]!.messages.find(
      (message) => message.role === 'tool' && message.callId === 'call'
    )?.content;
    expect(JSON.parse(feedback as string)).toMatchObject({
      error: 'MAR_AGENT_TOOL_INPUT_INVALID',
      message: 'Missing required string field "code".'
    });
    expect(feedback).not.toContain('private-value');
  });

  it('executes the documented JSON Code Exec example unchanged', async () => {
    const { host, context } = await fixture();
    const example = /JSON input example: `([^`]+)`/u.exec(codeModeToolDefinition.description)?.[1];
    expect(example).toBeDefined();
    const result = await host.executeTool(
      { name: 'code_exec', arguments: JSON.parse(example!) },
      context
    );
    expect(result.data).toMatchObject({ status: 'completed', output: '1' });
  });
});
