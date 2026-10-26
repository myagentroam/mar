/** Read the Node-confirmed current branch from a Git Changes response. */
export function currentChangesBranch(value: unknown): string | null | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const branch = (value as { readonly branch?: unknown }).branch;
  if (branch === undefined) return undefined;
  return typeof branch === 'string' && branch.length > 0 ? branch : null;
}

export function workspaceAbsolutePath(root: string, path: string): string {
  if (path === '.') return root;
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  const parent = root.replace(separator === '\\' ? /\\+$/u : /\/+$/u, '');
  return `${parent}${separator}${path.replaceAll('/', separator)}`;
}

export function fileSizeLabel(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'] as const;
  let value = Math.max(0, bytes);
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 2,
    useGrouping: false
  }).format(value)} ${units[unitIndex]}`;
}
