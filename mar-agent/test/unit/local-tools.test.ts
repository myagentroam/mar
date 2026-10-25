import { chmod, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ok } from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalAgentHost, MarAgentError, type LocalProcessSpawnRequest } from '../../src/index.js';
import { LocalWorkspaceTools } from '../../src/agent-core/tools/local/workspace-tools.js';
import { directLocalProcessExecutor } from '../../src/agent-core/host/local-process-executor.js';
import { AGENT_EXECUTION_POLICY } from '../../src/agent-core/runtime/execution-policy.js';
import { modelTokenBudgetBytes } from '../../src/agent-core/runtime/token-budget.js';
import { TOOL_EXECUTION_LIMITS } from '../../src/agent-core/tools/execution-limits.js';
import { ExecTool, execToolDefinition } from '../../src/agent-core/tools/local/exec.js';
import {
  ApplyPatchTool,
  applyPatchToolInput
} from '../../src/agent-core/tools/local/apply-patch.js';
import { readToolDefinition } from '../../src/agent-core/tools/local/read.js';
import { parseReadContextOutput } from '../../src/agent-core/tools/local/read-context.js';
import { viewImageToolDefinition } from '../../src/agent-core/tools/local/view-image.js';
import {
  AGENT_TOOL_HANDLERS,
  BUILTIN_TOOL_DEFINITIONS
} from '../../src/agent-core/tools/registry.js';
import { WorkspacePathResolver } from '../../src/agent-core/tools/shared/path-resolver.js';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mar-agent-tools-'));
  roots.push(root);
  return { root, tools: new LocalWorkspaceTools(root) };
}

async function readdirWithoutTemporaryFiles(root: string) {
  return (await readdir(root)).filter((name) => !name.includes('.mar-patch-'));
}

async function readOne(
  tools: LocalWorkspaceTools,
  input: { path: string; offset?: number; limit?: number }
) {
  const result = await tools.read({ reads: [input] });
  return result.results[0];
}

function parseReadOutput(content: string) {
  const parsed = parseReadContextOutput(content);
  expect(parsed, content).toBeDefined();
  return parsed!;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeChild() {
  const state = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null
  });
  return { state, child: state as unknown as ChildProcessWithoutNullStreams };
}

describe('local workspace tools', () => {
  it('uses one execution-limit source for model schemas and local enforcement', () => {
    const readSchemaProperties = readToolDefinition.inputSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    const reads = readSchemaProperties.reads;
    ok(reads, 'The read schema must define its reads property.');
    const readLimit = (
      (reads.items as Record<string, unknown>).properties as Record<string, Record<string, unknown>>
    ).limit;
    const execProperties = execToolDefinition.inputSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(readLimit?.maximum).toBe(TOOL_EXECUTION_LIMITS.readMaxLines);
    expect(reads?.maxItems).toBe(TOOL_EXECUTION_LIMITS.readMaxBatchItems);
    expect(readToolDefinition.inputSchema.required).toEqual(['reads']);
    expect(readToolDefinition.description).toContain('<metadata> with path');
    expect(readToolDefinition.description).toContain('nextOffset');
    expect(execProperties.timeoutMs?.maximum).toBe(TOOL_EXECUTION_LIMITS.execMaxTimeoutMs);
    expect(execProperties.yieldMs?.default).toBe(TOOL_EXECUTION_LIMITS.execDefaultYieldMs);
    expect(execProperties.yieldMs?.maximum).toBe(30_000);
    expect(execProperties.yieldMs?.description).toContain('Defaults to 10000 ms');
    expect(execToolDefinition.inputSchema.required).toEqual(['command']);
    expect(execProperties.action).toBeUndefined();
    expect(TOOL_EXECUTION_LIMITS.execDefaultYieldMs).toBe(10_000);
    expect(TOOL_EXECUTION_LIMITS.execMaxYieldMs).toBe(30_000);
    expect(viewImageToolDefinition.description).toContain(
      `${TOOL_EXECUTION_LIMITS.viewImageMaxBytes}`
    );
  });

  it('registers every built-in tool once and keeps agent handlers explicit', () => {
    const names = BUILTIN_TOOL_DEFINITIONS.map((tool) => tool.name);
    const todoRead = BUILTIN_TOOL_DEFINITIONS.find((tool) => tool.name === 'todo_read')!;
    const todoWrite = BUILTIN_TOOL_DEFINITIONS.find((tool) => tool.name === 'todo_write')!;
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([
      'skill',
      'tool_search',
      'read',
      'view_image',
      'exec',
      'exec_wait',
      'code_exec',
      'code_exec_wait',
      'apply_patch',
      'question',
      'todo_read',
      'todo_write',
      'agent_start',
      'agent_wait',
      'agent_message',
      'agent_cancel',
      'smart_compact'
    ]);
    expect([...AGENT_TOOL_HANDLERS.keys()]).toEqual([
      'skill',
      'smart_compact',
      'tool_search',
      'question',
      'todo_read',
      'todo_write',
      'agent_start',
      'agent_wait',
      'agent_message',
      'agent_cancel'
    ]);
    expect(todoRead.description).toContain(
      'Do not read an empty or new Todo merely to decide whether straightforward bounded work needs one.'
    );
    expect(todoWrite.description).toContain(
      'Use only after Todo has been chosen for coordination-heavy work'
    );
    expect(todoWrite.description).toContain('straightforward bounded work does not need it');
    expect(todoWrite.description).toContain('after meaningful stage changes');
    expect(todoWrite.description).toContain('same model response');
    expect(todoWrite.description).toContain('only for Todo bookkeeping');
  });

  it('reads a validated image as transient multimodal content without exposing base64 in data', async () => {
    const { root } = await fixture();
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64'
    );
    const sha256 = createHash('sha256').update(png).digest('hex');
    await writeFile(join(root, 'pixel.bin'), png);
    const host = new LocalAgentHost({ homeDirectory: join(root, 'home'), workspace: root });
    const output = await host.executeTool(
      { name: 'view_image', arguments: { path: 'pixel.bin' } },
      {
        mode: 'run',
        signal: new AbortController().signal,
        sessionId: 'direct-session',
        executionId: 'direct-execution'
      }
    );
    expect(output).toMatchObject({
      content: expect.stringContaining('image/png'),
      images: [{ mimeType: 'image/png', dataBase64: png.toString('base64') }],
      data: {
        path: 'pixel.bin',
        mimeType: 'image/png',
        bytes: png.byteLength,
        sha256
      }
    });
    expect(output.content).not.toContain('sha256');
    expect(output.content).not.toContain(sha256);
    expect(JSON.stringify(output.data)).not.toContain(png.toString('base64'));
    await host.dispose();
  });

  it('rejects unsupported and oversized image files', async () => {
    const { root } = await fixture();
    await writeFile(join(root, 'text.png'), 'not an image');
    await writeFile(
      join(root, 'large.png'),
      Buffer.alloc(TOOL_EXECUTION_LIMITS.viewImageMaxBytes + 1)
    );
    const host = new LocalAgentHost({ homeDirectory: join(root, 'home'), workspace: root });
    await expect(
      host.executeTool(
        { name: 'view_image', arguments: { path: 'text.png' } },
        {
          mode: 'run',
          signal: new AbortController().signal,
          sessionId: 'direct-session',
          executionId: 'direct-execution'
        }
      )
    ).rejects.toMatchObject({ code: 'MAR_AGENT_IMAGE_FORMAT_UNSUPPORTED' });
    await expect(
      host.executeTool(
        { name: 'view_image', arguments: { path: 'large.png' } },
        {
          mode: 'run',
          signal: new AbortController().signal,
          sessionId: 'direct-session',
          executionId: 'direct-execution'
        }
      )
    ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_OUTPUT_LIMIT' });
    await host.dispose();
  });

  it('reads bounded numbered text through relative and absolute paths', async () => {
    const { root, tools } = await fixture();
    await writeFile(join(root, 'a.txt'), 'one\ntwo\nthree\n');
    expect(await readOne(tools, { path: 'a.txt', offset: 2, limit: 1 })).toMatchObject({
      content: '2\ttwo',
      truncated: true,
      nextOffset: 3
    });
    const outside = await mkdtemp(join(tmpdir(), 'mar-agent-absolute-'));
    roots.push(outside);
    const absolute = join(outside, 'outside.txt');
    await writeFile(absolute, 'absolute\n');
    await expect(readOne(tools, { path: absolute })).resolves.toMatchObject({
      content: '1\tabsolute'
    });
  });

  it('returns pagination metadata in model-visible content', async () => {
    const { root } = await fixture();
    await writeFile(join(root, 'paged.txt'), 'one & <two>\ntwo\nthree\n');
    const host = new LocalAgentHost({ homeDirectory: join(root, 'home'), workspace: root });
    const output = await host.executeTool(
      { name: 'read', arguments: { reads: [{ path: 'paged.txt', offset: 1, limit: 2 }] } },
      {
        mode: 'run',
        signal: new AbortController().signal,
        sessionId: 'direct-session',
        executionId: 'direct-execution'
      }
    );
    expect(output.content).toContain('<mar_read_result index="0" path="paged.txt">');
    expect(output.content).toContain('<content>1\tone &amp; &lt;two&gt;\n2\ttwo</content>');
    expect(output.content).toContain('<metadata path="paged.txt"');
    expect(parseReadOutput(output.content).items[0]).toMatchObject({
      index: 0,
      path: 'paged.txt',
      content: '1\tone & <two>\n2\ttwo',
      metadata: {
        path: 'paged.txt',
        encoding: 'utf-8',
        newline: 'lf',
        startLine: 1,
        endLine: 2,
        eof: false,
        truncated: true,
        nextOffset: 3,
        previewComplete: true
      }
    });
    expect((output.data as { results: Array<{ text: string }> }).results[0]?.text).toBe(
      'one & <two>\ntwo\n'
    );
    await host.dispose();
  });

  it('reads multiple files through one tool call while preserving order and item errors', async () => {
    const { root } = await fixture();
    await writeFile(join(root, 'a.txt'), 'alpha\n');
    await writeFile(join(root, 'b.txt'), 'bravo\ncharlie\n');
    const host = new LocalAgentHost({ homeDirectory: join(root, 'home'), workspace: root });
    const output = await host.executeTool(
      {
        name: 'read',
        arguments: {
          reads: [
            { path: 'b.txt', offset: 2 },
            { path: 'missing.txt' },
            { path: 'a.txt' },
            { path: 'a.txt' }
          ]
        }
      },
      {
        mode: 'run',
        signal: new AbortController().signal,
        sessionId: 'direct-session',
        executionId: 'direct-execution'
      }
    );
    expect(output.content).toContain('<mar_read_result index="0" path="b.txt">');
    expect(output.content).toContain('<mar_read_error index="1" path="missing.txt"');
    expect(output.content.indexOf('path="b.txt"')).toBeLessThan(
      output.content.indexOf('path="a.txt"')
    );
    expect(output.data).toMatchObject({ mode: 'batch' });
    const data = output.data as { results: unknown[] };
    expect(data.results[0]).toMatchObject({ path: 'b.txt' });
    expect(data.results[2]).toBe(data.results[3]);
    expect(
      parseReadOutput(output.content).items.map(({ index, path, content }) => ({
        index,
        path,
        content
      }))
    ).toEqual([
      { index: 0, path: 'b.txt', content: '2\tcharlie' },
      { index: 2, path: 'a.txt', content: '1\talpha' },
      { index: 3, path: 'a.txt', content: '1\talpha' }
    ]);
    await host.dispose();
  });

  it('maps canonical and compatibility workspace aliases with shared writable overlays', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-agent-logical-mounts-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    const inbox = join(root, 'inbox');
    const output = join(root, 'output');
    const sourceAlias = '/home/source/workspace';
    const { mkdir } = await import('node:fs/promises');
    await Promise.all([workspace, inbox, output].map((directory) => mkdir(directory)));
    await writeFile(join(workspace, 'AGENTS.md'), 'workspace instructions\n');
    await writeFile(join(inbox, 'input.txt'), 'upload\n');
    const host = new LocalAgentHost({
      homeDirectory: join(root, 'home'),
      workspace,
      workspaceWritable: false,
      restrictPaths: true,
      pathMounts: [
        { logicalPath: '/workspace', physicalPath: workspace, writable: false },
        { logicalPath: '/workspace/inbox', physicalPath: inbox, writable: true },
        { logicalPath: '/workspace/output', physicalPath: output, writable: true },
        { logicalPath: sourceAlias, physicalPath: workspace, writable: false },
        { logicalPath: `${sourceAlias}/inbox`, physicalPath: inbox, writable: true },
        { logicalPath: `${sourceAlias}/output`, physicalPath: output, writable: true }
      ]
    });

    await expect(
      host.executeTool(
        {
          name: 'read',
          arguments: {
            reads: [
              { path: 'AGENTS.md' },
              { path: '/workspace/AGENTS.md' },
              { path: `${sourceAlias}/AGENTS.md` },
              { path: 'inbox/input.txt' },
              { path: '/workspace/inbox/input.txt' },
              { path: `${sourceAlias}/inbox/input.txt` }
            ]
          }
        },
        {
          mode: 'run',
          signal: new AbortController().signal,
          sessionId: 'hosted-session',
          executionId: 'hosted-execution'
        }
      )
    ).resolves.toMatchObject({
      data: {
        results: [
          { content: '1\tworkspace instructions' },
          { content: '1\tworkspace instructions' },
          { content: '1\tworkspace instructions' },
          { content: '1\tupload' },
          { content: '1\tupload' },
          { content: '1\tupload' }
        ]
      }
    });
    await expect(
      host.executeTool(
        {
          name: 'apply_patch',
          arguments: `*** Begin Patch\n*** Add File: /workspace/output/result.txt\n+done\n*** End Patch`
        },
        {
          mode: 'run',
          signal: new AbortController().signal,
          sessionId: 'hosted-session',
          executionId: 'hosted-execution'
        }
      )
    ).resolves.toMatchObject({ data: { files: [{ path: '/workspace/output/result.txt' }] } });
    await expect(readFile(join(output, 'result.txt'), 'utf8')).resolves.toBe('done\n');
    await expect(
      host.executeTool(
        {
          name: 'apply_patch',
          arguments: `*** Begin Patch\n*** Add File: ${sourceAlias}/output/alias.txt\n+alias\n*** End Patch`
        },
        {
          mode: 'run',
          signal: new AbortController().signal,
          sessionId: 'hosted-session',
          executionId: 'hosted-execution'
        }
      )
    ).resolves.toMatchObject({
      data: { files: [{ path: `${sourceAlias}/output/alias.txt` }] }
    });
    await expect(readFile(join(output, 'alias.txt'), 'utf8')).resolves.toBe('alias\n');
    await expect(
      host.executeTool(
        {
          name: 'apply_patch',
          arguments: `*** Begin Patch\n*** Add File: output/relative.txt\n+relative\n*** End Patch`
        },
        {
          mode: 'run',
          signal: new AbortController().signal,
          sessionId: 'hosted-session',
          executionId: 'hosted-execution'
        }
      )
    ).resolves.toMatchObject({ data: { files: [{ path: 'output/relative.txt' }] } });
    await expect(readFile(join(output, 'relative.txt'), 'utf8')).resolves.toBe('relative\n');
    await expect(
      host.executeTool(
        {
          name: 'apply_patch',
          arguments: `*** Begin Patch\n*** Update File: AGENTS.md\n@@\n-workspace instructions\n+changed\n*** End Patch`
        },
        {
          mode: 'run',
          signal: new AbortController().signal,
          sessionId: 'hosted-session',
          executionId: 'hosted-execution'
        }
      )
    ).rejects.toMatchObject({ code: 'MAR_AGENT_FILE_ACCESS_DENIED' });
    await expect(
      host.executeTool(
        {
          name: 'apply_patch',
          arguments: `*** Begin Patch\n*** Add File: /workspace/new.txt\n+blocked\n*** End Patch`
        },
        {
          mode: 'run',
          signal: new AbortController().signal,
          sessionId: 'hosted-session',
          executionId: 'hosted-execution'
        }
      )
    ).rejects.toMatchObject({ code: 'MAR_AGENT_FILE_ACCESS_DENIED' });
    await expect(
      host.executeTool(
        { name: 'read', arguments: { reads: [{ path: '/etc/passwd' }] } },
        {
          mode: 'run',
          signal: new AbortController().signal,
          sessionId: 'hosted-session',
          executionId: 'hosted-execution'
        }
      )
    ).resolves.toMatchObject({
      data: { results: [{ error: { code: 'MAR_AGENT_FILE_ACCESS_DENIED' } }] }
    });
    await host.dispose();
    expect(
      () =>
        new LocalAgentHost({
          homeDirectory: join(root, 'conflicting-home'),
          workspace,
          workspaceWritable: false,
          restrictPaths: true,
          pathMounts: [
            { logicalPath: '/workspace', physicalPath: workspace, writable: false },
            { logicalPath: sourceAlias, physicalPath: workspace, writable: true }
          ]
        })
    ).toThrowError('Logical aliases for one physical path must use the same access mode.');
  });

  it('keeps web tools out of the default Host and supports generic extensions', async () => {
    const { root } = await fixture();
    const offline = new LocalAgentHost({
      homeDirectory: join(root, 'offline-home'),
      workspace: root
    });
    try {
      const description = await offline.describe();
      expect(description.capabilities.some((capability) => capability.startsWith('web.'))).toBe(
        false
      );
      await expect(
        offline.listExecutionExtensions?.({
          sessionId: 'offline-session',
          executionId: 'offline-execution',
          claimExecutionScope: true
        })
      ).resolves.not.toHaveProperty('tools');
    } finally {
      await offline.dispose();
    }

    const executeTool = vi.fn(async () => ({ content: 'HOST_EXTENSION_OK' }));
    const hosted = new LocalAgentHost({
      homeDirectory: join(root, 'hosted-home'),
      workspace: root,
      extensions: {
        tools: [{ name: 'host_action', description: 'Host action.', inputSchema: {} }],
        executeTool
      }
    });
    try {
      const context = {
        mode: 'run' as const,
        signal: new AbortController().signal,
        sessionId: 'hosted-session',
        executionId: 'hosted-execution'
      };
      await expect(
        hosted.executeTool({ name: 'host_action', arguments: { value: 1 } }, context)
      ).resolves.toEqual({
        content: 'HOST_EXTENSION_OK'
      });
      expect(executeTool).toHaveBeenCalledWith(
        { name: 'host_action', arguments: { value: 1 } },
        context
      );
    } finally {
      await hosted.dispose();
    }
  });

  it('rejects ambiguous or oversized batch read input', async () => {
    const { tools } = await fixture();
    await expect(tools.read({ path: 'a.txt', reads: [{ path: 'a.txt' }] })).rejects.toMatchObject({
      code: 'MAR_AGENT_TOOL_INPUT_INVALID'
    });
    await expect(
      tools.read({
        reads: Array.from({ length: TOOL_EXECUTION_LIMITS.readMaxBatchItems + 1 }, () => ({
          path: 'a.txt'
        }))
      })
    ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_INPUT_INVALID' });
  });

  it.each([
    { request: { path: 'a.txt', offset: 0 }, field: 'offset', expected: 'an integer >= 1' },
    {
      request: { path: 'a.txt', limit: 'private-value' },
      field: 'limit',
      expected: 'an integer >= 1'
    },
    { request: { path: '' }, field: 'path', expected: 'a non-empty string' }
  ])(
    'identifies the invalid batch read $field without echoing values',
    async ({ request, field, expected }) => {
      const { tools } = await fixture();
      const failure = await tools
        .read({ reads: [{ path: 'first.txt' }, request] })
        .catch((error) => error);
      expect(failure).toMatchObject({
        code: 'MAR_AGENT_TOOL_INPUT_INVALID',
        message: expect.stringContaining(`reads[1].${field}: expected ${expected}.`)
      });
      expect(failure.message).not.toContain('private-value');
    }
  );

  it('explains the batch read envelope and size constraints', async () => {
    const { tools } = await fixture();
    await expect(tools.read({ path: 'private-value' })).rejects.toMatchObject({
      code: 'MAR_AGENT_TOOL_INPUT_INVALID',
      message: expect.stringContaining('reads: expected an array of 1 to 16 requests')
    });
    await expect(tools.read({ reads: [] })).rejects.toMatchObject({
      code: 'MAR_AGENT_TOOL_INPUT_INVALID',
      message: expect.stringContaining('reads: expected an array of 1 to 16 requests')
    });
  });

  it('shares the model-visible output budget across every batch read item', async () => {
    const { root } = await fixture();
    const paths = Array.from({ length: 5 }, (_, index) => `budget-${index}.txt`);
    await Promise.all(
      paths.map((path) => writeFile(join(root, path), `${'x'.repeat(1000)}\n`.repeat(2000)))
    );
    const host = new LocalAgentHost({ homeDirectory: join(root, 'home'), workspace: root });
    const output = await host.executeTool(
      { name: 'read', arguments: { reads: paths.map((path) => ({ path, limit: 2000 })) } },
      {
        mode: 'run',
        signal: new AbortController().signal,
        sessionId: 'direct-session',
        executionId: 'direct-execution'
      }
    );
    expect(Buffer.byteLength(output.content)).toBeLessThanOrEqual(
      modelTokenBudgetBytes(AGENT_EXECUTION_POLICY.modelToolOutputTokens)
    );
    expect(output.truncated).toBe(true);
    const items = parseReadOutput(output.content).items;
    expect(items).toHaveLength(paths.length);
    for (const [index, path] of paths.entries()) {
      expect(items.find((item) => item.index === index && item.path === path)).toMatchObject({
        index,
        path,
        metadata: {
          path,
          truncated: true,
          nextOffset: expect.any(Number),
          previewComplete: false
        }
      });
    }
    expect(output.content).not.toContain('tokens of tool output omitted');
    await host.dispose();
  });

  it('reuses model-visible budget left by short batch read items', async () => {
    const { root } = await fixture();
    await writeFile(join(root, 'short.txt'), 'short\n');
    await writeFile(join(root, 'long-a.txt'), `${'a'.repeat(500)}\n`.repeat(2000));
    await writeFile(join(root, 'long-b.txt'), `${'b'.repeat(500)}\n`.repeat(2000));
    const host = new LocalAgentHost({ homeDirectory: join(root, 'home'), workspace: root });
    const output = await host.executeTool(
      {
        name: 'read',
        arguments: {
          reads: [
            { path: 'short.txt' },
            { path: 'long-a.txt', limit: 2000 },
            { path: 'long-b.txt', limit: 2000 }
          ]
        }
      },
      {
        mode: 'run',
        signal: new AbortController().signal,
        sessionId: 'direct-session',
        executionId: 'direct-execution'
      }
    );
    expect(Buffer.byteLength(output.content)).toBeLessThanOrEqual(
      modelTokenBudgetBytes(AGENT_EXECUTION_POLICY.modelToolOutputTokens)
    );
    const items = parseReadOutput(output.content).items;
    expect(items[0]).toMatchObject({
      index: 0,
      path: 'short.txt',
      content: '1\tshort',
      metadata: {
        path: 'short.txt',
        encoding: 'utf-8',
        newline: 'lf',
        startLine: 1,
        endLine: 1,
        eof: true,
        truncated: false,
        previewComplete: true
      }
    });
    for (const [index, path] of ['long-a.txt', 'long-b.txt'].entries()) {
      const item = items.find(
        (candidate) => candidate.index === index + 1 && candidate.path === path
      )!;
      const visibleLines = item.content.split('\n');
      const metadata = item.metadata as {
        endLine: number;
        nextOffset: number;
        previewComplete: boolean;
      };
      expect(visibleLines.length).toBeGreaterThan(1);
      expect(metadata.endLine).toBe(Number.parseInt(visibleLines.at(-1)!, 10));
      expect(metadata.nextOffset).toBe(metadata.endLine + 1);
      expect(metadata.previewComplete).toBe(false);
    }
    await host.dispose();
  });

  it('returns a UTF-8-safe head-tail preview without a false cursor for an oversized line', async () => {
    const { root } = await fixture();
    const line = `HEAD-${'🙂'.repeat(15_000)}-TAIL`;
    await writeFile(join(root, 'single-line.json'), line);
    const host = new LocalAgentHost({ homeDirectory: join(root, 'home'), workspace: root });
    const output = await host.executeTool(
      { name: 'read', arguments: { reads: [{ path: 'single-line.json', limit: 1 }] } },
      {
        mode: 'run',
        signal: new AbortController().signal,
        sessionId: 'direct-session',
        executionId: 'direct-execution'
      }
    );

    expect(Buffer.byteLength(output.content)).toBeLessThanOrEqual(
      modelTokenBudgetBytes(AGENT_EXECUTION_POLICY.modelToolOutputTokens)
    );
    expect(output.truncated).toBe(true);
    expect(output.content).toContain('1\tHEAD-');
    expect(output.content).toContain('-TAIL');
    expect(output.content).toContain('bytes omitted from line 1');
    expect(output.content).not.toContain('\ufffd');
    const item = parseReadOutput(output.content).items[0]!;
    const metadata = item.metadata as {
      nextOffset?: number;
      previewComplete: boolean;
      oversizedLine: {
        line: number;
        bytes: number;
        shownBytes: number;
        omittedBytes: number;
      };
    };
    expect(metadata).not.toHaveProperty('nextOffset');
    expect(metadata.previewComplete).toBe(false);
    expect(metadata.oversizedLine).toMatchObject({
      line: 1,
      bytes: Buffer.byteLength(line)
    });
    expect(metadata.oversizedLine.omittedBytes).toBeGreaterThan(0);
    expect(metadata.oversizedLine.shownBytes + metadata.oversizedLine.omittedBytes).toBe(
      Buffer.byteLength(line)
    );
    expect(
      (
        output.data as {
          results: Array<{ text?: string }>;
        }
      ).results[0]?.text
    ).toBe(line);
    await host.dispose();
  });

  it('preserves every batch item with an oversized-line preview under a shared budget', async () => {
    const { root } = await fixture();
    const paths = Array.from(
      { length: TOOL_EXECUTION_LIMITS.readMaxBatchItems },
      (_, index) => `single-line-${index}.json`
    );
    await Promise.all(
      paths.map((path, index) =>
        writeFile(join(root, path), `HEAD-${index}-${'🙂'.repeat(2_000)}-TAIL-${index}`)
      )
    );
    const host = new LocalAgentHost({ homeDirectory: join(root, 'home'), workspace: root });
    const output = await host.executeTool(
      { name: 'read', arguments: { reads: paths.map((path) => ({ path, limit: 1 })) } },
      {
        mode: 'run',
        signal: new AbortController().signal,
        sessionId: 'direct-session',
        executionId: 'direct-execution'
      }
    );

    expect(Buffer.byteLength(output.content)).toBeLessThanOrEqual(
      modelTokenBudgetBytes(AGENT_EXECUTION_POLICY.modelToolOutputTokens)
    );
    for (const [index, path] of paths.entries()) {
      const item = parseReadOutput(output.content).items.find(
        (candidate) => candidate.index === index && candidate.path === path
      )!;
      expect(item.content).toContain(`HEAD-${index}-`);
      expect(item.content).toContain(`-TAIL-${index}`);
      const metadata = item.metadata as {
        nextOffset?: number;
        previewComplete: boolean;
        oversizedLine?: { omittedBytes: number };
      };
      expect(metadata).not.toHaveProperty('nextOffset');
      expect(metadata.previewComplete).toBe(false);
      expect(metadata.oversizedLine?.omittedBytes).toBeGreaterThan(0);
    }
    await host.dispose();
  });

  it('preserves every item boundary when a maximum-size batch exhausts its preview budget', async () => {
    const { root } = await fixture();
    const paths = Array.from(
      { length: TOOL_EXECUTION_LIMITS.readMaxBatchItems },
      (_, index) => `maximum-batch-${index}.txt`
    );
    await Promise.all(
      paths.map((path) => writeFile(join(root, path), `${'x'.repeat(500)}\n`.repeat(2000)))
    );
    const host = new LocalAgentHost({ homeDirectory: join(root, 'home'), workspace: root });
    const output = await host.executeTool(
      { name: 'read', arguments: { reads: paths.map((path) => ({ path, limit: 2000 })) } },
      {
        mode: 'run',
        signal: new AbortController().signal,
        sessionId: 'direct-session',
        executionId: 'direct-execution'
      }
    );
    expect(Buffer.byteLength(output.content)).toBeLessThanOrEqual(
      modelTokenBudgetBytes(AGENT_EXECUTION_POLICY.modelToolOutputTokens)
    );
    const items = parseReadOutput(output.content).items;
    expect(items).toHaveLength(paths.length);
    for (const [index, path] of paths.entries()) {
      expect(items[index]).toMatchObject({
        index,
        path,
        metadata: { path, encoding: 'utf-8', newline: 'lf', startLine: 1 }
      });
    }
    expect(output.content).not.toContain('tokens of tool output omitted');
    await host.dispose();
  });

  it('bounds long error paths without dropping later batch items', async () => {
    const { root } = await fixture();
    const paths = Array.from(
      { length: TOOL_EXECUTION_LIMITS.readMaxBatchItems },
      (_, index) => `/missing-${index}-${'p'.repeat(3000)}.txt`
    );
    const host = new LocalAgentHost({ homeDirectory: join(root, 'home'), workspace: root });
    const output = await host.executeTool(
      { name: 'read', arguments: { reads: paths.map((path) => ({ path })) } },
      {
        mode: 'run',
        signal: new AbortController().signal,
        sessionId: 'direct-session',
        executionId: 'direct-execution'
      }
    );
    expect(Buffer.byteLength(output.content)).toBeLessThanOrEqual(
      modelTokenBudgetBytes(AGENT_EXECUTION_POLICY.modelToolOutputTokens)
    );
    for (const index of paths.keys()) {
      expect(output.content).toContain(`<mar_read_error index="${index}"`);
    }
    expect(output.content).toContain('pathTruncated="true"');
    await host.dispose();
  });

  it('streams a small line range from a file larger than the result byte limit', async () => {
    const { root, tools } = await fixture();
    const large = `${'padding\n'.repeat(Math.ceil(TOOL_EXECUTION_LIMITS.readMaxBytes / 8) + 10)}tail\n`;
    await writeFile(join(root, 'large.txt'), large);
    await expect(readOne(tools, { path: 'large.txt', offset: 2, limit: 2 })).resolves.toMatchObject(
      {
        content: '2\tpadding\n3\tpadding',
        truncated: true,
        nextOffset: 4
      }
    );
  });

  it('detects CRLF from the same stream beyond the first 64 KiB', async () => {
    const { root, tools } = await fixture();
    await writeFile(join(root, 'late-crlf.txt'), `${'x'.repeat(70_000)}\r\nsecond\r\n`);
    await expect(readOne(tools, { path: 'late-crlf.txt', limit: 2 })).resolves.toMatchObject({
      newline: 'crlf',
      endLine: 2,
      eof: true
    });
  });

  it('strictly reads UTF-8 BOM and BOM-declared UTF-16 text', async () => {
    const { root, tools } = await fixture();
    await writeFile(
      join(root, 'utf8-bom.txt'),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('alpha\n')])
    );
    await writeFile(
      join(root, 'utf16le.txt'),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('alpha\r\nbeta', 'utf16le')])
    );
    const utf16beBody = Buffer.from('alpha\nbeta', 'utf16le');
    utf16beBody.swap16();
    await writeFile(
      join(root, 'utf16be.txt'),
      Buffer.concat([Buffer.from([0xfe, 0xff]), utf16beBody])
    );
    const result = await tools.read({
      reads: [{ path: 'utf8-bom.txt' }, { path: 'utf16le.txt' }, { path: 'utf16be.txt' }]
    });
    expect(result.results).toEqual([
      expect.objectContaining({
        path: 'utf8-bom.txt',
        content: '1\talpha',
        encoding: 'utf-8',
        newline: 'lf'
      }),
      expect.objectContaining({
        path: 'utf16le.txt',
        content: '1\talpha\n2\tbeta',
        encoding: 'utf-16le',
        newline: 'crlf'
      }),
      expect.objectContaining({
        path: 'utf16be.txt',
        content: '1\talpha\n2\tbeta',
        encoding: 'utf-16be',
        newline: 'lf'
      })
    ]);
  });

  it('returns an item error instead of replacing invalid UTF-8 bytes', async () => {
    const { root, tools } = await fixture();
    await writeFile(join(root, 'invalid.txt'), Buffer.from([0x61, 0x0a, 0xc3, 0x28]));
    await writeFile(join(root, 'valid.txt'), 'valid\n');
    await writeFile(join(root, 'utf16-without-bom.txt'), Buffer.from('not declared', 'utf16le'));
    await expect(
      tools.read({
        reads: [{ path: 'invalid.txt' }, { path: 'utf16-without-bom.txt' }, { path: 'valid.txt' }]
      })
    ).resolves.toMatchObject({
      results: [
        {
          path: 'invalid.txt',
          error: {
            code: 'MAR_AGENT_FILE_ENCODING_INVALID',
            message: 'File contains invalid text for its declared encoding.'
          }
        },
        {
          path: 'utf16-without-bom.txt',
          error: {
            code: 'MAR_AGENT_FILE_ENCODING_INVALID',
            message: 'Text files cannot contain NUL characters; UTF-16 requires a BOM.'
          }
        },
        { path: 'valid.txt', content: '1\tvalid' }
      ]
    });
  });

  it('applies patches to absolute paths using operating-system permissions', async () => {
    const { tools } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), 'mar-agent-absolute-patch-'));
    roots.push(outside);
    const absolute = join(outside, 'absolute.txt');
    await tools.applyPatch(`*** Begin Patch\n*** Add File: ${absolute}\n+outside\n*** End Patch`);
    expect(await readFile(absolute, 'utf8')).toBe('outside\n');
  });

  it('atomically applies add, update and delete patches', async () => {
    const { root, tools } = await fixture();
    await writeFile(join(root, 'old.txt'), 'hello\nworld\n');
    const result = await tools.applyPatch(
      `*** Begin Patch\n*** Update File: old.txt\n@@\n-hello\n+hello!\n world\n*** Add File: new.txt\n+new\n*** End Patch`
    );
    expect(result.files).toEqual([
      {
        path: 'old.txt',
        operation: 'modified',
        addedLines: 1,
        deletedLines: 1
      },
      { path: 'new.txt', operation: 'added', addedLines: 1, deletedLines: 0 }
    ]);
    expect(await readFile(join(root, 'old.txt'), 'utf8')).toBe('hello!\nworld\n');
    await tools.applyPatch('*** Begin Patch\n*** Delete File: new.txt\n*** End Patch');
    await expect(readFile(join(root, 'new.txt'))).rejects.toThrow();
  });

  it('overwrites an existing file with Add File like Codex', async () => {
    const { root, tools } = await fixture();
    const target = join(root, 'existing.txt');
    await writeFile(target, 'old content\n');
    await chmod(target, 0o744);

    const result = await tools.applyPatch(
      '*** Begin Patch\n*** Add File: existing.txt\n+new content\n*** End Patch'
    );

    expect(await readFile(target, 'utf8')).toBe('new content\n');
    expect((await stat(target)).mode & 0o777).toBe(0o744);
    expect(result).toEqual({
      files: [
        {
          path: 'existing.txt',
          operation: 'added',
          addedLines: 1,
          deletedLines: 0
        }
      ],
      totals: { files: 1, addedLines: 1, deletedLines: 0 }
    });
  });

  it('uses context-only hunks as ordered anchors for later changes', async () => {
    const { root, tools } = await fixture();
    await writeFile(join(root, 'anchored.txt'), 'target\nsection\nmiddle\ntarget\n');
    const result = await tools.applyPatch(
      '*** Begin Patch\n*** Update File: anchored.txt\n@@\n section\n@@\n-target\n+updated\n*** End Patch'
    );
    expect(await readFile(join(root, 'anchored.txt'), 'utf8')).toBe(
      'target\nsection\nmiddle\nupdated\n'
    );
    expect(result).toMatchObject({
      files: [
        {
          path: 'anchored.txt',
          operation: 'modified',
          addedLines: 1,
          deletedLines: 1
        }
      ],
      totals: { files: 1, addedLines: 1, deletedLines: 1 }
    });
  });

  it.each(['before', 'after'])(
    'validates an unchanged file section %s actual changes without writing or reporting it',
    async (order) => {
      const { root } = await fixture();
      await writeFile(join(root, 'first.txt'), 'before\n');
      const unchanged = join(root, 'unchanged.txt');
      await writeFile(unchanged, '  keep  \r\n');
      const previous = await stat(unchanged);
      const renameOperation = vi.fn(rename);
      const tool = new ApplyPatchTool(new WorkspacePathResolver(root), { rename: renameOperation });
      const change = '*** Update File: first.txt\n@@\n-before\n+after';
      const validation = '*** Update File: unchanged.txt\n@@\n keep';
      const sections = order === 'before' ? [validation, change] : [change, validation];
      const result = await tool.execute(`*** Begin Patch\n${sections.join('\n')}\n*** End Patch`);
      expect(result).toEqual({
        files: [{ path: 'first.txt', operation: 'modified', addedLines: 1, deletedLines: 1 }],
        totals: { files: 1, addedLines: 1, deletedLines: 1 }
      });
      expect(await readFile(join(root, 'first.txt'), 'utf8')).toBe('after\n');
      expect(await readFile(unchanged, 'utf8')).toBe('  keep  \r\n');
      expect((await stat(unchanged)).mtimeMs).toBe(previous.mtimeMs);
      for (const [source, target] of renameOperation.mock.calls) {
        expect(source).not.toBe(unchanged);
        expect(target).not.toBe(unchanged);
      }
      expect(await readdirWithoutTemporaryFiles(root)).toEqual(['first.txt', 'unchanged.txt']);
    }
  );

  it('validates trailing context-only hunks without counting or rewriting them', async () => {
    const { root, tools } = await fixture();
    await writeFile(join(root, 'trailing.txt'), 'before\r\n  middle  \r\n  tail  \r\n');
    const result = await tools.applyPatch(
      '*** Begin Patch\n*** Update File: trailing.txt\n@@\n-before\n+after\n@@\n middle\n@@\n tail\n*** End Patch'
    );
    expect(await readFile(join(root, 'trailing.txt'), 'utf8')).toBe(
      'after\r\n  middle  \r\n  tail  \r\n'
    );
    expect(result).toMatchObject({ totals: { files: 1, addedLines: 1, deletedLines: 1 } });
  });

  it('keeps a file atomic when trailing validation fails instead of ignoring its context', async () => {
    const { root, tools } = await fixture();
    await writeFile(join(root, 'trailing.txt'), 'before\ntail\n');
    await expect(
      tools.applyPatch(
        '*** Begin Patch\n*** Update File: trailing.txt\n@@\n-before\n+after\n@@\n missing\n*** End Patch'
      )
    ).rejects.toMatchObject({
      code: 'MAR_AGENT_PATCH_CONFLICT',
      message: expect.stringContaining('hunk 2')
    });
    expect(await readFile(join(root, 'trailing.txt'), 'utf8')).toBe('before\ntail\n');
  });

  it.each(['before', 'after'])(
    'rejects invalid validation-only sections %s changes before any writes',
    async (order) => {
      const { root, tools } = await fixture();
      await writeFile(join(root, 'first.txt'), 'before\n');
      await writeFile(join(root, 'unchanged.txt'), 'keep\n');
      const change = '*** Update File: first.txt\n@@\n-before\n+after';
      const validation = '*** Update File: unchanged.txt\n@@\n missing';
      const sections = order === 'before' ? [validation, change] : [change, validation];
      await expect(
        tools.applyPatch(`*** Begin Patch\n${sections.join('\n')}\n*** End Patch`)
      ).rejects.toMatchObject({
        code: 'MAR_AGENT_PATCH_CONFLICT'
      });
      expect(await readFile(join(root, 'first.txt'), 'utf8')).toBe('before\n');
      expect(await readFile(join(root, 'unchanged.txt'), 'utf8')).toBe('keep\n');
    }
  );

  it('does not count successful validation-only sections as applied files when the first change fails', async () => {
    const { root, tools } = await fixture();
    await writeFile(join(root, 'first.txt'), 'before\n');
    await writeFile(join(root, 'unchanged.txt'), 'keep\n');
    await expect(
      tools.applyPatch(
        '*** Begin Patch\n*** Update File: unchanged.txt\n@@\n keep\n*** Update File: first.txt\n@@\n-missing\n+after\n*** End Patch'
      )
    ).rejects.toMatchObject({ code: 'MAR_AGENT_PATCH_CONFLICT' });
    expect(await readFile(join(root, 'first.txt'), 'utf8')).toBe('before\n');
    expect(await readFile(join(root, 'unchanged.txt'), 'utf8')).toBe('keep\n');
  });

  it('excludes validation-only files from partial-failure retry diagnostics', async () => {
    const { root, tools } = await fixture();
    await writeFile(join(root, 'first.txt'), 'before\n');
    await writeFile(join(root, 'unchanged.txt'), 'keep\n');
    await writeFile(join(root, 'last.txt'), 'before\n');
    await expect(
      tools.applyPatch(
        '*** Begin Patch\n*** Update File: first.txt\n@@\n-before\n+after\n*** Update File: unchanged.txt\n@@\n keep\n*** Update File: last.txt\n@@\n-missing\n+after\n*** End Patch'
      )
    ).rejects.toMatchObject({
      code: 'MAR_AGENT_PATCH_PARTIAL',
      message: expect.stringContaining('Applied: first.txt. Failed: last.txt. Pending: (none).')
    });
    expect(await readFile(join(root, 'first.txt'), 'utf8')).toBe('after\n');
    expect(await readFile(join(root, 'unchanged.txt'), 'utf8')).toBe('keep\n');
    expect(await readFile(join(root, 'last.txt'), 'utf8')).toBe('before\n');
  });

  it('uses the first ordered match after an anchor like Codex', async () => {
    const { root, tools } = await fixture();
    await writeFile(join(root, 'ambiguous-anchor.txt'), 'section\ntarget\ntarget\n');
    await tools.applyPatch(
      '*** Begin Patch\n*** Update File: ambiguous-anchor.txt\n@@\n section\n@@\n-target\n+updated\n*** End Patch'
    );
    expect(await readFile(join(root, 'ambiguous-anchor.txt'), 'utf8')).toBe(
      'section\nupdated\ntarget\n'
    );
  });

  it('uses Codex change context to disambiguate repeated update lines', async () => {
    const { root, tools } = await fixture();
    await writeFile(
      join(root, 'change-context.ts'),
      [
        'function first() {',
        '  return value;',
        '}',
        'function second() {',
        '  return value;',
        '}',
        ''
      ].join('\n')
    );
    await tools.applyPatch(
      [
        '*** Begin Patch',
        '*** Update File: change-context.ts',
        '@@ function second() {',
        '-  return value;',
        '+  return updated;',
        '*** End Patch'
      ].join('\n')
    );
    expect(await readFile(join(root, 'change-context.ts'), 'utf8')).toBe(
      [
        'function first() {',
        '  return value;',
        '}',
        'function second() {',
        '  return updated;',
        '}',
        ''
      ].join('\n')
    );
  });

  it('uses Codex whitespace and Unicode punctuation tolerance for update context', async () => {
    const { root, tools } = await fixture();
    await writeFile(join(root, 'whitespace.txt'), 'const label = \u201cvalue\u201d;   \n');
    await tools.applyPatch(
      '*** Begin Patch\n*** Update File: whitespace.txt\n@@\n-const label = "value";\n+const label = "updated";\n*** End Patch'
    );
    expect(await readFile(join(root, 'whitespace.txt'), 'utf8')).toBe('const label = "updated";\n');
  });

  it('preserves source context text when tolerant matching locates an adjacent change', async () => {
    const { root, tools } = await fixture();
    await writeFile(
      join(root, 'preserved-context.txt'),
      '\tsection \u2014 alpha   \n  const label = \u201cvalue\u201d;   \n  return before;\n'
    );
    await tools.applyPatch(
      [
        '*** Begin Patch',
        '*** Update File: preserved-context.txt',
        '@@',
        ' section - alpha',
        ' const label = "value";',
        '-  return before;',
        '+  return after;',
        '*** End Patch'
      ].join('\n')
    );
    expect(await readFile(join(root, 'preserved-context.txt'), 'utf8')).toBe(
      '\tsection \u2014 alpha   \n  const label = \u201cvalue\u201d;   \n  return after;\n'
    );
  });

  it('reports the affected path and hunk when update context is missing', async () => {
    const { root, tools } = await fixture();
    await writeFile(join(root, 'diagnostic.txt'), 'before\n');
    await expect(
      tools.applyPatch(
        '*** Begin Patch\n*** Update File: diagnostic.txt\n@@\n-missing\n+after\n*** End Patch'
      )
    ).rejects.toThrow('Patch hunk 1 could not find expected lines in diagnostic.txt');
    expect(await readFile(join(root, 'diagnostic.txt'), 'utf8')).toBe('before\n');
  });

  it('keeps earlier file units when a later hunk conflicts and reports retry scope', async () => {
    const { root, tools } = await fixture();
    await writeFile(join(root, 'a.txt'), 'a-before\n');
    await writeFile(join(root, 'b.txt'), 'b-before\n');
    await writeFile(join(root, 'c.txt'), 'c-before\n');
    const operation = tools.applyPatch(
      [
        '*** Begin Patch',
        '*** Update File: a.txt',
        '@@',
        '-a-before',
        '+a-after',
        '*** Update File: b.txt',
        '@@',
        '-missing',
        '+b-after',
        '*** Update File: c.txt',
        '@@',
        '-c-before',
        '+c-after',
        '*** End Patch'
      ].join('\n')
    );
    await expect(operation).rejects.toMatchObject({
      code: 'MAR_AGENT_PATCH_PARTIAL',
      retryable: true,
      details: {
        appliedFiles: ['a.txt'],
        failedFile: 'b.txt',
        pendingFiles: ['c.txt']
      }
    });
    await expect(operation).rejects.toThrow(
      'Applied: a.txt. Failed: b.txt. Pending: c.txt. Retry only failed and pending paths.'
    );
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('a-after\n');
    expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('b-before\n');
    expect(await readFile(join(root, 'c.txt'), 'utf8')).toBe('c-before\n');
  });

  it('keeps earlier file units and rolls back only the failing commit unit', async () => {
    const { root } = await fixture();
    await writeFile(join(root, 'a.txt'), 'a-before\n');
    await writeFile(join(root, 'b.txt'), 'b-before\n');
    let renameCount = 0;
    const patch = new ApplyPatchTool(new WorkspacePathResolver(root), {
      rename: async (source, target) => {
        renameCount++;
        if (renameCount === 4) throw new Error('injected commit failure');
        await rename(source, target);
      }
    });
    await expect(
      patch.execute(
        '*** Begin Patch\n*** Update File: a.txt\n@@\n-a-before\n+a-after\n*** Update File: b.txt\n@@\n-b-before\n+b-after\n*** End Patch'
      )
    ).rejects.toMatchObject({
      code: 'MAR_AGENT_PATCH_PARTIAL',
      details: {
        appliedFiles: ['a.txt'],
        failedFile: 'b.txt',
        pendingFiles: []
      }
    });
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('a-after\n');
    expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('b-before\n');
    expect((await readdirWithoutTemporaryFiles(root)).sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('rolls back both paths when a Move unit fails', async () => {
    const { root } = await fixture();
    await writeFile(join(root, 'source.txt'), 'source-before\n');
    await writeFile(join(root, 'target.txt'), 'target-before\n');
    let renameCount = 0;
    const patch = new ApplyPatchTool(new WorkspacePathResolver(root), {
      rename: async (source, target) => {
        renameCount++;
        if (renameCount === 3) throw new Error('injected move failure');
        await rename(source, target);
      }
    });
    await expect(
      patch.execute(
        '*** Begin Patch\n*** Update File: source.txt\n*** Move to: target.txt\n@@\n-source-before\n+source-after\n*** End Patch'
      )
    ).rejects.toThrow('injected move failure');
    expect(await readFile(join(root, 'source.txt'), 'utf8')).toBe('source-before\n');
    expect(await readFile(join(root, 'target.txt'), 'utf8')).toBe('target-before\n');
    expect((await readdirWithoutTemporaryFiles(root)).sort()).toEqual(['source.txt', 'target.txt']);
  });

  it('removes newly created empty directories when a staged add cannot commit', async () => {
    const { root } = await fixture();
    const patch = new ApplyPatchTool(new WorkspacePathResolver(root), {
      rename: async () => {
        throw new Error('injected add failure');
      }
    });
    await expect(
      patch.execute('*** Begin Patch\n*** Add File: nested/deep/file.txt\n+value\n*** End Patch')
    ).rejects.toThrow('injected add failure');
    await expect(stat(join(root, 'nested'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('moves and updates CRLF files while preserving mode and final-newline state', async () => {
    const { root, tools } = await fixture();
    const source = join(root, 'script.sh');
    await writeFile(source, 'one\r\ntwo');
    await chmod(source, 0o755);
    const result = await tools.applyPatch(
      '*** Begin Patch\n*** Update File: script.sh\n*** Move to: bin/moved.sh\n@@\n-one\n+ONE\n two\n*** End Patch'
    );
    await expect(readFile(source)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(root, 'bin', 'moved.sh'), 'utf8')).toBe('ONE\r\ntwo');
    expect((await stat(join(root, 'bin', 'moved.sh'))).mode & 0o777).toBe(0o755);
    expect(result).toMatchObject({
      files: [
        {
          operation: 'moved',
          path: 'script.sh',
          targetPath: 'bin/moved.sh',
          addedLines: 1,
          deletedLines: 1
        }
      ],
      totals: { files: 1, addedLines: 1, deletedLines: 1 }
    });
  });

  it('overwrites an existing move destination like Codex', async () => {
    const { root, tools } = await fixture();
    const source = join(root, 'source.txt');
    const target = join(root, 'target.txt');
    await writeFile(source, 'from\n');
    await chmod(source, 0o755);
    await writeFile(target, 'existing\n');
    await chmod(target, 0o640);

    const result = await tools.applyPatch(
      [
        '*** Begin Patch',
        '*** Update File: source.txt',
        '*** Move to: target.txt',
        '@@',
        '-from',
        '+moved',
        '*** End Patch'
      ].join('\n')
    );

    await expect(readFile(source)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(target, 'utf8')).toBe('moved\n');
    expect((await stat(target)).mode & 0o777).toBe(0o640);
    expect(result).toEqual({
      files: [
        {
          path: 'source.txt',
          targetPath: 'target.txt',
          operation: 'moved',
          addedLines: 1,
          deletedLines: 1
        }
      ],
      totals: { files: 1, addedLines: 1, deletedLines: 1 }
    });
  });

  it('moves an unmodified binary file byte-for-byte', async () => {
    const { root, tools } = await fixture();
    const content = Buffer.from([0, 13, 10, 255, 1, 2, 3]);
    await writeFile(join(root, 'asset.bin'), content);
    await tools.applyPatch(
      '*** Begin Patch\n*** Update File: asset.bin\n*** Move to: moved/asset.bin\n*** End Patch'
    );
    expect(await readFile(join(root, 'moved', 'asset.bin'))).toEqual(content);
  });

  it('strictly rejects malformed, unchanged, duplicate-target and oversized patches', async () => {
    const { root, tools } = await fixture();
    await writeFile(join(root, 'a.txt'), 'before\n');
    for (const patch of [
      '*** Begin Patch\n*** Update File: a.txt\n@@\n?invalid\n*** End Patch',
      '*** Begin Patch\n*** Update File: a.txt\n@@\n before\n*** End Patch',
      '*** Begin Patch\n*** Update File: a.txt\n@@\n before\n*** Update File: missing.txt\n@@\n missing\n*** End Patch',
      '*** Begin Patch\n*** Add File: new.txt\n+new\n*** Update File: a.txt\n*** End Patch',
      '*** Begin Patch\n*** Add File: same.txt\n+one\n*** Add File: same.txt\n+two\n*** End Patch',
      `*** Begin Patch\n*** Add File: huge.txt\n+${'x'.repeat(TOOL_EXECUTION_LIMITS.patchMaxBytes)}\n*** End Patch`
    ])
      await expect(tools.applyPatch(patch)).rejects.toMatchObject({
        code: expect.stringMatching(/^MAR_AGENT_(?:TOOL_INPUT_INVALID|TOOL_OUTPUT_LIMIT)$/u)
      });
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('before\n');
    await expect(readFile(join(root, 'same.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('enforces file-count and existing-file byte limits before writing', async () => {
    const { root, tools } = await fixture();
    const tooMany = Array.from(
      { length: TOOL_EXECUTION_LIMITS.patchMaxFiles + 1 },
      (_, index) => `*** Add File: generated-${index}.txt\n+value`
    ).join('\n');
    await expect(
      tools.applyPatch(`*** Begin Patch\n${tooMany}\n*** End Patch`)
    ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_OUTPUT_LIMIT' });
    expect(await readdirWithoutTemporaryFiles(root)).toEqual([]);

    await writeFile(
      join(root, 'oversized.bin'),
      Buffer.alloc(TOOL_EXECUTION_LIMITS.patchMaxFileBytes + 1)
    );
    await expect(
      tools.applyPatch('*** Begin Patch\n*** Delete File: oversized.bin\n*** End Patch')
    ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_OUTPUT_LIMIT' });
    expect((await stat(join(root, 'oversized.bin'))).size).toBe(
      TOOL_EXECUTION_LIMITS.patchMaxFileBytes + 1
    );
  });

  it('accepts the conventional trailing newline after the patch envelope', async () => {
    const { root, tools } = await fixture();
    await writeFile(join(root, 'note.txt'), 'before\n');
    await tools.applyPatch(
      '*** Begin Patch\r\n*** Update File: note.txt\r\n@@\r\n-before\r\n+after\r\n*** End Patch\r\n'
    );
    expect(await readFile(join(root, 'note.txt'), 'utf8')).toBe('after\n');
  });

  it('starts, polls and cancels cross-platform managed processes', async () => {
    const { tools } = await fixture();
    const done = await tools.exec({
      command: `${process.execPath} -e "process.stdout.write('ok')"`,
      yieldMs: 5000
    });
    expect(done).toMatchObject({ status: 'completed', stdout: 'ok', exitCode: 0 });
    await expect(tools.exec({ action: 'poll', processId: 'missing' })).rejects.toBeInstanceOf(
      MarAgentError
    );
    await tools.dispose();
  });

  it('retains a completed command result for later Session polls without occupying a running slot', async () => {
    const { root } = await fixture();
    const tool = new ExecTool(new WorkspacePathResolver(root), undefined, 1);
    const owner = { sessionId: 'session', executionId: 'first' };
    const completed = await tool.execute(
      {
        command: `${process.execPath} -e "process.stdout.write('finished'); process.stderr.write('warning')"`,
        yieldMs: 5_000
      },
      undefined,
      owner
    );
    expect(completed).toMatchObject({
      status: 'completed',
      processId: expect.any(String),
      stdout: 'finished',
      stderr: 'warning',
      exitCode: 0
    });
    expect(tool.listSessionResources('session')).toEqual([
      expect.objectContaining({ processId: completed.processId, status: 'completed' })
    ]);
    await expect(
      tool.execute({ action: 'poll', processId: completed.processId! }, undefined, {
        sessionId: 'other',
        executionId: 'second'
      })
    ).rejects.toMatchObject({ code: 'MAR_AGENT_PROCESS_NOT_FOUND' });
    const running = await tool.execute({
      command: `${process.execPath} -e "setTimeout(() => {}, 30000)"`,
      yieldMs: 0
    });
    expect(running.status).toBe('running');
    const recalled = await tool.execute(
      { action: 'poll', processId: completed.processId! },
      undefined,
      { sessionId: 'session', executionId: 'second' }
    );
    expect(recalled).toMatchObject({ ...completed, cached: true });
    expect(
      await tool.execute({ action: 'poll', processId: completed.processId! }, undefined, {
        sessionId: 'session',
        executionId: 'third'
      })
    ).toMatchObject({ ...completed, cached: true });
    await expect(
      tool.execute(
        { action: 'write', processId: completed.processId!, data: 'x' },
        undefined,
        owner
      )
    ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_INPUT_INVALID' });
    await tool.execute({ action: 'cancel', processId: running.processId! });
    const cancelled = await tool.execute(
      { command: `${process.execPath} -e "process.stdout.write('remove')"`, yieldMs: 5_000 },
      undefined,
      owner
    );
    await tool.execute({ action: 'cancel', processId: cancelled.processId! }, undefined, owner);
    await expect(
      tool.execute({ action: 'poll', processId: cancelled.processId! }, undefined, owner)
    ).rejects.toMatchObject({ code: 'MAR_AGENT_PROCESS_NOT_FOUND' });
    await tool.disposeSession('session');
    await expect(
      tool.execute({ action: 'poll', processId: completed.processId! }, undefined, owner)
    ).rejects.toMatchObject({ code: 'MAR_AGENT_PROCESS_NOT_FOUND' });
    await tool.dispose();
  });

  it('recalls output consumed while a process was running after it finishes', async () => {
    const { root } = await fixture();
    const tool = new ExecTool(new WorkspacePathResolver(root));
    try {
      const started = await tool.execute({
        command: `${process.execPath} -e "process.stdin.once('data', () => process.stderr.write('late', () => process.exit(3))); process.stdout.write('early');"`,
        yieldMs: 0
      });
      const first = started.stdout
        ? started
        : await tool.execute({
            action: 'poll',
            processId: started.processId!,
            yieldMs: 1_000
          });
      expect(first).toMatchObject({ status: 'running', stdout: 'early' });
      await tool.execute({ action: 'write', processId: started.processId!, data: 'finish\n' });
      let terminal = started;
      await expect
        .poll(
          async () => {
            terminal = await tool.execute({
              action: 'poll',
              processId: started.processId!,
              yieldMs: 1_000
            });
            return terminal.status;
          },
          { timeout: 5_000 }
        )
        .toBe('completed');
      expect(terminal).toMatchObject({ status: 'completed', exitCode: 3 });
      expect(await tool.execute({ action: 'poll', processId: started.processId! })).toMatchObject({
        status: 'completed',
        processId: started.processId,
        stdout: 'early',
        stderr: 'late',
        exitCode: 3,
        cached: true
      });
    } finally {
      await tool.dispose();
    }
  });

  it('bounds completed command history and evicts the oldest result', async () => {
    const { root } = await fixture();
    const tool = new ExecTool(new WorkspacePathResolver(root), 8, 1);
    const ids: string[] = [];
    for (let index = 0; index <= TOOL_EXECUTION_LIMITS.execMaxCompletedResults; index++) {
      const result = await tool.execute({
        command: `${process.execPath} -e "process.stdout.write('head-${index}-tail')"`,
        yieldMs: 5_000
      });
      expect(result.status).toBe('completed');
      ids.push(result.processId!);
    }
    expect(tool.listSessionResources('session')).toEqual([]);
    await expect(tool.execute({ action: 'poll', processId: ids[0]! })).rejects.toMatchObject({
      code: 'MAR_AGENT_PROCESS_NOT_FOUND'
    });
    expect(await tool.execute({ action: 'poll', processId: ids.at(-1)! })).toMatchObject({
      status: 'completed',
      cached: true,
      stdout: 'headtail',
      truncated: true,
      stdoutDroppedBytes: expect.any(Number)
    });
    await tool.dispose();
  });

  it.each([
    { options: {}, expected: 10_000 },
    { options: { yieldMs: null }, expected: 10_000 },
    { options: { yieldMs: 0 }, expected: 0 },
    { options: { yieldMs: 30_000 }, expected: 30_000 },
    { options: { yieldMs: 300_000 }, expected: 300_000 }
  ])('uses the poll wait window $expected for $options', async ({ options, expected }) => {
    const { root } = await fixture();
    const { state, child } = fakeChild();
    const tool = new ExecTool(
      new WorkspacePathResolver(root),
      undefined,
      undefined,
      process.env,
      undefined,
      {
        async spawn() {
          return child;
        }
      }
    );
    const started = await tool.execute({ command: 'ignored', yieldMs: 0 });
    vi.useFakeTimers();
    try {
      let settled = false;
      const poll = tool
        .execute({ action: 'poll', processId: started.processId, ...options })
        .then((result) => {
          settled = true;
          return result;
        });
      if (expected > 0) {
        await vi.advanceTimersByTimeAsync(expected - 1);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(await poll).toMatchObject({ status: 'running' });
      const next = tool.execute({ action: 'poll', processId: started.processId });
      state.stdout.write('ready');
      expect(await next).toMatchObject({ status: 'running', stdout: 'ready' });
    } finally {
      state.exitCode = 0;
      state.emit('close', 0, null);
      await tool.dispose();
      vi.useRealTimers();
    }
  });

  it('expires completed command results five minutes after first terminal return without extending on poll', async () => {
    const { root } = await fixture();
    const { state, child } = fakeChild();
    const tool = new ExecTool(
      new WorkspacePathResolver(root),
      undefined,
      undefined,
      process.env,
      undefined,
      {
        async spawn() {
          return child;
        }
      }
    );
    const started = await tool.execute({ command: 'ignored', yieldMs: 0 }, undefined, {
      sessionId: 'session',
      executionId: 'start'
    });
    vi.useFakeTimers();
    try {
      state.exitCode = 0;
      state.emit('close', 0, null);
      await tool.execute({ action: 'poll', processId: started.processId! }, undefined, {
        sessionId: 'session',
        executionId: 'start'
      });
      await vi.advanceTimersByTimeAsync(TOOL_EXECUTION_LIMITS.execCompletedRetentionMs - 1);
      expect(
        await tool.execute({ action: 'poll', processId: started.processId! }, undefined, {
          sessionId: 'session',
          executionId: 'later'
        })
      ).toMatchObject({ status: 'completed', cached: true });
      await vi.advanceTimersByTimeAsync(1);
      expect(tool.listSessionResources('session')).toEqual([]);
      await expect(
        tool.execute({ action: 'poll', processId: started.processId! }, undefined, {
          sessionId: 'session',
          executionId: 'later'
        })
      ).rejects.toMatchObject({ code: 'MAR_AGENT_PROCESS_NOT_FOUND' });
    } finally {
      vi.useRealTimers();
      await tool.dispose();
    }
  });

  it('enforces tool control parameters at runtime without relying on model schema validation', async () => {
    const { tools } = await fixture();
    await expect(
      tools.exec({ action: 'start', command: 'ignored', timeoutMs: -1 })
    ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_INPUT_INVALID' });
    await expect(
      tools.exec({ action: 'poll', processId: 'missing', yieldMs: 30_001 })
    ).rejects.toMatchObject({ code: 'MAR_AGENT_PROCESS_NOT_FOUND' });
    await expect(tools.read({ reads: [{ path: 'ignored', limit: 0 }] })).rejects.toMatchObject({
      code: 'MAR_AGENT_TOOL_INPUT_INVALID'
    });
    await tools.dispose();
  });

  it('normalizes nullable optional controls and clamps requests to Host limits', async () => {
    const { tools } = await fixture();
    await expect(
      tools.exec({
        action: null,
        command: `${process.execPath} -e "process.stdout.write('bounded')"`,
        cwd: null,
        timeoutMs: null,
        yieldMs: 300_001
      } as never)
    ).resolves.toMatchObject({ status: 'completed', stdout: 'bounded' });
    await tools.dispose();
  });

  it('rejects an omitted action unless a non-empty command unambiguously implies start', async () => {
    const { tools } = await fixture();
    await expect(tools.exec({} as never)).rejects.toMatchObject({
      code: 'MAR_AGENT_TOOL_INPUT_INVALID'
    });
    await expect(tools.exec({ command: '   ' } as never)).rejects.toMatchObject({
      code: 'MAR_AGENT_TOOL_INPUT_INVALID'
    });
    await tools.dispose();
  });

  it('waits for process output through bounded poll instead of busy polling', async () => {
    const { tools } = await fixture();
    const started = await tools.exec({
      action: 'start',
      command: `${process.execPath} -e "setTimeout(() => process.stdout.write('ready'), 100)"`,
      yieldMs: 10
    });
    expect(started.status).toBe('running');
    const polled = await tools.exec({
      action: 'poll',
      processId: started.processId!,
      yieldMs: 1_000
    });
    expect(polled.stdout).toBe('ready');
    await tools.dispose();
  });

  it('returns only new process output on poll while retaining cumulative byte counters', async () => {
    const { tools } = await fixture();
    try {
      const started = await tools.exec({
        action: 'start',
        command: `${process.execPath} -e "let stage = 0; process.stdin.on('data', () => { if (stage++ === 0) process.stdout.write('second'); else process.exit(0); }); process.stdout.write('first');"`,
        yieldMs: 0
      });
      // Login startup has no fixed latency; advance the child only after consuming each chunk.
      const first = started.stdout
        ? started
        : await tools.exec({
            action: 'poll',
            processId: started.processId!,
            yieldMs: 1_000
          });
      expect(first).toMatchObject({ status: 'running', stdout: 'first', stdoutBytes: 5 });
      await tools.exec({ action: 'write', processId: started.processId!, data: 'next\n' });
      const updated = await tools.exec({
        action: 'poll',
        processId: started.processId!,
        yieldMs: 1_000
      });
      expect(updated).toMatchObject({
        status: 'running',
        stdout: 'second',
        stdoutBytes: 11,
        stdoutDroppedBytes: 0
      });
      await tools.exec({ action: 'write', processId: started.processId!, data: 'exit\n' });
      const completed = await tools.exec({
        action: 'poll',
        processId: started.processId!,
        yieldMs: 1_000
      });
      expect(completed).toMatchObject({
        status: 'completed',
        stdout: '',
        stdoutBytes: 11,
        stdoutDroppedBytes: 0
      });
    } finally {
      await tools.dispose();
    }
  });

  it('aborts the initial exec wait without terminating the retained Session process', async () => {
    const { root } = await fixture();
    const host = new LocalAgentHost({ homeDirectory: join(root, 'home'), workspace: root });
    const controller = new AbortController();
    const startedAt = Date.now();
    const execution = host.executeTool(
      {
        name: 'exec',
        arguments: {
          command: `${process.execPath} -e "setTimeout(() => {}, 30000)"`,
          yieldMs: 10_000,
          timeoutMs: 30_000
        }
      },
      {
        mode: 'run',
        signal: controller.signal,
        sessionId: 'direct-session',
        executionId: 'direct-execution'
      }
    );
    setTimeout(() => controller.abort(new Error('interrupted')), 50).unref();

    await expect(execution).rejects.toThrow('interrupted');
    expect(Date.now() - startedAt).toBeLessThan(500);
    const resources = await host.listSessionResources('direct-session');
    expect(resources).toMatchObject({
      processes: [expect.objectContaining({ status: 'running' })]
    });
    await host.executeTool(
      {
        name: 'exec_wait',
        arguments: {
          action: 'cancel',
          processId: resources.processes[0]!.processId
        }
      },
      {
        mode: 'run',
        signal: new AbortController().signal,
        sessionId: 'direct-session',
        executionId: 'cleanup'
      }
    );
    await host.dispose();
  });

  it('does not expose a replacement Execution MCP binding to an older execution', async () => {
    const { root } = await fixture();
    const host = new LocalAgentHost({ homeDirectory: join(root, 'home'), workspace: root });
    const tool = {
      name: 'mcp__mission__status',
      description: 'Read mission status.',
      inputSchema: { type: 'object' }
    };
    const first = host.bindExecutionMcp({
      tools: [tool],
      call: async () => ({ content: 'first' })
    });
    await expect(
      host.listMcpTools({
        sessionId: 'session',
        executionId: 'execution-1',
        claimExecutionScope: true
      })
    ).resolves.toEqual([tool]);
    host.unbindExecutionMcp(first);
    const second = host.bindExecutionMcp({
      tools: [tool],
      call: async () => ({ content: 'second' })
    });
    await expect(
      host.listMcpTools({
        sessionId: 'session',
        executionId: 'execution-2',
        claimExecutionScope: true
      })
    ).resolves.toEqual([tool]);
    await expect(
      host.listMcpTools({
        sessionId: 'child-session',
        executionId: 'delayed-child',
        executionScopeId: 'execution-1'
      })
    ).resolves.toEqual([]);

    await expect(
      host.callMcpTool({ name: tool.name, arguments: {} }, new AbortController().signal, {
        sessionId: 'session',
        executionId: 'execution-1'
      })
    ).rejects.toMatchObject({ code: 'MAR_AGENT_MCP_FAILED' });
    await expect(
      host.callMcpTool({ name: tool.name, arguments: {} }, new AbortController().signal, {
        sessionId: 'session',
        executionId: 'execution-2'
      })
    ).resolves.toEqual({ content: 'second' });

    host.unbindExecutionMcp(second);
    await host.dispose();
  });

  it('aborts a poll wait without terminating a retained Session process', async () => {
    const { root } = await fixture();
    const host = new LocalAgentHost({ homeDirectory: join(root, 'home'), workspace: root });
    const started = await host.executeTool(
      {
        name: 'exec',
        arguments: {
          command: `${process.execPath} -e "setTimeout(() => {}, 30000)"`,
          yieldMs: 10,
          timeoutMs: 30_000
        }
      },
      {
        mode: 'run',
        signal: new AbortController().signal,
        sessionId: 'session',
        executionId: 'start'
      }
    );
    const processId = (started.data as { processId?: string }).processId!;
    const controller = new AbortController();
    const startedAt = Date.now();
    const polling = host.executeTool(
      { name: 'exec_wait', arguments: { action: 'poll', processId, yieldMs: 1_000 } },
      {
        mode: 'run',
        signal: controller.signal,
        sessionId: 'session',
        executionId: 'poll'
      }
    );
    setTimeout(() => controller.abort(new Error('interrupted')), 50).unref();

    await expect(polling).rejects.toThrow('interrupted');
    expect(Date.now() - startedAt).toBeLessThan(500);
    await expect(host.listSessionResources('session')).resolves.toMatchObject({
      processes: [expect.objectContaining({ processId, status: 'running' })]
    });
    await expect(host.listSessionResources('other-session')).resolves.toEqual({
      processes: [],
      codeCells: []
    });
    await expect(
      host.executeTool(
        { name: 'exec_wait', arguments: { action: 'poll', processId } },
        {
          mode: 'run',
          signal: new AbortController().signal,
          sessionId: 'other-session',
          executionId: 'foreign'
        }
      )
    ).rejects.toMatchObject({ code: 'MAR_AGENT_PROCESS_NOT_FOUND' });
    await host.executeTool(
      { name: 'exec_wait', arguments: { action: 'cancel', processId } },
      {
        mode: 'run',
        signal: new AbortController().signal,
        sessionId: 'session',
        executionId: 'cancel'
      }
    );
    await host.dispose();
  });

  it('releases a Session process after exit even when child close never arrives', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mar-tools-exit-without-close-'));
    roots.push(workspace);
    const childState = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null
    });
    const child = childState as unknown as ChildProcessWithoutNullStreams;
    const tool = new ExecTool(
      new WorkspacePathResolver(workspace),
      undefined,
      undefined,
      process.env,
      undefined,
      {
        async spawn() {
          return child;
        }
      }
    );
    const started = await tool.execute(
      { action: 'start', command: 'ignored', yieldMs: 0, timeoutMs: 30_000 },
      undefined,
      { sessionId: 'session', executionId: 'execution' }
    );
    expect(started).toMatchObject({ status: 'running', processId: expect.any(String) });

    childState.emit('exit', null, 'SIGTERM');
    const disposing = tool.disposeSession('session');
    try {
      const result = await Promise.race([
        disposing.then(() => 'disposed' as const),
        new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 500))
      ]);
      expect(result).toBe('disposed');
      expect(tool.listSessionResources('session')).toEqual([]);
    } finally {
      childState.emit('close', 0, null);
      await disposing;
      await tool.dispose();
    }
  });

  it('forwards the Execution context to the tool policy hook and question callback', async () => {
    const { root } = await fixture();
    const controller = new AbortController();
    const seen: AbortSignal[] = [];
    const host = new LocalAgentHost({
      homeDirectory: join(root, 'home'),
      workspace: root,
      beforeToolExecute: async (_call, context) => {
        seen.push(context.signal);
        throw new MarAgentError('TEST_TOOL_POLICY_DENIED', 'Tool policy denied execution.');
      },
      question: async (_input, signal) => {
        seen.push(signal);
        return {};
      }
    });

    await expect(
      host.executeTool(
        { name: 'exec', arguments: { command: 'ignored' } },
        {
          mode: 'run',
          signal: controller.signal,
          sessionId: 'direct-session',
          executionId: 'direct-execution'
        }
      )
    ).rejects.toMatchObject({ code: 'TEST_TOOL_POLICY_DENIED' });
    await host.requestUserInput({ requestId: 'request', questions: [] }, controller.signal);

    expect(seen).toEqual([controller.signal, controller.signal]);
    await host.dispose();
  });

  it('delegates process starts to an injected executor without direct-execution fallback', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mar-tools-executor-'));
    roots.push(workspace);
    const requests: LocalProcessSpawnRequest[] = [];
    const host = new LocalAgentHost({
      homeDirectory: join(workspace, 'home'),
      workspace,
      environment: { HOME: workspace, PATH: process.env.PATH, MAR_EXECUTOR_TEST: 'visible' },
      processExecutor: {
        async spawn(request) {
          requests.push(request);
          return directLocalProcessExecutor.spawn(request);
        }
      }
    });

    await expect(
      host.executeTool(
        {
          name: 'exec',
          arguments: {
            command: `${JSON.stringify(process.execPath)} -e "process.stdout.write(process.env.MAR_EXECUTOR_TEST ?? '')"`,
            yieldMs: 1_000
          }
        },
        {
          mode: 'run',
          signal: AbortSignal.timeout(2_000),
          sessionId: 'executor-session',
          executionId: 'executor-execution'
        }
      )
    ).resolves.toMatchObject({ data: { status: 'completed', stdout: 'visible', exitCode: 0 } });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      cwd: workspace,
      shell: expect.any(String),
      detached: process.platform !== 'win32',
      owner: { sessionId: 'executor-session', executionId: 'executor-execution' }
    });

    const marker = join(workspace, 'must-not-exist');
    const rejecting = new LocalAgentHost({
      homeDirectory: join(workspace, 'rejecting-home'),
      workspace,
      processExecutor: {
        async spawn() {
          throw new MarAgentError('SANDBOX_UNAVAILABLE', 'Sandbox is unavailable.');
        }
      }
    });
    await expect(
      rejecting.executeTool(
        {
          name: 'exec',
          arguments: { command: `echo fallback > ${JSON.stringify(marker)}` }
        },
        {
          mode: 'run',
          signal: AbortSignal.timeout(2_000),
          sessionId: 'rejecting-session',
          executionId: 'rejecting-execution'
        }
      )
    ).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
    await expect(stat(marker)).rejects.toThrow();
    await Promise.all([host.dispose(), rejecting.dispose()]);
  });

  it('starts independent exec processes concurrently and preserves capacity reservations', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mar-tools-concurrent-exec-'));
    roots.push(workspace);
    const entered = deferred<void>();
    const releases = [
      deferred<ChildProcessWithoutNullStreams>(),
      deferred<ChildProcessWithoutNullStreams>()
    ] as const;
    const children = [fakeChild(), fakeChild()] as const;
    const commands: string[] = [];
    const tool = new ExecTool(
      new WorkspacePathResolver(workspace),
      undefined,
      2,
      process.env,
      undefined,
      {
        async spawn(request) {
          commands.push(request.command);
          if (commands.length === 2) entered.resolve();
          return releases[request.command === 'first' ? 0 : 1].promise;
        }
      }
    );

    const first = tool.execute({ command: 'first', yieldMs: 0 });
    const second = tool.execute({ command: 'second', yieldMs: 0 });
    await entered.promise;
    expect(commands.toSorted()).toEqual(['first', 'second']);

    releases[1].resolve(children[1].child);
    releases[0].resolve(children[0].child);
    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.status)).toEqual(['running', 'running']);

    for (const { state } of children) {
      state.exitCode = 0;
      state.emit('close', 0, null);
    }
    await tool.dispose();
  });

  it('enforces maxProcesses during concurrent starts and releases failed reservations', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mar-tools-exec-capacity-'));
    roots.push(workspace);
    const firstSpawnEntered = deferred<void>();
    const firstSpawn = deferred<ChildProcessWithoutNullStreams>();
    const child = fakeChild();
    let spawnCount = 0;
    const tool = new ExecTool(
      new WorkspacePathResolver(workspace),
      undefined,
      1,
      process.env,
      undefined,
      {
        async spawn() {
          spawnCount++;
          firstSpawnEntered.resolve();
          return firstSpawn.promise;
        }
      }
    );

    const first = tool.execute({ command: 'first', yieldMs: 0 });
    await firstSpawnEntered.promise;
    await expect(tool.execute({ command: 'blocked', yieldMs: 0 })).rejects.toMatchObject({
      code: 'MAR_AGENT_PROCESS_LIMIT'
    });
    expect(spawnCount).toBe(1);
    firstSpawn.resolve(child.child);
    await expect(first).resolves.toMatchObject({ status: 'running' });
    child.state.exitCode = 0;
    child.state.emit('close', 0, null);
    await tool.dispose();

    const recoveredChild = fakeChild();
    let attempts = 0;
    const recovering = new ExecTool(
      new WorkspacePathResolver(workspace),
      undefined,
      1,
      process.env,
      undefined,
      {
        async spawn() {
          attempts++;
          if (attempts === 1) throw new Error('expected spawn failure');
          return recoveredChild.child;
        }
      }
    );
    await expect(recovering.execute({ command: 'fails', yieldMs: 0 })).rejects.toThrow(
      'expected spawn failure'
    );
    await expect(recovering.execute({ command: 'recovers', yieldMs: 0 })).resolves.toMatchObject({
      status: 'running'
    });
    recoveredChild.state.exitCode = 0;
    recoveredChild.state.emit('close', 0, null);
    await recovering.dispose();
  });

  it('shares the 64-process default across sessions, including starts, and frees completed slots', async () => {
    const { root } = await fixture();
    const children = Array.from({ length: 65 }, () => fakeChild());
    const releases = Array.from({ length: 64 }, () => deferred<ChildProcessWithoutNullStreams>());
    let spawnCount = 0;
    const tool = new ExecTool(
      new WorkspacePathResolver(root),
      undefined,
      undefined,
      process.env,
      undefined,
      {
        async spawn(request) {
          spawnCount++;
          if (request.command === 'replacement') return children[64]!.child;
          return releases[Number(request.command)]!.promise;
        }
      }
    );
    expect(tool.maxProcesses).toBe(64);
    const starts = releases.map((_release, index) =>
      tool.execute({ command: String(index), yieldMs: 0 }, undefined, {
        sessionId: `child-${index % 4}`,
        executionId: 'execution'
      })
    );
    try {
      await expect.poll(() => spawnCount).toBe(64);
      await expect(
        tool.execute({ command: 'blocked', yieldMs: 0 }, undefined, {
          sessionId: 'parent',
          executionId: 'execution'
        })
      ).rejects.toMatchObject({
        code: 'MAR_AGENT_PROCESS_LIMIT',
        message: expect.stringContaining('shared managed-process limit (64)')
      });
      expect(spawnCount).toBe(64);
      releases.forEach((release, index) => release.resolve(children[index]!.child));
      const running = await Promise.all(starts);
      expect(running.every((result) => result.status === 'running')).toBe(true);
      children[0]!.state.exitCode = 0;
      children[0]!.state.emit('close', 0, null);
      await tool.execute({ action: 'poll', processId: running[0]!.processId }, undefined, {
        sessionId: 'child-0',
        executionId: 'execution'
      });
      await expect(
        tool.execute({ command: 'replacement', yieldMs: 0 }, undefined, {
          sessionId: 'parent',
          executionId: 'execution'
        })
      ).resolves.toMatchObject({ status: 'running' });
      await expect(tool.execute({ command: 'blocked', yieldMs: 0 })).rejects.toMatchObject({
        code: 'MAR_AGENT_PROCESS_LIMIT'
      });
    } finally {
      releases.forEach((release, index) => release.resolve(children[index]!.child));
      await Promise.allSettled(starts);
      for (const { state } of children) {
        state.exitCode = 0;
        state.emit('close', 0, null);
      }
      await tool.dispose();
    }
  });

  it('waits for an in-flight process start before disposing its Session', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mar-tools-exec-start-disposal-'));
    roots.push(workspace);
    const spawnEntered = deferred<void>();
    const spawnResult = deferred<ChildProcessWithoutNullStreams>();
    const child = fakeChild();
    const tool = new ExecTool(
      new WorkspacePathResolver(workspace),
      undefined,
      1,
      process.env,
      undefined,
      {
        async spawn() {
          spawnEntered.resolve();
          return spawnResult.promise;
        }
      }
    );
    const execution = tool.execute({ command: 'delayed', yieldMs: 10_000 }, undefined, {
      sessionId: 'session',
      executionId: 'execution'
    });
    await spawnEntered.promise;

    let disposed = false;
    const disposal = tool.disposeSession('session').then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);

    spawnResult.resolve(child.child);
    setTimeout(() => {
      child.state.exitCode = 0;
      child.state.emit('close', 0, null);
    }, 0);
    await expect(execution).resolves.toMatchObject({
      status: 'cancelled',
      waitOutcome: 'completion'
    });
    await disposal;
    expect(tool.listSessionResources('session')).toEqual([]);
    await tool.dispose();
  });

  it('enforces the exec output limit in UTF-8 bytes without false truncation', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mar-tools-output-'));
    roots.push(workspace);
    const paths = new WorkspacePathResolver(workspace);
    const exact = new ExecTool(paths, 4);
    const exactResult = await exact.execute({
      action: 'start',
      command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('test')"`,
      yieldMs: 1_000
    });
    expect(Buffer.byteLength(exactResult.stdout)).toBe(4);
    expect(exactResult.truncated).toBe(false);
    await exact.dispose();

    const multibyte = new ExecTool(paths, 5);
    const multibyteResult = await multibyte.execute({
      action: 'start',
      command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('\\u4f60\\u597d\\u4e16\\u754c')"`,
      yieldMs: 1_000
    });
    expect(Buffer.byteLength(multibyteResult.stdout)).toBeLessThanOrEqual(5);
    expect(multibyteResult.truncated).toBe(true);
    expect(multibyteResult.stdout).not.toContain('\ufffd');
    expect(multibyteResult.stdoutDroppedBytes).toBe(12 - Buffer.byteLength(multibyteResult.stdout));
    await multibyte.dispose();
  });

  it('retains the head and tail halves of overflowing exec output', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mar-tools-head-tail-'));
    roots.push(workspace);
    const paths = new WorkspacePathResolver(workspace);
    const tool = new ExecTool(paths, 8);
    const result = await tool.execute({
      action: 'start',
      command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('head01234567tail')"`,
      yieldMs: 1_000
    });
    expect(result.stdout).toBe('headtail');
    expect(result.stdoutDroppedBytes).toBe(8);
    expect(result.truncated).toBe(true);
    await tool.dispose();
  });

  it('preserves patch string and object inputs with tool-owned validation', () => {
    const patch = '*** Begin Patch\n*** End Patch';
    expect(applyPatchToolInput(patch)).toBe(patch);
    expect(applyPatchToolInput({ patch })).toBe(patch);
    for (const input of [undefined, null, {}, { patch: 12 }]) {
      expect(() => applyPatchToolInput(input)).toThrowError(
        expect.objectContaining({ code: 'MAR_AGENT_TOOL_INPUT_INVALID' })
      );
    }
  });
});
