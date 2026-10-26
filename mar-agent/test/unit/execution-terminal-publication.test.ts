import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { MarAgentError } from '../../src/agent-core/error.js';
import type { ModelEvent } from '../../src/agent-core/model/contracts.js';
import type { MarAgentEvent } from '../../src/index.js';
import { JsonlSessionStore } from '../../src/agent-core/session/store/index.js';
import { answer, cleanupCoreFixtures, fixture } from './support/core-extension-fixture.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupCoreFixtures();
});

const terminalTypes = ['execution.completed', 'execution.failed', 'execution.cancelled'];

it.each([
  { outcome: 'completed', publication: 'sync' },
  { outcome: 'completed', publication: 'async' },
  { outcome: 'failed', publication: 'async' },
  { outcome: 'cancelled', publication: 'async' }
] as const)(
  'keeps the committed $outcome outcome when terminal Host publication fails ($publication)',
  async ({ outcome, publication }) => {
    const warmDisposed = vi.fn();
    const f = await fixture(
      [
        {
          id: 'publication-resource',
          apiVersion: '1.0',
          attachSession(context) {
            context.resources.effect(() => warmDisposed);
          }
        }
      ],
      answer
    );
    const started = Promise.withResolvers<void>();
    let firstExecution = true;
    vi.spyOn(f.adapter, 'start').mockImplementation(
      async function* (_request, signal): AsyncGenerator<ModelEvent> {
        started.resolve();
        if (firstExecution && outcome === 'failed')
          throw new MarAgentError('ORIGINAL_MODEL_FAILURE', 'Original model failure.');
        if (firstExecution && outcome === 'cancelled') {
          if (!signal.aborted)
            await new Promise<void>((resolve) =>
              signal.addEventListener('abort', () => resolve(), { once: true })
            );
          signal.throwIfAborted();
        }
        yield* answer();
      }
    );
    const close = vi.fn(async () => undefined);
    Object.assign(f.adapter, {
      createTurnSession: () => ({ start: f.adapter.start.bind(f.adapter), close })
    });
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const failure = new MarAgentError('HOST_OFFLINE', 'Host observation failed.');
    const emit = f.host.emit.bind(f.host);
    const publish = vi.spyOn(f.host, 'emit').mockImplementation((event) => {
      if (firstExecution && event.type === `execution.${outcome}`) {
        if (publication === 'sync') throw failure;
        return Promise.reject(failure);
      }
      return emit(event);
    });
    const handle = f.session.run({ prompt: 'Finish the isolated task.' });
    const events: MarAgentEvent[] = [];
    const stream = (async () => {
      for await (const event of handle) events.push(event);
    })();
    const result = handle.result();
    if (outcome === 'cancelled') {
      await started.promise;
      handle.cancel();
    }
    await expect(result).resolves.toMatchObject({
      status: outcome,
      ...(outcome === 'failed'
        ? {
            errorCode: 'ORIGINAL_MODEL_FAILURE',
            errorMessage: 'Original model failure.'
          }
        : {}),
      ...(outcome === 'completed' ? { finalAnswer: 'done' } : {})
    });
    await stream;
    expect(handle.persistedEvents).toBe(true);
    const terminals = events.filter((event) => terminalTypes.includes(event.type));
    expect(terminals.map((event) => event.type)).toEqual([`execution.${outcome}`]);
    const transcript = join(
      f.home,
      '.mar',
      'agent',
      'sessions',
      f.session.id,
      'events-000001.jsonl'
    );
    const records = (await readFile(transcript, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(
      records.filter(
        (record) => record.executionId === handle.executionId && terminalTypes.includes(record.type)
      )
    ).toEqual([expect.objectContaining({ type: `execution.${outcome}`, payload: terminals[0] })]);
    expect(publish.mock.calls.filter(([event]) => terminalTypes.includes(event.type))).toHaveLength(
      1
    );
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'MAR_AGENT_HOST_EVENT_PUBLICATION_FAILED',
        message: `MAR_AGENT_HOST_EVENT_PUBLICATION_FAILED: Host publication of execution.${outcome} failed for Execution ${handle.executionId}.`,
        details: expect.objectContaining({
          sessionId: f.session.id,
          executionId: handle.executionId,
          eventId: terminals[0]!.eventId,
          eventType: `execution.${outcome}`
        })
      })
    );
    expect(close).toHaveBeenCalledTimes(1);
    expect(warmDisposed).not.toHaveBeenCalled();
    await expect(
      readFile(join(f.home, '.mar', 'agent', 'sessions', f.session.id, 'lock'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    firstExecution = false;
    await expect(
      f.session.run({ prompt: 'Continue after publication failure.' }).result()
    ).resolves.toMatchObject({ status: 'completed' });
    expect(close).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledTimes(1);
    await f.agent.clearSession(f.session.id);
    expect(warmDisposed).toHaveBeenCalledTimes(1);
  }
);

it.each(['error-with-cause', 'unbounded-code', 'string'] as const)(
  'diagnoses terminal publication without exposing private Host data (%s)',
  async (kind) => {
    const privateMessage = 'Violet canyon forecast: 47 unannounced projects.';
    const privateCause = 'Cobalt meadow: unpublished acquisition terms.';
    const externalCode = `EXTERNAL_${'q'.repeat(4096)}`;
    const failure =
      kind === 'error-with-cause'
        ? new Error(privateMessage, { cause: new Error(privateCause) })
        : kind === 'unbounded-code'
          ? new MarAgentError(externalCode, privateMessage, {
              cause: new Error(privateCause),
              details: { privateText: privateCause }
            })
          : privateMessage;
    const f = await fixture([], answer);
    const emit = f.host.emit.bind(f.host);
    vi.spyOn(f.host, 'emit').mockImplementation((event) => {
      if (event.type === 'execution.completed') return Promise.reject(failure);
      return emit(event);
    });
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const handle = f.session.run({ prompt: 'Finish without publishing private Host data.' });
    const events: MarAgentEvent[] = [];
    for await (const event of handle) events.push(event);
    await expect(handle.result()).resolves.toMatchObject({
      status: 'completed',
      finalAnswer: 'done'
    });
    const terminals = events.filter((event) => terminalTypes.includes(event.type));
    expect(terminals.map((event) => event.type)).toEqual(['execution.completed']);
    expect(handle.persistedEvents).toBe(true);
    const store = await JsonlSessionStore.open(f.home);
    try {
      expect(
        (await store.read(f.session.id)).filter(
          (record) =>
            record.executionId === handle.executionId && terminalTypes.includes(record.type)
        )
      ).toEqual([expect.objectContaining({ type: 'execution.completed', payload: terminals[0] })]);
    } finally {
      await store.close();
    }
    expect(warning).toHaveBeenCalledTimes(1);
    const diagnostic = warning.mock.calls[0]![0] as MarAgentError;
    const output = inspect(warning.mock.calls[0], { depth: null, showHidden: true });
    expect(output).not.toContain(privateMessage);
    expect(output).not.toContain(privateCause);
    expect(output).not.toContain(externalCode.slice(0, 128));
    expect(diagnostic.code).toBe('MAR_AGENT_HOST_EVENT_PUBLICATION_FAILED');
    expect(diagnostic.message).toBe(
      `MAR_AGENT_HOST_EVENT_PUBLICATION_FAILED: Host publication of execution.completed failed for Execution ${handle.executionId}.`
    );
    expect(diagnostic.cause).toBeUndefined();
    expect(diagnostic.details).toEqual({
      sessionId: f.session.id,
      executionId: handle.executionId,
      eventId: terminals[0]!.eventId,
      eventType: 'execution.completed'
    });
  }
);

it('does not isolate a nonterminal Host failure as a committed terminal publication failure', async () => {
  const f = await fixture([], answer);
  const emit = f.host.emit.bind(f.host);
  vi.spyOn(f.host, 'emit').mockImplementation((event) => {
    if (event.type === 'execution.started')
      throw new MarAgentError('HOST_START_FAILED', 'Host start failed.');
    return emit(event);
  });
  const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
  const handle = f.session.run({ prompt: 'Fail before completion.' });
  const events: MarAgentEvent[] = [];
  for await (const event of handle) events.push(event);
  await expect(handle.result()).resolves.toMatchObject({
    status: 'failed',
    errorCode: 'HOST_START_FAILED'
  });
  expect(
    events.filter((event) => terminalTypes.includes(event.type)).map((event) => event.type)
  ).toEqual(['execution.failed']);
  expect(warning).not.toHaveBeenCalled();
});

it('keeps a completed terminal append failure on the Store failure path', async () => {
  const f = await fixture([], answer);
  const append = JsonlSessionStore.prototype.append;
  vi.spyOn(JsonlSessionStore.prototype, 'append').mockImplementation(async function (
    this: JsonlSessionStore,
    id,
    record,
    options
  ) {
    if (id === f.session.id && record.type === 'execution.completed')
      throw Object.assign(new Error('Terminal append failed before writing.'), { code: 'ENOSPC' });
    return append.call(this, id, record, options);
  });
  const publish = vi.spyOn(f.host, 'emit');
  const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
  const handle = f.session.run({ prompt: 'Fail terminal persistence.' });
  const events: MarAgentEvent[] = [];
  for await (const event of handle) events.push(event);
  await expect(handle.result()).resolves.toMatchObject({
    status: 'failed',
    errorCode: 'ENOSPC',
    errorMessage: 'Terminal append failed before writing.'
  });
  const terminals = events.filter((event) => terminalTypes.includes(event.type));
  expect(terminals.map((event) => event.type)).toEqual(['execution.failed']);
  expect(publish.mock.calls.some(([event]) => event.type === 'execution.completed')).toBe(false);
  expect(handle.persistedEvents).toBe(true);
  const store = await JsonlSessionStore.open(f.home);
  try {
    expect(
      (await store.read(f.session.id)).filter(
        (record) => record.executionId === handle.executionId && terminalTypes.includes(record.type)
      )
    ).toEqual([expect.objectContaining({ type: 'execution.failed', payload: terminals[0] })]);
  } finally {
    await store.close();
  }
  expect(warning).not.toHaveBeenCalled();
});

it('does not let a failing publication diagnostic sink rewrite a committed success', async () => {
  const f = await fixture([], answer);
  const emit = f.host.emit.bind(f.host);
  vi.spyOn(f.host, 'emit').mockImplementation((event) => {
    if (event.type === 'execution.completed') throw new Error('Host publication failed.');
    return emit(event);
  });
  vi.spyOn(process, 'emitWarning').mockImplementation(() => {
    throw new Error('Diagnostic sink failed.');
  });
  const handle = f.session.run({ prompt: 'Finish despite observation failures.' });
  const events: MarAgentEvent[] = [];
  for await (const event of handle) events.push(event);
  await expect(handle.result()).resolves.toMatchObject({ status: 'completed' });
  expect(
    events.filter((event) => terminalTypes.includes(event.type)).map((event) => event.type)
  ).toEqual(['execution.completed']);
});
