// @test-covers packages/server-core/src/git-skill-repository.ts
import { mkdtemp, mkdir, readFile, stat, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { devNull, tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GithubSkillProvider } from '../../ee/server/src/skill/github-skill-provider.js';
import { GitSkillRepository } from '../../ee/server/src/skill/git-skill-repository.js';
import * as networkPolicy from '../../packages/server-core/src/skill-network-policy.js';

const { runGit, lookup } = vi.hoisted(() => ({ runGit: vi.fn(), lookup: vi.fn() }));
vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: runGit })
}));
vi.mock('node:dns/promises', () => ({ lookup }));

const commitSha = 'a'.repeat(40);
const skill = Buffer.from('---\nname: review\ndescription: Review code\n---\n');
const script = Buffer.from('echo review\n');
let entries: { path: string; content: Buffer }[];
const directories = new Set<string>();

beforeEach(() => {
  lookup.mockReset().mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  entries = [
    { path: 'skills/review/script.sh', content: script },
    { path: 'skills/review/SKILL.md', content: skill }
  ];
  runGit.mockReset().mockImplementation(async (_file, args, options) => {
    if (args.includes('clone')) {
      directories.add(args.at(-1));
      return { stdout: '' };
    }
    if (args[0] === 'rev-parse') return { stdout: commitSha };
    if (args[0] === 'ls-tree')
      return {
        stdout: Buffer.from(
          entries.map((entry) => `100644 blob ${'b'.repeat(40)}\t${entry.path}\0`).join('')
        )
      };
    const entry = entries.find((entry) => `HEAD:${entry.path}` === args[1]);
    if (entry === undefined) throw new Error('Unexpected Git read');
    return { stdout: options.encoding === 'utf8' ? entry.content.toString() : entry.content };
  });
});

afterEach(async () => {
  for (const directory of directories) {
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(directory, { recursive: true, force: true });
  }
  directories.clear();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Git Skill repository snapshots', () => {
  it.each([
    ['https://github.com/acme/skills', 'github.com/acme/skills'],
    ['https://git.example.com/skills.git', 'git.example.com/skills'],
    ['https://git.example.com/~acme/skills.git', 'git.example.com/~acme/skills'],
    ['https://git.example.com/acme/skill%20repo.git', 'git.example.com/acme/skill%20repo'],
    ['https://git.example.com/acme/skill repo.git', 'git.example.com/acme/skill%20repo'],
    ['https://git.example.com/acme/group/skills.git', 'git.example.com/acme/group/skills'],
    ['git@git.example.com:acme/skills.git', 'git.example.com/acme/skills']
  ])('clones %s once and reads a pinned Skill bundle locally', async (repositoryUrl, identity) => {
    const bundle = await new GithubSkillProvider().resolve({
      repositoryUrl,
      skillPath: 'skills/review'
    });
    expect(bundle).toMatchObject({
      repositoryIdentity: identity,
      repositoryUrl,
      commitSha,
      name: 'review',
      contentBytes: skill.length + script.length
    });
    expect(bundle.contentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(bundle.files.map((file) => file.path)).toEqual(
      ['script.sh', 'SKILL.md'].sort((a, b) => a.localeCompare(b))
    );
    const clones = runGit.mock.calls.filter(([, args]) => args.includes('clone'));
    expect(clones).toHaveLength(1);
    expect(clones[0]?.[1]).toEqual(
      expect.arrayContaining([
        '--depth=1',
        '--no-checkout',
        '--no-tags',
        '--',
        repositoryUrl.startsWith('https://') ? new URL(repositoryUrl).href : repositoryUrl
      ])
    );
    expect(clones[0]?.[1].some((arg: string) => arg.startsWith('--filter'))).toBe(false);
    expect(
      runGit.mock.calls.every(
        ([, args]) => args.includes('clone') || ['rev-parse', 'ls-tree', 'show'].includes(args[0])
      )
    ).toBe(true);
  });

  it('builds identical canonical content regardless of transport and tree order', async () => {
    const repository = new GithubSkillProvider();
    const github = await repository.resolve({
      repositoryUrl: 'https://github.com/acme/skills',
      skillPath: 'skills/review'
    });
    entries.reverse();
    const gitlab = await repository.resolve({
      repositoryUrl: 'https://git.example.com/acme/skills',
      skillPath: 'skills/review'
    });
    expect(github.files).toEqual(gitlab.files);
    expect(github.contentHash).toBe(gitlab.contentHash);
    expect(github.archiveHash).toBe(gitlab.archiveHash);
  });

  it('supports repository-root skills and resolving candidates by name', async () => {
    entries = [{ path: 'SKILL.md', content: skill }];
    const repository = new GithubSkillProvider();
    await expect(
      repository.resolve({ repositoryUrl: 'https://github.com/acme/skills', skillPath: '.' })
    ).resolves.toMatchObject({ skillPath: '.', name: 'review' });
    await expect(
      repository.resolve({ repositoryUrl: 'https://github.com/acme/skills', skillName: 'review' })
    ).resolves.toMatchObject({ skillPath: '.', name: 'review' });
  });

  it('discovers metadata only in standard directories and respects query and limit', async () => {
    entries.push(
      { path: 'random/deep/rejected/SKILL.md', content: skill },
      { path: '.agents/skills/review/SKILL.md', content: skill }
    );
    const candidates = await new GitSkillRepository().discover(
      'https://github.com/acme/skills',
      'review',
      1
    );
    expect(candidates).toEqual([
      {
        id: 'github.com/acme/skills/skills/review',
        source: 'github.com/acme/skills',
        skillPath: 'skills/review',
        name: 'review',
        description: 'Review code'
      }
    ]);
    expect(runGit.mock.calls.filter(([, args]) => args[0] === 'show')).toHaveLength(1);
  });

  it.each(['../review', '/review', 'skills/../review', 'skills\\review'])(
    'rejects unsafe Skill path %s before network access',
    async (skillPath) => {
      await expect(
        new GithubSkillProvider().resolve({
          repositoryUrl: 'https://github.com/acme/skills',
          skillPath
        })
      ).rejects.toThrow('SKILL_PATH_UNSAFE');
      expect(lookup).not.toHaveBeenCalled();
      expect(runGit).not.toHaveBeenCalled();
    }
  );

  it.each([
    'file:///tmp/skills',
    'http://example.com/acme/skills',
    'https://user:secret@example.com/acme/skills',
    'https://example.com/acme/skills?token=secret',
    'https://example.com/',
    'https://example.com/.git'
  ])('rejects invalid locator %s before cloning', async (repositoryUrl) => {
    await expect(
      new GithubSkillProvider().resolve({ repositoryUrl, skillPath: '.' })
    ).rejects.toThrow('SKILL_SOURCE_PROVIDER_UNSUPPORTED');
    expect(runGit).not.toHaveBeenCalled();
  });

  it('rejects any private DNS answer before cloning', async () => {
    lookup.mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 }
    ]);
    await expect(
      new GithubSkillProvider().resolve({
        repositoryUrl: 'https://example.com/acme/skills',
        skillPath: '.'
      })
    ).rejects.toThrow('SKILL_SOURCE_ADDRESS_FORBIDDEN');
    expect(runGit).not.toHaveBeenCalled();
  });

  it('does not leave metadata readers running after discovery fails and removes its snapshot', async () => {
    entries = [
      { path: 'skills/broken/SKILL.md', content: Buffer.from('invalid frontmatter') },
      { path: 'skills/review/SKILL.md', content: skill }
    ];
    const execute = runGit.getMockImplementation()!;
    let pendingReads = 0;
    let finishRead: (() => void) | undefined;
    runGit.mockImplementation(async (file, args, options) => {
      if (args[0] === 'show' && args[1] === 'HEAD:skills/review/SKILL.md') {
        pendingReads += 1;
        await new Promise<void>((resolve) => {
          finishRead = resolve;
        });
        pendingReads -= 1;
      }
      return execute(file, args, options);
    });
    try {
      await expect(
        new GitSkillRepository().discover('https://git.example.com/skills.git', '', 40)
      ).rejects.toThrow('SKILL_CONTENT_INVALID');
      expect(pendingReads).toBe(0);
    } finally {
      finishRead?.();
    }
  });

  it.each([false, true])(
    'pins HTTPS DNS and applies the TLS policy (%s) without inherited overrides',
    async (disabled) => {
      vi.stubEnv('GIT_SSL_NO_VERIFY', 'true');
      vi.stubEnv('GIT_CONFIG_COUNT', '1');
      vi.stubEnv('GIT_CONFIG_PARAMETERS', "'http.sslVerify=false'");
      const result = await new GithubSkillProvider(async () => disabled).resolve({
        repositoryUrl: 'https://github.com/acme/skills',
        skillPath: 'skills/review'
      });
      expect(result.tlsVerified).toBe(!disabled);
      const clone = runGit.mock.calls.find(([, args]) => args.includes('clone'))!;
      expect(clone[1]).toEqual(
        expect.arrayContaining([
          'http.curloptResolve=github.com:443:8.8.8.8',
          'http.followRedirects=false',
          'http.proxy=',
          'protocol.allow=never',
          'protocol.https.allow=always'
        ])
      );
      expect(clone[2].env).toMatchObject({
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: devNull
      });
      expect(clone[2].env.GIT_CONFIG_COUNT).toBeUndefined();
      expect(clone[2].env.GIT_CONFIG_PARAMETERS).toBeUndefined();
      expect(clone[2].env.GIT_SSL_NO_VERIFY).toBe(disabled ? 'true' : undefined);
      expect(clone[1]).toContain(`http.sslVerify=${!disabled}`);
    }
  );

  it('keeps SSH configuration independent from the HTTPS TLS setting', async () => {
    const disabled = vi.fn(async () => true);
    const result = await new GithubSkillProvider(disabled).resolve({
      repositoryUrl: 'git@git.example.com:acme/skills.git',
      skillPath: 'skills/review'
    });
    expect(result.tlsVerified).toBe(false);
    expect(disabled).not.toHaveBeenCalled();
    expect(runGit.mock.calls[0]?.[2].env.GIT_SSH_COMMAND).toContain('BatchMode=yes');
  });

  it('rejects forged installation metadata and ambiguous Skill names', async () => {
    entries.push({ path: 'skills/review/.mar-skill-install.json', content: Buffer.from('{}') });
    await expect(
      new GithubSkillProvider().resolve({
        repositoryUrl: 'https://github.com/acme/skills',
        skillPath: 'skills/review'
      })
    ).rejects.toThrow('SKILL_CONTENT_INVALID');
    entries = entries.filter((entry) => !entry.path.endsWith('.json'));
    entries.push({ path: '.agents/skills/review/SKILL.md', content: skill });
    await expect(
      new GithubSkillProvider().resolve({
        repositoryUrl: 'https://github.com/acme/skills',
        skillName: 'review'
      })
    ).rejects.toThrow('SKILL_CONTENT_INVALID');
  });

  it('reads Skill files without an arbitrary content-size limit', async () => {
    entries[0]!.content = Buffer.alloc(6 * 1024 * 1024, 'a');
    const bundle = await new GitSkillRepository().resolve({
      repositoryUrl: 'https://git.example.com/skills.git',
      skillPath: 'skills/review'
    });
    expect(bundle.contentBytes).toBe(entries[0]!.content.length + skill.length);
    expect(
      Buffer.from(
        bundle.files.find((file) => file.path === 'script.sh')!.contentBase64,
        'base64'
      ).equals(entries[0]!.content)
    ).toBe(true);
  });

  it('reads repositories and Skills without arbitrary file-count limits', async () => {
    entries.push(
      ...Array.from({ length: 5001 }, (_, index) => ({
        path: `other/file-${index}`,
        content: Buffer.alloc(0)
      })),
      ...Array.from({ length: 1001 }, (_, index) => ({
        path: `skills/review/file-${index}`,
        content: Buffer.alloc(0)
      }))
    );
    const bundle = await new GitSkillRepository().resolve({
      repositoryUrl: 'https://git.example.com/skills.git',
      skillPath: 'skills/review'
    });
    expect(bundle.files).toHaveLength(1003);
    expect(bundle.files.some((file) => file.path.startsWith('other/'))).toBe(false);
  });

  it('reports clone failure without leaking remote diagnostics and removes the temporary directory', async () => {
    runGit.mockImplementation(async (_file, args) => {
      directories.add(args.at(-1));
      throw new Error('credential-bearing Git diagnostic');
    });
    await expect(
      new GithubSkillProvider().resolve({
        repositoryUrl: 'https://github.com/acme/skills',
        skillPath: '.'
      })
    ).rejects.toThrow(/^SKILL_SOURCE_UNAVAILABLE$/u);
  });

  it('uses real HTTPS Git with the TLS policy and reads the complete snapshot after the source goes offline', async () => {
    const childProcess =
      await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const exec = promisify(childProcess.execFile);
    const root = await mkdtemp(path.join(tmpdir(), 'mar-skill-source-'));
    const source = path.join(root, '~acme/skill repo.git');
    let server: ReturnType<typeof createServer> | undefined;
    try {
      await mkdir(path.join(source, 'skills/review'), { recursive: true });
      await writeFile(path.join(source, 'skills/review/SKILL.md'), skill);
      await writeFile(path.join(source, 'skills/review/script.sh'), script);
      await exec('git', ['init', '--initial-branch=main', source]);
      await exec('git', ['-C', source, 'add', '.']);
      await exec('git', [
        '-C',
        source,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.com',
        'commit',
        '-m',
        'fixture'
      ]);
      const revision = (await exec('git', ['-C', source, 'rev-parse', 'HEAD'])).stdout.trim();
      const cert = path.join(root, 'cert.pem');
      const key = path.join(root, 'key.pem');
      await exec('openssl', [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=git.example.com',
        '-addext',
        'subjectAltName=DNS:git.example.com',
        '-keyout',
        key,
        '-out',
        cert
      ]);
      const requests: string[] = [];
      server = createServer(
        { cert: await readFile(cert), key: await readFile(key) },
        async (request, response) => {
          try {
            const url = new URL(request.url!, 'https://git.example.com');
            requests.push(url.pathname);
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const body = Buffer.concat(chunks);
            const operation = exec('git', ['http-backend'], {
              encoding: 'buffer',
              env: {
                ...process.env,
                GIT_PROJECT_ROOT: root,
                GIT_HTTP_EXPORT_ALL: '1',
                PATH_INFO: decodeURIComponent(url.pathname),
                QUERY_STRING: url.search.slice(1),
                REQUEST_METHOD: request.method,
                CONTENT_TYPE: request.headers['content-type'] ?? '',
                CONTENT_LENGTH: String(body.length)
              }
            });
            operation.child.stdin?.end(body);
            const { stdout } = await operation;
            const boundary = stdout.indexOf('\r\n\r\n');
            for (const line of stdout.subarray(0, boundary).toString().split('\r\n')) {
              const separator = line.indexOf(':');
              const name = line.slice(0, separator);
              const value = line.slice(separator + 1).trim();
              if (name.toLowerCase() === 'status')
                response.statusCode = Number(value.split(' ')[0]);
              else response.setHeader(name, value);
            }
            response.end(stdout.subarray(boundary + 4));
          } catch {
            response.writeHead(500).end();
          }
        }
      );
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      const repositoryUrl = `https://git.example.com:${(server.address() as AddressInfo).port}/~acme/skill%20repo.git`;
      // Only public-DNS admission is replaced; TLS and Git transport remain real.
      vi.spyOn(networkPolicy, 'assertPublicSkillHost').mockResolvedValue({
        address: '127.0.0.1',
        family: 4
      });
      runGit.mockImplementation(async (_file, args, options) => {
        if (args.includes('clone')) {
          const directory = args.at(-1);
          directories.add(directory);
          const result = await exec('git', args, options);
          await new Promise<void>((resolve) => server!.close(() => resolve()));
          await rm(source, { recursive: true, force: true });
          return result;
        }
        return exec('git', args, options);
      });
      await expect(
        new GithubSkillProvider().resolve({ repositoryUrl, skillPath: 'skills/review' })
      ).rejects.toThrow('SKILL_SOURCE_UNAVAILABLE');
      const bundle = await new GithubSkillProvider(async () => true).resolve({
        repositoryUrl,
        skillPath: 'skills/review'
      });
      expect(bundle.commitSha).toBe(revision);
      expect(bundle.tlsVerified).toBe(false);
      expect(requests).toContain('/~acme/skill%20repo.git/info/refs');
      expect(requests).toContain('/~acme/skill%20repo.git/git-upload-pack');
      expect(bundle.files).toEqual(
        expect.arrayContaining([
          { path: 'SKILL.md', contentBase64: skill.toString('base64') },
          { path: 'script.sh', contentBase64: script.toString('base64') }
        ])
      );
    } finally {
      server?.closeAllConnections();
      if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
});
