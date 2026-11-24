import { describe, expect, it } from 'vitest';
import {
  browserAddress,
  browserAddressDestination,
  routeWorkbenchBrowserLink,
  DEFAULT_BROWSER_LINK_PREFERENCES
} from '../../src/service/browser-link-routing.js';

describe('Workbench Browser link routing', () => {
  it('keeps private addresses local to the Node and searches only when explicitly requested', () => {
    expect(browserAddressDestination('internal-host/status')).toBe('https://internal-host/status');
    expect(browserAddressDestination('https://internal-host:8443/status')).toBe(
      'https://internal-host:8443/status'
    );
    expect(browserAddressDestination('internal host')).toBeUndefined();
    expect(browserAddressDestination('? ')).toBeUndefined();
    expect(browserAddressDestination('? ' + 'a'.repeat(513))).toBeUndefined();
    const search = new URL(browserAddressDestination('? café & browser')!);
    expect(search.origin).toBe('https://www.google.com');
    expect([...search.searchParams]).toEqual([['q', 'café & browser']]);
  });
  const source = { nodeId: 'original-node', workspaceId: 'original-workspace' };
  it('reverses the selected destination without rewriting the original target or scope', () => {
    const local = { kind: 'url' as const, source, url: 'HTTP://localhost:8080/path?q=1#tab' };
    const web = { kind: 'url' as const, source, url: 'https://example.org/a' };
    const html = { kind: 'html' as const, source, path: 'doc/index.HTM' };
    for (const [link, normal, alternate] of [
      [local, 'mar', 'external'],
      [web, 'external', 'mar'],
      [html, 'mar', 'external']
    ] as const) {
      expect(routeWorkbenchBrowserLink(link, DEFAULT_BROWSER_LINK_PREFERENCES)).toEqual({
        destination: normal,
        link
      });
      expect(routeWorkbenchBrowserLink(link, DEFAULT_BROWSER_LINK_PREFERENCES, true)).toEqual({
        destination: alternate,
        link
      });
    }
    expect(routeWorkbenchBrowserLink(web, { web: 'mar', local: 'external' })?.destination).toBe(
      'mar'
    );
    expect(routeWorkbenchBrowserLink(local, { web: 'mar', local: 'external' })?.destination).toBe(
      'external'
    );
  });

  it('classifies only the two exact loopback names and rejects non-HTTP links', () => {
    const route = (url: string) =>
      routeWorkbenchBrowserLink({ kind: 'url', source, url }, DEFAULT_BROWSER_LINK_PREFERENCES);
    expect(route('http://127.0.0.1:6300/a')?.destination).toBe('mar');
    for (const url of ['http://127.1/a', 'http://localhost.example/a', 'http://[::1]/a'])
      expect(route(url)?.destination).toBe('external');
    expect(route('javascript:alert(1)')).toBeUndefined();
  });

  it('defaults bare addresses without applying link preferences', () => {
    expect(browserAddress(' example.org:8443/a?q=1#b ')).toBe('https://example.org:8443/a?q=1#b');
    expect(browserAddress('localhost:3000/x')).toBe('http://localhost:3000/x');
    expect(browserAddress('127.0.0.1:9820')).toBe('http://127.0.0.1:9820/');
    expect(browserAddress('https://localhost:3000/x')).toBe('https://localhost:3000/x');
    for (const address of [
      '',
      'hello world',
      'ftp://example.net/',
      'tel:123',
      'https://user:pass@example.net/'
    ])
      expect(browserAddress(address)).toBeUndefined();
  });
});
