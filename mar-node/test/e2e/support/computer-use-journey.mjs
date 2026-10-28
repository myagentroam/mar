import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// Isolated acceptance only: real Node Runner, SDK and Worker; scripted HTTP model.
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const { output, nodeDist, runtime, code, cancelCode, work } = config;
const home = join(output, 'isolated-home');
await mkdir(home);
process.env.HOME = home;
process.env.USERPROFILE = home;
const load = (file) => import(pathToFileURL(join(nodeDist, file)).href);
const { MarAgentManagedRunController, resolveRunModels } = await load(
  'runner/mar-agent/managed-run-controller.js'
);
const { MarAgentRunner } = await load('runner/mar-agent-runner.js');
const { PyAutoGuiComputerUseProvider } = await load('runner/mar-agent/computer-use.js');
const { ComputerUseDesktopLeaseService } = await load('computer-use/session.js');
const lease = new ComputerUseDesktopLeaseService();
const provider = new PyAutoGuiComputerUseProvider(
  { enabled: true, runtimeExecutable: runtime },
  {
    lease,
    ...(config.fakeIndicator
      ? { showControlIndicator: async () => ({ close: async () => {} }) }
      : {})
  }
);
const events = [],
  results = [],
  pictures = [];
let diagnosticBinding;
let stage = 0,
  taskId,
  observationId,
  controller,
  cancelling = false,
  explicitCancel = false,
  cancelled = false;
let runId = 'async-normal',
  nativeSessionId,
  modelRequests = 0,
  terminalStatus;
const waitForFile = async (path) => {
  const deadline = Date.now() + 10000;
  while (true) {
    try {
      await access(path);
      return;
    } catch {}
    if (Date.now() >= deadline) {
      if (diagnosticBinding && taskId) {
        try {
          const state = await diagnosticBinding.call(
            { name: 'mcp__mar_computer__wait', arguments: { taskId, yieldMs: 0 } },
            new AbortController().signal
          );
          events.push({ phase: 'milestone-task-state', data: state.data, content: state.content });
        } catch (error) {
          events.push({ phase: 'milestone-task-error', code: error.code, message: error.message });
        }
      }
      throw new Error('fixture milestone was not reached');
    }
    await delay(10);
  }
};
function reply(response, tool, args) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (type, data) =>
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send('message_start', {
    message: {
      id: `message-${modelRequests}`,
      type: 'message',
      role: 'assistant',
      model: 'fixture',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 0 }
    }
  });
  send('content_block_start', {
    index: 0,
    content_block: tool
      ? { type: 'tool_use', id: `tool-${modelRequests}`, name: tool, input: {} }
      : { type: 'text', text: '' }
  });
  send('content_block_delta', {
    index: 0,
    delta: tool
      ? { type: 'input_json_delta', partial_json: JSON.stringify(args) }
      : { type: 'text_delta', text: 'Verified.' }
  });
  send('content_block_stop', { index: 0 });
  send('message_delta', {
    delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: 12 }
  });
  send('message_stop', {});
  response.end();
}
const server = createServer(async (request, response) => {
  try {
    if (request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'image/png' });
      return response.end(pictures.at(-1));
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert(Array.isArray(body.messages));
    assert(++modelRequests <= 12, 'bounded model request budget');
    const step = stage++;
    if (cancelling) {
      if (step === 0)
        return reply(response, 'mcp__mar_computer__exec', {
          code: cancelCode,
          yieldMs: 0,
          timeoutMs: 30000
        });
      if (explicitCancel && step === 2)
        return reply(response, 'mcp__mar_computer__exec', { code: '' });
      if (explicitCancel && step === 3) return reply(response);
      assert.equal(step, 1);
      await waitForFile(join(output, 'cancel-started'));
      return reply(response, 'mcp__mar_computer__wait', {
        taskId,
        yieldMs: 10000,
        ...(explicitCancel ? { action: 'cancel' } : {})
      });
    }
    if (step === 0) return reply(response, 'mcp__mar_computer__exec', { code: '' });
    if (step === 1)
      return reply(response, 'mcp__mar_computer__exec', {
        code,
        yieldMs: 0,
        basedOnObservationId: observationId
      });
    if (step === 2) {
      await waitForFile(join(output, 'started'));
      const command = `node "${work}"`;
      if (body.tools.some((tool) => tool.name === 'exec'))
        return reply(response, 'exec', { command });
      return reply(response, 'code_exec', {
        code: `observe.result(await tools.exec({command:${JSON.stringify(command)}}));`
      });
    }
    if (step === 3) {
      await waitForFile(join(output, 'work-done'));
      return reply(response, 'mcp__mar_computer__wait', { taskId, yieldMs: 10000 });
    }
    assert.equal(step, 4);
    reply(response);
  } catch (error) {
    events.push({ phase: 'fixture-error', message: error.message });
    controller.cancel(runId, 'CANCEL');
    response.writeHead(500);
    response.end('Fixture failed.');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const bind = provider.bind.bind(provider);
provider.bind = async (input) => {
  assert(input.signal instanceof AbortSignal, 'Runner must supply the Execution signal');
  const binding = await bind(input);
  assert(binding);
  diagnosticBinding = binding;
  return {
    ...binding,
    call: async (call, signal) => {
      const pending = binding.call(call, signal);
      if (cancelling && !explicitCancel && call.name === 'mcp__mar_computer__wait') {
        cancelled = controller.cancel(runId, 'CANCEL');
      }
      let result;
      try {
        result = await pending;
      } catch (error) {
        results.push({ runId, tool: call.name, code: error.code });
        throw error;
      }
      results.push({
        runId,
        tool: call.name,
        codeLength:
          typeof call.arguments?.code === 'string' ? call.arguments.code.length : undefined,
        data: result.data,
        content: result.content
      });
      if (result.data.taskId) taskId = result.data.taskId;
      if (result.data.observationId) observationId = result.data.observationId;
      for (const image of result.images ?? []) {
        const bytes = Buffer.from(image.dataBase64, 'base64');
        pictures.push(bytes);
        await writeFile(join(output, `runner-image-${pictures.length}.png`), bytes, { flag: 'wx' });
      }
      return result;
    }
  };
};
const active = new Set();
const host = {
  executionAccepted: (id) => active.add(id),
  isExecutionActive: (id) => active.has(id),
  adopt() {},
  promote(_id, nativeId) {
    nativeSessionId = nativeId;
  },
  customTitle() {
    return 'Async acceptance';
  },
  async syncTitle() {},
  emit(_id, event, payload, status) {
    if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(status)) {
      terminalStatus = status;
      active.delete(_id);
    }
    if (event === 'run.failed') events.push({ event, payload });
  },
  emitItem(_id, item) {
    if (item.kind === 'error') events.push({ phase: 'runner-error', payload: item.payload });
  },
  run() {},
  commandState() {},
  setCommandState() {},
  clearCommandState() {},
  commandStates() {
    return [];
  },
  async webSearch() {
    throw new Error('Unexpected web search');
  }
};
controller = new MarAgentManagedRunController(new MarAgentRunner(), host, {
  computerUse: provider,
  generateTitle: async () => undefined,
  publishModelResource: async (resource) => ({
    url: `${baseUrl}/images/${resource.resourceId}`,
    urlExpiresAt: Date.now() + 60000
  })
});
const configuration = {
  id: 'fixture',
  name: 'Fixture',
  protocol: 'ANTHROPIC_MESSAGES',
  baseUrl,
  apiKey: 'fixture-not-a-credential',
  modelId: 'fixture',
  contextWindowTokens: 200000,
  maxOutputTokens: 4096,
  inputCapabilities: ['TEXT', 'IMAGE'],
  outputCapabilities: ['TEXT'],
  reasoningEfforts: [],
  hostedWebSearch: false,
  responsesPreviousResponseId: false,
  enabled: true
};
const model = resolveRunModels(configuration, [configuration])[0];
const input = {
  sessionId: 'cu-acceptance',
  input: 'Complete the bounded desktop task, perform independent work, wait and inspect.',
  cwd: output,
  model,
  models: [model],
  effort: '',
  access: 'full-access',
  mode: 'run',
  mcpServers: [],
  images: [],
  computerUseEnabled: true
};
const watchdog = setTimeout(() => controller.cancel(runId, 'CANCEL'), 45000);
try {
  await controller.run({ ...input, runId });
  assert.equal(terminalStatus, 'SUCCEEDED', JSON.stringify(events));
  assert.equal(stage, 5);
  assert(results.some((r) => r.data.status === 'RUNNING'));
  assert(results.some((r) => r.tool.endsWith('__wait') && r.data.outcome === 'SUCCEEDED'));
  assert.equal(lease.holder(), undefined);
  assert.equal(pictures.length, 2);
  cancelling = true;
  explicitCancel = true;
  stage = 0;
  runId = 'explicit-cancel';
  terminalStatus = undefined;
  await controller.run({ ...input, runId, externalSessionId: nativeSessionId });
  assert.equal(terminalStatus, 'SUCCEEDED', JSON.stringify(events));
  assert(results.some((r) => r.runId === runId && r.data?.outcome === 'OUTCOME_UNKNOWN'));
  assert(results.some((r) => r.runId === runId && r.data?.outcome === 'SUCCEEDED'));
  assert.equal(lease.holder(), undefined);
  await rm(join(output, 'cancel-started'));
  explicitCancel = false;
  stage = 0;
  runId = 'async-cancel';
  terminalStatus = undefined;
  await controller.run({ ...input, runId, externalSessionId: nativeSessionId });
  assert(cancelled, 'Run cancellation was not accepted');
  assert.equal(terminalStatus, 'CANCELLED', JSON.stringify(events));
  assert(results.some((r) => r.runId === runId && r.code === 'COMPUTER_WAIT_CANCELLED'));
  const workerPid = Number(await readFile(join(output, 'cancel-started'), 'utf8'));
  assert(Number.isInteger(workerPid) && workerPid > 0);
  assert.throws(() => process.kill(workerPid, 0), 'cancelled Worker is still alive');
  assert.equal(lease.holder(), undefined);
  await controller.dispose();
  await writeFile(
    join(output, 'runner-report.json'),
    JSON.stringify(
      {
        scope:
          'real ManagedRunController + SDK + HTTP scripted model + MCP + Python Worker; desktop determined by supplied runtime',
        modelRequests,
        results,
        events,
        leaseReleased: true,
        executionCancellation: true
      },
      null,
      2
    ),
    { flag: 'wx' }
  );
  console.log('RUNNER_JOURNEY_OK');
} finally {
  clearTimeout(watchdog);
  await controller.dispose();
  await writeFile(
    join(output, 'runner-diagnostics.json'),
    JSON.stringify({ modelRequests, results, events, terminalStatus }, null, 2)
  );
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
