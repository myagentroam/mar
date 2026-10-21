import { describe, expect, it } from 'vitest';
import {
  gitCredentialInputSchema,
  gitCredentialSummarySchema,
  formatGitRemoteUrl,
  gitCredentialScopeKey,
  parsePersonalGitRuntime,
  parseGitRemoteUrl,
  personalGitSummarySchema,
  personalGitRuntimeSchema,
  selectGitCredential
} from '../../src/git-identity.js';

const credential = (pathPrefix = '', id = 'default') => ({
  id,
  name: id,
  protocol: 'HTTPS' as const,
  host: 'git.example.com',
  port: 443,
  pathPrefix,
  username: 'alice',
  commitName: 'Alice',
  commitEmail: 'alice@example.test',
  secret: 'test-only-password'
});

describe('personal Git identity and credential matching', () => {
  it('assigns conditional validation errors to the corresponding form fields', () => {
    const result = gitCredentialInputSchema.safeParse({
      ...withoutId(credential()),
      protocol: 'SSH',
      username: 'invalid user',
      secret: 'invalid key'
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues.map((issue) => issue.path)).toEqual([['username'], ['secret']]);
  });
  it('keeps commit identity paired with each credential and permits clearing both fields', () => {
    expect(gitCredentialInputSchema.parse(withoutId(credential())).commitName).toBe('Alice');
    expect(
      gitCredentialInputSchema.safeParse({
        ...withoutId(credential()),
        commitName: '',
        commitEmail: ''
      }).success
    ).toBe(true);
    expect(
      gitCredentialInputSchema.safeParse({
        ...withoutId(credential()),
        commitName: 'Alice',
        commitEmail: ''
      }).success
    ).toBe(false);
    const incompleteSummary = {
      ...credential(),
      hasSecret: true,
      hasPassphrase: false,
      commitName: 'Alice',
      commitEmail: ''
    };
    expect(gitCredentialSummarySchema.safeParse(incompleteSummary).success).toBe(false);
    expect(personalGitSummarySchema.safeParse({ credentials: [incompleteSummary] }).success).toBe(
      false
    );
  });

  it('normalizes complete remote addresses and SSH-host rules, and selects exact repositories first', () => {
    const parsed = gitCredentialInputSchema.parse({
      ...withoutId(credential('/team/')),
      host: 'GIT.EXAMPLE.COM'
    });
    expect(parsed.host).toBe('git.example.com');
    expect(parsed.pathPrefix).toBe('team');
    const entries = [credential(), credential('team', 'team'), credential('team/app.git', 'repo')];
    const target = { protocol: 'HTTPS' as const, host: 'git.example.com', port: 443 };
    expect(selectGitCredential(entries, { ...target, path: 'team/app.git' })?.id).toBe('repo');
    expect(selectGitCredential(entries, { ...target, path: '/team' })?.id).toBe('team');
    expect(selectGitCredential(entries, { ...target, path: 'team-other/app.git' })?.id).toBe(
      'default'
    );
    expect(selectGitCredential(entries, { ...target, path: 'Team/app.git' })?.id).toBe('default');
    expect(
      selectGitCredential(entries, { ...target, port: 8443, path: 'team/app.git' })
    ).toBeUndefined();
    expect(
      selectGitCredential(entries, { ...target, protocol: 'SSH', path: 'team/app.git' })
    ).toBeUndefined();
    expect(parseGitRemoteUrl('https://Git.Example.com:8443/team/app.git')).toEqual({
      protocol: 'HTTPS',
      host: 'git.example.com',
      port: 8443,
      pathPrefix: 'team/app.git'
    });
    expect(parseGitRemoteUrl('git@git.example.com:team/app.git')).toEqual({
      protocol: 'SSH',
      host: 'git.example.com',
      port: 22,
      pathPrefix: 'team/app.git',
      username: 'git'
    });
    expect(parseGitRemoteUrl('git@git.example.com')).toEqual({
      protocol: 'SSH',
      host: 'git.example.com',
      port: 22,
      pathPrefix: '',
      username: 'git'
    });
    expect(parseGitRemoteUrl('ssh://git@git.example.com:2222')).toEqual({
      protocol: 'SSH',
      host: 'git.example.com',
      port: 2222,
      pathPrefix: '',
      username: 'git'
    });
    expect(
      formatGitRemoteUrl({
        ...credential('team/app.git'),
        protocol: 'SSH',
        port: 22,
        username: 'git'
      })
    ).toBe('git@git.example.com:team/app.git');
    expect(
      formatGitRemoteUrl({
        ...credential(),
        protocol: 'SSH',
        port: 22,
        username: 'git'
      })
    ).toBe('git@git.example.com');
  });

  it('rejects ambiguous scopes, unsafe targets and invalid credential fields', () => {
    expect(gitCredentialScopeKey(credential())).toBe(
      gitCredentialScopeKey(credential('', 'other'))
    );
    expect(
      personalGitRuntimeSchema.safeParse({
        credentials: [credential(), credential('', 'other')]
      }).success
    ).toBe(false);
    for (const host of [
      'https://git.example.com',
      '*.example.com',
      'host/path',
      '-oProxyCommand=x'
    ]) {
      expect(gitCredentialInputSchema.safeParse({ ...withoutId(credential()), host }).success).toBe(
        false
      );
    }
    for (const pathPrefix of ['team/../other', 'team//other', 'team\\other', 'team\nother']) {
      expect(
        gitCredentialInputSchema.safeParse({
          ...withoutId(credential()),
          pathPrefix
        }).success
      ).toBe(false);
    }
    for (const remote of [
      'https://',
      'https://git.example.com',
      'http://git.example.com/team/app.git',
      'https://user:password@git.example.com/team/app.git',
      'git@git.example.com:team/../app.git'
    ])
      expect(() => parseGitRemoteUrl(remote)).toThrow('GIT_CONFIGURATION_INVALID');
    expect(
      gitCredentialInputSchema.safeParse({
        ...withoutId(credential()),
        username: 'a\npassword=leak'
      }).success
    ).toBe(false);
    expect(
      gitCredentialInputSchema.safeParse({
        ...withoutId(credential()),
        passphrase: 'not-for-https'
      }).success
    ).toBe(false);
  });

  it('accepts SSH private keys without mixing the remote login into matching', () => {
    const ssh = gitCredentialInputSchema.parse({
      ...withoutId(credential()),
      protocol: 'SSH',
      port: 22,
      username: 'git',
      secret: '-----BEGIN OPENSSH PRIVATE KEY-----\ntest-only\n-----END OPENSSH PRIVATE KEY-----',
      passphrase: 'test-only-passphrase'
    });
    expect(ssh.protocol).toBe('SSH');
    expect(
      selectGitCredential([{ ...ssh, id: 'ssh' }], {
        protocol: 'SSH',
        host: 'git.example.com',
        port: 22,
        path: 'team/app.git'
      })?.id
    ).toBe('ssh');
  });

  it('accepts current persisted credentials and rejects the obsolete account identity', () => {
    expect(parsePersonalGitRuntime({ credentials: [credential()] })).toEqual({
      credentials: [credential()]
    });
    expect(() =>
      parsePersonalGitRuntime({
        identity: { name: 'Alice', email: 'alice@example.test' },
        credentials: [credential()]
      })
    ).toThrow('GIT_CONFIGURATION_INVALID');
  });
});

function withoutId({ id: _id, ...value }: ReturnType<typeof credential>) {
  void _id;
  return value;
}
