import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerClient } from '../../src/codex-app-server.js';
import type { ConversationHistoryService } from '../../src/service/conversation-history-service.js';
import { NodeConnector } from '../../src/connector.js';
import type { NativeSessionProjectionService } from '../../src/service/native-session-projection-service.js';
import { NodeDatabase } from '../../src/database.js';

describe('Node Workbench Codex tool history projection', () => {
  it('restores local and inline user images through controlled references without JSONL', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-official-user-images-'));
    const previousHome = process.env.HOME;
    const workspace = join(home, 'workspace');
    process.env.HOME = home;
    const database = new NodeDatabase(':memory:', 'node-official-user-images');
    let connector: NodeConnector | undefined;
    try {
      await mkdir(workspace);
      const picture = join(workspace, 'picture.png');
      const outside = join(home, 'outside.png');
      await writeFile(picture, Buffer.from('local-image'));
      await writeFile(outside, Buffer.from('outside-image'));
      const saved = database.saveWorkspace({
        path: workspace,
        kind: 'DIRECTORY',
        gitSummary: null
      });
      const client = new CodexAppServerClient({ command: 'unused' });
      vi.spyOn(client, 'start').mockResolvedValue(undefined);
      vi.spyOn(client, 'readThread').mockResolvedValue({
        thread: { id: 'native-images', historyMode: 'legacy' }
      });
      vi.spyOn(client, 'listThreadTurns').mockResolvedValue({
        data: [
          {
            id: 'inline-turn',
            itemsView: 'full',
            status: 'completed',
            items: [
              {
                id: 'inline-user',
                type: 'userMessage',
                content: [{ type: 'image', url: 'data:image/png;base64,aW5saW5lLWltYWdl' }]
              }
            ]
          },
          {
            id: 'local-turn',
            itemsView: 'full',
            status: 'completed',
            items: [
              {
                id: 'local-user',
                type: 'userMessage',
                content: [
                  { type: 'localImage', path: picture },
                  { type: 'localImage', path: outside }
                ]
              }
            ]
          }
        ],
        nextCursor: null
      });
      connector = new NodeConnector({
        reconnect: false,
        database,
        codexClient: client,
        capabilities: {
          platform: 'linux',
          architecture: 'x64',
          nodeVersion: process.version,
          codex: { available: true },
          claudeCode: { available: false }
        }
      });
      const internals = connector as unknown as {
        conversationHistoryService: ConversationHistoryService;
        runtime: { createAgentSession(input: Record<string, unknown>): { id: string } };
      };
      const native = vi
        .spyOn(internals.conversationHistoryService, 'readNative')
        .mockRejectedValue(new Error('JSONL must not be read'));
      const session = internals.runtime.createAgentSession({
        workspaceId: saved.id,
        runner: 'codex',
        cwd: workspace,
        externalSessionId: 'native-images'
      });
      const page = (await operation(connector, 'session.turns.list', {
        sessionId: session.id
      })) as {
        turns: {
          userItemId: string | null;
          rewind: { before: string | null; after: string };
          items: {
            kind: string;
            payload: { text: string; attachments: { runId?: string; imageIndex?: number }[] };
          }[];
        }[];
      };
      expect(page.turns).toHaveLength(2);
      expect(page.turns.map((turn) => turn.rewind)).toEqual([
        { before: null, after: 'local-turn' },
        { before: 'local-turn', after: 'inline-turn' }
      ]);
      for (const turn of page.turns) {
        expect(turn.userItemId).not.toBeNull();
        expect(turn.items[0]).toMatchObject({ kind: 'user_message', payload: { text: '' } });
      }
      const local = page.turns[0]!.items[0]!.payload.attachments;
      const inline = page.turns[1]!.items[0]!.payload.attachments[0]!;
      expect(local[1]).not.toHaveProperty('runId');
      expect(local[1]).not.toHaveProperty('imageIndex');
      for (const [attachment, dataBase64] of [
        [local[0]!, Buffer.from('local-image').toString('base64')],
        [inline, 'aW5saW5lLWltYWdl']
      ] as const) {
        await expect(
          operation(connector, 'run.image.read', {
            runId: attachment.runId,
            imageIndex: attachment.imageIndex
          })
        ).resolves.toMatchObject({ image: { mime: 'image/png', dataBase64 } });
      }
      const publicPage = JSON.stringify(page);
      expect(publicPage).not.toContain(home);
      expect(publicPage).not.toContain('aW5saW5lLWltYWdl');
      expect(native).not.toHaveBeenCalled();
    } finally {
      if (connector !== undefined) await connector.stop();
      else database.close();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('restores official Codex tool and image history without reading JSONL', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-codex-native-tools-'));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    const database = new NodeDatabase(':memory:', 'node-codex-native-tools');
    const workspacePath = join(home, 'workspace');
    const workspace = database.saveWorkspace({
      path: workspacePath,
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const generatedImagePath = join(home, '.codex', 'generated_images', 'codex-tools', 'image.png');
    let connector: NodeConnector | undefined;
    try {
      await mkdir(dirname(generatedImagePath), { recursive: true });
      await mkdir(workspacePath, { recursive: true });
      await writeFile(generatedImagePath, Buffer.from('native-image'));
      const viewedImagePath = join(workspacePath, 'logo.png');
      const escapedImagePath = join(home, 'outside.png');
      await writeFile(viewedImagePath, Buffer.from('workspace-image'));
      await writeFile(escapedImagePath, Buffer.from('outside-image'));
      const client = new CodexAppServerClient({ command: 'unused' });
      vi.spyOn(client, 'start').mockResolvedValue(undefined);
      vi.spyOn(client, 'listThreadTurns').mockResolvedValue({
        data: [
          {
            id: 'tool-turn',
            status: 'completed',
            itemsView: 'full',
            items: [
              { id: 'user', type: 'userMessage', content: [{ type: 'text', text: 'Read README' }] },
              {
                type: 'function_call',
                call_id: 'exec-generated-image',
                name: 'imagegen',
                arguments: '{}'
              },
              {
                id: 'exec-generated-image',
                type: 'imageGeneration',
                status: 'completed',
                savedPath: generatedImagePath
              },
              {
                id: 'ctc-read',
                type: 'custom_tool_call',
                call_id: 'call-read',
                name: 'exec_command',
                input: { cmd: 'sed -n "1,4p" README.md' }
              },
              {
                id: 'ctco-read',
                type: 'custom_tool_call_output',
                call_id: 'call-read',
                output: [
                  { type: 'input_text', text: '# README\n' },
                  { type: 'input_text', text: '{"image_url":"data:image/jpeg;base64,aGVsbG8="}' },
                  { type: 'input_text', text: 'Script completed\n' }
                ]
              },
              {
                type: 'custom_tool_call',
                call_id: 'call-wrapped-command',
                name: 'exec',
                input:
                  'const r = await tools.exec_command({cmd:"git status --short",workdir:"/workspace"}); text(r.output);'
              },
              {
                type: 'custom_tool_call',
                call_id: 'call-wrapped-patch',
                name: 'exec',
                input: `const patch = ${JSON.stringify('*** Begin Patch\n*** Add File: src/new.ts\n+new\n*** Delete File: src/old.ts\n*** Update File: src/live.ts\n@@\n-old\n+new\n*** End Patch')}; text(await tools.apply_patch(patch));`
              },
              { id: 'call-view-image', type: 'imageView', path: viewedImagePath },
              { id: 'call-view-image-outside', type: 'imageView', path: escapedImagePath }
            ]
          }
        ],
        nextCursor: null
      });
      connector = new NodeConnector({
        reconnect: false,
        database,
        codexClient: client,
        capabilities: {
          platform: 'linux',
          architecture: 'x64',
          nodeVersion: process.version,
          codex: { available: true },
          claudeCode: { available: false }
        }
      });
      const internals = connector as unknown as {
        nativeSessionProjectionService: NativeSessionProjectionService;
        conversationHistoryService: ConversationHistoryService;
        directNativeSession(input: unknown): { readonly id: string };
        rememberDirectNativeSessions(sessions: readonly { readonly id: string }[]): void;
      };
      const session = internals.nativeSessionProjectionService.project({
        workspace,
        runner: 'codex',
        externalSessionId: 'codex-tools',
        cwd: workspace.path,
        title: 'Read README'
      });
      internals.nativeSessionProjectionService.remember([session]);
      const nativeRead = vi
        .spyOn(internals.conversationHistoryService, 'readNative')
        .mockRejectedValue(new Error('JSONL must not be read'));

      const page = (await operation(connector, 'session.turns.list', {
        sessionId: session.id,
        limit: 10
      })) as {
        turns: {
          items: {
            kind: string;
            payload: {
              toolName?: string;
              toolCategory?: string;
              command?: string;
              cwd?: string | null;
              attachments?: { name?: string; runId?: string; imageIndex?: number }[];
            };
          }[];
        }[];
      };
      const items = page.turns.flatMap((turn) => turn.items);
      expect(nativeRead).not.toHaveBeenCalled();
      expect(items.filter((item) => item.payload.toolName === 'imagegen')).toHaveLength(1);
      expect(items).toContainEqual(
        expect.objectContaining({
          kind: 'command_execution',
          payload: expect.objectContaining({
            command: 'sed -n "1,4p" README.md',
            outputPreview: expect.stringContaining('{"image_url":"[Image content extracted]"}')
          })
        })
      );
      expect(items).toContainEqual(
        expect.objectContaining({
          kind: 'tool_call',
          payload: expect.objectContaining({
            toolName: 'exec',
            inputSummary:
              'const r = await tools.exec_command({cmd:"git status --short",workdir:"/workspace"}); text(r.output);'
          })
        })
      );
      expect(items).toContainEqual(
        expect.objectContaining({
          kind: 'tool_call',
          payload: expect.objectContaining({
            toolName: 'exec',
            inputSummary: expect.stringContaining('const patch = ')
          })
        })
      );
      expect(items).toContainEqual(
        expect.objectContaining({
          kind: 'tool_call',
          payload: expect.objectContaining({
            toolName: 'imagegen',
            toolCategory: 'IMAGE_GENERATION',
            attachments: [
              expect.objectContaining({ name: 'image.png', mime: 'image/png', imageIndex: 0 })
            ]
          })
        })
      );
      const viewedImage = items.find(
        (item) => item.kind === 'tool_call' && item.payload.attachments?.[0]?.name === 'logo.png'
      );
      expect(viewedImage?.payload).not.toHaveProperty('toolCategory');
      const viewedImageAttachment = viewedImage?.payload.attachments?.[0];
      expect(viewedImageAttachment).toMatchObject({
        name: 'logo.png',
        runId: `native-history:${session.id}`,
        imageIndex: 1
      });
      await expect(
        operation(connector, 'run.image.read', {
          runId: viewedImageAttachment?.runId,
          imageIndex: viewedImageAttachment?.imageIndex
        })
      ).resolves.toMatchObject({
        image: { dataBase64: Buffer.from('workspace-image').toString('base64') }
      });
      const escapedImage = items.find(
        (item) => item.payload.attachments?.[0]?.name === 'outside.png'
      )?.payload.attachments?.[0];
      expect(escapedImage).toEqual({ name: 'outside.png', mime: 'image/png' });
      const attachment = items.find((item) => item.payload.attachments)?.payload.attachments?.[0];
      await expect(
        operation(connector, 'run.image.read', { runId: attachment?.runId, imageIndex: 0 })
      ).resolves.toMatchObject({
        image: { name: 'image.png', mime: 'image/png', dataBase64: 'bmF0aXZlLWltYWdl' }
      });
    } finally {
      if (connector !== undefined) await connector.stop();
      else database.close();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  });
});

function operation(connector: NodeConnector, operation: string, data: unknown): Promise<unknown> {
  return (
    connector as unknown as {
      executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
    }
  ).executeNodeOperation(operation, data);
}
