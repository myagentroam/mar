import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LocalAgentHost,
  SecretValue,
  type MarAgentEvent,
  type MarAgentModelConfiguration
} from '../../src/index.js';
import { createMarAgentWithAdapter as createMarAgent } from '../../src/agent-core/sdk/agent.js';
import { type ModelAdapter, type ModelEvent } from '../../src/agent-core/model/contracts.js';
import { describeMarAgentError, MarAgentError } from '../../src/agent-core/error.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const model: MarAgentModelConfiguration = {
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
    const error = new MarAgentError('service_unavailable_error', 'The model service is too busy.');
    expect(error).toMatchObject({
      code: 'service_unavailable_error',
      publicMessage: 'The model service is too busy.',
      message: 'service_unavailable_error: The model service is too busy.'
    });
  });

  it('retains bounded nested error causes with their codes', () => {
    const error = Object.assign(new Error('Failed to open AGENTS.md: access denied.'), {
      code: 'EACCES'
    });

    expect(describeMarAgentError(error, 'MAR_AGENT_EXECUTION_FAILED')).toEqual({
      code: 'EACCES',
      message: 'EACCES: Failed to open AGENTS.md: access denied.'
    });
  });

  it('emits and returns the underlying model failure detail', async () => {
    const { home, workspace } = await fixture();
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      adapterFactory: () => new ThrowingAdapter()
    });
    const handle = (await agent.createSession({ workspace, title: 'Error projection' })).run({
      prompt: 'run'
    });
    const events: MarAgentEvent[] = [];
    for await (const event of handle) events.push(event);

    await expect(handle.result()).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'EACCES',
      errorMessage: 'EACCES: Failed to open AGENTS.md: access denied.'
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'execution.failed',
          code: 'EACCES',
          message: 'EACCES: Failed to open AGENTS.md: access denied.'
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
    const agent = await createMarAgent({
      mode: 'normal',
      host,
      models: [model],
      adapterFactory: () => new ToolFailureAdapter()
    });
    const handle = (await agent.createSession({ workspace, title: 'Tool error projection' })).run({
      prompt: 'run'
    });
    const events: MarAgentEvent[] = [];
    for await (const event of handle) events.push(event);

    await expect(handle.result()).resolves.toMatchObject({ status: 'completed' });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool.failed',
          toolName: 'read',
          code: 'EACCES',
          message: 'EACCES: Workspace read failed: access denied.'
        })
      ])
    );
    await agent.dispose();
  });
});
