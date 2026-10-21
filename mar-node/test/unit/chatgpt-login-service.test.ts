import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CHATGPT_JWKS_ENDPOINT,
  CHATGPT_TOKEN_ENDPOINT,
  verifyChatgptIdentity
} from '@myagentroam/protocol';
import { ChatgptLoginService } from '../../src/service/chatgpt-login-service.js';

const alice = { __requestUserId: 7, __workspaceWatchSessionHash: 'session-alice' };
const bob = { __requestUserId: 8, __workspaceWatchSessionHash: 'session-bob' };
const now = Math.floor(Date.now() / 1000) * 1000;

const directories: string[] = [];
const services: ChatgptLoginService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) service.close();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe('verifyChatgptIdentity', () => {
  it('accepts a correctly signed RSA JWT with an audience array', async () => {
    const fixture = identityFixture({
      aud: ['not-this-client', 'client-1'],
      email: 'user@example.test'
    });

    await expect(
      verifyChatgptIdentity(fixture.token, fixture.jwks, {
        clientId: 'client-1',
        nonce: fixture.nonce,
        subject: fixture.subject,
        now
      })
    ).resolves.toEqual({ subject: fixture.subject, email: 'user@example.test' });
  });

  it.each([
    ['signature', (fixture: IdentityFixture) => tamperSignature(fixture.token)],
    [
      'issuer',
      (fixture: IdentityFixture) => signedToken(fixture, { iss: 'https://invalid.example.test' })
    ],
    ['audience', (fixture: IdentityFixture) => signedToken(fixture, { aud: 'other-client' })],
    ['nonce', (fixture: IdentityFixture) => signedToken(fixture, { nonce: 'other-nonce' })],
    ['expiry', (fixture: IdentityFixture) => signedToken(fixture, { exp: now / 1000 })],
    ['subject', (fixture: IdentityFixture) => signedToken(fixture, { sub: 'other-subject' })]
  ])('rejects a JWT with an invalid %s', async (_claim, tokenFor) => {
    const fixture = identityFixture();

    await expect(
      verifyChatgptIdentity(tokenFor(fixture), fixture.jwks, {
        clientId: fixture.clientId,
        nonce: fixture.nonce,
        subject: fixture.subject,
        now
      })
    ).rejects.toThrow('CHATGPT_IDENTITY_INVALID');
  });
});

describe('ChatgptLoginService', () => {
  it('does not leave a listener when the control connection closes during start', async () => {
    const service = await newService();
    const pending = start(service, { attemptId: 'late-start', nonce: 'n'.repeat(32) });
    service.close();
    await expect(pending).rejects.toThrow('CHATGPT_LOGIN_CANCELLED');
    expect(() => service.status({ ...alice, attemptId: 'late-start' })).toThrow(
      'CHATGPT_LOGIN_NOT_FOUND'
    );
  });

  it('single-flights concurrent starts for one authenticated attempt', async () => {
    const service = await newService();
    await start(service, { attemptId: 'prepare-host', nonce: 'n'.repeat(32) });
    await service.remove({ ...alice, attemptId: 'prepare-host' });
    const input = { ...alice, attemptId: 'concurrent-start', nonce: 'n'.repeat(32) };
    const [first, second] = await Promise.all([service.start(input), service.start(input)]);
    expect(second).toEqual(first);
    await expect(service.start({ ...input, ...bob })).rejects.toThrow('CHATGPT_LOGIN_NOT_FOUND');
  });

  it('redirects through a one-shot local entry with PKCE, nonce, actual client ID, and host ID', async () => {
    const fixture = identityFixture();
    const calls = requestFixture(fixture);
    const service = await newService(calls.request);
    const attemptId = 'attempt-pkce';
    const nonce = fixture.nonce;
    const pending = await start(service, { attemptId, nonce, clientId: fixture.clientId });

    expect(pending.status).toBe('PENDING');
    if (pending.status !== 'PENDING' || pending.verificationUri === undefined)
      throw new Error('Expected pending login');
    const verificationUri = pending.verificationUri;

    const entryResponse = await fetch(verificationUri, { redirect: 'manual' });
    expect(entryResponse.status).toBe(302);
    const authorize = new URL(requiredHeader(entryResponse, 'location'));
    const callback = new URL(authorize.searchParams.get('redirect_uri') ?? '');
    expect(authorize.searchParams.get('response_type')).toBe('code');
    expect(authorize.searchParams.get('client_id')).toBe(fixture.clientId);
    expect(authorize.searchParams.get('nonce')).toBe(nonce);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('scope')).toContain('openid');
    expect(authorize.searchParams.get('resource')).toBe('https://api.openai.com/v1');
    expect(authorize.searchParams.get('ext_agent_host_id')).toMatch(/^urn:uuid:/u);

    const secondEntryResponse = await fetch(verificationUri, { redirect: 'manual' });
    expect(secondEntryResponse.status).toBe(400);

    callback.searchParams.set('state', authorize.searchParams.get('state') ?? '');
    callback.searchParams.set('code', 'authorization-code');
    const callbackResponse = await fetch(callback);
    expect(callbackResponse.status).toBe(200);

    const tokenCall = calls.calls.find((call) => call.url === CHATGPT_TOKEN_ENDPOINT);
    expect(tokenCall).toBeDefined();
    const tokenBody = new URLSearchParams(String(tokenCall?.init.body));
    expect(tokenBody.get('client_id')).toBe(fixture.clientId);
    expect(tokenBody.get('code')).toBe('authorization-code');
    expect(tokenBody.get('redirect_uri')).toBe(`${callback.origin}${callback.pathname}`);
    expect(tokenBody.get('resource')).toBe('https://api.openai.com/v1');
    expect(tokenBody.get('code_verifier')).toBeTruthy();
    expect(
      createHash('sha256')
        .update(tokenBody.get('code_verifier') ?? '')
        .digest('base64url')
    ).toBe(authorize.searchParams.get('code_challenge'));
    expect(calls.calls.map((call) => call.url)).toEqual([
      CHATGPT_TOKEN_ENDPOINT,
      CHATGPT_JWKS_ENDPOINT
    ]);

    const status = await loginStatus(service, attemptId, alice);
    expect(status).toMatchObject({
      status: 'SUCCEEDED',
      result: {
        attemptId,
        clientId: fixture.clientId,
        hostId: authorize.searchParams.get('ext_agent_host_id'),
        tokens: expect.objectContaining({
          access_token: 'access-token-secret',
          refresh_token: 'refresh-token-secret',
          id_token: fixture.token
        })
      }
    });
    const callbackBody = await callbackResponse.text();
    expect(callbackBody).not.toContain('access-token-secret');
    expect(callbackBody).not.toContain('refresh-token-secret');
    await expectListenerClosed(verificationUri);
  });

  it('rejects wrong state and callback client ID without contacting the token endpoint', async () => {
    const fixture = identityFixture();
    const calls = requestFixture(fixture);
    const service = await newService(calls.request);
    const attemptId = 'attempt-rejections';
    const pending = await start(service, {
      attemptId,
      nonce: fixture.nonce,
      clientId: fixture.clientId
    });
    if (pending.status !== 'PENDING' || pending.verificationUri === undefined)
      throw new Error('Expected pending login');
    const verificationUri = pending.verificationUri;

    const entry = await fetch(verificationUri, { redirect: 'manual' });
    const authorize = new URL(requiredHeader(entry, 'location'));
    const callback = new URL(authorize.searchParams.get('redirect_uri') ?? '');
    callback.searchParams.set('state', 'wrong-state');
    callback.searchParams.set('code', 'authorization-code');
    expect((await fetch(callback)).status).toBe(400);
    expect(calls.calls).toHaveLength(0);
    await expect(loginStatus(service, attemptId, alice)).resolves.toMatchObject({
      status: 'PENDING'
    });

    callback.searchParams.set('state', authorize.searchParams.get('state') ?? '');
    callback.searchParams.set('client_id', 'different-client');
    expect((await fetch(callback)).status).toBe(400);
    expect(calls.calls).toHaveLength(0);
    await expect(loginStatus(service, attemptId, alice)).resolves.toMatchObject({
      status: 'FAILED',
      code: 'CHATGPT_CALLBACK_INVALID'
    });
  });

  it('isolates attempts by authenticated user and workspace watch session', async () => {
    const service = await newService(requestFixture(identityFixture()).request);
    const attemptId = 'attempt-isolation';
    const pending = await start(service, {
      attemptId,
      nonce: 'nonce-for-isolation-test-123456789012345678'
    });

    expect(pending.status).toBe('PENDING');
    if (pending.status !== 'PENDING' || pending.verificationUri === undefined)
      throw new Error('Expected pending login');
    const verificationUri = pending.verificationUri;
    await expect(loginStatus(service, attemptId, bob)).rejects.toThrow('CHATGPT_LOGIN_NOT_FOUND');
    await expect(loginCancel(service, attemptId, bob)).rejects.toThrow('CHATGPT_LOGIN_NOT_FOUND');
    await expect(
      start(service, { attemptId, nonce: 'another-nonce-123456789012345678901234567890' }, bob)
    ).rejects.toThrow('CHATGPT_LOGIN_NOT_FOUND');
    await expect(loginStatus(service, attemptId, alice)).resolves.toMatchObject({
      status: 'PENDING'
    });
    await expect(loginCancel(service, attemptId, alice)).resolves.toEqual({ cleared: true });
    await expectListenerClosed(verificationUri);
  });

  it('clears the listener on cancel and on service close', async () => {
    const service = await newService(requestFixture(identityFixture()).request);
    const cancelled = await start(service, {
      attemptId: 'attempt-cancel',
      nonce: 'nonce-for-cancel-test-123456789012345678901234'
    });
    if (cancelled.status !== 'PENDING' || cancelled.verificationUri === undefined)
      throw new Error('Expected pending login');
    const cancelledUri = cancelled.verificationUri;
    await expect(loginCancel(service, 'attempt-cancel', alice)).resolves.toEqual({ cleared: true });
    await expectListenerClosed(cancelledUri);

    const closed = await start(service, {
      attemptId: 'attempt-close',
      nonce: 'nonce-for-close-test-1234567890123456789012345'
    });
    if (closed.status !== 'PENDING' || closed.verificationUri === undefined)
      throw new Error('Expected pending login');
    const closedUri = closed.verificationUri;
    service.close();
    await expectListenerClosed(closedUri);
  });

  it('reuses the host ID after a restart with the same private data directory', async () => {
    const directory = await temporaryDirectory();
    const first = registerService(new ChatgptLoginService(() => directory));
    const firstPending = await start(first, {
      attemptId: 'attempt-host-first',
      nonce: 'nonce-for-host-first-123456789012345678901234'
    });
    if (firstPending.status !== 'PENDING' || firstPending.verificationUri === undefined)
      throw new Error('Expected pending login');
    const firstUri = firstPending.verificationUri;
    const firstAuthorize = new URL(
      requiredHeader(await fetch(firstUri, { redirect: 'manual' }), 'location')
    );
    const firstHostId = firstAuthorize.searchParams.get('ext_agent_host_id');
    first.close();

    const second = registerService(new ChatgptLoginService(() => directory));
    const secondPending = await start(second, {
      attemptId: 'attempt-host-second',
      nonce: 'nonce-for-host-second-123456789012345678901234'
    });
    if (secondPending.status !== 'PENDING' || secondPending.verificationUri === undefined)
      throw new Error('Expected pending login');
    const secondUri = secondPending.verificationUri;
    const secondAuthorize = new URL(
      requiredHeader(await fetch(secondUri, { redirect: 'manual' }), 'location')
    );
    expect(secondAuthorize.searchParams.get('ext_agent_host_id')).toBe(firstHostId);
    await expect(readFile(join(directory, 'chatgpt-host-id'), 'utf8')).resolves.toBe(firstHostId);
  });

  it('passes SOCKS5 proxy settings only to the fake upstream request', async () => {
    const fixture = identityFixture();
    const calls = requestFixture(fixture);
    const service = await newService(calls.request);
    const pending = await start(service, {
      attemptId: 'attempt-proxy',
      nonce: fixture.nonce,
      clientId: fixture.clientId,
      socks5Url: 'socks5://127.0.0.1:1080'
    });
    if (pending.status !== 'PENDING' || pending.verificationUri === undefined)
      throw new Error('Expected pending login');
    const verificationUri = pending.verificationUri;

    const entry = await fetch(verificationUri, { redirect: 'manual' });
    const authorize = new URL(requiredHeader(entry, 'location'));
    const callback = new URL(authorize.searchParams.get('redirect_uri') ?? '');
    callback.searchParams.set('state', authorize.searchParams.get('state') ?? '');
    callback.searchParams.set('code', 'proxy-code');
    expect((await fetch(callback)).status).toBe(200);
    expect(calls.calls).toHaveLength(2);
    expect(calls.calls.every((call) => call.proxy === 'socks5://127.0.0.1:1080')).toBe(true);
  });
});

interface IdentityFixture {
  clientId: string;
  jwks: { keys: Array<Record<string, unknown>> };
  nonce: string;
  subject: string;
  token: string;
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
}

function identityFixture(
  overrides: Partial<
    Record<'aud' | 'email' | 'exp' | 'iat' | 'iss' | 'nonce' | 'sub', unknown>
  > = {}
): IdentityFixture {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const clientId = 'actual-client-id';
  const nonce = 'nonce-for-jwt-test-123456789012345678901234';
  const subject = 'chatgpt-subject';
  const publicJwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  const jwks = {
    keys: [{ ...publicJwk, kid: 'test-key', alg: 'RS256', use: 'sig' }]
  };
  const fixture = {
    clientId,
    jwks,
    nonce,
    subject,
    token: '',
    privateKey
  };
  fixture.token = signedToken(fixture, overrides);
  return fixture;
}

function signedToken(
  fixture: Pick<IdentityFixture, 'privateKey' | 'nonce' | 'subject'> & {
    clientId?: string;
  },
  overrides: Partial<
    Record<'aud' | 'email' | 'exp' | 'iat' | 'iss' | 'nonce' | 'sub', unknown>
  > = {}
): string {
  const header = { alg: 'RS256', kid: 'test-key' };
  const claims = {
    iss: 'https://auth.openai.com',
    sub: fixture.subject,
    aud: fixture.clientId ?? 'actual-client-id',
    exp: now / 1000 + 3_600,
    iat: now / 1000 - 60,
    nonce: fixture.nonce,
    email: 'user@example.test',
    ...overrides
  };
  const encoded = `${encode(header)}.${encode(claims)}`;
  const signature = createSign('RSA-SHA256').update(encoded).end().sign(fixture.privateKey);
  return `${encoded}.${signature.toString('base64url')}`;
}

function tamperSignature(token: string): string {
  return `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
}

function requestFixture(fixture: IdentityFixture) {
  const calls: RequestCall[] = [];
  const request = async (
    url: string,
    init: RequestInit,
    proxy?: string,
    signal?: AbortSignal
  ): Promise<Response> => {
    calls.push({ url, init, proxy, signal });
    if (url === CHATGPT_TOKEN_ENDPOINT) {
      return new Response(
        JSON.stringify({
          access_token: 'access-token-secret',
          refresh_token: 'refresh-token-secret',
          id_token: fixture.token,
          token_type: 'Bearer',
          expires_in: 3_600,
          scope: 'openid profile email offline_access'
        }),
        { headers: { 'content-type': 'application/json' } }
      );
    }
    if (url === CHATGPT_JWKS_ENDPOINT) {
      return new Response(JSON.stringify(fixture.jwks), {
        headers: { 'content-type': 'application/json' }
      });
    }
    throw new Error(`Unexpected upstream URL: ${url}`);
  };
  return { calls, request };
}

interface RequestCall {
  url: string;
  init: RequestInit;
  proxy: string | undefined;
  signal: AbortSignal | undefined;
}

async function newService(
  request?: (
    url: string,
    init: RequestInit,
    proxy?: string,
    signal?: AbortSignal
  ) => Promise<Response>
): Promise<ChatgptLoginService> {
  const directory = await temporaryDirectory();
  return registerService(new ChatgptLoginService(() => directory, request));
}

function registerService(service: ChatgptLoginService): ChatgptLoginService {
  services.push(service);
  return service;
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'mar-chatgpt-login-'));
  directories.push(path);
  return path;
}

async function start(service: ChatgptLoginService, data: Record<string, unknown>, context = alice) {
  return service.operations()['chatgpt.login.start']({ ...data, ...context });
}

async function loginStatus(service: ChatgptLoginService, attemptId: string, context: typeof alice) {
  return service.operations()['chatgpt.login.status']({ attemptId, ...context });
}

async function loginCancel(service: ChatgptLoginService, attemptId: string, context: typeof alice) {
  return service.operations()['chatgpt.login.cancel']({ attemptId, ...context });
}

async function expectListenerClosed(url: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(100)
      });
      await response.body?.cancel();
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Listener remains reachable: ${url}`);
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function requiredHeader(response: Response, name: string): string {
  const value = response.headers.get(name);
  if (value === null) throw new Error(`Missing response header: ${name}`);
  return value;
}
