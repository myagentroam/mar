import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { WebSocketServer, type WebSocket } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { createEnvelope, type NodeEnvelope } from '@myagentroam/protocol';
import type { GoalState } from '../../src/service/goal-runtime.js';
import { NodeConnector } from '../../src/connector.js';
import { NodeDatabase } from '../../src/database.js';
import type { NodeRuntimeState } from '../../src/runtime-state.js';
import type { GoalRuntime } from '../../src/service/goal-runtime.js';
import type { ContinuousRunCoordinator } from '../../src/service/continuous-run-coordinator.js';
import {
  plannedRestartSchema,
  type PlannedRestartHandoff
} from '../../src/service/planned-restart-handoff.js';
import { openRestartState } from '../../src/service/restart-execution-state.js';

interface TestOperationResponse {
  readonly error?: string;
  readonly message?: string;
  readonly result: {
    readonly session: { readonly id: string };
    readonly workspace: { readonly id: string };
    readonly run?: { readonly id: string };
    readonly goal: GoalState;
  };
}

describe('Node capture failure logging', () => {
  it.each(['identity', 'goal', 'snapshot', 'unknown', 'diagnostic'] as const)(
    'projects only bounded producer metadata for a %s failure through shutdown logging',
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), 'mar-node-capture-log-'));
      const sentinel = 'PRIVATE_CAPTURE_SENTINEL';
      const oversized = sentinel.repeat(1000);
      const unready = mode === 'identity' || mode === 'diagnostic';
      const database = new NodeDatabase(join(root, 'node.sqlite'), 'capture-node');
      database.saveWorkspace({ id: 'workspace', path: root, kind: 'DIRECTORY', gitSummary: null });
      const connector = new NodeConnector({
        reconnect: false,
        database,
        config: {
          nodeId: 'capture-node',
          serverUrl: 'https://server.example.test',
          allowedRoots: [root],
          dataDirectory: root,
          credential: sentinel
        }
      });
      const core = connector as unknown as {
        runtime: NodeRuntimeState;
        goalRuntime: GoalRuntime;
        continuousRunCoordinator: ContinuousRunCoordinator<unknown>;
        restartHandoff: PlannedRestartHandoff;
        disposeRuntime(): Promise<void>;
      };
      const lines: string[] = [];
      let originalFailure: unknown;
      const capture = core.restartHandoff.capture.bind(core.restartHandoff);
      const dispose = vi.spyOn(core, 'disposeRuntime');
      const publish = vi.spyOn(core.restartHandoff, 'publish');
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        lines.push(String(chunk));
        if (mode === 'diagnostic') throw new Error('LOG_STORAGE_FAILED');
        return true;
      });
      try {
        const session = core.runtime.createAgentSession({
          workspaceId: 'workspace',
          runner: 'mar-agent',
          cwd: root,
          ...(unready ? {} : { externalSessionId: 'native-session' }),
          modelId: sentinel,
          effort: sentinel,
          access: sentinel
        });
        core.goalRuntime.start(session.id, sentinel);
        if (mode === 'goal') {
          const goal = core.goalRuntime.restartState(session.id)!;
          vi.spyOn(core.goalRuntime, 'restartState').mockReturnValue({
            ...goal,
            goal: { ...goal.goal, objective: oversized, [oversized]: sentinel }
          });
        }
        if (mode === 'snapshot') {
          for (let index = 0; index < 10; index++) {
            core.continuousRunCoordinator.accept({
              runId: `input-${index}`,
              sessionId: session.id,
              clientMessageId: `client-${index}`,
              content: sentinel,
              initiatedByUserId: 41,
              attachments: [{ name: oversized, mime: oversized, dataBase64: sentinel }]
            });
          }
        }
        vi.spyOn(core.restartHandoff, 'capture').mockImplementation(() => {
          try {
            if (mode === 'unknown')
              throw Object.assign(new Error(oversized, { cause: sentinel }), {
                details: { reason: oversized, issues: [{ code: oversized, path: [oversized] }] }
              });
            return capture();
          } catch (error) {
            originalFailure = error;
            throw error;
          }
        });
        let rejected = false;
        await connector.stop({ handoff: true }).catch((error: unknown) => {
          rejected = true;
          expect(error).toBe(originalFailure);
        });
        expect(rejected).toBe(true);
        expect(dispose).toHaveBeenCalledOnce();
        expect(publish).not.toHaveBeenCalled();
        await expect(readFile(join(root, 'planned-restart-handoff.json'))).rejects.toMatchObject({
          code: 'ENOENT'
        });
        const diagnostics = lines
          .flatMap((line) => line.trim().split('\n'))
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .filter((entry) => entry.event === 'node.shutdown.failed');
        expect(diagnostics).toHaveLength(1);
        const diagnostic = diagnostics[0]!;
        expect(diagnostic).toMatchObject({
          stage: 'capture',
          errorCode: unready ? 'RESTART_SESSION_NOT_READY' : 'NODE_SHUTDOWN_FAILED',
          ...(mode === 'unknown'
            ? {}
            : { reason: unready ? 'session_not_ready' : `${mode}_schema_invalid` })
        });
        if (mode === 'goal' || mode === 'snapshot') {
          expect(originalFailure).toMatchObject({ name: 'ZodError' });
          const issues = diagnostic.issues as { code: string; path: string }[];
          expect(issues).toContainEqual({
            code: 'too_big',
            path: mode === 'goal' ? 'goal.objective' : 'sessions[0].queue[0].attachments[0].name'
          });
          expect(issues.length).toBeLessThanOrEqual(12);
          for (const issue of issues) {
            expect(Object.keys(issue).sort()).toEqual(['code', 'path']);
            expect(issue.path.length).toBeLessThanOrEqual(160);
          }
          if (mode === 'snapshot') expect(diagnostic.issuesTruncated).toBe(true);
          if (mode === 'goal') {
            expect(issues).toContainEqual({ code: 'unrecognized_keys', path: 'goal' });
            expect(diagnostic.issuesTruncated).toBe(false);
          }
        }
        if (mode === 'unknown') {
          expect(diagnostic).not.toHaveProperty('reason');
          expect(diagnostic).not.toHaveProperty('issues');
        }
        expect(JSON.stringify(diagnostics)).not.toContain(sentinel);
        expect(lines.join('')).not.toContain(sentinel);
        expect(JSON.stringify(diagnostics).length).toBeLessThan(3000);
        expect(diagnostic).not.toHaveProperty('stack');
        expect(diagnostic).not.toHaveProperty('cause');
      } finally {
        await connector.stop().catch(() => {});
        vi.restoreAllMocks();
        await rm(root, { recursive: true, force: true });
      }
    }
  );
});

describe('Node CLI orderly restart with the real SDK', () => {
  it.skipIf(process.platform === 'win32').each(['message', 'goal', 'native-steer'] as const)(
    'continues the original %s and FIFO after SIGTERM, but not SIGKILL',
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), 'mar-node-restart-process-'));
      const workspace = join(root, 'workspace');
      const home = join(root, 'home');
      const data = join(root, 'node-data');
      await Promise.all([mkdir(workspace), mkdir(home)]);
      const requests: unknown[] = [];
      let hold = true;
      let goalCompleted = false;
      const http = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString());
        // Auxiliary title requests do not represent Session executions.
        const execution = JSON.stringify(body.messages).includes('<mar_environment>');
        if (execution) requests.push(body);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        event(response, {
          type: 'message_start',
          message: { id: randomUUID(), usage: { input_tokens: 10 } }
        });
        if (hold && execution) return;
        if (mode === 'goal' && execution && !goalCompleted) {
          goalCompleted = true;
          const tool = body.tools.find((item: { name: string }) =>
            item.name.includes('update_goal')
          );
          event(response, {
            type: 'content_block_start',
            index: 0,
            content_block: {
              type: 'tool_use',
              id: 'finish-goal',
              name: tool?.name,
              input: { status: 'completed' }
            }
          });
          event(response, { type: 'content_block_stop', index: 0 });
          event(response, {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use' },
            usage: { output_tokens: 5 }
          });
          event(response, { type: 'message_stop' });
          response.end();
          return;
        }
        event(response, {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: 'Done.' }
        });
        event(response, { type: 'content_block_stop', index: 0 });
        event(response, {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 5 }
        });
        event(response, { type: 'message_stop' });
        response.end();
      });
      await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
      const baseUrl = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
      const model = {
        id: 'restart-model',
        name: 'Restart model',
        protocol: 'ANTHROPIC_MESSAGES',
        baseUrl,
        credential: { type: 'INLINE_API_KEY', value: 'synthetic-key' },
        modelId: 'fake',
        contextWindowTokens: 100_000,
        maxOutputTokens: 1000,
        inputCapabilities: ['TEXT'],
        outputCapabilities: ['TEXT'],
        reasoningEfforts: [],
        hostedWebSearch: false,
        titleGeneration: false,
        codeMode: false,
        enabled: true
      };
      const sockets = new WebSocketServer({ server: http, path: '/api/node/connect' });
      let control: WebSocket | undefined;
      let connections = 0;
      let authorizations = 0;
      const watchEvents: unknown[] = [];
      const replies = new Map<string, (value: TestOperationResponse) => void>();
      sockets.on('connection', (socket) => {
        socket.on('message', (bytes) => {
          const envelope = JSON.parse(bytes.toString()) as NodeEnvelope;
          if (envelope.type === 'authenticate') {
            control = socket;
            connections++;
            socket.send(JSON.stringify(createEnvelope('authenticated', {})));
          } else if (envelope.type === 'node.response' && envelope.replyTo) {
            replies.get(envelope.replyTo)?.(envelope.payload as TestOperationResponse);
            replies.delete(envelope.replyTo);
          } else if (envelope.type === 'watch.event') {
            watchEvents.push(envelope.payload);
          } else if (envelope.type === 'restart.authorize') {
            authorizations++;
          }
        });
      });
      const config = join(root, 'node.json');
      const udpSocket = createSocket('udp4');
      udpSocket.bind(0, '127.0.0.1');
      await once(udpSocket, 'listening');
      const udpPort = udpSocket.address().port;
      await new Promise<void>((resolve) => udpSocket.close(resolve));
      await writeFile(
        config,
        JSON.stringify({
          serverUrl: baseUrl,
          nodeId: 'test-node',
          credential: 'synthetic-credential',
          allowedRoots: [root],
          dataDirectory: data,
          directTransfer: { udpPortRangeBegin: udpPort, udpPortRangeEnd: udpPort }
        })
      );
      let child: ChildProcess | undefined;
      let logs = '';
      const start = async () => {
        const before = connections;
        child = spawn(
          process.execPath,
          [
            '--import',
            'tsx',
            resolve('src/main.ts'),
            mode === 'goal' ? 'supervise' : 'run',
            '--config',
            config
          ],
          {
            cwd: resolve('..'),
            env: {
              ...process.env,
              HOME: home,
              NODE_OPTIONS: `${process.env['NODE_OPTIONS'] ?? ''} --import ${createRequire(import.meta.url).resolve('tsx')}`
            },
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe']
          }
        );
        for (const stream of [child.stdout, child.stderr])
          stream?.on('data', (bytes) => {
            logs = (logs + bytes.toString()).slice(-8000);
          });
        await vi.waitFor(
          () => {
            if (child?.exitCode !== null) throw new Error(`Node exited before connecting: ${logs}`);
            expect(connections).toBe(before + 1);
          },
          { timeout: 15000 }
        );
      };
      const operation = async (operation: string, input: Record<string, unknown> = {}) => {
        const envelope = createEnvelope('node.request', {});
        const issuedAt = Date.now();
        const payload = {
          operation,
          data: input,
          userAuthorization: {
            userId: 7,
            sessionHash: 'a'.repeat(43),
            nodeId: 'test-node',
            operation,
            requestId: envelope.id,
            issuedAt,
            expiresAt: issuedAt + 15000
          }
        };
        const result = new Promise<TestOperationResponse>((done, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`Node request timed out: ${operation}; ${logs}`)),
            10000
          );
          replies.set(envelope.id, (value) => {
            clearTimeout(timer);
            done(value);
          });
        });
        control!.send(JSON.stringify({ ...envelope, payload }));
        const response = await result;
        if (response.error) throw new Error(`${response.error}: ${response.message}`);
        return response.result;
      };
      const stop = async (signal: 'SIGTERM' | 'SIGKILL', expectedCode = 0) => {
        const ended = once(child!, 'close');
        if (signal === 'SIGKILL') killFixtureTree(child!.pid!);
        else {
          child!.kill(signal);
          child!.kill('SIGINT');
        }
        const [code, receivedSignal] = await ended;
        child = undefined;
        if (signal === 'SIGTERM') expect(code, logs).toBe(expectedCode);
        else expect(receivedSignal).toBe('SIGKILL');
      };
      try {
        await start();
        const registered = await operation('workspace.register', { path: workspace });
        const workspaceId = registered.workspace.id;
        const started = await operation('session.start', {
          workspaceId,
          runner: 'mar-agent',
          cwd: workspace,
          content: 'first unfinished request',
          clientMessageId: 'first-input',
          ...(mode === 'goal' ? { deferredCommands: [{ commandId: 'goal', input: '/goal' }] } : {}),
          modelId: model.id,
          effort: '',
          access: 'full-access',
          marAgentModel: model,
          marAgentModels: [model],
          secretEnvironment: { SYNTHETIC_TOKEN: 'before-restart' }
        });
        const sessionId = started.session.id;
        await vi.waitFor(() => expect(requests).toHaveLength(1), { timeout: 10000 });
        if (mode === 'native-steer') {
          const accepted = await operation('session.message', {
            sessionId,
            deliveryIntent: 'REPLACE_CURRENT',
            content: 'accepted native guidance',
            clientMessageId: 'native-guidance',
            marAgentModel: model,
            marAgentModels: [model]
          });
          expect(accepted.run?.id).toBe(started.run?.id);
          const history = await operation('session.turns.list', { sessionId, limit: 10 });
          expect(JSON.stringify(history).split('accepted native guidance')).toHaveLength(2);
          expect(requests).toHaveLength(1);
        }
        await operation('session.message', {
          sessionId,
          content: 'queued followup',
          clientMessageId: 'queued-input',
          marAgentModel: model,
          marAgentModels: [model]
        });
        await stop('SIGTERM');
        const saved = await readFile(join(data, 'planned-restart-handoff.json'), 'utf8');
        expect(saved).not.toContain('before-restart');
        const handoff = plannedRestartSchema.parse(openRestartState(saved, 'synthetic-credential'));
        const savedSession = handoff.sessions[0]!;
        expect(savedSession.session.id).toBe(sessionId);
        expect(savedSession.queue).toMatchObject([{ clientMessageId: 'queued-input' }]);
        if (mode === 'goal')
          expect(savedSession.goal!.goal).toMatchObject({
            sessionId,
            status: 'active',
            objective: 'first unfinished request',
            turns: 1
          });
        const originalExecution =
          handoff.sessions[0]!.current?.execution ?? handoff.sessions[0]!.execution;
        expect(originalExecution?.secretEnvironment).toMatchObject({
          SYNTHETIC_TOKEN: 'before-restart'
        });
        hold = false;
        await start();
        const resumedRequests = mode === 'goal' ? 4 : 3;
        await vi.waitFor(() => expect(requests, logs).toHaveLength(resumedRequests), {
          timeout: 15000
        });
        expect(authorizations).toBe(0);
        expect(JSON.stringify(requests[1])).toContain('system restart');
        if (mode === 'native-steer')
          expect(JSON.stringify(requests[1]).split('accepted native guidance')).toHaveLength(2);
        const history = await operation('session.turns.list', { sessionId, limit: 10 });
        expect(JSON.stringify(history)).toContain(
          mode === 'goal' ? 'mar_goal_continue' : 'mar_restart'
        );
        expect(JSON.stringify(history)).toContain('queued followup');
        if (mode === 'native-steer') {
          const pages = [history];
          let cursor = (history as { nextCursor?: string | null }).nextCursor;
          while (cursor && pages.length < 10) {
            const page = await operation('session.turns.list', { sessionId, limit: 10, cursor });
            pages.push(page);
            cursor = (page as { nextCursor?: string | null }).nextCursor;
          }
          expect(cursor).toBeFalsy();
          expect(JSON.stringify(pages).split('accepted native guidance')).toHaveLength(2);
        }
        if (mode === 'goal') {
          const { goal } = await operation('session.goal.get', { sessionId });
          const original = savedSession.goal!.goal;
          expect(goal).toMatchObject({
            id: original.id,
            revision: original.revision,
            startedAt: original.startedAt,
            revisionStartedAt: original.revisionStartedAt,
            status: 'completed',
            turns: original.turns + 1
          });
        }
        await operation('session.watch', {
          sessionId,
          workspaceId,
          watchId: 'reconnected',
          workbenchConnectionId: 'reconnected-page',
          mode: 'initial',
          unit: 'SEGMENT'
        });
        await vi.waitFor(
          () =>
            expect(watchEvents).toContainEqual(
              expect.objectContaining({
                type: 'watch.session.snapshot',
                payload: expect.objectContaining({
                  session: expect.objectContaining({ id: sessionId }),
                  queue: expect.objectContaining({ items: [], paused: false }),
                  runs: expect.not.arrayContaining([
                    expect.objectContaining({ id: started.run?.id })
                  ])
                })
              })
            ),
          { timeout: 5000 }
        );
        await expect(readFile(join(data, 'planned-restart-handoff.json'))).rejects.toMatchObject({
          code: 'ENOENT'
        });
        hold = true;
        await operation('session.message', {
          sessionId,
          content: 'do not recover a crash',
          clientMessageId: 'crash-input',
          marAgentModel: model,
          marAgentModels: [model]
        });
        await vi.waitFor(() => expect(requests).toHaveLength(resumedRequests + 1), {
          timeout: 10000
        });
        await stop('SIGKILL');
        await start();
        await operation('workspace.list');
        expect(authorizations).toBe(0);
        await expect(readFile(join(data, 'planned-restart-handoff.json'))).rejects.toMatchObject({
          code: 'ENOENT'
        });
        await operation('session.message', {
          sessionId,
          content: 'fail the handoff publication',
          clientMessageId: 'failed-handoff',
          marAgentModel: model,
          marAgentModels: [model]
        });
        await vi.waitFor(() => expect(requests).toHaveLength(resumedRequests + 2), {
          timeout: 10000
        });
        // A directory at the target path makes atomic publication fail.
        await mkdir(join(data, 'planned-restart-handoff.json'));
        await stop('SIGTERM', 1);
        const diagnostics = (await readFile(join(data, 'logs', 'node.log'), 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        expect(diagnostics).toContainEqual(
          expect.objectContaining({
            event: 'node.shutdown.failed',
            stage: 'publish',
            errorCode: 'EISDIR'
          })
        );
        expect(diagnostics).toContainEqual(
          expect.objectContaining({
            event: 'node.restart.diagnostic',
            code: 'RESTART_HANDOFF_SHUTDOWN_FAILED',
            errorCode: 'EISDIR'
          })
        );
        expect(JSON.stringify(diagnostics)).not.toContain('synthetic-key');
        expect(JSON.stringify(diagnostics)).not.toContain('synthetic-credential');
        await expect(readFile(join(data, 'planned-restart-handoff.json'))).rejects.toMatchObject({
          code: 'EISDIR'
        });
        expect(requests).toHaveLength(resumedRequests + 2);
      } finally {
        if (child && child.exitCode === null) {
          const ended = once(child, 'close');
          killFixtureTree(child.pid!);
          await ended;
        }
        for (const socket of sockets.clients) socket.terminate();
        await new Promise<void>((done) => sockets.close(() => done()));
        http.closeAllConnections();
        await new Promise<void>((done) => http.close(() => done()));
        await rm(root, { recursive: true, force: true });
      }
    },
    60000
  );
});

function killFixtureTree(pid: number): void {
  // The supervisor starts Node in its own process group, so killing only the
  // supervisor group leaves the real runtime alive and holding SQLite ownership.
  const processes = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number));
  const descendants = new Set([pid]);
  for (const parent of descendants)
    for (const [child, ppid] of processes)
      if (ppid === parent && child !== undefined) descendants.add(child);
  // Stop the supervisor first so it cannot restart a killed child.
  for (const target of descendants)
    try {
      process.kill(target, 'SIGKILL');
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error;
    }
}

function event(response: ServerResponse, value: unknown): void {
  response.write(`data: ${JSON.stringify(value)}${String.fromCharCode(10, 10)}`);
}
