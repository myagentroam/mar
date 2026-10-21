import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const servers: Array<ReturnType<typeof createServer>> = [];
function executeWithInput(file: string, arguments_: string[], input: string, cwd: string) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = execFile(file, arguments_, { cwd }, (error, stdout, stderr) =>
      error ? reject(error) : resolve({ stdout, stderr })
    );
    child.stdin?.end(input);
  });
}

function executeWithClosedStdin(file: string, arguments_: string[], cwd: string) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(file, arguments_, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({ stdout, stderr, code }));
  });
}
const homes: string[] = [];
beforeAll(async () => {
  await execute('pnpm', ['build'], { cwd: process.cwd() });
});
afterEach(async () =>
  Promise.all([
    ...homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
    ...servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  ])
);

async function responsesServer(requests: unknown[], permission?: 'ask' | 'deny') {
  let permissionSent = false;
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const parsed = JSON.parse(body);
      requests.push(parsed);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (permission && !permissionSent && JSON.stringify(parsed.tools).includes('exec')) {
        permissionSent = true;
        response.end(
          [
            { type: 'response.created', response: { id: 'permission-response' } },
            {
              type: 'response.output_item.done',
              item: {
                type: 'function_call',
                id: 'permission-item',
                call_id: 'permission-call',
                name: 'exec',
                namespace: 'tools',
                arguments: JSON.stringify({
                  command: 'exit 99',
                  permission: { action: permission, reason: 'Confirm the shared target.' }
                })
              }
            },
            {
              type: 'response.completed',
              response: {
                id: 'permission-response',
                usage: { input_tokens: 10, output_tokens: 10 }
              }
            }
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join('')
        );
        return;
      }
      response.end(
        [
          {
            type: 'response.created',
            response: { id: `response-${requests.length}` }
          },
          {
            type: 'response.output_text.done',
            item_id: `message-${requests.length}`,
            phase: 'final_answer',
            text: 'Completed'
          },
          {
            type: 'response.completed',
            response: {
              usage: {
                input_tokens: 10,
                output_tokens: 2,
                input_tokens_details: {}
              }
            }
          }
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join('')
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server unavailable');
  return `http://127.0.0.1:${address.port}`;
}

async function writeResponsesModel(home: string, baseUrl: string) {
  await mkdir(join(home, '.mar', 'agent'), { recursive: true });
  await writeFile(
    join(home, '.mar', 'agent', 'models.json'),
    JSON.stringify({
      version: 1,
      defaultModelId: 'reasoning',
      models: [
        {
          id: 'reasoning',
          name: 'Reasoning',
          protocol: 'OPENAI_RESPONSES',
          baseUrl,
          apiKey: 'test-key',
          modelId: 'reasoning-model',
          contextWindowTokens: 200000,
          maxOutputTokens: 4096,
          inputCapabilities: ['TEXT'],
          outputCapabilities: ['TEXT'],
          reasoningEfforts: ['low', 'high'],
          hostedWebSearch: false,
          responsesPreviousResponseId: false,
          enabled: true
        }
      ]
    })
  );
}

function jwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature'
  ].join('.');
}

async function writeCodexAuthModel(home: string, baseUrl: string) {
  await mkdir(join(home, '.mar', 'agent'), { recursive: true });
  await writeFile(
    join(home, '.mar', 'agent', 'models.json'),
    JSON.stringify({
      version: 1,
      defaultModelId: 'codex',
      models: [
        {
          id: 'codex',
          name: 'Codex',
          protocol: 'OPENAI_RESPONSES',
          baseUrl,
          credential: { type: 'CODEX_AUTH_FILE' },
          modelId: 'gpt-codex',
          contextWindowTokens: 200000,
          maxOutputTokens: 4096,
          inputCapabilities: ['TEXT'],
          outputCapabilities: ['TEXT'],
          reasoningEfforts: ['high'],
          hostedWebSearch: false,
          responsesTransport: { transport: 'HTTP', httpVersion: '1.1' },
          responsesPreviousResponseId: false,
          enabled: true
        }
      ]
    })
  );
}

async function writeCodexAuthFile(root: string, mode = 0o600) {
  const path = join(root, 'codex-auth.json');
  const accountId = 'account-cli-test';
  await writeFile(
    path,
    JSON.stringify({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: jwt({
          'https://api.openai.com/auth': {
            chatgpt_account_id: accountId,
            chatgpt_account_is_fedramp: true
          }
        }),
        access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
        refresh_token: 'refresh-schema-only',
        account_id: accountId
      },
      last_refresh: new Date().toISOString()
    }),
    { mode }
  );
  return path;
}

describe('maragent CLI', () => {
  it.each(['ask', 'deny'] as const)(
    'returns the Auto %s outcome without executing the denied call',
    async (action) => {
      const home = await mkdtemp(join(tmpdir(), 'mar-cli-auto-'));
      homes.push(home);
      const requests: unknown[] = [];
      await writeResponsesModel(home, await responsesServer(requests, action));
      const result = await executeWithClosedStdin(
        process.execPath,
        [
          'dist/cli/main.js',
          'run',
          'Inspect shared target',
          '--home',
          home,
          '--permission-mode',
          'auto',
          '--format',
          'json'
        ],
        process.cwd()
      );
      expect(result.code).toBe(action === 'ask' ? 3 : 0);
      const output = JSON.parse(result.stdout);
      expect(output).toMatchObject({
        status: 'completed',
        finalAnswer: action === 'ask' ? '' : 'Completed'
      });
      const workRequests = requests.filter((request) =>
        JSON.stringify((request as { tools?: unknown }).tools ?? []).includes('exec')
      );
      if (action === 'ask') {
        expect(output.permissionStop).toMatchObject({
          action,
          reason: 'Confirm the shared target.'
        });
        expect(workRequests).toHaveLength(1);
      } else {
        expect(output.permissionStop).toBeUndefined();
        expect(workRequests).toHaveLength(2);
        const followup = workRequests[1] as {
          input: Array<{ type: string; call_id?: string; output?: string }>;
        };
        const toolResult = followup.input.find(
          (item) => item.type === 'function_call_output' && item.call_id === 'permission-call'
        );
        const failedCall = JSON.parse(toolResult!.output!);
        expect(failedCall).toMatchObject({ error: 'MAR_AGENT_PERMISSION_DENIED' });
        expect(failedCall).not.toHaveProperty('exitCode');
      }
      expect(result.stdout).not.toContain('exitCode');
    }
  );
  it.each(['invalid', null, ['STANDARD'], { toString: 'LITE' }].map((encoding) => ({ encoding })))(
    'rejects malformed legacy catalog encoding $encoding without changing the file',
    async ({ encoding }) => {
      const home = await mkdtemp(join(tmpdir(), 'mar-cli-legacy-invalid-'));
      homes.push(home);
      await writeCodexAuthModel(home, 'https://chatgpt.com/backend-api/codex');
      const path = join(home, '.mar', 'agent', 'models.json');
      const saved = JSON.parse(await readFile(path, 'utf8'));
      saved.models[0].responsesEncoding = encoding;
      const before = JSON.stringify(saved);
      await writeFile(path, before);
      await expect(
        execute(process.execPath, ['dist/cli/main.js', '--home', home, 'models', 'list'], {
          cwd: process.cwd()
        })
      ).rejects.toMatchObject({
        stderr: expect.stringContaining('MAR_AGENT_MODEL_CONFIG_INVALID')
      });
      expect(await readFile(path, 'utf8')).toBe(before);
    }
  );

  it.each([
    ['OPENAI_RESPONSES', 'stand'],
    ['OPENAI_RESPONSES', 'standard'],
    ['OPENAI_RESPONSES', 'lite'],
    ['ANTHROPIC_MESSAGES', 'lite']
  ])('rejects encoding for %s / %s without changing the catalog', async (protocol, encoding) => {
    const home = await mkdtemp(join(tmpdir(), 'mar-cli-invalid-encoding-'));
    homes.push(home);
    await writeCodexAuthModel(home, 'https://chatgpt.com/backend-api/codex');
    const path = join(home, '.mar', 'agent', 'models.json');
    const before = await readFile(path, 'utf8');
    await expect(
      execute(
        process.execPath,
        [
          'dist/cli/main.js',
          '--home',
          home,
          'models',
          'edit',
          'codex',
          '--protocol',
          protocol!,
          '--responses-encoding',
          encoding!
        ],
        { cwd: process.cwd() }
      )
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('MAR_AGENT_CLI_ARGUMENT_INVALID')
    });
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it.each([undefined, 'STANDARD', 'LITE'])(
    'normalizes legacy Codex catalog encoding %s to standard Responses',
    async (encoding) => {
      const home = await mkdtemp(join(tmpdir(), 'mar-cli-encoding-'));
      homes.push(home);
      const requests: unknown[] = [];
      await writeCodexAuthModel(home, await responsesServer(requests));
      const authFile = await writeCodexAuthFile(home);
      const path = join(home, '.mar', 'agent', 'models.json');
      if (encoding !== undefined) {
        const saved = JSON.parse(await readFile(path, 'utf8'));
        saved.models[0].responsesEncoding = encoding;
        await writeFile(path, JSON.stringify(saved));
      }
      await execute(
        process.execPath,
        [
          'dist/cli/main.js',
          '--home',
          home,
          '--codex-auth-file',
          authFile,
          'models',
          'test',
          'codex'
        ],
        { cwd: process.cwd() }
      );
      expect(requests).toHaveLength(1);
      expect(Object.hasOwn(requests[0] as object, 'instructions')).toBe(true);
      expect(JSON.stringify(requests)).not.toContain('additional_tools');
      await execute(
        process.execPath,
        ['dist/cli/main.js', '--home', home, 'models', 'edit', 'codex', '--title-generation'],
        { cwd: process.cwd() }
      );
      expect(JSON.parse(await readFile(path, 'utf8')).models[0]).not.toHaveProperty(
        'responsesEncoding'
      );
    }
  );

  it('toggles Codex Fast mode and forwards priority only while enabled', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-cli-fast-'));
    homes.push(home);
    const requests: unknown[] = [];
    await writeCodexAuthModel(home, await responsesServer(requests));
    const authFile = await writeCodexAuthFile(home);
    const path = join(home, '.mar', 'agent', 'models.json');
    const testModel = async () =>
      execute(
        process.execPath,
        [
          'dist/cli/main.js',
          '--home',
          home,
          '--codex-auth-file',
          authFile,
          'models',
          'test',
          'codex'
        ],
        { cwd: process.cwd() }
      );
    const editModel = async (flag: string) =>
      execute(
        process.execPath,
        ['dist/cli/main.js', '--home', home, 'models', 'edit', 'codex', flag],
        { cwd: process.cwd() }
      );

    await testModel();
    await editModel('--fast-mode');
    expect(JSON.parse(await readFile(path, 'utf8')).models[0].fastMode).toBe(true);
    await testModel();
    await editModel('--no-fast-mode');
    await testModel();
    expect(requests.map((body) => (body as Record<string, unknown>).service_tier)).toEqual([
      undefined,
      'priority',
      undefined
    ]);
    const catalog = JSON.parse(await readFile(path, 'utf8'));
    catalog.models[0].serviceTier = 'ultrafast';
    await writeFile(path, JSON.stringify(catalog));
    await editModel('--code-mode');
    expect(JSON.parse(await readFile(path, 'utf8')).models[0].serviceTier).toBe('ultrafast');
    await editModel('--fast-mode');
    expect(JSON.parse(await readFile(path, 'utf8')).models[0].serviceTier).toBe('priority');
    await editModel('--no-fast-mode');
    expect(JSON.parse(await readFile(path, 'utf8')).models[0].serviceTier).toBe('default');

    const before = await readFile(path, 'utf8');
    await expect(
      execute(
        process.execPath,
        [
          'dist/cli/main.js',
          '--home',
          home,
          'models',
          'edit',
          'codex',
          '--credential',
          'api-key',
          '--fast-mode'
        ],
        { cwd: process.cwd() }
      )
    ).rejects.toMatchObject({ stderr: expect.stringContaining('MAR_AGENT_CLI_ARGUMENT_INVALID') });
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('prints the stable command name and command tree', async () => {
    const { stdout } = await execute(process.execPath, ['dist/cli/main.js', '--help'], {
      cwd: process.cwd()
    });
    expect(stdout).toContain('maragent run');
    expect(stdout).toContain('maragent models');
    expect(stdout).toContain('--reasoning-effort EFFORT');
  });

  it('lists model metadata without exposing API keys', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-cli-home-'));
    homes.push(home);
    await mkdir(join(home, '.mar', 'agent'), { recursive: true });
    await writeFile(
      join(home, '.mar', 'agent', 'models.json'),
      JSON.stringify({
        version: 1,
        models: [
          {
            id: 'coding',
            name: 'Coding',
            protocol: 'ANTHROPIC_MESSAGES',
            baseUrl: 'https://example.test',
            apiKey: 'never-print-me',
            modelId: 'coding',
            contextWindowTokens: 200000,
            maxOutputTokens: 4096,
            inputCapabilities: ['TEXT'],
            outputCapabilities: ['TEXT'],
            reasoningEfforts: [],
            hostedWebSearch: false,
            enabled: true
          }
        ]
      })
    );
    const { stdout } = await execute(
      process.execPath,
      ['dist/cli/main.js', '--home', home, 'models', 'list'],
      { cwd: process.cwd() }
    );
    expect(stdout).toContain('coding');
    expect(stdout).not.toContain('never-print-me');
  });

  it.each([true, false])(
    'discards the legacy high-density catalog value %s on edit',
    async (value) => {
      const home = await mkdtemp(join(tmpdir(), 'mar-cli-legacy-compaction-'));
      homes.push(home);
      await writeCodexAuthModel(home, 'https://chatgpt.com/backend-api/codex');
      const path = join(home, '.mar', 'agent', 'models.json');
      const catalog = JSON.parse(await readFile(path, 'utf8'));
      catalog.models[0].highDensityCompaction = value;
      catalog.models[0].conversationModel = value;
      await writeFile(path, JSON.stringify(catalog));
      await execute(
        process.execPath,
        ['dist/cli/main.js', '--home', home, 'models', 'edit', 'codex'],
        {
          cwd: process.cwd()
        }
      );
      const saved = JSON.parse(await readFile(path, 'utf8'));
      delete catalog.models[0].highDensityCompaction;
      expect(saved).toMatchObject(catalog);
      expect(saved.models[0]).not.toHaveProperty('highDensityCompaction');
    }
  );

  it.each(['--high-density-compaction', '--no-high-density-compaction'])(
    'rejects removed compaction flag %s without changing the catalog',
    async (flag) => {
      const home = await mkdtemp(join(tmpdir(), 'mar-cli-removed-compaction-'));
      homes.push(home);
      await writeCodexAuthModel(home, 'https://chatgpt.com/backend-api/codex');
      const path = join(home, '.mar', 'agent', 'models.json');
      const before = await readFile(path, 'utf8');
      await expect(
        execute(
          process.execPath,
          ['dist/cli/main.js', '--home', home, 'models', 'edit', 'codex', flag],
          { cwd: process.cwd() }
        )
      ).rejects.toMatchObject({
        stderr: expect.stringContaining('MAR_AGENT_CLI_ARGUMENT_INVALID')
      });
      expect(await readFile(path, 'utf8')).toBe(before);
    }
  );

  it.each(['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'])(
    'defaults new %s models to 256000/32000 and preserves explicit limits on edit',
    async (protocol) => {
      const home = await mkdtemp(join(tmpdir(), 'mar-cli-model-limits-'));
      homes.push(home);
      await executeWithInput(
        process.execPath,
        [
          'dist/cli/main.js',
          '--home',
          home,
          'models',
          'add',
          'coding',
          '--name',
          'Coding',
          '--protocol',
          protocol,
          '--url',
          'https://example.test',
          '--model',
          'coding',
          '--api-key-stdin'
        ],
        'private-key\n',
        process.cwd()
      );
      const path = join(home, '.mar', 'agent', 'models.json');
      expect(JSON.parse(await readFile(path, 'utf8')).models[0]).toMatchObject({
        contextWindowTokens: 256_000,
        maxOutputTokens: 32_000
      });
      await execute(
        process.execPath,
        [
          'dist/cli/main.js',
          '--home',
          home,
          'models',
          'edit',
          'coding',
          '--context',
          '120000',
          '--max-output',
          '16384'
        ],
        { cwd: process.cwd() }
      );
      await execute(
        process.execPath,
        ['dist/cli/main.js', '--home', home, 'models', 'edit', 'coding', '--name', 'Renamed'],
        { cwd: process.cwd() }
      );
      expect(JSON.parse(await readFile(path, 'utf8')).models[0]).toMatchObject({
        name: 'Renamed',
        contextWindowTokens: 120_000,
        maxOutputTokens: 16_384
      });
    }
  );

  it('adds and removes models without accepting a key argument', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-cli-model-home-'));
    homes.push(home);
    await executeWithInput(
      process.execPath,
      [
        'dist/cli/main.js',
        '--home',
        home,
        'models',
        'add',
        'coding',
        '--name',
        'Coding',
        '--protocol',
        'OPENAI_RESPONSES',
        '--url',
        'https://example.test',
        '--model',
        'coding',
        '--reasoning-efforts',
        'low,high',
        '--default-reasoning-effort',
        'high',
        '--code-mode',
        '--responses-transport',
        'websocket',
        '--responses-continuation',
        '--api-key-stdin'
      ],
      'private-key\n',
      process.cwd()
    );
    const path = join(home, '.mar', 'agent', 'models.json');
    const raw = await readFile(path, 'utf8');
    expect(JSON.parse(raw)).toMatchObject({
      defaultModelId: 'coding',
      models: [
        expect.objectContaining({
          reasoningEfforts: ['low', 'high'],
          defaultReasoningEffort: 'high',
          codeMode: true,
          responsesTransport: { transport: 'WEBSOCKET' },
          responsesPreviousResponseId: true
        })
      ]
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(raw).models[0]).not.toHaveProperty('responsesEncoding');
    expect(JSON.parse(raw).models[0]).not.toHaveProperty('highDensityCompaction');
    await execute(
      process.execPath,
      [
        'dist/cli/main.js',
        '--home',
        home,
        'models',
        'edit',
        'coding',
        '--reasoning-efforts',
        'low',
        '--no-code-mode'
      ],
      { cwd: process.cwd() }
    );
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      models: [
        expect.objectContaining({
          reasoningEfforts: ['low'],
          defaultReasoningEffort: 'low',
          codeMode: false
        })
      ]
    });
    await execute(
      process.execPath,
      ['dist/cli/main.js', '--home', home, 'models', 'remove', 'coding', '--yes'],
      { cwd: process.cwd() }
    );
    expect(JSON.parse(await readFile(path, 'utf8')).models).toEqual([]);
  });

  it('adds an external Codex credential marker with an explicit Responses transport', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-cli-external-model-home-'));
    homes.push(home);

    await execute(
      process.execPath,
      [
        'dist/cli/main.js',
        '--home',
        home,
        'models',
        'add',
        'codex',
        '--name',
        'Codex',
        '--protocol',
        'OPENAI_RESPONSES',
        '--url',
        'https://chatgpt.com/backend-api/codex',
        '--model',
        'gpt-codex',
        '--credential',
        'codex-auth-file',
        '--responses-transport',
        'websocket',
        '--responses-continuation'
      ],
      { cwd: process.cwd() }
    );

    const raw = await readFile(join(home, '.mar', 'agent', 'models.json'), 'utf8');
    expect(JSON.parse(raw)).toMatchObject({
      models: [
        expect.objectContaining({
          credential: { type: 'CODEX_AUTH_FILE' },
          responsesTransport: { transport: 'WEBSOCKET' },
          responsesPreviousResponseId: true
        })
      ]
    });
    expect(raw).not.toContain('apiKey');
    expect(raw).not.toContain('auth.json');
  });

  it('selects a configured reasoning effort without appending the option to the prompt', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-cli-reasoning-home-'));
    homes.push(home);
    const requests: unknown[] = [];
    await writeResponsesModel(home, await responsesServer(requests));

    const { stdout } = await execute(
      process.execPath,
      [
        'dist/cli/main.js',
        '--home',
        home,
        'run',
        'Inspect the current task',
        '--reasoning-effort',
        'high',
        '--access',
        'full-access',
        '--format',
        'json'
      ],
      { cwd: process.cwd() }
    );

    expect(stdout).toContain('Completed');
    const reasoningRequest = requests.find(
      (request) =>
        typeof request === 'object' &&
        request !== null &&
        'reasoning' in request &&
        (request as { reasoning?: { effort?: unknown } }).reasoning?.effort === 'high'
    ) as { reasoning: unknown; input: unknown[] } | undefined;
    expect(reasoningRequest).toMatchObject({
      reasoning: { effort: 'high', summary: 'auto' }
    });
    expect(reasoningRequest?.input.at(-1)).toEqual({
      role: 'user',
      content: 'Inspect the current task'
    });
    expect(JSON.stringify(reasoningRequest?.input)).not.toContain('--reasoning-effort');
    expect(JSON.stringify(reasoningRequest?.input)).not.toContain('--access');
    expect(
      requests.filter((request) => JSON.stringify(request).includes('session title generator'))
    ).toHaveLength(1);
    const index = JSON.parse(
      await readFile(join(home, '.mar', 'agent', 'sessions', 'index.json'), 'utf8')
    );
    expect(index.sessions).toEqual([
      expect.objectContaining({ title: 'Completed', automaticTitlePending: false })
    ]);
  });

  it('rejects the removed on-request access mode', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-cli-access-invalid-home-'));
    homes.push(home);
    await writeResponsesModel(home, await responsesServer([]));

    const result = await executeWithClosedStdin(
      process.execPath,
      ['dist/cli/main.js', '--home', home, '--access', 'on-request', 'run', 'Reply OK.'],
      process.cwd()
    );

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('deprecated --access option only accepts full-access');
  });

  it('runs non-interactively when stdin is closed', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-cli-closed-stdin-home-'));
    homes.push(home);
    const requests: unknown[] = [];
    await writeResponsesModel(home, await responsesServer(requests));

    const result = await executeWithClosedStdin(
      process.execPath,
      [
        'dist/cli/main.js',
        '--home',
        home,
        '--model',
        'reasoning',
        '--reasoning-effort',
        'high',
        '--format',
        'stream-json',
        'run',
        'Reply OK.'
      ],
      process.cwd()
    );

    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout).toContain('"type":"usage.updated"');
    expect(requests).toContainEqual(
      expect.objectContaining({
        input: expect.arrayContaining([
          expect.objectContaining({ role: 'user', content: 'Reply OK.' })
        ])
      })
    );
  });

  it('rejects a reasoning effort not declared by the selected model', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-cli-reasoning-invalid-home-'));
    homes.push(home);
    const requests: unknown[] = [];
    await writeResponsesModel(home, await responsesServer(requests));

    await expect(
      execute(
        process.execPath,
        [
          'dist/cli/main.js',
          '--home',
          home,
          'run',
          'Inspect the current task',
          '--reasoning-effort',
          'medium'
        ],
        { cwd: process.cwd() }
      )
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining(
        'Reasoning effort "medium" is not supported by model "reasoning".'
      )
    });
    expect(requests).toHaveLength(0);
  });

  it('injects a Codex auth file only for the current CLI process', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-cli-codex-auth-home-'));
    homes.push(home);
    const requests: Array<{
      body: unknown;
      headers: Record<string, string | string[] | undefined>;
    }> = [];
    const server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        requests.push({ body: JSON.parse(body), headers: request.headers });
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(
          [
            { type: 'response.created', response: { id: 'response-cli-auth' } },
            {
              type: 'response.output_text.done',
              item_id: 'message-cli-auth',
              phase: 'final_answer',
              text: 'Authenticated'
            },
            {
              type: 'response.completed',
              response: {
                usage: { input_tokens: 4, output_tokens: 1, input_tokens_details: {} }
              }
            }
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join('')
        );
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server unavailable');
    await writeCodexAuthModel(home, `http://127.0.0.1:${address.port}`);
    const authPath = await writeCodexAuthFile(home);

    const result = await execute(
      process.execPath,
      [
        'dist/cli/main.js',
        '--home',
        home,
        'run',
        'Use local Codex auth',
        '--codex-auth-file',
        authPath,
        '--format',
        'json'
      ],
      { cwd: process.cwd() }
    );

    expect(result.stdout).toContain('Authenticated');
    expect(result.stdout).not.toContain(authPath);
    expect(result.stderr).not.toContain(authPath);
    expect(requests[0]?.headers).toMatchObject({
      'chatgpt-account-id': 'account-cli-test',
      originator: 'myagentroam'
    });
    expect(requests[0]?.body).toMatchObject({
      parallel_tool_calls: true,
      instructions: expect.any(String),
      tools: expect.any(Array)
    });
    expect(requests[0]?.headers).not.toHaveProperty('x-openai-internal-codex-responses-lite');
    expect(requests[0]?.headers).not.toHaveProperty('x-openai-fedramp');
    expect(await readFile(join(home, '.mar', 'agent', 'models.json'), 'utf8')).not.toContain(
      authPath
    );
  });

  it('rejects duplicate Codex auth file options without exposing the path', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-cli-codex-auth-duplicate-home-'));
    homes.push(home);
    const requests: unknown[] = [];
    await writeCodexAuthModel(home, await responsesServer(requests));
    const authPath = await writeCodexAuthFile(home);

    await expect(
      execute(
        process.execPath,
        [
          'dist/cli/main.js',
          '--home',
          home,
          'run',
          'Do not persist credential paths',
          '--codex-auth-file',
          authPath,
          '--codex-auth-file',
          authPath
        ],
        { cwd: process.cwd() }
      )
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.not.stringContaining(authPath)
    });
    expect(requests).toHaveLength(0);
  });

  it('returns exit code 4 when a selected external credential has no auth file', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-cli-codex-auth-missing-home-'));
    homes.push(home);
    await writeCodexAuthModel(home, 'http://127.0.0.1:1');

    await expect(
      execute(process.execPath, ['dist/cli/main.js', '--home', home, 'run', 'Missing auth file'], {
        cwd: process.cwd()
      })
    ).rejects.toMatchObject({
      code: 4,
      stderr: expect.stringContaining('Codex auth file is required')
    });
  });
});
