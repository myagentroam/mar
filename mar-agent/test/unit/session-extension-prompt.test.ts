import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createSessionExtensionPrompt } from '../../src/sdk/session-extension-prompt.js';

it.each(['execution-only-idle', 'throwing-idle', 'throwing-running'] as const)(
  'composes without consulting Skill providers: %s',
  async (scenario) => {
    const listExecutionExtensions = vi.fn(async () => {
      throw new Error('Skill provider must not be queried');
    });
    const listSessionSkills = vi.fn(async () => {
      throw new Error('Skill provider must not be queried');
    });
    const model = { id: 'm', inputCapabilities: ['TEXT'], codeMode: false };
    const state = { models: new Map([['m', model]]), defaultModelId: 'm' };
    const prompt = createSessionExtensionPrompt({
      sessionId: 's',
      source: 'user',
      home: '/unused',
      workspace: '/unused',
      displayWorkspace: '/unused',
      codeExecute: false,
      host:
        scenario === 'execution-only-idle'
          ? { listExecutionExtensions }
          : { listExecutionExtensions, listSessionSkills },
      execution: () =>
        scenario === 'throwing-running'
          ? { ...state, modelId: 'm', mode: 'plan', executionId: 'e', instruction: undefined }
          : undefined,
      models: () => state,
      instruction: () => undefined,
      workspaceMapped: () => false,
      capture: () => new Map(),
      sections: () => [{ id: 'core:identity', text: 'Core instructions' }]
    } as never);
    const result = await prompt({}, { signal: new AbortController().signal } as never);
    expect(result.sections).toEqual([{ id: 'core:identity', text: 'Core instructions' }]);
    expect(result.facts).toEqual({
      modelId: 'm',
      mode: scenario === 'throwing-running' ? 'plan' : 'run',
      tools: []
    });
    expect(listExecutionExtensions).not.toHaveBeenCalled();
    expect(listSessionSkills).not.toHaveBeenCalled();
  }
);

it.each([
  ['idle', false],
  ['idle', true],
  ['running', false],
  ['running', true]
] as const)(
  'keeps model, tool availability and Host capability boundaries when %s (code.execute=%s)',
  async (phase, codeExecute) => {
    const textModel = { id: 'text', inputCapabilities: ['TEXT'], codeMode: false };
    const imageModel = { id: 'image', inputCapabilities: ['TEXT', 'IMAGE'], codeMode: true };
    const models = new Map([
      ['text', textModel],
      ['image', imageModel]
    ]);
    const bindings = new Map(
      ['read', 'question', 'view_image', 'code_exec', 'disabled'].map((name) => [
        name,
        { definition: { name }, ...(name === 'disabled' ? { available: () => false } : {}) }
      ])
    );
    const prompt = createSessionExtensionPrompt({
      source: 'user',
      codeExecute,
      execution: () =>
        phase === 'running'
          ? { models, modelId: 'image', mode: 'plan', instruction: 'snapshot' }
          : undefined,
      models: () => ({ models, defaultModelId: 'text' }),
      instruction: () => 'idle',
      capture: () => bindings,
      sections: (tools, _mode, _model, instruction) => [
        { id: 'fixture', text: `${instruction}:${tools.map((tool) => tool.name).join(',')}` }
      ]
    } as Parameters<typeof createSessionExtensionPrompt>[0]);
    const call = { signal: new AbortController().signal } as never;
    const defaults = await prompt({}, call);
    expect(defaults.facts).toEqual(
      phase === 'running'
        ? {
            modelId: 'image',
            mode: 'plan',
            tools: ['read', 'question', 'view_image', ...(codeExecute ? ['code_exec'] : [])]
          }
        : { modelId: 'text', mode: 'run', tools: ['read'] }
    );
    expect(defaults.sections[0]?.text).toContain(phase === 'running' ? 'snapshot:' : 'idle:');
    const selected = await prompt(
      {
        modelId: 'image',
        mode: 'run',
        tools: ['disabled', 'view_image', 'code_exec', 'read', 'missing']
      },
      call
    );
    expect(selected.facts.tools).toEqual([
      'view_image',
      ...(codeExecute ? ['code_exec'] : []),
      'read'
    ]);
    await expect(prompt({ modelId: 'missing' }, call)).rejects.toMatchObject({
      code: 'MAR_AGENT_MODEL_DISABLED'
    });
    const aborted = new AbortController();
    aborted.abort();
    await expect(prompt({}, { signal: aborted.signal } as never)).rejects.toMatchObject({
      name: 'AbortError'
    });
  }
);

it('rejects a preview without real tool sources', async () => {
  const model = { id: 'm', inputCapabilities: ['TEXT'], codeMode: false };
  const prompt = createSessionExtensionPrompt({
    source: 'user',
    codeExecute: false,
    execution: () => undefined,
    models: () => ({ models: new Map([['m', model]]), defaultModelId: 'm' }),
    instruction: () => undefined,
    capture: () => undefined,
    sections: () => []
  } as never);
  await expect(prompt({}, { signal: new AbortController().signal } as never)).rejects.toMatchObject(
    {
      code: 'MAR_AGENT_EXTENSION_PROMPT_UNAVAILABLE'
    }
  );
});

it('filters unavailable tools for the requested model without loading the idle Skill catalog', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-prompt-'));
  try {
    const names = ['read', 'question', 'view_image', 'code_exec', 'agent_start'];
    const bindings = new Map(
      names.map((name) => [
        name,
        {
          definition: {
            name,
            ...(name === 'agent_start' ? { agentScope: 'ROOT_ONLY' } : {})
          }
        }
      ])
    );
    const skills = vi.fn(async () => []);
    const model = { id: 'm', inputCapabilities: [], codeMode: false };
    const prompt = createSessionExtensionPrompt({
      sessionId: 's',
      source: 'subagent',
      home: root,
      workspace: root,
      displayWorkspace: root,
      codeExecute: true,
      host: { listSessionSkills: skills },
      execution: () => undefined,
      models: () => ({ models: new Map([['m', model]]), defaultModelId: 'm' }),
      instruction: () => undefined,
      workspaceMapped: () => false,
      capture: () => bindings,
      sections: (tools) => tools.map((tool) => ({ id: tool.name, text: tool.name }))
    } as never);
    const result = await prompt({}, { signal: new AbortController().signal } as never);
    expect(result.facts.tools).toEqual(['read']);
    expect(skills).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
