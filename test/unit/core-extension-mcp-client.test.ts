import { afterEach, describe, expect, it } from 'vitest';
import type {
  ExtensionJsonValue,
  SessionExtensionContext,
  ExtensionMcpConnectionRef
} from '../../mar-agent/src/extensions.js';
import {
  fixture,
  answer,
  call as modelCall,
  cleanupCoreFixtures
} from '../../mar-agent/test/unit/support/core-extension-fixture.js';
import {
  httpMcpFixture,
  mcpLeasePort,
  stdioDefinition
} from './support/core-extension-mcp-client.js';

afterEach(cleanupCoreFixtures);
const configuration = (value: unknown): ExtensionJsonValue =>
  JSON.parse(JSON.stringify(value)) as ExtensionJsonValue;
const modes = (['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'] as const).flatMap((protocol) =>
  [false, true].map((codeMode) => ({ protocol, codeMode }))
);

describe('Core Extension with the existing application MCP Client', () => {
  for (const transport of ['STDIO', 'HTTP'] as const) {
    it.each(modes)(
      `${transport} discovers and calls real tools ($protocol, Code Mode: $codeMode)`,
      async ({ protocol, codeMode }) => {
        const http = transport === 'HTTP' ? await httpMcpFixture() : undefined;
        let cwd = '';
        const bridge = mcpLeasePort(() => cwd);
        let name = '';
        let context!: SessionExtensionContext;
        try {
          const f = await fixture(
            [
              {
                id: 'real-mcp',
                apiVersion: '1.0',
                async attachSession(value) {
                  context = value;
                  const server = value.mcp!.register({
                    id: 'real',
                    configuration: configuration(http?.definition ?? stdioDefinition())
                  }).ref;
                  const connection = await value.mcp!.connect({ server });
                  const catalog = await value.mcp!.catalog({ connection });
                  name = catalog.tools.find((tool) => tool.definition.name.endsWith('__echo'))!
                    .definition.name;
                  expect(
                    bridge.leases[0]!.pool.catalog().tools.every(
                      (tool) => tool.lifetime === 'session'
                    )
                  ).toBe(true);
                }
              }
            ],
            (request, index) => {
              if (index === 0) {
                expect(request.tools.some((tool) => tool.name === name)).toBe(false);
                return modelCall('tool_search', { query: 'echo' });
              }
              if (index === 1) {
                return codeMode
                  ? modelCall('code_exec', {
                      code: `observe.text(await tools.${name}({value: "REAL_MCP_TRANSPORT"}));`
                    })
                  : modelCall(name, { value: 'REAL_MCP_TRANSPORT' });
              }
              return answer();
            },
            codeMode,
            true,
            { mcp: bridge.port },
            protocol
          );
          cwd = f.home;
          const run = f.session.run({ prompt: 'discover and call the real MCP transport' });
          expect(await run.result()).toHaveProperty('status', 'completed');
          expect(bridge.calls).toHaveLength(1);
          expect(JSON.stringify(f.adapter.requests.at(-1)?.messages)).toContain(
            'REAL_MCP_TRANSPORT'
          );
          expect(bridge.calls[0]!.operation).toMatchObject({
            sessionId: f.session.id,
            executionId: run.executionId,
            actor: codeMode ? 'code-mode' : 'model',
            entry: codeMode ? 'programmatic' : 'direct'
          });
          expect(bridge.calls[0]!.input.expectedTool).toEqual({
            sourceIdentity: bridge.leases[0]!.pool.catalog().tools.find(
              (tool) => tool.definition.name === name
            )!.sourceIdentity,
            definitionRevision: bridge.leases[0]!.pool.catalog().tools.find(
              (tool) => tool.definition.name === name
            )!.definitionRevision
          });
          const ref = (
            await context.mcp!.catalog({ connection: context.mcp!.connections()[0]! })
          ).tools.find((tool) => tool.definition.name === name)!;
          const actual = await context.mcp!.call({
            tool: ref,
            arguments: { value: 'NATIVE_REAL_TRANSPORT' }
          });
          expect(actual.content).toContain('NATIVE_REAL_TRANSPORT');
          expect(bridge.calls[1]!.operation.executionId).toBeUndefined();
          expect(bridge.calls[1]!.operation.entry).toBe('native-api');
          await f.agent.dispose();
          expect(bridge.released()).toBe(1);
        } finally {
          await cleanupCoreFixtures();
          await bridge.close();
          await http?.close();
        }
      },
      20_000
    );
  }

  it.each(modes)(
    'preserves deferred discovery and leaf facts through an idle-registered MCP wrapper ($protocol, Code Mode: $codeMode)',
    async ({ protocol, codeMode }) => {
      let cwd = '';
      const bridge = mcpLeasePort(() => cwd);
      let name = '';
      let context!: SessionExtensionContext;
      const attempts: Array<{
        fact: import('../../mar-agent/src/extensions.js').ExtensionToolCompletion;
        entry: string;
        executionId: string | undefined;
      }> = [];
      try {
        const f = await fixture(
          [
            {
              id: 'real-mcp-wrapper',
              apiVersion: '1.0',
              attachSession(value) {
                context = value;
                value.hooks.observe('tool.attempt.completed', (fact, call) => {
                  attempts.push({ fact, entry: call.entry, executionId: call.executionId });
                });
              }
            }
          ],
          (request, index) => {
            if (index === 1) {
              expect(request.tools.some((tool) => tool.name === name)).toBe(false);
              return modelCall('tool_search', { query: 'echo' });
            }
            if (index === 2)
              return codeMode
                ? modelCall('code_exec', {
                    code: `observe.result(await tools.${name}({value:"WRAPPED_MCP_SOURCE"}));`
                  })
                : modelCall(name, { value: 'WRAPPED_MCP_SOURCE' });
            return answer();
          },
          codeMode,
          true,
          { mcp: bridge.port },
          protocol
        );
        cwd = f.home;
        await f.session.run({ prompt: 'initialize' }).result();
        const declaration = context.mcp!.register({
          id: 'wrapped',
          configuration: configuration(stdioDefinition())
        });
        const connection = await context.mcp!.connect({ server: declaration.ref });
        const ref = (await context.mcp!.catalog({ connection })).tools.find((tool) =>
          tool.definition.name.endsWith('__echo')
        )!;
        expect(ref).toBeDefined();
        name = ref.definition.name;
        const wrapper = context.tools.register({
          ...ref.definition,
          override: 'wrap',
          execute: (input, _call, next) => next(input)
        });
        try {
          const handle = f.session.run({ prompt: 'discover and use wrapped echo' });
          expect(await handle.result()).toHaveProperty('status', 'completed');
          const own = attempts.filter((attempt) => attempt.executionId === handle.executionId);
          const leaf = own.filter(
            (attempt) => attempt.fact.name === name && attempt.fact.stage === 'leaf'
          );
          const wrapped = own.filter(
            (attempt) => attempt.fact.name === name && attempt.fact.stage === 'wrapper'
          );
          expect(leaf).toHaveLength(1);
          expect(wrapped).toHaveLength(1);
          expect(leaf[0]?.fact.source?.kind).toBe('mcp');
          expect(leaf[0]?.fact.parentAttemptId).toBe(wrapped[0]?.fact.attemptId);
          expect(leaf[0]?.entry).toBe(codeMode ? 'programmatic' : 'direct');
          expect(leaf[0]?.fact.result.content).toBe('{"value":"WRAPPED_MCP_SOURCE"}');
          expect(bridge.calls).toHaveLength(1);
          expect(bridge.calls[0]?.input.expectedTool?.sourceIdentity).toBe(ref.source.id);
          expect(bridge.calls[0]?.input.expectedTool?.definitionRevision).toBe(ref.source.revision);
          expect(
            JSON.stringify((await context.session!.messages({ view: 'conversation' })).messages)
          ).toContain('WRAPPED_MCP_SOURCE');
        } finally {
          await wrapper.dispose();
        }
        await context.mcp!.disconnect({ connection });
        await declaration.dispose();
        expect(await context.tools.check({ name, ref, arguments: {} })).toMatchObject({
          available: false
        });
        await expect(context.tools.invoke({ name, ref, arguments: {} })).rejects.toHaveProperty(
          'code',
          'MAR_AGENT_TOOL_NOT_AVAILABLE'
        );
      } finally {
        await cleanupCoreFixtures();
        await bridge.close();
      }
    },
    20_000
  );

  it.each(modes)(
    'keeps the real Client caller policy through a nested native facade ($protocol, Code Mode: $codeMode)',
    async ({ protocol, codeMode }) => {
      let cwd = '';
      const bridge = mcpLeasePort(() => cwd);
      let context!: SessionExtensionContext;
      let ref!: import('../../mar-agent/src/extensions.js').ExtensionToolRef;
      try {
        const f = await fixture(
          [
            {
              id: 'mcp-caller-policy',
              apiVersion: '1.0',
              async attachSession(value) {
                context = value;
                const connection = await value.mcp!.connect({
                  server: value.mcp!.register({
                    id: 'direct-only',
                    configuration: configuration({
                      ...stdioDefinition(),
                      allowedToolCallers: { echo: ['direct'] }
                    })
                  }).ref
                });
                ref = (await value.mcp!.catalog({ connection })).tools[0]!;
                expect(ref.definition.allowedCallers).toEqual(['direct']);
                value.tools.register({
                  name: 'proxy',
                  description: 'Use the native facade without changing the physical caller.',
                  inputSchema: { type: 'object' },
                  execute: () =>
                    value.mcp!.call({ tool: ref, arguments: { value: 'PHYSICAL_CALLER' } })
                });
              }
            }
          ],
          (_request, index) =>
            index === 0
              ? codeMode
                ? modelCall('code_exec', { code: 'observe.result(await tools.proxy({}));' })
                : modelCall('proxy', {})
              : answer(),
          codeMode,
          true,
          { mcp: bridge.port },
          protocol
        );
        cwd = f.home;
        expect(await f.session.run({ prompt: 'call the proxy' }).result()).toHaveProperty(
          'status',
          'completed'
        );
        expect(bridge.calls).toHaveLength(codeMode ? 0 : 1);
        expect(JSON.stringify(f.adapter.requests.at(-1)?.messages)).toContain(
          codeMode ? 'MAR_AGENT_TOOL_NOT_AVAILABLE' : 'PHYSICAL_CALLER'
        );
        const before = bridge.calls.length;
        expect(
          await context.mcp!.call({ tool: ref, arguments: { value: 'TRUSTED_IDLE_NATIVE' } })
        ).toHaveProperty('content', '{"value":"TRUSTED_IDLE_NATIVE"}');
        expect(bridge.calls).toHaveLength(before + 1);
        expect(bridge.calls.at(-1)!.operation.entry).toBe('native-api');
        expect(bridge.calls.at(-1)!.operation.executionId).toBeUndefined();
      } finally {
        await cleanupCoreFixtures();
        await bridge.close();
      }
    },
    20_000
  );

  it('keeps an acquired real stdio lease after its connect request signal is cancelled', async () => {
    let cwd = '';
    const bridge = mcpLeasePort(() => cwd);
    let context!: SessionExtensionContext;
    try {
      const f = await fixture(
        [
          {
            id: 'connect-signal',
            apiVersion: '1.0',
            attachSession(value) {
              context = value;
            }
          }
        ],
        () => answer(),
        false,
        true,
        { mcp: bridge.port }
      );
      cwd = f.home;
      await f.session.run({ prompt: 'initialize' }).result();
      const request = new AbortController();
      const connection = await context.mcp!.connect({
        server: context.mcp!.register({
          id: 'echo',
          configuration: configuration(stdioDefinition())
        }).ref,
        signal: request.signal
      });
      const tool = (await context.mcp!.catalog({ connection })).tools[0]!;
      request.abort();
      expect(
        await context.mcp!.call({ tool, arguments: { value: 'DELIVERED_LEASE_ALIVE' } })
      ).toHaveProperty('content', '{"value":"DELIVERED_LEASE_ALIVE"}');
      expect(bridge.released()).toBe(0);
      expect(context.mcp!.connections()).toEqual([connection]);
      await context.mcp!.disconnect({ connection });
      expect(bridge.released()).toBe(1);
    } finally {
      await cleanupCoreFixtures();
      await bridge.close();
    }
  }, 20_000);

  it('releases only the owning Session lease and revokes old refs on reconnect', async () => {
    let cwd = '';
    const bridge = mcpLeasePort(() => cwd);
    const contexts = new Map<string, SessionExtensionContext>();
    const connections = new Map<string, ExtensionMcpConnectionRef>();
    try {
      const f = await fixture(
        [
          {
            id: 'shared-client',
            apiVersion: '1.0',
            async attachSession(value) {
              contexts.set(value.sessionId, value);
              connections.set(
                value.sessionId,
                await value.mcp!.connect({
                  server: value.mcp!.register({
                    id: 'echo',
                    configuration: configuration(stdioDefinition())
                  }).ref
                })
              );
            }
          }
        ],
        () => answer(),
        false,
        true,
        { mcp: bridge.port }
      );
      cwd = f.home;
      await f.session.run({ prompt: 'first lease' }).result();
      const second = await f.agent.createSession({ workspace: f.home });
      await second.run({ prompt: 'second lease' }).result();
      expect(bridge.leases).toHaveLength(2);
      expect(bridge.leases[0]!.pool).toBe(bridge.leases[1]!.pool);
      const firstContext = contexts.get(f.session.id)!;
      const secondContext = contexts.get(second.id)!;
      const old = (await firstContext.mcp!.catalog({ connection: connections.get(f.session.id)! }))
        .tools[0]!;
      await firstContext.mcp!.disconnect({ connection: connections.get(f.session.id)! });
      expect(bridge.released()).toBe(1);
      await expect(
        firstContext.mcp!.call({ tool: old, arguments: { value: 'revoked' } })
      ).rejects.toHaveProperty('code');
      const surviving = (
        await secondContext.mcp!.catalog({ connection: connections.get(second.id)! })
      ).tools[0]!;
      expect(
        await secondContext.mcp!.call({ tool: surviving, arguments: { value: 'surviving' } })
      ).toHaveProperty('content', '{"value":"surviving"}');
      const replacement = await firstContext.mcp!.connect({ server: 'echo' });
      expect(bridge.leases[2]!.pool).toBe(bridge.leases[1]!.pool);
      await expect(
        firstContext.mcp!.call({ tool: old, arguments: { value: 'not-rebound' } })
      ).rejects.toHaveProperty('code');
      const fresh = (await firstContext.mcp!.catalog({ connection: replacement })).tools[0]!;
      expect(
        await firstContext.mcp!.call({ tool: fresh, arguments: { value: 'fresh' } })
      ).toHaveProperty('content', '{"value":"fresh"}');
      expect(bridge.calls.map((call) => call.input.arguments)).toEqual([
        { value: 'surviving' },
        { value: 'fresh' }
      ]);
      await f.agent.dispose();
      expect(bridge.released()).toBe(3);
    } finally {
      await cleanupCoreFixtures();
      await bridge.close();
    }
  }, 20_000);

  it('checks the actual Client revision before refresh and atomically publishes the new catalog', async () => {
    const http = await httpMcpFixture();
    let cwd = '';
    const bridge = mcpLeasePort(() => cwd);
    let context!: SessionExtensionContext;
    try {
      const f = await fixture(
        [
          {
            id: 'http-refresh',
            apiVersion: '1.0',
            attachSession(value) {
              context = value;
            }
          }
        ],
        () => answer(),
        false,
        true,
        { mcp: bridge.port }
      );
      cwd = f.home;
      await f.session.run({ prompt: 'initialize' }).result();
      const connection = await context.mcp!.connect({
        server: context.mcp!.register({ id: 'http', configuration: configuration(http.definition) })
          .ref
      });
      const oldCatalog = await context.mcp!.catalog({ connection });
      const old = oldCatalog.tools.find((tool) => tool.definition.name.endsWith('__echo'))!;
      const metadata = bridge.leases[0]!.pool.catalog().tools.find(
        (tool) => tool.rawName === 'echo'
      )!;
      http.update('New authoritative server definition.');
      await expect
        .poll(
          () =>
            bridge.leases[0]!.pool.catalog().tools.find((tool) => tool.rawName === 'echo')!
              .definitionRevision
        )
        .not.toBe(metadata.definitionRevision);
      await expect(
        context.mcp!.call({ tool: old, arguments: { value: 'not-called' } })
      ).rejects.toMatchObject({ code: 'MAR_AGENT_MCP_TOOL_DEFINITION_CHANGED' });
      expect(http.calls).toEqual([]);
      const updated = await context.mcp!.catalog({ connection });
      expect(updated.revision).not.toBe(oldCatalog.revision);
      const fresh = updated.tools.find((tool) => tool.definition.name === old.definition.name)!;
      expect(
        await context.mcp!.call({ tool: fresh, arguments: { value: 'new-definition' } })
      ).toHaveProperty('content', 'new-definition');
      await expect(
        context.mcp!.call({ tool: old, arguments: { value: 'still-revoked' } })
      ).rejects.toHaveProperty('code');
      expect(http.calls).toEqual(['new-definition']);
    } finally {
      await cleanupCoreFixtures();
      await bridge.close();
      await http.close();
    }
  }, 20_000);

  it.each(['abort', 'disconnect', 'clear', 'dispose'] as const)(
    '%s cancels a real request without closing another owner lease',
    async (stop) => {
      const http = await httpMcpFixture();
      let cwd = '';
      const bridge = mcpLeasePort(() => cwd);
      let context!: SessionExtensionContext;
      let survivor: Awaited<ReturnType<typeof bridge.cache.acquire>> | undefined;
      try {
        const f = await fixture(
          [
            {
              id: 'http-cancel',
              apiVersion: '1.0',
              attachSession(value) {
                context = value;
              }
            }
          ],
          () => answer(),
          false,
          true,
          { mcp: bridge.port }
        );
        cwd = f.home;
        await f.session.run({ prompt: 'initialize' }).result();
        const connection = await context.mcp!.connect({
          server: context.mcp!.register({
            id: 'http',
            configuration: configuration(http.definition)
          }).ref
        });
        survivor = await bridge.cache.acquire([http.definition], cwd, { authorizationScope: cwd });
        expect(survivor.pool).toBe(bridge.leases[0]!.pool);
        const gate = (await context.mcp!.catalog({ connection })).tools.find((tool) =>
          tool.definition.name.endsWith('__gate')
        )!;
        const failures: unknown[] = [];
        context.hooks.observe('tool.failed', (fact) => {
          failures.push(fact);
        });
        const controller = new AbortController();
        const pending = context
          .mcp!.call({ tool: gate, arguments: {}, signal: controller.signal })
          .then(
            () => {
              throw new Error('Cancelled request unexpectedly succeeded.');
            },
            (error: unknown) => error
          );
        await within(http.entered);
        if (stop === 'abort') controller.abort();
        else if (stop === 'disconnect') await context.mcp!.disconnect({ connection });
        else if (stop === 'clear') await f.agent.clearSession(f.session.id);
        else await f.agent.dispose();
        const error = await within(pending);
        if (stop === 'abort') {
          // Caller cancellation keeps the Client's native failure, unlike owned lease teardown.
          expect(error).toMatchObject({ code: -32001 });
          expect(bridge.released()).toBe(0);
        } else {
          expect(error).toMatchObject({ code: 'MAR_AGENT_CANCELLED', cause: { code: -32001 } });
          expect(bridge.released()).toBe(1);
        }
        await within(http.cancelled);
        if (stop === 'abort' || stop === 'disconnect')
          expect(failures).toEqual([
            expect.objectContaining({ status: 'cancelled', errorCode: 'MAR_AGENT_CANCELLED' })
          ]);
        const echo = survivor.pool.catalog().tools.find((tool) => tool.rawName === 'echo')!;
        expect(
          await survivor.pool.call(
            echo.definition.name,
            { value: 'surviving-owner' },
            undefined,
            echo
          )
        ).toHaveProperty('content', 'surviving-owner');
        expect(bridge.calls).toHaveLength(1);
        if (stop === 'disconnect') {
          const replacement = await context.mcp!.connect({ server: 'http' });
          const fresh = (await context.mcp!.catalog({ connection: replacement })).tools.find(
            (tool) => tool.definition.name.endsWith('__echo')
          )!;
          expect(
            await context.mcp!.call({ tool: fresh, arguments: { value: 'after-reconnect' } })
          ).toHaveProperty('content', 'after-reconnect');
          await context.mcp!.disconnect({ connection: replacement });
          expect(bridge.released()).toBe(2);
        }
      } finally {
        await cleanupCoreFixtures();
        await survivor?.release();
        await bridge.close();
        await http.close();
      }
    },
    20_000
  );
});

async function within<Value>(promise: Promise<Value>): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Isolated MCP gate did not settle.')), 5000);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
