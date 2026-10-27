import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createSessionExtensionPrompt } from '../../src/sdk/session-extension-prompt.js';

it('filters unavailable tools for the requested model before loading the idle Skill catalog', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-prompt-'));
  try {
    const names = ['read', 'question', 'view_image', 'code_exec', 'agent_start'];
    const bindings = new Map(names.map((name) => [name, { definition: { name } }]));
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
    expect(skills).toHaveBeenCalledOnce();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
