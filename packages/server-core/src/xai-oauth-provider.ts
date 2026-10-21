import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  XAI_SUBSCRIPTION_PROXY_BASE_URL,
  codexCredentialUsageSchema,
  codexModelCatalogSchema,
  type CodexCredentialUsage,
  type CodexModelCatalog
} from '@myagentroam/protocol';
import type { CredentialRecord } from './credential-document.js';

const ISSUER = 'https://auth.x.ai';
const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
// Grok wire compatibility, not the MAR release version. Verified against x.ai/cli/stable.
const XAI_CLIENT_VERSION = '1.0.52';
const SCOPES = 'openid profile email offline_access grok-cli:access api:access';
const tokenSchema = z.object({
  access_token: z.string().min(1).max(131_072),
  refresh_token: z.string().min(1).max(131_072),
  token_type: z
    .string()
    .refine((value) => value.toLowerCase() === 'bearer')
    .default('Bearer'),
  expires_in: z.number().int().positive().max(31_536_000).optional(),
  scope: z.string().max(16_384).optional()
});
export type XaiTokens = z.infer<typeof tokenSchema>;
const deviceSchema = z.object({
  device_code: z.string().min(1).max(8192),
  user_code: z.string().trim().min(1).max(128),
  verification_uri: z.string().url().max(2048),
  verification_uri_complete: z.string().url().max(2048).optional(),
  expires_in: z.number().int().positive().max(1800),
  interval: z.number().int().positive().max(60).default(5)
});
export type XaiDeviceAuthorization = z.infer<typeof deviceSchema>;
export type XaiRequest = (
  url: string,
  method: string,
  proxy: string | undefined,
  headers: Record<string, string>,
  body?: string
) => Promise<Response>;

const messages = {
  XAI_REQUEST_FAILED:
    'The X subscription service could not be reached. Check the connection and SOCKS5 proxy.',
  XAI_DEVICE_AUTH_UNAVAILABLE:
    'X subscription device authorization is unavailable. Check the connection and proxy.',
  XAI_LOGIN_FAILED: 'X subscription authorization could not be completed. Start a new sign-in.',
  XAI_LOGIN_DENIED: 'X subscription authorization was denied.',
  XAI_LOGIN_CONFLICT: 'The credential changed during sign-in. Start a new sign-in.',
  XAI_RESPONSE_INVALID: 'The X subscription service returned an invalid or oversized response.',
  XAI_ENTITLEMENT_REQUIRED:
    'This account is not authorized for the requested X subscription service.',
  XAI_REFRESH_FAILED:
    'X subscription credentials could not be refreshed. Check the connection or sign in again.',
  XAI_USAGE_LOAD_FAILED: 'X subscription usage could not be loaded.',
  XAI_USAGE_RATE_LIMITED: 'X subscription usage requests are rate limited. Try again later.',
  XAI_CATALOG_LOAD_FAILED: 'The X subscription model catalog could not be loaded.'
} as const;
export class XaiOAuthError extends Error {
  readonly publicMessage: string;
  constructor(
    readonly code: keyof typeof messages,
    readonly publicDetails?: string
  ) {
    super(code);
    this.publicMessage = messages[code];
  }
}

/** Owns xAI's wire contract; storage, permissions and refresh serialization belong to the service. */
export class XaiOAuthProvider {
  constructor(
    private readonly request: XaiRequest,
    private readonly version: string
  ) {}

  headers(accountId?: string): Record<string, string> {
    return {
      'x-xai-token-auth': 'xai-grok-cli',
      'x-grok-client-identifier': 'myagentroam',
      'x-grok-client-version': XAI_CLIENT_VERSION,
      'x-grok-client-mode': 'headless',
      'user-agent': `MyAgentRoam/${this.version}`,
      ...(accountId === undefined ? {} : { 'x-userid': accountId })
    };
  }

  async start(proxy?: string): Promise<XaiDeviceAuthorization> {
    const response = await this.form(
      '/oauth2/device/code',
      {
        client_id: CLIENT_ID,
        scope: SCOPES
      },
      proxy
    );
    assertResponse(response, 'XAI_DEVICE_AUTH_UNAVAILABLE');
    const device = parse(deviceSchema, await json(response));
    // Only xAI-controlled HTTPS authorization pages may be offered to the browser.
    for (const address of [device.verification_uri, device.verification_uri_complete]) {
      if (address === undefined) continue;
      const url = new URL(address);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.port ||
        !['auth.x.ai', 'accounts.x.ai', 'grok.com'].includes(url.hostname)
      )
        throw new XaiOAuthError('XAI_RESPONSE_INVALID');
    }
    return device;
  }

  async poll(
    deviceCode: string,
    proxy?: string
  ): Promise<
    { state: 'pending' | 'slow_down' | 'expired' } | { state: 'success'; tokens: XaiTokens }
  > {
    const response = await this.form(
      '/oauth2/token',
      {
        client_id: CLIENT_ID,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode
      },
      proxy
    );
    const body = await json(response);
    if (response.ok) return { state: 'success', tokens: parse(tokenSchema, body) };
    const code = record(body)['error'];
    if (code === 'authorization_pending') return { state: 'pending' };
    if (code === 'slow_down') return { state: 'slow_down' };
    if (code === 'expired_token') return { state: 'expired' };
    if (code === 'access_denied' || code === 'authorization_denied')
      throw new XaiOAuthError('XAI_LOGIN_DENIED');
    throw new XaiOAuthError('XAI_LOGIN_FAILED', `Token exchange returned HTTP ${response.status}.`);
  }

  async identity(tokens: XaiTokens, proxy?: string) {
    const response = await this.request(`${ISSUER}/oauth2/userinfo`, 'GET', proxy, {
      authorization: `Bearer ${tokens.access_token}`,
      accept: 'application/json'
    });
    assertResponse(response, 'XAI_LOGIN_FAILED');
    const identity = parse(z.object({ sub: z.string().min(1).max(512) }), await json(response));
    const user = await this.request(`${XAI_SUBSCRIPTION_PROXY_BASE_URL}/user`, 'GET', proxy, {
      ...this.headers(),
      authorization: `Bearer ${tokens.access_token}`,
      accept: 'application/json'
    });
    assertResponse(user, 'XAI_LOGIN_FAILED');
    const info = parse(z.object({ userId: z.string().min(1).max(512) }), await json(user));
    return { subject: identity.sub, accountId: info.userId, scopes: scopes(tokens.scope) };
  }

  async refresh(credential: CredentialRecord): Promise<XaiTokens> {
    const response = await this.form(
      '/oauth2/token',
      {
        client_id: CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: credential.refreshToken
      },
      credential.proxy ?? undefined
    );
    if (!response.ok) {
      if (response.status === 401) throw new Error('CODEX_CREDENTIAL_REAUTH_REQUIRED');
      if (response.status === 403) throw new XaiOAuthError('XAI_ENTITLEMENT_REQUIRED');
      const body = await json(response).catch(() => undefined);
      if (record(body)['error'] === 'invalid_grant')
        throw new Error('CODEX_CREDENTIAL_REAUTH_REQUIRED');
      throw new XaiOAuthError(
        'XAI_REFRESH_FAILED',
        `Token refresh returned HTTP ${response.status}.`
      );
    }
    const body = await json(response);
    // OAuth may omit the refresh token when it has not rotated; never replace it with emptiness.
    return parse(tokenSchema, {
      ...record(body),
      refresh_token:
        record(body)['refresh_token'] === undefined
          ? credential.refreshToken
          : record(body)['refresh_token']
    });
  }

  revoke(credential: CredentialRecord): Promise<Response> {
    return this.form(
      '/oauth2/revoke',
      {
        client_id: CLIENT_ID,
        token: credential.refreshToken,
        token_type_hint: 'refresh_token'
      },
      credential.proxy ?? undefined
    );
  }

  catalogResponse(credential: CredentialRecord): Promise<Response> {
    return this.get('/models', credential);
  }

  usageResponse(credential: CredentialRecord): Promise<Response> {
    return this.get('/billing?format=credits', credential);
  }

  private get(path: string, credential: CredentialRecord): Promise<Response> {
    return this.request(
      `${XAI_SUBSCRIPTION_PROXY_BASE_URL}${path}`,
      'GET',
      credential.proxy ?? undefined,
      {
        ...this.headers(credential.accountId),
        authorization: `Bearer ${credential.accessToken}`,
        accept: 'application/json'
      }
    );
  }

  private form(path: string, fields: Record<string, string>, proxy?: string): Promise<Response> {
    return this.request(
      `${ISSUER}${path}`,
      'POST',
      proxy,
      {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        'user-agent': `MyAgentRoam/${this.version}`
      },
      new URLSearchParams(fields).toString()
    );
  }
}

export function xaiTokenFields(tokens: XaiTokens, now: number) {
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    accessTokenExpiresAt: tokens.expires_in === undefined ? null : now + tokens.expires_in * 1000,
    lastRefreshAt: now
  };
}
export function scopes(value: string | undefined): string[] {
  return parse(z.array(z.string().min(1).max(256)).max(64), [
    ...new Set((value ?? SCOPES).split(/\s+/u).filter(Boolean))
  ]);
}

export function normalizeXaiCatalog(raw: unknown, now: number): CodexModelCatalog {
  const root = record(raw);
  const values = root['data'] ?? root['models'];
  if (!Array.isArray(values) || values.length > 256)
    throw new XaiOAuthError('XAI_RESPONSE_INVALID');
  const models = values.flatMap((value) => {
    const item = record(value);
    const meta = record(item['_meta']);
    const capabilities = record(item['capabilities']);
    const backend = item['apiBackend'] ?? item['api_backend'];
    if (
      item['hidden'] === true ||
      meta['hidden'] === true ||
      (typeof backend === 'string' && backend !== 'responses')
    )
      return [];
    const id = parse(
      z.string().trim().min(1).max(256),
      item['model'] ?? item['modelId'] ?? item['id'] ?? meta['model'] ?? meta['modelId']
    );
    const context = positive(
      item['contextWindow'] ??
        item['context_window'] ??
        item['context_length'] ??
        meta['contextWindow'] ??
        meta['totalContextTokens']
    );
    const output = positive(
      item['maxCompletionTokens'] ?? item['max_completion_tokens'] ?? item['max_output_tokens']
    );
    const rawEfforts =
      item['reasoningEfforts'] ??
      item['reasoning_efforts'] ??
      meta['reasoningEfforts'] ??
      capabilities['reasoning_effort'];
    const values = (Array.isArray(rawEfforts) ? rawEfforts : []).map((entry) =>
      typeof entry === 'string' ? entry : record(entry)['value']
    );
    const efforts = [
      ...new Set(
        values.filter(
          (entry): entry is string =>
            typeof entry === 'string' && entry.length > 0 && entry.length <= 128
        )
      )
    ];
    const reasoningEfforts = efforts.filter((entry) =>
      ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(entry)
    );
    const defaultEffort =
      item['default_reasoning_effort'] ?? capabilities['default_reasoning_effort'];
    return [
      {
        upstreamModelId: id,
        displayName: typeof item['name'] === 'string' ? item['name'] : id,
        ...(context === undefined ? {} : { contextWindowTokens: context }),
        ...(output === undefined || (context !== undefined && output >= context)
          ? {}
          : { maxOutputTokens: output }),
        reasoningEfforts,
        ...(typeof defaultEffort === 'string' && reasoningEfforts.includes(defaultEffort)
          ? { defaultReasoningEffort: defaultEffort }
          : {}),
        unsupportedReasoningEfforts: efforts
          .filter((entry) => !reasoningEfforts.includes(entry))
          .slice(0, 16),
        inputCapabilities: ['TEXT'],
        hostedWebSearch: true,
        warnings: [],
        requiredInputs: context === undefined ? ['contextWindowTokens'] : []
      }
    ];
  });
  return parse(codexModelCatalogSchema, {
    catalogHash: createHash('sha256').update(JSON.stringify(models)).digest('hex'),
    fetchedAt: now,
    models
  });
}

export function normalizeXaiUsage(raw: unknown, now: number): CodexCredentialUsage {
  const value = record(raw)['config'];
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new XaiOAuthError('XAI_RESPONSE_INVALID');
  const config = record(value);
  const current = record(config['currentPeriod']);
  const period =
    current['type'] === 'USAGE_PERIOD_TYPE_WEEKLY'
      ? 'WEEKLY'
      : current['type'] === 'USAGE_PERIOD_TYPE_MONTHLY'
        ? 'MONTHLY'
        : 'UNKNOWN';
  const percentage = config['creditUsagePercent'];
  const usedPercentage =
    typeof percentage === 'number' &&
    Number.isFinite(percentage) &&
    percentage >= 0 &&
    percentage <= 100
      ? percentage
      : null;
  const startsAt = timestamp(current['start']);
  const resetsAt = timestamp(current['end']);
  const balance = config['prepaidBalance'];
  const cents =
    balance !== null && typeof balance === 'object' && !Array.isArray(balance)
      ? (record(balance)['val'] ?? 0)
      : null;
  const prepaidBalanceCents =
    typeof cents === 'number' && Number.isSafeInteger(cents) && cents >= 0 ? cents : null;
  return codexCredentialUsageSchema.parse({
    runner: 'mar-agent',
    fetchedAt: now,
    cached: false,
    windows:
      usedPercentage === null
        ? []
        : [{ id: 'subscription', label: period, usedPercentage, resetsAt }],
    profile: {
      lifetimeTokens: null,
      currentDayTokens: null,
      lastSevenDaysTokens: null,
      statsAsOf: null,
      dailyUsageBuckets: []
    },
    subscription: {
      provider: 'XAI',
      period,
      startsAt,
      resetsAt,
      usedPercentage,
      prepaidBalanceCents
    }
  });
}

export function assertXaiResponse(response: Response, fallback: keyof typeof messages): void {
  assertResponse(response, fallback);
}
function assertResponse(response: Response, fallback: keyof typeof messages): void {
  if (response.ok) return;
  if (response.status === 403) throw new XaiOAuthError('XAI_ENTITLEMENT_REQUIRED');
  throw new XaiOAuthError(fallback, `Upstream returned HTTP ${response.status}.`);
}
function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
function timestamp(value: unknown): number | null {
  const result = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isSafeInteger(result) && result >= 0 ? result : null;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new XaiOAuthError('XAI_RESPONSE_INVALID');
  return parsed.data;
}
async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new XaiOAuthError('XAI_RESPONSE_INVALID');
  }
}
