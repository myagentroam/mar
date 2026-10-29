import { activeSessionDirectory } from '../support/jsonl-session-path.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalAgentHost, type ClientToolDefinition } from '../../src/host.js';
import {
  SecretValue,
  type AgentEvent,
  type AgentModelConfiguration,
  type ToolApprovalDecision,
  type ToolApprovalHandler,
  type ToolApprovalRequest
} from '../../src/index.js';
import { createAgentWithAdapter } from '../../src/sdk/agent.js';
import { createSubagentExtension } from '../../extensions/subagent/src/index.js';
import type { Agent } from '../../src/index.js';
import type { ModelEvent, ModelRequest } from '../../src/model/contracts.js';
import { JsonlSessionStore } from '../../src/session/store/index.js';
import { startResponsesWebSocketServer } from './support/responses-transport-servers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const model: AgentModelConfiguration = {
  id: 'test',
  name: 'Test',
  protocol: 'ANTHROPIC_MESSAGES',
  baseUrl: 'https://example.test',
  apiKey: new SecretValue('test'),
  modelId: 'test',
  contextWindowTokens: 200_000,
  maxOutputTokens: 4096,
  inputCapabilities: ['TEXT'],
  outputCapabilities: ['TEXT'],
  reasoningEfforts: ['medium'],
  defaultReasoningEffort: 'medium',
  hostedWebSearch: false,
  responsesPreviousResponseId: false,
  enabled: true,
  titleGeneration: false,
  codeMode: true
};
const effect: ClientToolDefinition = {
  name: 'effect',
  description: 'A controlled test effect.',
  allowedCallers: ['direct', 'programmatic'],
  parallelSafety: 'serial',
  inputSchema: {
    type: 'object',
    properties: { target: { type: 'string' } },
    required: ['target'],
    additionalProperties: false
  }
};
const call = (id: string, args: unknown, name = 'effect'): ModelEvent => ({
  type: 'client_tool.call',
  callId: id,
  name,
  arguments: args
});
const final: ModelEvent[] = [
  { type: 'text.completed', itemId: 'answer', text: 'done' },
  { type: 'completed', reason: 'completed' }
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function fixture(
  rounds: ModelEvent[][] | ((request: ModelRequest) => readonly ModelEvent[]),
  tools: ClientToolDefinition[] = [effect],
  extensions: NonNullable<Parameters<typeof createAgentWithAdapter>[0]['extensions']> = [],
  approval?: ToolApprovalHandler,
  agentReady?: (agent: Agent) => void
) {
  const home = await mkdtemp(join(tmpdir(), 'mar-auto-'));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const requests: ModelRequest[] = [];
  const effects: unknown[] = [];
  const host = new LocalAgentHost({
    homeDirectory: home,
    workspace: home,
    ...(approval ? { approval } : {}),
    extensions: {
      tools,
      executeTool: async (input) => {
        effects.push(input.arguments);
        return { content: 'applied' };
      }
    }
  });
  const agent = await createAgentWithAdapter(
    {
      mode: 'normal',
      host,
      models: [model],
      extensions
    },
    () => ({
      configuration: model,
      async *start(request) {
        const index = requests.length;
        requests.push(request);
        for (const event of (typeof rounds === 'function' ? rounds(request) : rounds[index]) ??
          final)
          yield event;
      }
    })
  );
  cleanups.push(() => agent.dispose());
  agentReady?.(agent);
  const session = await agent.createSession({ workspace: home });
  return { agent, session, requests, effects, home };
}

async function persistedToolResult(home: string, sessionId: string, callId: string) {
  const store = await JsonlSessionStore.open(home);
  try {
    const records = await store.read(sessionId);
    const record = records.find(
      (entry) =>
        entry.type === 'model.context' &&
        (entry.payload as { role?: string; callId?: string }).role === 'tool' &&
        (entry.payload as { callId?: string }).callId === callId
    );
    expect(record).toBeDefined();
    return record!.payload;
  } finally {
    await store.close();
  }
}

describe('Auto execution and ordinary-message continuation', () => {
  it.each([
    { permissionMode: 'auto', codeMode: false, hostedWebSearch: true, transport: 'HTTP' },
    { permissionMode: 'auto', codeMode: true, hostedWebSearch: true, transport: 'HTTP' },
    { permissionMode: 'auto', codeMode: true, hostedWebSearch: true, transport: 'WEBSOCKET' },
    { permissionMode: 'full-access', codeMode: true, hostedWebSearch: true, transport: 'HTTP' },
    { permissionMode: 'auto', codeMode: true, hostedWebSearch: false, transport: 'HTTP' }
  ] as const)(
    'preserves hosted search without client permission ($permissionMode, codeMode=$codeMode, hosted=$hostedWebSearch, $transport)',
    async ({ permissionMode, codeMode, hostedWebSearch, transport }) => {
      const search = {
        id: 'search-1',
        type: 'web_search_call',
        status: 'completed',
        action: { type: 'search', query: 'official documentation' }
      };
      const responseEvents = [
        { type: 'response.created', response: { id: 'response-1' } },
        ...(hostedWebSearch ? [{ type: 'response.output_item.done', item: search }] : []),
        {
          type: 'response.output_item.done',
          item: {
            id: 'answer-1',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'done' }]
          }
        },
        { type: 'response.completed', response: { id: 'response-1' } }
      ];
      let baseUrl: string;
      let requests: unknown[];
      if (transport === 'WEBSOCKET') {
        const fixture = await startResponsesWebSocketServer(responseEvents);
        baseUrl = fixture.baseUrl;
        requests = fixture.requests;
        cleanups.push(() => new Promise<void>((resolve) => fixture.server.close(() => resolve())));
      } else {
        requests = [];
        const server = createServer((request, response) => {
          let body = '';
          request.setEncoding('utf8');
          request.on('data', (chunk) => (body += chunk));
          request.on('end', () => {
            requests.push(JSON.parse(body));
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            response.end(
              responseEvents.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join('')
            );
          });
        });
        cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (address === null || typeof address === 'string') throw new Error('server unavailable');
        baseUrl = 'http://127.0.0.1:' + address.port;
      }
      const home = await mkdtemp(join(tmpdir(), 'mar-auto-hosted-search-'));
      cleanups.push(() => rm(home, { recursive: true, force: true }));
      const approval = vi.fn<ToolApprovalHandler>();
      const executeTool = vi.fn(async () => ({ content: 'unexpected client tool' }));
      const agent = await createAgentWithAdapter({
        mode: 'normal',
        host: new LocalAgentHost({
          homeDirectory: home,
          workspace: home,
          approval,
          extensions: { tools: [effect], executeTool }
        }),
        models: [
          {
            ...model,
            protocol: 'OPENAI_RESPONSES',
            baseUrl,
            codeMode,
            hostedWebSearch,
            responsesTransport:
              transport === 'HTTP' ? { transport, httpVersion: '1.1' } : { transport },
            responsesToolNamespace: 'mar'
          }
        ]
      });
      cleanups.push(() => agent.dispose());
      const session = await agent.createSession({ workspace: home, title: 'Hosted search' });
      const run = session.run({ prompt: 'Search the official documentation.', permissionMode });
      const events: AgentEvent[] = [];
      for await (const event of run) events.push(event);
      expect(await run.result()).toMatchObject({ status: 'completed', finalAnswer: 'done' });
      expect(requests).toHaveLength(1);
      const request = requests[0] as { tools: Array<Record<string, unknown>>; include: string[] };
      expect(request.tools).toContainEqual(
        expect.objectContaining({ type: 'namespace', name: 'mar' })
      );
      expect(request.tools.filter((tool) => tool.type === 'web_search')).toEqual(
        hostedWebSearch ? [{ type: 'web_search' }] : []
      );
      expect(request.include.includes('web_search_call.action.sources')).toBe(hostedWebSearch);
      expect(
        events.filter((event) => event.type === 'tool.completed' && event.toolName === 'web_search')
      ).toHaveLength(hostedWebSearch ? 1 : 0);
      expect(approval).not.toHaveBeenCalled();
      expect(executeTool).not.toHaveBeenCalled();
    }
  );

  it('inherits Auto in a child and exposes its stop in terminal events and wait snapshots', async () => {
    let parentRound = 0;
    let agent!: Agent;
    const f = await fixture(
      (request) => {
        if (
          request.messages.some(
            (message) =>
              message.role === 'user' &&
              message.content.includes(
                'Inspect shared target; the real user has not authorized writes.'
              )
          )
        ) {
          expect(request.allowHostedTools).not.toBe(false);
          return [
            call('child-stop', {
              target: 'shared',
              permission: { action: 'ask', reason: 'Confirm shared target.' }
            }),
            { type: 'completed', reason: 'tool_use' }
          ];
        }
        const index = parentRound++;
        if (index === 0)
          return [
            call(
              'start-child',
              {
                prompt: 'Inspect shared target; the real user has not authorized writes.',
                title: 'Inspect target',
                description: 'Inspect target',
                modelId: 'test',
                reasoningEffort: 'medium',
                role: 'general-purpose'
              },
              'agent_start'
            ),
            { type: 'completed', reason: 'tool_use' }
          ];
        if (index === 1)
          return [
            call('wait-child', { waitMs: 10000 }, 'agent_wait'),
            { type: 'completed', reason: 'tool_use' }
          ];
        return final;
      },
      [effect],
      [createSubagentExtension({ agent: () => agent })],
      undefined,
      (created) => {
        agent = created;
      }
    );
    await f.agent.reconfigureModels({
      models: [{ ...model, conversationModel: true, subagentModel: true }]
    });
    const events = [];
    const run = f.session.run({
      prompt: 'Inspect, do not authorize writes.',
      permissionMode: 'auto'
    });
    for await (const event of run) events.push(event);
    expect(await run.result()).toMatchObject({ status: 'completed' });
    expect(f.effects).toEqual([]);
    const start = events.find(
      (event) => event.type === 'tool.completed' && event.toolName === 'agent_start'
    );
    const wait = events.find(
      (event) => event.type === 'tool.completed' && event.toolName === 'agent_wait'
    );
    if (start?.type !== 'tool.completed' || wait?.type !== 'tool.completed')
      throw new Error(
        `Missing child receipts: ${JSON.stringify(events.filter((event) => event.type === 'tool.failed'))}`
      );
    expect(JSON.parse(wait.summary)).toMatchObject({ permissionStop: { action: 'ask' } });
    const childId = (JSON.parse(start.summary) as { agentId: string }).agentId;
    const childHistory = await f.agent.sessionHistory(childId);
    expect(childHistory.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'event',
          event: expect.objectContaining({
            type: 'execution.started',
            permissionMode: 'auto'
          })
        }),
        expect.objectContaining({
          kind: 'event',
          event: expect.objectContaining({
            type: 'execution.completed',
            permissionStop: expect.objectContaining({ action: 'ask' })
          })
        })
      ])
    );
  });
  it('asks on the outer Code Mode call and normally runs its nested calls after ordinary allow', async () => {
    const code =
      'observe.result(await tools.effect({target:"shared"})); observe.result(await tools.effect({target:"shared"}));';
    const f = await fixture([
      [
        call(
          'outer-ask',
          { code, permission: { action: 'ask', reason: 'Confirm this Code Mode call.' } },
          'code_exec'
        ),
        { type: 'completed', reason: 'tool_use' }
      ],
      [call('outer-new', { code }, 'code_exec'), { type: 'completed', reason: 'tool_use' }],
      final
    ]);
    expect(
      await f.session.run({ prompt: 'Update with Code Mode.', permissionMode: 'auto' }).result()
    ).toMatchObject({
      permissionStop: { action: 'ask', source: { toolName: 'code_exec', callId: 'outer-ask' } }
    });
    expect(f.effects).toEqual([]);
    expect(await f.session.run({ prompt: 'allow', permissionMode: 'auto' }).result()).toMatchObject(
      { status: 'completed', finalAnswer: 'done' }
    );
    expect(f.effects).toEqual([{ target: 'shared' }, { target: 'shared' }]);
    expect(JSON.stringify(f.requests[0]!.messages)).toContain(
      'prefer ask or deny on the OUTER code_exec'
    );
  });

  it('waits for host approval without effects or extra model requests, then runs the original call once', async () => {
    const approvalRequest = deferred<{ request: ToolApprovalRequest; signal: AbortSignal }>();
    const decision = deferred<ToolApprovalDecision>();
    let approvalCalls = 0;
    const f = await fixture(
      [
        [
          call('approved-call', {
            target: 'shared',
            permission: { action: 'ask', reason: 'Confirm shared target.' }
          }),
          { type: 'completed', reason: 'tool_use' }
        ],
        final
      ],
      [effect],
      [],
      (request, signal) => {
        approvalCalls++;
        approvalRequest.resolve({ request, signal });
        return decision.promise;
      }
    );

    const handle = f.session.run({ prompt: 'update shared', permissionMode: 'auto' });
    const result = handle.result();
    const { request, signal } = await approvalRequest.promise;
    expect(request).toMatchObject({
      reason: 'Confirm shared target.',
      source: { sessionId: f.session.id, callId: 'approved-call', toolName: 'effect' },
      input: { target: 'shared' }
    });
    expect(signal.aborted).toBe(false);
    expect(approvalCalls).toBe(1);
    expect(f.effects).toEqual([]);
    expect(f.requests).toHaveLength(1);

    decision.resolve('APPROVED');
    expect(await result).toMatchObject({ status: 'completed', finalAnswer: 'done' });
    expect(f.effects).toEqual([{ target: 'shared' }]);
    expect(f.requests).toHaveLength(2);
  });

  it('continues with the next model round after approval rejection', async () => {
    const f = await fixture(
      [
        [
          call('rejected-call', {
            target: 'blocked',
            permission: { action: 'ask', reason: 'Confirm blocked target.' }
          }),
          { type: 'completed', reason: 'tool_use' }
        ],
        [call('later-call', { target: 'later' }), { type: 'completed', reason: 'tool_use' }],
        final
      ],
      [effect],
      [],
      async () => 'REJECTED'
    );

    const events: AgentEvent[] = [];
    const handle = f.session.run({ prompt: 'work', permissionMode: 'auto' });
    for await (const event of handle) events.push(event);
    const result = await handle.result();
    expect(result).toMatchObject({ status: 'completed', finalAnswer: 'done' });
    expect(result.permissionStop).toBeUndefined();
    expect(f.effects).toEqual([{ target: 'later' }]);
    expect(f.requests).toHaveLength(3);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool.failed',
        toolName: 'effect',
        callId: 'rejected-call',
        code: 'MAR_AGENT_APPROVAL_REJECTED'
      })
    );
  });

  it('rejects a late approval after expiry without executing that call and continues the run', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const approvalRequest = deferred<{ request: ToolApprovalRequest; signal: AbortSignal }>();
    const decision = deferred<ToolApprovalDecision>();
    const f = await fixture(
      [
        [
          call('expired-call', {
            target: 'too-late',
            permission: { action: 'ask', reason: 'Confirm target.' }
          }),
          { type: 'completed', reason: 'tool_use' }
        ],
        [call('later-call', { target: 'later' }), { type: 'completed', reason: 'tool_use' }],
        final
      ],
      [effect],
      [],
      (request, signal) => {
        approvalRequest.resolve({ request, signal });
        return decision.promise;
      }
    );

    const handle = f.session.run({ prompt: 'work', permissionMode: 'auto' });
    const result = handle.result();
    const { request, signal } = await approvalRequest.promise;
    vi.setSystemTime(request.expiresAt);
    expect(signal.aborted).toBe(false);
    decision.resolve('APPROVED');

    expect(await result).toMatchObject({ status: 'completed', finalAnswer: 'done' });
    expect(f.effects).toEqual([{ target: 'later' }]);
    expect(f.requests).toHaveLength(3);
  });

  it('returns an inner Code Mode approval rejection as failure data and lets JavaScript continue', async () => {
    const code =
      'const r=await tools.effect({target:"blocked",permission:{action:"ask",reason:"Confirm target."}}); if(r.data.error!=="MAR_AGENT_APPROVAL_REJECTED" || !r.data.message) throw new Error("Missing rejection result"); await tools.effect({target:"later"});';
    const f = await fixture(
      [[call('cell', { code }, 'code_exec'), { type: 'completed', reason: 'tool_use' }], final],
      [effect],
      [],
      async () => 'REJECTED'
    );

    const result = await f.session.run({ prompt: 'work', permissionMode: 'auto' }).result();
    expect(result).toMatchObject({ status: 'completed', finalAnswer: 'done' });
    expect(result.permissionStop).toBeUndefined();
    expect(f.effects).toEqual([{ target: 'later' }]);
    expect(f.requests).toHaveLength(2);
  });

  it('does not execute a call when approval arrives after execution cancellation', async () => {
    const approvalRequest = deferred<{ request: ToolApprovalRequest; signal: AbortSignal }>();
    const decision = deferred<ToolApprovalDecision>();
    const f = await fixture(
      [
        [
          call('cancelled-call', {
            target: 'shared',
            permission: { action: 'ask', reason: 'Confirm shared target.' }
          }),
          { type: 'completed', reason: 'tool_use' }
        ],
        final
      ],
      [effect],
      [],
      (request, signal) => {
        approvalRequest.resolve({ request, signal });
        return decision.promise;
      }
    );

    const handle = f.session.run({ prompt: 'update shared', permissionMode: 'auto' });
    const result = handle.result();
    const { signal } = await approvalRequest.promise;
    expect(f.effects).toEqual([]);
    expect(f.requests).toHaveLength(1);

    handle.cancel();
    expect(await result).toMatchObject({ status: 'cancelled' });
    expect(signal.aborted).toBe(true);
    decision.resolve('APPROVED');
    await Promise.resolve();
    await Promise.resolve();
    expect(f.effects).toEqual([]);
    expect(f.requests).toHaveLength(1);
  });

  it('keeps actual scoped user authorization available after Compact and reopening', async () => {
    const authorization =
      'I authorize updating target shared in this bounded task; do not touch production.';
    const summary = [
      {
        type: 'text.completed',
        itemId: 'handoff',
        text: 'Continue the bounded shared-target task. Preserve the original user authorization and production prohibition.'
      },
      { type: 'completed', reason: 'completed' }
    ] as ModelEvent[];
    const f = await fixture([
      final,
      summary,
      [call('resumed-call', { target: 'shared' }), { type: 'completed', reason: 'tool_use' }],
      final
    ]);
    await f.session.run({ prompt: authorization, permissionMode: 'auto' }).result();
    expect(await f.session.compact().result()).toMatchObject({ status: 'completed' });
    const resumed = await f.agent.openSession(f.session.id);
    expect(
      await resumed
        .run({ prompt: 'Continue the same authorized work.', permissionMode: 'auto' })
        .result()
    ).toMatchObject({ status: 'completed', finalAnswer: 'done' });
    expect(f.effects).toEqual([{ target: 'shared' }]);
    expect(
      f.requests[2]!.messages.some(
        (message) => message.role === 'user' && message.content === authorization
      )
    ).toBe(true);
    expect(f.requests[2]!.system + JSON.stringify(f.requests[2]!.messages)).toContain(
      'Reuse actual user authorization'
    );
  });

  it('preserves parameterless calls in the Auto Code Mode catalog', async () => {
    const parameterless = {
      ...effect,
      name: 'ping',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    };
    const f = await fixture(
      [
        [
          call('cell', { code: 'observe.result(await tools.ping());' }, 'code_exec'),
          { type: 'completed', reason: 'tool_use' }
        ],
        final
      ],
      [parameterless]
    );
    expect(await f.session.run({ prompt: 'ping', permissionMode: 'auto' }).result()).toMatchObject({
      status: 'completed',
      finalAnswer: 'done'
    });
    expect(f.effects).toEqual([{}]);
  });
  it('keeps ask without an approval handler as a stop without effects or extra model requests', async () => {
    let hookCalls = 0;
    const f = await fixture(
      [
        [
          call('blocked', {
            target: 'shared',
            permission: { action: 'ask', reason: 'Confirm this shared target.' }
          }),
          call('skipped', { target: 'later' }),
          { type: 'completed', reason: 'tool_use' }
        ]
      ],
      [effect],
      [
        {
          id: 'permission-hook',
          apiVersion: '1.0',
          failurePolicy: 'fail-composition',
          attachSession(context) {
            context.hooks.intercept('tool.invoke', (input, _call, next) => {
              hookCalls++;
              return next(input);
            });
          }
        }
      ]
    );
    const result = await f.session.run({ prompt: 'work', permissionMode: 'auto' }).result();
    expect(result.errorMessage).toBeUndefined();
    expect(result).toMatchObject({
      status: 'completed',
      finalAnswer: '',
      permissionStop: { action: 'ask', source: { callId: 'blocked', toolName: 'effect' } }
    });
    expect(hookCalls).toBe(0);
    expect(f.effects).toEqual([]);
    expect(f.requests).toHaveLength(1);
    const records = (
      await readFile(
        join(await activeSessionDirectory(f.home, f.session.id), 'events-000001.jsonl'),
        'utf8'
      )
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(
      records.some((record) =>
        JSON.stringify(record).includes('MAR_AGENT_TOOL_SKIPPED_PERMISSION_STOP')
      )
    ).toBe(true);
    expect(
      records.some(
        (record) =>
          record.payload?.type === 'execution.completed' &&
          record.payload.permissionStop?.action === 'ask'
      )
    ).toBe(true);
  });

  it('only a newly generated call runs after an ordinary allow message', async () => {
    const f = await fixture([
      [
        call('blocked', {
          target: 'shared',
          permission: { action: 'ask', reason: 'Confirm shared target.' }
        }),
        { type: 'completed', reason: 'tool_use' }
      ],
      [
        call('new-call', { target: 'shared', permission: null }),
        { type: 'completed', reason: 'tool_use' }
      ],
      final
    ]);
    await f.session.run({ prompt: 'inspect shared target', permissionMode: 'auto' }).result();
    expect(f.effects).toEqual([]);
    expect(await f.session.run({ prompt: 'allow', permissionMode: 'auto' }).result()).toMatchObject(
      { status: 'completed', finalAnswer: 'done' }
    );
    expect(f.effects).toEqual([{ target: 'shared' }]);
    expect(f.requests[1]!.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'tool', callId: 'blocked', isError: true }),
        expect.objectContaining({ role: 'user', content: 'allow' })
      ])
    );
    expect(f.requests[1]!.system + JSON.stringify(f.requests[1]!.messages)).toContain(
      'Reuse actual user authorization'
    );
  });

  it('does not replay a blocked operation when the new model response has no tool', async () => {
    const f = await fixture([
      [
        call('blocked', {
          target: 'shared',
          permission: { action: 'ask', reason: 'Confirm shared target.' }
        }),
        { type: 'completed', reason: 'tool_use' }
      ],
      final
    ]);
    await f.session.run({ prompt: 'work', permissionMode: 'auto' }).result();
    await f.session.run({ prompt: 'allow', permissionMode: 'auto' }).result();
    expect(f.effects).toEqual([]);
  });

  it('stops a Code Mode cell even when guest JavaScript catches the tool failure', async () => {
    const code =
      'try { await tools.effect({target:"shared",permission:{action:"ask",reason:"Confirm shared target."}}); } catch {} await tools.effect({target:"later"});';
    const f = await fixture([
      [call('cell', { code }, 'code_exec'), { type: 'completed', reason: 'tool_use' }]
    ]);
    const result = await f.session.run({ prompt: 'work', permissionMode: 'auto' }).result();
    expect(result).toMatchObject({
      status: 'completed',
      permissionStop: { action: 'ask', source: { toolName: 'effect', parentCallId: 'cell' } }
    });
    expect(f.effects).toEqual([]);
    expect(f.requests).toHaveLength(1);
  });

  it('returns nested deny as failure data without catch, keeps audit failed and commits cell state', async () => {
    const code =
      'const r = await tools.effect({target:"blocked",permission:{action:"deny",reason:"Explicit prohibition."}}); if(r.data.error!=="MAR_AGENT_PERMISSION_DENIED" || !r.data.message) throw new Error("Missing denial result"); observe.result(r); await tools.effect({target:"later"}); state.set("continued",true);';
    const f = await fixture([
      [call('cell', { code }, 'code_exec'), { type: 'completed', reason: 'tool_use' }],
      [
        call(
          'verify-state',
          {
            code: 'if(state.get("continued")!==true) throw new Error("State not committed"); await tools.effect({target:"next-cell"});'
          },
          'code_exec'
        ),
        { type: 'completed', reason: 'tool_use' }
      ],
      final
    ]);
    const events: AgentEvent[] = [];
    const handle = f.session.run({ prompt: 'work', permissionMode: 'auto' });
    for await (const event of handle) events.push(event);
    const result = await handle.result();
    expect(result).toMatchObject({ status: 'completed', finalAnswer: 'done' });
    expect(result.permissionStop).toBeUndefined();
    expect(f.effects).toEqual([{ target: 'later' }, { target: 'next-cell' }]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool.failed',
        toolName: 'effect',
        parentCallId: 'cell',
        code: 'MAR_AGENT_PERMISSION_DENIED',
        permissionStop: expect.objectContaining({ action: 'deny' })
      })
    );
    const completed = events.find(
      (event) => event.type === 'tool.completed' && event.callId === 'cell'
    );
    expect(completed).toMatchObject({
      type: 'tool.completed',
      data: { status: 'completed' }
    });
    // The durable logical result retains the audit; the adapter sees only model input.
    expect(await persistedToolResult(f.home, f.session.id, 'cell')).toMatchObject({
      calls: expect.arrayContaining([
        expect.objectContaining({
          toolName: 'effect',
          status: 'failed',
          error: expect.objectContaining({ code: 'MAR_AGENT_PERMISSION_DENIED' })
        })
      ])
    });
    const modelMessage = f.requests[1]!.messages.find((message) => message.role === 'tool')!;
    expect(modelMessage).not.toHaveProperty('calls');
    expect(modelMessage.contentParts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('MAR_AGENT_PERMISSION_DENIED')
        })
      ])
    );
    expect(JSON.parse(modelMessage.content)).toMatchObject({
      observations: expect.arrayContaining([
        expect.objectContaining({ toolName: 'effect', outcome: 'failed' })
      ])
    });
    expect(completed).not.toHaveProperty('permissionStop');
    expect(completed).not.toHaveProperty('data.permissionStop');
  });

  it('does not poison sibling calls when a parallel Code Mode call is denied', async () => {
    const code =
      'const [denied] = await Promise.all([tools.effect({target:"blocked",permission:{action:"deny",reason:"Explicit prohibition."}}),tools.effect({target:"sibling"})]); if(denied.data.error!=="MAR_AGENT_PERMISSION_DENIED") throw new Error("Missing denial result"); await tools.effect({target:"after"});';
    const f = await fixture([
      [call('cell', { code }, 'code_exec'), { type: 'completed', reason: 'tool_use' }],
      final
    ]);
    const result = await f.session.run({ prompt: 'work', permissionMode: 'auto' }).result();
    expect(result).toMatchObject({ status: 'completed', finalAnswer: 'done' });
    expect(result.permissionStop).toBeUndefined();
    expect(f.effects).toEqual([{ target: 'sibling' }, { target: 'after' }]);
  });

  it('continues after a direct deny and executes a later model-generated call', async () => {
    const f = await fixture([
      [
        call('direct-deny', {
          target: 'blocked',
          permission: { action: 'deny', reason: 'Explicit prohibition.' }
        }),
        { type: 'completed', reason: 'tool_use' }
      ],
      [call('later', { target: 'after-deny' }), { type: 'completed', reason: 'tool_use' }],
      final
    ]);

    const events: AgentEvent[] = [];
    const handle = f.session.run({ prompt: 'work', permissionMode: 'auto' });
    for await (const event of handle) events.push(event);
    const result = await handle.result();
    expect(result).toMatchObject({ status: 'completed', finalAnswer: 'done' });
    expect(result.permissionStop).toBeUndefined();
    expect(f.effects).toEqual([{ target: 'after-deny' }]);
    expect(f.requests).toHaveLength(3);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool.failed',
        toolName: 'effect',
        callId: 'direct-deny',
        code: 'MAR_AGENT_PERMISSION_DENIED'
      })
    );
  });

  it.each([
    ['deny', true],
    ['ask', true],
    ['deny', false],
    ['ask', false]
  ] as const)('preserves native facade %s semantics (Code Mode: %s)', async (action, codeMode) => {
    const code =
      'const r = await tools.forwarded_effect({}); if(r.data.error!=="MAR_AGENT_PERMISSION_DENIED") throw new Error("Missing denial result"); await tools.effect({target:"after-native"});';
    const f = await fixture(
      [
        [
          codeMode ? call('cell', { code }, 'code_exec') : call('native', {}, 'forwarded_effect'),
          { type: 'completed', reason: 'tool_use' }
        ],
        final
      ],
      [effect],
      [
        {
          id: 'native-denial',
          apiVersion: '1.0',
          failurePolicy: 'fail-composition',
          attachSession(context) {
            context.tools.register({
              name: 'forwarded_effect',
              description: 'Forward a tool invocation.',
              inputSchema: { type: 'object', properties: {}, additionalProperties: false },
              allowedCallers: ['direct', 'programmatic'],
              execute: () =>
                context.tools.invoke({
                  name: 'effect',
                  arguments: { target: 'blocked' },
                  permission: { action, reason: 'Explicit decision.' }
                })
            });
          }
        }
      ]
    );
    const result = await f.session.run({ prompt: 'work', permissionMode: 'auto' }).result();
    if (action === 'deny') {
      expect(result).toMatchObject({ status: 'completed', finalAnswer: 'done' });
      expect(result.permissionStop).toBeUndefined();
      expect(f.effects).toEqual(codeMode ? [{ target: 'after-native' }] : []);
      expect(f.requests).toHaveLength(2);
      if (codeMode) {
        const message = f.requests[1]!.messages.find((message) => message.role === 'tool')!;
        expect(await persistedToolResult(f.home, f.session.id, 'cell')).toMatchObject({
          calls: expect.arrayContaining([
            expect.objectContaining({ toolName: 'forwarded_effect', status: 'failed' }),
            expect.objectContaining({ toolName: 'effect', status: 'completed' })
          ])
        });
        expect(message).not.toHaveProperty('calls');
        expect(message.contentParts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: 'text', text: expect.stringContaining('completed') })
          ])
        );
      } else {
        expect(f.requests[1]!.messages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ role: 'tool', callId: 'native', isError: true })
          ])
        );
      }
    } else {
      expect(result).toMatchObject({ status: 'completed', finalAnswer: '' });
      expect(result.permissionStop).toMatchObject({
        action,
        source: { toolName: 'effect', ...(codeMode ? { parentCallId: 'cell' } : {}) }
      });
      expect(f.effects).toEqual([]);
      expect(f.requests).toHaveLength(1);
    }
  });

  it('keeps an outer Code Mode deny effect-free while later model calls can proceed', async () => {
    const f = await fixture([
      [
        call(
          'cell',
          {
            code: 'await tools.effect({target:"blocked"});',
            permission: { action: 'deny', reason: 'Explicit prohibition.' }
          },
          'code_exec'
        ),
        { type: 'completed', reason: 'tool_use' }
      ],
      [call('later', { target: 'after-deny' }), { type: 'completed', reason: 'tool_use' }],
      final
    ]);
    const result = await f.session.run({ prompt: 'work', permissionMode: 'auto' }).result();
    expect(result).toMatchObject({ status: 'completed', finalAnswer: 'done' });
    expect(result.permissionStop).toBeUndefined();
    expect(f.effects).toEqual([{ target: 'after-deny' }]);
    expect(f.requests).toHaveLength(3);
  });

  it('unwraps business permission once and preserves the SDK Full access default', async () => {
    const business = {
      ...effect,
      inputSchema: {
        type: 'object',
        properties: { permission: { type: 'string' } },
        required: ['permission'],
        additionalProperties: false
      }
    };
    const f = await fixture(
      [
        [
          call('business', { input: { permission: 'reader' }, permission: null }),
          { type: 'completed', reason: 'tool_use' }
        ],
        final,
        [call('plain', { permission: 'writer' }), { type: 'completed', reason: 'tool_use' }],
        final
      ],
      [business]
    );
    await f.session.run({ prompt: 'read', permissionMode: 'auto' }).result();
    await f.session.run({ prompt: 'write' }).result();
    expect(f.effects).toEqual([{ permission: 'reader' }, { permission: 'writer' }]);
    expect(f.requests[0]!.allowHostedTools).toBeUndefined();
    expect(f.requests[2]!.allowHostedTools).toBeUndefined();
  });
});
