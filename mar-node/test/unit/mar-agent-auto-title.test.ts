import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMarAgent,
  generateSessionTitle,
  LocalAgentHost,
  openMarAgentSessionCatalog,
  type MarAgent,
  type MarAgentEvent,
  type MarAgentSession
} from '@myagentroam/agent';
import type { NodeAgentSession } from '../../src/database.js';
import type { MarAgentRuntimeModelConfiguration } from '@myagentroam/protocol';
import { MarAgentManagedRunController } from '../../src/runner/mar-agent/managed-run-controller.js';
import { MarAgentHostedConversationRuntime } from '../../src/runner/mar-agent/hosted-conversation-runtime.js';
import { MarAgentRunner } from '../../src/runner/mar-agent-runner.js';
import { NodeConnector } from '../../src/connector.js';
import { NodeDatabase } from '../../src/database.js';
import type { NodeRuntimeState } from '../../src/runtime-state.js';
import * as operational from '../../src/operational.js';
import { executeNodeOperation as operation } from './support/node-connector.js';

const homes: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

const model: MarAgentRuntimeModelConfiguration = {
  id: 'current',
  name: 'Current',
  protocol: 'OPENAI_RESPONSES',
  baseUrl: 'https://example.test/v1',
  apiKey: 'test-key',
  modelId: 'current',
  contextWindowTokens: 100_000,
  maxOutputTokens: 4096,
  inputCapabilities: ['TEXT'],
  outputCapabilities: ['TEXT'],
  reasoningEfforts: ['low'],
  defaultReasoningEffort: 'low',
  hostedWebSearch: false,
  enabled: true
};

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'mar-node-auto-title-'));
  homes.push(home);
  let pending = true;
  let title = 'New session';
  let ordinal = 0;
  const handle = () => {
    const executionId = `execution-${++ordinal}`;
    return {
      executionId,
      async *[Symbol.asyncIterator]() {
        pending = false;
        yield {
          eventId: `started-${ordinal}`,
          sequence: 1,
          timestamp: '2026-01-01T00:00:00.000Z',
          sessionId: 'native-session',
          executionId,
          type: 'execution.started',
          mode: 'run'
        } as MarAgentEvent;
      },
      result: async () => ({ executionId, status: 'completed' as const, finalAnswer: 'Done' }),
      cancel: vi.fn()
    };
  };
  const session: MarAgentSession = {
    id: 'native-session',
    run: vi.fn(handle),
    steer: vi.fn(async () => ({ status: 'notAccepted' as const })),
    plan: vi.fn(handle),
    compact: vi.fn(handle),
    cancel: vi.fn()
  };
  const agent: MarAgent = {
    createSession: vi.fn(async () => session),
    openSession: vi.fn(async () => session),
    listSessions: vi.fn(),
    getSession: vi.fn(async () => ({
      id: session.id,
      title,
      automaticTitlePending: pending,
      workspace: home,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastActivityAt: '2026-01-01T00:00:00.000Z',
      source: { type: 'user' as const }
    })),
    setSessionTitle: vi.fn(async (_id, value) => {
      title = value;
      return true;
    }),
    clearSession: vi.fn(),
    deleteSession: vi.fn(),
    setSystemInstruction: vi.fn(),
    reconfigureModels: vi.fn(),
    extensionDiagnostics: () => [],
    dispose: vi.fn(async () => undefined)
  };
  const models = [model, { ...model, id: 'title', titleGeneration: true }];
  const createAgent = vi.fn(async () => agent);
  const generateTitle = vi
    .fn<typeof generateSessionTitle>()
    .mockResolvedValue('Project inspection');
  const host = {
    active: new Set<string>(),
    adopt: vi.fn(),
    promote: vi.fn(),
    syncTitle: vi.fn(),
    emit: vi.fn(),
    emitItem: vi.fn(),
    run: vi.fn(),
    commandState: vi.fn(),
    setCommandState: vi.fn(),
    clearCommandState: vi.fn(),
    commandStates: vi.fn(() => []),
    webSearch: vi.fn()
  };
  return { home, agent, session, models, createAgent, generateTitle, host };
}

describe('Node host auto title', () => {
  it.each(['fixer#42 Preserve named sessions', 'reviewer#42 Review named sessions'])(
    'preserves the explicit title %s in the native SDK without requesting an automatic title',
    async (title) => {
      const f = await fixture();
      const server = createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(
          [
            { type: 'response.output_text.done', item_id: 'answer', text: 'Done' },
            {
              type: 'response.completed',
              response: { usage: { input_tokens: 10, output_tokens: 2 } }
            }
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join('')
        );
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      const runtimeModel = { ...model, baseUrl: `http://127.0.0.1:${port}/v1` };
      const customTitle = vi.fn(() => title);
      const controller = new MarAgentManagedRunController(
        new MarAgentRunner(f.home),
        { ...f.host, customTitle },
        {
          generateTitle: f.generateTitle,
          createAgent: (options) =>
            createMarAgent({
              ...options,
              host: new LocalAgentHost({ mode: 'node', homeDirectory: f.home, workspace: f.home })
            })
        }
      );
      try {
        await managedRun(controller)({
          runId: 'named-run',
          sessionId: 'named-draft',
          input: 'Inspect the project',
          cwd: f.home,
          model: runtimeModel,
          models: [runtimeModel],
          effort: 'low',
          mode: 'run',
          mcpServers: [],
          images: []
        });
        expect(f.generateTitle).not.toHaveBeenCalled();
        expect(f.host.emit).toHaveBeenCalledWith(
          'named-run',
          'run.completed',
          { status: 'SUCCEEDED' },
          'SUCCEEDED'
        );
        const sessionId = f.host.promote.mock.calls[0]![1] as string;
        await controller.dispose();
        const catalog = await openMarAgentSessionCatalog({ homeDirectory: f.home });
        try {
          expect((await catalog.list()).sessions).toEqual([
            expect.objectContaining({ id: sessionId, title })
          ]);
        } finally {
          await catalog.close();
        }
      } finally {
        await controller.dispose();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
      }
    }
  );

  it.each(['failure', 'empty'] as const)(
    'restores the first-message title after %s generation and Node restart through list, search and detail',
    async (scenario) => {
      const f = await fixture();
      const log = vi.spyOn(operational, 'nodeLog');
      const server = createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(
          [
            { type: 'response.output_text.done', item_id: 'answer', text: 'Done' },
            {
              type: 'response.completed',
              response: { usage: { input_tokens: 10, output_tokens: 2 } }
            }
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join('')
        );
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      const runtimeModel = { ...model, baseUrl: `http://127.0.0.1:${port}/v1` };
      f.generateTitle.mockReset();
      if (scenario === 'failure')
        f.generateTitle.mockRejectedValue(new Error('Title model unavailable'));
      else f.generateTitle.mockResolvedValue(undefined);
      const runner = new MarAgentRunner(f.home);
      const controller = new MarAgentManagedRunController(runner, f.host, {
        generateTitle: f.generateTitle,
        createAgent: (options) =>
          createMarAgent({
            ...options,
            host: new LocalAgentHost({ mode: 'node', homeDirectory: f.home, workspace: f.home })
          })
      });
      const database = new NodeDatabase(':memory:', 'node-title-restart');
      let connector: NodeConnector | undefined;
      try {
        await managedRun(controller)({
          runId: 'first',
          sessionId: 'draft',
          input: '  去看升国旗吧\n需要五星红旗元素  ',
          cwd: f.home,
          model: runtimeModel,
          models: [runtimeModel],
          effort: 'low',
          mode: 'run',
          mcpServers: [],
          images: []
        });
        const sessionId = f.host.promote.mock.calls[0]![1] as string;
        expect(f.host.emit).toHaveBeenCalledWith(
          'first',
          'run.completed',
          { status: 'SUCCEEDED' },
          'SUCCEEDED'
        );
        if (scenario === 'failure')
          expect(log).toHaveBeenCalledWith('runner.mar-agent.title.failed', {
            sessionId,
            runId: 'first',
            stage: 'generate',
            code: 'MAR_AGENT_TITLE_GENERATION_FAILED'
          });
        await controller.dispose();
        const workspace = database.saveWorkspace({
          path: f.home,
          kind: 'DIRECTORY',
          gitSummary: null
        });
        connector = new NodeConnector({
          reconnect: false,
          database,
          capabilities: {
            platform: 'linux',
            architecture: 'x64',
            nodeVersion: process.version,
            codex: { available: false },
            claudeCode: { available: false },
            marAgent: { available: true, version: 'test' }
          }
        });
        const internals = connector as unknown as {
          marAgentClient: MarAgentRunner;
          runtime: NodeRuntimeState;
        };
        vi.spyOn(internals.marAgentClient, 'discoverSessions').mockImplementation(
          (context, target) => runner.discoverSessions(context, target)
        );
        const listed = (await operation(connector, 'session.list', {
          workspaceId: workspace.id
        })) as {
          sessions: NodeAgentSession[];
        };
        expect(listed.sessions).toEqual([
          expect.objectContaining({
            id: sessionId,
            runnerTitle: '去看升国旗吧 需要五星红旗元素',
            titleSource: 'AUTO'
          })
        ]);
        await expect(runner.readManagedRunnerTitle(listed.sessions[0]!, sessionId)).resolves.toBe(
          '去看升国旗吧 需要五星红旗元素'
        );
        const managed = internals.runtime.createAgentSession({
          workspaceId: workspace.id,
          runner: 'mar-agent',
          externalSessionId: sessionId,
          nativeControl: 'MAR_MANAGED',
          cwd: f.home,
          title: 'New session'
        });
        await expect(
          operation(connector, 'session.list', {
            workspaceId: workspace.id,
            query: '五星红旗'
          })
        ).resolves.toMatchObject({
          sessions: [
            expect.objectContaining({
              id: managed.id,
              runnerTitle: '去看升国旗吧 需要五星红旗元素',
              titleSource: 'AUTO'
            })
          ]
        });
        await expect(operation(connector, 'session.get', { sessionId })).resolves.toMatchObject({
          session: { id: sessionId, runnerTitle: '去看升国旗吧 需要五星红旗元素' }
        });
        internals.runtime.updateSessionMetadata({ sessionId, customTitle: 'My title' });
        internals.runtime.setRunnerTitleFromNative(sessionId, 'Generated title');
        await expect(operation(connector, 'session.get', { sessionId })).resolves.toMatchObject({
          session: { customTitle: 'My title', titleSource: 'CUSTOM' }
        });
      } finally {
        if (connector !== undefined) await connector.stop();
        else database.close();
        await controller.dispose();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
      }
    }
  );

  it.each([
    { kind: 'ordinary', cancellation: 'none' },
    { kind: 'hosted', cancellation: 'none' },
    { kind: 'ordinary', cancellation: 'before-title' },
    { kind: 'hosted', cancellation: 'before-title' },
    { kind: 'ordinary', cancellation: 'after-title' },
    { kind: 'hosted', cancellation: 'after-title' }
  ] as const)(
    'persists and projects a title through the real $kind SDK with $cancellation cancellation',
    async ({ kind, cancellation }) => {
      const f = await fixture();
      let titleRequested!: () => void;
      let mainRequested!: () => void;
      let titleGenerated!: () => void;
      let finishTitle!: () => void;
      const titleRequest = new Promise<void>((resolve) => {
        titleRequested = resolve;
      });
      const mainRequest = new Promise<void>((resolve) => {
        mainRequested = resolve;
      });
      const generated = new Promise<void>((resolve) => {
        titleGenerated = resolve;
      });
      const titleGate = new Promise<void>((resolve) => {
        finishTitle = resolve;
      });
      let titleSignal: AbortSignal | undefined;
      const generateTitle: typeof generateSessionTitle = async (input) => {
        titleSignal = input.signal;
        const title = await generateSessionTitle(input);
        titleGenerated();
        return title;
      };
      const requests: {
        body: { model: string; input: unknown[]; tools?: unknown[] };
        authorization: string | undefined;
      }[] = [];
      const server = createServer(async (request, response) => {
        let text = '';
        for await (const chunk of request) text += chunk;
        const body = JSON.parse(text) as (typeof requests)[number]['body'];
        requests.push({ body, authorization: request.headers.authorization });
        if (body.model === 'title') {
          titleRequested();
          if (cancellation === 'before-title') await titleGate;
        } else if (
          cancellation !== 'none' &&
          requests.filter(({ body }) => body.model === 'current').length === 1
        ) {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.write(': waiting for cancellation\n\n');
          mainRequested();
          return;
        }
        const answer = body.model === 'title' ? 'Project inspection' : 'Done';
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(
          [
            { type: 'response.output_text.done', item_id: 'answer', text: answer },
            {
              type: 'response.completed',
              response: { usage: { input_tokens: 10, output_tokens: 2 } }
            }
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join('')
        );
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string')
        throw new Error('Fixture server did not bind.');
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const models = [
        { ...model, baseUrl, apiKey: 'main-key' },
        {
          ...model,
          id: 'title',
          modelId: 'title',
          baseUrl,
          apiKey: 'title-key',
          titleGeneration: true
        }
      ];
      const runner = new MarAgentRunner(f.home);
      f.host.syncTitle.mockImplementation(async (nativeSessionId: string) => {
        expect(
          await runner.readManagedRunnerTitle(
            { runner: 'mar-agent', externalSessionId: nativeSessionId } as NodeAgentSession,
            nativeSessionId
          )
        ).toBe('Project inspection');
      });
      const ordinary = new MarAgentManagedRunController(runner, f.host, {
        generateTitle,
        createAgent: (options) =>
          createMarAgent({
            ...options,
            host: new LocalAgentHost({ mode: 'node', homeDirectory: f.home, workspace: f.home })
          })
      });
      const hosted = new MarAgentHostedConversationRuntime({ generateTitle });
      const cancelFirst = async (cancel: () => unknown) => {
        if (cancellation === 'none') return;
        await Promise.all([titleRequest, mainRequest]);
        if (cancellation === 'after-title') await generated;
        expect(cancel()).toBe(true);
        expect(titleSignal?.aborted).toBe(false);
        finishTitle();
      };
      const hostedInput = {
        conversationId: 'conversation',
        homeDirectory: f.home,
        workspaceDirectory: f.home,
        systemInstruction: 'Private template instructions',
        models,
        pathMounts: [],
        processExecutor: { spawn: vi.fn() } as never
      };
      let sessionId: string;
      try {
        if (kind === 'ordinary') {
          const first = managedRun(ordinary)({
            runId: 'first',
            sessionId: 'draft',
            input: 'Inspect project',
            cwd: f.home,
            model: models[0],
            models,
            effort: 'low',
            mode: 'run',
            mcpServers: [],
            images: []
          });
          await cancelFirst(() =>
            ordinary.cancel('first', cancellation === 'after-title' ? 'INTERRUPT' : 'CANCEL')
          );
          await first;
          expect(f.host.syncTitle).toHaveBeenCalledOnce();
          sessionId = f.host.promote.mock.calls[0]![1] as string;
          await managedRun(ordinary)({
            runId: 'second',
            sessionId,
            externalSessionId: sessionId,
            input: 'Continue',
            cwd: f.home,
            model: models[0],
            models,
            effort: 'low',
            mode: 'run',
            mcpServers: [],
            images: []
          });
          for (const runId of ['first', 'second']) {
            const cancelled = runId === 'first' && cancellation !== 'none';
            expect(f.host.emit).toHaveBeenCalledWith(
              runId,
              cancelled ? 'run.cancelled' : 'run.completed',
              { status: cancelled ? 'CANCELLED' : 'SUCCEEDED' },
              cancelled ? 'CANCELLED' : 'SUCCEEDED'
            );
          }
        } else {
          ({ sessionId } = await hosted.createSession({
            ...hostedInput,
            defaultModelId: model.id
          }));
          const runInput = {
            ...hostedInput,
            sessionId,
            modelId: model.id,
            clientMessageId: 'first',
            prompt: 'Injected instructions\nInspect project',
            userPrompt: 'Inspect project',
            attachmentIds: [],
            access: 'full-access' as const,
            temporaryDirectory: f.home,
            webAccess: false,
            mcpServers: []
          };
          const first = await hosted.startRun(runInput);
          await cancelFirst(() => first.cancel());
          await expect(first.completion).resolves.toMatchObject({
            status: cancellation === 'none' ? 'SUCCEEDED' : 'INTERRUPTED',
            title: 'Project inspection'
          });
          const second = await hosted.startRun({
            ...runInput,
            clientMessageId: 'second',
            prompt: 'Continue',
            userPrompt: 'Continue'
          });
          await expect(second.completion).resolves.toMatchObject({
            status: 'SUCCEEDED',
            title: 'Project inspection'
          });
        }
        const catalog = await openMarAgentSessionCatalog({ homeDirectory: f.home });
        try {
          expect((await catalog.list()).sessions).toEqual([
            expect.objectContaining({ id: sessionId, title: 'Project inspection' })
          ]);
        } finally {
          await catalog.close();
        }
        const titles = requests.filter(({ body }) => body.model === 'title');
        expect(titles).toHaveLength(1);
        expect(titles[0]!.authorization).toBe('Bearer title-key');
        expect(titles[0]!.body).not.toHaveProperty('instructions');
        expect(titles[0]!.body.input).toEqual([
          {
            role: 'developer',
            content: [
              { type: 'input_text', text: expect.stringContaining('session title generator') }
            ]
          },
          { role: 'user', content: 'Inspect project' }
        ]);
        expect(JSON.stringify(titles[0]!.body.input)).not.toContain(
          'Private template instructions'
        );
        expect(titles[0]!.body.tools ?? []).toEqual([]);
        expect(requests.filter(({ body }) => body.model === 'current')).toHaveLength(2);
        expect(
          requests
            .filter(({ body }) => body.model === 'current')
            .every(({ authorization }) => authorization === 'Bearer main-key')
        ).toBe(true);
      } finally {
        finishTitle();
        await Promise.all([ordinary.dispose(), hosted.dispose()]);
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
      }
    }
  );

  it.each(['run', 'plan'] as const)(
    'generates once after %s input acceptance and writes before terminal publication',
    async (mode) => {
      const f = await fixture();
      const controller = new MarAgentManagedRunController(new MarAgentRunner(), f.host, {
        createAgent: f.createAgent,
        generateTitle: f.generateTitle
      });
      const input = {
        sessionId: 'native-session',
        input: 'Inspect project',
        cwd: f.home,
        model,
        models: f.models,
        effort: 'low',
        mode,
        mcpServers: [],
        images: []
      };
      try {
        await managedRun(controller)({ ...input, runId: 'run-1' });
        expect(f.generateTitle).toHaveBeenCalledWith(
          expect.objectContaining({
            prompt: 'Inspect project',
            currentModelId: 'current',
            models: expect.arrayContaining([
              expect.objectContaining({ id: 'title', titleGeneration: true })
            ])
          })
        );
        expect(f.agent.setSessionTitle).toHaveBeenCalledWith(
          'native-session',
          'Project inspection',
          {
            automatic: true,
            expectedTitle: 'New session',
            executionId: 'execution-1'
          }
        );
        expect(vi.mocked(f.agent.setSessionTitle).mock.invocationCallOrder[0]).toBeLessThan(
          f.host.syncTitle.mock.invocationCallOrder[0]!
        );
        await managedRun(controller)({
          ...input,
          runId: 'run-2',
          externalSessionId: 'native-session'
        });
        expect(f.generateTitle).toHaveBeenCalledOnce();
      } finally {
        await controller.dispose();
      }
    }
  );

  it.each(['compact', 'resume', 'failure', 'persist-failure'] as const)(
    'does not let %s produce an automatic title or fail the main task',
    async (scenario) => {
      const f = await fixture();
      if (scenario === 'failure') f.generateTitle.mockRejectedValue(new Error('title unavailable'));
      if (scenario === 'persist-failure')
        vi.mocked(f.agent.setSessionTitle).mockRejectedValue(new Error('title write unavailable'));
      const controller = new MarAgentManagedRunController(new MarAgentRunner(), f.host, {
        createAgent: f.createAgent,
        generateTitle: f.generateTitle
      });
      try {
        await managedRun(controller)({
          runId: 'run',
          sessionId: 'native-session',
          input: 'Inspect project',
          cwd: f.home,
          model,
          models: f.models,
          effort: 'low',
          mode: scenario === 'compact' ? 'compact' : 'run',
          mcpServers: [],
          images: [],
          ...(scenario === 'resume' ? { externalSessionId: 'native-session' } : {})
        });
        expect(f.generateTitle).toHaveBeenCalledTimes(
          scenario === 'failure' || scenario === 'persist-failure' ? 1 : 0
        );
        expect(f.agent.setSessionTitle).toHaveBeenCalledTimes(
          scenario === 'persist-failure' ? 1 : 0
        );
        expect(f.host.emit).toHaveBeenCalledWith(
          'run',
          'run.completed',
          expect.anything(),
          'SUCCEEDED'
        );
      } finally {
        await controller.dispose();
      }
    }
  );

  it.each([
    { kind: 'ordinary', operation: 'dispose' },
    { kind: 'ordinary', operation: 'release' },
    { kind: 'hosted', operation: 'dispose' },
    { kind: 'hosted', operation: 'release' }
  ] as const)(
    'settles a cancelled title before $kind $operation closes the Agent',
    async ({ kind, operation }) => {
      const f = await fixture();
      let started!: () => void;
      let aborted!: () => void;
      let finish!: () => void;
      const titleStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const titleAborted = new Promise<void>((resolve) => {
        aborted = resolve;
      });
      const cleanup = new Promise<void>((resolve) => {
        finish = resolve;
      });
      f.generateTitle.mockImplementation(async ({ signal }) => {
        signal.addEventListener('abort', aborted, { once: true });
        started();
        await cleanup;
        return 'Project inspection';
      });
      const controller = new MarAgentManagedRunController(new MarAgentRunner(), f.host, {
        createAgent: f.createAgent,
        generateTitle: f.generateTitle
      });
      const runtime = new MarAgentHostedConversationRuntime({
        createAgent: f.createAgent,
        createHost: vi.fn() as never,
        generateTitle: f.generateTitle,
        openCatalog: vi.fn(async () => ({
          list: async () => ({ sessions: [await f.agent.getSession('native-session')] }),
          close: vi.fn()
        })) as never
      });
      const run =
        kind === 'ordinary'
          ? managedRun(controller)({
              runId: 'run',
              sessionId: 'native-session',
              input: 'Inspect project',
              cwd: f.home,
              model,
              models: f.models,
              effort: 'low',
              mode: 'run',
              mcpServers: [],
              images: []
            })
          : (
              await runtime.startRun({
                conversationId: 'conversation',
                sessionId: 'native-session',
                homeDirectory: f.home,
                workspaceDirectory: f.home,
                systemInstruction: '',
                modelId: model.id,
                models: f.models,
                clientMessageId: 'message-1',
                prompt: 'Inspect project',
                userPrompt: 'Inspect project',
                attachmentIds: [],
                access: 'full-access',
                temporaryDirectory: f.home,
                webAccess: false,
                mcpServers: [],
                pathMounts: [],
                processExecutor: { spawn: vi.fn() } as never
              })
            ).completion;
      let release: Promise<void> | undefined;
      try {
        await titleStarted;
        release =
          kind === 'ordinary'
            ? operation === 'dispose'
              ? controller.dispose()
              : controller.releaseSession('native-session')
            : operation === 'dispose'
              ? runtime.dispose()
              : runtime.releaseSession({
                  conversationId: 'conversation',
                  sessionId: 'native-session',
                  homeDirectory: f.home
                });
        await titleAborted;
        expect(f.agent.dispose).not.toHaveBeenCalled();
        finish();
        await Promise.all([run, release]);
        expect(f.agent.dispose).toHaveBeenCalledOnce();
        expect(f.agent.setSessionTitle).not.toHaveBeenCalled();
      } finally {
        finish();
        await run;
        await release;
        await Promise.all([controller.dispose(), runtime.dispose()]);
      }
    }
  );

  it.each(['success', 'failure'] as const)(
    'uses raw hosted user input and settles %s before credential disposal',
    async (scenario) => {
      const f = await fixture();
      if (scenario === 'failure') f.generateTitle.mockRejectedValue(new Error('title unavailable'));
      const runtime = new MarAgentHostedConversationRuntime({
        createAgent: f.createAgent,
        createHost: vi.fn() as never,
        generateTitle: f.generateTitle,
        openCatalog: vi.fn(async () => ({
          list: async () => ({ sessions: [await f.agent.getSession('native-session')] }),
          close: vi.fn()
        })) as never
      });
      const input = {
        conversationId: 'conversation',
        sessionId: 'native-session',
        homeDirectory: f.home,
        workspaceDirectory: f.home,
        systemInstruction: 'Private template instructions',
        modelId: model.id,
        models: f.models,
        clientMessageId: 'message-1',
        prompt: 'Injected instructions\nInspect project',
        userPrompt: 'Inspect project',
        attachmentIds: [],
        access: 'full-access' as const,
        temporaryDirectory: f.home,
        webAccess: false,
        mcpServers: [],
        pathMounts: [],
        processExecutor: { spawn: vi.fn() } as never
      };
      try {
        const run = await runtime.startRun(input);
        await expect(run.completion).resolves.toMatchObject({ status: 'SUCCEEDED' });
        expect(f.generateTitle).toHaveBeenCalledWith(
          expect.objectContaining({ prompt: 'Inspect project' })
        );
        expect(f.agent.setSessionTitle).toHaveBeenCalledTimes(scenario === 'success' ? 1 : 0);
        expect(f.agent.dispose).toHaveBeenCalledOnce();
        if (scenario === 'success') {
          const next = await runtime.startRun({ ...input, clientMessageId: 'message-2' });
          await next.completion;
          expect(f.generateTitle).toHaveBeenCalledOnce();
        }
      } finally {
        await runtime.dispose();
      }
    }
  );
});

function managedRun(controller: MarAgentManagedRunController) {
  return (controller as unknown as { run(input: unknown): Promise<void> }).run.bind(controller);
}
