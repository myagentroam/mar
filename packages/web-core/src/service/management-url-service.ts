import { captureMobileLayerRoute } from './mobile-layer-history-service.js';
export function managementUrlValues(
  namespace: string,
  keys: readonly string[],
  location: Pick<Location, 'search'> = window.location
): Readonly<Record<string, string>> {
  const query = new URLSearchParams(location.search);
  return Object.fromEntries(
    keys.flatMap((key) => {
      const value = query.get(`${namespace}.${key}`);
      return value === null || value === '' ? [] : [[key, value]];
    })
  );
}

export function replaceManagementUrlValues(
  namespace: string,
  values: Readonly<Record<string, string | number | undefined>>
): void {
  const url = new URL(window.location.href);
  for (const key of Object.keys(values)) {
    const value = values[key];
    if (value === undefined || value === '') url.searchParams.delete(`${namespace}.${key}`);
    else url.searchParams.set(`${namespace}.${key}`, String(value));
  }
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  captureMobileLayerRoute();
}
