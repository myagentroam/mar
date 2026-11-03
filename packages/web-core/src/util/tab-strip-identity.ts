/** Stable DOM identities within one tab strip; the caller owns the unique prefix. */
export function tabStripIdentity(prefix: string, id: string | number) {
  const suffix = `${typeof id}-${String(id)
    .split('')
    .map((character) => character.charCodeAt(0).toString(16).padStart(4, '0'))
    .join('')}`;
  return { tab: `${prefix}-tab-${suffix}`, panel: `${prefix}-panel-${suffix}` };
}
