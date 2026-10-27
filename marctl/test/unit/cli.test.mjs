import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { executableArgs, main, parseArgs, resolveNodeId } from '../../src/cli.mjs';

const context = {
  MAR_CTL_CONTEXT_REQUIRED: '1',
  MAR_CTL_SERVER_URL: 'https://server.test',
  MAR_CTL_USER_TOKEN: `marctl_user_${'x'.repeat(43)}`
};

test('parses internal commands and rejects removed configuration options', () => {
  assert.deepEqual(parseArgs(['nodes']), { command: 'nodes' });
  for (const args of [
    ['--env-file', '/tmp/marctl.env', 'nodes'],
    ['nodes', '--env-file=/tmp/marctl.env'],
    ['ssh', '--env-file', '/tmp/marctl.env', 'node-1'],
    ['scp', '--env-file=/tmp/marctl.env', 'a', 'node-1:/tmp/a']
  ])
    assert.throws(() => parseArgs(args));
  assert.deepEqual(parseArgs(['ssh', 'node-1', '--env-file=/tmp/remote.env']), {
    command: 'ssh',
    nodeId: 'node-1',
    remoteCommand: '--env-file=/tmp/remote.env'
  });
  assert.deepEqual(parseArgs(['ssh', 'node-1', 'uname', '-a']), {
    command: 'ssh',
    nodeId: 'node-1',
    remoteCommand: 'uname -a'
  });
  assert.deepEqual(parseArgs(['ssh', 'node-1', 'echo hello && date']), {
    command: 'ssh',
    nodeId: 'node-1',
    remoteCommand: 'echo hello && date'
  });
  assert.deepEqual(parseArgs(['scp', 'linux:///tmp/file', 'win://C:\\file']), {
    command: 'scp',
    source: 'linux:///tmp/file',
    destination: 'win://C:\\file',
    preserve: false
  });
  assert.deepEqual(parseArgs(['scp', '-pq', 'linux:/tmp/file', 'win:C:\\file']), {
    command: 'scp',
    source: 'linux:/tmp/file',
    destination: 'win:C:\\file',
    preserve: true
  });
  assert.throws(
    () => parseArgs(['scp', '-P', '222', 'linux:/tmp/file', 'win:C:\\file']),
    /SCP option is not supported/
  );
  assert.throws(
    () => parseArgs(['scp', '-r', 'linux:/tmp/dir', 'win:C:\\dir']),
    /SCP option is not supported/
  );
  assert.throws(() => parseArgs(['scp', 'linux:///tmp/file']), /Invalid command arguments/);
  assert.deepEqual(parseArgs(['ssh', 'node-1', '--', '--version']), {
    command: 'ssh',
    nodeId: 'node-1',
    remoteCommand: '--version'
  });
  assert.deepEqual(parseArgs(['ssh', 'node-1', '--', '-p', '22']), {
    command: 'ssh',
    nodeId: 'node-1',
    remoteCommand: '-p 22'
  });
  assert.deepEqual(parseArgs(['ssh', 'node-1', '-p', '22']), {
    command: 'ssh',
    nodeId: 'node-1',
    remoteCommand: '-p 22'
  });
  assert.deepEqual(parseArgs(['--help']), { help: true });
  assert.throws(() => parseArgs(['nodes', 'extra']), /Invalid command arguments/);
  assert.throws(() => parseArgs(['ssh', '-t', 'node-1']), /SSH options are not supported/);
  assert.throws(() => parseArgs(['ssh', '-T', 'node-1']), /SSH options are not supported/);
  assert.throws(() => parseArgs(['ssh', '-p', '22', 'node-1']), /SSH options are not supported/);
});

test('dispatches the friendly executable names without changing marctl invocation', () => {
  assert.deepEqual(executableArgs('/usr/local/bin/marnodes', []), ['nodes']);
  assert.deepEqual(executableArgs('C:\\bin\\marssh.cmd', ['ubuntu-develop']), [
    'ssh',
    'ubuntu-develop'
  ]);
  assert.deepEqual(executableArgs('/usr/local/bin/marscp', ['linux://a', 'win://b']), [
    'scp',
    'linux://a',
    'win://b'
  ]);
  assert.deepEqual(executableArgs('/usr/local/bin/marctl', ['ssh', 'node-1']), ['ssh', 'node-1']);
});

test('selects command help without consuming remote help flags or literal copy paths', () => {
  assert.deepEqual(parseArgs(['help']), { help: true });
  for (const command of ['nodes', 'ssh', 'scp', 'version']) {
    assert.deepEqual(parseArgs(['help', command]), { help: true, command });
    for (const flag of ['--help', '-h'])
      assert.deepEqual(parseArgs([command, flag]), { help: true, command });
  }
  for (const flag of ['--help', '-h']) {
    assert.deepEqual(parseArgs(['ssh', 'node-1', flag]), {
      command: 'ssh',
      nodeId: 'node-1',
      remoteCommand: flag
    });
    assert.deepEqual(parseArgs(['ssh', 'node-1', 'tool', flag]), {
      command: 'ssh',
      nodeId: 'node-1',
      remoteCommand: `tool ${flag}`
    });
  }
  assert.deepEqual(parseArgs(['scp', '--', '--help', '-h']), {
    command: 'scp',
    source: '--help',
    destination: '-h',
    preserve: false
  });
});

test('shows offline bilingual help with the invoked alias or marctl subcommand only', async () => {
  const { bin } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  for (const locale of ['en_US.UTF-8', 'zh_CN.UTF-8']) {
    for (const [alias, command] of [
      ['marnodes', 'nodes'],
      ['marssh', 'ssh'],
      ['marscp', 'scp']
    ]) {
      const script = fileURLToPath(new URL(`../../${bin[alias]}`, import.meta.url));
      for (const flag of ['--help', '-h']) {
        const result = spawnSync(process.execPath, ['--', script, flag], {
          encoding: 'utf8',
          env: {
            ...process.env,
            LC_ALL: locale,
            MAR_CTL_CONTEXT_REQUIRED: '1',
            MAR_CTL_USER_TOKEN: ''
          }
        });
        assert.equal(result.status, 0, `${alias}: ${result.stderr}`);
        assert.equal(result.stderr, '');
        assert.ok(result.stdout.includes(`${alias} [`), result.stdout);
        assert.doesNotMatch(result.stdout, /\bmarctl (?:nodes|ssh|scp|version|help)\b/u);
        for (const other of ['marnodes', 'marssh', 'marscp'].filter((name) => name !== alias))
          assert.ok(!result.stdout.includes(other), result.stdout);
        assert.match(result.stdout, locale.startsWith('zh') ? /用法/ : /Usage/);
      }
      for (const args of [
        [command, '--help'],
        ['help', command]
      ]) {
        let output = '';
        assert.equal(
          await main(args, {
            env: { LC_ALL: locale, MAR_CTL_CONTEXT_REQUIRED: '1' },
            stdout: { write: (value) => (output += value) },
            stderr: { write: (value) => assert.fail(value) }
          }),
          0
        );
        assert.ok(output.includes(`marctl ${command} [`), output);
        assert.ok(!output.includes(alias), output);
      }
    }
    let output = '';
    assert.equal(
      await main(['help'], {
        env: { LC_ALL: locale, MAR_CTL_CONTEXT_REQUIRED: '1' },
        stdout: { write: (value) => (output += value) },
        stderr: { write: (value) => assert.fail(value) }
      }),
      0
    );
    for (const command of ['nodes', 'ssh', 'scp'])
      assert.ok(output.includes(`marctl ${command}`), output);
  }
});

test('sessions help explains JSON fields and delivery tradeoffs offline in both languages', async () => {
  for (const [locale, descriptions] of [
    [
      'en_US.UTF-8',
      [
        'switch the current execution',
        'waits for that execution and earlier queued work',
        'Use --steer instead',
        'not guaranteed to be immediate',
        'Goal exits',
        'RUNNING/IDLE/SLEEPING'
      ]
    ],
    [
      'zh_CN.UTF-8',
      [
        '切换当前执行',
        '等待当前执行和前面的队列项',
        '应使用 --steer',
        '不保证模型立即处理',
        'Goal 退出',
        'RUNNING/IDLE/SLEEPING'
      ]
    ]
  ]) {
    let output = '';
    assert.equal(
      await main(['help', 'sessions'], {
        env: { LC_ALL: locale, MAR_CTL_CONTEXT_REQUIRED: '1' },
        stdout: { write: (value) => (output += value) },
        stderr: { write: (value) => assert.fail(value) }
      }),
      0
    );
    for (const field of [
      'session.status',
      'session.model',
      'session.effort',
      'session.title',
      'session.runId',
      'session.recentTools',
      'session.queuedCount',
      'session.latestMessage',
      'latestActivity',
      'progress',
      'segments[].items[]',
      'kind === "assistant_message"',
      'payload.text',
      ...descriptions
    ])
      assert.ok(output.includes(field), field);
  }
});

test('parses local version requests without consuming remote command flags or file paths', () => {
  assert.deepEqual(parseArgs(['version', '--help']), { help: true, command: 'version' });
  for (const flag of ['--version', '-V']) {
    for (const command of [[], ['nodes'], ['ssh'], ['scp']])
      assert.deepEqual(parseArgs([...command, flag]), { version: true });
    assert.deepEqual(parseArgs(['ssh', 'node-1', flag]), {
      command: 'ssh',
      nodeId: 'node-1',
      remoteCommand: flag
    });
    assert.deepEqual(parseArgs(['ssh', 'node-1', '--', flag]), {
      command: 'ssh',
      nodeId: 'node-1',
      remoteCommand: flag
    });
  }
  assert.deepEqual(parseArgs(['version']), { version: true });
  assert.deepEqual(parseArgs(['ssh', 'version']), { command: 'ssh', nodeId: 'version' });
  assert.deepEqual(parseArgs(['scp', '--', '--version', '-V']), {
    command: 'scp',
    source: '--version',
    destination: '-V',
    preserve: false
  });
  assert.throws(() => parseArgs(['version', 'extra']), /Invalid command arguments/);
});

test('reports its installed package version without loading config or contacting Server', async () => {
  const { version } = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
  );
  for (const args of [['--version'], ['-V'], ['version'], ['ssh', '--version']]) {
    let output = '';
    let errors = '';
    const result = await main(args, {
      env: { MAR_CTL_CONTEXT_REQUIRED: '1' },
      stdout: { write: (value) => (output += value) },
      stderr: { write: (value) => (errors += value) },
      client: {
        async listNodes() {
          assert.fail('Version must not contact Server');
        }
      }
    });
    assert.equal(result, 0, errors);
    assert.equal(output, `marctl ${version}\n`);
    assert.equal(errors, '');
  }
});

test('uses a consistent product heading and documents the exact version output in both languages', async () => {
  for (const locale of ['en_US.UTF-8', 'zh_CN.UTF-8']) {
    for (const args of [['help'], ['help', 'version'], ['version', '--help']]) {
      let output = '';
      assert.equal(
        await main(args, {
          env: { LC_ALL: locale, MAR_CTL_CONTEXT_REQUIRED: '1' },
          stdout: { write: (value) => (output += value) },
          stderr: { write: (value) => assert.fail(value) },
          client: { listNodes: () => assert.fail('Help must not contact Server') }
        }),
        0
      );
      assert.match(output, /^marctl — MyAgentRoam /u);
      assert.match(output, locale.startsWith('zh') ? /用法：/u : /Usage:/u);
      assert.match(output, locale.startsWith('zh') ? /选项：/u : /Options:/u);
      assert.match(output, locale.startsWith('zh') ? /示例：/u : /Examples:/u);
      if (args.includes('version')) {
        assert.match(output, /@myagentroam\/marctl/u);
        assert.match(output, /marctl <version>/u);
        assert.match(output, /marctl --version/u);
        assert.match(output, /marctl -V/u);
        assert.doesNotMatch(output, /MAR_CTL_KEY|--env-file/u);
      }
    }
  }
});

test('standalone aliases report the CLI package version outside their installation directory', async () => {
  const { bin, version } = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
  );
  const directory = await mkdtemp(path.join(os.tmpdir(), 'marctl-version-'));
  try {
    for (const alias of ['marctl', 'marnodes', 'marssh', 'marscp']) {
      const script = fileURLToPath(new URL(`../../${bin[alias]}`, import.meta.url));
      for (const flag of ['--version', '-V']) {
        const result = spawnSync(process.execPath, [script, flag], {
          encoding: 'utf8',
          cwd: directory,
          env: { ...process.env, MAR_CTL_CONTEXT_REQUIRED: '1', MAR_CTL_USER_TOKEN: '' }
        });
        assert.equal(result.status, 0, `${alias} ${flag}: ${result.stderr}`);
        assert.equal(result.stdout, `marctl ${version}\n`);
        assert.equal(result.stderr, '');
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('standalone aliases keep their command when a Windows shim resolves its script path', () => {
  const { bin } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  for (const [alias, args] of [
    ['marnodes', []],
    ['marssh', ['node-1']],
    ['marscp', ['local.bin', 'node-1:///tmp/file']]
  ]) {
    assert.notEqual(bin[alias], bin.marctl);
    const script = new URL(`../../${bin[alias]}`, import.meta.url);
    const result = spawnSync(process.execPath, [script.pathname, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        LC_ALL: 'en_US.UTF-8',
        MAR_CTL_CONTEXT_REQUIRED: '1',
        MAR_CTL_SERVER_URL: 'http://127.0.0.1:1',
        MAR_CTL_USER_TOKEN: ''
      }
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /This Node session has no valid marctl user authorization/);
  }
});

test('lists nodes without printing credentials', async () => {
  let output = '';
  let errors = '';
  const result = await main(['nodes'], {
    env: context,
    stdout: { write: (value) => (output += value) },
    stderr: { write: (value) => (errors += value) },
    client: {
      async listNodes() {
        return [
          { id: 'node-1', displayName: 'Build node', connected: true, platform: 'linux' },
          { id: 'node-2', connected: false }
        ];
      }
    }
  });
  assert.equal(result, 0);
  assert.equal(output.split('\n')[0], 'ID\tNAME\tSTATUS\tPLATFORM');
  assert.match(output, /node-1/);
  assert.match(output, /Build node/);
  assert.match(output, /connected/);
  assert.match(output, /disconnected/);
  assert.equal(output.includes(context.MAR_CTL_USER_TOKEN), false);
  assert.equal(errors, '');
});

test('does not create a websocket for nodes listing', async () => {
  let created = false;
  let output = '';
  const result = await main(['nodes'], {
    env: context,
    stdout: {
      write(value) {
        output += value;
      }
    },
    stderr: { write() {} },
    client: { listNodes: async () => [] },
    WebSocketClass: class {
      constructor() {
        created = true;
      }
    }
  });
  assert.equal(result, 0);
  assert.equal(output, 'ID\tNAME\tSTATUS\tPLATFORM\n');
  assert.equal(created, false);
});

test('resolves an exact authorized node name and prefers an exact ID', async () => {
  const client = {
    async listNodes() {
      return [
        { id: 'node-1', displayName: 'ubuntu-develop', connected: true },
        { id: 'node-2', displayName: 'node-1', connected: false }
      ];
    }
  };
  assert.equal(await resolveNodeId(client, 'ubuntu-develop'), 'node-1');
  assert.equal(await resolveNodeId(client, 'node-1'), 'node-1');
  assert.equal(await resolveNodeId(client, 'node-2'), 'node-2');
});

test('rejects duplicate names including offline nodes and unknown references', async () => {
  const client = {
    async listNodes() {
      return [
        { id: 'node-1', displayName: 'shared', connected: true },
        { id: 'node-2', displayName: 'shared', connected: false }
      ];
    }
  };
  await assert.rejects(
    resolveNodeId(client, 'shared'),
    /Multiple accessible nodes share that name/
  );
  await assert.rejects(resolveNodeId(client, 'missing'), /No accessible node matches/);
  assert.equal(await resolveNodeId(client, 'node-1'), 'node-1');
});

test('rejects ambiguous node names before creating a terminal connection', async () => {
  let errors = '';
  let created = false;
  const result = await main(['ssh', 'shared'], {
    env: context,
    stdout: { write() {} },
    stderr: { write: (value) => (errors += value) },
    client: {
      async listNodes() {
        return [
          { id: 'node-1', displayName: 'shared', connected: true },
          { id: 'node-2', displayName: 'shared', connected: false }
        ];
      },
      async createTerminal() {
        created = true;
      }
    }
  });
  assert.equal(result, 1);
  assert.match(errors, /Multiple accessible nodes share that name/);
  assert.equal(created, false);
});

test('localizes help and node status from LC_ALL', async () => {
  let output = '';
  assert.equal(
    await main(['--help'], {
      env: { LC_ALL: 'zh_CN.UTF-8', LANG: 'en_US.UTF-8' },
      stdout: { write: (value) => (output += value) },
      stderr: { write() {} }
    }),
    0
  );
  assert.match(output, /用法/);
  output = '';
  assert.equal(
    await main(['nodes'], {
      env: { ...context, LC_ALL: 'zh_CN.UTF-8' },
      stdout: { write: (value) => (output += value) },
      stderr: { write() {} },
      client: {
        async listNodes() {
          return [{ id: 'node-1', connected: false }];
        }
      }
    }),
    0
  );
  assert.match(output, /离线/);
});
