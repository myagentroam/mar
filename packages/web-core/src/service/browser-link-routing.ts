export type BrowserLinkDestination = 'mar' | 'external';
type Destination = BrowserLinkDestination;
export interface BrowserLinkPreferences {
  readonly web: Destination;
  readonly local: Destination;
}
export const DEFAULT_BROWSER_LINK_PREFERENCES: BrowserLinkPreferences = {
  web: 'external',
  local: 'mar'
};

export function browserLinkStorageKey(userId: number): string {
  return `mar.browser-links.v1.${userId}`;
}

export function readBrowserLinkPreferences(userId: number | undefined): BrowserLinkPreferences {
  if (userId === undefined) return DEFAULT_BROWSER_LINK_PREFERENCES;
  try {
    const stored = JSON.parse(localStorage.getItem(browserLinkStorageKey(userId)) ?? 'null');
    if (
      stored &&
      ['mar', 'external'].includes(stored.web) &&
      ['mar', 'external'].includes(stored.local)
    )
      return { web: stored.web, local: stored.local };
  } catch {
    /* Invalid or unavailable storage uses the documented defaults. */
  }
  return DEFAULT_BROWSER_LINK_PREFERENCES;
}

type Scope = { nodeId: string; workspaceId: string };
export type WorkbenchBrowserLink =
  { kind: 'url'; source: Scope; url: string } | { kind: 'html'; source: Scope; path: string };

function httpUrl(value: string): URL | undefined {
  const url = URL.parse(value);
  if (
    url &&
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    !url.username &&
    !url.password
  )
    return url;
}

export function isBrowserLoopback(address: string): boolean {
  return /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?=[/?#]|$)/iu.test(address);
}

/** Selects where an eligible, pre-resolved Workbench link opens. It never
 * grants access, interprets a raw file path, or handles in-page navigation. */
export function routeWorkbenchBrowserLink(
  link: WorkbenchBrowserLink,
  preferences: BrowserLinkPreferences,
  alternate = false
): { destination: Destination; link: WorkbenchBrowserLink } | undefined {
  let destination = preferences.local;
  if (link.kind === 'url') {
    const url = httpUrl(link.url);
    if (!url) return;
    if (!isBrowserLoopback(link.url)) destination = preferences.web;
  }
  return {
    link,
    destination: alternate ? (destination === 'mar' ? 'external' : 'mar') : destination
  };
}

/** Resolves only address-bar syntax, not authorization or link preferences. */
export function browserAddress(input: string): string | undefined {
  const value = input.trim();
  if (!value || /\s/u.test(value)) return;
  if (/^https?:\/\//iu.test(value)) return httpUrl(value)?.href;
  if (
    /^[a-z][a-z\d+.-]*:/iu.test(value) &&
    !/^(?:localhost|[\w-]+(?:\.[\w-]+)+):\d+(?=[/?#]|$)/iu.test(value)
  )
    return;
  const url = httpUrl(`https://${value}`);
  if (!url) return;
  if (isBrowserLoopback(`https://${value}`)) return httpUrl(`http://${value}`)?.href;
  return url.href;
}

/** A query is sent to a search provider only after an explicit `? ` prefix. */
export function browserAddressDestination(input: string): string | undefined {
  const value = input.trimStart();
  if (!/^\?\s/u.test(value)) return browserAddress(input);
  const query = value.slice(1).trim();
  if (!query || query.length > 512) return;
  const search = new URL('https://www.google.com/search');
  search.searchParams.set('q', query);
  return search.href;
}
