import { emitAudit } from '@myagentroam/server-core/audit';
import { createHash, randomBytes } from 'node:crypto';
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { z } from 'zod';
import { oauthProviderInputSchema } from '@myagentroam/protocol';
import {
  lockMysqlUsers,
  withMysqlTransaction
} from '@myagentroam/server-core/mysql-reference-store';
import type { MysqlServerDatabase } from '../mysql/server-database.js';
import type { AuthorizationProvider } from '../product/product-policy.js';
import type { LicenseService } from '../license/license-service.js';
import { lockOrganizationReference } from '../rbac/organization-reference.js';

type OAuthProviderInput = z.infer<typeof oauthProviderInputSchema>;
type Fetch = typeof fetch;

type StoredProvider = Omit<OAuthProviderInput, 'clientSecret'> & {
  readonly clientSecret: string;
  readonly enabled: boolean;
  readonly testedAt: number | null;
};

export class OAuthService {
  constructor(
    private readonly database: MysqlServerDatabase,
    private readonly authorization: AuthorizationProvider,
    private readonly licenses: LicenseService,
    private readonly fetchImpl: Fetch = fetch,
    private readonly now: () => number = Date.now
  ) {}

  async list(actorUserId: number): Promise<readonly object[]> {
    await this.requireManage(actorUserId);
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      `SELECT id,name,client_id,authorization_endpoint,token_endpoint,userinfo_endpoint,
              configuration,default_organization_id,enabled,tested_at,created_at,updated_at
       FROM oauth_providers ORDER BY name,id`
    );
    return rows.map(publicProvider);
  }

  async enabledProviders(): Promise<readonly object[]> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      'SELECT id,name FROM oauth_providers WHERE enabled=TRUE ORDER BY name,id'
    );
    return rows.map((row) => ({ providerKey: String(row['id']), name: String(row['name']) }));
  }

  async bindings(userId: number): Promise<readonly object[]> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      `SELECT provider.id,provider.name,identity.external_user_id
       FROM oauth_providers provider
       LEFT JOIN external_identities identity
         ON identity.provider_id=provider.id AND identity.user_id=?
       WHERE provider.enabled=TRUE ORDER BY provider.name,provider.id`,
      [userId]
    );
    return rows.map((row) => ({
      providerKey: String(row['id']),
      name: String(row['name']),
      bound: row['external_user_id'] !== null,
      externalUserId: row['external_user_id'] === null ? null : String(row['external_user_id'])
    }));
  }

  async removeBinding(userId: number, providerKey: string): Promise<void> {
    const status = await this.licenses.status();
    if (status.state !== 'ENTERPRISE_VALID') throw new Error('OAUTH_ACCOUNT_BINDING_FROZEN');
    await withMysqlTransaction(this.database.raw, async (connection) => {
      await lockProvider(connection, providerKey, 'FOR SHARE');
      await lockMysqlUsers(connection, [userId]);
      const [result] = await connection.execute<ResultSetHeader>(
        'DELETE FROM external_identities WHERE provider_id=? AND user_id=?',
        [providerKey, userId]
      );
      if (result.affectedRows !== 1) throw new Error('OAUTH_BINDING_NOT_FOUND');
    });
  }

  async create(actorUserId: number, input: OAuthProviderInput): Promise<object> {
    await this.requireManage(actorUserId);
    if (input.clientSecret === undefined) throw new Error('OAUTH_CLIENT_SECRET_REQUIRED');
    const secret = input.clientSecret;
    const timestamp = this.now();
    await withMysqlTransaction(this.database.raw, async (connection) => {
      await lockOrganizationReference(connection, 1);
      await connection.execute(
        `INSERT INTO oauth_providers
       (id,name,client_id,client_secret,authorization_endpoint,token_endpoint,userinfo_endpoint,
        configuration,default_organization_id,enabled,tested_at,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,FALSE,NULL,?,?)`,
        providerParameters(input, secret, timestamp)
      );
    });
    emitAudit(this.database, {
      eventType: 'oauth_provider.created',
      actorUserId,
      targetType: 'OAUTH_PROVIDER',
      targetId: input.providerKey,
      targetName: input.name
    });
    return this.getPublic(input.providerKey);
  }

  async update(
    actorUserId: number,
    providerKey: string,
    input: OAuthProviderInput
  ): Promise<object> {
    await this.requireManage(actorUserId);
    if (providerKey !== input.providerKey) throw new Error('OAUTH_PROVIDER_KEY_IMMUTABLE');
    const current = await this.provider(providerKey, false);
    const secret = input.clientSecret ?? current.clientSecret;
    const configuration = providerConfiguration(input);
    const [result] = await withMysqlTransaction(this.database.raw, async (connection) => {
      await lockOrganizationReference(connection, 1);
      return connection.execute<ResultSetHeader>(
        `UPDATE oauth_providers SET name=?,client_id=?,client_secret=?,authorization_endpoint=?,
       token_endpoint=?,userinfo_endpoint=?,configuration=?,default_organization_id=?,
       enabled=FALSE,tested_at=NULL,updated_at=? WHERE id=?`,
        [
          input.name,
          input.clientId,
          secret,
          input.authorizationEndpoint,
          input.tokenEndpoint,
          input.userinfoEndpoint,
          JSON.stringify(configuration),
          1,
          this.now(),
          providerKey
        ]
      );
    });
    if (result.affectedRows !== 1) throw new Error('OAUTH_PROVIDER_NOT_FOUND');
    emitAudit(this.database, {
      eventType: 'oauth_provider.updated',
      actorUserId,
      targetType: 'OAUTH_PROVIDER',
      targetId: providerKey,
      targetName: input.name,
      metadata: JSON.stringify({
        before: { name: current.name, enabled: current.enabled },
        after: { name: input.name, enabled: false }
      })
    });
    return this.getPublic(providerKey);
  }

  async remove(actorUserId: number, providerKey: string): Promise<void> {
    await this.requireManage(actorUserId);
    const targetName = await withMysqlTransaction(this.database.raw, async (connection) => {
      const current = await lockProvider(connection, providerKey, 'FOR UPDATE');
      await connection.execute('DELETE FROM oauth_transactions WHERE provider_id=?', [providerKey]);
      await connection.execute('DELETE FROM external_identities WHERE provider_id=?', [
        providerKey
      ]);
      const [result] = await connection.execute<ResultSetHeader>(
        'DELETE FROM oauth_providers WHERE id=?',
        [providerKey]
      );
      if (result.affectedRows !== 1) throw new Error('OAUTH_PROVIDER_NOT_FOUND');
      return String(current['name'] ?? providerKey);
    });
    emitAudit(this.database, {
      eventType: 'oauth_provider.deleted',
      actorUserId,
      targetType: 'OAUTH_PROVIDER',
      targetId: providerKey,
      targetName
    });
  }

  async test(actorUserId: number, providerKey: string): Promise<void> {
    await this.requireManage(actorUserId);
    const provider = await this.provider(providerKey, false);
    try {
      await requireHttpsEndpoints(provider);
      await this.testConfiguration(provider);
      await this.database.raw.execute(
        'UPDATE oauth_providers SET tested_at=?,updated_at=? WHERE id=?',
        [this.now(), this.now(), providerKey]
      );
      emitAudit(this.database, {
        eventType: 'oauth_provider.tested',
        actorUserId,
        targetType: 'OAUTH_PROVIDER',
        targetId: providerKey,
        targetName: provider.name
      });
    } catch (error) {
      emitAudit(this.database, {
        eventType: 'oauth_provider.tested',
        actorUserId,
        targetType: 'OAUTH_PROVIDER',
        targetId: providerKey,
        targetName: provider.name,
        result: 'FAILED',
        errorCode: 'OAUTH_PROVIDER_TEST_FAILED'
      });
      throw error;
    }
  }

  private async testConfiguration(provider: StoredProvider): Promise<void> {
    const authorizationUrl = new URL(provider.authorizationEndpoint);
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('client_id', provider.clientId);
    authorizationUrl.searchParams.set('redirect_uri', 'https://localhost/oauth/config-test');
    authorizationUrl.searchParams.set('scope', provider.scopes.join(' '));
    authorizationUrl.searchParams.set('state', 'configuration-test');
    const authorizationResponse = await this.fetchImpl(authorizationUrl, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000)
    });
    if (authorizationResponse.status >= 500)
      throw new Error('OAUTH_AUTHORIZATION_ENDPOINT_UNAVAILABLE');

    const parameters = {
      grant_type: 'authorization_code',
      code: 'configuration-test',
      redirect_uri: 'https://localhost/oauth/config-test',
      client_id: provider.clientId
    };
    const body = new URLSearchParams(parameters);
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded'
    };
    if (provider.tokenAuthMethod === 'client_secret_basic')
      headers['authorization'] =
        `Basic ${Buffer.from(`${provider.clientId}:${provider.clientSecret}`).toString('base64')}`;
    else if (provider.tokenAuthMethod === 'client_secret_post')
      body.set('client_secret', provider.clientSecret);
    else headers['content-type'] = 'application/json';
    const tokenResponse = await this.fetchImpl(provider.tokenEndpoint, {
      method: 'POST',
      headers,
      body:
        provider.tokenAuthMethod === 'client_secret_json'
          ? JSON.stringify({ ...parameters, client_secret: provider.clientSecret })
          : body,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000)
    });
    const payload = await boundedJson(tokenResponse);
    if (tokenResponse.status >= 500 || !record(payload))
      throw new Error('OAUTH_TOKEN_ENDPOINT_INVALID');

    const userinfoResponse = await this.fetchImpl(provider.userinfoEndpoint, {
      headers: { authorization: 'Bearer configuration-test', accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000)
    });
    const userinfoPayload = await boundedJson(userinfoResponse);
    if (userinfoResponse.status >= 500 || !record(userinfoPayload))
      throw new Error('OAUTH_USERINFO_ENDPOINT_INVALID');
  }

  async setEnabled(actorUserId: number, providerKey: string, enabled: boolean): Promise<void> {
    await this.requireManage(actorUserId);
    const [result] = await this.database.raw.execute<ResultSetHeader>(
      `UPDATE oauth_providers SET enabled=?,updated_at=?
       WHERE id=? AND (?=FALSE OR tested_at IS NOT NULL)`,
      [enabled, this.now(), providerKey, enabled]
    );
    if (result.affectedRows !== 1)
      throw new Error(enabled ? 'OAUTH_PROVIDER_TEST_REQUIRED' : 'OAUTH_PROVIDER_NOT_FOUND');
    emitAudit(this.database, {
      eventType: 'oauth_provider.updated',
      actorUserId,
      targetType: 'OAUTH_PROVIDER',
      targetId: providerKey,
      targetName: providerKey,
      metadata: JSON.stringify({ after: { enabled } })
    });
  }

  async begin(
    providerKey: string,
    redirectUri: string,
    bindingUserId?: number
  ): Promise<{ readonly authorizationUrl: string; readonly browserFlowId: string }> {
    const status = await this.licenses.status();
    if (status.edition !== 'ENTERPRISE') throw new Error('ENTERPRISE_LICENSE_REQUIRED');
    if (bindingUserId !== undefined && status.state !== 'ENTERPRISE_VALID')
      throw new Error('OAUTH_ACCOUNT_BINDING_FROZEN');
    return withMysqlTransaction(this.database.raw, async (connection) => {
      const provider = await providerOnConnection(connection, providerKey, true, 'FOR SHARE');
      const state = randomBytes(32).toString('base64url');
      const randomFlowId = randomBytes(24).toString('base64url');
      const browserFlowId =
        bindingUserId === undefined ? randomFlowId : `BIND.${bindingUserId}.${randomFlowId}`;
      const verifier =
        provider.pkceMode === 'DISABLED' ? null : randomBytes(48).toString('base64url');
      await connection.execute('DELETE FROM oauth_transactions WHERE expires_at<=?', [this.now()]);
      await connection.execute(
        `INSERT INTO oauth_transactions
         (state_hash,provider_id,browser_flow_id,pkce_verifier,created_at,expires_at)
         VALUES (?,?,?,?,?,?)`,
        [sha256(state), providerKey, browserFlowId, verifier, this.now(), this.now() + 10 * 60_000]
      );
      const url = new URL(provider.authorizationEndpoint);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', provider.clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('scope', provider.scopes.join(' '));
      url.searchParams.set('state', state);
      if (verifier !== null) {
        url.searchParams.set('code_challenge_method', 'S256');
        url.searchParams.set('code_challenge', base64UrlSha256(verifier));
      }
      return { authorizationUrl: url.toString(), browserFlowId };
    });
  }

  async callback(input: {
    readonly providerKey: string;
    readonly state: string;
    readonly code: string;
    readonly browserFlowId: string;
    readonly redirectUri: string;
  }): Promise<{ readonly userId: number; readonly flowType: 'LOGIN' | 'BIND' }> {
    const transaction = await this.consumeTransaction(
      input.providerKey,
      input.state,
      input.browserFlowId
    );
    const provider = await this.provider(input.providerKey, true);
    const tokenResponse = await this.exchangeCode(
      provider,
      input.code,
      input.redirectUri,
      transaction.pkceVerifier
    );
    const userinfo = await this.loadUserinfo(provider, tokenResponse);
    const identity = mappedIdentity(provider, userinfo);
    if (transaction.bindingUserId !== undefined) {
      await this.bindIdentity(provider, identity, transaction.bindingUserId);
      return { userId: transaction.bindingUserId, flowType: 'BIND' };
    }
    return { userId: await this.bindOrCreate(provider, identity), flowType: 'LOGIN' };
  }

  private async consumeTransaction(
    providerKey: string,
    state: string,
    browserFlowId: string
  ): Promise<{ readonly pkceVerifier: string | null; readonly bindingUserId?: number }> {
    return withMysqlTransaction(this.database.raw, async (connection) => {
      const stateHash = sha256(state);
      const [parentRows] = await connection.execute<RowDataPacket[]>(
        'SELECT provider_id FROM oauth_transactions WHERE state_hash=?',
        [stateHash]
      );
      const providerId = parentRows[0]?.['provider_id'];
      if (providerId === undefined) throw new Error('OAUTH_STATE_INVALID');
      await lockProvider(connection, String(providerId), 'FOR SHARE');
      const [rows] = await connection.execute<RowDataPacket[]>(
        `SELECT provider_id,browser_flow_id,pkce_verifier,expires_at FROM oauth_transactions
         WHERE state_hash=? FOR UPDATE`,
        [stateHash]
      );
      await connection.execute('DELETE FROM oauth_transactions WHERE state_hash=?', [stateHash]);
      const row = rows[0];
      if (
        row === undefined ||
        row['provider_id'] !== providerKey ||
        row['browser_flow_id'] !== browserFlowId ||
        Number(row['expires_at']) <= this.now()
      )
        throw new Error('OAUTH_STATE_INVALID');
      const userId = bindingUserId(browserFlowId);
      return {
        pkceVerifier: row['pkce_verifier'] === null ? null : String(row['pkce_verifier']),
        ...(userId === undefined ? {} : { bindingUserId: userId })
      };
    });
  }

  private async exchangeCode(
    provider: StoredProvider,
    code: string,
    redirectUri: string,
    verifier: string | null
  ): Promise<Record<string, unknown>> {
    const parameters = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: provider.clientId
    };
    const body = new URLSearchParams(parameters);
    if (verifier !== null) body.set('code_verifier', verifier);
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
    if (provider.tokenAuthMethod === 'client_secret_basic')
      headers['authorization'] =
        `Basic ${Buffer.from(`${provider.clientId}:${provider.clientSecret}`).toString('base64')}`;
    else if (provider.tokenAuthMethod === 'client_secret_post')
      body.set('client_secret', provider.clientSecret);
    else headers['content-type'] = 'application/json';
    const response = await this.fetchImpl(provider.tokenEndpoint, {
      method: 'POST',
      headers,
      body:
        provider.tokenAuthMethod === 'client_secret_json'
          ? JSON.stringify({
              ...parameters,
              client_secret: provider.clientSecret,
              ...(verifier === null ? {} : { code_verifier: verifier })
            })
          : body,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000)
    });
    const payload: unknown = await boundedJson(response);
    if (!response.ok || !record(payload)) throw new Error('OAUTH_TOKEN_EXCHANGE_FAILED');
    return payload;
  }

  private async loadUserinfo(
    provider: StoredProvider,
    tokenResponse: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const token = tokenResponse['access_token'];
    if (typeof token !== 'string' || token.length === 0)
      throw new Error('OAUTH_ACCESS_TOKEN_INVALID');
    const response = await this.fetchImpl(provider.userinfoEndpoint, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000)
    });
    const payload: unknown = await boundedJson(response);
    if (!response.ok || !record(payload)) throw new Error('OAUTH_USERINFO_FAILED');
    return payload;
  }

  private async bindOrCreate(provider: StoredProvider, identity: MappedIdentity): Promise<number> {
    return withMysqlTransaction(this.database.raw, async (connection) => {
      const lockedProvider = await providerOnConnection(
        connection,
        provider.providerKey,
        true,
        'FOR SHARE'
      );
      const canonicalId = `${lockedProvider.providerKey}_${identity.externalUserId}`;
      const [boundRows] = await connection.execute<RowDataPacket[]>(
        `SELECT identity.user_id FROM external_identities identity JOIN users user ON user.id=identity.user_id
         WHERE identity.provider_id=? AND identity.external_user_id=? AND user.enabled=TRUE`,
        [lockedProvider.providerKey, canonicalId]
      );
      if (boundRows[0] !== undefined) {
        const userId = Number(boundRows[0]['user_id']);
        await lockMysqlUsers(connection, [userId]);
        return userId;
      }
      const status = await this.licenses.status();
      if (status.state !== 'ENTERPRISE_VALID') throw new Error('OAUTH_ACCOUNT_BINDING_FROZEN');
      const trustedEmail = identity.email;
      let userId: number | undefined;
      if (trustedEmail !== null) {
        const [emailRows] = await connection.execute<RowDataPacket[]>(
          'SELECT id FROM users WHERE email=? AND enabled=TRUE',
          [trustedEmail]
        );
        if (emailRows.length > 1) throw new Error('OAUTH_EMAIL_AMBIGUOUS');
        if (emailRows[0] !== undefined) {
          userId = Number(emailRows[0]['id']);
          await lockMysqlUsers(connection, [userId]);
        }
      }
      if (userId === undefined) {
        if (!lockedProvider.autoProvisioningEnabled) throw new Error('OAUTH_ACCOUNT_NOT_BOUND');
        await lockOrganizationReference(connection, 1);
        const username = await availableUsername(connection, canonicalId);
        const [result] = await connection.execute<ResultSetHeader>(
          `INSERT INTO users
           (username,email,nickname,password_hash,must_change_password,enabled,role,organization_id,
            is_fixed_admin,created_at,updated_at)
           VALUES (?,?,?,NULL,FALSE,TRUE,'MEMBER',?,FALSE,?,?)`,
          [username, trustedEmail, identity.displayName, 1, this.now(), this.now()]
        );
        userId = result.insertId;
      }
      await connection.execute(
        `INSERT INTO external_identities
         (provider_id,external_user_id,user_id,email_snapshot,created_at) VALUES (?,?,?,?,?)`,
        [lockedProvider.providerKey, canonicalId, userId, identity.email, this.now()]
      );
      return userId;
    });
  }

  private async bindIdentity(
    provider: StoredProvider,
    identity: MappedIdentity,
    userId: number
  ): Promise<void> {
    const status = await this.licenses.status();
    if (status.state !== 'ENTERPRISE_VALID') throw new Error('OAUTH_ACCOUNT_BINDING_FROZEN');
    await withMysqlTransaction(this.database.raw, async (connection) => {
      const lockedProvider = await providerOnConnection(
        connection,
        provider.providerKey,
        true,
        'FOR SHARE'
      );
      await lockMysqlUsers(connection, [userId]);
      const canonicalId = `${lockedProvider.providerKey}_${identity.externalUserId}`;
      const [identityRows] = await connection.execute<RowDataPacket[]>(
        'SELECT user_id FROM external_identities WHERE provider_id=? AND external_user_id=?',
        [lockedProvider.providerKey, canonicalId]
      );
      if (identityRows[0] !== undefined) {
        if (Number(identityRows[0]['user_id']) === userId) return;
        throw new Error('OAUTH_IDENTITY_ALREADY_BOUND');
      }
      const [providerRows] = await connection.execute<RowDataPacket[]>(
        'SELECT external_user_id FROM external_identities WHERE provider_id=? AND user_id=?',
        [lockedProvider.providerKey, userId]
      );
      if (providerRows[0] !== undefined) throw new Error('OAUTH_PROVIDER_ALREADY_BOUND');
      await connection.execute(
        `INSERT INTO external_identities
         (provider_id,external_user_id,user_id,email_snapshot,created_at) VALUES (?,?,?,?,?)`,
        [lockedProvider.providerKey, canonicalId, userId, identity.email, this.now()]
      );
    });
  }

  private async provider(providerKey: string, requireEnabled: boolean): Promise<StoredProvider> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      `SELECT * FROM oauth_providers WHERE id=?${requireEnabled ? ' AND enabled=TRUE' : ''}`,
      [providerKey]
    );
    if (rows[0] === undefined) throw new Error('OAUTH_PROVIDER_NOT_FOUND');
    const provider = storedProvider(rows[0]);
    if (requireEnabled) await requireHttpsEndpoints(provider);
    return provider;
  }

  private async getPublic(providerKey: string): Promise<object> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      `SELECT id,name,client_id,authorization_endpoint,token_endpoint,userinfo_endpoint,
              configuration,default_organization_id,enabled,tested_at,created_at,updated_at
       FROM oauth_providers WHERE id=?`,
      [providerKey]
    );
    if (rows[0] === undefined) throw new Error('OAUTH_PROVIDER_NOT_FOUND');
    return publicProvider(rows[0]);
  }

  private async requireManage(actorUserId: number): Promise<void> {
    const allowed = await this.authorization.authorize(actorUserId, 'SSO_MANAGE', {
      ownerType: 'SYSTEM'
    });
    if (!allowed.allowed) throw new Error(allowed.reason ?? 'RBAC_DENIED');
  }
}

interface MappedIdentity {
  readonly externalUserId: string;
  readonly email: string | null;
  readonly displayName: string | null;
}

function mappedIdentity(
  provider: StoredProvider,
  userinfo: Record<string, unknown>
): MappedIdentity {
  const externalUserId = jsonPointer(userinfo, provider.mappings.externalUserId);
  if (
    typeof externalUserId !== 'string' ||
    externalUserId.length === 0 ||
    externalUserId.length > 400
  )
    throw new Error('OAUTH_EXTERNAL_USER_ID_INVALID');
  const email =
    provider.mappings.email === undefined
      ? undefined
      : jsonPointer(userinfo, provider.mappings.email);
  const displayName =
    provider.mappings.displayName === undefined
      ? undefined
      : jsonPointer(userinfo, provider.mappings.displayName);
  return {
    externalUserId,
    email: typeof email === 'string' && email.length <= 320 ? email.toLowerCase() : null,
    displayName:
      typeof displayName === 'string' && displayName.trim().length > 0
        ? displayName.trim().slice(0, 128)
        : null
  };
}

function jsonPointer(source: unknown, pointer: string): unknown {
  if (pointer === '') return source;
  let current = source;
  for (const token of pointer.slice(1).split('/')) {
    const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(key)) return undefined;
      current = current[Number(key)];
    } else if (record(current) && Object.hasOwn(current, key)) current = current[key];
    else return undefined;
  }
  return current;
}

function storedProvider(row: RowDataPacket): StoredProvider {
  const configuration = parsedConfiguration(row['configuration']);
  const parsed = oauthProviderInputSchema.parse({
    providerKey: String(row['id']),
    name: String(row['name']),
    clientId: String(row['client_id']),
    clientSecret: String(row['client_secret']),
    authorizationEndpoint: String(row['authorization_endpoint']),
    tokenEndpoint: String(row['token_endpoint']),
    userinfoEndpoint: String(row['userinfo_endpoint']),
    ...configuration
  });
  return {
    ...parsed,
    clientSecret: String(row['client_secret']),
    enabled: Boolean(row['enabled']),
    testedAt: row['tested_at'] === null ? null : Number(row['tested_at'])
  };
}

function publicProvider(row: RowDataPacket): object {
  return {
    providerKey: String(row['id']),
    name: String(row['name']),
    clientId: String(row['client_id']),
    authorizationEndpoint: String(row['authorization_endpoint']),
    tokenEndpoint: String(row['token_endpoint']),
    userinfoEndpoint: String(row['userinfo_endpoint']),
    enabled: Boolean(row['enabled']),
    testedAt: row['tested_at'] === null ? null : Number(row['tested_at']),
    ...parsedConfiguration(row['configuration'])
  };
}

function providerConfiguration(input: OAuthProviderInput): object {
  return {
    scopes: input.scopes,
    pkceMode: input.pkceMode,
    tokenAuthMethod: input.tokenAuthMethod,
    autoProvisioningEnabled: input.autoProvisioningEnabled,
    mappings: input.mappings
  };
}

function providerParameters(
  input: OAuthProviderInput,
  secret: string,
  timestamp: number
): Array<string | number | null> {
  return [
    input.providerKey,
    input.name,
    input.clientId,
    secret,
    input.authorizationEndpoint,
    input.tokenEndpoint,
    input.userinfoEndpoint,
    JSON.stringify(providerConfiguration(input)),
    1,
    timestamp,
    timestamp
  ];
}

function parsedConfiguration(value: unknown): Record<string, unknown> {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!record(parsed)) throw new Error('OAUTH_PROVIDER_CONFIGURATION_INVALID');
  return parsed;
}

async function requireHttpsEndpoints(provider: StoredProvider): Promise<void> {
  for (const endpoint of [
    provider.authorizationEndpoint,
    provider.tokenEndpoint,
    provider.userinfoEndpoint
  ])
    if (new URL(endpoint).protocol !== 'https:') throw new Error('OAUTH_HTTPS_REQUIRED');
}

async function boundedJson(response: Response): Promise<unknown> {
  const body = await response.text();
  if (Buffer.byteLength(body) > 1024 * 1024) throw new Error('OAUTH_RESPONSE_TOO_LARGE');
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error('OAUTH_RESPONSE_INVALID');
  }
}

async function availableUsername(
  connection: Pick<PoolConnection, 'execute'>,
  identity: string
): Promise<string> {
  const base = identity.replaceAll(/[^A-Za-z0-9._-]/g, '_').slice(0, 110) || 'oauth_user';
  for (let index = 0; index < 100; index += 1) {
    const candidate = index === 0 ? base : `${base}_${index}`;
    const [rows] = await connection.execute<RowDataPacket[]>(
      'SELECT id FROM users WHERE username=?',
      [candidate]
    );
    if (rows.length === 0) return candidate;
  }
  throw new Error('OAUTH_USERNAME_EXHAUSTED');
}

async function lockProvider(
  connection: Pick<PoolConnection, 'execute'>,
  providerKey: string,
  mode: 'FOR SHARE' | 'FOR UPDATE'
): Promise<RowDataPacket> {
  const [rows] = await connection.execute<RowDataPacket[]>(
    `SELECT id,name FROM oauth_providers WHERE id=? ${mode}`,
    [providerKey]
  );
  if (rows.length !== 1) throw new Error('OAUTH_PROVIDER_NOT_FOUND');
  return rows[0]!;
}

async function providerOnConnection(
  connection: Pick<PoolConnection, 'execute'>,
  providerKey: string,
  requireEnabled: boolean,
  mode: 'FOR SHARE' | 'FOR UPDATE'
): Promise<StoredProvider> {
  const [rows] = await connection.execute<RowDataPacket[]>(
    `SELECT * FROM oauth_providers WHERE id=?${requireEnabled ? ' AND enabled=TRUE' : ''} ${mode}`,
    [providerKey]
  );
  if (rows[0] === undefined) throw new Error('OAUTH_PROVIDER_NOT_FOUND');
  const provider = storedProvider(rows[0]);
  if (requireEnabled) await requireHttpsEndpoints(provider);
  return provider;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function base64UrlSha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function bindingUserId(browserFlowId: string): number | undefined {
  const match = /^BIND\.([1-9][0-9]*)\.[A-Za-z0-9_-]+$/.exec(browserFlowId);
  if (match === null) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : undefined;
}
