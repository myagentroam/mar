import { describe, expect, it } from 'vitest';
import { createCodeModeEngine } from '../../src/tools/code-mode/quickjs-engine.js';
import type { CodeModeEngine } from '../../src/tools/code-mode/engine.js';
import { BoundedTextOutput } from '../../src/tools/code-mode/text-output.js';

async function executeFull(
  code: string,
  overrides: Partial<Parameters<CodeModeEngine['execute']>[0]> = {}
) {
  const engine = await createCodeModeEngine({
    coreModuleUrl: import.meta.resolve('quickjs-emscripten-core'),
    variantModuleUrl: import.meta.resolve('@jitl/quickjs-wasmfile-release-sync')
  });
  const output: string[] = [];
  const originalBytes: number[] = [];
  try {
    const result = await engine.execute({
      code,
      tools: ['echo'],
      catalog: [
        {
          name: 'echo',
          description: 'Echo the input.',
          inputSchema: { type: 'object' },
          inputMode: 'json'
        }
      ],
      state: [],
      signal: new AbortController().signal,
      limits: {
        memoryBytes: 8_388_608,
        stackBytes: 262_144,
        timeoutMs: 100,
        outputBytes: 4096,
        stateEntries: 128,
        stateMutations: 128,
        stateKeyBytes: 256,
        stateValueBytes: 65_536,
        stateTotalBytes: 1_048_576,
        sleepMs: 30_000
      },
      onToolCall: async (call) => ({ content: 'echo', data: call.arguments }),
      onText: () => undefined,
      onImage: () => undefined,
      onObserve: (observation) => {
        if (observation.type !== 'value' || observation.format === 'image') return;
        output.push(observation.value);
        originalBytes.push(observation.originalBytes);
      },
      onYield: () => undefined,
      ...overrides
    });
    return { output, originalBytes, stateMutations: result.stateMutations };
  } finally {
    await engine.dispose();
  }
}

async function execute(
  code: string,
  overrides: Partial<Parameters<CodeModeEngine['execute']>[0]> = {}
) {
  return (await executeFull(code, overrides)).output;
}

describe('restricted Code Mode engine', () => {
  it('retains UTF-8 display tails without replenishing the separate model capture', () => {
    const display = new BoundedTextOutput(7, '\n', 'tail');
    const model = new BoundedTextOutput(7);
    for (const output of [display, model]) {
      output.append('old😀');
      output.append('new😀');
    }
    expect(display.drain()).toEqual({
      text: 'new😀',
      originalBytes: 15,
      retainedBytes: 7,
      droppedBytes: 8
    });
    expect(model.drain().text).toBe('old😀');
    display.append('latest😀');
    model.append('latest😀');
    expect(display.snapshot()).toEqual({
      text: 'est😀',
      originalBytes: 10,
      retainedBytes: 7,
      droppedBytes: 3
    });
    expect(model.snapshot()).toEqual({
      text: '',
      originalBytes: 10,
      retainedBytes: 0,
      droppedBytes: 10
    });
  });
  describe('WASM memory growth during Promise jobs', () => {
    const limits = {
      memoryBytes: 33_554_432,
      stackBytes: 524_288,
      timeoutMs: 5000,
      outputBytes: 4096,
      stateEntries: 128,
      stateMutations: 128,
      stateKeyBytes: 256,
      stateValueBytes: 65_536,
      stateTotalBytes: 1_048_576,
      sleepMs: 30_000
    };
    const allocate = `
      const items = [];
      for (let i = 0; i < 200000; i++) items.push({ i });
    `;

    it.each(['result', 'text', 'image'])(
      'retains original results through %s and releases the grown heap',
      async (method) => {
        const observations: string[] = [];
        const result = await executeFull(
          `
          const before = await tools.echo({ before: true });
          observe.${method}(before);
          ${allocate}
          observe.text(items.length);
          observe.${method}(before);
          observe.${method}(await tools.echo({ after: true }));
          state.set('done', true);
        `,
          {
            limits,
            onObserve: (observation) => {
              if (observation.type === 'tool_result') observations.push(observation.operationId);
              else if (observation.type === 'value') observations.push(observation.value);
            }
          }
        );
        expect(observations).toEqual(['1', '200000', '1', '2']);
        expect(result.stateMutations).toEqual([{ operation: 'set', key: 'done', value: true }]);
      }
    );

    it('preserves guest failures instead of replacing them with a disposal assertion', async () => {
      await expect(
        execute(`await tools.echo({}); ${allocate} throw new Error('After growth.');`, { limits })
      ).rejects.toMatchObject({ code: 'MAR_AGENT_CODE_FAILED', message: 'After growth.' });
    });

    it('still rejects copied and modified original results after heap growth', async () => {
      const result = await execute(
        `
        const result = await tools.echo({ value: 1 });
        ${allocate}
        try { observe.result({...result}); } catch (error) { observe.text(error.code); }
        result.data.value = 2;
        try { observe.result(result); } catch (error) { observe.text(error.code); }
      `,
        { limits }
      );
      expect(result).toEqual(['MAR_AGENT_TOOL_INPUT_INVALID', 'MAR_AGENT_TOOL_INPUT_INVALID']);
    });
  });

  it.each([
    { source: 'const broken = {offset: 1, 230};', location: 'Line 1, column 31.' },
    {
      source: '\nconst valid = 1;\nconst broken = {offset: 1, 230};',
      location: 'Line 3, column 31.'
    },
    {
      source: '// header\r\nconst broken = {offset: 1, 230};',
      location: 'Line 2, column 31.'
    },
    { source: '// header\rconst broken = {offset: 1, 230};', location: 'Line 2, column 31.' },
    { source: '// header\u2028const broken = {offset: 1, 230};', location: 'Line 2, column 31.' },
    {
      source: 'const text = "你😀";\rconst broken = {offset: 1, 230};',
      location: 'Line 2, column 31.'
    },
    {
      source: 'const broken = {offset: 1, 230};\rconst after = 1;',
      location: 'Line 1, column 31.'
    },
    { source: 'const broken = {', location: 'Line 1, column 17.' }
  ])(
    'reports syntax errors against the submitted source: $location',
    async ({ source, location }) => {
      const failure = await execute(source).catch((error) => error);
      expect(failure).toMatchObject({
        code: 'MAR_AGENT_CODE_SYNTAX_ERROR',
        message: expect.stringContaining('No tools were executed.')
      });
      expect(failure.message).toContain(location);
      expect(failure.message).not.toContain('code-mode.js');
    }
  );

  it.each(['text("private-value");', 'console.log("private-value");'])(
    'explains the observation API without exposing source or adding aliases: %s',
    async (source) => {
      const failure = await execute(source).catch((error) => error);
      expect(failure).toMatchObject({
        code: 'MAR_AGENT_CODE_FAILED',
        message: expect.stringContaining('observe.text(value)')
      });
      expect(failure.message).toContain('is not defined');
      expect(failure.message).not.toContain('private-value');
    }
  );

  it('preserves unrelated reference errors without guessing a recovery action', async () => {
    await expect(execute('throw new ReferenceError("Unrelated failure.");')).rejects.toMatchObject({
      code: 'MAR_AGENT_CODE_FAILED',
      message: 'Unrelated failure.'
    });
  });

  it('explains undefined original-result observations without invoking tools', async () => {
    let calls = 0;
    await expect(
      execute('observe.result(undefined);', {
        onToolCall: async () => {
          calls++;
          return { data: {} };
        }
      })
    ).rejects.toMatchObject({
      code: 'MAR_AGENT_TOOL_INPUT_INVALID',
      message: expect.stringMatching(/received undefined.*observe\.text\(value\)/)
    });
    expect(calls).toBe(0);
  });

  it.each([
    {
      source: 'observe.text({ exitCode: undefined, status: "running", stderr: undefined });',
      expected: '{"status":"running"}'
    },
    {
      source:
        'observe.text({ nested: { optional: undefined, value: 1 }, "": undefined, empty: { missing: undefined } });',
      expected: '{"nested":{"value":1},"empty":{}}'
    },
    {
      source: 'observe.text([undefined, , { optional: undefined, value: 2 }, [undefined]]);',
      expected: '[null,null,{"value":2},[null]]'
    }
  ])(
    'normalizes optional undefined values in derived text: $expected',
    async ({ source, expected }) => {
      expect(await execute(source)).toEqual([expected]);
    }
  );

  it('normalizes undefined returned by toJSON once per field without changing scalar text', async () => {
    expect(
      await execute(`
      const keys = [];
      const optional = { toJSON(key) { keys.push(key); return undefined; } };
      observe.text({ optional, value: 1 });
      observe.text([optional]);
      observe.text(keys);
      observe.text(undefined);
    `)
    ).toEqual(['{"value":1}', '[null]', '["optional","0"]', 'undefined']);
  });

  it.each([
    {
      source: 'observe.text({ items: [{ invalid: () => 1 }] });',
      path: '$["items"][0]["invalid"]',
      type: 'function'
    },
    {
      source: 'observe.text({ items: [1n] });',
      path: '$["items"][0]',
      type: 'bigint'
    },
    {
      source: 'observe.text({ "private-value": "not echoed", items: [Symbol("secret")] });',
      path: '$["items"][0]',
      type: 'symbol'
    }
  ])('locates non-JSON observation values at $path', async ({ source, path, type }) => {
    const failure = await execute(source).catch((error) => error);
    expect(failure).toMatchObject({
      code: 'MAR_AGENT_TOOL_INPUT_INVALID',
      message: expect.stringContaining(`${path} has type ${type}`)
    });
    expect(failure.message).toContain('null');
    expect(failure.message).not.toContain('not echoed');
    expect(failure.message).not.toContain('secret');
  });

  it('bounds the field path in non-JSON observation errors', async () => {
    const failure = await execute(
      'observe.text({["x".repeat(10000)]: { invalid: () => 1 }});'
    ).catch((error) => error);
    expect(failure.code).toBe('MAR_AGENT_TOOL_INPUT_INVALID');
    expect(failure.message).toContain('has type function');
    expect(failure.message.length).toBeLessThan(500);
  });

  it('does not use runtime exception fields to invent compiler source locations', async () => {
    await expect(
      execute(
        'throw Object.assign(new SyntaxError("Runtime failure."), {fileName:"code-mode.js",lineNumber:123});'
      )
    ).rejects.toMatchObject({ code: 'MAR_AGENT_CODE_FAILED', message: 'Runtime failure.' });
  });

  it.each([
    { source: 'const broken = {offset: 1, 230};', line: 1, column: 31 },
    { source: 'const broken = {', line: 1, column: 17 },
    {
      source: 'const privateText = "你😀";\rconst broken = {offset: 1, 230};',
      line: 2,
      column: 31
    },
    { source: '// private-body\u2028const broken = {offset: 1, 230};', line: 2, column: 31 },
    { source: '// private-body\u2029const broken = {offset: 1, 230};', line: 2, column: 31 },
    { source: 'const text = "你😀";\r\nconst broken = {offset: 1, 230};', line: 2, column: 31 },
    {
      source: 'const text = "你😀"; const broken = {offset: 1, 230};',
      line: 1,
      column: 50,
      caret: 51
    },
    { source: '\tconst broken = {offset: 1, 230};', line: 1, column: 32, caret: 34 },
    { source: 'const broken = {\r\n', line: 2, column: 1 }
  ])(
    'locates compilation failure at $line:$column in the submitted source',
    async ({ source, line, column, caret: expectedCaret }) => {
      const error = await execute(source).catch((error) => error);
      expect(error.code).toBe('MAR_AGENT_CODE_SYNTAX_ERROR');
      expect(error.message).toContain(`Line ${line}, column ${column}.`);
      expect(error.message).toContain(`${line} | `);
      expect(error.message).toContain('^');
      expect(error.message).toContain(source.split(/\r\n|[\r\n\u2028\u2029]/u)[line - 1]!.trim());
      expect(error.message).not.toContain('<source omitted>');
      expect(error.message).not.toContain('<character omitted>');
      expect(error.message).not.toContain('at code-mode');
      expect(error.message.length).toBeLessThan(800);
      const lines = error.message.split('\n');
      const caret = lines.at(-1).indexOf('^') - `${line} | `.length;
      expect(caret).toBe(expectedCaret ?? column - 1);
    }
  );

  it('keeps the caret in bounded compiler diagnostics for long source lines', async () => {
    const error = await execute(`${' '.repeat(20000)}const broken = {offset: 1, 230};`).catch(
      (error) => error
    );
    expect(error.message).toContain('Line 1, column 20031.');
    expect(error.message).toContain('…');
    expect(error.message).toContain('const broken = {offset: 1, 230};');
    expect(error.message).toContain('^');
    expect(error.message.length).toBeLessThan(800);
  });

  it('does not classify echoed source text as an engine memory failure', async () => {
    const error = await execute('const message = "out of memory"; const broken = {x: 1, 2};').catch(
      (error) => error
    );
    expect(error.code).toBe('MAR_AGENT_CODE_SYNTAX_ERROR');
    expect(error.message).toContain('out of memory');
  });

  it('explains unterminated strings using the submitted source and no internal filename', async () => {
    const error = await execute('const message = "hello;').catch((error) => error);
    expect(error).toMatchObject({ code: 'MAR_AGENT_CODE_SYNTAX_ERROR' });
    expect(error.message).toContain('Unterminated string literal.');
    expect(error.message).toContain('No tools were executed.');
    expect(error.message).toContain('1 | const message = "hello;');
    expect(error.message).not.toContain('code-mode.js');
  });

  it.each(['', 'undefined', '{}'])(
    'accepts empty tool input %j only with a bound parameterless schema',
    async (argument) => {
      const calls: unknown[] = [];
      await execute(`await tools.echo(${argument});`, {
        catalog: [
          {
            name: 'echo',
            description: 'No parameters.',
            inputMode: 'json',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false }
          }
        ],
        onToolCall: async (call) => {
          calls.push(call.arguments);
          return { data: {} };
        }
      });
      expect(calls).toEqual([{}]);
    }
  );

  it('accepts a parameterless schema with empty required and annotation metadata', async () => {
    const calls: unknown[] = [];
    await execute('await tools.echo();', {
      catalog: [
        {
          name: 'echo',
          description: 'No parameters.',
          inputMode: 'json',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
            required: [],
            title: 'Read',
            description: 'Empty input.'
          }
        }
      ],
      onToolCall: async (call) => {
        calls.push(call.arguments);
        return { data: {} };
      }
    });
    expect(calls).toEqual([{}]);
  });

  it.each([
    { schema: { type: 'object' } },
    {
      schema: {
        type: 'object',
        properties: { optional: { type: 'string' } },
        additionalProperties: false
      }
    },
    {
      schema: { type: 'object', properties: {}, required: ['missing'], additionalProperties: false }
    },
    { schema: { type: 'object', properties: {}, additionalProperties: false, minProperties: 1 } },
    { schema: { type: 'object', properties: {}, additionalProperties: false, anyOf: [{}] } },
    {
      schema: { type: 'object', properties: {}, additionalProperties: false, $ref: '#/$defs/input' }
    },
    {
      schema: { type: 'object', properties: {}, additionalProperties: false },
      mode: 'freeform' as const
    },
    { schema: { type: 'object', properties: {}, additionalProperties: false }, name: 'other' }
  ])('does not invent omitted input for $schema, $mode, $name', async ({ schema, mode, name }) => {
    let calls = 0;
    await expect(
      execute('await tools.echo();', {
        catalog: [
          {
            name: name ?? 'echo',
            description: 'Test schema.',
            inputMode: mode ?? 'json',
            inputSchema: schema
          }
        ],
        onToolCall: async () => {
          calls++;
          return { data: {} };
        }
      })
    ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_INPUT_INVALID' });
    expect(calls).toBe(0);
  });

  it('keeps arrays, state and observations strict for parameterless tools', async () => {
    for (const code of [
      'await tools.echo([undefined]);',
      'state.set("invalid", undefined);',
      'observe.result(undefined);'
    ]) {
      let calls = 0;
      await expect(
        execute(code, {
          catalog: [
            {
              name: 'echo',
              description: 'No parameters.',
              inputMode: 'json',
              inputSchema: {
                type: 'object',
                properties: {},
                additionalProperties: false,
                required: []
              }
            }
          ],
          onToolCall: async () => {
            calls++;
            return { data: {} };
          }
        })
      ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_INPUT_INVALID' });
      expect(calls).toBe(0);
    }
  });

  it('preserves literal source interpolation syntax in JSON-escaped tool arguments', async () => {
    const text = 'literal `${id}` / None / "quotes" / \\ / 你😀\n';
    const calls: unknown[] = [];
    await execute(`await tools.echo({text:${JSON.stringify(text)}});`, {
      onToolCall: async (call) => {
        calls.push(call.arguments);
        return { data: {} };
      }
    });
    expect(calls).toEqual([{ text }]);
  });

  it('does not repair malformed command keys or execute tools before compilation succeeds', async () => {
    let calls = 0;
    await expect(
      execute('await tools.echo({command": "echo harmless"});', {
        onToolCall: async () => {
          calls++;
          return { content: '' };
        }
      })
    ).rejects.toMatchObject({
      code: 'MAR_AGENT_CODE_SYNTAX_ERROR',
      message: expect.stringContaining('No tools were executed.')
    });
    expect(calls).toBe(0);
  });

  it('streams serialized objects larger than the guest heap without allocating the complete JSON string', async () => {
    const result = await executeFull(
      'observe.text(Array(64).fill("x".repeat(250000))); state.set("done",true);',
      {
        limits: {
          memoryBytes: 8_388_608,
          stackBytes: 262_144,
          timeoutMs: 5000,
          outputBytes: 4096,
          stateEntries: 128,
          stateMutations: 128,
          stateKeyBytes: 256,
          stateValueBytes: 65_536,
          stateTotalBytes: 1_048_576,
          sleepMs: 30_000
        }
      }
    );
    expect(result.output[0]).toHaveLength(4096);
    expect(result.originalBytes).toEqual([16_000_193]);
    expect(result.stateMutations).toHaveLength(1);
  });

  it('keeps JSON escaping, toJSON and Unicode intact in streamed text', async () => {
    const source = `({a:["你😀\\n\\"\\\\",true,null,Infinity],b:{toJSON(key){return key;}},c:new String("boxed")})`;
    const result = await executeFull(
      `const value=${source}; observe.text(value); observe.text(JSON.stringify(value));`
    );
    expect(result.output[0]).toBe(result.output[1]);
    expect(result.originalBytes[0]).toBe(Buffer.byteLength(result.output[0]!));
  });

  it('does not expose the trusted text sink through caller introspection', async () => {
    const result = await execute(
      'observe.text({toJSON(){try { return this.toJSON.caller.caller.arguments[1]; } catch { return "blocked"; }}});'
    );
    expect(result).toEqual(['"blocked"']);
  });
  it('bridges concurrent JSON results and rejects tools with stable diagnostics', async () => {
    expect(
      await execute(`
      const result = await Promise.all([tools.echo({value: 1}), tools.echo({value: 2})]);
      observe.text(result.map(item => item.data.value));
    `)
    ).toEqual(['[1,2]']);
    expect(
      await execute(
        `
      try { await tools.echo({}); } catch (error) { observe.text(error.code); }
    `,
        {
          onToolCall: async () => {
            throw Object.assign(new Error('denied'), { code: 'DENIED' });
          }
        }
      )
    ).toEqual(['DENIED']);
  });

  it.each(['node:fs', 'node:child_process', 'data:text/javascript,export default 1', './local.js'])(
    'denies every module specifier: %s',
    async (specifier) => {
      expect(
        await execute(`
        try { await import(${JSON.stringify(specifier)}); } catch (error) { observe.text(error.code); }
      `)
      ).toEqual(['MAR_AGENT_CODE_IMPORT_DENIED']);
    }
  );

  it('does not expose Host APIs through constructors or eval', async () => {
    expect(
      await execute(`
      observe.text(Function("return typeof process")());
      observe.text(eval("typeof console"));
      observe.text([typeof require, typeof Buffer, typeof fetch, typeof WebAssembly,
        typeof SharedArrayBuffer, typeof Atomics, typeof TextEncoder, typeof TextDecoder]);
    `)
    ).toEqual([
      'undefined',
      'undefined',
      '["undefined","undefined","undefined","undefined","undefined","undefined","undefined","undefined"]'
    ]);
  });

  it('interrupts synchronous loops and busy guest job queues', async () => {
    await expect(execute('while (true) {}')).rejects.toMatchObject({
      code: 'MAR_AGENT_CODE_TIMEOUT'
    });
    await expect(execute('while (true) { await Promise.resolve(); }')).rejects.toMatchObject({
      code: 'MAR_AGENT_CODE_TIMEOUT'
    });
  });

  it.each(['success', 'failure'] as const)(
    'excludes asynchronous tool waiting from the execution budget (%s)',
    async (outcome) => {
      const output = await execute(
        `
        try { await tools.echo({}); observe.text("success"); }
        catch (error) { observe.text(error.code); }
        const end = Date.now() + 5; while (Date.now() < end) {}
        observe.text("continued");
      `,
        {
          onToolCall: async () => {
            await new Promise((resolve) => setTimeout(resolve, 160));
            if (outcome === 'failure')
              throw Object.assign(new Error('Tool failed.'), { code: 'FAILURE' });
            return { content: 'ok' };
          }
        }
      );
      expect(output).toEqual([outcome === 'success' ? 'success' : 'FAILURE', 'continued']);
    }
  );

  it('excludes cancellable sleep from the execution budget', async () => {
    expect(
      await execute(
        'await cell.sleep(160); const end = Date.now() + 5; while (Date.now() < end) {} observe.text("awake");'
      )
    ).toEqual(['awake']);
  });

  it('charges guest callbacks entered while delivering a rejected Host tool', async () => {
    await expect(
      execute(
        `
      Object.defineProperty(Error.prototype, "code", {set() { while (true) {} }});
      await tools.echo({});
    `,
        {
          onToolCall: async () => {
            throw new Error('Tool failed.');
          }
        }
      )
    ).rejects.toMatchObject({ code: 'MAR_AGENT_CODE_TIMEOUT' });
  });

  it('accumulates guest execution across asynchronous tool waits', async () => {
    const output: string[] = [];
    await expect(
      execute(
        `
      function work() { const end = Date.now() + 60; while (Date.now() < end) {} }
      work();
      await tools.echo({});
      observe.text("resumed");
      work();
    `,
        {
          onToolCall: async () => {
            await new Promise((resolve) => setTimeout(resolve, 160));
            return { content: 'ok' };
          },
          onObserve: (observation) => {
            if (observation.type === 'value') output.push(observation.value);
          }
        }
      )
    ).rejects.toMatchObject({ code: 'MAR_AGENT_CODE_TIMEOUT' });
    expect(output).toEqual(['resumed']);
  });

  it('bounds guest memory and recursion', async () => {
    await expect(
      execute('const values = []; while (true) { values.push(new Array(10000).fill(1)); }', {
        limits: {
          memoryBytes: 8_388_608,
          stackBytes: 262_144,
          timeoutMs: 5000,
          outputBytes: 4096,
          stateEntries: 128,
          stateMutations: 128,
          stateKeyBytes: 256,
          stateValueBytes: 65_536,
          stateTotalBytes: 1_048_576,
          sleepMs: 30_000
        }
      })
    ).rejects.toMatchObject({ code: 'MAR_AGENT_CODE_MEMORY_LIMIT' });
    await expect(execute('function recur() { return recur(); } recur();')).rejects.toMatchObject({
      code: 'MAR_AGENT_CODE_FAILED'
    });
  });

  it('rejects unresolved work and unsupported values but truncates ordinary text', async () => {
    await expect(execute('await new Promise(() => {});')).rejects.toMatchObject({
      code: 'MAR_AGENT_CODE_INCOMPLETE'
    });
    const invoked: unknown[] = [];
    const result = await executeFull(
      'observe.text("x".repeat(5000)); await tools.echo({after:true}); state.set("done",true);',
      {
        onToolCall: async (call) => {
          invoked.push(call.arguments);
          return { content: 'ok' };
        }
      }
    );
    expect(result.output.join('')).toHaveLength(4096);
    expect(invoked).toEqual([{ after: true }]);
    expect(result.stateMutations).toHaveLength(1);
    await expect(execute('await tools.echo({value: 1n});')).rejects.toMatchObject({
      code: 'MAR_AGENT_TOOL_INPUT_INVALID'
    });
    await expect(
      execute('await tools.echo({});', {
        onToolCall: async () => ({ content: 'bad', data: 1n })
      })
    ).rejects.toMatchObject({
      code: 'MAR_AGENT_CODE_ENGINE_FAILED',
      message: expect.stringMatching(/BigInt/)
    });
    await expect(
      execute('tools.echo({}); await cell.sleep(20); observe.text("done");')
    ).rejects.toMatchObject({
      code: 'MAR_AGENT_CODE_INCOMPLETE'
    });
  });

  it('releases pending host callbacks safely on cancellation', async () => {
    const controller = new AbortController();
    let release!: (value: { content: string }) => void;
    const run = execute('await tools.echo({});', {
      signal: controller.signal,
      onToolCall: () => {
        controller.abort(Object.assign(new Error('cancelled'), { code: 'CANCELLED' }));
        return new Promise((resolve) => {
          release = resolve;
        });
      }
    });
    await expect(run).rejects.toMatchObject({ code: 'CANCELLED' });
    release({ content: 'late' });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('exposes only frozen namespace APIs and no legacy output aliases', async () => {
    expect(
      await execute(`
        const names = ["tools", "observe", "state", "catalog", "cell"];
        const before = Object.fromEntries(names.map(name => [name, {
          frozen: Object.isFrozen(globalThis[name]),
          writable: Object.getOwnPropertyDescriptor(globalThis, name).writable,
          configurable: Object.getOwnPropertyDescriptor(globalThis, name).configurable
        }]));
        try { observe.extra = 1; } catch {}
        try { globalThis.observe = {}; } catch {}
        try { delete globalThis.state; } catch {}
        observe.text({ before, extra: typeof observe.extra, aliases: [typeof out, typeof text, typeof image] });
      `)
    ).toEqual([
      JSON.stringify({
        before: Object.fromEntries(
          ['tools', 'observe', 'state', 'catalog', 'cell'].map((name) => [
            name,
            { frozen: true, writable: false, configurable: false }
          ])
        ),
        extra: 'undefined',
        aliases: ['undefined', 'undefined', 'undefined']
      })
    ]);
  });

  it('buffers bounded JSON state mutations and exposes read-your-writes', async () => {
    const result = await executeFull(
      `
        observe.text([state.has("count"), state.get("count")]);
        state.set("count", 2);
        state.set("nested", { ok: true });
        observe.text([state.has("count"), state.get("count"), state.delete("missing")]);
        state.delete("old");
      `,
      {
        state: [
          { key: 'count', value: 1 },
          { key: 'old', value: true }
        ]
      }
    );
    expect(result.output).toEqual(['[true,1]', '[true,2,false]']);
    expect(result.stateMutations).toEqual([
      { operation: 'set', key: 'count', value: 2 },
      { operation: 'set', key: 'nested', value: { ok: true } },
      { operation: 'delete', key: 'old' }
    ]);
  });

  it('returns a deeply frozen catalog snapshot without expanding the tool surface', async () => {
    expect(
      await execute(`
        const entries = catalog.tools();
        try { entries.push({ name: "hidden" }); } catch {}
        try { entries[0].inputSchema.extra = true; } catch {}
        observe.text({
          entries,
          frozen: Object.isFrozen(entries) && Object.isFrozen(entries[0])
            && Object.isFrozen(entries[0].inputSchema),
          hidden: typeof tools.hidden
        });
      `)
    ).toEqual([
      JSON.stringify({
        entries: [
          {
            name: 'echo',
            description: 'Echo the input.',
            inputSchema: { type: 'object' }
          }
        ],
        frozen: true,
        hidden: 'function'
      })
    ]);
  });

  it('sleeps asynchronously and cancels a pending sleep', async () => {
    const started = Date.now();
    expect(await execute('await cell.sleep(20); observe.text("awake");')).toEqual(['awake']);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);

    const controller = new AbortController();
    const pending = execute('await cell.sleep(30000);', { signal: controller.signal });
    setTimeout(
      () => controller.abort(Object.assign(new Error('cancelled'), { code: 'CANCELLED' })),
      10
    );
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
