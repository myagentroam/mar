/** Removes relay-only authorization context before strict business input validation. */
export function nodeOperationData(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const data = { ...(raw as Record<string, unknown>) };
  delete data['__requestUserId'];
  delete data['__workspaceWatchSessionHash'];
  return data;
}
