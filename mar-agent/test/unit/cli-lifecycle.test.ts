import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// Exercise the packaged CLI against a loopback-only model, with per-test process ownership.
const homes: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
      child.kill('SIGKILL');
      await closed;
    })
  );
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    })
  );
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

function complete(response: ServerResponse) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(
    [
      { type: 'response.created', response: { id: 'fixture-response' } },
      {
        type: 'response.output_text.done',
        item_id: 'answer',
        phase: 'final_answer',
        text: 'Completed'
      },
      {
        type: 'response.completed',
        response: { id: 'fixture-response', usage: { input_tokens: 10, output_tokens: 2 } }
      }
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join('')
  );
}

async function fixture(
  onRequest?: (body: Record<string, unknown>, response: ServerResponse) => void
) {
  const requests: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (part) => (body += part));
    request.on('end', () => {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      requests.push(parsed);
      if (onRequest) onRequest(parsed, response);
      else complete(response);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind.');
  const home = await mkdtemp(join(tmpdir(), 'mar-cli-lifecycle-'));
  homes.push(home);
  await mkdir(join(home, '.mar', 'agent'), { recursive: true });
  await writeFile(
    join(home, '.mar', 'agent', 'models.json'),
    JSON.stringify({
      version: 1,
      defaultModelId: 'fixture',
      models: [
        {
          id: 'fixture',
          name: 'Fixture',
          protocol: 'OPENAI_RESPONSES',
          baseUrl: `http://127.0.0.1:${address.port}`,
          apiKey: 'fixture-key',
          modelId: 'fixture',
          contextWindowTokens: 200_000,
          maxOutputTokens: 4096,
          inputCapabilities: ['TEXT'],
          outputCapabilities: ['TEXT'],
          reasoningEfforts: ['low'],
          enabled: true,
          hostedWebSearch: false
        }
      ]
    })
  );
  return { home, requests };
}

function run(home: string, flags: string[] = [], interactive = false) {
  const child = spawn(
    process.execPath,
    [
      'dist/cli/main.js',
      '--home',
      home,
      '--format',
      'stream-json',
      ...flags,
      ...(interactive ? [] : ['run', 'Reply OK.'])
    ],
    { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] }
  );
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (part) => (stdout += part));
  child.stderr.setEncoding('utf8').on('data', (part) => (stderr += part));
  if (!interactive) child.stdin.end();
  const result = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, result };
}

function events(stdout: string): Record<string, unknown>[] {
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('CLI title control and lifecycle', () => {
  it('disables title generation without changing the model prompt or conversation metering', async () => {
    const { home, requests } = await fixture();
    const result = await run(home, ['--no-auto-title']).result;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: '' });
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0])).not.toContain('--no-auto-title');
    expect(requests[0]?.input).toEqual(
      expect.arrayContaining([{ role: 'user', content: 'Reply OK.' }])
    );
    const usage = events(result.stdout).filter((event) => event.type === 'model.usage');
    expect(usage).toContainEqual(
      expect.objectContaining({
        purpose: 'conversation',
        state: 'succeeded',
        inputTokens: '10',
        outputTokens: '2'
      })
    );
    expect(usage.some((event) => event.purpose === 'title')).toBe(false);
  });

  it.each([{ flags: [] }, { flags: ['--auto-title'] }])(
    'keeps automatic titles enabled with flags $flags and meters their requests separately',
    async ({ flags }) => {
      const { home, requests } = await fixture();
      const result = await run(home, flags).result;
      expect(result).toMatchObject({ code: 0, signal: null, stderr: '' });
      expect(requests).toHaveLength(2);
      const allEvents = events(result.stdout);
      const title = allEvents.find(
        (event) =>
          event.type === 'model.usage' && event.purpose === 'title' && event.state === 'succeeded'
      );
      const conversation = allEvents.find(
        (event) =>
          event.type === 'model.usage' &&
          event.purpose === 'conversation' &&
          event.state === 'succeeded'
      );
      expect(title).toMatchObject({
        inputTokens: '10',
        outputTokens: '2',
        agentRole: 'root',
        recordId: expect.any(String),
        requestId: expect.any(String),
        revision: expect.any(Number)
      });
      expect(conversation).toMatchObject({
        sessionId: title?.sessionId,
        executionId: title?.executionId
      });
      expect(conversation?.requestId).not.toBe(title?.requestId);
      expect(
        allEvents
          .filter((event) => event.type === 'usage.updated')
          .every((event) => event.purpose !== 'title')
      ).toBe(true);
      const index = JSON.parse(
        await readFile(join(home, '.mar', 'agent', 'sessions', 'index.json'), 'utf8')
      );
      expect(index.sessions).toEqual([
        expect.objectContaining({ title: 'Completed', automaticTitlePending: false })
      ]);
    }
  );

  it('rejects conflicting title flags before starting a request', async () => {
    const { home, requests } = await fixture();
    const result = await run(home, ['--auto-title', '--no-auto-title']).result;
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('MAR_AGENT_CLI_ARGUMENT_INVALID');
    expect(requests).toHaveLength(0);
  });

  it.runIf(process.platform !== 'win32').each([
    ['SIGINT', 130],
    ['SIGTERM', 143]
  ] as const)(
    'cancels a live request and disposes on %s without overwriting exit code %s',
    async (signal, code) => {
      let child: ChildProcess;
      let requestClosed = false;
      const { home } = await fixture((_body, response) => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(
          `data: ${JSON.stringify({ type: 'response.created', response: { id: 'pending' } })}\n\n`
        );
        response.on('close', () => (requestClosed = true));
        child.kill(signal);
      });
      const running = run(home, ['--no-auto-title']);
      child = running.child;
      const result = await running.result;
      expect(result).toMatchObject({ code, signal: null, stderr: '' });
      expect(events(result.stdout)).toContainEqual(
        expect.objectContaining({ type: 'execution.cancelled' })
      );
      expect(requestClosed).toBe(true);
    }
  );

  it.runIf(process.platform !== 'win32').each([
    { signal: 'SIGTERM', code: 143, interactive: false },
    { signal: 'SIGINT', code: 130, interactive: true }
  ] as const)(
    '$signal exits while a title is pending after the main answer completed (interactive=$interactive)',
    async ({ signal, code, interactive }) => {
      let child: ChildProcess;
      let mainCompleted = false;
      let titleResponse: ServerResponse | undefined;
      let titleClosed = false;
      let cancelled = false;
      const cancelWhenReady = () => {
        if (mainCompleted && titleResponse && !cancelled) {
          cancelled = true;
          child.kill(signal);
        }
      };
      const { home } = await fixture((body, response) => {
        if (JSON.stringify(body).includes('session title generator')) {
          titleResponse = response;
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.write(
            `data: ${JSON.stringify({ type: 'response.created', response: { id: 'title-pending' } })}\n\n`
          );
          response.on('close', () => (titleClosed = true));
          cancelWhenReady();
        } else complete(response);
      });
      const running = run(home, [], interactive);
      child = running.child;
      let lines = '';
      let prompted = false;
      child.stdout?.on('data', (chunk) => {
        lines += chunk;
        if (interactive && !prompted && lines.includes('> ')) {
          prompted = true;
          child.stdin?.write('Reply OK.\n');
        }
        if (lines.includes('"type":"execution.completed"')) {
          mainCompleted = true;
          cancelWhenReady();
        }
      });
      const result = await running.result;
      expect(result).toMatchObject({ code, signal: null, stderr: '' });
      expect(titleClosed).toBe(true);
      const allEvents = events(interactive ? result.stdout.replace(/^> /gm, '') : result.stdout);
      expect(allEvents).toContainEqual(expect.objectContaining({ type: 'execution.completed' }));
      expect(allEvents).toContainEqual(
        expect.objectContaining({ type: 'model.usage', purpose: 'title', state: 'cancelled' })
      );
    }
  );

  it.runIf(process.platform !== 'win32')(
    'exits an idle prompt on SIGTERM without starting an execution',
    async () => {
      const { home, requests } = await fixture();
      const running = run(home, ['--no-auto-title'], true);
      let prompted = false;
      running.child.stdout.on('data', (chunk) => {
        if (String(chunk).includes('> ')) {
          prompted = true;
          running.child.kill('SIGTERM');
        }
      });
      const result = await running.result;
      expect(result).toMatchObject({ code: 143, signal: null, stderr: '' });
      expect(prompted).toBe(true);
      expect(requests).toHaveLength(0);
    }
  );

  it.runIf(process.platform !== 'win32')(
    'disposes a Session-owned warm process on SIGTERM',
    async () => {
      let child: ChildProcess;
      let ownedPid: number | undefined;
      let turns = 0;
      const { home } = await fixture((_body, response) => {
        if (++turns === 1) {
          const script = `require('node:fs').writeFileSync(${JSON.stringify(join(home, 'owned-pid'))}, String(process.pid));setInterval(()=>{},1000);`;
          const item = {
            type: 'function_call',
            id: 'item-exec',
            call_id: 'call-exec',
            name: 'exec',
            arguments: JSON.stringify({
              command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
              yieldMs: 1000
            })
          };
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.end(
            [
              { type: 'response.output_item.done', item },
              {
                type: 'response.completed',
                response: {
                  id: 'tool-response',
                  output: [item],
                  usage: { input_tokens: 10, output_tokens: 2 }
                }
              }
            ]
              .map((event) => `data: ${JSON.stringify(event)}\n\n`)
              .join('')
          );
          return;
        }
        ownedPid = Number(readFileSync(join(home, 'owned-pid'), 'utf8'));
        process.kill(ownedPid, 0);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.flushHeaders();
        child.kill('SIGTERM');
      });
      try {
        const running = run(home, ['--no-auto-title']);
        child = running.child;
        const result = await running.result;
        expect(result).toMatchObject({ code: 143, signal: null, stderr: '' });
        expect(turns).toBe(2);
        expect(ownedPid).toBeGreaterThan(0);
        expect(() => process.kill(ownedPid!, 0)).toThrow(
          expect.objectContaining({ code: 'ESRCH' })
        );
      } finally {
        if (ownedPid) {
          try {
            process.kill(ownedPid, 'SIGKILL');
          } catch {
            /* Already reaped by the CLI. */
          }
        }
      }
    }
  );
});
