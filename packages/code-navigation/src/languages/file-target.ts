export function localWorkspaceFileTarget(value: string): string | undefined {
  if (
    value.length === 0 ||
    /^[a-z][a-z\d+.-]*:/iu.test(value) ||
    value.startsWith('/') ||
    value.includes('?')
  )
    return undefined;
  const path = value.slice(0, value.indexOf('#') < 0 ? value.length : value.indexOf('#'));
  return path.length === 0 || path.includes('\\') ? undefined : path;
}
