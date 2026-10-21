import { afterEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { parseWorkbenchRoute } from '../../src/util/workbench-route.js';
import { createWorkbenchRouteService } from '../../src/service/WorkbenchRouteService.js';

describe('Shared workbench routes', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['?view=conversations&node=n&conversation=c', { nodeId: 'n', conversationId: 'c' }],
    ['?view=nodes&node=n&conversation=c', undefined],
    ['?view=conversations&node=n', undefined],
    ['?view=conversations&node=&conversation=c', undefined],
    ['?view=unknown&node=n&conversation=c', undefined]
  ])('restores only a complete Hosted target: %s', (search, expected) => {
    expect(parseWorkbenchRoute({ search }).hostedConversation).toEqual(expected);
  });

  it('does not interpret product management identifiers', () => {
    expect(parseWorkbenchRoute({ search: '?view=management&management=users' })).toEqual({
      view: 'management'
    });
    expect(parseWorkbenchRoute({ search: '?node=n&workspace=w&session=s' })).toEqual({
      nodeId: 'n',
      workspaceId: 'w',
      sessionId: 's'
    });
  });

  it('synchronizes Hosted, work, settings and opaque management routes without losing unrelated URL fields', () => {
    let url = new URL(
      'https://example.test/console?view=conversations&node=n&conversation=c&skill=old&keep=1#anchor'
    );
    const replaceState = vi.fn((_state: unknown, _title: string, value: string) => {
      url = new URL(value, url);
    });
    vi.stubGlobal('window', {
      get location() {
        return url;
      },
      history: { replaceState }
    });
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
    const view = ref<'nodes' | 'conversations' | 'settings' | 'management'>('conversations');
    const selectedHostedNodeId = ref<string | undefined>('node / one');
    const selectedHostedConversationId = ref<string | undefined>('conversation&two');
    const service = createWorkbenchRouteService({
      nodes: ref([]),
      sessions: ref([]),
      workspaceTarget: ref(),
      selectedSessionId: ref(),
      view,
      managementSection: ref('custom-section'),
      selectedHostedNodeId,
      selectedHostedConversationId,
      activateWorkspace: vi.fn(async () => true),
      synchronizeSessions: vi.fn(async () => []),
      openSession: vi.fn(async () => undefined),
      lookupSession: vi.fn(async () => undefined),
      openDraft: vi.fn(),
      notice: vi.fn()
    });
    expect(service.hostedConversationRoute).toEqual({ nodeId: 'n', conversationId: 'c' });
    service.sync();
    expect(url.searchParams.get('node')).toBe('node / one');
    expect(url.searchParams.get('conversation')).toBe('conversation&two');
    expect(url.searchParams.has('skill')).toBe(false);
    selectedHostedConversationId.value = undefined;
    service.sync();
    expect(url.searchParams.has('node')).toBe(false);
    expect(url.searchParams.has('conversation')).toBe(false);
    view.value = 'management';
    service.sync();
    expect(url.searchParams.get('management')).toBe('custom-section');
    view.value = 'settings';
    service.sync();
    expect(url.searchParams.has('management')).toBe(false);
    view.value = 'nodes';
    service.sync();
    expect(url.pathname + url.search + url.hash).toBe('/console?keep=1#anchor');
    expect(replaceState).toHaveBeenCalledTimes(5);
  });
});
