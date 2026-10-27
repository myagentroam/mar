import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../src/runtime/events.js';
import type { ModelEvent, ModelRequest } from '../../src/model/contracts.js';
import type { ExtensionAgentsApi } from '../../src/extensions.js';
import type {
  ToolCall,
  ToolExecutionContext,
  ToolExecutionResult
} from '../../src/tools/contracts.js';
import { effectiveInstructions, latestUserText } from './support/model-context.js';
import { JsonlSessionStore } from '../../src/session/store/index.js';
import {
  fixture as sdkFixture,
  answer,
  cleanupCoreFixtures
} from './support/core-extension-fixture.js';

const childPrompt = 'Inspect the child task marker and report progress.';
const releases = new Set<() => void>();

function deferred() {
  let resolvePromise!: () => void;
  let settled = false;
  const promise = new Promise<void>((resolve) => (resolvePromise = resolve));
  const resolve = () => {
    if (settled) return;
    settled = true;
    resolvePromise();
  };
  releases.add(resolve);
  return { promise, resolve };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const release of releases) release();
  releases.clear();
  await cleanupCoreFixtures();
});

type ToolHandler = (call: ToolCall, context: ToolExecutionContext) => Promise<ToolExecutionResult>;

function toolCall(name: string, callId: string, arguments_: unknown = {}): ModelEvent {
  return { type: 'client_tool.call', name, callId, arguments: arguments_ };
}

function modelTool(name: string) {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    allowedCallers: ['direct'] as const,
    agentScope: 'ROOT_AND_SUBAGENTS' as const,
    parallelSafety: 'serial' as const
  };
}

async function sdkFixtureWithTools(
  script: (request: ModelRequest) => ModelEvent[],
  handlers: Readonly<Record<string, ToolHandler>>,
  extensions: readonly {
    id: string;
    attachSession(context: { agents?: ExtensionAgentsApi }): void;
  }[] = []
) {
  const f = await sdkFixture(
    extensions.map((extension) => ({
      id: extension.id,
      apiVersion: '1.0',
      attachSession: extension.attachSession
    })),
    (request) => script(request),
    false,
    true,
    {
      extensions: {
        tools: Object.keys(handlers).map(modelTool),
        executeTool: async (call, context) => {
          const handler = handlers[call.name];
          if (!handler) throw new Error('Unexpected test tool: ' + call.name);
          return handler(call, context);
        }
      }
    }
  );
  return f;
}

function childRequest(request: ModelRequest) {
  return effectiveInstructions(request).includes('non-recursive subagent');
}

function updates(request: ModelRequest) {
  return request.messages.filter(
    (message) => message.role === 'user' && message.content.includes('<mar_subagent_update')
  );
}

function observeHost(
  host: { emit(event: AgentEvent): Promise<void> | void },
  listener: (event: AgentEvent) => void | Promise<void>
) {
  const emit = host.emit.bind(host);
  host.emit = async (event) => {
    await emit(event);
    await listener(event);
  };
}

function finalAnswer(text: string): ModelEvent[] {
  return [
    { type: 'text.completed', itemId: 'parent-answer', text },
    { type: 'completed', reason: 'completed' }
  ];
}

describe('subagent automatic context injection through the SDK', () => {
  it.each(['agent_start', 'Extension API'] as const)(
    'delivers running messages and terminal updates after complete tool batches for %s children',
    async (creation) => {
      const commentaryEntered = deferred();
      const commentaryRelease = deferred();
      const finalEntered = deferred();
      const finalRelease = deferred();
      const childCompleted = deferred();
      let api: ExtensionAgentsApi | undefined;
      let childRounds = 0;
      let parentRounds = 0;
      const parentRequests: ModelRequest[] = [];
      let commentaryRequest: ModelRequest | undefined;
      let finalPhaseRequest: ModelRequest | undefined;
      let terminalRequest: ModelRequest | undefined;
      let reopenedRequest: ModelRequest | undefined;

      const handlers: Record<string, ToolHandler> = {
        'wait-child-commentary': async () => {
          await commentaryEntered.promise;
          return { content: 'Child commentary is now observable.' };
        },
        'hold-commentary': async () => {
          commentaryEntered.resolve();
          await commentaryRelease.promise;
          return { content: 'Continue after commentary.' };
        },
        'release-commentary': async () => {
          commentaryRelease.resolve();
          await finalEntered.promise;
          return { content: 'The child has published its final-phase message.' };
        },
        'hold-final': async () => {
          finalEntered.resolve();
          await finalRelease.promise;
          return { content: 'Continue after final-phase message.' };
        },
        'finish-child': async () => {
          finalRelease.resolve();
          await childCompleted.promise;
          return { content: 'The child is terminal.' };
        },
        'native-spawn': async () => {
          if (!api) throw new Error('The Extension API was not attached.');
          await api.spawn({
            prompt: childPrompt,
            description: 'SDK injection child',
            role: 'explore',
            background: true
          });
          await commentaryEntered.promise;
          return { content: 'Native child reached its commentary gate.' };
        }
      };
      const f = await sdkFixtureWithTools(
        (request) => {
          if (childRequest(request)) {
            childRounds++;
            if (childRounds === 1)
              return [
                {
                  type: 'text.completed',
                  itemId: 'child-commentary',
                  phase: 'commentary',
                  text: 'The child found a useful boundary.'
                },
                toolCall('hold-commentary', 'hold-commentary'),
                { type: 'completed', reason: 'tool_use' }
              ];
            if (childRounds === 2)
              return [
                {
                  type: 'text.completed',
                  itemId: 'child-final-phase',
                  phase: 'final_answer',
                  text: 'This is a final-phase message, but the task still runs.'
                },
                toolCall('hold-final', 'hold-final'),
                { type: 'completed', reason: 'tool_use' }
              ];
            return answer();
          }

          parentRequests.push(request);
          if (parentRounds++ === 0)
            return creation === 'agent_start'
              ? [
                  toolCall('agent_start', 'start-child', {
                    description: 'SDK injection child',
                    prompt: childPrompt,
                    role: 'explore'
                  }),
                  toolCall('wait-child-commentary', 'wait-commentary'),
                  { type: 'completed', reason: 'tool_use' }
                ]
              : [
                  toolCall('native-spawn', 'spawn-native'),
                  { type: 'completed', reason: 'tool_use' }
                ];

          const current = updates(request).at(-1);
          if (!current) return answer();
          if (latestUserText(request) === 'reopen committed history') {
            reopenedRequest = request;
            return answer();
          }
          if (current.content.includes('status="completed"')) {
            terminalRequest = request;
            return answer();
          }
          if (current.content.includes('phase="final_answer"')) {
            finalPhaseRequest = request;
            return [
              toolCall('finish-child', 'finish-child'),
              { type: 'completed', reason: 'tool_use' }
            ];
          }
          if (current.content.includes('phase="commentary"')) {
            commentaryRequest = request;
            return [
              toolCall('release-commentary', 'release-commentary'),
              { type: 'completed', reason: 'tool_use' }
            ];
          }
          return answer();
        },
        handlers,
        [
          {
            id: 'subagent-auto-injection-test',
            attachSession(context) {
              api = context.agents;
            }
          }
        ]
      );
      observeHost(f.host, (event) => {
        if (event.type === 'subagent.completed') childCompleted.resolve();
      });

      const result = await f.session.run({ prompt: 'coordinate automatic child updates' }).result();
      expect(result.status).toBe('completed');
      expect(commentaryRequest).toBeDefined();
      expect(finalPhaseRequest).toBeDefined();
      expect(terminalRequest).toBeDefined();
      if (!commentaryRequest || !finalPhaseRequest || !terminalRequest)
        throw new Error('The model did not receive all expected automatic updates.');

      const firstUpdate = updates(commentaryRequest);
      expect(firstUpdate).toHaveLength(1);
      expect(firstUpdate[0]).toMatchObject({ role: 'user', contextKind: 'contextual' });
      expect(firstUpdate[0]?.content).toContain('status="running"');
      expect(firstUpdate[0]?.content).toContain('phase="commentary"');
      expect(firstUpdate[0]?.content).toContain('The child found a useful boundary.');
      const updateIndex = commentaryRequest.messages.indexOf(firstUpdate[0]!);
      const toolIndexes = commentaryRequest.messages
        .map((message, index) => (message.role === 'tool' ? index : -1))
        .filter((index) => index >= 0);
      expect(toolIndexes.length).toBeGreaterThan(0);
      expect(Math.max(...toolIndexes)).toBeLessThan(updateIndex);
      expect(
        commentaryRequest.messages.some(
          (message) =>
            message.role === 'user' &&
            message.contextKind === undefined &&
            message.content.includes('<mar_subagent_update')
        )
      ).toBe(false);

      const finalPhaseUpdate = updates(finalPhaseRequest).at(-1);
      expect(finalPhaseUpdate?.content).toContain('status="running"');
      expect(finalPhaseUpdate?.content).toContain('phase="final_answer"');
      expect(terminalRequest.messages.at(-1)?.content).toContain('status="completed"');

      const store = await JsonlSessionStore.open(f.home);
      const records = await store.read(f.session.id);
      const committed = records.filter(
        (record) =>
          record.type === 'model.context' &&
          JSON.stringify(record.payload).includes('<mar_subagent_update')
      );
      expect(committed).toHaveLength(3);
      expect(
        committed.every((record) =>
          JSON.stringify(record.payload).includes('"contextKind":"contextual"')
        )
      ).toBe(true);
      expect(
        records
          .filter((record) => record.type === 'turn.user')
          .every((record) => !JSON.stringify(record.payload).includes('<mar_subagent_update'))
      ).toBe(true);

      const reopened = await f.agent.openSession(f.session.id);
      expect((await reopened.run({ prompt: 'reopen committed history' }).result()).status).toBe(
        'completed'
      );
      expect(reopenedRequest).toBeDefined();
      if (!reopenedRequest) throw new Error('The reopened Session did not make a model request.');
      expect(updates(reopenedRequest)).toHaveLength(3);
      const reopenedRecords = await store.read(f.session.id);
      expect(
        reopenedRecords.filter(
          (record) =>
            record.type === 'model.context' &&
            JSON.stringify(record.payload).includes('<mar_subagent_update')
        )
      ).toHaveLength(3);
    }
  );

  it('preserves messages and terminal updates that arrive while a normal final response is returning', async () => {
    const initialEntered = deferred();
    const initialRelease = deferred();
    const lateEntered = deferred();
    const lateRelease = deferred();
    let childRounds = 0;
    let parentRounds = 0;
    let api: ExtensionAgentsApi | undefined;
    let childId = '';
    let onParentFinal: (() => Promise<void>) | undefined;
    const parentRequests: ModelRequest[] = [];
    let finalExecutionRequest: ModelRequest | undefined;
    let lateMessageRequest: ModelRequest | undefined;
    let terminalExecutionRequest: ModelRequest | undefined;
    const handlers: Record<string, ToolHandler> = {
      'hold-initial-child': async () => {
        initialEntered.resolve();
        await initialRelease.promise;
        return { content: 'Continue the child turn.' };
      },
      'hold-late-message': async () => {
        lateEntered.resolve();
        await lateRelease.promise;
        return { content: 'Finish the child turn.' };
      },
      'native-spawn': async () => {
        if (!api) throw new Error('The Extension API was not attached.');
        const spawned = await api.spawn({
          prompt: childPrompt,
          description: 'Late update child',
          role: 'explore',
          background: true
        });
        if (!('agentId' in spawned)) throw new Error('Expected a child Agent.');
        childId = spawned.agentId;
        await initialEntered.promise;
        return { content: 'Child is held before its first message.' };
      }
    };
    const f = await sdkFixtureWithTools(
      (request) => {
        if (childRequest(request)) {
          childRounds++;
          if (childRounds === 1)
            return [
              toolCall('hold-initial-child', 'hold-initial'),
              { type: 'completed', reason: 'tool_use' }
            ];
          if (childRounds === 2)
            return [
              {
                type: 'text.completed',
                itemId: 'late-progress',
                phase: 'commentary',
                text: 'Late progress preserved for the next Execution.'
              },
              toolCall('hold-late-message', 'hold-late'),
              { type: 'completed', reason: 'tool_use' }
            ];
          return answer();
        }
        parentRequests.push(request);
        if (parentRounds++ === 0)
          return [
            toolCall('native-spawn', 'spawn-child'),
            { type: 'completed', reason: 'tool_use' }
          ];
        if (!finalExecutionRequest) {
          finalExecutionRequest = request;
          onParentFinal = async () => {
            initialRelease.resolve();
            await lateEntered.promise;
          };
          return finalAnswer('Parent final one.');
        }
        const current = updates(request).at(-1);
        if (!current) return answer();
        if (current.content.includes('status="completed"')) {
          terminalExecutionRequest = request;
          return answer();
        }
        if (current.content.includes('Late progress preserved')) {
          lateMessageRequest = request;
          onParentFinal = async () => {
            lateRelease.resolve();
            // Terminal publication uses the parent emit lane currently held by this test gate.
            await vi.waitFor(async () =>
              expect((await api!.inspect({ agentId: childId })).status).toBe('completed')
            );
          };
          return finalAnswer('Parent final two.');
        }
        return answer();
      },
      handlers,
      [
        {
          id: 'late-update-test',
          attachSession(context) {
            if (context.agents) api = context.agents;
          }
        }
      ]
    );
    observeHost(f.host, async (event) => {
      if (
        event.type === 'message.completed' &&
        event.sessionId === f.session.id &&
        event.phase === 'final_answer'
      ) {
        const callback = onParentFinal;
        onParentFinal = undefined;
        await callback?.();
      }
    });

    const first = await f.session
      .run({ prompt: 'return a normal final while the child runs' })
      .result();
    expect(first).toMatchObject({ status: 'completed', finalAnswer: 'Parent final one.' });
    expect(finalExecutionRequest).toBeDefined();
    expect(updates(finalExecutionRequest!).length).toBe(0);
    await lateEntered.promise;
    expect(parentRequests).toHaveLength(2);
    expect((await api!.inspect({ agentId: childId })).status).toBe('running');

    const second = await f.session.run({ prompt: 'receive late progress' }).result();
    expect(second).toMatchObject({ status: 'completed', finalAnswer: 'Parent final two.' });
    expect(lateMessageRequest).toBeDefined();
    expect(updates(lateMessageRequest!).at(-1)?.content).toContain('status="running"');
    expect(updates(lateMessageRequest!).at(-1)?.content).toContain('Late progress preserved');
    expect(terminalExecutionRequest).toBeUndefined();
    expect(api).toBeDefined();
    expect((await api!.inspect({ agentId: childId })).status).toBe('completed');
    expect(parentRequests).toHaveLength(3);

    expect((await f.session.run({ prompt: 'receive late terminal state' }).result()).status).toBe(
      'completed'
    );
    expect(terminalExecutionRequest).toBeDefined();
    expect(updates(terminalExecutionRequest!).at(-1)?.content).toContain('status="completed"');
    expect(parentRequests).toHaveLength(4);
  });

  it('keeps native Extension observations independent from automatic and model-wait consumption', async () => {
    const messageEntered = deferred();
    const messageRelease = deferred();
    const apis = new Map<string, ExtensionAgentsApi>();
    let childRounds = 0;
    let parentRounds = 0;
    let childId = '';
    const parentRequests: ModelRequest[] = [];
    let automaticRequest: ModelRequest | undefined;
    let waitRequest: ModelRequest | undefined;
    let modelWaitResult: unknown;
    const handlers: Record<string, ToolHandler> = {
      'hold-message': async () => {
        messageEntered.resolve();
        await messageRelease.promise;
        return { content: 'Continue after the public message.' };
      }
    };
    const extensions = ['native-reader-before', 'native-reader-after'].map((id) => ({
      id,
      attachSession(context: { agents?: ExtensionAgentsApi }) {
        if (context.agents) apis.set(id, context.agents);
      }
    }));
    const f = await sdkFixtureWithTools(
      (request) => {
        if (childRequest(request)) {
          childRounds++;
          if (childRounds === 1)
            return [
              {
                type: 'text.completed',
                itemId: 'shared-progress',
                phase: 'commentary',
                text: 'The native and model observers must each receive this progress.'
              },
              toolCall('hold-message', 'hold-message'),
              { type: 'completed', reason: 'tool_use' }
            ];
          return answer();
        }
        parentRequests.push(request);
        if (parentRounds++ === 0) return answer();
        const current = updates(request).at(-1);
        if (!current) return answer();
        if (!automaticRequest) {
          automaticRequest = request;
          return [
            toolCall('agent_wait', 'wait-after-auto', { agentId: childId, waitMs: 0 }),
            { type: 'completed', reason: 'tool_use' }
          ];
        }
        waitRequest = request;
        const result = request.messages.findLast(
          (message) => message.role === 'tool' && message.name === 'agent_wait'
        );
        modelWaitResult = result ? JSON.parse(result.content) : undefined;
        return answer();
      },
      handlers,
      extensions
    );
    await f.session.run({ prompt: 'initialize Extension observation APIs' }).result();
    const apiBefore = apis.get('native-reader-before');
    const apiAfter = apis.get('native-reader-after');
    if (!apiBefore || !apiAfter) throw new Error('Both Extension API instances must attach.');
    const spawned = await apiBefore.spawn({
      prompt: childPrompt,
      description: 'Independent observation child',
      role: 'explore',
      background: true
    });
    if (!('agentId' in spawned)) throw new Error('Expected a child Agent.');
    childId = spawned.agentId;
    await messageEntered.promise;

    const nativeBefore = await apiBefore.wait({
      agentId: childId,
      waitFor: 'message',
      waitMs: 1000
    });
    expect(nativeBefore).toMatchObject({
      latestMessage: { text: 'The native and model observers must each receive this progress.' }
    });

    expect(
      (await f.session.run({ prompt: 'automatically observe child progress' }).result()).status
    ).toBe('completed');
    expect(automaticRequest).toBeDefined();
    expect(updates(automaticRequest!).at(-1)?.content).toContain('The native and model observers');
    expect(JSON.stringify(modelWaitResult)).not.toContain('latestMessage');
    expect(waitRequest).toBeDefined();
    expect(updates(waitRequest!)).toHaveLength(1);

    const nativeAfter = await apiAfter.wait({ agentId: childId, waitFor: 'message', waitMs: 1000 });
    expect(nativeAfter).toMatchObject({
      latestMessage: { text: 'The native and model observers must each receive this progress.' }
    });
    messageRelease.resolve();
  });

  it('does not acknowledge a model update whose contextual record fails to persist', async () => {
    const message = 'The message must survive a failed context commit.';
    const entered = deferred();
    const release = deferred();
    let api: ExtensionAgentsApi | undefined;
    let parentRounds = 0;
    let deliveredRequest: ModelRequest | undefined;
    const f = await sdkFixtureWithTools(
      (request) => {
        if (childRequest(request))
          return [
            { type: 'text.completed', itemId: 'progress', phase: 'commentary', text: message },
            toolCall('hold-message', 'hold-message'),
            { type: 'completed', reason: 'tool_use' }
          ];
        if (parentRounds++ === 0) return answer();
        deliveredRequest = request;
        return answer();
      },
      {
        'hold-message': async () => {
          entered.resolve();
          await release.promise;
          return { content: 'Continue child execution.' };
        }
      },
      [
        {
          id: 'failed-context-write',
          attachSession: (context) => {
            if (context.agents) api = context.agents;
          }
        }
      ]
    );
    await f.session.run({ prompt: 'initialize the parent Session' }).result();
    if (!api) throw new Error('The Extension API was not attached.');
    const child = await api.spawn({
      prompt: childPrompt,
      description: 'Commit failure child',
      role: 'explore',
      background: true
    });
    if (!('agentId' in child)) throw new Error('Expected a child Agent.');
    await entered.promise;

    const originalAppend = JsonlSessionStore.prototype.append;
    let failedWrite = false;
    const appendSpy = vi.spyOn(JsonlSessionStore.prototype, 'append');
    appendSpy.mockImplementation(async function (sessionId, input, options) {
      const content = (input.payload as { content?: unknown }).content;
      if (
        !failedWrite &&
        sessionId === f.session.id &&
        input.type === 'model.context' &&
        typeof content === 'string' &&
        content.includes('<mar_subagent_update')
      ) {
        failedWrite = true;
        throw new Error('Simulated model.context persistence failure.');
      }
      return originalAppend.call(this, sessionId, input, options);
    });
    try {
      expect(
        (await f.session.run({ prompt: 'try to receive the child message' }).result()).status
      ).toBe('failed');
      expect(failedWrite).toBe(true);
      expect(deliveredRequest).toBeUndefined();
      appendSpy.mockRestore();
      expect(
        (await f.session.run({ prompt: 'retry automatic child delivery' }).result()).status
      ).toBe('completed');
      expect(updates(deliveredRequest!).at(-1)?.content).toContain(message);
      expect(updates(deliveredRequest!)).toHaveLength(1);
    } finally {
      appendSpy.mockRestore();
      release.resolve();
    }
  });

  it('confirms only committed entries when the second update in a batch fails', async () => {
    let api!: ExtensionAgentsApi;
    const f = await sdkFixture(
      [
        {
          id: 'partial-update-commit',
          apiVersion: '1.0',
          attachSession(context) {
            if (context.agents) api = context.agents;
          }
        }
      ],
      answer,
      false,
      true
    );
    await f.session.run({ prompt: 'initialize' }).result();
    const children = [];
    for (const prompt of ['first child', 'second child']) {
      const child = await api.spawn({ prompt, background: false });
      if (!('agentId' in child)) throw new Error('Expected a child Agent.');
      children.push(child.agentId);
    }
    const original = JsonlSessionStore.prototype.append;
    let attempted = 0;
    const spy = vi
      .spyOn(JsonlSessionStore.prototype, 'append')
      .mockImplementation(async function (sessionId, input, options) {
        if (
          sessionId === f.session.id &&
          input.type === 'model.context' &&
          String((input.payload as { content?: unknown }).content).startsWith(
            '<mar_subagent_update '
          )
        ) {
          if (++attempted === 2) throw new Error('Second update commit failed.');
        }
        return original.call(this, sessionId, input, options);
      });
    expect((await f.session.run({ prompt: 'collect both updates' }).result()).status).toBe(
      'failed'
    );
    expect(attempted).toBe(2);
    spy.mockRestore();
    expect((await f.session.run({ prompt: 'retry remaining updates' }).result()).status).toBe(
      'completed'
    );
    const store = await JsonlSessionStore.open(f.home);
    const committed = (await store.read(f.session.id)).filter(
      (record) =>
        record.type === 'model.context' &&
        String((record.payload as { content?: unknown }).content).startsWith(
          '<mar_subagent_update '
        )
    );
    expect(committed).toHaveLength(2);
    for (const id of children)
      expect(
        committed.filter((record) =>
          String((record.payload as { content?: unknown }).content).includes(id)
        )
      ).toHaveLength(1);
    const parent = f.adapter.requests.findLast((request) => !childRequest(request))!;
    expect(updates(parent)).toHaveLength(2);
  });

  it('does not automatically replay a message already consumed by the model agent_wait tool', async () => {
    const messageEntered = deferred();
    const messageRelease = deferred();
    let childRounds = 0;
    let parentRounds = 0;
    const parentRequests: ModelRequest[] = [];
    let waitResult: unknown;
    let continuationRequest: ModelRequest | undefined;
    const handlers: Record<string, ToolHandler> = {
      'hold-message': async () => {
        messageEntered.resolve();
        await messageRelease.promise;
        return { content: 'Continue after the observed message.' };
      }
    };
    const f = await sdkFixtureWithTools((request) => {
      if (childRequest(request)) {
        childRounds++;
        if (childRounds === 1)
          return [
            {
              type: 'text.completed',
              itemId: 'waited-progress',
              phase: 'commentary',
              text: 'Explicit wait observed this before the next natural request.'
            },
            toolCall('hold-message', 'hold-message'),
            { type: 'completed', reason: 'tool_use' }
          ];
        return answer();
      }
      parentRequests.push(request);
      if (parentRounds++ === 0)
        return [
          toolCall('agent_start', 'start-child', {
            description: 'Explicit wait child',
            prompt: childPrompt,
            role: 'explore'
          }),
          toolCall('agent_wait', 'wait-for-message', { waitFor: 'message', waitMs: 300000 }),
          { type: 'completed', reason: 'tool_use' }
        ];
      const result = request.messages.findLast(
        (message) => message.role === 'tool' && message.name === 'agent_wait'
      );
      waitResult = result ? JSON.parse(result.content) : undefined;
      continuationRequest = request;
      return answer();
    }, handlers);

    expect(
      (await f.session.run({ prompt: 'explicitly wait for the child message' }).result()).status
    ).toBe('completed');
    expect(parentRequests).toHaveLength(2);
    expect(waitResult).toMatchObject({
      latestMessage: { text: 'Explicit wait observed this before the next natural request.' }
    });
    expect(updates(continuationRequest!).length).toBe(0);
    messageRelease.resolve();
  });
});
