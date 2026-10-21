import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  MODEL_USAGE_RETENTION_MS,
  modelUsageGrantClaimsSchema,
  modelUsageGrantSchema,
  type ModelUsageGrant,
  type ModelUsageGrantClaims
} from '@myagentroam/protocol';

/** Domain-separated signatures do not confer execution or credential access. */
export class ModelUsageGrants {
  constructor(
    private readonly key: Uint8Array,
    private readonly now: () => number = Date.now
  ) {}

  issue(nodeId: string, userId: number, mode: 'work' | 'conversation'): ModelUsageGrant {
    const issuedAt = this.now();
    const claims = modelUsageGrantClaimsSchema.parse({
      audience: 'model-usage-v1',
      scopeId: randomUUID(),
      nodeId,
      userId,
      mode,
      issuedAt,
      expiresAt: issuedAt + MODEL_USAGE_RETENTION_MS
    });
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return { scopeId: claims.scopeId, token: `${body}.${this.sign(body)}` };
  }

  verify(nodeId: string, value: unknown): ModelUsageGrantClaims | undefined {
    const parsed = modelUsageGrantSchema.safeParse(value);
    if (!parsed.success) return;
    const [body, signature, extra] = parsed.data.token.split('.');
    if (!body || !signature || extra !== undefined) return;
    const actual = Buffer.from(signature);
    const expected = Buffer.from(this.sign(body));
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return;
    try {
      const claims = modelUsageGrantClaimsSchema.parse(
        JSON.parse(Buffer.from(body, 'base64url').toString())
      );
      if (
        claims.nodeId !== nodeId ||
        claims.scopeId !== parsed.data.scopeId ||
        claims.expiresAt < this.now() ||
        claims.issuedAt > this.now() + 3_600_000 ||
        claims.expiresAt - claims.issuedAt !== MODEL_USAGE_RETENTION_MS
      )
        return;
      return claims;
    } catch {
      return;
    }
  }

  private sign(body: string): string {
    return createHmac('sha256', this.key)
      .update('mar:model-usage:v1\0')
      .update(body)
      .digest('base64url');
  }
}
