import { describe, expect, it, vi } from 'vitest';
import { PersonalGitService } from '../../src/personal-git-service.js';

function fixture() {
  const documents = new Map<number, string>();
  const execute = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (sql.includes('SELECT id FROM users')) return [[{ id: values[0] }], []];
    if (sql.startsWith('SELECT'))
      return [
        [{ configuration: documents.get(values[0] as number) }].filter((row) => row.configuration)
      ];
    if (sql.startsWith('INSERT')) {
      if (!documents.has(values[0] as number))
        documents.set(values[0] as number, values[1] as string);
    } else if (sql.startsWith('UPDATE')) documents.set(values[2] as number, values[0] as string);
    return [{ affectedRows: 1 }];
  });
  const connection = {
    execute,
    beginTransaction: vi.fn(),
    commit: vi.fn(),
    rollback: vi.fn(),
    release: vi.fn()
  };
  const service = new PersonalGitService({
    raw: {
      execute,
      getConnection: async () => connection
    }
  } as never);
  return { service, documents, connection };
}
const input = {
  name: 'Work',
  protocol: 'HTTPS',
  host: 'git.example.com',
  port: 443,
  pathPrefix: '',
  username: 'alice',
  commitName: 'Alice',
  commitEmail: 'alice@example.test',
  secret: 'test-only-password'
};

describe('personal Git configuration storage', () => {
  it('keeps an omitted SSH passphrase and explicitly removes it with null', async () => {
    const { service } = fixture();
    const ssh = {
      ...input,
      protocol: 'SSH',
      port: 22,
      username: 'git',
      secret: '-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n-----END OPENSSH PRIVATE KEY-----',
      passphrase: 'fixture-passphrase'
    };
    const saved = await service.createCredential(1, ssh);
    const { secret: _secret, passphrase: _passphrase, ...metadata } = ssh;
    void _secret;
    void _passphrase;
    await service.updateCredential(1, saved.credentials[0]!.id, metadata);
    expect((await service.get(1)).credentials[0]?.hasPassphrase).toBe(true);
    await service.updateCredential(1, saved.credentials[0]!.id, { ...metadata, passphrase: null });
    expect((await service.get(1)).credentials[0]?.hasPassphrase).toBe(false);
    expect((await service.getRuntime(1)).credentials[0]?.secret === ssh.secret).toBe(true);
  });
  it('isolates users and never projects secrets in management responses', async () => {
    const { service } = fixture();
    expect(await service.get(1)).toEqual({ credentials: [] });
    const saved = await service.createCredential(1, input);
    expect(saved.credentials[0]).toMatchObject({
      name: 'Work',
      hasSecret: true,
      hasPassphrase: false
    });
    expect(JSON.stringify(saved)).not.toContain(input.secret);
    expect((await service.getRuntime(1)).credentials[0]?.secret).toBe(input.secret);
    expect((await service.get(2)).credentials).toEqual([]);
    expect((await service.get(1)).credentials[0]?.commitEmail).toBe('alice@example.test');
  });

  it('rejects obsolete account-level identity without rewriting saved configuration', async () => {
    const { service, documents, connection } = fixture();
    const legacy = JSON.stringify({
      identity: { name: 'Legacy User', email: 'legacy@example.test' },
      credentials: [{ ...input, id: 'legacy-a' }]
    });
    documents.set(1, legacy);

    await expect(service.get(1)).rejects.toThrow('GIT_CONFIGURATION_INVALID');
    await expect(service.getRuntime(1)).rejects.toThrow('GIT_CONFIGURATION_INVALID');
    await expect(service.updateCredential(1, 'legacy-a', input)).rejects.toThrow(
      'GIT_CONFIGURATION_INVALID'
    );
    expect(documents.get(1)).toBe(legacy);
    expect(connection.rollback).toHaveBeenCalledTimes(1);
  });

  it('preserves write-only fields, rejects duplicate scopes, and scopes IDs to their owner', async () => {
    const { service, connection } = fixture();
    const created = await service.createCredential(1, input);
    const id = created.credentials[0]!.id;
    const { secret: _secret, ...metadata } = input;
    void _secret;
    await service.updateCredential(1, id, { ...metadata, name: 'Renamed' });
    expect((await service.getRuntime(1)).credentials[0]?.secret).toBe(input.secret);
    await expect(service.createCredential(1, { ...input, name: 'Duplicate' })).rejects.toThrow(
      'GIT_CREDENTIAL_SCOPE_CONFLICT'
    );
    await expect(service.removeCredential(2, id)).rejects.toThrow('GIT_CREDENTIAL_NOT_FOUND');
    expect(connection.rollback).toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalled();
    await service.removeCredential(1, id);
    expect((await service.get(1)).credentials).toEqual([]);
  });

  it('rejects protocol switches and untrusted extra fields before writing', async () => {
    const { service } = fixture();
    const saved = await service.createCredential(1, input);
    await expect(
      service.createCredential(1, {
        ...input,
        commitName: 'Alice',
        commitEmail: 'alice@example.test',
        userId: 2
      })
    ).rejects.toThrow('GIT_CONFIGURATION_INVALID');
    await expect(
      service.updateCredential(1, saved.credentials[0]!.id, {
        ...input,
        protocol: 'SSH',
        port: 22,
        secret: undefined
      })
    ).rejects.toThrow('GIT_CREDENTIAL_PROTOCOL_IMMUTABLE');
  });

  it('rejects a missing user before creating the account document and rolls back', async () => {
    const { service, connection } = fixture();
    connection.execute.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id FROM users')) return [[], []] as never;
      return [{ affectedRows: 1 }, []] as never;
    });

    await expect(service.createCredential(7, input)).rejects.toThrow('USER_NOT_FOUND');
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.release).toHaveBeenCalledOnce();
    expect(connection.rollback.mock.invocationCallOrder[0]!).toBeLessThan(
      connection.release.mock.invocationCallOrder[0]!
    );
  });
});
