import { describe, expect, it } from 'vitest';
import { isGenericContextGcTool } from '../../src/session/context-gc-replacements.js';
import { executeThought, thoughtToolDefinition } from '../../src/tools/agent/thought.js';
import { codeModeToolDefinition, projectCodeModeTools } from '../../src/tools/code-mode/index.js';

describe('thought', () => {
  it('exposes compression and evidence guidance on the content field', () => {
    const tools = projectCodeModeTools([codeModeToolDefinition, thoughtToolDefinition]);
    const properties = tools.find(({ name }) => name === 'thought')?.inputSchema.properties;
    expect(properties).toMatchObject({
      title: { description: expect.stringContaining('human-readable title') },
      content: {
        description: expect.stringMatching(
          /reuse in subsequent reasoning[\s\S]+telegraphic fragments[\s\S]+preserve causal links and dependencies[\s\S]+distinguish verified facts from hypotheses/u
        )
      }
    });
  });

  it('accepts exactly 32 KiB UTF-8 without echoing either field', async () => {
    const title = '确认恢复策略';
    const content = '研'.repeat(10_922) + 'ok';
    expect(Buffer.byteLength(content)).toBe(32 * 1024);
    expect(await executeThought({ title, content })).toEqual({ content: '{"status":"recorded"}' });
    await expect(executeThought({ title, content: content + '!' })).rejects.toMatchObject({
      code: 'MAR_AGENT_TOOL_INPUT_INVALID'
    });
  });

  it.each([
    { content: 'A verified finding' },
    { title: 'Decision' },
    { title: 'Decision', content: 1 },
    { title: 'Decision', content: ' \n ' },
    { title: ' \n ', content: 'A verified finding' },
    { title: 'x'.repeat(257), content: 'A verified finding' }
  ])('rejects invalid Thought input: %j', async (input) => {
    await expect(executeThought(input)).rejects.toMatchObject({
      code: 'MAR_AGENT_TOOL_INPUT_INVALID'
    });
  });

  it('keeps the tool direct in Code Mode and out of generic GC', () => {
    const tools = projectCodeModeTools([codeModeToolDefinition, thoughtToolDefinition]);
    expect(tools.map(({ name }) => name)).toContain('thought');
    expect(tools.find(({ name }) => name === 'code_exec')?.description).not.toContain('"thought"');
    expect(isGenericContextGcTool('thought')).toBe(false);
  });
});
