import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalAgentHost } from '../../src/host.js';
import {
  SecretValue,
  openAgentSessionCatalog,
  type AgentModelConfiguration
} from '../../src/index.js';
import { createAgentWithAdapter } from '../../src/sdk/agent.js';
import type { ModelAdapter, ModelRequest } from '../../src/model/contracts.js';
import { ApplyPatchTool } from '../../src/tools/local/apply-patch.js';
import { WorkspacePathResolver } from '../../src/tools/shared/path-resolver.js';
import {
  failedToolResultExtensions,
  withToolResultExtensions,
  type ToolResultResourceWriter
} from '../../src/tools/result-extensions.js';

describe('tool result extension evidence', () => {
  it('creates, overwrites and deletes empty files without inventing a newline', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mar-empty-diff-'));
    const resources = new Map<string, string>();
    const writer: ToolResultResourceWriter = async (text) => {
      const resourceRef = randomUUID();
      resources.set(resourceRef, text);
      return {
        status: 'available',
        resourceRef,
        format: 'unified-diff',
        byteSize: Buffer.byteLength(text),
        sha256: createHash('sha256').update(text).digest('hex')
      };
    };
    try {
      const tool = new ApplyPatchTool(new WorkspacePathResolver(workspace));
      const execute = (patch: string) =>
        withToolResultExtensions(writer, async () => ({
          content: '',
          data: await tool.execute(patch)
        }));
      const added = await execute(
        '*** Begin Patch\n*** Add File: empty\n*** Add File: blank\n+\n*** End Patch'
      );
      expect(await readFile(join(workspace, 'empty'), 'utf8')).toBe('');
      expect(await readFile(join(workspace, 'blank'), 'utf8')).toBe('\n');
      expect(added.resultExtensions?.[0]?.entries).toMatchObject([
        { path: 'empty', change: 'added', additions: 0, deletions: 0 },
        { path: 'blank', change: 'added', additions: 1, deletions: 0 }
      ]);
      await writeFile(join(workspace, 'empty'), 'old\n');
      const overwritten = await execute('*** Begin Patch\n*** Add File: empty\n*** End Patch');
      expect(await readFile(join(workspace, 'empty'), 'utf8')).toBe('');
      expect(overwritten.resultExtensions?.[0]?.entries).toMatchObject([
        { path: 'empty', change: 'modified', additions: 0, deletions: 1 }
      ]);
      const deleted = await execute('*** Begin Patch\n*** Delete File: empty\n*** End Patch');
      expect(deleted.resultExtensions?.[0]?.entries).toMatchObject([
        { path: 'empty', change: 'deleted', additions: 0, deletions: 0 }
      ]);
      await expect(readFile(join(workspace, 'empty'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect([...resources.values()]).toContain('--- /dev/null\n+++ "b/empty"\n');
      expect([...resources.values()]).toContain('--- "a/empty"\n+++ /dev/null\n');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    'persists exact changes with codeMode=%s without leaking into model results',
    async (codeMode) => {
      const home = await mkdtemp(join(tmpdir(), 'mar-tool-diff-'));
      const workspace = join(home, 'workspace');
      await mkdir(workspace);
      await writeFile(join(workspace, 'file.txt'), 'A\n');
      const configuration: AgentModelConfiguration = {
        id: 'test',
        name: 'Test',
        modelId: 'test',
        protocol: 'OPENAI_RESPONSES',
        baseUrl: 'https://example.test',
        apiKey: new SecretValue('test'),
        contextWindowTokens: 200_000,
        maxOutputTokens: 4096,
        inputCapabilities: ['TEXT'],
        outputCapabilities: ['TEXT'],
        reasoningEfforts: ['high'],
        hostedWebSearch: false,
        defaultReasoningEffort: 'high',
        codeMode,
        enabled: true
      };
      const requests: ModelRequest[] = [];
      const patch = '*** Begin Patch\n*** Update File: file.txt\n@@\n-A\n+B\n*** End Patch';
      const adapter: ModelAdapter = {
        configuration,
        async *start(request) {
          requests.push(request);
          if (requests.length === 1) {
            yield {
              type: 'client_tool.call',
              callId: 'change',
              name: codeMode ? 'code_exec' : 'apply_patch',
              arguments: codeMode
                ? `const result = await tools.apply_patch(${JSON.stringify(patch)}); if ('resultExtensions' in result) throw new Error('private result leaked');`
                : patch
            };
            yield { type: 'completed', reason: 'tool_use' };
          } else {
            yield { type: 'text.completed', itemId: 'done', text: 'done' };
            yield { type: 'completed', reason: 'completed' };
          }
        }
      };
      const agent = await createAgentWithAdapter(
        {
          mode: 'normal',
          host: new LocalAgentHost({ homeDirectory: home, workspace }),
          models: [configuration]
        },
        () => adapter
      );
      try {
        const session = await agent.createSession({ workspace, title: 'Diff' });
        const run = session.run({ prompt: 'Apply the change.' });
        const events = [];
        for await (const event of run) events.push(event);
        expect((await run.result()).status).toBe('completed');
        const event = events.find(
          (event) => event.type === 'tool.completed' && event.toolName === 'apply_patch'
        );
        expect(event?.type).toBe('tool.completed');
        if (event?.type !== 'tool.completed') throw new Error('missing tool event');
        const entry = event.resultExtensions?.[0]?.entries[0];
        expect(entry).toMatchObject({
          path: 'file.txt',
          change: 'modified',
          additions: 1,
          deletions: 1,
          diff: { status: 'available' }
        });
        if (entry?.diff.status !== 'available') throw new Error('missing resource');
        const resourceRef = entry.diff.resourceRef;
        expect(
          JSON.stringify(requests[1]!.messages.filter((message) => message.role === 'tool'))
        ).not.toContain('resultExtensions');
        await writeFile(join(workspace, 'file.txt'), 'C\n');
        await agent.dispose();
        const catalog = await openAgentSessionCatalog({ homeDirectory: home });
        try {
          const page = await catalog.readToolResultResource(session.id, { resourceRef });
          expect(page.content).toContain('-A\n+B\n');
          expect(page.content).not.toContain('+C');
          const fork = await catalog.fork(session.id, {
            boundaryTurnId: event.turnId,
            title: 'Fork'
          });
          await catalog.clear(session.id);
          await expect(
            catalog.readToolResultResource(session.id, { resourceRef })
          ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_RESOURCE_NOT_FOUND' });
          expect((await catalog.readToolResultResource(fork.id, { resourceRef })).content).toBe(
            page.content
          );
          await catalog.rollback(fork.id, { boundaryTurnId: null });
          await expect(
            catalog.readToolResultResource(fork.id, { resourceRef })
          ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_RESOURCE_NOT_FOUND' });
        } finally {
          await catalog.close();
        }
      } finally {
        await agent.dispose();
        await rm(home, { recursive: true, force: true });
      }
    }
  );

  it('retains successful leaf effects after failure and compares overwritten targets', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mar-diff-effects-'));
    const resources = new Map<string, string>();
    const writer: ToolResultResourceWriter = async (text) => {
      const resourceRef = randomUUID();
      resources.set(resourceRef, text);
      return {
        status: 'available',
        resourceRef,
        format: 'unified-diff',
        byteSize: Buffer.byteLength(text),
        sha256: createHash('sha256').update(text).digest('hex')
      };
    };
    try {
      await writeFile(join(workspace, 'source'), 'source\n');
      await writeFile(join(workspace, 'target'), 'target\n');
      const tool = new ApplyPatchTool(new WorkspacePathResolver(workspace));
      let failure: unknown;
      try {
        await withToolResultExtensions(writer, async () => {
          await tool.execute(
            '*** Begin Patch\n*** Update File: source\n*** Move to: target\n@@\n-source\n+changed\n*** Update File: missing\n@@\n-x\n+y\n*** End Patch'
          );
          return { content: '' };
        });
      } catch (error) {
        failure = error;
      }
      const entries = failedToolResultExtensions(failure)?.[0]?.entries;
      expect(entries).toMatchObject([
        { path: 'source', change: 'deleted', additions: 0, deletions: 1 },
        { path: 'target', change: 'modified', additions: 1, deletions: 1 }
      ]);
      expect([...resources.values()].some((text) => text.includes('-target\n+changed\n'))).toBe(
        true
      );
      expect(await readFile(join(workspace, 'target'), 'utf8')).toBe('changed\n');
      const spoof = await withToolResultExtensions(writer, async () => ({
        content: '',
        resultExtensions: failedToolResultExtensions(failure)!
      }));
      expect(spoof.resultExtensions).toBeUndefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
