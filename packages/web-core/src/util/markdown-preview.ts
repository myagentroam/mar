export function resolveMarkdownWorkspacePath(
  currentPath: string,
  target: string
): string | undefined {
  if (
    /^[a-z][a-z\d+.-]*:/i.test(target) ||
    target.startsWith('/') ||
    target.includes('?') ||
    target.includes('#')
  )
    return undefined;
  const parts = currentPath.split('/').slice(0, -1);
  for (const part of target.replaceAll('\\', '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length === 0 ? undefined : parts.join('/');
}

export function isExternalMarkdownImageUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}
