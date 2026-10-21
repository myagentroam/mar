import { execFile } from 'node:child_process';
import { mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAuthFileCredentialProvider } from '../../src/cli/codex-auth-file.js';

const roots: string[] = [];
const executeFile = promisify(execFile);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function jwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature'
  ].join('.');
}

function authDocument(input: {
  readonly accessToken?: string;
  readonly accountId?: string;
  readonly claimAccountId?: string;
  readonly fedramp?: unknown;
  readonly authMode?: string;
  readonly openAiApiKey?: string | null;
  readonly refreshToken?: string;
  readonly lastRefresh?: string;
}) {
  const accountId = input.accountId ?? 'account-file';
  const claimAccountId = input.claimAccountId ?? accountId;
  const expiresAtSeconds = Math.floor(Date.now() / 1000) + 3600;
  return {
    auth_mode: input.authMode ?? 'chatgpt',
    OPENAI_API_KEY: input.openAiApiKey ?? null,
    tokens: {
      id_token: jwt({
        'https://api.openai.com/auth': {
          chatgpt_account_id: claimAccountId,
          chatgpt_account_is_fedramp: input.fedramp ?? false
        }
      }),
      access_token: input.accessToken ?? jwt({ exp: expiresAtSeconds }),
      refresh_token: input.refreshToken ?? 'refresh-required-by-schema',
      account_id: accountId
    },
    last_refresh: input.lastRefresh ?? new Date().toISOString()
  };
}

async function createAuthFile(document: unknown, mode = 0o600) {
  const root = await mkdtemp(join(tmpdir(), 'mar-agent-codex-auth-'));
  roots.push(root);
  const path = join(root, 'auth.json');
  await writeFile(path, JSON.stringify(document), { mode });
  if (process.platform === 'win32') await setWindowsAcl(path, false);
  return { root, path };
}

describe('Codex auth file credential provider', () => {
  it('returns only the current bearer and bounded account headers from a secure ChatGPT file', async () => {
    const { path } = await createAuthFile(authDocument({ fedramp: true }));
    const provider = new CodexAuthFileCredentialProvider(path);

    const credential = await provider.acquire('REQUEST');

    expect(credential.revision).toBe(1);
    expect(credential.expiresAt).toBeGreaterThan(Date.now());
    expect(credential.bearer.reveal()).toContain('.');
    expect(credential.headers['ChatGPT-Account-ID']?.toString()).toBe('[REDACTED]');
    expect(credential.headers).toMatchObject({ originator: 'myagentroam' });
    expect(credential.headers['user-agent']).toMatch(/^MyAgentRoam\/.+ \(.+; .+\)$/);
    expect(credential.headers).not.toHaveProperty('X-OpenAI-Fedramp');
    expect(JSON.stringify(credential)).not.toContain('account-file');
    expect(JSON.stringify(provider)).toBe('{}');
    await provider.close();
  });

  it('ignores a non-boolean legacy FedRAMP claim', async () => {
    const { path } = await createAuthFile(authDocument({ fedramp: 'legacy-value' }));
    const provider = new CodexAuthFileCredentialProvider(path);

    const credential = await provider.acquire('REQUEST');

    expect(credential.headers).not.toHaveProperty('X-OpenAI-Fedramp');
    await provider.close();
  });

  it('reloads an atomically replaced file and force-reads once after invalidation', async () => {
    const { root, path } = await createAuthFile(
      authDocument({ accessToken: jwt({ exp: 2_000_000_000 }) })
    );
    const provider = new CodexAuthFileCredentialProvider(path);
    const first = await provider.acquire('REQUEST');
    expect(first.bearer.reveal()).toBe(jwt({ exp: 2_000_000_000 }));

    const replacement = join(root, 'auth.next');
    const nextToken = jwt({ exp: 2_000_000_100, generation: 2 });
    await writeFile(replacement, JSON.stringify(authDocument({ accessToken: nextToken })), {
      mode: 0o600
    });
    if (process.platform === 'win32') await setWindowsAcl(replacement, false);
    await rename(replacement, path);

    const second = await provider.acquire('REQUEST');
    expect(second.revision).toBe(2);
    expect(second.bearer.reveal()).toBe(nextToken);

    provider.invalidate(second.revision);
    const forced = await provider.acquire('UNAUTHORIZED');
    expect(forced.revision).toBe(3);
    expect(forced.bearer.reveal()).toBe(nextToken);
    await provider.close();
  });

  it('rejects unsafe permissions, symlinks, account mismatch and unsupported auth modes', async () => {
    if (process.platform !== 'win32') {
      const unsafe = await createAuthFile(authDocument({}), 0o644);
      await expect(
        new CodexAuthFileCredentialProvider(unsafe.path).acquire('REQUEST')
      ).rejects.toMatchObject({ code: 'MAR_AGENT_CREDENTIAL_FILE_UNSAFE' });

      const target = await createAuthFile(authDocument({}));
      const link = join(target.root, 'auth-link.json');
      await symlink(target.path, link);
      await expect(
        new CodexAuthFileCredentialProvider(link).acquire('REQUEST')
      ).rejects.toMatchObject({ code: 'MAR_AGENT_CREDENTIAL_FILE_UNSAFE' });
    }

    const mismatch = await createAuthFile(
      authDocument({ accountId: 'account-one', claimAccountId: 'account-two' })
    );
    await expect(
      new CodexAuthFileCredentialProvider(mismatch.path).acquire('REQUEST')
    ).rejects.toMatchObject({ code: 'MAR_AGENT_CREDENTIAL_FILE_INVALID' });

    const unsupported = await createAuthFile(authDocument({ authMode: 'apikey' }));
    await expect(
      new CodexAuthFileCredentialProvider(unsupported.path).acquire('REQUEST')
    ).rejects.toMatchObject({ code: 'MAR_AGENT_CREDENTIAL_FILE_INVALID' });
  });

  it('accepts a restricted Windows ACL and rejects an additional allowed principal', async () => {
    if (process.platform !== 'win32') return;
    const { path } = await createAuthFile(authDocument({}));
    await setWindowsAcl(path, false);

    await expect(
      new CodexAuthFileCredentialProvider(path).acquire('REQUEST')
    ).resolves.toMatchObject({ revision: 1 });

    await setWindowsAcl(path, true);
    await expect(
      new CodexAuthFileCredentialProvider(path).acquire('REQUEST')
    ).rejects.toMatchObject({ code: 'MAR_AGENT_CREDENTIAL_FILE_UNSAFE' });
  });

  it('rejects expired access credentials without using the refresh token', async () => {
    const { path } = await createAuthFile(
      authDocument({
        accessToken: jwt({ exp: Math.floor(Date.now() / 1000) - 60 }),
        refreshToken: 'must-never-be-refreshed'
      })
    );

    await expect(
      new CodexAuthFileCredentialProvider(path).acquire('REQUEST')
    ).rejects.toMatchObject({ code: 'MAR_AGENT_MODEL_AUTH_FAILED' });
  });

  it('rejects a malformed access token instead of applying the no-expiry fallback', async () => {
    const { path } = await createAuthFile(
      authDocument({
        accessToken: 'not-a-jwt',
        lastRefresh: new Date().toISOString()
      })
    );

    await expect(
      new CodexAuthFileCredentialProvider(path).acquire('REQUEST')
    ).rejects.toMatchObject({ code: 'MAR_AGENT_CREDENTIAL_FILE_INVALID' });
  });
});

async function setWindowsAcl(path: string, includeEveryone: boolean): Promise<void> {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$path = $env:MAR_AGENT_TEST_AUTH_FILE_PATH
if ([string]::IsNullOrWhiteSpace($path)) { throw 'Missing auth file path.' }
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
$administrators = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')
$security = New-Object System.Security.AccessControl.FileSecurity
$security.SetOwner($current)
$security.SetAccessRuleProtection($true, $false)
foreach ($sid in @($current, $system, $administrators)) {
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $sid,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  [void]$security.AddAccessRule($rule)
}
if ($env:MAR_AGENT_TEST_AUTH_FILE_ALLOW_EVERYONE -eq 'true') {
  $everyone = New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $everyone,
    [System.Security.AccessControl.FileSystemRights]::Read,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  [void]$security.AddAccessRule($rule)
}
[System.IO.File]::SetAccessControl($path, $security)
`;
  await executeFile(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    {
      windowsHide: true,
      env: {
        ...process.env,
        MAR_AGENT_TEST_AUTH_FILE_PATH: path,
        MAR_AGENT_TEST_AUTH_FILE_ALLOW_EVERYONE: String(includeEveryone)
      }
    }
  );
}
