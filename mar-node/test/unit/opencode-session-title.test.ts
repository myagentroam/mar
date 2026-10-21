import { describe, expect, it, vi } from 'vitest';
import type { NodeAgentSession } from '../../src/database.js';
import { OpenCodeServerClient } from '../../src/opencode-server.js';
import { OpenCodeRunner } from '../../src/runner/opencode-runner.js';
import { openCodeUserMessagePreview } from '../../src/runner/opencode/conversation-parser.js';

describe('OpenCode Session title recovery', () => {
  it.each(['New session', 'Untitled session', 'New session - 2026-10-06T02:00:00.000Z'])(
    'restores %s from the first real user input across official message pages',
    async (title) => {
      const native = { id: 'native', directory: '/workspace', title, time: { updated: 2 } };
      const messagePage = vi.fn(
        async (_directory: string, _id: string, input: { limit: number; before?: string }) =>
          input.before === 'older'
            ? {
                messages: [
                  {
                    info: { id: 'system', role: 'user' },
                    parts: [{ type: 'text', text: 'Injected instructions', synthetic: true }]
                  },
                  {
                    info: { id: 'compact', role: 'user' },
                    parts: [{ type: 'compaction' }, { type: 'text', text: 'Compact history' }]
                  },
                  {
                    info: { id: 'first', role: 'user' },
                    parts: [{ type: 'text', text: '  去看升国旗吧\n需要五星红旗元素  ' }]
                  }
                ],
                nextCursor: null
              }
            : {
                messages: [
                  {
                    info: { id: 'later', role: 'user' },
                    parts: [{ type: 'text', text: 'Later message' }]
                  }
                ],
                nextCursor: 'older'
              }
      );
      const runner = new OpenCodeRunner({
        sessions: vi.fn(async () => [native]),
        session: vi.fn(async () => native),
        messagePage
      } as unknown as OpenCodeServerClient);
      const projection = vi.fn(
        (input) =>
          ({
            id: input.externalSessionId,
            runnerTitle: input.title
          }) as NodeAgentSession
      );
      const workspace = {
        id: 'workspace',
        path: '/workspace',
        kind: 'DIRECTORY' as const,
        gitSummary: null
      };
      const context = { workspaces: [], createProjection: projection };
      const [discovered, titleRead] = await Promise.all([
        runner.discoverSessions(context, workspace),
        runner.readManagedRunnerTitle({
          externalSessionId: 'native',
          cwd: '/workspace'
        } as NodeAgentSession)
      ]);
      expect(discovered[0]?.runnerTitle).toBe('去看升国旗吧 需要五星红旗元素');
      expect(titleRead).toBe('去看升国旗吧 需要五星红旗元素');
      expect(projection).toHaveBeenCalledWith(expect.objectContaining({ titleOrigin: 'PREVIEW' }));
      expect(messagePage).toHaveBeenCalledTimes(2);
      expect(messagePage.mock.calls.map((call) => call[2])).toEqual([
        { limit: 100 },
        { limit: 100, before: 'older' }
      ]);
      await runner.discoverSessions(context, workspace);
      expect(messagePage).toHaveBeenCalledTimes(2);
      native.title = 'Generated official title';
      expect(
        await runner.readManagedRunnerTitle({
          externalSessionId: 'native',
          cwd: '/workspace'
        } as NodeAgentSession)
      ).toBe(native.title);
      expect(messagePage).toHaveBeenCalledTimes(2);
    }
  );

  it('bounds user previews and excludes ignored, synthetic and non-user text', () => {
    expect(
      openCodeUserMessagePreview([
        { info: { id: 'agent', role: 'assistant' }, parts: [{ type: 'text', text: 'Agent text' }] },
        {
          info: { id: 'ignored', role: 'user' },
          parts: [{ type: 'text', text: 'Ignored', ignored: true }]
        },
        { info: { id: 'empty', role: 'user' }, parts: [{ type: 'text', text: '  ' }] },
        {
          info: { id: 'first', role: 'user' },
          parts: [{ type: 'text', text: ' first\n' + '国旗'.repeat(100) }]
        }
      ])
    ).toBe(('first ' + '国旗'.repeat(100)).slice(0, 160));
  });

  it('keeps native placeholders on paging failure and retries without caching partial previews', async () => {
    const native = {
      id: 'native',
      directory: '/workspace',
      title: 'New session',
      time: { updated: 2 }
    };
    const messagePage = vi.fn(
      async (): Promise<{ messages: readonly unknown[]; nextCursor: string | null }> => ({
        messages: [
          {
            info: { id: 'later', role: 'user' },
            parts: [{ type: 'text', text: 'Not the first input' }]
          }
        ],
        nextCursor: 'repeated'
      })
    );
    const runner = new OpenCodeRunner({
      session: async () => native,
      messagePage
    } as unknown as OpenCodeServerClient);
    const session = { externalSessionId: 'native', cwd: '/workspace' } as NodeAgentSession;
    expect(await runner.readManagedRunnerTitle(session)).toBe('New session');
    messagePage.mockResolvedValue({ messages: [], nextCursor: null });
    expect(await runner.readManagedRunnerTitle(session)).toBe('New session');
    native.time.updated++;
    messagePage.mockResolvedValue({
      messages: [
        { info: { id: 'first', role: 'user' }, parts: [{ type: 'text', text: 'First input' }] }
      ],
      nextCursor: null
    });
    expect(await runner.readManagedRunnerTitle(session)).toBe('First input');
  });

  it('forwards official message cursors and reads the response next-cursor header', async () => {
    const messages = vi.fn(async () => ({
      data: [],
      response: new Response(null, { headers: { 'X-Next-Cursor': 'opaque-before' } })
    }));
    const client = new OpenCodeServerClient();
    (client as unknown as { client: unknown }).client = { session: { messages } };
    expect(
      await client.messagePage('/workspace', 'native', { limit: 100, before: 'older' })
    ).toEqual({ messages: [], nextCursor: 'opaque-before' });
    expect(messages).toHaveBeenCalledWith({
      directory: '/workspace',
      sessionID: 'native',
      limit: 100,
      before: 'older'
    });
  });
});
