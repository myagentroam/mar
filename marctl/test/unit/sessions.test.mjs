import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import test from 'node:test';
import { main, parseArgs } from '../../src/cli.mjs';
import { waitForSessionRun } from '../../src/session-wait.mjs';
import { MarctlError } from '../../src/errors.mjs';
import { MarctlClient } from '../../src/client.mjs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const watchEnvelope = (event) => JSON.stringify({ type: 'watch.event', event });
const env = {
  MAR_CTL_CONTEXT_REQUIRED: '1',
  MAR_CTL_SERVER_URL: 'https://server.test',
  MAR_CTL_USER_TOKEN: `marctl_user_e30.${'x'.repeat(43)}`,
  MAR_CTL_SESSION_ID: 'source'
};
const triggers = [
  { kind: 'daily', time: '09:00' },
  { kind: 'weekly', time: '10:30', weekdays: [1, 5] },
  { kind: 'monthly', time: '12:00', monthDays: [1, 31] },
  { kind: 'once', date: '2035-02-12', time: '14:30' }
];
const scheduleCreate = [
  'schedule',
  'create',
  '--name',
  'Build',
  '--triggers-file',
  '-',
  '-m',
  'Check build'
];

test('uses agents as the sole CLI command group', () => {
  assert.equal(parseArgs(['agents', 'current']).command, 'agents');
  assert.throws(() => parseArgs(['sessions', 'current']));
});

test('maps six Agent operations to the common Node command without inventing a source', async () => {
  const calls = [];
  const invoke = (args) =>
    main(['agents', ...args, '--json'], {
      env,
      stdout: { write() {} },
      client: {
        sessionCommand: async (body) => {
          calls.push(body);
          return { ok: true };
        }
      }
    });
  assert.equal(
    await invoke(['start', '-m', 'work', '--goal', 'finish', '--model-id', 'selected-id']),
    0
  );
  assert.equal(await invoke(['send', 'child', '--clear-goal']), 0);
  assert.equal(
    await invoke([
      'wait',
      '--agent',
      'child',
      '--agent',
      'other',
      '--mode',
      'all',
      '--wait-for',
      'message',
      '--timeout',
      '0ms'
    ]),
    0
  );
  assert.equal(await invoke(['stop', 'child']), 0);
  assert.equal(await invoke(['list', '--scope', 'active', '--query', 'Task', '--limit', '10']), 0);
  assert.equal(await invoke(['view', 'child']), 0);
  assert.deepEqual(
    calls.map((call) => call.command.operation),
    ['start', 'send', 'wait', 'stop', 'list', 'view']
  );
  assert.deepEqual(calls[0].command.input.goal, { objective: 'finish' });
  assert.equal(calls[0].command.input.modelId, 'selected-id');
  assert.equal(Object.hasOwn(calls[0].command.input, 'model'), false);
  assert.equal(calls[0].command.input.runner, undefined);
  assert.equal(calls[0].command.input.parentSessionId, undefined);
  assert.deepEqual(calls[1].command.input.goal, { clear: true });
  assert.equal(calls[1].command.input.content, undefined);
  assert.equal(Object.hasOwn(calls[1].command.input, 'deliveryIntent'), false);
  assert.deepEqual(calls[2].command.input.agentIds, ['child', 'other']);
  assert.equal(calls[2].command.input.waitMs, 0);
  assert.deepEqual(calls[3].command.input, { agentId: 'child' });
  assert.deepEqual(calls[4].command.input, { scope: 'active', query: 'Task', limit: 10 });
  assert.deepEqual(calls[5].command.input, { agentId: 'child' });
});

test('state view rejects history options locally while dedicated history retains pagination', async () => {
  let calls = 0;
  for (const options of [['--history'], ['--limit', '5'], ['--cursor', 'older']]) {
    assert.equal(
      await main(['agents', 'view', 'child', ...options, '--json'], {
        env,
        stdout: { write() {} },
        stderr: { write() {} },
        client: {
          sessionCommand: async () => {
            calls++;
          }
        }
      }),
      2
    );
  }
  assert.equal(calls, 0);
  assert.deepEqual(parseArgs(['agents', 'history', 'child', '--cursor', 'older', '--limit', '5']), {
    command: 'agents',
    action: 'history',
    sessionId: 'child',
    cursor: 'older',
    limit: 5
  });
  const requests = [];
  assert.equal(
    await main(['agents', 'history', 'child', '--cursor', 'older', '--limit', '5', '--json'], {
      env,
      stdout: { write() {} },
      client: {
        sessionCommand: async (body) => {
          requests.push(body);
          return { segments: [], nextCursor: 'next' };
        }
      }
    }),
    0
  );
  assert.deepEqual(requests, [
    { action: 'history', sessionId: 'child', cursor: 'older', limit: 5 }
  ]);
});

test('forwards a positional wait target as an array and preserves the requested duration', async () => {
  for (const [timeout, waitMs, transportTimeout] of [
    [undefined, undefined, 40000],
    ['0ms', 0, 10000],
    ['1ms', 1, 20000],
    ['10s', 10000, 20000],
    ['5m', 300000, 310000]
  ]) {
    let request;
    let options;
    const exit = await main(
      [
        'agents',
        'wait',
        'child',
        '--mode',
        'all',
        ...(timeout ? ['--timeout', timeout] : []),
        '--json'
      ],
      {
        env,
        stdout: { write() {} },
        client: {
          sessionCommand: async (body, supplied) => {
            request = body;
            options = supplied;
            return { waitOutcome: 'snapshot' };
          }
        }
      }
    );
    assert.equal(exit, 0);
    assert.deepEqual(request.command, {
      operation: 'wait',
      input: { agentIds: ['child'], mode: 'all', ...(waitMs === undefined ? {} : { waitMs }) }
    });
    assert.equal(options.timeoutMs, transportTimeout);
  }
});

test('leaves an untargeted wait to Node direct-child selection', async () => {
  const calls = [];
  assert.equal(
    await main(['agents', 'wait', '--timeout', '0ms', '--json'], {
      env,
      stdout: { write() {} },
      client: {
        sessionCommand: async (body) => {
          calls.push(body);
          return { agents: [], waitOutcome: 'snapshot' };
        }
      }
    }),
    0
  );
  assert.deepEqual(calls, [
    { action: 'network', command: { operation: 'wait', input: { waitMs: 0 } } }
  ]);
});

test('send maps an approval ID and decision without a Run ID', async () => {
  const calls = [];
  const client = {
    sessionCommand: async (body) => {
      calls.push(body);
      return { accepted: true };
    }
  };
  assert.equal(
    await main(
      ['agents', 'send', 'child', '--approval', 'approval-1', '--decision', 'approve', '--json'],
      { env, stdout: { write() {} }, client }
    ),
    0
  );
  assert.deepEqual(calls[0].command.input.approval, {
    approvalId: 'approval-1',
    decision: 'approve'
  });
  assert.equal(calls[0].command.input.runId, undefined);
  assert.equal(Object.hasOwn(calls[0].command.input, 'deliveryIntent'), false);
  assert.throws(() => parseArgs(['agents', 'send', 'child', '--approval', 'approval-1']));
  assert.throws(() => parseArgs(['agents', 'send', 'child', '--decision', 'approve']));
  assert.throws(() =>
    parseArgs(['agents', 'send', 'child', '--approval', 'approval-1', '--decision', 'maybe'])
  );
});

test('renames sessions, manages prompts, and decides approvals', async () => {
  const calls = [];
  const invoke = (args) =>
    main(['agents', ...args, '--json'], {
      env,
      stdout: { write() {} },
      client: {
        sessionCommand: async (body) => {
          calls.push(body);
          return { accepted: true };
        }
      }
    });
  assert.equal(await invoke(['rename', 'other', '--title', '  fixer#42 New title  ']), 0);
  assert.equal(await invoke(['prompt', 'get']), 0);
  assert.equal(await invoke(['prompt', 'set', '-m', '  Agent role  ']), 0);
  assert.equal(await invoke(['prompt', 'clear']), 0);
  assert.equal(
    await invoke([
      'approval',
      'decide',
      'other',
      '--run',
      'run-1',
      '--approval',
      'approval-1',
      '--decision',
      'approve'
    ]),
    0
  );
  assert.equal(
    await invoke([
      'approval',
      'decide',
      'other',
      '--run',
      'run-2',
      '--approval',
      'approval-2',
      '--decision',
      'reject'
    ]),
    0
  );
  assert.deepEqual(calls, [
    { action: 'rename', sessionId: 'other', title: 'fixer#42 New title' },
    { action: 'prompt.get', sessionId: 'source' },
    { action: 'prompt.set', sessionId: 'source', content: '  Agent role  ' },
    { action: 'prompt.clear', sessionId: 'source' },
    {
      action: 'approval.decide',
      sessionId: 'other',
      runId: 'run-1',
      approvalId: 'approval-1',
      decision: 'APPROVED'
    },
    {
      action: 'approval.decide',
      sessionId: 'other',
      runId: 'run-2',
      approvalId: 'approval-2',
      decision: 'REJECTED'
    }
  ]);
  for (const args of [
    ['rename', 'other'],
    ['rename', 'other', '--title', '   ']
  ])
    assert.throws(() => parseArgs(['agents', ...args]));
});

test('addresses schedules by task ID and creates a separate task for each supported target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'marctl-schedule-'));
  const triggersFile = join(root, 'triggers.json');
  const calls = [];
  const invoke = (args, sessionId = 'source') =>
    main(['agents', ...args, '--json'], {
      env: { ...env, MAR_CTL_SESSION_ID: sessionId },
      stdin: [JSON.stringify(triggers)],
      stdout: { write() {} },
      client: {
        sessionCommand: async (body) => {
          calls.push(body);
          return {};
        }
      }
    });
  try {
    await writeFile(triggersFile, JSON.stringify(triggers));
    assert.equal(await invoke(['schedule', 'list', '--limit', '2', '--cursor', 'cursor'], ''), 0);
    assert.equal(await invoke(['schedule', 'list', '--session', 'other']), 0);
    assert.equal(await invoke(['schedule', 'get', '--task', 'task-b'], ''), 0);
    assert.equal(await invoke(['schedule', 'runs', '--task', 'task-b', '--page', '2'], ''), 0);
    assert.equal(await invoke(scheduleCreate), 0);
    assert.equal(await invoke([...scheduleCreate, '--session', 'other'], ''), 0);
    assert.equal(
      await invoke(
        [...scheduleCreate, '--new-session', '--runner', 'codex', '--default-model'],
        ''
      ),
      0
    );
    assert.equal(
      await invoke([
        ...scheduleCreate,
        '--new-session',
        '--runner',
        'mar-agent',
        '--model-id',
        'model',
        '--effort',
        'high'
      ]),
      0
    );
    assert.equal(
      await invoke(
        [
          'schedule',
          'update',
          '--task',
          'task-b',
          '--expected-revision',
          '3',
          '--name',
          'Review',
          '--triggers-file',
          triggersFile,
          '-m',
          'Check tests'
        ],
        ''
      ),
      0
    );
    const create = { action: 'schedule.create', name: 'Build', objective: 'Check build', triggers };
    assert.deepEqual(calls, [
      { action: 'schedule.list', limit: 2, cursor: 'cursor' },
      { action: 'schedule.list', sessionId: 'other' },
      { action: 'schedule.get', taskId: 'task-b' },
      { action: 'schedule.runs', taskId: 'task-b', occurrencePage: 2 },
      { ...create, target: { kind: 'existing', sessionId: 'source' } },
      { ...create, target: { kind: 'existing', sessionId: 'other' } },
      { ...create, target: { kind: 'newSession', runner: 'codex', model: { kind: 'default' } } },
      {
        ...create,
        target: {
          kind: 'newSession',
          runner: 'mar-agent',
          model: { kind: 'fixed', modelId: 'model' },
          effort: 'high'
        }
      },
      {
        action: 'schedule.update',
        taskId: 'task-b',
        expectedRevision: 3,
        patch: { name: 'Review', objective: 'Check tests', triggers }
      }
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('lists current Session tasks in one request without widening the scope when context is absent', async () => {
  const calls = [];
  let output = '';
  const invoke = (options, sessionId = 'source') =>
    main(['agents', 'schedule', 'list', ...options, '--json'], {
      env: { ...env, MAR_CTL_SESSION_ID: sessionId },
      stdout: { write: (value) => (output = value) },
      client: {
        sessionCommand: async (body) => {
          calls.push(body);
          return { tasks: [], nextCursor: null };
        }
      }
    });
  assert.equal(await invoke(['--current', '--cursor', 'cursor', '--limit', '2']), 0);
  assert.deepEqual(JSON.parse(output), { tasks: [], nextCursor: null });
  assert.equal(await invoke([], 'source'), 0);
  assert.equal(await invoke(['--current'], ''), 1);
  assert.equal(JSON.parse(output).error.code, 'MARCTL_SESSION_CONTEXT_REQUIRED');
  assert.deepEqual(calls, [
    { action: 'schedule.list', sessionId: 'source', cursor: 'cursor', limit: 2 },
    { action: 'schedule.list' }
  ]);
});

test('rejects legacy syntax, invalid task options and competing stdin inputs before reading', async () => {
  for (const args of [
    ['schedule', 'get'],
    ['schedule', 'get', 'other'],
    ['schedule', 'get', '--task', 'task', '--node', 'foreign'],
    ['schedule', 'list', '--current', '--session', 'other'],
    ['schedule', 'list', '--session', 'other', '--current'],
    ['schedule', 'list', '--current', '--current'],
    ['schedule', 'list', '--current', 'other'],
    [...scheduleCreate, '--current'],
    ['schedule', 'runs', '--task', 'task', '--page', '0'],
    ['schedule', 'create', '--name', 'Build', '--cron', '0 9 * * *', '-m', 'Check'],
    ['schedule', 'create', '--name', 'Build', '--groups-file', '-', '-m', 'Check'],
    ['schedule', 'create', '--name', 'Build', '--triggers-file', '-', '--message-file', '-'],
    [...scheduleCreate, '--new-session', '--runner', 'codex'],
    [
      ...scheduleCreate,
      '--new-session',
      '--runner',
      'codex',
      '--default-model',
      '--model-id',
      'model'
    ],
    [
      ...scheduleCreate,
      '--session',
      'other',
      '--new-session',
      '--runner',
      'codex',
      '--default-model'
    ],
    [...scheduleCreate, '--new-session', '--runner', 'invalid', '--default-model'],
    ...['1.5', '9007199254740992'].map((value) => [
      'schedule',
      'update',
      '--task',
      'other',
      '--expected-revision',
      value,
      '-m',
      'Check'
    ]),
    ['schedule', 'update', '--task', 'other', '-m', 'Check'],
    ['schedule', 'update', '--task', 'other', '--expected-revision', '1'],
    ['schedule', 'update', '--task', 'other', '--expected-revision', '1', '--enabled', 'false']
  ])
    assert.throws(() => parseArgs(['agents', ...args]));

  let read = false;
  let output = '';
  const code = await main(['agents', ...scheduleCreate, '--json'], {
    env: { ...env, MAR_CTL_SESSION_ID: '' },
    stdin: (async function* () {
      read = true;
      yield JSON.stringify(triggers);
    })(),
    stdout: { write: (value) => (output += value) },
    client: { sessionCommand: async () => assert.fail('must not call Server') }
  });
  assert.notEqual(code, 0);
  assert.equal(JSON.parse(output).error.code, 'MARCTL_SESSION_CONTEXT_REQUIRED');
  assert.equal(read, false);
});

test('defaults only state and configuration commands to the current Session before reading input', async () => {
  for (const args of [
    ['show'],
    ['history'],
    ['graph'],
    ['config', '--effort', 'high'],
    ['rename', '--title', 'Renamed']
  ]) {
    const calls = [];
    const options = {
      env,
      stdout: { write() {} },
      stderr: { write() {} },
      client: {
        sessionCommand: async (body) => {
          calls.push(body);
          return {};
        }
      }
    };
    assert.equal(await main(['agents', ...args, '--json'], options), 0);
    assert.equal(calls[0].sessionId, 'source');
    const explicit = [...args];
    explicit.splice(1, 0, 'target');
    assert.equal(await main(['agents', ...explicit, '--json'], options), 0);
    assert.equal(calls[1].sessionId, 'target');
    let errorOutput = '';
    assert.notEqual(
      await main(['agents', ...args, '--json'], {
        ...options,
        env: { ...env, MAR_CTL_SESSION_ID: '' },
        stdout: {
          write: (value) => {
            errorOutput += value;
          }
        },
        stderr: {
          write: (value) => {
            errorOutput += value;
          }
        }
      }),
      0
    );
    assert.match(errorOutput, /MARCTL_SESSION_CONTEXT_REQUIRED/u);
    assert.equal(calls.length, 2);
  }
  for (const args of [
    ['send', '--steer', '-m', 'Urgent'],
    ['send', '--queue', '-m', 'Later'],
    ['goal', 'get'],
    ['goal', 'set', '-m', 'Finish'],
    ['goal', 'clear'],
    ['stop', '--run', 'r'],
    ['stop', 'child', '--execution', 'old'],
    ['wait', '--run', 'r', '--timeout', '1s']
  ])
    assert.throws(() => parseArgs(['agents', ...args]));
});

test('schedule text uses bounded UTF-8 stdin and new writes never retry uncertain outcomes', async () => {
  for (const [text, valid] of [
    [Buffer.from('x'.repeat(20000)), true],
    [Buffer.from('x'.repeat(20001)), false],
    [Buffer.from([0xff]), false]
  ]) {
    let calls = 0;
    const code = await main(
      [
        'agents',
        'schedule',
        'update',
        '--task',
        'task',
        '--expected-revision',
        '1',
        '--message-file',
        '-',
        '--json'
      ],
      {
        env,
        stdin: (async function* () {
          yield text;
        })(),
        stdout: { write() {} },
        client: {
          sessionCommand: async () => {
            calls++;
            return {};
          }
        }
      }
    );
    assert.equal(code === 0, valid);
    assert.equal(calls, valid ? 1 : 0);
  }
  for (const input of [
    '{',
    'null',
    '{}',
    '[]',
    `${' '.repeat(64_001)}${JSON.stringify(triggers)}`,
    Buffer.from([0xff])
  ]) {
    let output = '';
    assert.equal(
      await main(['agents', ...scheduleCreate, '--json'], {
        env,
        stdin: [input],
        stdout: { write: (value) => (output += value) },
        client: { sessionCommand: async () => assert.fail('must not call Server') }
      }),
      2
    );
    assert.equal(JSON.parse(output).error.code, 'MARCTL_SESSION_INPUT_INVALID');
  }
  for (const args of [
    ['rename', '--title', 'Updated'],
    scheduleCreate,
    ['schedule', 'update', '--task', 'task', '--expected-revision', '1', '--triggers-file', '-']
  ]) {
    let output = '';
    let calls = 0;
    const client = new MarctlClient({
      serverUrl: 'https://server.test',
      key: 'fixture-token',
      fetchImpl: async () => {
        calls++;
        return {
          ok: true,
          json: async () => {
            throw new SyntaxError('Unreadable response');
          }
        };
      }
    });
    assert.equal(
      await main(['agents', ...args, '--json'], {
        env,
        stdin: [JSON.stringify(triggers)],
        client,
        stdout: {
          write: (value) => {
            output += value;
          }
        }
      }),
      6
    );
    assert.equal(calls, 1);
    assert.equal(JSON.parse(output).error.code, 'MARCTL_OUTCOME_UNKNOWN');
  }
});

test('prompt set reports invalid UTF-8 input and rejects missing context before reading stdin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'marctl-prompt-'));
  const invalidUtf8 = join(root, 'invalid.txt');
  const validUtf8 = join(root, 'valid.txt');
  await writeFile(invalidUtf8, Buffer.from([0xff]));
  await writeFile(validUtf8, 'instructions 日本語');
  try {
    for (const args of [
      ['prompt', 'set', 's', '-m', ' \n\t'],
      ['prompt', 'set', 's', '-m', 'x'.repeat(20_001)],
      ['prompt', 'set', 's', '--message-file', invalidUtf8]
    ]) {
      let output = '';
      let calls = 0;
      assert.equal(
        await main(['agents', ...args, '--json'], {
          env,
          stdout: { write: (value) => (output += value) },
          client: { sessionCommand: async () => (calls++, {}) }
        }),
        2
      );
      const error = JSON.parse(output).error;
      assert.equal(error.code, 'MARCTL_SESSION_INPUT_INVALID');
      assert.match(error.details, /at most 20000 characters/u);
      assert.equal(calls, 0);
    }

    const submitted = [];
    const client = { sessionCommand: async (body) => (submitted.push(body), {}) };
    assert.equal(
      await main(['agents', 'prompt', 'set', 's', '--message-file', validUtf8, '--json'], {
        env,
        stdout: { write() {} },
        client
      }),
      0
    );
    assert.equal(
      await main(['agents', 'prompt', 'set', 's', '--message-file', '-', '--json'], {
        env,
        stdin: (async function* () {
          yield Buffer.from('stdin instructions');
        })(),
        stdout: { write() {} },
        client
      }),
      0
    );
    assert.deepEqual(
      submitted.map(({ action, sessionId, content }) => ({ action, sessionId, content })),
      [
        { action: 'prompt.set', sessionId: 's', content: 'instructions 日本語' },
        { action: 'prompt.set', sessionId: 's', content: 'stdin instructions' }
      ]
    );

    let consumed = false;
    let output = '';
    let calls = 0;
    assert.equal(
      await main(['agents', 'prompt', 'set', '--message-file', '-', '--json'], {
        env: { ...env, MAR_CTL_SESSION_ID: '' },
        stdin: (async function* () {
          consumed = true;
          yield Buffer.from('private prompt');
        })(),
        stdout: { write: (value) => (output += value) },
        client: { sessionCommand: async () => (calls++, {}) }
      }),
      1
    );
    assert.equal(JSON.parse(output).error.code, 'MARCTL_SESSION_CONTEXT_REQUIRED');
    assert.equal(consumed, false);
    assert.equal(calls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('send uses the same Node intent for default and explicit steer, and queues only explicitly', async () => {
  for (const [flags, intent] of [
    [[], 'REPLACE_CURRENT'],
    [['--steer'], 'REPLACE_CURRENT'],
    [['--queue'], 'QUEUE']
  ]) {
    const calls = [];
    assert.equal(
      await main(
        [
          'agents',
          'send',
          'target',
          '-m',
          'notice',
          '--client-message-id',
          'input',
          ...flags,
          '--json'
        ],
        {
          env,
          stdout: { write() {} },
          client: {
            sessionCommand: async (body) => {
              calls.push(body);
              return { accepted: true };
            }
          }
        }
      ),
      0
    );
    assert.deepEqual(calls, [
      {
        action: 'network',
        command: {
          operation: 'send',
          input: {
            agentId: 'target',
            content: 'notice',
            clientMessageId: 'input',
            deliveryIntent: intent
          }
        }
      }
    ]);
  }
  for (const args of [
    ['send', 'target', '-m', 'task', '--steer', '--queue'],
    ['send', 'target', '-m', 'task', '--queue', '--steer'],
    ['send', 'target', '-m', 'task', '--steer', '--steer'],
    ['send', 'target', '-m', 'task', '--steer', 'true'],
    ['send', 'target', '-m', 'task', '--queue', '--queue'],
    ['send', 'target', '-m', 'task', '--queue', 'true'],
    ['send', 'target', '-m', 'task', '--delivery', 'queue'],
    ['send', 'target', '-m', 'task', '--replace'],
    ['send', 'target', '-m', 'task', '--forced'],
    ['send', 'target', '-m', 'task', '--queue', '--forced'],
    ['start', '--runner', 'codex', '-m', 'task', '--queue'],
    ['start', '--runner', 'codex', '-m', 'task', '--steer'],
    ['start', '--runner', 'codex', '-m', 'task', '--forced']
  ])
    assert.throws(() => parseArgs(['agents', ...args]));
});

test('rejects conflicting, repeated, or retired send modes locally before reading input or authorization', async () => {
  for (const locale of ['en_US.UTF-8', 'zh_CN.UTF-8']) {
    for (const [flags, expectsDeliveryError] of [
      [['--steer', '--queue'], true],
      [['--queue', '--steer'], true],
      [['--steer', '--steer'], false],
      [['--queue', '--queue'], false],
      [['--forced'], false],
      [['--queue', '--forced'], false]
    ]) {
      let output = '';
      const code = await main(
        ['agents', 'send', 'target', '--message-file', '-', ...flags, '--json'],
        {
          env: new Proxy(
            { LANG: locale },
            {
              get(target, key) {
                assert.ok(
                  !String(key).startsWith('MAR_CTL_'),
                  'Invalid delivery must not read credentials'
                );
                return target[key];
              }
            }
          ),
          stdin: {
            [Symbol.asyncIterator]() {
              assert.fail('Invalid delivery must not read stdin');
            }
          },
          client: new Proxy(
            {},
            {
              get() {
                assert.fail('Invalid delivery must not contact Server');
              }
            }
          ),
          stdout: {
            write(value) {
              output += value;
            }
          },
          stderr: {
            write(value) {
              assert.fail(value);
            }
          }
        }
      );
      assert.equal(code, 2);
      const error = JSON.parse(output).error;
      assert.equal(error.code, 'MARCTL_SESSION_INPUT_INVALID');
      if (expectsDeliveryError) {
        assert.match(error.message, /--steer/u);
        assert.match(error.message, /--queue/u);
      }
    }
  }
});

test('updates model and effort independently and forwards startup effort', async () => {
  const calls = [];
  const client = {
    sessionCommand: async (body) => {
      calls.push(body);
      return { session: { id: 'target' } };
    }
  };
  const invoke = (args) =>
    main(['agents', ...args, '--json'], { env, client, stdout: { write() {} } });
  assert.equal(
    await invoke(['config', 'target', '--model-id', 'next-model', '--effort', 'high']),
    0
  );
  assert.deepEqual(calls[0], {
    action: 'config',
    sessionId: 'target',
    modelId: 'next-model',
    effort: 'high'
  });
  assert.equal(await invoke(['config', 'target', '--effort', '']), 0);
  assert.deepEqual(calls[1], { action: 'config', sessionId: 'target', effort: '' });
  assert.equal(await invoke(['config', 'target', '--model-id', 'next-model']), 0);
  assert.equal(Object.hasOwn(calls[2], 'effort'), false);
  assert.equal(await invoke(['start', '--runner', 'codex', '--effort', 'low', '-m', 'task']), 0);
  assert.equal(calls[3].command.input.effort, 'low');
  for (const args of [
    ['config', 'target'],
    ['config', 'target', '--access', 'full-access'],
    ['config', 'target', '--model-id', ''],
    ['config', 'target', '--model', 'old'],
    ['start', '--model', 'old', '-m', 'work'],
    ['start', '--model', 'old', '--model-id', 'selected', '-m', 'work'],
    ['config', 'target', '--effort', 'x'.repeat(121)],
    ['config', 'target', '--model-id', 'x'.repeat(121)]
  ])
    assert.throws(() => parseArgs(['agents', ...args]));
  let output = '';
  let writes = 0;
  assert.equal(
    await main(['agents', 'config', 'target', '--effort', 'low', '--json'], {
      env,
      stdout: {
        write: (value) => {
          output += value;
        }
      },
      client: {
        sessionCommand: async () => {
          writes += 1;
          throw new MarctlError('Network failure', { code: 'MARCTL_REQUEST_TIMEOUT' });
        }
      }
    }),
    6
  );
  assert.equal(writes, 1);
  assert.equal(JSON.parse(output).error.code, 'MARCTL_OUTCOME_UNKNOWN');
});

test('forwards tree and graph queries without assigning parents to sends or terminal-created Sessions', async () => {
  const calls = [];
  let output = '';
  const client = {
    sessionCommand: async (body) => {
      calls.push(body);
      return { rootSessionId: 'source', nodes: [], truncated: true };
    }
  };
  const invoke = (args, context = env) =>
    main(['agents', ...args, '--json'], {
      env: context,
      client,
      stdout: {
        write: (value) => {
          output = value;
        }
      }
    });
  assert.equal(await invoke(['list', '--scope', 'tree', '--limit', '1']), 0);
  assert.deepEqual(calls[0], {
    action: 'network',
    command: {
      operation: 'list',
      input: { scope: 'tree', limit: 1 }
    }
  });
  assert.equal(await invoke(['graph', 'source', '--limit', '2']), 0);
  assert.deepEqual(calls[1], { action: 'graph', sessionId: 'source', limit: 2 });
  assert.equal(JSON.parse(output).truncated, true);
  assert.equal(
    await invoke(['start', '--runner', 'codex', '-m', 'task'], {
      ...env,
      MAR_CTL_SESSION_ID: undefined
    }),
    0
  );
  assert.equal(Object.hasOwn(calls[2].command.input, 'parentSessionId'), false);
  assert.equal(Object.hasOwn(calls[2].command.input, 'sourceSessionId'), false);
  assert.equal(await invoke(['send', 'existing', '--steer', '-m', 'task']), 0);
  assert.equal(Object.hasOwn(calls[3].command.input, 'parentSessionId'), false);
  assert.equal(Object.hasOwn(calls[3].command.input, 'sourceSessionId'), false);
  assert.equal(await invoke(['start', '--runner', 'codex', '-m', 'new task']), 0);
  assert.equal(Object.hasOwn(calls[4].command.input, 'parentSessionId'), false);
  assert.equal(Object.hasOwn(calls[4].command.input, 'sourceSessionId'), false);
  assert.equal(await invoke(['send', 'existing', '--queue', '-m', 'later']), 0);
  assert.equal(Object.hasOwn(calls[5].command.input, 'sourceSessionId'), false);
  assert.equal(await invoke(['goal', 'set', 'existing', '-m', 'objective']), 0);
  assert.equal(Object.hasOwn(calls[6], 'sourceSessionId'), false);
});

test('forwards title searches and preserves nearby Session hints in JSON and text errors', async () => {
  const calls = [];
  let output = '';
  const client = {
    sessionCommand: async (body) => {
      calls.push(body);
      return { sessions: [] };
    }
  };
  assert.equal(
    await main(['agents', 'list', '--query', 'fixer#42', '--json'], {
      env,
      client,
      stdout: {
        write: (value) => {
          output += value;
        }
      }
    }),
    0
  );
  assert.deepEqual(calls, [
    {
      action: 'network',
      command: {
        operation: 'list',
        input: { query: 'fixer#42' }
      }
    }
  ]);
  const details = 'Similar Sessions (suggestions only):\nsession-id fixer#42 Fix totals';
  for (const json of [true, false]) {
    output = '';
    const target = {
      write: (value) => {
        output += value;
      }
    };
    const code = await main(['agents', 'show', 'mistyped-id', ...(json ? ['--json'] : [])], {
      env,
      client: {
        sessionCommand: async () => {
          throw new MarctlError('The Session was not found.', {
            code: 'SESSION_NOT_FOUND',
            details
          });
        }
      },
      stdout: target,
      stderr: target
    });
    assert.equal(code, 1);
    if (json) assert.equal(JSON.parse(output).error.details, details);
    else assert.ok(output.includes(details));
  }
});

test('wait reports a rejected WebSocket credential as authorization failure', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  server.on('connection', (socket) => socket.close(1008, 'UNAUTHENTICATED'));
  const transport = new MarctlClient({
    serverUrl: 'http://127.0.0.1:' + server.address().port,
    key: 'fixture-token'
  });
  const client = {
    openWorkbenchWebSocket: () => transport.openWorkbenchWebSocket(WebSocket),
    sessionCommand: () => assert.fail('Rejected connection must not register a Watch')
  };
  let output = '';
  try {
    const code = await main(
      ['agents', 'wait', 's', '--run', 'r', '--timeout', '1s', '--until', 'approval', '--json'],
      {
        env,
        client,
        stdout: { write: (value) => (output += value) }
      }
    );
    assert.equal(code, 3);
    assert.equal(JSON.parse(output).error.code, 'UNAUTHENTICATED');
  } finally {
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('wait preserves authorization failure and request IDs when its Watch renewal is rejected', async () => {
  class Socket extends EventEmitter {
    send() {
      setImmediate(() =>
        this.emit(
          'message',
          JSON.stringify({ type: 'workbench.ready', workbenchConnectionId: 'connection' })
        )
      );
    }
    close() {
      this.closed = true;
    }
  }
  const socket = new Socket();
  const calls = [];
  let output = '';
  const client = {
    openWorkbenchWebSocket: () => {
      setImmediate(() => socket.emit('open'));
      return socket;
    },
    sessionCommand: async (body) => {
      calls.push(body.mode);
      if (body.mode === 'initial')
        socket.emit(
          'message',
          watchEnvelope({
            type: 'watch.session.snapshot',
            watchId: body.watchId,
            payload: {
              session: { id: 's' },
              progress: { runId: 'r', pendingApprovals: [] },
              runs: [{ id: 'r', sessionId: 's', status: 'RUNNING' }]
            },
            expiresAt: Date.now() + 100
          })
        );
      if (body.mode === 'renew')
        throw new MarctlError('Access denied.', {
          code: 'RESOURCE_ACCESS_DENIED',
          statusCode: 403,
          requestId: 'renew-request',
          upstreamRequestId: 'node-renew-request'
        });
      return { accepted: true };
    }
  };
  const code = await main(
    ['agents', 'wait', 's', '--run', 'r', '--timeout', '1s', '--until', 'approval', '--json'],
    {
      env,
      client,
      stdout: { write: (value) => (output += value) }
    }
  );
  assert.equal(code, 3);
  assert.deepEqual(JSON.parse(output).error, {
    code: 'RESOURCE_ACCESS_DENIED',
    message: 'Access denied.',
    requestId: 'renew-request',
    upstreamRequestId: 'node-renew-request',
    sessionId: 's',
    runId: 'r',
    stage: 'renew'
  });
  assert.deepEqual(calls, ['initial', 'renew', 'stop']);
  assert.equal(socket.closed, true);
});
test('parses closed Session commands including creation and rejects scope overrides', () => {
  for (const flags of [
    ['--parent', 'source'],
    ['--agent', 'source'],
    ['--runner', 'codex'],
    ['--cursor', 'next'],
    ...['children', 'descendants', 'workspace', 'profile'].map((scope) => ['--scope', scope])
  ])
    assert.throws(() => parseArgs(['agents', 'list', ...flags]));
  assert.equal(parseArgs(['agents', 'list', '--scope', 'active']).scope, 'active');
  assert.equal(parseArgs(['agents', 'graph', 'source', '--limit', '2']).limit, 2);
  assert.equal(parseArgs(['agents', 'graph']).action, 'graph');
  for (const args of [['graph', 'source', '--limit', '101']])
    assert.throws(() => parseArgs(['agents', ...args]));
  assert.equal(
    parseArgs(['agents', 'start', '--runner', 'codex', '-m', 'task', '--parent', 'source'])
      .parentSessionId,
    'source'
  );
  assert.equal(parseArgs(['agents', 'list', '--query', 'fixer#42']).query, 'fixer#42');
  assert.throws(() => parseArgs(['agents', 'list', '--query', 'x'.repeat(161)]));
  assert.deepEqual(
    parseArgs([
      'agents',
      'start',
      '--runner',
      'codex',
      '--message-file',
      '-',
      '--title',
      'fixer#42 Parse fixture',
      '--json'
    ]),
    {
      command: 'agents',
      action: 'start',
      runner: 'codex',
      messageFile: '-',
      title: 'fixer#42 Parse fixture',
      json: true
    }
  );
  assert.equal(parseArgs(['agents', 'goal', 'clear', 's']).action, 'goal.clear');
  assert.deepEqual(parseArgs(['agents', 'prompt', 'get']), {
    command: 'agents',
    action: 'prompt.get'
  });
  assert.equal(
    parseArgs(['agents', 'wait', 's', '--run', 'r', '--timeout', '1s', '--until', 'approval'])
      .until,
    'approval'
  );
  for (const args of [
    ['list', '--workspace', 'w'],
    ['send', 's'],
    ['wait', 's', '--run', 'r', '--timeout', '0s'],
    ['list', '--limit', '101'],
    ['show', 's', '--run', 'r'],
    ['prompt', 'set', 's'],
    ['approval', 'decide', 's', '--run', 'r', '--approval', 'a'],
    ['approval', 'decide', '--run', 'r', '--approval', 'a', '--decision', 'approve'],
    ['wait', 's', '--run', 'r', '--timeout', '1s', '--until', 'anything']
  ])
    assert.throws(() => parseArgs(['agents', ...args]));
});

test('sends an explicit peer relationship without a parent', async () => {
  let body;
  const status = await main(
    ['agents', 'start', '--relation', 'peer', '--title', 'Peer', '-m', 'task', '--json'],
    {
      env,
      client: {
        async sessionCommand(input) {
          body = input;
          return { agentId: 'peer' };
        }
      },
      stdout: { write() {} },
      stderr: { write: (value) => assert.fail(value) }
    }
  );
  assert.equal(status, 0);
  assert.equal(body.command.operation, 'start');
  assert.equal(body.command.input.relation, 'peer');
  assert.equal(Object.hasOwn(body.command.input, 'parentSessionId'), false);
  assert.throws(() => parseArgs(['agents', 'start', '--relation', 'unknown', '-m', 'task']));
  assert.throws(() =>
    parseArgs(['agents', 'start', '--relation', 'peer', '--parent', 'source', '-m', 'task'])
  );
});
test('supports direct messages while rejecting images and ambiguous input', () => {
  for (const content of ['--help', '-h', '--json', '--review'])
    assert.equal(parseArgs(['agents', 'send', 's', '--steer', '-m', content]).message, content);
  assert.equal(
    parseArgs(['agents', 'send', 's', '--steer', '-m', 'Review this']).message,
    'Review this'
  );
  assert.equal(
    parseArgs(['agents', 'goal', 'set', 's', '--message', 'Finish review']).message,
    'Finish review'
  );
  for (const args of [
    ['start', '--runner', 'codex', '--image', 'a.png'],
    ['start', '-m', 'task', '--image', 'a.png'],
    ['send', 's', '-m', 'update', '--image', 'a.png'],
    ['send', 's', '--steer', '-m', 'one', '--message', 'two'],
    ['send', 's', '--steer', '-m', 'one', '--message-file', '-'],
    ['goal', 'set', 's', '--image', 'a.png'],
    ['goal', 'set', 's', '-m', 'goal', '--image', 'a.png'],
    ['send', 's', '--steer', ...Array(6).fill(['--image', 'a.png']).flat()]
  ])
    assert.throws(() => parseArgs(['agents', ...args]));
});

test('submits text and message files once and rejects images without submitting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'marctl-input-'));
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=',
    'base64'
  );
  const image = join(root, 'screen shot.png');
  await writeFile(image, png);
  const messageFile = join(root, 'task.txt');
  await writeFile(messageFile, 'Review the task');
  const calls = [];
  const client = {
    sessionCommand: async (body) => {
      calls.push(body);
      return { accepted: true };
    }
  };
  const invoke = async (args) =>
    main(['agents', ...args, '--json'], {
      env,
      client,
      stdout: { write() {} },
      stderr: { write() {} }
    });
  try {
    assert.equal(await invoke(['start', '--runner', 'mar-agent', '-m', 'Review this']), 0);
    assert.equal(await invoke(['send', 's', '--steer', '-m', 'Continue review']), 0);
    assert.equal(await invoke(['goal', 'set', 's', '-m', 'Finish review']), 0);
    assert.equal(calls[0].command.input.content, 'Review this');
    assert.equal(calls[1].command.input.content, 'Continue review');
    assert.equal(Object.hasOwn(calls[0].command.input, 'attachments'), false);
    assert.equal(Object.hasOwn(calls[1].command.input, 'attachments'), false);
    assert.equal(calls[2].content, 'Finish review');
    assert.equal(calls[2].attachments, undefined);
    assert.equal(await invoke(['send', 's', '--steer', '--message-file', messageFile]), 0);
    assert.equal(calls[3].command.input.content, 'Review the task');
    assert.equal(Object.hasOwn(calls[3].command.input, 'attachments'), false);
    for (const args of [
      ['send', 's', '--steer', '-m', '   '],
      ['send', 's', '--steer', '-m', 'a'.repeat(100001)],
      ['goal', 'set', 's', '-m', 'a'.repeat(20001)],
      ['start', '--runner', 'codex', '-m', 'task', '--image', image],
      ['send', 's', '--steer', '-m', 'update', '--image', image],
      ['send', 's', '--message-file', messageFile, '--image', image],
      ['send', 's', '--steer', '--image', root],
      ['send', 's', '--steer', '--image', join(root, 'missing.png')]
    ])
      assert.equal(await invoke(args), 2);
    assert.equal(calls.length, 4, 'Invalid local inputs must not mutate Sessions');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('submits one start with stdin and preserves the generated correlation ID', async () => {
  let output = '';
  let error = '';
  const calls = [];
  const result = await main(
    ['agents', 'start', '--runner', 'codex', '--message-file', '-', '--json'],
    {
      env,
      stdin: (async function* () {
        yield Buffer.from('Develop a fixture');
      })(),
      stdout: { write: (value) => (output += value) },
      stderr: { write: (value) => (error += value) },
      client: {
        sessionCommand: async (body) => {
          calls.push(body);
          return { session: { id: 'native' }, delivery: 'STARTED' };
        }
      }
    }
  );
  assert.equal(result, 0);
  assert.equal(error, '');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command.input.content, 'Develop a fixture');
  assert.equal(calls[0].command.input.parentSessionId, undefined);
  assert.match(calls[0].command.input.clientMessageId, /^[a-f0-9-]{36}$/u);
  assert.equal(JSON.parse(output).clientMessageId, calls[0].command.input.clientMessageId);
});
test('wait ignores invalid frames and closes observation when cancelled', async () => {
  class Socket extends EventEmitter {
    close() {
      this.closed = true;
    }
  }
  const socket = new Socket();
  const controller = new AbortController();
  const waiting = waitForSessionRun({
    client: {
      openWorkbenchWebSocket: () => socket,
      sessionCommand: () => assert.fail('Invalid frames must not register a Watch')
    },
    sessionId: 's',
    runId: 'r',
    timeoutMs: 1000,
    WebSocketClass: Socket,
    signal: controller.signal
  });
  try {
    for (const raw of ['{', 'null', 'false', '[]', '{"type":"watch.event","event":null}'])
      assert.doesNotThrow(() => socket.emit('message', raw));
  } finally {
    controller.abort();
    await assert.rejects(waiting, { code: 'MARCTL_WAIT_CANCELLED' });
  }
  assert.equal(socket.closed, true);
  assert.equal(socket.listenerCount('message'), 0);
  assert.equal(socket.listenerCount('close'), 0);
});

test('wait uses the existing owned Watch and releases it on a terminal Run', async () => {
  class Socket extends EventEmitter {
    send(raw) {
      assert.deepEqual(JSON.parse(raw), { type: 'resume' });
      setImmediate(() =>
        this.emit(
          'message',
          JSON.stringify({ type: 'workbench.ready', workbenchConnectionId: 'connection' })
        )
      );
    }
    close() {
      this.closed = true;
    }
  }
  const socket = new Socket();
  const calls = [];
  const client = {
    openWorkbenchWebSocket: () => {
      setImmediate(() => socket.emit('open'));
      return socket;
    },
    sessionCommand: async (body) => {
      calls.push(body);
      if (body.mode === 'initial')
        setImmediate(() =>
          socket.emit(
            'message',
            watchEnvelope({
              type: 'watch.session.snapshot',
              watchId: body.watchId,
              payload: { runs: [{ id: 'r', sessionId: 's', status: 'SUCCEEDED' }] },
              expiresAt: Date.now() + 30000
            })
          )
        );
      return { accepted: true };
    }
  };
  const result = await waitForSessionRun({ client, sessionId: 's', runId: 'r', timeoutMs: 1000 });
  assert.equal(result.run.status, 'SUCCEEDED');
  assert.deepEqual(
    calls.map((call) => call.mode),
    ['initial', 'stop']
  );
  assert.equal(socket.closed, true);
});

test('wait returns pending approvals from initial or incremental progress and always releases its Watch', async () => {
  const ownApproval = { id: 'approval-1', runId: 'r', prompt: 'Allow tool?' };
  const cases = [
    {
      initial: { runId: 'r', pendingApprovals: [ownApproval, { id: 'other', runId: 'other' }] },
      expected: {
        sessionId: 's',
        runId: 'r',
        stopReason: 'APPROVAL_REQUIRED',
        pendingApprovals: [ownApproval]
      }
    },
    {
      initial: { runId: 'r', pendingApprovals: [] },
      update: { runId: 'r', pendingApprovals: [ownApproval] },
      expected: {
        sessionId: 's',
        runId: 'r',
        stopReason: 'APPROVAL_REQUIRED',
        pendingApprovals: [ownApproval]
      }
    },
    {
      initial: { runId: 'r', pendingApprovals: [ownApproval] },
      status: 'SUCCEEDED',
      expected: { run: { id: 'r', sessionId: 's', status: 'SUCCEEDED' } }
    },
    { initial: { runId: 'r' }, error: 'NODE_OPERATION_UNSUPPORTED' }
  ];

  for (const scenario of cases) {
    class Socket extends EventEmitter {
      send(raw) {
        assert.deepEqual(JSON.parse(raw), { type: 'resume' });
        queueMicrotask(() =>
          this.emit(
            'message',
            JSON.stringify({ type: 'workbench.ready', workbenchConnectionId: 'c' })
          )
        );
      }
      close() {
        this.closed = true;
      }
    }
    const socket = new Socket();
    const calls = [];
    const client = {
      openWorkbenchWebSocket: () => {
        queueMicrotask(() => socket.emit('open'));
        return socket;
      },
      sessionCommand: async (command) => {
        calls.push(command);
        if (command.mode === 'initial')
          setImmediate(() => {
            socket.emit(
              'message',
              watchEnvelope({
                type: 'watch.session.snapshot',
                watchId: command.watchId,
                payload: {
                  session: { id: 's' },
                  runs: [{ id: 'r', sessionId: 's', status: scenario.status ?? 'RUNNING' }],
                  progress: scenario.initial
                },
                expiresAt: Date.now() + 30_000
              })
            );
            if (scenario.update)
              socket.emit(
                'message',
                watchEnvelope({
                  type: 'watch.session.event',
                  watchId: command.watchId,
                  event: { payload: { sessionId: 's', progress: scenario.update } }
                })
              );
          });
        return { accepted: true };
      }
    };

    if (scenario.error) {
      await assert.rejects(
        waitForSessionRun({
          client,
          sessionId: 's',
          runId: 'r',
          timeoutMs: 1000,
          until: 'approval'
        }),
        { code: scenario.error, stage: 'approval' }
      );
    } else {
      assert.deepEqual(
        await waitForSessionRun({
          client,
          sessionId: 's',
          runId: 'r',
          timeoutMs: 1000,
          until: 'approval'
        }),
        scenario.expected
      );
    }
    assert.deepEqual(
      calls.map((call) => call.mode),
      ['initial', 'stop']
    );
    assert.equal(socket.closed, true);
    assert.equal(socket.listenerCount('message'), 0);
  }
});

test('message text does not select JSON error output', async () => {
  for (const json of [false, true]) {
    let output = '';
    let error = '';
    const result = await main(
      ['agents', 'send', 's', '--steer', '-m', '--json', ...(json ? ['--json'] : [])],
      {
        env,
        client: {
          sessionCommand: async () => {
            throw new MarctlError('Fixture rejection.', {
              code: 'FIXTURE_REJECTED',
              statusCode: 400
            });
          }
        },
        stdout: { write: (value) => (output += value) },
        stderr: { write: (value) => (error += value) }
      }
    );
    assert.equal(result, 1);
    if (json) {
      assert.equal(JSON.parse(output).error.code, 'FIXTURE_REJECTED');
      assert.equal(error, '');
    } else {
      assert.equal(output, '');
      assert.match(error, /FIXTURE_REJECTED/u);
    }
  }
});

for (const locale of ['en_US.UTF-8', 'zh_CN.UTF-8']) {
  test(`Session help has readable command continuations and offline entrypoints (${locale})`, async () => {
    const outputs = [];
    for (const args of [
      ['help', 'agents'],
      ['agents', '--help']
    ]) {
      let output = '';
      assert.equal(
        await main(args, {
          env: new Proxy(
            { LANG: locale },
            {
              get(target, key) {
                assert.ok(!String(key).startsWith('MAR_CTL_'), 'Help must not read configuration');
                return target[key];
              }
            }
          ),
          stdout: { write: (value) => (output += value) },
          stderr: { write: (value) => assert.fail(value) },
          client: new Proxy({}, { get: () => assert.fail('Help must not contact Server') })
        }),
        0
      );
      outputs.push(output);
      for (const action of ['start', 'send', 'wait', 'stop', 'list', 'view']) {
        const lines = output.split('\n');
        const start = lines.findIndex((line) => line.startsWith(`  marctl agents ${action} `));
        assert.ok(start >= 0, action);
        if (!['stop', 'view'].includes(action)) assert.match(lines[start + 1], /^ {4}\S/u);
      }
      for (const flag of [
        '--runner',
        '--parent',
        '--relation child|peer',
        '--goal',
        '--clear-goal',
        '--scope',
        '--wait-for',
        '--timeout'
      ])
        assert.ok(output.includes(flag), flag);
      assert.ok(!output.includes('--forced'));
      assert.ok(!output.includes('--history'));
      assert.ok(!output.includes('--cron'));
      assert.match(output, /schedule list \[--current \| --session /u);
      assert.match(output, /schedule get --task/u);
      assert.match(output, /schedule runs --task/u);
      assert.match(output, /schedule create --name .* --triggers-file/u);
      assert.match(output, /hourly[^\n]*minutes[^\n]*0\.\.59/u);
      assert.match(output, /schedule update --task .* --expected-revision/u);
      assert.ok(!output.toLowerCase().includes('urgent'));
      for (const line of output.split('\n')) {
        // Count CJK glyphs as two columns; other help characters occupy one.
        const columns = [...line].reduce(
          (width, character) =>
            width +
            (/[\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff\ufe10-\ufe6f\uff01-\uff60]/u.test(character)
              ? 2
              : 1),
          0
        );
        assert.ok(columns <= 80, `${columns} columns: ${line}`);
      }
      for (const heading of locale.startsWith('zh')
        ? ['管理', '输入与结果', '退出码']
        : ['Management', 'Input and results', 'Exit codes'])
        assert.ok(output.includes(`\n\n${heading}`), heading);
    }
    assert.equal(outputs[0], outputs[1]);
  });
}

test('Session help documents prompts and approvals without supporting --prompt-file', async () => {
  for (const locale of ['en_US.UTF-8', 'zh_CN.UTF-8']) {
    let output = '';
    assert.equal(
      await main(['help', 'agents'], {
        env: { LANG: locale },
        stdout: { write: (value) => (output += value) },
        client: { sessionCommand: () => assert.fail('Help must not contact Server') }
      }),
      0
    );
    assert.ok(output.includes('[--runner <runner>]'));
    assert.ok(output.includes('-m <text>'));
    assert.ok(!output.includes('--image'));
    assert.ok(output.includes('prompt get'));
    assert.ok(output.includes('prompt set'));
    assert.ok(output.includes('agents prompt get|clear'));
    assert.ok(output.includes('approval decide'));
    assert.ok(output.includes('--until approval'));
    assert.ok(!output.includes('--prompt-file'));
  }
  assert.throws(() => parseArgs(['agents', 'prompt', 'set', 's', '--file', '-']));
  assert.throws(() =>
    parseArgs([
      'agents',
      'start',
      '--runner',
      'codex',
      '--message-file',
      '-',
      '--prompt-file',
      'role.txt'
    ])
  );
});

test('keeps structured authorization failures and reports unknown mutation outcomes without resending', async () => {
  const client = new MarctlClient({
    serverUrl: 'https://server.test',
    key: 'private-fixture-token',
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      json: async () => ({
        error: {
          code: 'RESOURCE_ACCESS_DENIED',
          message: 'Access denied.',
          requestId: 'request-1',
          upstreamRequestId: 'node-request-1'
        }
      })
    })
  });
  await assert.rejects(
    client.sessionCommand({ action: 'list' }),
    (error) =>
      error.code === 'RESOURCE_ACCESS_DENIED' &&
      error.requestId === 'request-1' &&
      error.upstreamRequestId === 'node-request-1' &&
      error.statusCode === 403
  );
  let output = '';
  let calls = 0;
  const code = await main(
    [
      'agents',
      'send',
      's',
      '--steer',
      '--message-file',
      '-',
      '--client-message-id',
      'known-message',
      '--json'
    ],
    {
      env,
      stdin: (async function* () {
        yield Buffer.from('Private task input');
      })(),
      stdout: { write: (value) => (output += value) },
      client: {
        sessionCommand: async () => {
          calls += 1;
          throw new MarctlError('Network failure', { code: 'MARCTL_REQUEST_TIMEOUT' });
        }
      }
    }
  );
  assert.equal(code, 6);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(output).error.clientMessageId, 'known-message');
  assert.equal(JSON.parse(output).error.code, 'MARCTL_OUTCOME_UNKNOWN');
  assert.ok(!output.includes('Private task input'));
  assert.ok(!output.includes(env.MAR_CTL_USER_TOKEN));
  for (const args of [
    ['start', '--runner', 'mar-agent', '-m', 'task'],
    ['config', 's', '--model-id', 'model'],
    ['rename', 's', '--title', 'title'],
    ['prompt', 'set', 's', '-m', 'new instructions'],
    ['prompt', 'clear', 's'],
    ['approval', 'decide', 's', '--run', 'r', '--approval', 'a', '--decision', 'approve'],
    [...scheduleCreate, '--session', 's'],
    ['schedule', 'update', '--task', 'task', '--expected-revision', '1', '--triggers-file', '-'],
    ['stop', 's'],
    ['goal', 'set', 's', '-m', 'goal'],
    ['goal', 'clear', 's']
  ]) {
    let mutationCalls = 0;
    let mutationOutput = '';
    assert.equal(
      await main(['agents', ...args, '--json'], {
        env,
        stdin: [JSON.stringify(triggers)],
        stdout: { write: (value) => (mutationOutput += value) },
        client: {
          sessionCommand: async () => {
            mutationCalls++;
            throw new MarctlError('Network failure', { code: 'MARCTL_REQUEST_TIMEOUT' });
          }
        }
      }),
      6
    );
    assert.equal(mutationCalls, 1);
    assert.equal(JSON.parse(mutationOutput).error.code, 'MARCTL_OUTCOME_UNKNOWN');
  }
});

test('wait timeout and unknown Run release observation without cancelling any Run', async () => {
  for (const unknown of [false, true]) {
    class Socket extends EventEmitter {
      send(raw) {
        assert.deepEqual(JSON.parse(raw), { type: 'resume' });
        setImmediate(() =>
          this.emit(
            'message',
            JSON.stringify({ type: 'workbench.ready', workbenchConnectionId: 'connection' })
          )
        );
      }
      close() {
        this.closed = true;
      }
    }
    const socket = new Socket();
    const calls = [];
    const client = {
      openWorkbenchWebSocket: () => {
        setImmediate(() => socket.emit('open'));
        return socket;
      },
      sessionCommand: async (body) => {
        calls.push(body);
        if (body.mode === 'initial')
          setImmediate(() =>
            socket.emit(
              'message',
              watchEnvelope({
                type: 'watch.session.snapshot',
                watchId: body.watchId,
                payload: { runs: unknown ? [] : [{ id: 'r', sessionId: 's', status: 'RUNNING' }] },
                expiresAt: Date.now() + 30000
              })
            )
          );
        return { accepted: true };
      }
    };
    await assert.rejects(
      waitForSessionRun({ client, sessionId: 's', runId: 'r', timeoutMs: 30 }),
      (error) => error.code === (unknown ? 'MARCTL_WAIT_UNKNOWN' : 'MARCTL_WAIT_TIMEOUT')
    );
    assert.deepEqual(
      calls.map((call) => call.mode),
      ['initial', 'stop']
    );
    assert.equal(socket.closed, true);
    assert.ok(calls.every((call) => call.action === 'watch'));
  }
});

test('wait timeouts return the latest observed activity in JSON and text without polling', async () => {
  for (const json of [true, false]) {
    const progress = {
      status: 'SLEEPING',
      runId: 'r',
      observedAt: 2,
      pendingApprovals: [],
      latestMessage: {
        runId: 'r',
        state: 'COMPLETED',
        at: 1,
        text: 'Waiting for review.',
        truncated: false
      },
      recentTools: [
        {
          runId: 'r',
          name: 'sleep',
          state: 'IN_PROGRESS',
          at: 2,
          summary: 'Sleep for up to 10000 ms',
          truncated: false
        }
      ]
    };
    const modes = [];
    class Socket extends EventEmitter {
      constructor() {
        super();
        queueMicrotask(() =>
          this.emit(
            'message',
            JSON.stringify({ type: 'workbench.ready', workbenchConnectionId: 'connection' })
          )
        );
      }
      send() {}
      close() {}
    }
    let socket;
    const client = {
      openWorkbenchWebSocket: () => (socket = new Socket()),
      sessions: () => assert.fail('wait must not poll Session APIs'),
      sessionCommand: async (command) => {
        modes.push(command.mode);
        if (command.mode === 'initial')
          queueMicrotask(() => {
            socket.emit(
              'message',
              watchEnvelope({
                type: 'watch.session.snapshot',
                watchId: command.watchId,
                payload: {
                  session: { id: 's' },
                  progress,
                  runs: [{ id: 'r', sessionId: 's', status: 'RUNNING' }]
                }
              })
            );
            socket.emit(
              'message',
              watchEnvelope({
                type: 'watch.session.event',
                watchId: command.watchId,
                event: {
                  category: 'conversation',
                  payload: { sessionId: 's', progress }
                }
              })
            );
            socket.emit(
              'message',
              watchEnvelope({
                type: 'watch.session.event',
                watchId: 'foreign',
                event: {
                  payload: {
                    sessionId: 's',
                    progress: {
                      ...progress,
                      latestMessage: { text: 'DO_NOT_INCLUDE_FOREIGN_ACTIVITY' }
                    }
                  }
                }
              })
            );
            for (const [sessionId, runId] of [
              ['other', 'r'],
              ['s', 'other']
            ])
              socket.emit(
                'message',
                watchEnvelope({
                  type: 'watch.session.event',
                  watchId: command.watchId,
                  event: {
                    payload: {
                      sessionId,
                      progress: {
                        ...progress,
                        runId,
                        latestMessage: { text: 'DO_NOT_INCLUDE_FOREIGN_ACTIVITY' }
                      }
                    }
                  }
                })
              );
          });
        return { expiresAt: Date.now() + 60_000 };
      }
    };
    let output = '';
    let errors = '';
    const exit = await main(
      [
        'agents',
        'wait',
        's',
        '--run',
        'r',
        '--timeout',
        '1s',
        '--until',
        'approval',
        ...(json ? ['--json'] : [])
      ],
      {
        env,
        client,
        stdout: {
          write: (value) => {
            output += value;
          }
        },
        stderr: {
          write: (value) => {
            errors += value;
          }
        }
      }
    );
    assert.equal(exit, 5);
    assert.deepEqual(modes, ['initial', 'stop']);
    if (json) {
      const error = JSON.parse(output).error;
      assert.equal(error.code, 'MARCTL_WAIT_TIMEOUT');
      assert.equal(error.stage, 'timeout');
      assert.deepEqual(error.progress, progress);
    } else {
      assert.match(errors, /MARCTL_WAIT_TIMEOUT/);
      assert.match(errors, /SLEEPING/);
      assert.match(errors, /Waiting for review/);
    }
    assert.doesNotMatch(output + errors, /DO_NOT_INCLUDE_FOREIGN_ACTIVITY/);
  }
});

test('wait timeout keeps the latest progress across the real Workbench WebSocket without polling', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  let peer;
  server.on('connection', (socket) => {
    peer = socket;
    socket.on('message', () =>
      socket.send(
        JSON.stringify({ type: 'workbench.ready', workbenchConnectionId: 'real-connection' })
      )
    );
  });
  const transport = new MarctlClient({
    serverUrl: 'http://127.0.0.1:' + server.address().port,
    key: 'fixture-token'
  });
  const progress = {
    status: 'SLEEPING',
    runId: 'r',
    latestMessage: null,
    recentTools: [
      {
        name: 'sleep',
        state: 'IN_PROGRESS',
        summary: 'Sleep for up to 5000 ms',
        at: 2,
        runId: 'r',
        truncated: false
      }
    ],
    observedAt: 2
  };
  const modes = [];
  const client = {
    openWorkbenchWebSocket: () => transport.openWorkbenchWebSocket(WebSocket),
    sessionCommand: async (body) => {
      modes.push(body.mode);
      if (body.mode === 'initial') {
        peer.send(
          watchEnvelope({
            type: 'watch.session.snapshot',
            watchId: body.watchId,
            payload: {
              session: { id: 's' },
              runs: [{ id: 'r', sessionId: 's', status: 'RUNNING' }],
              progress: { ...progress, status: 'RUNNING', observedAt: 1 }
            }
          })
        );
        peer.send(
          watchEnvelope({
            type: 'watch.session.event',
            watchId: body.watchId,
            event: { payload: { sessionId: 's', progress } }
          })
        );
      }
      return { expiresAt: Date.now() + 60_000 };
    }
  };
  try {
    await assert.rejects(
      waitForSessionRun({ client, sessionId: 's', runId: 'r', timeoutMs: 1000 }),
      (error) => {
        assert.equal(error.code, 'MARCTL_WAIT_TIMEOUT');
        assert.deepEqual(error.progress, progress);
        return true;
      }
    );
    assert.deepEqual(modes, ['initial', 'stop']);
  } finally {
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('wait failures retain target, stage and bounded public upstream diagnostics in CLI JSON', async () => {
  const cases = [
    ['missing-run', 'snapshot'],
    ['invalid-snapshot', 'snapshot'],
    ['null-run', 'snapshot'],
    ['watch-failed', 'watch'],
    ['expired-lease', 'lease'],
    ['renew-failed', 'renew'],
    ['closed', 'connection'],
    ['socket-error', 'connection'],
    ['subscribe-denied', 'subscribe']
  ];
  for (const [scenario, stage] of cases) {
    class Socket extends EventEmitter {
      send() {
        setImmediate(() =>
          this.emit(
            'message',
            JSON.stringify({
              type: 'workbench.ready',
              workbenchConnectionId: 'connection'
            })
          )
        );
      }
      close() {
        this.closed = true;
      }
    }
    const socket = new Socket();
    const calls = [];
    const sourceError = new MarctlError('The Node is offline.', {
      code: 'NODE_OFFLINE',
      requestId: 'server-request',
      upstreamRequestId: 'node-request',
      details: 'Public diagnostic. '.repeat(300)
    });
    const client = {
      openWorkbenchWebSocket() {
        setImmediate(() => socket.emit('open'));
        return socket;
      },
      async sessionCommand(body) {
        calls.push(body);
        if (body.mode === 'renew') throw sourceError;
        if (body.mode !== 'initial') return {};
        if (scenario === 'subscribe-denied')
          throw new MarctlError('Access was revoked.', {
            code: 'RESOURCE_ACCESS_DENIED',
            statusCode: 403,
            requestId: 'denied-request'
          });
        setImmediate(() => {
          if (scenario === 'closed') {
            socket.emit('close', 1006, Buffer.from('private-close-data'));
            return;
          }
          if (scenario === 'socket-error') {
            socket.emit(
              'error',
              Object.assign(new Error('private-socket-data'), { code: 'ECONNRESET' })
            );
            return;
          }
          socket.emit(
            'message',
            watchEnvelope(
              scenario === 'watch-failed'
                ? {
                    type: 'watch.failed',
                    watchId: body.watchId,
                    code: 'NODE_OFFLINE',
                    message: 'The Node disconnected.'
                  }
                : {
                    type: 'watch.session.snapshot',
                    watchId: body.watchId,
                    payload:
                      scenario === 'invalid-snapshot'
                        ? {}
                        : {
                            session: { id: 's' },
                            progress: { runId: 'r', pendingApprovals: [] },
                            runs:
                              scenario === 'missing-run'
                                ? []
                                : scenario === 'null-run'
                                  ? [null]
                                  : [{ id: 'r', sessionId: 's', status: 'RUNNING' }]
                          },
                    expiresAt: scenario === 'expired-lease' ? 0 : Date.now() + 80
                  }
            )
          );
        });
        return {};
      }
    };
    let output = '';
    const exit = await main(
      ['agents', 'wait', 's', '--run', 'r', '--timeout', '2s', '--until', 'approval', '--json'],
      {
        env,
        client,
        stdout: { write: (value) => (output += value) }
      }
    );
    const failure = JSON.parse(output).error;
    assert.equal(exit, scenario === 'subscribe-denied' ? 3 : 6, scenario);
    assert.equal(
      failure.code,
      scenario === 'subscribe-denied' ? 'RESOURCE_ACCESS_DENIED' : 'MARCTL_WAIT_UNKNOWN'
    );
    assert.equal(failure.sessionId, 's', scenario);
    assert.equal(failure.runId, 'r', scenario);
    assert.equal(failure.stage, stage, scenario);
    if (scenario !== 'subscribe-denied')
      assert.ok(failure.details.length > 0 && failure.details.length <= 4000);
    if (scenario === 'watch-failed') {
      assert.equal(failure.upstreamCode, 'NODE_OFFLINE');
      assert.match(failure.details, /The Node disconnected/);
    }
    if (scenario === 'renew-failed') {
      assert.equal(failure.upstreamCode, 'NODE_OFFLINE');
      assert.equal(failure.requestId, 'server-request');
      assert.equal(failure.upstreamRequestId, 'node-request');
      assert.match(failure.details, /Public diagnostic/);
    }
    if (scenario === 'socket-error') assert.equal(failure.upstreamCode, 'ECONNRESET');
    if (scenario === 'subscribe-denied') assert.equal(failure.requestId, 'denied-request');
    assert.equal(socket.closed, true);
    assert.equal(calls.at(-1).mode, 'stop');
    assert.ok(calls.every((call) => call.action === 'watch'));
    assert.ok(!output.includes('private-close-data') && !output.includes('private-socket-data'));
    assert.ok(!output.includes(env.MAR_CTL_USER_TOKEN));
  }
});

test('a successful HTTP response with unreadable JSON leaves mutation outcome unknown', async () => {
  let output = '';
  let calls = 0;
  const client = new MarctlClient({
    serverUrl: 'https://server.test',
    key: 'private-fixture-token',
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: true,
        json: async () => {
          throw new SyntaxError('private invalid body');
        }
      };
    }
  });
  const code = await main(
    [
      'agents',
      'send',
      's',
      '--steer',
      '--message-file',
      '-',
      '--client-message-id',
      'retained-id',
      '--json'
    ],
    {
      env,
      stdin: (async function* () {
        yield Buffer.from('fixture message');
      })(),
      stdout: { write: (value) => (output += value) },
      client
    }
  );
  assert.equal(code, 6);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(output).error.code, 'MARCTL_OUTCOME_UNKNOWN');
  assert.equal(JSON.parse(output).error.clientMessageId, 'retained-id');
  assert.ok(!output.includes('private invalid body'));
});

test('wait performs the real Workbench handshake, renews and consumes wrapped live Run events', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  let peer;
  let terminalTimer;
  const calls = [];
  server.on('connection', (socket) => {
    peer = socket;
    socket.on('message', (raw) => {
      assert.deepEqual(JSON.parse(String(raw)), { type: 'resume' });
      socket.send(
        JSON.stringify({ type: 'workbench.ready', workbenchConnectionId: 'real-connection' })
      );
    });
  });
  const transport = new MarctlClient({
    serverUrl: 'http://127.0.0.1:' + server.address().port,
    key: 'fixture-token'
  });
  const client = {
    openWorkbenchWebSocket: () => transport.openWorkbenchWebSocket(WebSocket),
    sessionCommand: async (body) => {
      calls.push(body);
      if (body.mode === 'initial') {
        peer.send(
          watchEnvelope({
            type: 'watch.session.snapshot',
            watchId: body.watchId,
            payload: { runs: [{ id: 'r', sessionId: 's', status: 'RUNNING' }] },
            expiresAt: Date.now() + 100
          })
        );
        peer.send(
          watchEnvelope({
            type: 'watch.session.event',
            watchId: body.watchId,
            event: { payload: { run: { id: 'other', sessionId: 's', status: 'SUCCEEDED' } } }
          })
        );
        terminalTimer = setTimeout(
          () =>
            peer.send(
              watchEnvelope({
                type: 'watch.session.event',
                watchId: body.watchId,
                event: { payload: { run: { id: 'r', sessionId: 's', status: 'SUCCEEDED' } } }
              })
            ),
          150
        );
      }
      return { expiresAt: Date.now() + 1000 };
    }
  };
  try {
    assert.equal(
      (await waitForSessionRun({ client, sessionId: 's', runId: 'r', timeoutMs: 2000 })).run.id,
      'r'
    );
    assert.deepEqual(
      calls.map((call) => call.mode),
      ['initial', 'renew', 'stop']
    );
  } finally {
    clearTimeout(terminalTimer);
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('rejects non-object Session success bodies and reports missing authorization distinctly', async () => {
  for (const value of [null, []]) {
    const client = new MarctlClient({
      serverUrl: 'https://server.test',
      key: 'fixture-token',
      fetchImpl: async () => ({ ok: true, json: async () => value })
    });
    await assert.rejects(
      client.sessionCommand({ action: 'list' }),
      (error) => error.code === 'MARCTL_RESPONSE_INVALID'
    );
  }
  let output = '';
  assert.equal(
    await main(['agents', 'list', '--json'], {
      env: {},
      stdout: { write: (value) => (output += value) }
    }),
    3
  );
  assert.equal(JSON.parse(output).error.code, 'UNAUTHENTICATED');
});
