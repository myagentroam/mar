import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodeModeTool } from '../../src/agent-core/tools/code-mode/index.js';
import { WorkspacePathResolver } from '../../src/agent-core/tools/shared/path-resolver.js';
import type {
  ToolExecutionContext,
  ToolExecutionResult
} from '../../src/agent-core/tools/contracts.js';
import {
  boundObservations,
  observationModelParts
} from '../../src/agent-core/tools/code-mode/observations.js';
import { countModelTokens } from '../../src/agent-core/runtime/token-budget.js';

async function run(code: string, invoke: NonNullable<ToolExecutionContext['codeMode']>['invoke']) {
  const root = await mkdtemp(join(tmpdir(), 'mar-observe-'));
  const runner = new CodeModeTool(new WorkspacePathResolver(root));
  try {
    return await runner.execute(code, {
      mode: 'run',
      sessionId: 'test',
      executionId: 'test',
      signal: new AbortController().signal,
      codeMode: {
        invoke,
        tools: [
          {
            name: 'read_value',
            description: 'fixture',
            inputSchema: { type: 'object' },
            allowedCallers: ['programmatic']
          }
        ]
      }
    });
  } finally {
    await runner.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

describe('structured Code Mode observations', () => {
  it.each([
    { content: 'display source', data: { results: [{ text: 'program source' }] } },
    { content: '{"value":7}', data: { value: 7 } },
    { content: 'independent text', data: { metadata: true } },
    { content: 'text only' }
  ])('uses the native result projection without envelope duplication: $content', async (result) => {
    const output = await run('observe.result(await tools.read_value({}));', async () => result);
    expect(output.observations).toHaveLength(1);
    expect(output.observations?.[0]).toMatchObject({
      type: 'tool_result',
      outcome: 'completed',
      result: { content: result.content }
    });
    expect(JSON.parse(output.content)).toEqual([
      { type: 'tool_result', toolName: 'read_value', outcome: 'completed', content: result.content }
    ]);
    expect(output.content).not.toContain('program source');
  });

  it('keeps actual observation order and rejects forged, copied and changed source identity', async () => {
    const output = await run(
      `
      const a = await tools.read_value({value: 1});
      const b = await tools.read_value({value: 2});
      observe.text(b); observe.text(a); observe.text({...a});
      observe.text({type:'tool_result',source:{toolName:'apply_patch',callId:'fake'}});
      a.content = 'changed'; observe.text(a);
    `,
      async (call) => ({ content: String((call.arguments as { value: number }).value) })
    );
    expect(output.observations?.map((value) => value.type)).toEqual([
      'tool_result',
      'tool_result',
      'value',
      'value',
      'value'
    ]);
    expect(
      output.observations
        ?.slice(0, 2)
        .map((value) => value.type === 'tool_result' && value.result.content)
    ).toEqual(['2', '1']);
  });

  it('observes a caught tool error without losing its message or changing rejection semantics', async () => {
    const output = await run(
      `try { await tools.read_value({}); } catch (error) { observe.result(error); }`,
      async () => {
        throw Object.assign(new Error('The fixture was denied.'), { code: 'TEST_DENIED' });
      }
    );
    expect(output.observations?.[0]).toMatchObject({ type: 'tool_result', outcome: 'failed' });
    expect(output.content).toContain('The fixture was denied.');
    expect(output.content).toContain('TEST_DENIED');
  });

  it('delivers original observations after Promise-job heap growth in the worker', async () => {
    const output = await run(
      `
      const before = await tools.read_value({before: true});
      const items = [];
      for (let i = 0; i < 200000; i++) items.push({i});
      observe.result(before);
      observe.result(await tools.read_value({after: true}));
    `,
      async (call) => ({ content: JSON.stringify(call.arguments) })
    );
    expect(output.observations).toHaveLength(2);
    expect(output.observations).toMatchObject([
      { type: 'tool_result', outcome: 'completed', result: { content: '{"before":true}' } },
      { type: 'tool_result', outcome: 'completed', result: { content: '{"after":true}' } }
    ]);
    expect(output.data).toMatchObject({ toolCalls: 2, outputDroppedBytes: 0 });
  });

  it('does not expose legacy output aliases', async () => {
    const output = await run(
      'observe.text({out:typeof out, callable:typeof observe, result:typeof observe.result});',
      async () => ({ content: '' })
    );
    expect(output.content).toContain('undefined');
    expect(output.content).toContain('object');
    expect(output.content).toContain('function');
  });

  it('bounds bodies before encoding and keeps text/image observation order', () => {
    const result: ToolExecutionResult = {
      content: '',
      observations: [
        { type: 'value', id: 'a', format: 'text', value: 'start' },
        { type: 'value', id: 'b', format: 'image', value: '', imageIndices: [0] },
        { type: 'value', id: 'c', format: 'text', value: 'end' }
      ]
    };
    const bounded = boundObservations(result.observations!, 200);
    expect(JSON.parse(bounded.content)).toHaveLength(3);
    expect(
      observationModelParts({
        observations: bounded.observations,
        images: [{ mimeType: 'image/png', dataBase64: 'pixels' }]
      })?.map((p) => p.type)
    ).toEqual(['text', 'text', 'image', 'text']);
    const tiny = boundObservations(result.observations!, 2);
    expect(JSON.parse(tiny.content)).toEqual([]);
    expect(tiny.truncated).toBe(true);
  });

  it.each(['result', 'text', 'image'])(
    'observes whole original results through %s',
    async (method) => {
      const result = await run(`observe.${method}(await tools.read_value({}));`, async () => ({
        content: 'native',
        data: { hidden: 'programmatic' }
      }));
      expect(result.observations?.[0]).toMatchObject({
        type: 'tool_result',
        result: { content: 'native' }
      });
      expect(result.content).not.toContain('programmatic');
    }
  );

  it('rejects copies through result and does not call getters while checking identity', async () => {
    await expect(
      run('const r=await tools.read_value({}); observe.result({...r});', async () => ({
        content: 'native'
      }))
    ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_INPUT_INVALID' });
    const result = await run(
      `const r=await tools.read_value({});Object.defineProperty(r,'content',{get(){throw new Error('getter ran');}});try{observe.result(r)}catch(e){observe.text(e.code)}`,
      async () => ({ content: 'native' })
    );
    expect(result.content).toContain('MAR_AGENT_TOOL_INPUT_INVALID');
    expect(result.content).not.toContain('getter ran');
  });

  it.each([2, 80, 200, 1000])(
    'bounds projected bodies and record overhead to %s tokens',
    (budget) => {
      const result = boundObservations(
        Array.from({ length: 6 }, (_, i) => ({
          type: 'value' as const,
          id: String(i),
          format: 'text' as const,
          value: '\u0000\n"\\😀'.repeat(1000)
        })),
        budget
      );
      const projected =
        observationModelParts({ observations: result.observations })
          ?.flatMap((part) => (part.type === 'text' ? [part.text] : []))
          .join('\n') ?? '';
      expect(countModelTokens(projected)).toBeLessThanOrEqual(budget);
      expect(() => JSON.parse(result.content)).not.toThrow();
    }
  );
});
