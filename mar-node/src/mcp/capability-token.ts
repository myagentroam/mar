import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { z } from 'zod';

/** Signs process-local MCP claims; authorization and revocation belong to the Execution owner. */
export class McpCapabilityToken<T extends object> {
  constructor(
    private readonly purpose: string,
    private readonly schema: z.ZodType<T>,
    private readonly key: Buffer = randomBytes(32)
  ) {}

  sign(claims: T): string {
    const body = `v1.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
    return `${body}.${this.signature(body).toString('base64url')}`;
  }

  verify(token: unknown): T | undefined {
    if (typeof token !== 'string' || token.length > 8192) return undefined;
    const match = /^(v1\.[A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/u.exec(token);
    if (match === null) return undefined;
    const expected = this.signature(match[1]!);
    const received = Buffer.from(match[2]!, 'base64url');
    if (expected.length !== received.length || !timingSafeEqual(expected, received))
      return undefined;
    try {
      const value: unknown = JSON.parse(
        Buffer.from(match[1]!.slice(3), 'base64url').toString('utf8')
      );
      const parsed = this.schema.safeParse(value);
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  private signature(body: string): Buffer {
    return createHmac('sha256', this.key).update(`${this.purpose}\0${body}`).digest();
  }
}
