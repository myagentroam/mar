import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalAgentHost } from '../../src/host.js';
import { SecretValue, type AgentEvent, type AgentModelConfiguration } from '../../src/index.js';
import { createAgentWithAdapter as createMarAgent } from '../../src/sdk/agent.js';
import { type ModelAdapter, type ModelEvent } from '../../src/model/contracts.js';
import { describeAgentError, AgentError } from '../../src/error.js';
import { CodeCellExecutionError } from '../../src/tools/code-mode/cells.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const model: AgentModelConfiguration = {
  id: 'error-projection',
  name: 'Error projection',
  protocol: 'ANTHROPIC_MESSAGES',
  baseUrl: 'https://example.test',
  apiKey: new SecretValue('secret'),
  modelId: 'error-projection',
  contextWindowTokens: 200_000,
  maxOutputTokens: 4096,
  inputCapabilities: ['TEXT'],
  outputCapabilities: ['TEXT'],
  reasoningEfforts: [],
  hostedWebSearch: false,
  responsesPreviousResponseId: false,
  enabled: true
};

class ThrowingAdapter implements ModelAdapter {
  readonly configuration = model;

  start(): AsyncIterable<ModelEvent> {
    return {
      [Symbol.asyncIterator](): AsyncIterator<ModelEvent> {
        return {
          async next(): Promise<IteratorResult<ModelEvent>> {
            throw Object.assign(new Error('Failed to open AGENTS.md: access denied.'), {
              code: 'EACCES'
            });
          }
        };
      }
    };
  }
}

class ToolFailureAdapter implements ModelAdapter {
  readonly configuration = model;
  #calls = 0;

  async *start(): AsyncIterable<ModelEvent> {
    this.#calls++;
    if (this.#calls === 1) {
      yield {
        type: 'client_tool.call',
        callId: 'read-1',
        name: 'read',
        arguments: { path: 'AGENTS.md' }
      };
      yield { type: 'completed', reason: 'completed' };
      return;
    }
    yield { type: 'text.completed', itemId: 'answer-1', text: 'Recovered after the tool error.' };
    yield { type: 'completed', reason: 'completed' };
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mar-error-projection-'));
  roots.push(root);
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  await Promise.all([mkdir(home), mkdir(workspace)]);
  return { home, workspace };
}

describe('MAR Agent error projection', () => {
  it('provides the original readable model summary for public error boundaries', () => {
    const error = new AgentError('service_unavailable_error', 'The model service is too busy.');
    expect(error).toMatchObject({
      code: 'service_unavailable_error',
      publicMessage: 'The model service is too busy.',
      message: 'service_unavailable_error: The model service is too busy.'
    });
  });

  it('separates the top-level error code from its readable message', () => {
    const error = Object.assign(new Error('Failed to open AGENTS.md: access denied.'), {
      code: 'EACCES'
    });

    expect(describeAgentError(error, 'MAR_AGENT_EXECUTION_FAILED')).toEqual({
      code: 'EACCES',
      message: 'Failed to open AGENTS.md: access denied.'
    });
  });

  it('retains distinct cause codes without duplicating the outer code or summary', () => {
    const cause = new AgentError('EACCES', 'Underlying access denied.');
    const error = new AgentError('TEST_TOOL_FAILED', 'Expected tool failure.', { cause });
    expect(describeAgentError(error, 'MAR_AGENT_EXECUTION_FAILED')).toEqual({
      code: 'TEST_TOOL_FAILED',
      message: 'Expected tool failure. Caused by: EACCES: Underlying access denied.'
    });
    expect(
      describeAgentError(
        new AgentError(error.code, error.publicMessage, { cause: error }),
        'MAR_AGENT_EXECUTION_FAILED'
      )
    ).toEqual(describeAgentError(error, 'MAR_AGENT_EXECUTION_FAILED'));
  });

  it('projects a cell wrapper and its cause chain exactly once', () => {
    const cause = Object.assign(new Error('Access denied.'), { code: 'EACCES' });
    const error = new AgentError('TEST_TOOL_FAILED', 'Tool failed.', { cause, retryable: true });
    const wrapped = new CodeCellExecutionError(error, { content: '' });
    expect(wrapped.cause).toBe(error);
    expect(wrapped.retryable).toBe(true);
    expect(describeAgentError(wrapped, 'MAR_AGENT_CODE_FAILED')).toEqual({
      code: 'TEST_TOOL_FAILED',
      message: 'Tool failed. Caused by: EACCES: Access denied.'
    });
    expect(
      describeAgentError(
        new CodeCellExecutionError(wrapped, { content: '' }),
        'MAR_AGENT_CODE_FAILED'
      )
    ).toEqual(describeAgentError(wrapped, 'MAR_AGENT_CODE_FAILED'));
  });

  it('emits and returns the underlying model failure detail', async () => {
    const { home, workspace } = await fixture();
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [model]
      },
      () => new ThrowingAdapter()
    );
    const handle = (await agent.createSession({ workspace, title: 'Error projection' })).run({
      prompt: 'run'
    });
    const events: AgentEvent[] = [];
    for await (const event of handle) events.push(event);

    await expect(handle.result()).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'EACCES',
      errorMessage: 'Failed to open AGENTS.md: access denied.'
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'execution.failed',
          code: 'EACCES',
          message: 'Failed to open AGENTS.md: access denied.'
        })
      ])
    );
    await agent.dispose();
  });

  it('includes a tool failure reason in the emitted tool event', async () => {
    const { home, workspace } = await fixture();
    const host = new LocalAgentHost({ homeDirectory: home, workspace });
    vi.spyOn(host, 'executeTool').mockRejectedValue(
      Object.assign(new Error('Workspace read failed: access denied.'), { code: 'EACCES' })
    );
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host,
        models: [model]
      },
      () => new ToolFailureAdapter()
    );
    const handle = (await agent.createSession({ workspace, title: 'Tool error projection' })).run({
      prompt: 'run'
    });
    const events: AgentEvent[] = [];
    for await (const event of handle) events.push(event);

    await expect(handle.result()).resolves.toMatchObject({ status: 'completed' });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool.failed',
          toolName: 'read',
          code: 'EACCES',
          message: 'Workspace read failed: access denied.'
        })
      ])
    );
    await agent.dispose();
  });
});
