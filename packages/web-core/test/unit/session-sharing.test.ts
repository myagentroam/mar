import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionShareAccessService } from '../../src/service/session-share-access-service.js';
import { createSessionShareManagementService } from '../../src/service/session-share-management-service.js';
import { createSessionShareClientService } from '../../src/service/session-share-client-service.js';
import { createSessionShareConversationService } from '../../src/service/session-share-conversation-service.js';
import {
  createStandaloneFileWindowService,
  standaloneFileOpenIntent
} from '../../src/service/standalone-file-window-service.js';

const share = {
  id: 'share-one',
  nodeId: 'node',
  workspaceId: 'workspace',
  sessionId: 'session',
  createdAt: 10,
  expiresAt: null
};
const auth = { share, credential: 'a'.repeat(43), sharerName: 'Owner' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    }
  };
}

describe('Web session sharing', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('synchronizes an open name prompt across tabs and releases its storage listener on disposal', async () => {
    const browser = storage();
    const events = new EventTarget();
    vi.stubGlobal('window', events);
    const first = createSessionShareAccessService(share.id, { storage: browser });
    const second = createSessionShareAccessService('second-link', { storage: browser });
    const naming = second.ensureNamed();
    expect(second.nameRequired.value).toBe(true);
    first.setName('Alice');
    const changed = () =>
      events.dispatchEvent(
        Object.assign(new Event('storage'), { key: 'mar:session-share:visitor' })
      );
    changed();
    await expect(naming).resolves.toBe(true);
    expect(second.visitor.value.name).toBe('Alice');
    expect(second.nameRequired.value).toBe(false);
    second.dispose();
    first.setName('Bob');
    changed();
    expect(second.visitor.value.name).toBe('Alice');
    first.dispose();
  });
  it('does not overwrite a name from another open link during authentication or invalidation', async () => {
    const browser = storage();
    const transport = vi.fn<typeof fetch>(async () => json(auth));
    const first = createSessionShareAccessService(share.id, { storage: browser, fetch: transport });
    const second = createSessionShareAccessService('second-link', {
      storage: browser,
      fetch: transport
    });
    first.setName('Alice');
    await second.authenticate('000123');
    expect(JSON.parse(browser.getItem('mar:session-share:visitor')!).name).toBe('Alice');
    second.invalidate('SESSION_SHARE_NOT_FOUND');
    expect(JSON.parse(browser.getItem('mar:session-share:visitor')!).name).toBe('Alice');
    const named = second.ensureNamed();
    expect(second.nameRequired.value).toBe(false);
    await expect(named).resolves.toBe(true);
    expect(second.visitor.value.name).toBe('Alice');
  });
  it('shares browser display identity across links while keeping access credentials isolated', async () => {
    const browser = storage();
    const transport = vi.fn<typeof fetch>(async (url) =>
      json({
        ...auth,
        share: { ...share, id: String(url).includes('second-link') ? 'second-link' : share.id }
      })
    );
    const first = createSessionShareAccessService(share.id, { storage: browser, fetch: transport });
    await first.authenticate('000123');
    first.setName('Alice');
    const second = createSessionShareAccessService('second-link', {
      storage: browser,
      fetch: transport
    });
    expect(second.visitor.value).toEqual(first.visitor.value);
    expect(second.session.value).toBeUndefined();
    await second.authenticate();
    expect(transport).toHaveBeenCalledTimes(1);
    first.invalidate('SESSION_SHARE_NOT_FOUND');
    expect(
      createSessionShareAccessService('second-link', { storage: browser, fetch: transport }).visitor
        .value.name
    ).toBe('Alice');
  });

  it.each([false, true])(
    'recovers once on Node recovery or takeover without losing the draft (initially offline: %s)',
    async (initiallyOffline) => {
      class Socket extends EventTarget {
        static readonly OPEN = 1;
        static current: Socket;
        readyState = 1;
        constructor(_url: string) {
          super();
          Socket.current = this;
        }
        send(_data: string): void {}
        close(): void {
          this.readyState = 3;
        }
        emit(value: unknown): void {
          this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
        }
      }
      vi.stubGlobal('WebSocket', Socket);
      vi.stubGlobal('window', { location: { origin: 'https://share.example' } });
      vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
      const watches: { watchId: string; mode: string }[] = [];
      let nodeOnline = !initiallyOffline;
      const transport = vi.fn<typeof fetch>(async (url, init) => {
        const path = String(url);
        if (path.endsWith('/auth')) return json(auth);
        if (path.endsWith('/profiles')) return json({ profiles: [] });
        if (path.endsWith('/session'))
          return nodeOnline
            ? json({
                session: {
                  id: share.sessionId,
                  workspaceId: share.workspaceId,
                  runner: 'mar-agent',
                  activity: 'IDLE'
                }
              })
            : json({ error: { code: 'NODE_OFFLINE', message: 'The node is offline.' } }, 503);
        if (path.endsWith('/watch')) {
          if (init?.method === 'DELETE') return new Response(null, { status: 204 });
          watches.push(JSON.parse(String(init?.body)));
          return json({ nodeGeneration: 'generation' });
        }
        throw new Error('Unexpected share request: ' + path);
      });
      const access = createSessionShareAccessService(share.id, {
        storage: storage(),
        fetch: transport
      });
      await access.authenticate('001234');
      const notice = vi.fn();
      const chat = createSessionShareConversationService({
        access,
        beforeSend: async () => true,
        notice
      });
      const initial = () => watches.filter((watch) => watch.mode === 'initial');
      const snapshot = () =>
        Socket.current.emit({
          type: 'watch.event',
          event: {
            type: 'watch.session.snapshot',
            workbenchConnectionId: 'connection',
            nodeGeneration: 'generation',
            nodeId: share.nodeId,
            workspaceId: share.workspaceId,
            sessionId: share.sessionId,
            watchId: initial().at(-1)!.watchId,
            payload: { unit: 'SEGMENT', segments: [], nextCursor: null, source: 'runtime' }
          }
        });
      try {
        await chat.start();
        Socket.current.emit({
          type: 'workbench.ready',
          workbenchConnectionId: 'connection',
          workbenchResumeToken: 'resume'
        });
        chat.input.value = 'Preserved during Node recovery';
        if (initiallyOffline) {
          await vi.waitFor(() => expect(chat.state.initialLoadFailed.value).toBe(true));
          expect(chat.ready.value).toBe(false);
          expect(access.session.value).toBeDefined();
          notice.mockClear();
          nodeOnline = true;
          Socket.current.emit({ type: 'node', nodeId: share.nodeId, connected: true });
        }
        await vi.waitFor(() => expect(initial()).toHaveLength(1));
        snapshot();
        await vi.waitFor(() => expect(chat.ready.value).toBe(true));
        Socket.current.emit({ type: 'node', nodeId: share.nodeId, connected: false });
        expect(chat.ready.value).toBe(false);
        Socket.current.emit({ type: 'node', nodeId: share.nodeId, connected: true });
        await vi.waitFor(() => expect(initial()).toHaveLength(2));
        // Replace a recovering watch before its snapshot arrives.
        Socket.current.emit({
          type: 'node',
          nodeId: share.nodeId,
          connected: true,
          reason: 'CONNECTION_REPLACED'
        });
        await vi.waitFor(() => expect(initial()).toHaveLength(3));
        expect(chat.state.initialLoadFailed.value).toBe(false);
        expect(chat.state.loadingInitial.value).toBe(true);
        snapshot();
        await vi.waitFor(() => expect(chat.ready.value).toBe(true));
        Socket.current.emit({ type: 'node', nodeId: share.nodeId, connected: false });
        // The Node returns while this browser is disconnected, so its online frame is missed.
        document.dispatchEvent(new Event('visibilitychange'));
        Socket.current.emit({
          type: 'workbench.ready',
          workbenchConnectionId: 'connection',
          workbenchResumeToken: 'resume',
          resumed: true
        });
        await vi.waitFor(() => expect(initial()).toHaveLength(4));
        snapshot();
        await vi.waitFor(() => expect(chat.ready.value).toBe(true));
        expect(chat.input.value).toBe('Preserved during Node recovery');
        expect(chat.state.initialLoadFailed.value).toBe(false);
        expect(notice).not.toHaveBeenCalled();
      } finally {
        chat.dispose();
      }
    }
  );

  it('waits for a name outside the submission gate and resumes or cancels the pending intent', async () => {
    const access = createSessionShareAccessService('share-one', {
      storage: storage(),
      fetch: vi.fn()
    });
    const pending = access.ensureNamed();
    expect(access.ensureNamed()).toBe(pending);
    expect(access.nameRequired.value).toBe(true);
    access.cancelName();
    expect(await pending).toBe(false);
    const retry = access.ensureNamed();
    access.setName('Alice');
    expect(await retry).toBe(true);
    expect(await access.ensureNamed()).toBe(true);
  });

  it('adapts only fixed-target resources, injects provenance identity, and refuses account-only APIs', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(json({ delivery: 'QUEUED' }));
    const access = createSessionShareAccessService('share-one', {
      storage: storage(),
      fetch: transport
    });
    access.setName('Alice');
    const client = createSessionShareClientService(access, share);
    await client.request('/api/agent-sessions/session/messages', {
      method: 'POST',
      body: JSON.stringify({ nodeId: 'other', workspaceId: 'other', content: 'hello' })
    });
    expect(transport.mock.calls[0]?.[0]).toBe(access.base + '/messages');
    expect(JSON.parse(transport.mock.calls[0]?.[1]?.body as string)).toEqual({
      content: 'hello',
      visitor: access.visitor.value
    });
    expect(
      client.resourceUrl('/api/workspaces/workspace/files/content?nodeId=node&path=report.pdf')
    ).toBe(access.base + '/files/content?path=report.pdf');
    await expect(client.request('/api/agent-sessions/other/messages')).rejects.toMatchObject({
      code: 'SESSION_SHARE_INPUT_INVALID'
    });
    await expect(client.request('/api/workspaces/workspace/files/write')).rejects.toMatchObject({
      code: 'SESSION_SHARE_INPUT_INVALID'
    });
    await expect(client.request('/api/prompt-completions')).rejects.toMatchObject({
      code: 'SESSION_SHARE_INPUT_INVALID'
    });
    expect(transport).toHaveBeenCalledOnce();
  });

  it('isolates file window reuse from Console and other shares for every preview mode', () => {
    const popup = {
      closed: false,
      location: { replace: vi.fn() },
      dispatchEvent: vi.fn(() => true),
      focus: vi.fn()
    } as unknown as Window;
    const open = vi.fn<(url?: string, target?: string) => Window>(() => popup);
    const windows = createStandaloneFileWindowService(open, 'share:share-one');
    expect(windows.open('/console?standaloneFile=1&path=a')).toBeUndefined();
    expect(windows.open('/share/other?standaloneFile=1&path=a')).toBeUndefined();
    windows.open('/share/share-one?standaloneFile=1&path=a');
    windows.open('/share/share-one?standaloneFile=1&path=b');
    windows.open('/share/share-one?standaloneFile=1&markdownPreview=1&path=a.md');
    windows.open('/share/share-one?standaloneFile=1&htmlPreview=1&path=a.html');
    expect(open.mock.calls.map((call) => call[1])).toEqual([
      'mar-file-preview:share:share-one',
      'mar-markdown-preview:share:share-one',
      'mar-html-preview:share:share-one'
    ]);
    expect(
      standaloneFileOpenIntent(
        '/share/share-one?standaloneFile=1&nodeId=node&workspaceId=workspace&path=a'
      )
    ).toBeUndefined();
  });
  it('restores a link credential and name without saving the password or using Console authentication', async () => {
    const local = storage();
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => json(auth));
    const first = createSessionShareAccessService('share-one', {
      storage: local,
      fetch: transport
    });
    expect(await first.authenticate()).toBe(false);
    await first.authenticate('001234');
    first.setName('访客');
    const second = createSessionShareAccessService('share-one', {
      storage: local,
      fetch: transport
    });
    await second.authenticate();
    expect(second.visitor.value).toEqual(first.visitor.value);
    expect(transport.mock.calls[1]?.[0]).toBe('/api/session-shares/share-one/auth');
    expect(JSON.parse(transport.mock.calls[1]?.[1]?.body as string)).toEqual({
      credential: auth.credential
    });
    expect([...local.values.values()].join('')).not.toContain('001234');
    expect(transport.mock.calls[0]?.[1]?.headers).not.toHaveProperty('x-csrf-token');
    const other = createSessionShareAccessService('other-share', {
      storage: local,
      fetch: transport
    });
    expect(await other.authenticate()).toBe(false);
    expect(other.visitor.value.visitorId).toBe(first.visitor.value.visitorId);
  });

  it('retains access on Node outages but invalidates only this share when revoked', async () => {
    const local = storage();
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(auth))
      .mockResolvedValueOnce(
        json({ error: { code: 'NODE_OFFLINE', message: 'The node is offline.' } }, 503)
      )
      .mockResolvedValueOnce(
        json({ error: { code: 'SESSION_SHARE_NOT_FOUND', message: 'The share was deleted.' } }, 404)
      );
    local.setItem('workbench-login', 'preserved');
    const access = createSessionShareAccessService('share-one', {
      storage: local,
      fetch: transport
    });
    await access.authenticate('001234');
    await expect(access.request('/session')).rejects.toMatchObject({ code: 'NODE_OFFLINE' });
    expect(access.session.value).toBeDefined();
    await expect(access.request('/session')).rejects.toMatchObject({
      code: 'SESSION_SHARE_NOT_FOUND'
    });
    expect(access.session.value).toBeUndefined();
    expect(local.getItem('workbench-login')).toBe('preserved');
    expect(local.getItem('mar:session-share:share-one')).not.toContain(auth.credential);
  });

  it('drops a late response after revocation and leaves malformed storage usable', async () => {
    const local = storage();
    local.setItem('mar:session-share:share-one', '{bad json');
    let resolve!: (response: Response) => void;
    const transport = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const access = createSessionShareAccessService('share-one', {
      storage: local,
      fetch: transport
    });
    const pending = access.authenticate('001234');
    access.invalidate('SESSION_SHARE_EXPIRED');
    resolve(json(auth));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(access.session.value).toBeUndefined();
    expect(() => access.setName('   ')).toThrow();
  });

  it('keeps UI password state in dialog memory and deletes records through the fixed session target', async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce({ shares: [] })
      .mockResolvedValueOnce({ share, password: '000123' })
      .mockResolvedValueOnce(undefined);
    const service = createSessionShareManagementService(share, transport);
    await service.load();
    await service.create(null);
    expect(service.created.value?.password).toBe('000123');
    expect(service.shares.value).toEqual([share]);
    await service.remove(share.id);
    expect(service.shares.value).toEqual([]);
    expect(service.created.value).toBeUndefined();
    expect(transport.mock.calls[2]?.[0]).toBe(
      '/api/agent-sessions/session/shares/share-one?nodeId=node&workspaceId=workspace'
    );
  });

  it('copies historical passwords through management and supports restoring legacy records', async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce({ password: '000123' })
      .mockResolvedValueOnce({ password: null })
      .mockResolvedValueOnce({ password: '000123' });
    const service = createSessionShareManagementService(share, transport);
    expect(await service.copyPassword(share.id)).toBe('000123');
    expect(transport.mock.calls[0]).toEqual([
      '/api/agent-sessions/session/shares/share-one/copy?nodeId=node&workspaceId=workspace',
      { method: 'POST', body: '{}' }
    ]);
    expect(await service.copyPassword(share.id)).toBeNull();
    expect(await service.copyPassword(share.id, '000123')).toBe('000123');
    expect(transport.mock.calls[2]?.[1]?.body).toBe(JSON.stringify({ password: '000123' }));
  });
});
