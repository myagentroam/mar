import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { NodeConnector } from '../../src/connector.js';
import { ConversationHistoryService } from '../../src/service/conversation-history-service.js';
import { NodeDatabase } from '../../src/database.js';

describe('Node Workbench delayed official-history backfill', () => {
  it('keeps distinct official image-generation calls and supports preview without JSONL', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-official-native-image-'));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    const database = new NodeDatabase(':memory:', 'node-official-history-image-placeholder');
    const workspace = database.saveWorkspace({
      path: '/workspace/official-history-image-placeholder',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: process.version,
        codex: { available: true, version: 'codex-cli 0.147.0' },
        claudeCode: { available: false }
      }
    });
    const internals = connector as unknown as {
      conversationHistoryService: ConversationHistoryService;
      runtime: { createAgentSession(input: Record<string, unknown>): { id: string } };
      codexClient: {
        start(): Promise<void>;
        client: { start(): Promise<void>; listThreadTurns(threadId: string): Promise<unknown> };
        stop(): void;
      };
    };
    try {
      const externalSessionId = 'thread-history-image-placeholder';
      const imagePath = join(
        home,
        '.codex',
        'generated_images',
        externalSessionId,
        'official-image.png'
      );
      const secondImagePath = join(
        home,
        '.codex',
        'generated_images',
        externalSessionId,
        'official-image-2.png'
      );
      await mkdir(join(home, '.codex', 'generated_images', externalSessionId), { recursive: true });
      await writeFile(imagePath, Buffer.from('official-native-image'));
      await writeFile(secondImagePath, Buffer.from('official-native-image-2'));
      const session = internals.runtime.createAgentSession({
        workspaceId: workspace.id,
        runner: 'codex',
        cwd: workspace.path,
        externalSessionId
      });
      Object.assign(internals.codexClient.client, {
        async start() {},
        async listThreadTurns(_threadId: string) {
          return {
            nextCursor: null,
            data: [
              {
                id: 'native-history-image-turn',
                itemsView: 'full',
                status: 'completed',
                startedAt: '2026-08-17T00:00:00.000Z',
                completedAt: '2026-08-17T00:00:01.000Z',
                items: [
                  {
                    type: 'imageGeneration',
                    id: 'image-tool-1',
                    savedPath: imagePath,
                    status: 'completed'
                  },
                  {
                    type: 'imageGeneration',
                    id: 'image-tool-2',
                    savedPath: secondImagePath,
                    status: 'completed'
                  }
                ]
              }
            ]
          };
        },
        stop() {}
      });
      const nativeRead = vi.spyOn(internals.conversationHistoryService, 'readNative');
      const page = (await operation(connector, 'session.turns.list', {
        sessionId: session.id
      })) as {
        turns: {
          runId: string | null;
          items: {
            kind: string;
            payload: { toolCategory?: string; attachments?: unknown[] };
          }[];
        }[];
      };
      expect(nativeRead).not.toHaveBeenCalled();
      expect(page.turns[0]).toMatchObject({ runId: null });
      expect(page.turns[0]?.items).toHaveLength(2);
      expect(page.turns[0]?.items.map((item) => item.payload.toolCategory)).toEqual([
        'IMAGE_GENERATION',
        'IMAGE_GENERATION'
      ]);
      const attachments = page.turns[0]?.items.flatMap((item) => item.payload.attachments ?? []);
      expect(attachments).toEqual([
        expect.objectContaining({
          name: 'official-image.png',
          mime: 'image/png',
          runId: `native-history:${session.id}`,
          imageRef: expect.stringMatching(/^file:[^\s]+$/u)
        }),
        expect.objectContaining({
          name: 'official-image-2.png',
          mime: 'image/png',
          runId: `native-history:${session.id}`,
          imageRef: expect.stringMatching(/^file:[^\s]+$/u)
        })
      ]);
      const imageRefs = attachments!.map(
        (attachment) => (attachment as { imageRef: string }).imageRef
      );
      expect(imageRefs[0]).not.toBe(imageRefs[1]);
      for (const [imageRef, imageContent] of [
        [imageRefs[0]!, 'official-native-image'],
        [imageRefs[1]!, 'official-native-image-2']
      ] as const) {
        await expect(
          operation(connector, 'run.image.read', {
            runId: `native-history:${session.id}`,
            imageRef
          })
        ).resolves.toMatchObject({
          image: { dataBase64: Buffer.from(imageContent).toString('base64') }
        });
      }
    } finally {
      await connector.stop();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('ignores truncated JSONL and preserves local Runtime when official history is unavailable', async () => {
    const database = new NodeDatabase(':memory:', 'node-truncated-native-fallback');
    const workspace = database.saveWorkspace({
      path: '/workspace/truncated-native-fallback',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: process.version,
        codex: { available: true, version: 'codex-cli 0.147.0' },
        claudeCode: { available: false }
      }
    });
    const internals = connector as unknown as {
      conversationHistoryService: ConversationHistoryService;
      runtime: {
        createAgentSession(input: Record<string, unknown>): { id: string };
        createMessageRun(input: Record<string, unknown>): { run: { id: string } };
      };
      emitRunEvent(runId: string, eventType: string, payload: unknown, status?: string): void;
      readOfficialCodexConversation(): Promise<undefined>;
      readDirectNativeHistory(): Promise<{
        runner: 'codex';
        externalSessionId: string;
        cwd: string;
        digest: string;
        items: readonly unknown[];
        lastActivityAt: number;
        truncated: true;
      }>;
    };
    try {
      const session = internals.runtime.createAgentSession({
        workspaceId: workspace.id,
        runner: 'codex',
        cwd: workspace.path,
        externalSessionId: 'thread-truncated-native-fallback'
      });
      const run = internals.runtime.createMessageRun({
        sessionId: session.id,
        clientMessageId: 'truncated-native-fallback',
        content: 'preserve local content'
      }).run;
      internals.emitRunEvent(run.id, 'text.delta', { text: 'latest local runtime response' });
      internals.emitRunEvent(run.id, 'run.completed', { status: 'SUCCEEDED' }, 'SUCCEEDED');
      const readOfficial = vi.fn(async () => undefined);
      internals.conversationHistoryService.readOfficial = readOfficial;
      internals.conversationHistoryService.readNative = async () => ({
        runner: 'codex',
        externalSessionId: 'thread-truncated-native-fallback',
        cwd: workspace.path,
        digest: 'stale-window',
        items: [
          {
            kind: 'message',
            role: 'USER',
            text: 'latest question in truncated window',
            createdAt: 10
          },
          {
            kind: 'message',
            role: 'ASSISTANT',
            text: 'latest answer in truncated window',
            createdAt: 11
          }
        ],
        lastActivityAt: 11,
        truncated: true
      });

      await expect(
        operation(connector, 'session.turns.list', { sessionId: session.id })
      ).resolves.toMatchObject({
        source: 'runtime',
        turns: [
          expect.objectContaining({
            items: expect.arrayContaining([
              expect.objectContaining({
                payload: expect.objectContaining({ text: 'latest local runtime response' })
              })
            ])
          })
        ]
      });
      expect(readOfficial).toHaveBeenCalledOnce();
    } finally {
      await connector.stop();
    }
  });

  it('reports unavailable official history without falling back to truncated JSONL', async () => {
    const database = new NodeDatabase(':memory:', 'node-truncated-native-empty-runtime');
    const workspace = database.saveWorkspace({
      path: '/workspace/truncated-native-empty-runtime',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: process.version,
        codex: { available: true, version: 'codex-cli 0.147.0' },
        claudeCode: { available: false }
      }
    });
    const internals = connector as unknown as {
      conversationHistoryService: ConversationHistoryService;
      runtime: {
        createAgentSession(input: Record<string, unknown>): { id: string };
      };
      readOfficialCodexConversation(): Promise<undefined>;
      readDirectNativeHistory(): Promise<{
        runner: 'codex';
        externalSessionId: string;
        cwd: string;
        digest: string;
        items: readonly unknown[];
        lastActivityAt: number;
        truncated: true;
      }>;
    };
    try {
      const session = internals.runtime.createAgentSession({
        workspaceId: workspace.id,
        runner: 'codex',
        cwd: workspace.path,
        externalSessionId: 'thread-truncated-native-empty-runtime'
      });
      internals.conversationHistoryService.readOfficial = async () => undefined;
      internals.conversationHistoryService.readNative = async () => ({
        runner: 'codex',
        externalSessionId: 'thread-truncated-native-empty-runtime',
        cwd: workspace.path,
        digest: 'stale-window',
        items: [],
        lastActivityAt: 0,
        truncated: true
      });

      await expect(
        operation(connector, 'session.turns.list', { sessionId: session.id })
      ).rejects.toThrow('NATIVE_TRANSCRIPT_UNAVAILABLE');
    } finally {
      await connector.stop();
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
