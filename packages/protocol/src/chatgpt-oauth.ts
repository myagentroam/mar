import { z } from 'zod';

export const CHATGPT_ISSUER = 'https://auth.openai.com';
export const CHATGPT_RESOURCE = 'https://api.openai.com/v1';
export const CHATGPT_TOKEN_ENDPOINT = `${CHATGPT_ISSUER}/api/accounts/oauth/token`;
export const CHATGPT_JWKS_ENDPOINT = `${CHATGPT_ISSUER}/.well-known/jwks.json`;
export const CHATGPT_REVOKE_ENDPOINT = `${CHATGPT_ISSUER}/api/accounts/oauth/revoke`;
export const CHATGPT_PLAN_SCOPE = 'chatgpt.tokens.use.direct';
export const CHATGPT_REQUESTED_SCOPE =
  'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';

const identifier = z.string().min(1).max(512);
export const chatgptTokenResponseSchema = z
  .object({
    access_token: z.string().min(1).max(131_072),
    refresh_token: z.string().min(1).max(131_072).optional(),
    id_token: z.string().min(1).max(131_072).optional(),
    token_type: z.literal('Bearer'),
    expires_in: z.number().int().positive().max(86_400),
    scope: z.string().max(8192),
    earliest_refresh_at: z.number().int().nonnegative().optional()
  })
  .strip();
export type ChatgptTokenResponse = z.infer<typeof chatgptTokenResponseSchema>;
export const chatgptLoginStartSchema = z
  .object({
    attemptId: identifier,
    nonce: z.string().min(32).max(256),
    clientId: identifier.optional(),
    subject: identifier.optional(),
    socks5Url: z.string().url().max(2048).optional()
  })
  .strict();
export const chatgptLoginResultSchema = z
  .object({
    attemptId: identifier,
    clientId: identifier,
    hostId: identifier,
    tokens: chatgptTokenResponseSchema
  })
  .strict();
export type ChatgptLoginResult = z.infer<typeof chatgptLoginResultSchema>;
export const chatgptNodeLoginStatusSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('PENDING'),
      verificationUri: z.string().url().max(2048),
      expiresAt: z.number().int().nonnegative()
    })
    .strict(),
  z.object({ status: z.literal('SUCCEEDED'), result: chatgptLoginResultSchema }).strict(),
  z
    .object({ status: z.literal('FAILED'), code: z.string().regex(/^CHATGPT_[A-Z0-9_]{1,64}$/u) })
    .strict()
]);
export const chatgptLoginCapabilitySchema = z
  .object({
    apiVersion: z.literal(1),
    loopback: z.literal(true)
  })
  .strict();

/** Verify the identity at a trust boundary. Hosts fetch the fixed OpenAI JWKS endpoint. */
export async function verifyChatgptIdentity(
  token: string,
  jwks: unknown,
  expected: {
    clientId: string;
    nonce?: string | undefined;
    subject?: string | undefined;
    now?: number | undefined;
  }
): Promise<{ subject: string; email?: string }> {
  try {
    if (token.length > 131_072) throw new Error();
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error();
    const decode = (part: string): Uint8Array =>
      Uint8Array.from(atob(part.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));
    const header = z
      .object({ alg: z.literal('RS256'), kid: identifier })
      .parse(JSON.parse(new TextDecoder().decode(decode(parts[0]!))));
    const claims = z
      .object({
        iss: z.literal(CHATGPT_ISSUER),
        sub: identifier,
        aud: z.union([identifier, identifier.array().min(1).max(16)]),
        exp: z.number().int(),
        iat: z.number().int().optional(),
        nonce: identifier.optional(),
        email: z.string().max(512).optional()
      })
      .parse(JSON.parse(new TextDecoder().decode(decode(parts[1]!))));
    const now = (expected.now ?? Date.now()) / 1000;
    if (
      claims.exp <= now ||
      (claims.iat !== undefined && claims.iat > now + 60) ||
      !(Array.isArray(claims.aud)
        ? claims.aud.includes(expected.clientId)
        : claims.aud === expected.clientId) ||
      (expected.nonce !== undefined && claims.nonce !== expected.nonce) ||
      (expected.subject !== undefined && claims.sub !== expected.subject)
    )
      throw new Error();
    const keyset = z.object({ keys: z.array(z.record(z.unknown())).max(64) }).parse(jwks);
    const matching = keyset.keys.filter(
      (key) =>
        key['kid'] === header.kid &&
        key['kty'] === 'RSA' &&
        (key['alg'] === undefined || key['alg'] === 'RS256') &&
        (key['use'] === undefined || key['use'] === 'sig')
    );
    if (matching.length !== 1) throw new Error();
    const key = await crypto.subtle.importKey(
      'jwk',
      matching[0]!,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      decode(parts[2]!) as Uint8Array<ArrayBuffer>,
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
    if (!valid) throw new Error();
    return { subject: claims.sub, ...(claims.email === undefined ? {} : { email: claims.email }) };
  } catch {
    throw new Error('CHATGPT_IDENTITY_INVALID');
  }
}
