import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  managementUrlValues,
  replaceManagementUrlValues
} from '../../src/service/management-url-service.js';

afterEach(() => vi.unstubAllGlobals());

describe('management filter URL state', () => {
  it('reads only declared nonempty filters in the selected namespace', () => {
    expect(
      managementUrlValues('resources', ['keyword', 'status', 'missing'], {
        search: '?resources.keyword=hello%20world&resources.status=&other.keyword=private'
      })
    ).toEqual({ keyword: 'hello world' });
  });

  it('updates only selected filters and preserves navigation, hash and other namespaces', () => {
    const replaceState = vi.fn();
    const historyState = { __marMobileMenu: 'menu-existing', unrelated: 'keep' };
    vi.stubGlobal('window', {
      location: {
        href: 'https://example.test/console?view=management&nodes.status=online&nodes.keyword=old&skills.keyword=tools#details'
      },
      history: { replaceState, state: historyState }
    });
    replaceManagementUrlValues('nodes', { status: undefined, keyword: 'café & /', page: 0 });
    expect(replaceState).toHaveBeenCalledOnce();
    const [state, title, target] = replaceState.mock.calls[0]!;
    expect(state).toBe(historyState);
    expect(title).toBe('');
    const url = new URL(target as string, 'https://example.test');
    expect(url.pathname).toBe('/console');
    expect(url.hash).toBe('#details');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      view: 'management',
      'nodes.keyword': 'café & /',
      'nodes.page': '0',
      'skills.keyword': 'tools'
    });
  });

  it('clears empty filters without writing form or unrelated state', () => {
    const replaceState = vi.fn();
    vi.stubGlobal('window', {
      location: { href: 'https://example.test/console?secrets.keyword=old&view=management' },
      history: { replaceState, state: null }
    });
    replaceManagementUrlValues('secrets', { keyword: '' });
    expect(replaceState).toHaveBeenCalledWith(null, '', '/console?view=management');
  });
});
