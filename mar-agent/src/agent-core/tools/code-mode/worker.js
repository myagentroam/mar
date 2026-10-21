import { createInterface } from 'node:readline';

// The worker evaluates only a trusted engine module. Model source is passed as data to that engine.
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const pending = new Map();
const controller = new AbortController();
let sequence = 0;
let started = false;
lines.on('line', async (line) => {
  let engine;
  try {
    const frame = JSON.parse(line);
    if (started) {
      const deferred = pending.get(frame.id);
      if (!deferred) return;
      pending.delete(frame.id);
      if (frame.ok) deferred.resolve(frame.output);
      else
        deferred.reject(Object.assign(new Error(frame.error.message), { code: frame.error.code }));
      return;
    }
    started = true;
    const { createCodeModeEngine } = await import(frame.engine.moduleUrl);
    engine = await createCodeModeEngine(frame.engine.options ?? {});
    const result = await engine.execute({
      code: frame.code,
      tools: frame.tools,
      catalog: frame.catalog,
      state: frame.state,
      limits: frame.limits,
      signal: controller.signal,
      onText: (value, originalBytes) => send({ kind: 'text', value, originalBytes }),
      onImage: (value) => send({ kind: 'image', value }),
      onYield: () => send({ kind: 'yield' }),
      onObserve: (value) => send({ kind: 'observe', observation: value }),
      onToolCall: (call) =>
        new Promise((resolve, reject) => {
          const id = ++sequence;
          pending.set(id, { resolve, reject });
          send({
            kind: 'call',
            id,
            operationId: call.callId,
            name: call.name,
            arguments: call.arguments
          });
        })
    });
    if (pending.size)
      throw Object.assign(new Error('Unawaited tool calls remain.'), {
        code: 'MAR_AGENT_CODE_INCOMPLETE'
      });
    await engine.dispose();
    engine = undefined;
    await new Promise((resolve) =>
      process.stdout.write(
        JSON.stringify({ kind: 'done', stateMutations: result.stateMutations }) + '\n',
        resolve
      )
    );
  } catch (error) {
    controller.abort(error);
    for (const deferred of pending.values()) deferred.reject(error);
    pending.clear();
    try {
      await engine?.dispose();
    } catch {
      // Report the original engine failure even if disposal also fails.
    }
    await new Promise((resolve) =>
      process.stdout.write(
        JSON.stringify({
          kind: 'error',
          code: typeof error?.code === 'string' ? error.code : 'MAR_AGENT_CODE_ENGINE_FAILED',
          message: String(error?.message ?? error).slice(0, 4096)
        }) + '\n',
        resolve
      )
    );
  }
});
