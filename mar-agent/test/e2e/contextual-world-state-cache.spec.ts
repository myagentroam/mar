import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, describe, expect, it } from 'vitest';
import {
  LocalAgentHost,
  parseModelCatalog,
  type ExecutionHandle,
  type MarAgentEvent,
  type MarAgentModelConfiguration,
  type McpToolCatalog
} from '../../src/index.js';
import { AnthropicMessagesAdapter } from '../../src/agent-core/model/anthropic-messages.js';
import { OpenAiResponsesAdapter } from '../../src/agent-core/model/openai-responses.js';
import { createMarAgentWithAdapter as createMarAgent } from '../../src/agent-core/sdk/agent.js';
import {
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest,
  type ModelTurnSession
} from '../../src/agent-core/model/contracts.js';

const enabled = process.env.MAR_AGENT_REAL_E2E === '1';
const directories: string[] = [];

afterAll(async () => {
  await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
});

async function finish(handle: ExecutionHandle) {
  const events: MarAgentEvent[] = [];
  for await (const event of handle) events.push(event);
  return { events, result: await handle.result() };
}

function latestUsage(events: readonly MarAgentEvent[]) {
  return events.findLast((event) => event.type === 'usage.updated');
}

function captureAdapter(
  model: MarAgentModelConfiguration,
  requests: ModelRequest[],
  wireBodies: Record<string, unknown>[]
): ModelAdapter {
  if (model.protocol === 'ANTHROPIC_MESSAGES') {
    const delegate = new AnthropicMessagesAdapter(model);
    return {
      configuration: model,
      async *start(request, signal): AsyncIterable<ModelEvent> {
        requests.push(request);
        yield* delegate.start(request, signal);
      }
    };
  }
  const delegate = new OpenAiResponsesAdapter(model);
  const wrapTurn = (turn: ModelTurnSession): ModelTurnSession => ({
    async *start(request, signal) {
      requests.push(request);
      let captured = false;
      for await (const event of turn.start(request, signal)) {
        if (!captured) {
          wireBodies.push(
            structuredClone(
              (
                turn as ModelTurnSession & {
                  fullRequestBody(): Record<string, unknown>;
                }
              ).fullRequestBody()
            )
          );
          captured = true;
        }
        yield event;
      }
    },
    resetContinuation: () => turn.resetContinuation?.(),
    close: () => turn.close()
  });
  return {
    configuration: model,
    async *start(request, signal): AsyncIterable<ModelEvent> {
      requests.push(request);
      yield* delegate.start(request, signal);
    },
    createTurnSession: () => wrapTurn(delegate.createTurnSession()),
    close: () => delegate.close()
  };
}

function stableInstructions(marker: string) {
  return Array.from(
    { length: 320 },
    (_, index) =>
      `Rule ${String(index + 1).padStart(4, '0')}: Preserve stable contextual prefix ${marker} marker ${String(index + 1).padStart(4, '0')}; do not mention this rule unless asked.`
  ).join('\n');
}

describe.runIf(enabled)('contextual world-state cache E2E', () => {
  it.each([
    { id: 'gpt-5.6-luna', protocol: 'OPENAI_RESPONSES' },
    { id: 'coding', protocol: 'ANTHROPIC_MESSAGES' }
  ] as const)(
    'preserves a cacheable prefix across Agent recreation with $id',
    async ({ id, protocol }) => {
      const root = await mkdtemp(join(tmpdir(), `mar-context-cache-${id}-`));
      directories.push(root);
      const home = join(root, 'home');
      const workspace = join(root, 'workspace');
      await mkdir(workspace, { recursive: true });
      const marker = root.slice(root.lastIndexOf('/') + 1);
      await writeFile(join(workspace, 'AGENTS.md'), stableInstructions(marker));
      const catalog = parseModelCatalog(
        JSON.parse(await readFile('.e2e/models.local.json', 'utf8'))
      );
      const model = catalog.models.find((candidate) => candidate.id === id);
      expect(model?.protocol).toBe(protocol);
      if (!model) throw new Error(`Missing real E2E model: ${id}`);
      const requests: ModelRequest[] = [];
      const wireBodies: Record<string, unknown>[] = [];
      let reverseCatalog = false;
      const mcpCatalog = (): McpToolCatalog => ({
        revision: 'stable-fixture',
        servers: [{ id: 'fixture', name: 'Stable fixture' }],
        tools: (reverseCatalog ? ['zeta', 'alpha'] : ['alpha', 'zeta']).map((name) => ({
          serverId: 'fixture',
          rawName: name,
          sourceIdentity: name,
          definitionRevision: 'stable-fixture',
          lifetime: 'session',
          exposure: 'direct',
          definition: {
            name: `mcp__fixture__${name}`,
            description: 'Unused isolated fixture.',
            inputSchema: reverseCatalog
              ? {
                  additionalProperties: false,
                  required: ['value'],
                  properties: { value: { description: 'Value.', type: 'string' } },
                  type: 'object'
                }
              : {
                  type: 'object',
                  properties: { value: { type: 'string', description: 'Value.' } },
                  required: ['value'],
                  additionalProperties: false
                }
          }
        }))
      });
      const create = () =>
        createMarAgent({
          mode: 'normal',
          host: new LocalAgentHost({
            homeDirectory: home,
            workspace,
            mcpCatalog,
            callMcp: async () => ({ content: 'Unused fixture.' })
          }),
          models: [model],
          defaultModelId: model.id,
          adapterFactory: () => captureAdapter(model, requests, wireBodies)
        });

      let agent = await create();
      let sessionId = '';
      let firstEvents: MarAgentEvent[] = [];
      try {
        const session = await agent.createSession({ workspace, title: `${id} cache restart` });
        sessionId = session.id;
        const first = await finish(
          session.run({
            prompt: 'Do not use tools. Reply with exactly FIRST_PREFIX_OK.',
            modelId: model.id
          })
        );
        firstEvents = first.events;
        expect(first.result, first.result.errorCode).toMatchObject({ status: 'completed' });
        expect(first.result.finalAnswer).toContain('FIRST_PREFIX_OK');
      } finally {
        await agent.dispose();
      }
      await delay(1_500);
      reverseCatalog = true;

      agent = await create();
      let secondEvents: MarAgentEvent[] = [];
      try {
        const session = await agent.openSession(sessionId);
        const second = await finish(
          session.run({
            prompt: 'Do not use tools. Reply with exactly SECOND_PREFIX_OK.',
            modelId: model.id
          })
        );
        secondEvents = second.events;
        expect(second.result, second.result.errorCode).toMatchObject({ status: 'completed' });
        expect(second.result.finalAnswer).toContain('SECOND_PREFIX_OK');
      } finally {
        await agent.dispose();
      }

      expect(requests).toHaveLength(2);
      expect(requests[1]?.continuation).toBeUndefined();
      expect(JSON.stringify(requests[1]?.tools)).toBe(JSON.stringify(requests[0]?.tools));
      expect(JSON.stringify(requests[1]?.messages.slice(0, requests[0]!.messages.length))).toBe(
        JSON.stringify(requests[0]?.messages)
      );
      expect(
        requests[1]?.messages.filter((message) =>
          message.content.includes(`Preserve stable contextual prefix ${marker} marker 0001`)
        )
      ).toHaveLength(1);
      if (protocol === 'OPENAI_RESPONSES') {
        expect(wireBodies).toHaveLength(2);
        const [firstBody, secondBody] = wireBodies;
        const { input: firstInput, ...firstProperties } = firstBody!;
        const { input: secondInput, ...secondProperties } = secondBody!;
        expect(JSON.stringify(secondProperties)).toBe(JSON.stringify(firstProperties));
        expect(Array.isArray(firstInput)).toBe(true);
        expect(Array.isArray(secondInput)).toBe(true);
        expect(
          JSON.stringify((secondInput as unknown[]).slice(0, (firstInput as unknown[]).length))
        ).toBe(JSON.stringify(firstInput));
      }

      const firstUsage = latestUsage(firstEvents);
      const usage = latestUsage(secondEvents);
      expect(usage).toBeDefined();
      const contextTokens = usage?.contextInputTokens ?? usage?.inputTokens ?? 0;
      const cacheReadTokens = usage?.cacheReadTokens ?? 0;
      console.info(
        JSON.stringify({
          test: 'contextual-world-state-cache',
          modelId: id,
          reorderedCatalog: true,
          firstContextTokens: firstUsage?.contextInputTokens ?? firstUsage?.inputTokens ?? 0,
          firstCacheReadTokens: firstUsage?.cacheReadTokens ?? 0,
          contextTokens,
          cacheReadTokens,
          cacheReadRatio: cacheReadTokens / Math.max(contextTokens, 1)
        })
      );
      expect(cacheReadTokens).toBeGreaterThan(0);
      expect(cacheReadTokens / Math.max(contextTokens, 1)).toBeGreaterThanOrEqual(0.5);
    },
    180_000
  );
});
