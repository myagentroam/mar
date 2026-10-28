import type { CodexCredentialOwnership } from '@myagentroam/protocol';

export function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function optionalString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : undefined;
}

export function parsePositiveInteger(value: unknown, maximum: number): number | undefined {
  const parsed =
    typeof value === 'string' && /^[0-9]+$/u.test(value) ? Number(value) : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : undefined;
}

export async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('CODEX_UPSTREAM_RESPONSE_INVALID');
  return value as Record<string, unknown>;
}

export function requiredString(value: unknown, maxLength: number): string {
  const parsed = optionalString(value, maxLength);
  if (parsed === undefined) throw new Error('CODEX_UPSTREAM_RESPONSE_INVALID');
  return parsed;
}

export function sameOwnership(
  left: CodexCredentialOwnership,
  right: CodexCredentialOwnership
): boolean {
  if (left.ownerType !== right.ownerType) return false;
  if (left.ownerType === 'PERSONAL' && right.ownerType === 'PERSONAL')
    return left.ownerUserId === right.ownerUserId;
  if (left.ownerType === 'ORGANIZATION' && right.ownerType === 'ORGANIZATION')
    return left.ownerOrganizationId === right.ownerOrganizationId;
  return true;
}
