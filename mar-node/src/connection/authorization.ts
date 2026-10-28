import type { NodeEnvelope } from '@myagentroam/protocol';

const USER_AUTHORIZATION_CLOCK_SKEW_MS = 60 * 60 * 1_000;

export function validUserAuthorization(
  value: unknown,
  envelope: NodeEnvelope,
  operation: string,
  nodeId: string | undefined,
  now = Date.now()
): boolean {
  if (typeof value !== 'object' || value === null || nodeId === undefined) return false;
  const authorization = value as Record<string, unknown>;
  const modelResourceCapability =
    operation === 'model.resource.read' &&
    authorization.userId === 0 &&
    authorization.sessionHash === 'model-resource';
  return (
    (modelResourceCapability ||
      (typeof authorization.userId === 'number' &&
        Number.isSafeInteger(authorization.userId) &&
        authorization.userId > 0 &&
        typeof authorization.sessionHash === 'string' &&
        /^[A-Za-z0-9_-]{43}$/.test(authorization.sessionHash))) &&
    authorization.nodeId === nodeId &&
    authorization.operation === operation &&
    authorization.requestId === envelope.id &&
    typeof authorization.issuedAt === 'number' &&
    typeof authorization.expiresAt === 'number' &&
    Number.isSafeInteger(authorization.issuedAt) &&
    Number.isSafeInteger(authorization.expiresAt) &&
    authorization.expiresAt >= authorization.issuedAt &&
    authorization.issuedAt <= now + USER_AUTHORIZATION_CLOCK_SKEW_MS &&
    authorization.expiresAt >= now - USER_AUTHORIZATION_CLOCK_SKEW_MS &&
    authorization.expiresAt - authorization.issuedAt <= 15_000
  );
}
