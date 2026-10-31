import { afterEach, expect, it } from 'vitest';
import type { Agent } from '../../src/index.js';
import type { SessionExtensionContext } from '../../src/extensions.js';
import { createSubagentExtension } from '../../extensions/subagent/src/index.js';
import { answer, cleanupCoreFixtures, fixture } from './support/core-extension-fixture.js';
import { effectiveInstructions } from './support/model-context.js';

afterEach(cleanupCoreFixtures);

it.each([false, true])(
  'provides bounded delegation guidance with Code Mode %s',
  async (codeMode) => {
    let agent!: Agent;
    const setup = await fixture(
      [createSubagentExtension({ agent: () => agent })],
      answer,
      codeMode
    );
    agent = setup.agent;

    for (const prompt of ['Review the task', 'Continue the review']) {
      expect(await setup.session.run({ prompt }).result()).toHaveProperty('status', 'completed');
    }

    for (const request of setup.adapter.requests) {
      const instructions = effectiveInstructions(request);
      expect(instructions.match(/# Delegation and coordination/gu)).toHaveLength(1);
      expect(instructions).toContain(
        [
          '# Delegation and coordination',
          'Prefer handling focused or tightly coupled work locally.',
          'Consider delegating a clearly separable subtask when parallel progress or context savings materially outweigh coordination overhead.',
          'Avoid splitting work merely because agents are available.'
        ].join('\n\n')
      );
      expect(instructions).toContain('a read-only boundary or non-overlapping write scope');
      expect(instructions).toContain('Prefer following up through the direct delegate');
      expect(instructions).toContain('only when a concrete issue needs independent verification');
      expect(instructions).toContain(
        'prefer advancing meaningful, non-overlapping task work rather than duplicating delegated work'
      );
      expect(instructions).toContain(
        'Waiting is generally useful once no meaningful local task work remains and a required result is needed to unblock or finish the task.'
      );
      expect(instructions).toContain(
        'An accepted message normally needs no separate acknowledgment.'
      );
      expect(instructions).toContain(
        'Requests for receipt-only replies and immediate agent_view calls solely to confirm receipt are usually unnecessary.'
      );
      expect(instructions).toContain('retain responsibility for the final result');
      expect(instructions).not.toContain('agent_message');
      expect(instructions).not.toContain('agent_cancel');
      expect(instructions).not.toContain('never inside code_exec');
      expect(instructions).not.toContain('# Workspace collaboration');
      expect(JSON.stringify(request.tools)).toContain(
        'Send a message to a direct child or report to the direct parent.'
      );
    }
  }
);

it('conditions delegation guidance on the selected tools and mode without starting a model', async () => {
  let agent!: Agent;
  let context!: SessionExtensionContext;
  const setup = await fixture(
    [
      createSubagentExtension({ agent: () => agent }),
      {
        id: 'capture',
        apiVersion: '1.0',
        attachSession(value) {
          context = value;
        }
      }
    ],
    answer
  );
  agent = setup.agent;
  await setup.session.run({ prompt: 'Initialize' }).result();

  for (const [mode, tools, expected] of [
    ['run', ['read'], false],
    ['run', ['agent_start'], true],
    ['plan', ['agent_start'], true],
    ['compact', ['agent_start'], false]
  ] as const) {
    const composed = await context.prompts.composeDefault({ mode, tools });
    const instructions = composed.sections.map((section) => section.text ?? '').join('\n\n');
    expect(instructions.includes('# Delegation and coordination')).toBe(expected);
  }
  expect(setup.adapter.requests).toHaveLength(1);
});
