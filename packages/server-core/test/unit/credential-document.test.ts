import { describe, expect, it } from 'vitest';
import {
  parseCredentialDocument,
  projectCredentialDocument
} from '../../src/credential-document.js';

function record(id = 'credential-1', name = 'Account') {
  return {
    id,
    name,
    type: 'CODEX_OAUTH',
    status: 'ACTIVE',
    accessToken: 'fixture-access',
    refreshToken: 'fixture-refresh',
    accountId: 'fixture-account',
    accessTokenExpiresAt: null,
    lastRefreshAt: null,
    lastCheckedAt: null,
    proxy: null,
    revision: 4,
    createdAt: 1,
    updatedAt: 2
  };
}

describe('credential document ownership projection', () => {
  it('rejects legacy versions and global owners in normal reads', () => {
    expect(() =>
      parseCredentialDocument({
        version: 2,
        credentials: [{ ...record(), ownership: { ownerType: 'ENTERPRISE' } }]
      })
    ).toThrow('CODEX_CREDENTIAL_STORE_INVALID');
    expect(() =>
      parseCredentialDocument({
        version: 3,
        credentials: [{ ...record(), ownership: { ownerType: 'ENTERPRISE' } }]
      })
    ).toThrow('CODEX_CREDENTIAL_STORE_INVALID');
  });

  it('projects v1 to root ownership without changing tokens, IDs or order', () => {
    const result = projectCredentialDocument(
      {
        version: 1,
        credentials: [
          { ...record(), fedramp: true, custom: { obsolete: true } },
          record('credential-2', 'Second')
        ]
      },
      { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 },
      100
    );
    expect(result.changed).toBe(true);
    expect(result.document.version).toBe(3);
    expect(result.document.credentials.map((entry) => entry.id)).toEqual([
      'credential-1',
      'credential-2'
    ]);
    expect(result.document.credentials[0]).toMatchObject({
      accessToken: 'fixture-access',
      refreshToken: 'fixture-refresh',
      revision: 5,
      updatedAt: 100,
      ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 }
    });
    expect(result.document.credentials[0]).not.toHaveProperty('fedramp');
    expect(projectCredentialDocument(result.document, undefined, 200)).toEqual({
      document: result.document,
      changed: false
    });
  });

  it('projects unactivated and personal data to the supplied fixed owner only', () => {
    const result = projectCredentialDocument(
      {
        version: 2,
        credentials: [{ ...record(), ownership: { ownerType: 'ENTERPRISE' } }]
      },
      { ownerType: 'PERSONAL', ownerUserId: 7 },
      100
    );
    expect(result.document.credentials[0]?.ownership).toEqual({
      ownerType: 'PERSONAL',
      ownerUserId: 7
    });
    expect(() =>
      projectCredentialDocument(
        {
          version: 2,
          credentials: [{ ...record(), ownership: { ownerType: 'ENTERPRISE' } }]
        },
        undefined,
        100
      )
    ).toThrow('CODEX_CREDENTIAL_SCOPE_FORBIDDEN');
  });

  it('upgrades owned v2 documents without advancing unchanged record revisions', () => {
    const original = { ...record(), ownership: { ownerType: 'PERSONAL', ownerUserId: 9 } };
    expect(
      projectCredentialDocument({ version: 2, credentials: [original] }, undefined, 100)
    ).toEqual({ document: { version: 3, credentials: [original] }, changed: true });
  });

  it('fails before a projected name collision and never drops a credential', () => {
    expect(() =>
      projectCredentialDocument(
        {
          version: 2,
          credentials: [
            { ...record('global', 'Ａ'), ownership: { ownerType: 'ENTERPRISE' } },
            {
              ...record('root', 'a'),
              ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 }
            }
          ]
        },
        { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 },
        100
      )
    ).toThrow('CODEX_CREDENTIAL_NAME_CONFLICT');
  });

  it('rejects unknown versions, bad records and duplicate IDs without exposing tokens', () => {
    for (const raw of [
      { version: 99, credentials: [] },
      {
        version: 2,
        credentials: [
          { ...record(), ownership: { ownerType: 'ENTERPRISE' }, extra: 'private-data' }
        ]
      },
      { version: 1, credentials: [record(), record()] }
    ]) {
      expect(() =>
        projectCredentialDocument(raw, { ownerType: 'PERSONAL', ownerUserId: 1 }, 100)
      ).toThrow('CODEX_CREDENTIAL_STORE_INVALID');
    }
  });
});
