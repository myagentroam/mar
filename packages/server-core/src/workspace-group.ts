export const WORKSPACE_GROUP_NAME_MAX_LENGTH = 128;

export function normalizeWorkspaceGroupName(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > WORKSPACE_GROUP_NAME_MAX_LENGTH)
    throw new Error('WORKSPACE_GROUP_NAME_INVALID');
  return normalized;
}
