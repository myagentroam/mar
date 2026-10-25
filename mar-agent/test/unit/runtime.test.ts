import { baseMessages, effectiveInstructions } from './support/model-context.js';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForNewChild } from './support/subagent-wait.js';
import {
  LocalAgentHost,
  MarAgentError,
  SecretValue,
  type HostSessionResourceSnapshot,
  type MarAgentModelConfiguration
} from '../../src/index.js';
import { AnthropicMessagesAdapter } from '../../src/agent-core/model/anthropic-messages.js';
import { observeModelStreamEvent } from '../../src/agent-core/model/sse.js';
import { modelRetryMaxAttempts } from '../../src/agent-core/model/http.js';
import { createMarAgentWithAdapter as createMarAgent } from '../../src/agent-core/sdk/agent.js';
import {
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest
} from '../../src/agent-core/model/contracts.js';
import { TOOL_EXECUTION_LIMITS } from '../../src/agent-core/tools/execution-limits.js';
import { openMarAgentSessionCatalog } from '../../src/agent-core/session/catalog.js';
import { JsonlSessionStore } from '../../src/agent-core/session/store/index.js';
import { countModelTokens } from '../../src/agent-core/runtime/token-budget.js';

const homes: string[] = [];
const modelServers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    modelServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
const model: MarAgentModelConfiguration = {
  id: 'coding',
  name: 'Coding',
  protocol: 'ANTHROPIC_MESSAGES',
  baseUrl: 'https://example.test',
  apiKey: new SecretValue('secret'),
  modelId: 'coding',
  contextWindowTokens: 200_000,
  maxOutputTokens: 4096,
  inputCapabilities: ['TEXT'],
  outputCapabilities: ['TEXT'],
  reasoningEfforts: [],
  defaultReasoningEffort: 'medium',
  hostedWebSearch: false,
  responsesPreviousResponseId: false,
  enabled: true
};

class StaticResourceHost extends LocalAgentHost {
  override async listSessionResources(): Promise<HostSessionResourceSnapshot> {
    return {
      processes: [
        {
          processId: 'retained-process',
          status: 'running',
          command: 'long-running-command',
          cwd: '/workspace'
        }
      ]
    };
  }
}

class ScriptedAdapter implements ModelAdapter {
  readonly configuration = model;
  calls = 0;
  async *start(): AsyncIterable<ModelEvent> {
    this.calls++;
    yield { type: 'response.started', responseId: `r${this.calls}` };
    if (this.calls === 1) {
      yield {
        type: 'client_tool.call',
        callId: 'c1',
        name: 'read',
        arguments: { reads: [{ path: 'input.txt' }] }
      };
      yield { type: 'completed', reason: 'tool_use' };
    } else {
      yield { type: 'text.delta', itemId: 'm1', phase: 'final_answer', delta: 'fin' };
      await new Promise((resolve) => setTimeout(resolve, 5));
      yield { type: 'text.delta', itemId: 'm1', phase: 'final_answer', delta: 'ished' };
      yield { type: 'text.completed', itemId: 'm1', text: 'finished' };
      yield { type: 'usage', usage: { outputTokens: 8 } };
      yield { type: 'completed', reason: 'completed' };
    }
  }
}

class CommentaryAdapter implements ModelAdapter {
  readonly configuration = model;
  calls = 0;
  async *start(): AsyncIterable<ModelEvent> {
    this.calls++;
    if (this.calls === 1) {
      yield { type: 'text.delta', itemId: 'progress', phase: 'commentary', delta: 'Checking.' };
      yield {
        type: 'text.completed',
        itemId: 'progress',
        phase: 'commentary',
        text: 'Checking.'
      };
      yield {
        type: 'client_tool.call',
        callId: 'read',
        name: 'read',
        arguments: { reads: [{ path: 'input.txt' }] }
      };
      yield { type: 'completed', reason: 'tool_use' };
      return;
    }
    yield { type: 'text.delta', itemId: 'answer', phase: 'final_answer', delta: 'Done.' };
    yield {
      type: 'text.completed',
      itemId: 'answer',
      phase: 'final_answer',
      text: 'Done.'
    };
    yield { type: 'completed', reason: 'completed' };
  }
}

class WorkflowAdapter implements ModelAdapter {
  readonly configuration = model;
  calls = 0;
  readonly requests: ModelRequest[] = [];
  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    this.calls++;
    if (this.calls === 1) {
      yield {
        type: 'client_tool.call',
        callId: 'todo',
        name: 'todo_write',
        arguments: {
          items: [{ id: 'one', step: 'Work', status: 'in_progress' }]
        }
      };
      yield { type: 'completed', reason: 'tool_use' };
    } else if (this.calls === 2) {
      yield {
        type: 'client_tool.call',
        callId: 'question',
        name: 'question',
        arguments: {
          questions: [
            {
              id: 'choice',
              header: 'Choice',
              question: 'Choose',
              options: [
                { label: 'A', description: 'Use A' },
                { label: 'B', description: 'Use B' }
              ]
            }
          ]
        }
      };
      yield { type: 'completed', reason: 'tool_use' };
    } else {
      yield { type: 'text.completed', itemId: 'final', text: 'selected' };
      yield { type: 'completed', reason: 'completed' };
    }
  }
}

class SessionTodoAdapter implements ModelAdapter {
  readonly configuration = model;
  calls = 0;
  constructor(
    private readonly items: readonly {
      id: string;
      step: string;
      status: 'pending' | 'in_progress' | 'completed';
    }[],
    private readonly terminal: 'complete' | 'cancel' | 'fail' = 'complete'
  ) {}
  async *start(_request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    this.calls++;
    if (this.calls === 1) {
      yield {
        type: 'client_tool.call',
        callId: 'todo',
        name: 'todo_write',
        arguments: {
          items: this.items
        }
      };
      yield { type: 'completed', reason: 'tool_use' };
      return;
    }
    if (this.terminal === 'cancel')
      await new Promise<never>((_resolve, reject) => {
        const cancel = () => reject(signal.reason);
        if (signal.aborted) cancel();
        else signal.addEventListener('abort', cancel, { once: true });
      });
    if (this.terminal === 'fail') throw new Error('Simulated provider failure.');
    yield { type: 'text.completed', itemId: 'final', text: 'continued' };
    yield { type: 'completed', reason: 'completed' };
  }
}

class HistoryAdapter implements ModelAdapter {
  readonly configuration = model;
  readonly requests: ModelRequest[] = [];
  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    if (this.requests.length === 3) {
      yield { type: 'text.delta', itemId: 'answer', phase: 'final_answer', delta: 'answer-' };
      yield {
        type: 'reasoning.completed',
        representation: 'summary',
        itemId: 'reasoning',
        text: 'Compaction reasoning must remain internal.'
      };
    }
    yield { type: 'text.completed', itemId: 'answer', text: `answer-${this.requests.length}` };
    yield { type: 'completed', reason: 'completed' };
  }
}

class SkillSelectingAdapter implements ModelAdapter {
  readonly configuration = model;
  readonly requests: ModelRequest[] = [];
  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      yield {
        type: 'client_tool.call',
        callId: 'skill-call',
        name: 'skill',
        arguments: { name: 'deploy' }
      };
      yield { type: 'completed', reason: 'tool_use' };
      return;
    }
    yield { type: 'text.completed', itemId: 'answer', text: 'deployed safely' };
    yield { type: 'completed', reason: 'completed' };
  }
}

class TitleAdapter implements ModelAdapter {
  readonly configuration = model;
  readonly requests: ModelRequest[] = [];
  constructor(private readonly failTitle = false) {}
  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    if (request.system.includes('session title generator')) {
      if (this.failTitle) throw new Error('title unavailable');
      yield {
        type: 'text.completed',
        itemId: 'title',
        text: `<think>hidden</think>\n  ${'Title'.repeat(12)}  `
      };
      yield { type: 'completed', reason: 'completed' };
      return;
    }
    yield { type: 'text.completed', itemId: 'answer', text: 'done' };
    yield { type: 'completed', reason: 'completed' };
  }
}

class ResponsesHistoryAdapter implements ModelAdapter {
  readonly requests: ModelRequest[] = [];
  readonly configuration: MarAgentModelConfiguration = {
    ...model,
    protocol: 'OPENAI_RESPONSES',
    responsesPreviousResponseId: true
  };
  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    const sequence = this.requests.length;
    yield { type: 'response.started', responseId: `response-${sequence}` };
    yield {
      type: 'response.item',
      provider: 'OPENAI_RESPONSES',
      item: {
        type: 'reasoning',
        id: `reasoning-${sequence}`,
        encrypted_content: `opaque-${sequence}`,
        summary: []
      }
    };
    yield { type: 'text.completed', itemId: `answer-${sequence}`, text: `answer-${sequence}` };
    yield { type: 'completed', reason: 'completed' };
  }
}

class CompletedCommentaryEarlyEofAdapter implements ModelAdapter {
  readonly requests: ModelRequest[] = [];
  readonly configuration: MarAgentModelConfiguration = {
    ...model,
    protocol: 'OPENAI_RESPONSES',
    responsesPreviousResponseId: true
  };
  constructor(private readonly earlyEofFailures = 1) {}
  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    if (this.requests.length <= this.earlyEofFailures) {
      yield { type: 'response.started', responseId: 'response-interrupted' };
      yield {
        type: 'text.delta',
        itemId: 'commentary',
        phase: 'commentary',
        delta: 'Preparing the document structure.'
      };
      yield {
        type: 'response.item',
        provider: 'OPENAI_RESPONSES',
        item: {
          type: 'message',
          id: 'commentary',
          phase: 'commentary',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Preparing the document structure.' }]
        }
      };
      yield {
        type: 'text.completed',
        itemId: 'commentary',
        phase: 'commentary',
        text: 'Preparing the document structure.'
      };
      throw new MarAgentError(
        'MAR_AGENT_MODEL_PROTOCOL_ERROR',
        'OpenAI Responses stream ended without a terminal event.',
        {
          details: { reason: 'OPENAI_RESPONSES_EARLY_EOF', retryAfter: '0' },
          retryable: true
        }
      );
    }
    yield { type: 'response.started', responseId: 'response-recovered' };
    yield {
      type: 'text.completed',
      itemId: 'answer',
      phase: 'final_answer',
      text: 'Document completed in bounded sections.'
    };
    yield { type: 'completed', reason: 'completed' };
  }
}

class ToolCallEarlyEofAdapter implements ModelAdapter {
  readonly requests: ModelRequest[] = [];
  readonly configuration: MarAgentModelConfiguration = {
    ...model,
    protocol: 'OPENAI_RESPONSES',
    responsesPreviousResponseId: true
  };
  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    if (this.requests.length > 1) {
      yield { type: 'response.started', responseId: 'response-tool-recovered' };
      yield {
        type: 'text.completed',
        itemId: 'answer',
        phase: 'final_answer',
        text: 'Recovered after the interrupted tool round.'
      };
      yield { type: 'completed', reason: 'completed' };
      return;
    }
    yield { type: 'response.started', responseId: 'response-tool-interrupted' };
    yield {
      type: 'client_tool.call',
      callId: 'patch-interrupted',
      name: 'apply_patch',
      arguments: [
        '*** Begin Patch',
        '*** Add File: should-not-exist.txt',
        '+unexpected',
        '*** End Patch'
      ].join('\n')
    };
    throw new MarAgentError(
      'MAR_AGENT_MODEL_PROTOCOL_ERROR',
      'OpenAI Responses stream ended without a terminal event.',
      {
        details: { reason: 'OPENAI_RESPONSES_EARLY_EOF' },
        retryable: true
      }
    );
  }
}

class ParallelToolsAdapter implements ModelAdapter {
  readonly configuration = model;
  readonly requests: ModelRequest[] = [];
  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      yield {
        type: 'client_tool.call',
        callId: 'first',
        name: 'read',
        arguments: { reads: [{ path: 'a.txt' }] }
      };
      yield {
        type: 'client_tool.call',
        callId: 'second',
        name: 'read',
        arguments: { reads: [{ path: 'b.txt' }] }
      };
      yield { type: 'completed', reason: 'tool_use' };
      return;
    }
    yield { type: 'text.completed', itemId: 'answer', text: 'done' };
    yield { type: 'completed', reason: 'completed' };
  }
}

class ParallelExecToolsAdapter implements ModelAdapter {
  readonly configuration = model;
  readonly requests: ModelRequest[] = [];
  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      yield {
        type: 'client_tool.call',
        callId: 'exec-first',
        name: 'exec',
        arguments: {
          command: `${JSON.stringify(process.execPath)} -e "setTimeout(() => process.stdout.write('first'), 100)"`
        }
      };
      yield {
        type: 'client_tool.call',
        callId: 'exec-second',
        name: 'exec',
        arguments: {
          command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('second')"`
        }
      };
      yield { type: 'completed', reason: 'tool_use' };
      return;
    }
    yield { type: 'text.completed', itemId: 'answer', text: 'done' };
    yield { type: 'completed', reason: 'completed' };
  }
}

class ExecPersistenceAdapter implements ModelAdapter {
  readonly configuration = model;
  readonly requests: ModelRequest[] = [];
  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      yield {
        type: 'client_tool.call',
        callId: 'exec-1',
        name: 'exec',
        arguments: {
          command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('persisted-output')"`
        }
      };
      yield { type: 'completed', reason: 'tool_use' };
      return;
    }
    yield { type: 'text.completed', itemId: 'answer', text: 'done' };
    yield { type: 'completed', reason: 'completed' };
  }
}

class LargeExecPreviewAdapter implements ModelAdapter {
  readonly configuration = model;
  readonly requests: ModelRequest[] = [];
  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      yield {
        type: 'client_tool.call',
        callId: 'large-exec-preview',
        name: 'exec',
        arguments: {
          command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('out\\\\n'.repeat(7000)); process.stderr.write('err\\\\n'.repeat(7000))"`
        }
      };
      yield { type: 'completed', reason: 'tool_use' };
      return;
    }
    yield { type: 'text.completed', itemId: 'answer', text: 'done' };
    yield { type: 'completed', reason: 'completed' };
  }
}

class HostedExecResourceAdapter implements ModelAdapter {
  readonly configuration = model;
  readonly requests: ModelRequest[] = [];
  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      yield {
        type: 'client_tool.call',
        callId: 'hosted-exec',
        name: 'exec',
        arguments: {
          command: `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`,
          cwd: 'output',
          yieldMs: 10,
          timeoutMs: 10_000
        }
      };
      yield { type: 'completed', reason: 'tool_use' };
      return;
    }
    yield { type: 'text.completed', itemId: 'answer', text: 'done' };
    yield { type: 'completed', reason: 'completed' };
  }
}

class SubagentAdapter implements ModelAdapter {
  readonly configuration = model;
  constructor(readonly requests: ModelRequest[] = []) {}
  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    const child = effectiveInstructions(request).includes('non-recursive subagent');
    const wait = !child && waitForNewChild(request);
    if (wait) {
      yield wait;
      yield { type: 'completed', reason: 'tool_use' };
      return;
    }
    const hasToolResult = request.messages.some((message) => message.role === 'tool');
    if (!hasToolResult) {
      if (child) {
        yield {
          type: 'client_tool.call',
          callId: 'child-read',
          name: 'read',
          arguments: { reads: [{ path: 'input.txt' }] }
        };
        yield {
          type: 'client_tool.call',
          callId: 'child-read-second',
          name: 'read',
          arguments: { reads: [{ path: 'input-second.txt' }] }
        };
        yield {
          type: 'client_tool.call',
          callId: 'child-move',
          name: 'apply_patch',
          arguments: {
            patch:
              '*** Begin Patch\n*** Update File: move.txt\n*** Move to: moved.txt\n*** End Patch'
          }
        };
      } else
        yield {
          type: 'client_tool.call',
          callId: 'parent-task',
          name: 'agent_start',
          arguments: { description: 'Inspect input', prompt: 'Read input.txt', role: 'explore' }
        };
      yield { type: 'completed', reason: 'tool_use' };
      return;
    }
    if (child && !hasToolResult) {
      yield {
        type: 'client_tool.call',
        callId: 'child-read',
        name: 'read',
        arguments: { reads: [{ path: 'input.txt' }] }
      };
      yield { type: 'completed', reason: 'tool_use' };
      return;
    }
    yield {
      type: 'text.completed',
      itemId: child ? 'child-final' : 'parent-final',
      text: child ? 'x'.repeat(TOOL_EXECUTION_LIMITS.subagentSummaryMaxBytes + 100) : 'parent done'
    };
    yield { type: 'completed', reason: 'completed' };
  }
}

class EmptyFinalSubagentAdapter implements ModelAdapter {
  readonly configuration = model;
  readonly requests: ModelRequest[] = [];
  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    const child = effectiveInstructions(request).includes('non-recursive subagent');
    const wait = !child && waitForNewChild(request);
    if (wait) {
      yield wait;
      yield { type: 'completed', reason: 'tool_use' };
      return;
    }
    const hasToolResult = request.messages.some((message) => message.role === 'tool');
    if (!child && !hasToolResult) {
      yield {
        type: 'client_tool.call',
        callId: 'parent-task',
        name: 'agent_start',
        arguments: { description: 'Inspect input', prompt: 'Read input.txt', role: 'explore' }
      };
      yield { type: 'completed', reason: 'tool_use' };
      return;
    }
    if (child && !hasToolResult) {
      yield {
        type: 'text.completed',
        itemId: 'preliminary',
        text: 'Preliminary text before reading evidence.'
      };
      yield {
        type: 'client_tool.call',
        callId: 'child-read',
        name: 'read',
        arguments: { reads: [{ path: 'input.txt' }] }
      };
      yield { type: 'completed', reason: 'tool_use' };
      return;
    }
    if (child) {
      yield { type: 'completed', reason: 'completed' };
      return;
    }
    yield { type: 'text.completed', itemId: 'parent-final', text: 'parent done' };
    yield { type: 'completed', reason: 'completed' };
  }
}

class SubagentModelAdapter implements ModelAdapter {
  readonly configuration = model;
  constructor(
    readonly requests: ModelRequest[] = [],
    readonly requestedReasoningEffort?: () => string | undefined
  ) {}
  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    const child = effectiveInstructions(request).includes('non-recursive subagent');
    const wait = !child && waitForNewChild(request);
    if (wait) {
      yield wait;
      yield { type: 'completed', reason: 'tool_use' };
      return;
    }
    const hasToolResult = request.messages.some((message) => message.role === 'tool');
    if (!child && !hasToolResult) {
      const reasoningEffort = this.requestedReasoningEffort?.();
      yield {
        type: 'client_tool.call',
        callId: 'parent-task',
        name: 'agent_start',
        arguments: {
          description: 'Inspect input',
          prompt: 'Read input.txt',
          role: 'explore',
          modelId: 'review',
          ...(reasoningEffort === undefined ? {} : { reasoningEffort })
        }
      };
      yield { type: 'completed', reason: 'tool_use' };
      return;
    }
    yield {
      type: 'text.completed',
      itemId: child ? 'child-final' : 'parent-final',
      text: child ? 'child done' : 'parent done'
    };
    yield { type: 'completed', reason: 'completed' };
  }
}

class NoProgressAdapter implements ModelAdapter {
  readonly configuration = model;
  calls = 0;
  async *start(): AsyncIterable<ModelEvent> {
    this.calls++;
    if (this.calls > 3) {
      yield { type: 'text.completed', itemId: 'final', text: 'repeated checks complete' };
      yield { type: 'completed', reason: 'completed' };
      return;
    }
    yield {
      type: 'client_tool.call',
      callId: `repeat-${this.calls}`,
      name: 'read',
      arguments: { reads: [{ path: 'input.txt' }] }
    };
    yield { type: 'completed', reason: 'tool_use' };
  }
}

class BatchedNoProgressAdapter implements ModelAdapter {
  readonly configuration = model;
  calls = 0;
  async *start(): AsyncIterable<ModelEvent> {
    this.calls++;
    if (this.calls > 3) {
      yield { type: 'text.completed', itemId: 'final', text: 'batched checks complete' };
      yield { type: 'completed', reason: 'completed' };
      return;
    }
    for (const suffix of ['first', 'second'])
      yield {
        type: 'client_tool.call',
        callId: `${suffix}-${this.calls}`,
        name: 'read',
        arguments: { reads: [{ path: `${suffix}.txt` }] }
      };
    yield { type: 'completed', reason: 'tool_use' };
  }
}

class ToolRecoveryAdapter implements ModelAdapter {
  readonly configuration = model;
  calls = 0;
  readonly requests: ModelRequest[] = [];
  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.calls++;
    this.requests.push(request);
    if (this.calls <= 2) {
      yield {
        type: 'client_tool.call',
        callId: `patch-${this.calls}`,
        name: 'apply_patch',
        arguments:
          this.calls === 1
            ? { patch: 'invalid patch' }
            : {
                patch:
                  '*** Begin Patch\n*** Update File: input.txt\n@@\n-before\n+after\n*** End Patch'
              }
      };
      yield { type: 'completed', reason: 'tool_use' };
      return;
    }
    yield { type: 'text.completed', itemId: 'recovered', text: 'recovered' };
    yield { type: 'completed', reason: 'completed' };
  }
}

class MalformedToolRecoveryAdapter implements ModelAdapter {
  readonly configuration = model;
  calls = 0;
  readonly requests: ModelRequest[] = [];
  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.calls++;
    this.requests.push(request);
    if (this.calls === 1) {
      yield {
        type: 'client_tool.call',
        callId: 'malformed-1',
        name: 'read',
        arguments: {},
        argumentError: 'Tool arguments are invalid JSON.'
      };
      yield { type: 'completed', reason: 'tool_use' };
      return;
    }
    yield { type: 'text.completed', itemId: 'corrected', text: 'corrected' };
    yield { type: 'completed', reason: 'completed' };
  }
}

class CompactAdapter implements ModelAdapter {
  readonly requests: ModelRequest[] = [];
  constructor(
    readonly configuration: MarAgentModelConfiguration,
    private readonly initialAnswerCharacters = 400
  ) {}
  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    const text =
      request.toolChoice === 'none'
        ? 'short summary'
        : this.requests.length === 1
          ? 'x'.repeat(this.initialAnswerCharacters)
          : 'continued';
    yield { type: 'text.completed', itemId: 'message', text };
    yield { type: 'completed', reason: 'completed' };
  }
}

class CalibratedNativeCompactAdapter implements ModelAdapter {
  readonly requests: ModelRequest[] = [];
  private seeded = false;
  constructor(
    readonly configuration: MarAgentModelConfiguration,
    private readonly automatic: boolean,
    private readonly reportOutputTokens = true
  ) {}
  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    if (request.toolChoice === 'none') {
      yield { type: 'text.completed', itemId: 'summary', text: 'calibrated native summary' };
      yield { type: 'completed', reason: 'completed' };
      return;
    }
    const latestContent = baseMessages(request).at(-1)?.content;
    const isSeedRequest = latestContent === 'seed' || latestContent === 'durable objective';
    if (isSeedRequest && !this.seeded) this.seeded = true;
    yield {
      type: 'text.completed',
      itemId: 'answer',
      text: isSeedRequest
        ? '🌐tool-evidence'.repeat(4_000)
        : this.automatic
          ? 'continued after calibrated compact'
          : 'continued'
    };
    yield {
      type: 'usage',
      usage: {
        inputTokens: this.automatic ? 18_000 : 7_000,
        contextInputTokens: this.automatic ? 18_000 : 7_000,
        ...(this.reportOutputTokens ? { outputTokens: this.automatic ? 100 : 500 } : {})
      }
    };
    yield { type: 'completed', reason: 'completed' };
  }
}

class AppendOnlyToolCompactAdapter implements ModelAdapter {
  readonly requests: ModelRequest[] = [];
  private normalCalls = 0;
  constructor(readonly configuration: MarAgentModelConfiguration) {}
  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    if (request.toolChoice === 'none') {
      yield { type: 'text.completed', itemId: 'summary', text: 'append-only tool summary' };
      yield { type: 'completed', reason: 'completed' };
      return;
    }
    this.normalCalls++;
    if (this.normalCalls === 1) {
      yield {
        type: 'response.item',
        provider: 'OPENAI_RESPONSES',
        item: {
          type: 'reasoning',
          id: 'large-reasoning',
          encrypted_content: 'opaque-tool-evidence'.repeat(4_000),
          summary: []
        }
      };
      yield {
        type: 'client_tool.call',
        callId: 'small-read',
        name: 'read',
        arguments: { reads: [{ path: 'small.txt' }] }
      };
      yield {
        type: 'usage',
        usage: {
          inputTokens: 18_000,
          contextInputTokens: 18_000,
          outputTokens: 100,
          rolloutBudgetUnits: 60
        }
      };
      yield { type: 'completed', reason: 'tool_use' };
      return;
    }
    yield {
      type: 'text.completed',
      itemId: 'answer',
      text: 'continued after append-only tool compact'
    };
    yield { type: 'completed', reason: 'completed' };
  }
}

class StaleUsageCompactAdapter implements ModelAdapter {
  readonly requests: ModelRequest[] = [];
  constructor(readonly configuration: MarAgentModelConfiguration) {}
  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    if (request.toolChoice === 'none') {
      yield { type: 'text.completed', itemId: 'summary', text: 'bounded stale summary' };
      yield { type: 'completed', reason: 'completed' };
      return;
    }
    const latestContent = baseMessages(request).at(-1)?.content;
    yield {
      type: 'text.completed',
      itemId: 'answer',
      text: `${latestContent ?? 'title'}:${'stale-evidence'.repeat(4_000)}`
    };
    if (latestContent === 'first') {
      yield {
        type: 'usage',
        usage: {
          inputTokens: 7_000,
          contextInputTokens: 7_000,
          outputTokens: 500
        }
      };
    }
    yield { type: 'completed', reason: 'completed' };
  }
}

class CompactOverflowFallbackAdapter implements ModelAdapter {
  readonly requests: ModelRequest[] = [];
  normalCalls = 0;
  constructor(readonly configuration: MarAgentModelConfiguration) {}
  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    if (request.toolChoice === 'none') {
      if (baseMessages(request).length > 2)
        throw new (await import('../../src/agent-core/error.js')).MarAgentError(
          'context_length_exceeded',
          'Native compact exceeded the provider context window.'
        );
      yield { type: 'text.completed', itemId: 'summary', text: 'fallback summary' };
      yield { type: 'completed', reason: 'completed' };
      return;
    }
    this.normalCalls++;
    yield {
      type: 'text.completed',
      itemId: 'answer',
      text: this.normalCalls === 1 ? 'seeded' : 'continued after fallback'
    };
    yield {
      type: 'usage',
      usage: {
        inputTokens: this.normalCalls === 1 ? 8_200 : 100,
        contextInputTokens: this.normalCalls === 1 ? 8_200 : 100,
        outputTokens: 20
      }
    };
    yield { type: 'completed', reason: 'completed' };
  }
}

class MidExecutionCompactAdapter implements ModelAdapter {
  readonly requests: ModelRequest[] = [];
  compacted = false;
  normalCalls = 0;
  constructor(readonly configuration: MarAgentModelConfiguration) {}
  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    if (request.toolChoice === 'none') {
      this.compacted = true;
      yield { type: 'text.completed', itemId: 'summary', text: 'bounded exploration summary' };
      yield { type: 'completed', reason: 'completed' };
      return;
    }
    this.normalCalls++;
    if (this.normalCalls === 1) {
      yield {
        type: 'client_tool.call',
        callId: 'large-read',
        name: 'read',
        arguments: { reads: [{ path: 'large.txt' }] }
      };
      yield {
        type: 'usage',
        usage: { inputTokens: 11_000, contextInputTokens: 11_000, outputTokens: 20 }
      };
      yield { type: 'completed', reason: 'tool_use' };
      return;
    }
    yield {
      type: 'text.completed',
      itemId: 'answer',
      text: this.compacted ? 'continued after compact' : 'continued without compact'
    };
    yield { type: 'completed', reason: 'completed' };
  }
}

class ProviderUsageAdapter implements ModelAdapter {
  readonly requests: ModelRequest[] = [];
  constructor(
    readonly configuration: MarAgentModelConfiguration,
    private readonly reportedContextTokens = 1_000
  ) {}
  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    if (request.toolChoice === 'none') {
      yield { type: 'text.completed', itemId: 'summary', text: 'unexpected summary' };
      yield { type: 'completed', reason: 'completed' };
      return;
    }
    if (this.requests.filter((entry) => entry.toolChoice !== 'none').length === 1) {
      yield {
        type: 'client_tool.call',
        callId: 'calibrated-read',
        name: 'read',
        arguments: { reads: [{ path: 'calibrated.txt' }] }
      };
      yield {
        type: 'usage',
        usage: {
          inputTokens: this.reportedContextTokens,
          contextInputTokens: this.reportedContextTokens,
          outputTokens: 20
        }
      };
      yield { type: 'completed', reason: 'tool_use' };
      return;
    }
    yield { type: 'text.completed', itemId: 'answer', text: 'continued from calibrated usage' };
    yield { type: 'completed', reason: 'completed' };
  }
}

class PersistedUsageAdapter implements ModelAdapter {
  readonly requests: ModelRequest[] = [];
  constructor(
    readonly configuration: MarAgentModelConfiguration,
    public reportedContextTokens: number
  ) {}
  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    if (request.toolChoice === 'none') {
      yield { type: 'text.completed', itemId: 'summary', text: 'persisted usage summary' };
      yield { type: 'completed', reason: 'completed' };
      return;
    }
    yield { type: 'text.completed', itemId: 'answer', text: 'continued from persisted usage' };
    yield {
      type: 'usage',
      usage: {
        inputTokens: this.reportedContextTokens,
        contextInputTokens: this.reportedContextTokens,
        outputTokens: 20
      }
    };
    yield { type: 'completed', reason: 'completed' };
  }
}

class PostCompactUsageAdapter implements ModelAdapter {
  readonly requests: ModelRequest[] = [];
  private normalCalls = 0;
  constructor(readonly configuration: MarAgentModelConfiguration) {}
  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    if (request.toolChoice === 'none') {
      yield { type: 'text.completed', itemId: 'summary', text: 'post compact summary' };
      yield { type: 'completed', reason: 'completed' };
      return;
    }
    this.normalCalls++;
    yield { type: 'text.completed', itemId: 'answer', text: `answer-${this.normalCalls}` };
    yield {
      type: 'usage',
      usage: { inputTokens: 8_200, contextInputTokens: 8_200, outputTokens: 20 }
    };
    yield { type: 'completed', reason: 'completed' };
  }
}

class ResetUsageAdapter implements ModelAdapter {
  readonly requests: ModelRequest[] = [];
  readonly configuration: MarAgentModelConfiguration;
  constructor(configuration: MarAgentModelConfiguration) {
    this.configuration = configuration;
  }
  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    if (request.toolChoice === 'none') {
      yield { type: 'text.completed', itemId: 'summary', text: 'unexpected summary' };
      yield { type: 'completed', reason: 'completed' };
      return;
    }
    const normalCall = this.requests.filter((entry) => entry.toolChoice !== 'none').length;
    if (normalCall === 1) {
      yield {
        type: 'client_tool.call',
        callId: 'first',
        name: 'read',
        arguments: { reads: [{ path: 'first.txt' }] }
      };
      yield { type: 'usage', usage: { inputTokens: 27_000, contextInputTokens: 27_000 } };
      yield { type: 'usage', usage: { inputTokens: 0, contextInputTokens: 0 } };
      yield { type: 'completed', reason: 'tool_use' };
      return;
    }
    yield { type: 'text.completed', itemId: 'answer', text: 'continued after zero usage' };
    yield { type: 'completed', reason: 'completed' };
  }
}

class ContextOverflowAdapter implements ModelAdapter {
  readonly requests: ModelRequest[] = [];
  private normalCalls = 0;
  constructor(
    readonly configuration: MarAgentModelConfiguration,
    private readonly overflowAfterCompaction = false,
    private readonly overflowCode = 'context_length_exceeded',
    private readonly overflowMessage = 'The request exceeds the context window.',
    private readonly overflowStatus?: number
  ) {}
  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    if (request.toolChoice === 'none') {
      yield { type: 'text.completed', itemId: 'summary', text: 'overflow recovery summary' };
      yield { type: 'completed', reason: 'completed' };
      return;
    }
    this.normalCalls++;
    if (this.normalCalls === 1) {
      yield { type: 'text.completed', itemId: 'seed', text: 'seeded' };
      yield { type: 'completed', reason: 'completed' };
      return;
    }
    if (this.normalCalls === 2 || this.overflowAfterCompaction)
      throw new (await import('../../src/agent-core/error.js')).MarAgentError(
        this.overflowCode,
        this.overflowMessage,
        this.overflowStatus === undefined ? {} : { details: { status: this.overflowStatus } }
      );
    yield { type: 'text.completed', itemId: 'answer', text: 'continued after overflow compact' };
    yield { type: 'completed', reason: 'completed' };
  }
}

class PartialOutputOverflowAdapter implements ModelAdapter {
  readonly requests: ModelRequest[] = [];
  readonly configuration = model;
  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    yield { type: 'text.delta', itemId: 'partial', phase: 'final_answer', delta: 'partial' };
    throw new (await import('../../src/agent-core/error.js')).MarAgentError(
      'context_length_exceeded',
      'The request exceeds the context window.'
    );
  }
}

class EmptyCompletedAdapter implements ModelAdapter {
  readonly configuration = model;
  readonly requests: ModelRequest[] = [];
  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    if (request.retryState) request.retryState.retryDelayMs = 0;
    yield {
      type: 'usage',
      usage: { inputTokens: 0, contextInputTokens: 0, outputTokens: 0 }
    };
    yield { type: 'completed', reason: 'completed' };
  }
}

class MaxOutputContinuationAdapter implements ModelAdapter {
  readonly requests: ModelRequest[] = [];
  calls = 0;
  constructor(private readonly truncatedResponses = 1) {}
  readonly configuration = model;
  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    this.calls++;
    if (this.calls <= this.truncatedResponses) {
      yield {
        type: 'text.completed',
        itemId: `partial-${this.calls}`,
        phase: 'commentary',
        text: `partial ${this.calls}`
      };
      yield { type: 'completed', reason: 'max_output' };
      return;
    }
    yield { type: 'text.completed', itemId: 'answer', text: 'completed after continuation' };
    yield { type: 'completed', reason: 'completed' };
  }
}

class MaxOutputContinuationCompactionAdapter implements ModelAdapter {
  readonly requests: ModelRequest[] = [];
  calls = 0;
  constructor(readonly configuration: MarAgentModelConfiguration) {}
  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    this.calls++;
    if (request.toolChoice === 'none') {
      yield { type: 'text.completed', itemId: 'summary', text: 'compacted continuation state' };
      yield { type: 'completed', reason: 'completed' };
      return;
    }
    if (this.calls === 1) {
      yield {
        type: 'text.completed',
        itemId: 'partial',
        phase: 'commentary',
        text: 'partial before compact'
      };
      yield {
        type: 'usage',
        usage: { inputTokens: 29_000, contextInputTokens: 29_000, outputTokens: 8 }
      };
      yield { type: 'completed', reason: 'max_output' };
      return;
    }
    yield { type: 'text.completed', itemId: 'answer', text: 'completed after compact' };
    yield { type: 'completed', reason: 'completed' };
  }
}

class IncompleteToolMaxOutputAdapter implements ModelAdapter {
  readonly requests: ModelRequest[] = [];
  calls = 0;
  readonly configuration = model;
  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    this.calls++;
    if (this.calls === 1) {
      yield {
        type: 'client_tool.call',
        callId: 'incomplete-read',
        name: 'read',
        arguments: {},
        argumentError: 'Tool arguments are invalid JSON.'
      };
      yield { type: 'completed', reason: 'max_output' };
      return;
    }
    yield { type: 'text.completed', itemId: 'answer', text: 'completed after tool continuation' };
    yield { type: 'completed', reason: 'completed' };
  }
}

class MaxOutputContinuationWithToolAdapter implements ModelAdapter {
  readonly requests: ModelRequest[] = [];
  calls = 0;
  readonly configuration = model;
  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    this.calls++;
    if (this.calls === 1 || this.calls === 3) {
      yield {
        type: 'text.completed',
        itemId: `partial-${this.calls}`,
        phase: 'commentary',
        text: `partial ${this.calls}`
      };
      yield { type: 'completed', reason: 'max_output' };
      return;
    }
    if (this.calls === 2) {
      yield {
        type: 'client_tool.call',
        callId: 'todo-read',
        name: 'todo_read',
        arguments: {}
      };
      yield { type: 'completed', reason: 'max_output' };
      return;
    }
    yield { type: 'text.completed', itemId: 'answer', text: 'completed after tool round' };
    yield { type: 'completed', reason: 'completed' };
  }
}

class ModelSwitchOverflowAdapter implements ModelAdapter {
  readonly requests: ModelRequest[] = [];
  private overflowPending = true;
  constructor(readonly configuration: MarAgentModelConfiguration) {}
  async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    if (request.toolChoice === 'none') {
      yield { type: 'text.completed', itemId: 'summary', text: 'switched model summary' };
      yield { type: 'completed', reason: 'completed' };
      return;
    }
    if (this.overflowPending) {
      this.overflowPending = false;
      throw new (await import('../../src/agent-core/error.js')).MarAgentError(
        'context_length_exceeded',
        'The switched model has a smaller context window.'
      );
    }
    yield { type: 'text.completed', itemId: 'answer', text: 'continued on switched model' };
    yield { type: 'completed', reason: 'completed' };
  }
}

describe('agent runtime', () => {
  it('offers view_image only to vision models, forwards pixels, and never persists base64', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-image-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    const imageBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    await writeFile(join(workspace, 'pixel.png'), Buffer.from(imageBase64, 'base64'));
    const visionModel: MarAgentModelConfiguration = {
      ...model,
      id: 'vision',
      inputCapabilities: ['TEXT', 'IMAGE']
    };
    class ImageAdapter implements ModelAdapter {
      readonly configuration = visionModel;
      readonly requests: ModelRequest[] = [];
      async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
        this.requests.push(request);
        if (this.requests.length === 1) {
          expect(request.tools.map((tool) => tool.name)).toContain('view_image');
          expect(request.images).toMatchObject([
            { mimeType: 'image/png', dataBase64: imageBase64 }
          ]);
          yield {
            type: 'client_tool.call',
            callId: 'image',
            name: 'view_image',
            arguments: { path: 'pixel.png' }
          };
          yield { type: 'completed', reason: 'tool_use' };
          return;
        }
        expect(request.messages.at(-1)).toMatchObject({
          role: 'tool',
          images: [{ mimeType: 'image/png', dataBase64: imageBase64 }]
        });
        expect(request.promptCacheKey).toBe(this.requests[0]?.promptCacheKey);
        expect(request.tools.map((tool) => tool.name)).toEqual(
          this.requests[0]?.tools.map((tool) => tool.name)
        );
        yield { type: 'text.completed', itemId: 'answer', text: 'seen' };
        yield { type: 'completed', reason: 'completed' };
      }
    }
    const adapter = new ImageAdapter();
    const host = new LocalAgentHost({ homeDirectory: home, workspace });
    const agent = await createMarAgent({
      mode: 'normal',
      host,
      models: [visionModel],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace, title: 'Image' });
    await expect(
      session
        .run({
          prompt: 'view image',
          images: [{ name: 'pixel.png', mimeType: 'image/png', dataBase64: imageBase64 }]
        })
        .result()
    ).resolves.toMatchObject({ status: 'completed', finalAnswer: 'seen' });
    const persisted = await readFile(
      join(home, '.mar', 'agent', 'sessions', session.id, 'events-000001.jsonl'),
      'utf8'
    );
    const userRecord = persisted
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type?: string; payload?: unknown })
      .find((record) => record.type === 'turn.user');
    expect(userRecord?.payload).toMatchObject({
      prompt: 'view image',
      images: [
        {
          name: 'pixel.png',
          mimeType: 'image/png',
          byteSize: 68,
          fileName: expect.stringMatching(/\.bin$/u),
          sha256: createHash('sha256').update(Buffer.from(imageBase64, 'base64')).digest('hex')
        }
      ]
    });
    expect(persisted).toContain('image/png');
    expect(persisted).not.toContain(imageBase64);
    await agent.dispose();

    const textAdapter = new HistoryAdapter();
    const textHost = new LocalAgentHost({ homeDirectory: join(home, 'text-home'), workspace });
    const textAgent = await createMarAgent({
      mode: 'normal',
      host: textHost,
      models: [model],
      adapterFactory: () => textAdapter
    });
    const textSession = await textAgent.createSession({ workspace, title: 'Text' });
    await textSession.run({ prompt: 'inspect tools' }).result();
    expect(textAdapter.requests[0]?.tools.map((tool) => tool.name)).not.toContain('view_image');
    expect(textAdapter.requests[0]?.tools.map((tool) => tool.name)).not.toContain('skill');
    await textAgent.dispose();
  });
  it('restores user image pixels for later executions after the Agent restarts', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-image-history-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const imageBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const visionModel: MarAgentModelConfiguration = {
      ...model,
      id: 'vision-history',
      inputCapabilities: ['TEXT', 'IMAGE']
    };
    const firstAdapter: ModelAdapter = {
      configuration: visionModel,
      async *start(request) {
        expect(request.images).toMatchObject([{ mimeType: 'image/png', dataBase64: imageBase64 }]);
        yield { type: 'text.completed', itemId: 'first', text: 'Microsoft logo' };
        yield { type: 'completed', reason: 'completed' };
      }
    };
    const firstAgent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [visionModel],
      adapterFactory: () => firstAdapter
    });
    const session = await firstAgent.createSession({ workspace, title: 'Image history' });
    await expect(
      session
        .run({
          prompt: 'What is in the image?',
          images: [{ name: 'logo.png', mimeType: 'image/png', dataBase64: imageBase64 }]
        })
        .result()
    ).resolves.toMatchObject({ status: 'completed', finalAnswer: 'Microsoft logo' });
    await firstAgent.dispose();

    const eventsPath = join(home, '.mar', 'agent', 'sessions', session.id, 'events-000001.jsonl');
    const persisted = await readFile(eventsPath, 'utf8');
    const userRecord = persisted
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type?: string; payload?: Record<string, unknown> })
      .find((record) => record.type === 'turn.user');
    const storedImage = (
      userRecord?.payload?.images as
        | Array<{
            name: string;
            mimeType: string;
            byteSize: number;
            fileName?: string;
            sha256?: string;
          }>
        | undefined
    )?.[0];
    expect(storedImage).toMatchObject({
      name: 'logo.png',
      mimeType: 'image/png',
      byteSize: 68,
      fileName: expect.stringMatching(/\.bin$/u),
      sha256: createHash('sha256').update(Buffer.from(imageBase64, 'base64')).digest('hex')
    });
    expect(persisted).not.toContain(imageBase64);
    const storedImagePath = join(
      home,
      '.mar',
      'agent',
      'sessions',
      session.id,
      'images',
      storedImage!.fileName!
    );
    await expect(readFile(storedImagePath)).resolves.toEqual(Buffer.from(imageBase64, 'base64'));
    if (process.platform !== 'win32')
      expect((await stat(storedImagePath)).mode & 0o777).toBe(0o600);

    const secondAdapter: ModelAdapter = {
      configuration: visionModel,
      async *start(request) {
        expect(request.images).toBeUndefined();
        expect(request.messages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              role: 'user',
              content: 'What is in the image?',
              images: [expect.objectContaining({ mimeType: 'image/png', dataBase64: imageBase64 })]
            }),
            expect.objectContaining({ role: 'user', content: 'Look at it again.' })
          ])
        );
        yield { type: 'text.completed', itemId: 'second', text: 'Still a Microsoft logo' };
        yield { type: 'completed', reason: 'completed' };
      }
    };
    const secondAgent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [visionModel],
      adapterFactory: () => secondAdapter
    });
    const reopened = await secondAgent.openSession(session.id);
    await expect(reopened.run({ prompt: 'Look at it again.' }).result()).resolves.toMatchObject({
      status: 'completed',
      finalAnswer: 'Still a Microsoft logo'
    });
    await secondAgent.dispose();

    await writeFile(storedImagePath, 'corrupt');
    const degradedRequests: ModelRequest[] = [];
    const thirdAgent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [visionModel],
      adapterFactory: () => ({
        configuration: visionModel,
        async *start(request) {
          degradedRequests.push(request);
          yield { type: 'text.completed', itemId: 'third', text: 'Continued without the image' };
          yield { type: 'completed', reason: 'completed' };
        }
      })
    });
    const reopenedAgain = await thirdAgent.openSession(session.id);
    await expect(reopenedAgain.run({ prompt: 'Continue.' }).result()).resolves.toMatchObject({
      status: 'completed',
      finalAnswer: 'Continued without the image'
    });
    expect(
      degradedRequests[0]?.messages.find(
        (message) => message.role === 'user' && message.content === 'What is in the image?'
      )
    ).toEqual({
      role: 'user',
      content: 'What is in the image?',
      metadata: { source: 'user', recordId: expect.any(String) }
    });
    const warningRecord = (await readFile(eventsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type?: string; payload?: unknown })
      .findLast((record) => record.type === 'context.warning');
    expect(warningRecord?.payload).toEqual({
      code: 'MAR_AGENT_INPUT_IMAGE_IGNORED',
      message: 'One or more corrupt historical input images were ignored.',
      ignoredImages: 1
    });
    await thirdAgent.dispose();
  });
  it('rejects a text-only model instead of dropping restored user images', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-image-model-switch-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const imageBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const visionModel: MarAgentModelConfiguration = {
      ...model,
      id: 'vision-switch',
      inputCapabilities: ['TEXT', 'IMAGE']
    };
    const textModel: MarAgentModelConfiguration = {
      ...model,
      id: 'text-switch'
    };
    const modelCalls: string[] = [];
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [visionModel, textModel],
      defaultModelId: visionModel.id,
      adapterFactory: (configuration) => ({
        configuration,
        async *start() {
          modelCalls.push(configuration.id);
          yield { type: 'text.completed', itemId: configuration.id, text: 'seen' };
          yield { type: 'completed', reason: 'completed' };
        }
      })
    });
    const session = await agent.createSession({ workspace, title: 'Image model switch' });
    await expect(
      session
        .run({
          prompt: 'See this image.',
          images: [{ name: 'pixel.png', mimeType: 'image/png', dataBase64: imageBase64 }]
        })
        .result()
    ).resolves.toMatchObject({ status: 'completed' });

    await expect(
      session
        .run({
          prompt: 'Describe it with the text model.',
          modelId: textModel.id
        })
        .result()
    ).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'MAR_AGENT_INPUT_CAPABILITY_UNSUPPORTED'
    });
    expect(modelCalls).toEqual([visionModel.id]);
    await agent.dispose();
  });
  it('uses the caller-selected extension directory for web tools', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-web-tools-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    for (const hostedWebSearch of [false, true]) {
      const configuration: MarAgentModelConfiguration = {
        ...model,
        id: `web-${hostedWebSearch}`,
        protocol: 'OPENAI_RESPONSES',
        hostedWebSearch
      };
      const requests: ModelRequest[] = [];
      const adapter: ModelAdapter = {
        configuration,
        async *start(request) {
          requests.push(request);
          yield { type: 'text.completed', itemId: 'answer', text: 'ok' };
          yield { type: 'completed', reason: 'completed' };
        }
      };
      const fetchTool = {
        name: 'web_fetch',
        description: 'Fetch a web resource.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            mode: { type: 'string', enum: ['http', 'browser'] }
          },
          required: ['url', 'mode']
        }
      };
      const searchTool = {
        name: 'web_search',
        description: 'Search the web.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query']
        }
      };
      const extensionTools = hostedWebSearch ? [fetchTool] : [searchTool, fetchTool];
      const agent = await createMarAgent({
        mode: 'normal',
        host: new LocalAgentHost({
          homeDirectory: join(home, String(hostedWebSearch)),
          workspace,
          extensions: {
            tools: extensionTools,
            executeTool: async () => ({ content: '{}' })
          }
        }),
        models: [configuration],
        adapterFactory: () => adapter
      });
      const session = await agent.createSession({ workspace });
      await session.run({ prompt: 'test', access: 'full-access' }).result();
      const tools = requests
        .find((request) => !request.system.includes('session title generator'))!
        .tools.map((tool) => tool.name);
      expect(tools).toEqual(expect.arrayContaining(extensionTools.map((tool) => tool.name)));
      expect(tools.includes('web_search')).toBe(!hostedWebSearch);
      await agent.dispose();
    }
  });

  it.each([
    ['short', 'Implement MAR Agent title generation', 'Implement MAR Agent title generation'],
    ['boundary', 'b'.repeat(1000), 'b'.repeat(1000)],
    ['long', 'a'.repeat(1000) + 'follow-up critical task', 'a'.repeat(1000)],
    ['unicode', '中'.repeat(999) + '😀follow-up critical task', '中'.repeat(999) + '😀']
  ])('does not generate titles or truncate main input: %s', async (_name, prompt) => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-title-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    const adapter = new TitleAdapter();
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      systemInstruction: 'private project context',
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace });
    await expect(
      session.run({ prompt: prompt!, reasoningEffort: 'high' }).result()
    ).resolves.toMatchObject({ status: 'completed' });
    await expect(session.run({ prompt: 'second turn' }).result()).resolves.toMatchObject({
      status: 'completed'
    });
    expect(adapter.requests).toHaveLength(2);
    expect(adapter.requests[0]?.reasoningEffort).toBe('high');
    expect(adapter.requests[1]?.reasoningEffort).toBe('medium');
    expect(
      adapter.requests.every((request) => !request.system.includes('session title generator'))
    ).toBe(true);
    for (const request of adapter.requests)
      expect(request.messages).toContainEqual({
        role: 'user',
        content: prompt,
        metadata: { source: 'user', recordId: expect.any(String) }
      });
    const store = await JsonlSessionStore.open(home);
    expect(
      (await store.read(session.id)).find((record) => record.type === 'turn.user')?.payload
    ).toMatchObject({ prompt });
    await store.close();
    await expect(agent.getSession(session.id)).resolves.toMatchObject({
      title: 'New session',
      automaticTitlePending: false
    });
    await agent.dispose();
  });

  it('does not select a title model during a Core Execution', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-title-model-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    const adapters = new Map<string, TitleAdapter>();
    const titleModel = { ...model, id: 'title-model', name: 'Title model', titleGeneration: true };
    const currentModel = { ...model, id: 'current-model', name: 'Current model' };
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [titleModel, currentModel],
      defaultModelId: currentModel.id,
      adapterFactory: (configuration) => {
        const adapter = new TitleAdapter();
        adapters.set(configuration.id, adapter);
        return adapter;
      }
    });
    const session = await agent.createSession({ workspace });
    await session
      .run({
        prompt: 'Use a dedicated title model',
        modelId: currentModel.id
      })
      .result();
    expect(
      adapters
        .get(titleModel.id)
        ?.requests.some((request) => request.system.includes('session title generator'))
    ).toBeUndefined();
    expect(
      adapters
        .get(currentModel.id)
        ?.requests.some((request) => request.system.includes('session title generator'))
    ).toBe(false);
    await agent.dispose();
  });

  it('does not call title generation even when it would fail', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-title-failure-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    const adapter = new TitleAdapter(true);
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace });
    await expect(session.run({ prompt: 'hello' }).result()).resolves.toMatchObject({
      status: 'completed'
    });
    await expect(agent.listSessions()).resolves.toMatchObject({
      sessions: [{ title: 'New session' }]
    });
    await agent.dispose();
  });

  it('executes one model tool batch concurrently and preserves protocol order', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-parallel-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    await Promise.all([
      writeFile(join(workspace, 'a.txt'), 'a\n'),
      writeFile(join(workspace, 'b.txt'), 'b\n')
    ]);
    const adapter = new ParallelToolsAdapter();
    const host = new LocalAgentHost({ homeDirectory: home, workspace });
    const executeTool = host.executeTool.bind(host);
    let active = 0;
    let maximumActive = 0;
    host.executeTool = async (...arguments_) => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      try {
        return await executeTool(...arguments_);
      } finally {
        active--;
      }
    };
    const agent = await createMarAgent({
      mode: 'normal',
      host,
      models: [model],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace, title: 'History' });
    expect((await session.run({ prompt: 'read both' }).result()).status).toBe('completed');
    expect(maximumActive).toBe(2);
    expect(adapter.requests[1]?.messages.slice(-4).map((message) => message.role)).toEqual([
      'tool_call',
      'tool_call',
      'tool',
      'tool'
    ]);
    expect(adapter.requests[1]?.messages.slice(-4).map((message) => message.callId)).toEqual([
      'first',
      'second',
      'first',
      'second'
    ]);
    await agent.dispose();
  });

  it('executes independent exec calls concurrently and returns results in model order', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-parallel-exec-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    const adapter = new ParallelExecToolsAdapter();
    const host = new LocalAgentHost({ homeDirectory: home, workspace });
    const executeTool = host.executeTool.bind(host);
    let activeExec = 0;
    let maximumActiveExec = 0;
    host.executeTool = async (call, ...options) => {
      if (call.name !== 'exec') return executeTool(call, ...options);
      activeExec++;
      maximumActiveExec = Math.max(maximumActiveExec, activeExec);
      try {
        return await executeTool(call, ...options);
      } finally {
        activeExec--;
      }
    };
    const agent = await createMarAgent({
      mode: 'normal',
      host,
      models: [model],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace, title: 'Parallel exec' });

    await expect(session.run({ prompt: 'run both' }).result()).resolves.toMatchObject({
      status: 'completed'
    });
    expect(maximumActiveExec).toBe(2);
    const messages = adapter.requests[1]?.messages.slice(-4);
    expect(messages?.map((message) => message.role)).toEqual([
      'tool_call',
      'tool_call',
      'tool',
      'tool'
    ]);
    expect(messages?.map((message) => message.callId)).toEqual([
      'exec-first',
      'exec-second',
      'exec-first',
      'exec-second'
    ]);
    expect(messages?.[2]?.content).toContain('first');
    expect(messages?.[3]?.content).toContain('second');
    await agent.dispose();
  });

  it.each(['RUNNING', 'COMPLETED', 'FAILED'] as const)(
    'publishes hosted %s as standard tool events without client-tool context',
    async (status) => {
      const home = await mkdtemp(join(tmpdir(), 'mar-hosted-tool-home-'));
      homes.push(home);
      const workspace = join(home, 'workspace');
      await mkdir(workspace);
      const hosted: ModelEvent = {
        type: 'hosted_tool',
        itemId: 'native-web',
        kind: 'WEB_FETCH',
        toolName: 'web_search',
        input: { type: 'find_in_page', url: 'https://example.test', pattern: 'exact phrase' },
        output: { sources: [{ url: 'https://example.test', title: 'Actual source' }] },
        truncated: true,
        status,
        summary: {}
      };
      const agent = await createMarAgent({
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [model],
        adapterFactory: () => ({
          configuration: model,
          async *start(): AsyncIterable<ModelEvent> {
            yield hosted;
            yield { type: 'text.completed', itemId: 'answer', text: 'Done.' };
            yield { type: 'completed', reason: 'completed' };
          }
        })
      });
      try {
        const session = await agent.createSession({ workspace, title: 'Hosted tool' });
        const execution = session.run({ prompt: 'Find the phrase.' });
        const events = [];
        for await (const event of execution) events.push(event);
        await execution.result();
        const expectedStart = {
          type: 'tool.started',
          toolName: 'web_search',
          callId: 'native-web',
          input: hosted.input,
          truncated: true
        };
        expect(events.find((event) => event.type === 'tool.started')).toMatchObject(expectedStart);
        expect(events.some((event) => event.type === 'hosted_tool.updated')).toBe(false);
        const expectedTerminal =
          status === 'RUNNING'
            ? undefined
            : status === 'COMPLETED'
              ? {
                  type: 'tool.completed',
                  toolName: 'web_search',
                  callId: 'native-web',
                  summary: JSON.stringify(hosted.output),
                  truncated: true
                }
              : {
                  type: 'tool.failed',
                  toolName: 'web_search',
                  callId: 'native-web',
                  code: 'HOSTED_TOOL_FAILED',
                  message: JSON.stringify(hosted.output),
                  truncated: true
                };
        if (expectedTerminal)
          expect(events.find((event) => event.type === expectedTerminal.type)).toMatchObject(
            expectedTerminal
          );
        const persisted = (
          await readFile(
            join(home, '.mar', 'agent', 'sessions', session.id, 'events-000001.jsonl'),
            'utf8'
          )
        )
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        expect(persisted.find((event) => event.type === 'tool.started')?.payload).toMatchObject(
          expectedStart
        );
        if (expectedTerminal)
          expect(
            persisted.find((event) => event.type === expectedTerminal.type)?.payload
          ).toMatchObject(expectedTerminal);
        expect(persisted.some((event) => event.type === 'hosted_tool.updated')).toBe(false);
        expect(
          persisted.some(
            (event) =>
              event.type === 'model.context' && ['tool_call', 'tool'].includes(event.payload.role)
          )
        ).toBe(false);
      } finally {
        await agent.dispose();
      }
    }
  );

  it('runs a model/tool loop and persists events before completion', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-home-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    await writeFile(join(workspace, 'input.txt'), 'content\n');
    const adapter = new ScriptedAdapter();
    const host = new LocalAgentHost({ homeDirectory: home, workspace });
    const agent = await createMarAgent({
      mode: 'normal',
      host,
      models: [model],
      adapterFactory: () => ({
        configuration: model,
        async *start(): AsyncIterable<ModelEvent> {
          const observedAt = performance.now();
          for await (const event of adapter.start())
            yield observeModelStreamEvent(event, observedAt);
        }
      })
    });
    const session = await agent.createSession({ workspace, title: 'Runtime' });
    const handle = session.run({ prompt: 'read it' });
    const events = [];
    for await (const event of handle) events.push(event);
    expect((await handle.result()).finalAnswer).toBe('finished');
    expect(adapter.calls).toBe(2);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'tool.completed', toolName: 'read' }),
        expect.objectContaining({
          type: 'model.performance',
          latencyMs: expect.any(Number)
        }),
        expect.objectContaining({ type: 'usage.updated', outputTokens: 8 }),
        expect.objectContaining({ type: 'execution.completed' })
      ])
    );
    const persisted = await readFile(
      join(home, '.mar', 'agent', 'sessions', session.id, 'events-000001.jsonl'),
      'utf8'
    );
    expect(persisted).toContain('"type":"message.completed"');
    expect(persisted).not.toContain('"type":"message.performance"');
    expect(persisted).not.toContain('"type":"model.performance"');
    expect(persisted).toContain('"type":"usage.updated"');
    const measurements = events.filter((event) => event.type === 'model.performance');
    const firstToolStarted = events.find(
      (event) => event.type === 'tool.started' && event.toolName === 'read'
    );
    expect(measurements).toHaveLength(2);
    expect(measurements[0]).not.toHaveProperty('tokensPerSecond');
    expect(measurements[0]?.sequence).toBeLessThan(firstToolStarted?.sequence ?? Infinity);
    expect(measurements[1]).not.toHaveProperty('tokensPerSecond');
    expect(persisted).not.toContain('"type":"message.delta"');
    await agent.dispose();
  });

  it('refreshes transient latency for each model request without carrying usage into later rounds', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-model-performance-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    await writeFile(join(workspace, 'input.txt'), 'content');
    let calls = 0;
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const adapter: ModelAdapter = {
      configuration: model,
      async *start(): AsyncIterable<ModelEvent> {
        calls++;
        if (calls === 1) {
          for (const itemId of ['first', 'second']) {
            yield { type: 'text.delta', itemId, phase: 'commentary', delta: 'Checking.' };
            yield { type: 'text.completed', itemId, phase: 'commentary', text: 'Checking.' };
            now += 500;
          }
          yield { type: 'usage', usage: { outputTokens: 8 } };
          yield {
            type: 'client_tool.call',
            callId: 'read',
            name: 'read',
            arguments: { reads: [{ path: 'input.txt' }] }
          };
          yield { type: 'completed', reason: 'tool_use' };
        } else {
          yield { type: 'text.delta', itemId: 'final', phase: 'final_answer', delta: 'Done.' };
          now += 500;
          yield { type: 'text.completed', itemId: 'final', text: 'Done.' };
          yield { type: 'completed', reason: 'completed' };
        }
      }
    };
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      adapterFactory: () => adapter
    });
    try {
      const session = await agent.createSession({ workspace, title: 'Performance' });
      const handle = session.run({ prompt: 'read it' });
      const measurements = [];
      for await (const event of handle)
        if (event.type === 'model.performance') measurements.push(event);
      await handle.result();
      expect(measurements).toHaveLength(3);
      expect(measurements[0]).toMatchObject({ latencyMs: expect.any(Number) });
      expect(measurements[0]).not.toHaveProperty('outputTokens');
      expect(measurements[0]).not.toHaveProperty('tokensPerSecond');
      expect(measurements[1]).toMatchObject({
        outputTokens: 8,
        tokensPerSecond: expect.any(Number)
      });
      expect(measurements[2]).toMatchObject({ latencyMs: expect.any(Number) });
      expect(measurements[2]).not.toHaveProperty('outputTokens');
      expect(measurements[2]).not.toHaveProperty('tokensPerSecond');
      expect(measurements.every((event) => !('itemId' in event))).toBe(true);
      const persisted = await readFile(
        join(home, '.mar', 'agent', 'sessions', session.id, 'events-000001.jsonl'),
        'utf8'
      );
      expect(persisted).not.toContain('"type":"model.performance"');
      expect(persisted).not.toContain('"type":"message.performance"');
      expect(persisted).toContain('"type":"usage.updated"');
    } finally {
      clock.mockRestore();
      await agent.dispose();
    }
  });

  it('uses the first reasoning output as the model response latency boundary', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-model-reasoning-latency-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    let now = 0;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const adapter: ModelAdapter = {
      configuration: model,
      async *start(): AsyncIterable<ModelEvent> {
        now = 50;
        yield { type: 'usage', usage: { outputTokens: 12 } };
        now = 120;
        yield {
          type: 'reasoning.completed',
          representation: 'summary',
          itemId: 'reasoning',
          text: 'Checking.'
        };
        now = 200;
        yield { type: 'text.delta', itemId: 'answer', phase: 'final_answer', delta: 'Do' };
        now = 1_500;
        yield { type: 'text.delta', itemId: 'answer', phase: 'final_answer', delta: 'ne.' };
        yield { type: 'text.completed', itemId: 'answer', text: 'Done.' };
        yield { type: 'completed', reason: 'completed' };
      }
    };
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      adapterFactory: () => adapter
    });
    try {
      const session = await agent.createSession({ workspace, title: 'Reasoning latency' });
      const handle = session.run({ prompt: 'think first' });
      const events = [];
      for await (const event of handle) events.push(event);
      await handle.result();
      const reasoning = events.find((event) => event.type === 'reasoning.completed');
      const measurements = events.filter((event) => event.type === 'model.performance');
      expect(measurements).toHaveLength(2);
      expect(measurements[0]).toMatchObject({ latencyMs: 120 });
      expect(measurements[0]).not.toHaveProperty('outputDurationMs');
      expect(measurements[0]).not.toHaveProperty('tokensPerSecond');
      expect(measurements[0]?.sequence).toBe((reasoning?.sequence ?? 0) + 1);
      expect(measurements[1]).toMatchObject({
        latencyMs: 120,
        outputTokens: 12,
        outputDurationMs: 1_300,
        tokensPerSecond: 9.23
      });
    } finally {
      nowSpy.mockRestore();
      await agent.dispose();
    }
  });

  it('does not treat lifecycle, usage, unknown, or empty text events as a model response', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-model-performance-empty-response-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const adapter: ModelAdapter = {
      configuration: model,
      async *start(request): AsyncIterable<ModelEvent> {
        // This case checks performance projection, not transport retries.
        if (request.retryState)
          request.retryState.attempts = modelRetryMaxAttempts(request.retryState);
        yield { type: 'response.started', responseId: 'response' };
        yield { type: 'usage', usage: { outputTokens: 0 } };
        yield { type: 'unknown', nativeType: 'response.heartbeat' };
        yield { type: 'text.delta', itemId: 'answer', phase: 'final_answer', delta: '' };
        yield { type: 'text.completed', itemId: 'answer', text: '' };
        yield { type: 'completed', reason: 'completed' };
      }
    };
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      adapterFactory: () => adapter
    });
    try {
      const session = await agent.createSession({ workspace, title: 'Empty response' });
      const events = [];
      const handle = session.run({ prompt: 'wait' });
      for await (const event of handle) events.push(event);
      expect(await handle.result()).toMatchObject({ status: 'failed' });
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'execution.failed',
          code: 'MAR_AGENT_MODEL_OUTPUT_INCOMPLETE'
        })
      );
      expect(events.some((event) => event.type === 'model.performance')).toBe(false);
    } finally {
      await agent.dispose();
    }
  });

  it('emits latency immediately and publishes average output TPS only after completion', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-model-performance-average-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    let now = 0;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const adapter: ModelAdapter = {
      configuration: model,
      async *start(): AsyncIterable<ModelEvent> {
        now = 100;
        yield { type: 'text.delta', itemId: 'answer', phase: 'final_answer', delta: 'A' };
        now = 200;
        yield { type: 'usage', usage: { outputTokens: 10 } };
        now = 900;
        yield { type: 'text.delta', itemId: 'answer', phase: 'final_answer', delta: 'B' };
        now = 1_200;
        yield { type: 'usage', usage: { outputTokens: 20 } };
        now = 1_300;
        yield { type: 'text.delta', itemId: 'answer', phase: 'final_answer', delta: 'C' };
        now = 1_350;
        yield { type: 'text.completed', itemId: 'answer', text: 'ABC' };
        now = 1_400;
        yield { type: 'usage', usage: { outputTokens: 30 } };
        now = 1_450;
        yield { type: 'completed', reason: 'completed' };
      }
    };
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      adapterFactory: () => adapter
    });
    try {
      const session = await agent.createSession({ workspace, title: 'Live performance' });
      const handle = session.run({ prompt: 'stream it' });
      const events = [];
      for await (const event of handle) events.push(event);
      await handle.result();
      const deltas = events.filter((event) => event.type === 'message.delta');
      const measurements = events.filter((event) => event.type === 'model.performance');
      expect(measurements).toHaveLength(2);
      expect(measurements[0]).toMatchObject({
        latencyMs: 100
      });
      expect(measurements[0]).not.toHaveProperty('outputDurationMs');
      expect(measurements[0]).not.toHaveProperty('tokensPerSecond');
      expect(measurements[0]?.sequence).toBe((deltas[0]?.sequence ?? 0) + 1);
      expect(measurements[1]).toMatchObject({
        latencyMs: 100,
        outputTokens: 30,
        outputDurationMs: 1_350,
        tokensPerSecond: 22.22
      });
      expect(measurements[1]?.sequence).toBeGreaterThan(deltas[2]?.sequence ?? 0);
    } finally {
      nowSpy.mockRestore();
      await agent.dispose();
    }
  });

  it('clears an SDK session after releasing warm resources and restarts its context', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-clear-session-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const host = new LocalAgentHost({ homeDirectory: home, workspace });
    const disposeSessionResources = vi.spyOn(host, 'disposeSessionResources');
    const adapter = new HistoryAdapter();
    const agent = await createMarAgent({
      mode: 'normal',
      host,
      models: [model],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace, title: 'Kept title' });
    await await session.run({ prompt: 'history to clear' }).result();

    await agent.clearSession(session.id);

    expect(disposeSessionResources).toHaveBeenCalledWith(session.id);
    await expect(agent.listSessions()).resolves.toMatchObject({
      sessions: [expect.objectContaining({ id: session.id, title: 'Kept title', workspace })]
    });
    const store = await JsonlSessionStore.open(home);
    await expect(store.read(session.id)).resolves.toEqual([
      expect.objectContaining({
        sequence: 1,
        type: 'session.created',
        payload: expect.objectContaining({ title: 'Kept title', workspace })
      })
    ]);
    await store.close();

    await (await agent.openSession(session.id)).run({ prompt: 'new context' }).result();
    const request = adapter.requests.at(-1)!;
    expect(request.messages.map((message) => message.content).join('\n')).toContain('new context');
    expect(request.messages.map((message) => message.content).join('\n')).not.toContain(
      'history to clear'
    );
    await agent.dispose();
  });

  it('preserves provider commentary separately from the terminal answer', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-commentary-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    await writeFile(join(workspace, 'input.txt'), 'content\n');
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      adapterFactory: () => new CommentaryAdapter()
    });
    const handle = (await agent.createSession({ workspace })).run({
      prompt: 'inspect it'
    });
    const events = [];
    for await (const event of handle) events.push(event);

    await expect(handle.result()).resolves.toMatchObject({
      status: 'completed',
      finalAnswer: 'Done.'
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'message.completed',
          itemId: 'progress',
          phase: 'commentary',
          text: 'Checking.'
        }),
        expect.objectContaining({
          type: 'message.completed',
          itemId: 'answer',
          phase: 'final_answer',
          text: 'Done.'
        })
      ])
    );
    await agent.dispose();
  });

  it('lets a Local Host policy hook reject apply_patch', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-approval-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    const host = new LocalAgentHost({
      homeDirectory: home,
      workspace,
      beforeToolExecute: async () => {
        throw new MarAgentError('TEST_TOOL_POLICY_DENIED', 'Tool policy denied execution.');
      }
    });
    await expect(
      host.executeTool(
        { name: 'apply_patch', arguments: { patch: '*** Begin Patch\n*** End Patch' } },
        {
          mode: 'run',
          signal: new AbortController().signal,
          sessionId: 'direct-session',
          executionId: 'direct-execution'
        }
      )
    ).rejects.toMatchObject({ code: 'TEST_TOOL_POLICY_DENIED' });
    await host.dispose();
  });

  it('keeps normal tool availability and Host policy semantics in plan mode', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-plan-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    const host = new LocalAgentHost({ homeDirectory: home, workspace });
    await expect(
      host.executeTool(
        { name: 'exec', arguments: { command: 'rg --files', yieldMs: 5_000 } },
        {
          mode: 'plan',
          signal: new AbortController().signal,
          sessionId: 'direct-session',
          executionId: 'direct-execution'
        }
      )
    ).resolves.toMatchObject({ data: expect.objectContaining({ status: 'completed' }) });
    await expect(
      host.executeTool(
        { name: 'exec', arguments: { command: 'touch changed.txt' } },
        {
          mode: 'plan',
          signal: new AbortController().signal,
          sessionId: 'direct-session',
          executionId: 'direct-execution'
        }
      )
    ).resolves.toMatchObject({ data: expect.objectContaining({ status: 'completed' }) });
    await host.dispose();
  });

  it('executes Todo through run and question only through the Plan tool loop', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-workflow-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    const host = new LocalAgentHost({
      homeDirectory: home,
      workspace,
      question: async () => ({ choice: 'A' })
    });
    const adapter = new WorkflowAdapter();
    const agent = await createMarAgent({
      mode: 'normal',
      host,
      models: [model],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace, title: 'Continuation' });
    const handle = session.plan({ prompt: 'workflow' });
    const events = [];
    for await (const event of handle) events.push(event);
    expect(adapter.requests[0]?.tools.map((tool) => tool.name)).toContain('question');
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'todo.updated', revision: 1 }),
        expect.objectContaining({ type: 'user_input.requested' }),
        expect.objectContaining({ type: 'user_input.resolved' }),
        expect.objectContaining({
          type: 'message.completed',
          itemId: 'final',
          text: 'selected'
        })
      ])
    );
    expect(events.some((event) => event.type === 'plan.completed')).toBe(false);
    expect((await handle.result()).finalAnswer).toBe('selected');

    adapter.calls = 0;
    const planRequestCount = adapter.requests.length;
    const runHandle = session.run({ prompt: 'workflow again' });
    for await (const event of runHandle) void event;
    expect(adapter.requests[planRequestCount]?.tools.map((tool) => tool.name)).not.toContain(
      'question'
    );
    expect((await runHandle.result()).finalAnswer).toBe('selected');
    await agent.dispose();
  });

  it('keeps Session Todo across cancellation, failure, later Execution, and Agent reopen', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-session-todo-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    const firstAdapter = new SessionTodoAdapter(
      [{ id: 'inspect', step: 'Inspect implementation', status: 'in_progress' }],
      'cancel'
    );
    const firstAgent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      adapterFactory: () => firstAdapter
    });
    const session = await firstAgent.createSession({ workspace, title: 'Session Todo' });
    const firstHandle = session.run({ prompt: 'start work' });
    const firstEvents = [];
    for await (const event of firstHandle) {
      firstEvents.push(event);
      if (event.type === 'todo.updated') firstHandle.cancel();
    }
    expect(await firstHandle.result()).toMatchObject({ status: 'cancelled' });
    expect(firstEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'todo.updated',
          revision: 1,
          items: [expect.objectContaining({ id: 'inspect', status: 'in_progress' })]
        })
      ])
    );
    await firstAgent.dispose();

    const secondAdapter = new SessionTodoAdapter(
      [
        { id: 'inspect', step: 'Inspect implementation', status: 'completed' },
        { id: 'fix', step: 'Implement requested change', status: 'in_progress' }
      ],
      'fail'
    );
    const secondAgent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      adapterFactory: () => secondAdapter
    });
    const reopened = await secondAgent.openSession(session.id);
    const secondHandle = reopened.run({
      prompt: 'continue with one more change'
    });
    const secondEvents = [];
    for await (const event of secondHandle) secondEvents.push(event);

    expect(await secondHandle.result()).toMatchObject({
      status: 'failed',
      errorCode: 'MAR_AGENT_EXECUTION_FAILED'
    });
    expect(secondEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'todo.updated',
          revision: 2,
          items: [
            expect.objectContaining({ id: 'inspect', status: 'completed' }),
            expect.objectContaining({ id: 'fix', status: 'in_progress' })
          ]
        })
      ])
    );
    await secondAgent.dispose();

    const thirdAdapter = new SessionTodoAdapter([
      { id: 'inspect', step: 'Inspect implementation', status: 'completed' },
      { id: 'fix', step: 'Implement requested change', status: 'completed' },
      { id: 'verify', step: 'Verify requested change', status: 'in_progress' }
    ]);
    const thirdAgent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      adapterFactory: () => thirdAdapter
    });
    const resumed = await thirdAgent.openSession(session.id);
    const thirdHandle = resumed.run({
      prompt: 'continue after the failed execution'
    });
    const thirdEvents = [];
    for await (const event of thirdHandle) thirdEvents.push(event);

    expect(await thirdHandle.result()).toMatchObject({ status: 'completed' });
    expect(thirdEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'todo.updated',
          revision: 3,
          items: [
            expect.objectContaining({ id: 'inspect', status: 'completed' }),
            expect.objectContaining({ id: 'fix', status: 'completed' }),
            expect.objectContaining({ id: 'verify', status: 'in_progress' })
          ]
        })
      ])
    );
    await thirdAgent.dispose();

    const store = await JsonlSessionStore.open(home);
    const todoRecords = (await store.read(session.id)).filter(
      (record) => record.type === 'todo.updated'
    );
    expect(
      todoRecords.map((record) => (record.payload as { revision?: unknown }).revision)
    ).toEqual([1, 2, 3]);
    await store.close();
  });

  it('restores a completed Plan as assistant context after reopening the session', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-plan-resume-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    const firstAgent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({
        homeDirectory: home,
        workspace,
        question: async () => ({ choice: 'A' })
      }),
      models: [model],
      adapterFactory: () => new WorkflowAdapter()
    });
    const session = await firstAgent.createSession({ workspace, title: 'Plan recovery' });
    expect((await session.plan({ prompt: 'workflow' }).result()).finalAnswer).toBe('selected');
    await firstAgent.dispose();

    const resumedAdapter = new HistoryAdapter();
    const resumedAgent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      adapterFactory: () => resumedAdapter
    });
    await (await resumedAgent.openSession(session.id)).run({ prompt: 'continue' }).result();
    expect(resumedAdapter.requests[0]?.messages).toEqual(
      expect.arrayContaining([
        {
          role: 'user',
          content: 'workflow',
          metadata: { source: 'user', recordId: expect.any(String) }
        },
        { role: 'assistant', content: 'selected' },
        {
          role: 'user',
          content: 'continue',
          metadata: { source: 'user', recordId: expect.any(String) }
        }
      ])
    );
    await resumedAgent.dispose();
  });

  it('restores prior turns and persists a compact context boundary', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-resume-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    const adapter = new HistoryAdapter();
    const create = () =>
      createMarAgent({
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [model],
        adapterFactory: () => adapter
      });
    let agent = await create();
    const session = await agent.createSession({ workspace, title: 'Instructions' });
    expect(
      (await session.run({ prompt: 'first', clientMessageId: 'client-first' }).result()).status
    ).toBe('completed');
    const sessionId = session.id;
    await agent.dispose();
    agent = await create();
    const resumed = await agent.openSession(sessionId);
    expect((await resumed.run({ prompt: 'second' }).result()).status).toBe('completed');
    expect(baseMessages(adapter.requests[1]!)).toEqual([
      {
        role: 'user',
        contextKind: 'environment',
        content: expect.stringContaining(`<cwd>${workspace}</cwd>`)
      },
      {
        role: 'user',
        content: 'first',
        metadata: { source: 'user', recordId: expect.any(String) }
      },
      { role: 'assistant', content: 'answer-1' },
      {
        role: 'user',
        content: 'second',
        metadata: { source: 'user', recordId: expect.any(String) }
      }
    ]);
    expect(adapter.requests.slice(0, 2).map((request) => request.promptCacheKey)).toEqual([
      sessionId,
      sessionId
    ]);
    const compactHandle = resumed.compact();
    const compactEvents = [];
    for await (const event of compactHandle) compactEvents.push(event);
    const compactResult = await compactHandle.result();
    expect(compactResult, JSON.stringify(compactResult)).toMatchObject({
      status: 'completed',
      finalAnswer: ''
    });
    const compacting = compactEvents.find((event) => event.type === 'context.compacting');
    const compacted = compactEvents.find((event) => event.type === 'context.compacted');
    expect(compacting).toMatchObject({ compactionId: expect.any(String) });
    expect(compacted).toMatchObject({ compactionId: compacting?.compactionId });
    expect(compacted).not.toHaveProperty('summary');
    expect(
      compactEvents.some(
        (event) =>
          event.type === 'message.delta' ||
          event.type === 'message.completed' ||
          event.type === 'reasoning.completed'
      )
    ).toBe(false);
    expect(adapter.requests[2]?.system).toBe(adapter.requests[1]?.system);
    expect(adapter.requests[2]?.tools).toEqual(adapter.requests[1]?.tools);
    expect(adapter.requests[2]?.toolChoice).toBe('none');
    const persistedPrefix = baseMessages(adapter.requests[1]!).filter(
      (message) => message.contextKind !== 'contextual' && message.contextKind !== 'private'
    );
    expect(baseMessages(adapter.requests[2]!).slice(0, persistedPrefix.length)).toEqual(
      persistedPrefix
    );
    expect(
      adapter.requests[2]?.messages.some(
        (message) => message.contextualBlock?.authority === 'instruction'
      )
    ).toBe(false);
    expect(adapter.requests[2]?.messages.at(-2)).toEqual({
      role: 'assistant',
      content: 'answer-2'
    });
    expect(adapter.requests[2]?.messages.at(-1)?.content).toContain('Output only the handoff.');
    expect(adapter.requests[2]?.promptCacheKey).toBe(sessionId);
    const persisted = await import('../../src/agent-core/session/store/index.js').then(
      async ({ JsonlSessionStore }) => {
        const store = await JsonlSessionStore.open(home);
        const records = await store.read(sessionId);
        await store.close();
        return records;
      }
    );
    const compactRecords = persisted.filter(
      (record) => record.executionId === compactResult.executionId
    );
    expect(JSON.stringify(compactRecords)).not.toContain('Output only the handoff.');
    expect(compactRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'compact.completed',
          payload: expect.objectContaining({
            summary: 'answer-3',
            replacementHistory: [
              {
                role: 'user',
                content: 'first',
                kind: 'user_input',
                metadata: { source: 'user', recordId: expect.any(String) }
              },
              {
                role: 'user',
                content: 'second',
                kind: 'user_input',
                metadata: { source: 'user', recordId: expect.any(String) }
              },
              { role: 'user', content: expect.stringContaining('answer-3'), kind: 'summary' }
            ],
            boundarySequence: expect.any(Number),
            automatic: false,
            modelId: model.id
          })
        })
      ])
    );
    expect(compactRecords.some((record) => record.type === 'context.compacting')).toBe(true);
    expect(compactRecords).toContainEqual(
      expect.objectContaining({
        type: 'context.compacted',
        payload: expect.objectContaining({ compactionId: compacting?.compactionId })
      })
    );
    expect(compactRecords.some((record) => record.type === 'message.completed')).toBe(false);
    expect(
      persisted.filter((record) => record.type === 'turn.user').map((record) => record.payload)
    ).toEqual([{ prompt: 'first', clientMessageId: 'client-first' }, { prompt: 'second' }]);
    await agent.dispose();
    agent = await create();
    await (await agent.openSession(sessionId)).run({ prompt: 'after compact' }).result();
    const restoredSummary = adapter.requests[3]?.messages.find(
      (message) => message.contextKind === 'summary'
    );
    expect(restoredSummary).toMatchObject({
      role: 'user',
      content: expect.stringContaining('answer-3')
    });
    expect(restoredSummary?.content).toContain('Continue directly');
    expect(
      adapter.requests[3]?.messages
        .filter((message) => message.metadata?.source === 'user')
        .slice(0, 2)
    ).toEqual([
      {
        role: 'user',
        content: 'first',
        metadata: { source: 'user', recordId: expect.any(String) }
      },
      {
        role: 'user',
        content: 'second',
        metadata: { source: 'user', recordId: expect.any(String) }
      }
    ]);
    const reopened = await agent.openSession(sessionId);
    await reopened.compact({ prompt: 'Keep task facts, not this control instruction.' }).result();
    await reopened.run({ prompt: 'continue again' }).result();
    const lastRequest = adapter.requests.at(-1)!;
    expect(
      lastRequest.messages.filter((message) => message.metadata?.source === 'user').slice(0, 3)
    ).toEqual([
      {
        role: 'user',
        content: 'first',
        metadata: { source: 'user', recordId: expect.any(String) }
      },
      {
        role: 'user',
        content: 'second',
        metadata: { source: 'user', recordId: expect.any(String) }
      },
      {
        role: 'user',
        content: 'after compact',
        metadata: { source: 'user', recordId: expect.any(String) }
      }
    ]);
    expect(lastRequest.messages.map((message) => message.content).join('\n')).not.toContain(
      'Keep task facts'
    );
    expect(
      lastRequest.messages.filter((message) => message.content.includes('Continue directly'))
    ).toHaveLength(1);
    await agent.dispose();
  });

  it.each([undefined, '', '   '])(
    'ignores malformed Compact records and falls back from an empty replacement summary (%j)',
    async (replacementSummary) => {
      const home = await mkdtemp(join(tmpdir(), 'mar-runtime-invalid-compact-'));
      homes.push(home);
      const workspace = join(home, 'workspace');
      await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
      const store = await JsonlSessionStore.open(home);
      const session = await store.createSession({ title: 'Compact validation', workspace });
      await store.compact(session.id, {
        summary: 'valid handoff',
        ...(replacementSummary === undefined
          ? {}
          : {
              replacementHistory: [
                { role: 'user' as const, content: replacementSummary, kind: 'summary' as const }
              ]
            })
      });
      await store.append(session.id, {
        type: 'compact.completed',
        payload: { summary: '   ' }
      });
      await store.close();

      const adapter = new HistoryAdapter();
      const agent = await createMarAgent({
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [model],
        adapterFactory: () => adapter
      });
      await (await agent.openSession(session.id)).run({ prompt: 'continue' }).result();

      expect(baseMessages(adapter.requests[0]!)).toEqual([
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining(
            'The previously provided AGENTS.md instructions no longer apply.'
          )
        }),
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining('valid handoff')
        }),
        {
          role: 'user',
          contextKind: 'environment',
          content: expect.stringContaining(`<cwd>${workspace}</cwd>`)
        },
        {
          role: 'user',
          content: 'continue',
          metadata: { source: 'user', recordId: expect.any(String) }
        }
      ]);
      await agent.dispose();
    }
  );

  it('persists provider context as local authority across Agent recreation', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-provider-context-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    const adapter = new ResponsesHistoryAdapter();
    const create = () =>
      createMarAgent({
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [adapter.configuration],
        adapterFactory: () => adapter
      });
    let agent = await create();
    const session = await agent.createSession({ workspace, title: 'Subagent' });
    await session.run({ prompt: 'first' }).result();
    await session.run({ prompt: 'second' }).result();
    const sessionId = session.id;
    await agent.dispose();
    agent = await create();
    await (await agent.openSession(sessionId)).run({ prompt: 'third' }).result();
    expect(adapter.requests[2]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'provider',
          provider: 'OPENAI_RESPONSES',
          providerModelId: 'coding',
          item: expect.objectContaining({ encrypted_content: 'opaque-1' })
        }),
        expect.objectContaining({
          role: 'provider',
          provider: 'OPENAI_RESPONSES',
          item: expect.objectContaining({ encrypted_content: 'opaque-2' })
        })
      ])
    );
    await agent.dispose();
  });

  it('continues from completed commentary after an early Responses EOF without duplicating it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-commentary-eof-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    const adapter = new CompletedCommentaryEarlyEofAdapter();
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [adapter.configuration],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace, title: 'Commentary recovery' });
    const handle = session.run({ prompt: 'write the document' });
    const events = [];
    for await (const event of handle) events.push(event);

    await expect(handle.result()).resolves.toMatchObject({
      status: 'completed',
      finalAnswer: 'Document completed in bounded sections.'
    });
    expect(adapter.requests).toHaveLength(2);
    expect(adapter.requests[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'provider',
          provider: 'OPENAI_RESPONSES',
          item: expect.objectContaining({
            type: 'message',
            id: 'commentary',
            status: 'completed'
          })
        }),
        { role: 'assistant', content: 'Preparing the document structure.' }
      ])
    );
    expect(adapter.requests[1]?.messages.some((message) => message.role === 'tool_call')).toBe(
      false
    );
    expect(
      events.filter(
        (event) =>
          event.type === 'message.completed' &&
          event.phase === 'commentary' &&
          event.text === 'Preparing the document structure.'
      )
    ).toHaveLength(1);
    expect(events.some((event) => event.type === 'execution.failed')).toBe(false);
    await agent.dispose();
  });

  it('limits completed-output early EOF recovery to eight total attempts', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-commentary-eof-limit-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    const adapter = new CompletedCommentaryEarlyEofAdapter(8);
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [adapter.configuration],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace, title: 'Commentary recovery limit' });

    await expect(session.run({ prompt: 'write the document' }).result()).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'MAR_AGENT_MODEL_PROTOCOL_ERROR'
    });
    expect(adapter.requests).toHaveLength(8);
    await agent.dispose();
  });

  it('executes a complete tool call and automatically recovers when a Responses stream ends early', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-tool-eof-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    const adapter = new ToolCallEarlyEofAdapter();
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [adapter.configuration],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace, title: 'Tool EOF boundary' });
    const handle = session.run({ prompt: 'apply the patch' });
    const events = [];
    for await (const event of handle) events.push(event);

    await expect(handle.result()).resolves.toMatchObject({
      status: 'completed',
      finalAnswer: 'Recovered after the interrupted tool round.'
    });
    expect(adapter.requests).toHaveLength(2);
    expect(adapter.requests[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'tool_call', callId: 'patch-interrupted' }),
        expect.objectContaining({ role: 'tool', callId: 'patch-interrupted' })
      ])
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'tool.started', callId: 'patch-interrupted' }),
        expect.objectContaining({ type: 'tool.completed', callId: 'patch-interrupted' })
      ])
    );
    await expect(readFile(join(workspace, 'should-not-exist.txt'), 'utf8')).resolves.toBe(
      'unexpected\n'
    );
    await agent.dispose();
  });

  it('discovers skills by description and loads the selected body only through the skill tool', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-instructions-'));
    homes.push(home);
    const project = join(home, 'project');
    const workspace = join(project, 'packages', 'app');
    const nestedWorkspace = join(workspace, 'src');
    const userAgents = join(home, '.agents');
    const skill = join(project, '.agents', 'skills', 'deploy');
    const { mkdir } = await import('node:fs/promises');
    await Promise.all([
      mkdir(userAgents, { recursive: true }),
      mkdir(join(project, '.git'), { recursive: true }),
      mkdir(join(project, '.agents'), { recursive: true }),
      mkdir(workspace, { recursive: true }),
      mkdir(nestedWorkspace, { recursive: true }),
      mkdir(skill, { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(userAgents, 'AGENTS.md'), 'USER_RULE_SHOULD_NOT_LOAD'),
      writeFile(join(userAgents, 'AGENTS.override.md'), 'USER_RULE'),
      writeFile(join(project, '.agents', 'AGENTS.md'), 'DOT_RULE_SHOULD_NOT_LOAD'),
      writeFile(join(project, '.agents', 'AGENTS.override.md'), 'DOT_RULE'),
      writeFile(join(project, 'AGENTS.md'), 'ROOT_RULE'),
      writeFile(join(project, 'packages', 'AGENTS.md'), 'PACKAGE_RULE_SHOULD_NOT_LOAD'),
      writeFile(join(project, 'packages', 'AGENTS.override.md'), 'PACKAGE_OVERRIDE'),
      writeFile(join(workspace, 'AGENTS.md'), 'APP_RULE'),
      writeFile(join(nestedWorkspace, 'AGENTS.md'), 'NESTED_RULE_NOT_AUTOLOADED'),
      writeFile(
        join(skill, 'SKILL.md'),
        '---\ndescription: Deploy safely\n---\nSKILL_BODY\n[checklist](references/checklist.md)'
      ),
      mkdir(join(skill, 'references'), { recursive: true }).then(() =>
        writeFile(join(skill, 'references', 'checklist.md'), 'RESOURCE_BODY')
      )
    ]);
    await Promise.all(
      Array.from({ length: 11 }, (_, index) =>
        writeFile(join(skill, 'references', `resource-${String(index).padStart(2, '0')}.md`), 'x')
      )
    );
    const outsideResource = join(home, 'outside-resource.md');
    await writeFile(outsideResource, 'OUTSIDE_RESOURCE');
    await import('node:fs/promises').then(({ symlink }) =>
      symlink(outsideResource, join(skill, 'references', 'outside-link.md'))
    );
    const adapter = new SkillSelectingAdapter();
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace, title: 'Instructions' });
    await session.run({ prompt: 'Release the application safely.' }).result();
    const system = effectiveInstructions(adapter.requests[0]!);
    const instructions = adapter.requests[0]!.messages[0]!.content;
    expect(instructions.indexOf('USER_RULE')).toBeLessThan(instructions.indexOf('ROOT_RULE'));
    expect(instructions.indexOf('ROOT_RULE')).toBeLessThan(
      instructions.indexOf('PACKAGE_OVERRIDE')
    );
    expect(instructions.indexOf('PACKAGE_OVERRIDE')).toBeLessThan(instructions.indexOf('APP_RULE'));
    expect(instructions).not.toContain('USER_RULE_SHOULD_NOT_LOAD');
    expect(instructions).not.toContain('DOT_RULE');
    expect(instructions).not.toContain('DOT_RULE_SHOULD_NOT_LOAD');
    expect(instructions).not.toContain('PACKAGE_RULE_SHOULD_NOT_LOAD');
    expect(instructions).not.toContain('NESTED_RULE_NOT_AUTOLOADED');
    expect(system).not.toContain('APP_RULE');
    expect(system).toContain('from the project root through the current Workspace');
    expect(system).toContain('Do not independently search for or reread AGENTS.md files');
    expect(system).toContain('explicit user or injected instructions');
    expect(system).not.toContain('check for applicable AGENTS.md');
    expect(system).toContain('deploy: Deploy safely');
    expect(system).toContain('source:');
    expect(system).not.toContain('SKILL_BODY');
    expect(adapter.requests[0]!.tools.map((tool) => tool.name)).toContain('skill');
    const selected = adapter.requests[1]!.messages.find(
      (message) => message.role === 'tool' && message.callId === 'skill-call'
    )?.content;
    expect(selected).toContain('SKILL_BODY');
    expect(selected).not.toContain('RESOURCE_BODY');
    expect(selected).toContain('<mar_skill ');
    expect(selected).toContain(join(skill, 'references', 'checklist.md'));
    expect(selected?.match(/<file path=/gu)).toHaveLength(10);
    expect(selected).not.toContain('outside-link.md');
    expect(selected).not.toContain('resource-09.md');
    await agent.dispose();
  });

  it('loads hosted instructions from a physical mirror without exposing that path', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-hosted-instructions-'));
    homes.push(home);
    const physicalWorkspace = join(home, 'private-template-content');
    const skill = join(physicalWorkspace, '.agents', 'skills', 'deploy');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(skill, 'references'), { recursive: true });
    await Promise.all([
      writeFile(join(physicalWorkspace, 'AGENTS.md'), 'HOSTED_WORKSPACE_RULE'),
      writeFile(
        join(skill, 'SKILL.md'),
        '---\ndescription: Deploy hosted output\n---\nHOSTED_SKILL_BODY'
      ),
      writeFile(join(skill, 'references', 'checklist.md'), 'HOSTED_RESOURCE')
    ]);
    const adapter = new SkillSelectingAdapter();
    const agent = await createMarAgent({
      mode: 'node',
      host: new LocalAgentHost({
        homeDirectory: home,
        workspace: physicalWorkspace,
        mode: 'node',
        restrictPaths: true,
        workspaceWritable: false,
        pathMounts: [
          {
            logicalPath: '/workspace',
            physicalPath: physicalWorkspace,
            writable: false
          }
        ]
      }),
      models: [model],
      workspaceMapping: {
        physicalPath: physicalWorkspace,
        logicalPath: '/workspace'
      },
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({
      workspace: '/workspace',
      title: 'Hosted instructions'
    });

    await session.run({ prompt: 'Deploy safely.' }).result();

    const system = effectiveInstructions(adapter.requests[0]!);
    const instructions = adapter.requests[0]!.messages[0]!.content;
    const environment = adapter.requests[0]!.messages[1]!.content;
    expect(environment).toContain('<cwd>/workspace</cwd>');
    expect(environment).not.toContain(physicalWorkspace);
    expect(system).not.toContain('HOSTED_WORKSPACE_RULE');
    expect(instructions).toContain('HOSTED_WORKSPACE_RULE');
    expect(system).toContain('source: /workspace/.agents/skills/deploy');
    expect(system).not.toContain(physicalWorkspace);
    expect(instructions).not.toContain(physicalWorkspace);
    const selected = adapter.requests[1]!.messages.find(
      (message) => message.role === 'tool' && message.callId === 'skill-call'
    )?.content;
    expect(selected).toContain('baseDirectory="/workspace/.agents/skills/deploy"');
    expect(selected).toContain(
      '<file path="/workspace/.agents/skills/deploy/references/checklist.md" />'
    );
    expect(selected).not.toContain(physicalWorkspace);
    await agent.dispose();
  });

  it('projects hosted managed process cwd without exposing physical mount paths', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-hosted-resources-'));
    homes.push(home);
    const physicalWorkspace = join(home, 'private-template-content');
    const physicalOutput = join(home, 'private-conversation-output');
    const { mkdir } = await import('node:fs/promises');
    await Promise.all([mkdir(physicalWorkspace), mkdir(physicalOutput)]);
    const adapter = new HostedExecResourceAdapter();
    const agent = await createMarAgent({
      mode: 'node',
      host: new LocalAgentHost({
        homeDirectory: home,
        workspace: physicalWorkspace,
        mode: 'node',
        restrictPaths: true,
        workspaceWritable: false,
        pathMounts: [
          {
            logicalPath: '/workspace',
            physicalPath: physicalWorkspace,
            writable: false
          },
          {
            logicalPath: '/workspace/output',
            physicalPath: physicalOutput,
            writable: true
          }
        ]
      }),
      models: [model],
      workspaceMapping: {
        physicalPath: physicalWorkspace,
        logicalPath: '/workspace'
      },
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({
      workspace: '/workspace',
      title: 'Hosted resources'
    });

    await session.run({ prompt: 'Start the process.' }).result();
    await session.run({ prompt: 'Resume the process.' }).result();
    expect(JSON.stringify(adapter.requests[2]!.messages)).not.toContain(
      '# Retained Session resources'
    );
    expect((await session.compact().result()).status).toBe('completed');
    await session.run({ prompt: 'Resume after Compact.' }).result();

    const resumedRequest = adapter.requests.at(-1)!;
    const resumedContext = resumedRequest.messages.map((message) => message.content).join('\n');
    expect(resumedRequest.system).not.toContain('# Retained Session resources');
    expect(resumedContext).toContain('# Retained Session resources');
    expect(JSON.stringify(resumedRequest.messages)).toContain('/workspace/output');
    expect(resumedContext).not.toContain(physicalWorkspace);
    expect(resumedContext).not.toContain(physicalOutput);
    await agent.dispose();
  });

  it('runs a non-recursive explore subagent', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-subagent-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) =>
      mkdir(join(workspace, 'src'), { recursive: true })
    );
    await writeFile(join(workspace, 'input.txt'), 'subagent content\n');
    await writeFile(join(workspace, 'input-second.txt'), 'more content\n');
    await writeFile(join(workspace, 'move.txt'), 'move content\n');
    await writeFile(join(workspace, 'AGENTS.md'), 'SUBAGENT_SCOPED_RULE\n');
    await writeFile(join(workspace, 'src', 'AGENTS.md'), 'SUBAGENT_NESTED_RULE_NOT_AUTOLOADED\n');
    const requests: ModelRequest[] = [];
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      adapterFactory: () => new SubagentAdapter(requests)
    });
    const session = await agent.createSession({ workspace, title: 'Subagent' });
    const handle = session.run({ prompt: 'delegate' });
    const events = [];
    for await (const event of handle) events.push(event);
    expect(await handle.result()).toMatchObject({
      status: 'completed',
      finalAnswer: 'parent done'
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'subagent.started', description: 'Inspect input' }),
        expect.objectContaining({ type: 'subagent.completed', status: 'completed' }),
        expect.objectContaining({
          type: 'tool.completed',
          toolName: 'agent_wait',
          data: expect.objectContaining({
            description: 'Inspect input',
            status: 'completed'
          })
        })
      ])
    );
    const childRequest = requests.find((request) =>
      effectiveInstructions(request).includes('non-recursive subagent')
    );
    const childInstructions = childRequest?.messages[0]?.content;
    const childEnvironment = childRequest?.messages[1];
    expect(childEnvironment).toMatchObject({
      role: 'user',
      content: expect.stringContaining(`<cwd>${workspace}</cwd>`)
    });
    expect(childEnvironment?.content).toContain('<shell>');
    expect(childEnvironment?.content).toContain('<architecture>');
    expect(childRequest?.system).not.toContain(workspace);
    expect(childRequest?.system).not.toContain('SUBAGENT_SCOPED_RULE');
    expect(childInstructions).toContain('SUBAGENT_SCOPED_RULE');
    expect(childInstructions).not.toContain('SUBAGENT_NESTED_RULE_NOT_AUTOLOADED');
    expect(childRequest?.system).toContain('from the project root through the current Workspace');
    expect(childRequest?.system).toContain(
      'Do not independently search for or reread AGENTS.md files'
    );
    expect(childRequest?.system).toContain('explicit user or injected instructions');
    expect(childRequest?.system).not.toContain('check for applicable AGENTS.md');
    expect(childInstructions).toContain('Project instructions');
    expect(childRequest?.tools.map((tool) => tool.name)).not.toContain('skill');
    const childContinuation = requests.filter((request) =>
      effectiveInstructions(request).includes('non-recursive subagent')
    )[1];
    expect(childContinuation?.messages.slice(-6).map((message) => message.role)).toEqual([
      'tool_call',
      'tool_call',
      'tool_call',
      'tool',
      'tool',
      'tool'
    ]);
    const parentContinuation = requests.filter(
      (request) => !effectiveInstructions(request).includes('non-recursive subagent')
    )[2];
    const taskResult = JSON.parse(
      parentContinuation?.messages.findLast((message) => message.role === 'tool')?.content ?? '{}'
    );
    expect(Buffer.byteLength(taskResult.summary)).toBeLessThanOrEqual(
      TOOL_EXECUTION_LIMITS.subagentSummaryMaxBytes
    );
    expect(taskResult.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'input.txt', startLine: 1, endLine: 1 }),
        expect.objectContaining({ path: 'input-second.txt', startLine: 1, endLine: 1 })
      ])
    );
    expect(taskResult.changedFiles).toEqual(['move.txt', 'moved.txt']);
    await agent.dispose();
    const catalog = await openMarAgentSessionCatalog({ homeDirectory: home });
    try {
      const history = await catalog.history(session.id);
      expect(history.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'event',
            event: expect.objectContaining({
              type: 'tool.completed',
              toolName: 'agent_wait',
              data: expect.objectContaining({
                description: 'Inspect input',
                status: 'completed'
              })
            })
          })
        ])
      );
    } finally {
      await catalog.close();
    }
  });

  it('fails a subagent that completes without a final-round summary', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-subagent-empty-final-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    await writeFile(join(workspace, 'input.txt'), 'subagent content\n');
    const adapter = new EmptyFinalSubagentAdapter();
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace, title: 'Subagent empty final' });
    const handle = session.run({ prompt: 'delegate' });
    const events = [];
    for await (const event of handle) events.push(event);

    await expect(handle.result()).resolves.toMatchObject({
      status: 'completed',
      finalAnswer: 'parent done'
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'subagent.completed',
          description: 'Inspect input',
          status: 'failed',
          errorCode: 'MAR_AGENT_SUBAGENT_FAILED',
          errorMessage: 'MAR_AGENT_SUBAGENT_FAILED: Subagent completed without a final summary.'
        })
      ])
    );
    const parentContinuation = adapter.requests.filter(
      (request) => !effectiveInstructions(request).includes('non-recursive subagent')
    )[2];
    expect(
      JSON.parse(
        parentContinuation?.messages.findLast((message) => message.role === 'tool')?.content ?? '{}'
      )
    ).toMatchObject({
      description: 'Inspect input',
      status: 'failed',
      errorCode: 'MAR_AGENT_SUBAGENT_FAILED',
      errorMessage: 'MAR_AGENT_SUBAGENT_FAILED: Subagent completed without a final summary.'
    });
    await agent.dispose();
  });

  it('allows repeated identical tool calls until the model completes', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-progress-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    await writeFile(join(workspace, 'input.txt'), 'unchanged\n');
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      adapterFactory: () => new NoProgressAdapter()
    });
    const handle = (await agent.createSession({ workspace, title: 'No progress' })).run({
      prompt: 'loop'
    });
    const events: import('../../src/index.js').MarAgentEvent[] = [];
    for await (const event of handle) events.push(event);
    const result = await handle.result();
    expect(result).toMatchObject({ status: 'completed', finalAnswer: 'repeated checks complete' });
    expect(events.filter((event) => event.type === 'tool.completed')).toHaveLength(3);
    expect(events.some((event) => event.type === 'execution.failed')).toBe(false);
    await agent.dispose();
  });

  it('persists every repeated batched tool result so the session can continue', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-progress-batch-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    await Promise.all([
      writeFile(join(workspace, 'first.txt'), 'first\n'),
      writeFile(join(workspace, 'second.txt'), 'second\n')
    ]);
    const looping = new BatchedNoProgressAdapter();
    const recovered = new HistoryAdapter();
    let adapter: ModelAdapter = looping;
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace, title: 'Batch no progress' });
    await expect(session.run({ prompt: 'loop' }).result()).resolves.toMatchObject({
      status: 'completed',
      finalAnswer: 'batched checks complete'
    });

    const store = await JsonlSessionStore.open(home);
    await store.append(session.id, {
      type: 'model.context',
      payload: {
        role: 'provider',
        content: '',
        provider: 'OPENAI_RESPONSES',
        providerModelId: model.id,
        item: {
          id: 'legacy-provider-call',
          type: 'function_call',
          call_id: 'legacy-orphan',
          name: 'read',
          arguments: '{}'
        }
      }
    });
    await store.append(session.id, {
      type: 'model.context',
      payload: {
        role: 'tool_call',
        callId: 'legacy-orphan',
        name: 'read',
        arguments: { reads: [{ path: 'missing.txt' }] },
        content: ''
      }
    });
    await store.close();

    adapter = recovered;
    await expect(session.run({ prompt: 'continue' }).result()).resolves.toMatchObject({
      status: 'completed',
      finalAnswer: 'answer-1'
    });
    const restored = recovered.requests[0]?.messages ?? [];
    const toolCallIds = restored
      .filter((message) => message.role === 'tool_call')
      .map((message) => message.callId);
    const toolResultIds = restored
      .filter((message) => message.role === 'tool')
      .map((message) => message.callId);
    expect(toolCallIds).toHaveLength(6);
    expect(toolResultIds).toEqual(toolCallIds);
    await agent.dispose();
  });

  it('returns safe tool errors to the model and allows a corrected call', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-tool-recovery-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    await writeFile(join(workspace, 'input.txt'), 'before\n');
    const adapter = new ToolRecoveryAdapter();
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace, title: 'Tool correction' });
    const handle = session.run({
      prompt: 'fix it'
    });
    const events = [];
    for await (const event of handle) events.push(event);
    expect(await handle.result()).toMatchObject({ status: 'completed', finalAnswer: 'recovered' });
    expect(adapter.requests[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          callId: 'patch-1',
          content: expect.stringContaining('MAR_AGENT_TOOL_INPUT_INVALID')
        })
      ])
    );
    expect(
      adapter.requests[1]?.messages.find(
        (message) => message.role === 'tool' && message.callId === 'patch-1'
      )?.content
    ).not.toContain('"retryable":true');
    expect(adapter.requests[2]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          callId: 'patch-2',
          content: expect.stringContaining('"operation":"modified"')
        })
      ])
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool.failed',
          toolName: 'apply_patch',
          code: 'MAR_AGENT_TOOL_INPUT_INVALID'
        }),
        expect.objectContaining({
          type: 'tool.completed',
          toolName: 'apply_patch',
          truncated: false,
          data: {
            files: [
              {
                path: 'input.txt',
                operation: 'modified',
                addedLines: 1,
                deletedLines: 1
              }
            ],
            totals: { files: 1, addedLines: 1, deletedLines: 1 }
          }
        })
      ])
    );
    expect(
      await import('node:fs/promises').then(({ readFile }) =>
        readFile(join(workspace, 'input.txt'), 'utf8')
      )
    ).toBe('after\n');
    await agent.dispose();
    const catalog = await openMarAgentSessionCatalog({ homeDirectory: home });
    const history = await catalog.history(session.id);
    expect(history.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'event',
          event: expect.objectContaining({
            type: 'tool.completed',
            toolName: 'apply_patch',
            data: expect.objectContaining({
              files: [expect.objectContaining({ path: 'input.txt', operation: 'modified' })]
            })
          })
        })
      ])
    );
    await catalog.close();
  });

  it('avoids duplicating exec streams while retaining the complete live event and context', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-exec-persistence-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    const adapter = new ExecPersistenceAdapter();
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace, title: 'Exec persistence' });
    const handle = session.run({ prompt: 'run it' });
    const events = [];
    for await (const event of handle) events.push(event);
    expect(await handle.result()).toMatchObject({ status: 'completed', finalAnswer: 'done' });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool.completed',
          toolName: 'exec',
          data: expect.objectContaining({ stdout: 'persisted-output', stderr: '' })
        })
      ])
    );
    expect(adapter.requests[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          callId: 'exec-1',
          content: expect.stringContaining('persisted-output')
        })
      ])
    );
    await agent.dispose();

    const store = await JsonlSessionStore.open(home);
    const records = await store.read(session.id);
    const completed = records.find(
      (record) => record.type === 'tool.completed' && record.payload.toolName === 'exec'
    );
    expect(completed?.payload).toMatchObject({
      type: 'tool.completed',
      toolName: 'exec',
      data: expect.objectContaining({
        status: 'completed',
        exitCode: 0,
        stdoutBytes: 16,
        stderrBytes: 0
      })
    });
    expect(completed?.payload.data).not.toHaveProperty('stdout');
    expect(completed?.payload.data).not.toHaveProperty('stderr');
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'model.context',
          payload: expect.objectContaining({
            role: 'tool',
            callId: 'exec-1',
            content: expect.stringContaining('persisted-output')
          })
        })
      ])
    );
    await store.close();
  });

  it('separates complete live exec data from truncated event and model previews', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-exec-preview-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    const adapter = new LargeExecPreviewAdapter();
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace, title: 'Exec preview' });
    const handle = session.run({ prompt: 'run it' });
    const events = [];
    for await (const event of handle) events.push(event);
    expect(await handle.result()).toMatchObject({ status: 'completed', finalAnswer: 'done' });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool.completed',
          toolName: 'exec',
          callId: 'large-exec-preview',
          summary: expect.stringMatching(/^.{2000}$/u),
          truncated: true,
          data: expect.objectContaining({
            stdout: 'out\n'.repeat(7_000),
            stderr: 'err\n'.repeat(7_000),
            truncated: false,
            stdoutDroppedBytes: 0,
            stderrDroppedBytes: 0
          })
        })
      ])
    );
    expect(adapter.requests[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          callId: 'large-exec-preview',
          content: expect.stringContaining('Warning: truncated output (original token count:')
        })
      ])
    );
    const modelContent = adapter.requests[1]?.messages.find(
      (message) => message.role === 'tool' && message.callId === 'large-exec-preview'
    )?.content;
    expect(modelContent).toContain('original token count: 14000');
    expect(modelContent).toContain('Total output lines: 14000');
    expect(modelContent).toContain('tokens of tool output omitted');
    expect(modelContent).not.toContain('out\n'.repeat(7_000));
    expect(modelContent).not.toContain('err\n'.repeat(7_000));
    await agent.dispose();
  });

  it('automatically compacts prior history from persisted provider usage', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-auto-compact-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    await writeFile(join(workspace, 'AGENTS.md'), 'CURRENT_COMPACT_RULE');
    const imageBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const smallModel = {
      ...model,
      protocol: 'OPENAI_RESPONSES' as const,
      hostedWebSearch: true,
      contextWindowTokens: 10_000,
      maxOutputTokens: 1_000,
      inputCapabilities: ['TEXT', 'IMAGE'] as const,
      reasoningEfforts: ['medium', 'high'],
      defaultReasoningEffort: 'medium'
    };
    const adapter = new PersistedUsageAdapter(smallModel, 100);
    const host = new LocalAgentHost({ homeDirectory: home, workspace });
    const agent = await createMarAgent({
      mode: 'normal',
      host,
      models: [smallModel],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace, title: 'Automatic compact' });
    expect(
      (
        await session
          .run({
            prompt: 'first',
            images: [{ name: 'historical.png', mimeType: 'image/png', dataBase64: imageBase64 }]
          })
          .result()
      ).status
    ).toBe('completed');
    adapter.reportedContextTokens = 9_200;
    const seededUsageStore = await JsonlSessionStore.open(home);
    await seededUsageStore.append(session.id, {
      type: 'usage.updated',
      payload: { type: 'usage.updated', inputTokens: 9_200, contextInputTokens: 9_200 }
    });
    await seededUsageStore.close();
    const handle = session.run({
      prompt: 'continue',
      reasoningEffort: 'high',
      images: [{ name: 'current.png', mimeType: 'image/png', dataBase64: imageBase64 }]
    });
    const events = [];
    for await (const event of handle) events.push(event);
    expect(await handle.result()).toMatchObject({
      status: 'completed',
      finalAnswer: 'continued from persisted usage'
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'context.compacting' }),
        expect.objectContaining({ type: 'context.compacted' })
      ])
    );
    const compacting = events.find((event) => event.type === 'context.compacting');
    const compacted = events.find((event) => event.type === 'context.compacted');
    expect(compacted).toMatchObject({ compactionId: compacting?.compactionId });
    expect(compacted).not.toHaveProperty('summary');
    expect(adapter.requests.some((request) => request.toolChoice === 'none')).toBe(true);
    const compactRequest = adapter.requests.find((request) => request.toolChoice === 'none');
    expect(compactRequest?.tools.map((tool) => tool.name)).toContain('read');
    expect(compactRequest?.system).not.toContain('Textual Continuation IR');
    expect(compactRequest?.messages.at(-1)?.content).toContain('# Compaction contract');
    expect(compactRequest?.toolChoice).toBe('none');
    expect(compactRequest?.reasoningEffort).toBe('high');
    expect(compactRequest?.images).toBeUndefined();
    expect(compactRequest?.messages.every((message) => message.images === undefined)).toBe(true);
    expect(compactRequest?.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ contextKind: 'environment' })])
    );
    expect(compactRequest?.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ content: 'first' })])
    );
    expect(
      compactRequest?.messages.filter((message) => message.content.includes('CURRENT_COMPACT_RULE'))
    ).toHaveLength(0);
    const normalRequests = adapter.requests.filter((request) => request.toolChoice !== 'none');
    expect(normalRequests).toHaveLength(2);
    const persistedPrefix = baseMessages(normalRequests[0]!).filter(
      (message) => message.contextKind !== 'contextual' && message.contextKind !== 'private'
    );
    expect(baseMessages(compactRequest!).slice(0, persistedPrefix.length)).toEqual(persistedPrefix);
    expect(
      normalRequests[1]!.messages.filter((message) =>
        message.content.includes('CURRENT_COMPACT_RULE')
      )
    ).toHaveLength(1);
    expect(
      normalRequests[1]?.messages.filter((message) => message.contextKind === 'environment')
    ).toEqual([
      expect.objectContaining({
        role: 'user',
        content: expect.stringContaining(`<cwd>${workspace}</cwd>`)
      })
    ]);
    expect(normalRequests[1]?.images).toMatchObject([
      { mimeType: 'image/png', dataBase64: imageBase64 }
    ]);
    expect(normalRequests[1]?.messages.every((message) => message.images === undefined)).toBe(true);
    await agent.dispose();
    const store = await JsonlSessionStore.open(home);
    expect(await store.read(session.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'compact.completed',
          payload: expect.objectContaining({
            boundarySequence: expect.any(Number),
            automatic: true,
            environment: expect.objectContaining({ workspace, platform: process.platform })
          })
        })
      ])
    );
    await store.close();
  });

  it('retries automatic native compaction with bounded text evidence on provider overflow', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-auto-compact-fallback-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const compactModel = {
      ...model,
      contextWindowTokens: 9_000,
      maxOutputTokens: 1_000
    };
    const adapter = new CompactOverflowFallbackAdapter(compactModel);
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [compactModel],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace });
    await session.run({ prompt: 'seed' }).result();
    expect(await session.run({ prompt: 'continue' }).result()).toMatchObject({
      status: 'completed',
      finalAnswer: 'continued after fallback'
    });
    const compactRequests = adapter.requests.filter((request) => request.toolChoice === 'none');
    expect(compactRequests).toHaveLength(2);
    expect(compactRequests[0]?.messages.length).toBeGreaterThan(2);
    expect(baseMessages(compactRequests[1]!)).toHaveLength(2);
    expect(compactRequests[1]?.messages[0]?.content).toContain('Compaction focus');
    await agent.dispose();
  });

  it('uses authoritative Provider usage for automatic native compaction when the local estimate overflows', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-auto-compact-provider-fit-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const compactModel = { ...model, contextWindowTokens: 20_000, maxOutputTokens: 1_000 };
    const adapter = new CalibratedNativeCompactAdapter(compactModel, true);
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [compactModel],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace });
    await session.run({ prompt: 'seed' }).result();
    expect(await session.run({ prompt: 'continue' }).result()).toMatchObject({
      status: 'completed',
      finalAnswer: 'continued after calibrated compact'
    });
    const compactRequest = adapter.requests.find((request) => request.toolChoice === 'none');
    expect(compactRequest?.messages.length).toBeGreaterThan(2);
    expect(JSON.stringify(compactRequest)).toContain('🌐tool-evidence');
    await agent.dispose();
  });

  it('keeps native compaction when only tool results were appended after Provider usage', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-auto-compact-tool-delta-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    await writeFile(join(workspace, 'small.txt'), 'small append-only tool evidence\n');
    const compactModel = { ...model, contextWindowTokens: 19_500, maxOutputTokens: 1_000 };
    const adapter = new AppendOnlyToolCompactAdapter(compactModel);
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [compactModel],
      rolloutBudget: {
        limitTokens: 100,
        conserveAtRemainingTokens: 70,
        finalizeAtRemainingTokens: 30
      },
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace, title: 'Append-only compact' });
    expect(await session.run({ prompt: 'read the small file' }).result()).toMatchObject({
      status: 'completed',
      finalAnswer: 'continued after append-only tool compact'
    });
    const compactRequest = adapter.requests.find((request) => request.toolChoice === 'none');
    expect(compactRequest).toBeDefined();
    expect(compactRequest!.messages.length).toBeGreaterThan(2);
    expect(JSON.stringify(compactRequest)).toContain('small append-only tool evidence');
    expect(JSON.stringify(compactRequest)).not.toContain('execution_guidance');
    const requestAfterCompact = adapter.requests.at(-1);
    expect(requestAfterCompact?.toolChoice).not.toBe('none');
    expect(JSON.stringify(requestAfterCompact)).not.toContain('execution_guidance');
    const store = await JsonlSessionStore.open(home);
    expect(JSON.stringify(await store.read(session.id))).not.toContain('execution_guidance');
    await store.close();
    await agent.dispose();
  });

  it('returns malformed model tool arguments to the model instead of terminating execution', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-malformed-tool-recovery-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    const adapter = new MalformedToolRecoveryAdapter();
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace, title: 'Malformed tool correction' });
    const handle = session.run({ prompt: 'inspect it' });
    const events = [];
    for await (const event of handle) events.push(event);

    expect(await handle.result()).toMatchObject({ status: 'completed', finalAnswer: 'corrected' });
    expect(adapter.requests[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'tool_call', callId: 'malformed-1', arguments: {} }),
        expect.objectContaining({
          role: 'tool',
          callId: 'malformed-1',
          content: expect.stringContaining('MAR_AGENT_TOOL_INPUT_INVALID')
        })
      ])
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool.failed',
          toolName: 'read',
          callId: 'malformed-1',
          code: 'MAR_AGENT_TOOL_INPUT_INVALID'
        })
      ])
    );
    expect(events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'execution.failed',
          code: 'MAR_AGENT_MODEL_PROTOCOL_ERROR'
        })
      ])
    );
    await agent.dispose();
  });

  it('compacts fresh high usage at each turn end without restoring stale pre-compact usage', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-post-compact-usage-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    const compactModel = { ...model, contextWindowTokens: 9_000, maxOutputTokens: 1_000 };
    const adapter = new PostCompactUsageAdapter(compactModel);
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [compactModel],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace, title: 'Post compact usage' });
    await session.run({ prompt: 'first' }).result();
    await session.run({ prompt: 'second' }).result();
    const compactCountAfterSecond = adapter.requests.filter(
      (request) => request.toolChoice === 'none'
    ).length;
    expect(compactCountAfterSecond).toBe(2);
    await session.run({ prompt: 'third' }).result();
    expect(adapter.requests.filter((request) => request.toolChoice === 'none')).toHaveLength(3);
    await agent.dispose();
  });

  it('treats max output as a separate provider limit instead of consuming the input window', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-output-limit-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    const largeOutputModel = { ...model, contextWindowTokens: 20_000, maxOutputTokens: 18_000 };
    const adapter = new CompactAdapter(largeOutputModel);
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [largeOutputModel],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace, title: 'Separate output limit' });
    expect((await session.run({ prompt: 'answer briefly' }).result()).status).toBe('completed');
    expect(adapter.requests.some((request) => request.toolChoice === 'none')).toBe(false);
    await agent.dispose();
  });

  it('bounds a large tool result and compacts before the next model round', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-mid-compact-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    await writeFile(join(workspace, 'AGENTS.md'), 'MID_COMPACT_RULE');
    await writeFile(join(workspace, 'large.txt'), `${'x'.repeat(500)}\n`.repeat(200));
    const constrainedModel = { ...model, contextWindowTokens: 12_000, maxOutputTokens: 1_000 };
    const adapter = new MidExecutionCompactAdapter(constrainedModel);
    const agent = await createMarAgent({
      mode: 'normal',
      host: new StaticResourceHost({ homeDirectory: home, workspace }),
      models: [constrainedModel],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace, title: 'Mid execution compact' });
    const handle = session.run({ prompt: 'inspect the large file only as far as useful' });
    const events = [];
    for await (const event of handle) events.push(event);
    expect(await handle.result()).toMatchObject({
      status: 'completed',
      finalAnswer: 'continued after compact'
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'tool.completed', truncated: true }),
        expect.objectContaining({ type: 'context.compacted' })
      ])
    );
    expect(events.find((event) => event.type === 'context.compacted')).not.toHaveProperty(
      'summary'
    );
    const continuedRequest = adapter.requests.at(-1)!;
    expect(baseMessages(continuedRequest)).toHaveLength(5);
    expect(continuedRequest.messages[0]?.content).toContain(
      'replace all previously provided AGENTS.md instructions'
    );
    expect(continuedRequest.messages[0]?.content).toContain('MID_COMPACT_RULE');
    expect(continuedRequest.messages[1]?.content).toContain('processId: retained-process');
    expect(continuedRequest.messages[2]?.content).toContain(`<cwd>${workspace}</cwd>`);
    expect(continuedRequest.messages[3]?.content).toBe(
      'inspect the large file only as far as useful'
    );
    expect(continuedRequest.messages[4]?.content).toContain('bounded exploration summary');
    const compactRequest = adapter.requests.find((request) => request.toolChoice === 'none')!;
    expect(JSON.stringify(compactRequest.messages)).not.toContain('<mar_environment>');
    expect(JSON.stringify(compactRequest.messages)).not.toContain('retained-process');
    expect(
      countModelTokens(compactRequest.system) +
        compactRequest.messages.reduce((sum, message) => sum + countModelTokens(message.content), 0)
    ).toBeLessThan(12_000);
    const store = await JsonlSessionStore.open(home);
    expect(JSON.stringify(await store.read(session.id))).not.toContain('retained-process');
    await store.close();
    await agent.dispose();
  });

  it('does not use an inflated local estimate when provider usage is below the threshold', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-usage-calibrated-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    await writeFile(join(workspace, 'calibrated.txt'), 'one two three four '.repeat(2_500));
    const calibratedModel = { ...model, contextWindowTokens: 30_000, maxOutputTokens: 1_000 };
    const adapter = new ProviderUsageAdapter(calibratedModel);
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [calibratedModel],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace, title: 'Usage calibrated' });
    const result = await session.run({ prompt: 'alpha beta gamma delta '.repeat(6_000) }).result();
    expect(result).toMatchObject({
      status: 'completed',
      finalAnswer: 'continued from calibrated usage'
    });
    expect(adapter.requests.some((request) => request.toolChoice === 'none')).toBe(false);
    await agent.dispose();
  });

  it('compacts at ninety percent based on provider usage alone', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-usage-threshold-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    await writeFile(join(workspace, 'calibrated.txt'), 'one two three four '.repeat(2_500));
    const calibratedModel = { ...model, contextWindowTokens: 30_000, maxOutputTokens: 1_000 };
    const adapter = new ProviderUsageAdapter(calibratedModel, 27_000);
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [calibratedModel],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace, title: 'Usage threshold' });
    expect((await session.run({ prompt: 'inspect calibrated.txt' }).result()).status).toBe(
      'completed'
    );
    expect(adapter.requests.some((request) => request.toolChoice === 'none')).toBe(true);
    await agent.dispose();
  });

  it('treats an explicit zero provider usage as a fresh authoritative measurement', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-zero-usage-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    await writeFile(join(workspace, 'first.txt'), 'first');
    const zeroUsageModel = { ...model, contextWindowTokens: 30_000 };
    const adapter = new ResetUsageAdapter(zeroUsageModel);
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [zeroUsageModel],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace, title: 'Zero usage' });
    expect(await session.run({ prompt: 'read both files' }).result()).toMatchObject({
      status: 'completed',
      finalAnswer: 'continued after zero usage'
    });
    expect(adapter.requests.some((request) => request.toolChoice === 'none')).toBe(false);
    expect(adapter.requests.filter((request) => request.toolChoice !== 'none')).toHaveLength(2);
    await agent.dispose();
  });

  it('compacts and replays once when the provider rejects an oversized context', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-overflow-recovery-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    const adapter = new ContextOverflowAdapter(model);
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace, title: 'Overflow recovery' });
    await session.run({ prompt: 'seed history' }).result();
    const result = await session.run({ prompt: 'continue after overflow' }).result();
    expect(result).toMatchObject({
      status: 'completed',
      finalAnswer: 'continued after overflow compact'
    });
    expect(adapter.requests.filter((request) => request.toolChoice === 'none')).toHaveLength(1);
    await agent.dispose();
  });

  it('recovers when a compatible provider rejects an oversized message string', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-string-limit-recovery-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    const adapter = new ContextOverflowAdapter(model, false, 'string_above_max_length');
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace, title: 'String limit recovery' });
    await session.run({ prompt: 'seed history' }).result();
    await expect(
      session.run({ prompt: 'continue after string limit' }).result()
    ).resolves.toMatchObject({
      status: 'completed',
      finalAnswer: 'continued after overflow compact'
    });
    expect(adapter.requests.some((request) => request.toolChoice === 'none')).toBe(true);
    await agent.dispose();
  });

  it('recovers an HTTP 413 as context overflow even without a provider-specific code', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-http-413-recovery-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    const adapter = new ContextOverflowAdapter(
      model,
      false,
      'invalid_request_error',
      'Request rejected.',
      413
    );
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace, title: 'HTTP 413 recovery' });
    await session.run({ prompt: 'seed history' }).result();
    await expect(session.run({ prompt: 'continue' }).result()).resolves.toMatchObject({
      status: 'completed',
      finalAnswer: 'continued after overflow compact'
    });
    expect(adapter.requests.some((request) => request.toolChoice === 'none')).toBe(true);
    await agent.dispose();
  });

  it('recovers the K3-compatible 401 context-limit error shape', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-k3-context-recovery-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    const adapter = new ContextOverflowAdapter(
      model,
      false,
      '<nil>',
      'k3-256k supports only 256K context. (request id: test)',
      401
    );
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace, title: 'K3 context recovery' });
    await session.run({ prompt: 'seed history' }).result();
    await expect(session.run({ prompt: 'continue' }).result()).resolves.toMatchObject({
      status: 'completed',
      finalAnswer: 'continued after overflow compact'
    });
    expect(adapter.requests.some((request) => request.toolChoice === 'none')).toBe(true);
    await agent.dispose();
  });

  it('does not apply the K3 context-limit compatibility rule outside HTTP 401', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-k3-context-status-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    const adapter = new ContextOverflowAdapter(
      model,
      false,
      '<nil>',
      'k3-256k supports only 256K context. (request id: test)',
      403
    );
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace, title: 'K3 status boundary' });
    await session.run({ prompt: 'seed history' }).result();
    await expect(session.run({ prompt: 'continue' }).result()).resolves.toMatchObject({
      status: 'failed',
      errorCode: '<nil>'
    });
    expect(adapter.requests.some((request) => request.toolChoice === 'none')).toBe(false);
    await agent.dispose();
  });

  it('does not classify context wording on an unrelated provider error code', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-overflow-code-boundary-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    const adapter = new ContextOverflowAdapter(
      model,
      false,
      'authentication_error',
      'Access denied while validating the context window.',
      401
    );
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace, title: 'Overflow code boundary' });
    await session.run({ prompt: 'seed history' }).result();
    await expect(session.run({ prompt: 'continue' }).result()).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'authentication_error'
    });
    expect(adapter.requests.some((request) => request.toolChoice === 'none')).toBe(false);
    await agent.dispose();
  });

  it('does not misclassify rate limiting that mentions too many tokens as context overflow', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-overflow-exclusion-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    const adapter = new ContextOverflowAdapter(
      model,
      false,
      'invalid_request_error',
      'Rate limit: too many tokens requested per minute.'
    );
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace, title: 'Overflow exclusion' });
    await session.run({ prompt: 'seed history' }).result();
    await expect(session.run({ prompt: 'continue' }).result()).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'invalid_request_error'
    });
    expect(adapter.requests.some((request) => request.toolChoice === 'none')).toBe(false);
    await agent.dispose();
  });

  it('fails safely when the replay still exceeds the provider context window', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-overflow-terminal-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    const adapter = new ContextOverflowAdapter(model, true);
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace, title: 'Overflow terminal' });
    await session.run({ prompt: 'seed history' }).result();
    await expect(session.run({ prompt: 'still too large' }).result()).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'MAR_AGENT_CONTEXT_LIMIT'
    });
    expect(adapter.requests.filter((request) => request.toolChoice === 'none')).toHaveLength(1);
    await agent.dispose();
  });

  it('does not replay a context overflow after semantic output was emitted', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-overflow-after-output-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    const adapter = new PartialOutputOverflowAdapter();
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace, title: 'Partial overflow' });
    await expect(session.run({ prompt: 'do not replay me' }).result()).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'context_length_exceeded'
    });
    expect(adapter.requests).toHaveLength(1);
    await agent.dispose();
  });

  it('fails empty model completions after eight attempts instead of reporting false success', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-empty-completion-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    const adapter = new EmptyCompletedAdapter();
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace, title: 'Empty completion' });
    await expect(session.run({ prompt: 'answer me' }).result()).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'MAR_AGENT_MODEL_OUTPUT_INCOMPLETE'
    });
    expect(adapter.requests).toHaveLength(8);
    await agent.dispose();
  });

  it('continues one max-output response within the same execution', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-max-output-continuation-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    const adapter = new MaxOutputContinuationAdapter();
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace, title: 'Max output continuation' });

    await expect(session.run({ prompt: 'answer fully' }).result()).resolves.toMatchObject({
      status: 'completed',
      finalAnswer: 'completed after continuation'
    });
    expect(adapter.requests).toHaveLength(2);
    expect(adapter.requests[1]?.messages.at(-1)).toEqual({
      role: 'user',
      content:
        'Continue the previous response from exactly where it stopped. Do not repeat completed content.'
    });
    await agent.dispose();
  });

  it('fails after the one allowed max-output continuation', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-max-output-terminal-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    const adapter = new MaxOutputContinuationAdapter(2);
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace, title: 'Max output terminal' });

    await expect(session.run({ prompt: 'answer fully' }).result()).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'MAR_AGENT_MODEL_OUTPUT_INCOMPLETE'
    });
    expect(adapter.requests).toHaveLength(2);
    await agent.dispose();
  });

  it('does not persist max-output continuation through automatic compaction', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-max-output-compact-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    const compactModel = { ...model, contextWindowTokens: 30_000 };
    const adapter = new MaxOutputContinuationCompactionAdapter(compactModel);
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [compactModel],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace, title: 'Max output compact' });

    await expect(session.run({ prompt: 'answer fully' }).result()).resolves.toMatchObject({
      status: 'completed',
      finalAnswer: 'completed after compact'
    });
    expect(adapter.requests).toHaveLength(3);
    expect(adapter.requests.at(-1)?.messages.at(-1)).toEqual({
      role: 'user',
      content:
        'Continue the previous response from exactly where it stopped. Do not repeat completed content.'
    });
    const records = await import('../../src/agent-core/session/store/index.js').then(
      async ({ JsonlSessionStore }) => {
        const store = await JsonlSessionStore.open(home);
        const value = await store.read(session.id);
        await store.close();
        return value;
      }
    );
    expect(records.filter((record) => record.type === 'turn.user')).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain(
      'Continue the previous response from exactly where it stopped.'
    );
    expect(records.some((record) => record.type === 'compact.completed')).toBe(true);
    await agent.dispose();
  });

  it('does not execute an incomplete tool call from a max-output response', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-max-output-tool-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    const adapter = new IncompleteToolMaxOutputAdapter();
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace, title: 'Max output tool' });
    const handle = session.run({ prompt: 'read the file' });
    const events = [];
    for await (const event of handle) events.push(event);

    await expect(handle.result()).resolves.toMatchObject({
      status: 'completed',
      finalAnswer: 'completed after tool continuation'
    });
    expect(events.some((event) => event.type === 'tool.started')).toBe(false);
    expect(adapter.requests).toHaveLength(2);
    expect(adapter.requests[1]?.messages.some((message) => message.role === 'tool_call')).toBe(
      false
    );
    await agent.dispose();
  });

  it('resets max-output continuation after a complete tool round', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-max-output-tool-round-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    const adapter = new MaxOutputContinuationWithToolAdapter();
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace, title: 'Max output tool round' });

    await expect(session.run({ prompt: 'finish the task' }).result()).resolves.toMatchObject({
      status: 'completed',
      finalAnswer: 'completed after tool round'
    });
    expect(adapter.requests).toHaveLength(4);
    await agent.dispose();
  });

  it('continues a low-token Anthropic Messages response through the Runtime', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-anthropic-max-output-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    const requestBodies: Array<Record<string, unknown>> = [];
    const server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        requestBodies.push(JSON.parse(body) as Record<string, unknown>);
        const events =
          requestBodies.length === 1
            ? [
                { type: 'message_start', message: { id: 'anthropic-partial', usage: {} } },
                { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
                {
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'text_delta', text: 'partial response' }
                },
                { type: 'content_block_stop', index: 0 },
                {
                  type: 'message_delta',
                  delta: { stop_reason: 'max_tokens' },
                  usage: { output_tokens: 8 }
                },
                { type: 'message_stop' }
              ]
            : [
                { type: 'message_start', message: { id: 'anthropic-final', usage: {} } },
                { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
                {
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'text_delta', text: 'completed after continuation' }
                },
                { type: 'content_block_stop', index: 0 },
                {
                  type: 'message_delta',
                  delta: { stop_reason: 'end_turn' },
                  usage: { output_tokens: 4 }
                },
                { type: 'message_stop' }
              ];
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
      });
    });
    modelServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server unavailable');
    const lowOutputModel = {
      ...model,
      baseUrl: `http://127.0.0.1:${address.port}`,
      maxOutputTokens: 8
    };
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [lowOutputModel],
      adapterFactory: (configuration) => new AnthropicMessagesAdapter(configuration)
    });
    const session = await agent.createSession({ workspace, title: 'Anthropic max output' });

    await expect(session.run({ prompt: 'answer fully' }).result()).resolves.toMatchObject({
      status: 'completed',
      finalAnswer: 'completed after continuation'
    });
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies.every((body) => body.max_tokens === 8)).toBe(true);
    expect(JSON.stringify(requestBodies[1]?.messages)).toContain(
      'Continue the previous response from exactly where it stopped.'
    );
    await agent.dispose();
    const persisted = await readFile(
      join(home, '.mar', 'agent', 'sessions', session.id, 'events-000001.jsonl'),
      'utf8'
    );
    expect(persisted.match(/"type":"turn\.user"/gu)).toHaveLength(1);
    expect(persisted).not.toContain(
      'Continue the previous response from exactly where it stopped.'
    );
  });

  it('compacts and retries when switching to a model with a smaller context window', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-model-switch-overflow-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    const sourceModel = { ...model, id: 'large', modelId: 'large' };
    const targetModel = {
      ...model,
      id: 'small',
      modelId: 'small',
      contextWindowTokens: 30_000
    };
    const sourceAdapter = new PersistedUsageAdapter(sourceModel, 180_000);
    const targetAdapter = new ModelSwitchOverflowAdapter(targetModel);
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [sourceModel, targetModel],
      adapterFactory: (configuration) =>
        configuration.id === sourceModel.id ? sourceAdapter : targetAdapter
    });
    const session = await agent.createSession({ workspace, title: 'Model switch overflow' });
    await session.run({ prompt: 'seed history', modelId: sourceModel.id }).result();
    expect(
      await session.run({ prompt: 'continue', modelId: targetModel.id }).result()
    ).toMatchObject({ status: 'completed', finalAnswer: 'continued on switched model' });
    expect(targetAdapter.requests.filter((request) => request.toolChoice === 'none')).toHaveLength(
      1
    );
    expect(targetAdapter.requests.filter((request) => request.toolChoice !== 'none')).toHaveLength(
      2
    );
    const records = await import('../../src/agent-core/session/store/index.js').then(
      async ({ JsonlSessionStore }) => {
        const store = await JsonlSessionStore.open(home);
        const value = await store.read(session.id);
        await store.close();
        return value;
      }
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        type: 'compact.completed',
        payload: expect.objectContaining({
          summary: 'switched model summary',
          automatic: true,
          modelId: targetModel.id
        })
      })
    );
    await agent.dispose();
  });

  it('manually compacts oversized history without persisting a control prompt as a user turn', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-manual-compact-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    const compactModel = {
      ...model,
      contextWindowTokens: 10_000,
      maxOutputTokens: 1_000
    };
    const adapter = new CompactAdapter(compactModel, 40_000);
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [compactModel],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace, title: 'Cancellation' });
    expect((await session.run({ prompt: 'durable objective' }).result()).status).toBe('completed');
    expect(
      (await session.compact({ prompt: 'preserve exact file and test state' }).result()).status
    ).toBe('completed');
    const compactRequest = adapter.requests.at(-1)!;
    expect(compactRequest.system).not.toContain('Textual Continuation IR');
    expect(compactRequest.messages.at(-1)?.content).toContain('# Compaction contract');
    expect(compactRequest.tools.map((tool) => tool.name)).toContain('read');
    expect(compactRequest.toolChoice).toBe('none');
    expect(compactRequest.messages[0]?.content).toContain('durable objective');
    expect(compactRequest.messages[0]?.content).toContain('preserve exact file and test state');
    expect(
      countModelTokens(
        `${compactRequest.system}${JSON.stringify(compactRequest.messages)}${JSON.stringify(compactRequest.tools)}`
      )
    ).toBeLessThanOrEqual(compactModel.contextWindowTokens);
    const records = await import('../../src/agent-core/session/store/index.js').then(
      async ({ JsonlSessionStore }) => {
        const store = await JsonlSessionStore.open(home);
        const value = await store.read(session.id);
        await store.close();
        return value;
      }
    );
    expect(records.filter((record) => record.type === 'turn.user')).toHaveLength(1);
    await agent.dispose();
  });

  it('retries manual native compaction with bounded text evidence on provider overflow', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-manual-compact-fallback-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const compactModel = { ...model, contextWindowTokens: 30_000 };
    const adapter = new CompactOverflowFallbackAdapter(compactModel);
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [compactModel],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace });
    await session.run({ prompt: 'durable objective' }).result();
    expect(await session.compact({ prompt: 'preserve exact state' }).result()).toMatchObject({
      status: 'completed'
    });
    const compactRequests = adapter.requests.filter((request) => request.toolChoice === 'none');
    expect(compactRequests).toHaveLength(2);
    expect(compactRequests[0]?.messages.length).toBeGreaterThan(2);
    expect(baseMessages(compactRequests[1]!)).toHaveLength(2);
    expect(compactRequests[1]?.messages[0]?.content).toContain('preserve exact state');
    await agent.dispose();
  });

  it('uses authoritative Provider usage for manual native compaction when the local estimate overflows', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-manual-compact-provider-fit-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const compactModel = { ...model, contextWindowTokens: 10_000, maxOutputTokens: 1_000 };
    const adapter = new CalibratedNativeCompactAdapter(compactModel, false);
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [compactModel],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace });
    await session.run({ prompt: 'durable objective' }).result();
    expect(await session.compact({ prompt: 'preserve exact state' }).result()).toMatchObject({
      status: 'completed'
    });
    const compactRequest = adapter.requests.find((request) => request.toolChoice === 'none');
    expect(compactRequest?.messages.length).toBeGreaterThan(2);
    expect(JSON.stringify(compactRequest)).toContain('🌐tool-evidence');
    await agent.dispose();
  });

  it('rejects persisted usage calibration when a tool result has no paired tool call', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-manual-compact-orphan-tool-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const compactModel = { ...model, contextWindowTokens: 10_000, maxOutputTokens: 1_000 };
    const seedAdapter = new CalibratedNativeCompactAdapter(compactModel, false);
    const seedAgent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [compactModel],
      adapterFactory: () => seedAdapter
    });
    const session = await seedAgent.createSession({ workspace, title: 'Orphan tool calibration' });
    await session.run({ prompt: 'durable objective' }).result();
    await seedAgent.dispose();

    const store = await JsonlSessionStore.open(home);
    await store.append(session.id, {
      type: 'model.context',
      payload: { role: 'tool', callId: 'orphan-tool', content: 'unpaired result' }
    });
    await store.close();

    const compactAdapter = new CalibratedNativeCompactAdapter(compactModel, false);
    const compactAgent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [compactModel],
      adapterFactory: () => compactAdapter
    });
    const reopened = await compactAgent.openSession(session.id);
    expect(await reopened.compact({ prompt: 'preserve exact state' }).result()).toMatchObject({
      status: 'completed'
    });
    const compactRequest = compactAdapter.requests.find(
      (request) => request.toolChoice === 'none'
    )!;
    expect(baseMessages(compactRequest)).toHaveLength(2);
    expect(compactRequest.messages[0]?.content).toContain('Compaction focus');
    await compactAgent.dispose();
  });

  it('restores persisted usage calibration for a paired tool result', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-manual-compact-paired-tool-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const compactModel = { ...model, contextWindowTokens: 10_000, maxOutputTokens: 1_000 };
    const seedAdapter = new CalibratedNativeCompactAdapter(compactModel, false);
    const seedAgent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [compactModel],
      adapterFactory: () => seedAdapter
    });
    const session = await seedAgent.createSession({ workspace, title: 'Paired tool calibration' });
    await session.run({ prompt: 'durable objective' }).result();
    await seedAgent.dispose();

    const store = await JsonlSessionStore.open(home);
    await store.append(session.id, {
      type: 'model.context',
      payload: {
        role: 'tool_call',
        callId: 'paired-tool',
        name: 'read',
        arguments: { reads: [{ path: 'small.txt' }] }
      }
    });
    await store.append(session.id, {
      type: 'usage.updated',
      payload: {
        type: 'usage.updated',
        inputTokens: 7_000,
        contextInputTokens: 7_000,
        outputTokens: 500
      }
    });
    await store.append(session.id, {
      type: 'model.context',
      payload: { role: 'tool', callId: 'paired-tool', content: 'paired result' }
    });
    await store.close();

    const compactAdapter = new CalibratedNativeCompactAdapter(compactModel, false);
    const compactAgent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [compactModel],
      adapterFactory: () => compactAdapter
    });
    const reopened = await compactAgent.openSession(session.id);
    expect(await reopened.compact({ prompt: 'preserve exact state' }).result()).toMatchObject({
      status: 'completed'
    });
    const compactRequest = compactAdapter.requests.find(
      (request) => request.toolChoice === 'none'
    )!;
    expect(compactRequest.messages.length).toBeGreaterThan(2);
    expect(JSON.stringify(compactRequest.messages)).toContain('paired result');
    await compactAgent.dispose();
  });

  it('falls back locally when authoritative Provider usage omits output tokens', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-compact-missing-output-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const compactModel = { ...model, contextWindowTokens: 10_000, maxOutputTokens: 1_000 };
    const adapter = new CalibratedNativeCompactAdapter(compactModel, false, false);
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [compactModel],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace });
    await session.run({ prompt: 'durable objective' }).result();
    await session.compact().result();
    const compactRequest = adapter.requests.find((request) => request.toolChoice === 'none')!;
    expect(baseMessages(compactRequest)).toHaveLength(2);
    expect(JSON.stringify(compactRequest.messages)).not.toContain('<mar_environment>');
    await agent.dispose();
  });

  it('does not reuse restored Provider usage across a newer execution without usage', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-compact-stale-usage-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const compactModel = { ...model, contextWindowTokens: 10_000, maxOutputTokens: 1_000 };
    const adapter = new StaleUsageCompactAdapter(compactModel);
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [compactModel],
      adapterFactory: () => adapter
    });
    const session = await agent.createSession({ workspace });
    await session.run({ prompt: 'first' }).result();
    await session.run({ prompt: 'second' }).result();
    await session.compact().result();
    const compactRequest = adapter.requests.find((request) => request.toolChoice === 'none')!;
    expect(baseMessages(compactRequest)).toHaveLength(2);
    expect(JSON.stringify(compactRequest.messages)).not.toContain('<mar_environment>');
    await agent.dispose();
  });

  it('uses a text-only model to compact image history without loading or sending images', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-manual-image-compact-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    const imageBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const visionModel: MarAgentModelConfiguration = {
      ...model,
      id: 'vision-compact',
      modelId: 'vision-compact',
      inputCapabilities: ['TEXT', 'IMAGE']
    };
    const textCompactModel: MarAgentModelConfiguration = {
      ...model,
      id: 'text-compact',
      modelId: 'text-compact',
      contextWindowTokens: 10_000,
      maxOutputTokens: 1_000
    };
    const visionRequests: ModelRequest[] = [];
    const compactRequests: ModelRequest[] = [];
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [visionModel, textCompactModel],
      defaultModelId: visionModel.id,
      adapterFactory: (configuration) => ({
        configuration,
        async *start(request) {
          if (configuration.id === visionModel.id) {
            visionRequests.push(request);
            yield { type: 'text.completed', itemId: 'vision', text: 'image described' };
          } else {
            compactRequests.push(request);
            yield { type: 'text.completed', itemId: 'summary', text: 'image-free handoff' };
          }
          yield { type: 'completed', reason: 'completed' };
        }
      })
    });
    const session = await agent.createSession({ workspace, title: 'Manual image compact' });
    await expect(
      session
        .run({
          prompt: 'Describe the historical image.',
          images: [{ name: 'historical.png', mimeType: 'image/png', dataBase64: imageBase64 }]
        })
        .result()
    ).resolves.toMatchObject({ status: 'completed', finalAnswer: 'image described' });
    await rm(join(home, '.mar', 'agent', 'sessions', session.id, 'input_images'), {
      recursive: true,
      force: true
    });

    await expect(
      session
        .compact({
          prompt: 'Preserve the textual conclusion only.',
          modelId: textCompactModel.id,
          images: [{ name: 'current.png', mimeType: 'image/png', dataBase64: imageBase64 }]
        })
        .result()
    ).resolves.toMatchObject({ status: 'completed' });

    expect(visionRequests).toHaveLength(1);
    expect(compactRequests).toHaveLength(1);
    expect(compactRequests[0]?.images).toBeUndefined();
    expect(compactRequests[0]?.messages.every((message) => message.images === undefined)).toBe(
      true
    );
    expect(
      compactRequests[0]?.messages.some((message) =>
        message.content.includes('Describe the historical image.')
      )
    ).toBe(true);
    expect(compactRequests[0]?.messages.at(-1)?.content).toContain(
      'Preserve the textual conclusion only.'
    );
    await agent.dispose();
  });

  it('lists enabled models in the agent_start tool and honors a subagent modelId selection', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-runtime-subagent-model-'));
    homes.push(home);
    const workspace = join(home, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    await writeFile(join(workspace, 'input.txt'), 'subagent content\n');
    const defaultRequests: ModelRequest[] = [];
    const reviewRequests: ModelRequest[] = [];
    let requestedReasoningEffort: string | undefined = 'low';
    const reviewModel: MarAgentModelConfiguration = {
      ...model,
      id: 'review',
      name: 'Review Mini',
      modelId: 'review',
      reasoningEfforts: ['low', 'high'],
      defaultReasoningEffort: 'low'
    };
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model, reviewModel],
      adapterFactory: (configuration) =>
        new SubagentModelAdapter(
          configuration.id === 'review' ? reviewRequests : defaultRequests,
          configuration.id === 'review' ? undefined : () => requestedReasoningEffort
        )
    });
    const session = await agent.createSession({ workspace, title: 'Subagent model' });
    const handle = session.run({
      prompt: 'delegate',
      reasoningEffort: 'high'
    });
    for await (const event of handle) void event;
    expect(await handle.result()).toMatchObject({
      status: 'completed',
      finalAnswer: 'parent done'
    });

    const parentPrompt = defaultRequests[0]?.system ?? '';
    expect(parentPrompt).not.toContain('# Current Agent Model');
    expect(parentPrompt).not.toContain('# Subagent Models');
    expect(parentPrompt).not.toContain('https://example.test');
    expect(parentPrompt).not.toContain('apiKey');
    const agentStart = defaultRequests[0]?.tools.find((tool) => tool.name === 'agent_start');
    expect(agentStart?.description).toContain('- "coding" ("Coding")');
    expect(agentStart?.description).toContain(
      '- "review" ("Review Mini"; reasoning efforts: low, high)'
    );
    expect(agentStart?.description).not.toContain(', default');

    expect(reviewRequests.length).toBeGreaterThan(0);
    expect(
      reviewRequests.every((request) =>
        effectiveInstructions(request).includes('non-recursive subagent')
      )
    ).toBe(true);
    expect(reviewRequests.every((request) => request.reasoningEffort === 'low')).toBe(true);
    expect(reviewRequests[0]?.tools.some((tool) => tool.name === 'agent_start')).toBe(false);
    const taskResult = JSON.parse(
      defaultRequests.at(-1)?.messages.findLast((message) => message.role === 'tool')?.content ??
        '{}'
    );
    expect(taskResult.status).toBe('completed');
    expect(taskResult.summary).toBe('child done');

    requestedReasoningEffort = undefined;
    const inheritedSupportedRequestCount = reviewRequests.length;
    const inheritedSupportedSession = await agent.createSession({
      workspace,
      title: 'Subagent inherited supported effort'
    });
    const inheritedSupportedHandle = inheritedSupportedSession.run({
      prompt: 'delegate',
      reasoningEffort: 'high'
    });
    for await (const event of inheritedSupportedHandle) void event;
    expect(await inheritedSupportedHandle.result()).toMatchObject({
      status: 'completed',
      finalAnswer: 'parent done'
    });
    const inheritedSupportedReviewRequests = reviewRequests.slice(inheritedSupportedRequestCount);
    expect(inheritedSupportedReviewRequests.length).toBeGreaterThan(0);
    expect(
      inheritedSupportedReviewRequests.every((request) => request.reasoningEffort === 'high')
    ).toBe(true);

    const inheritedUnsupportedRequestCount = reviewRequests.length;
    const unsupportedSession = await agent.createSession({
      workspace,
      title: 'Subagent unsupported effort'
    });
    const unsupportedHandle = unsupportedSession.run({
      prompt: 'delegate',
      reasoningEffort: 'xhigh'
    });
    for await (const event of unsupportedHandle) void event;
    expect(await unsupportedHandle.result()).toMatchObject({
      status: 'completed',
      finalAnswer: 'parent done'
    });
    const unsupportedReviewRequests = reviewRequests.slice(inheritedUnsupportedRequestCount);
    expect(unsupportedReviewRequests.length).toBeGreaterThan(0);
    expect(unsupportedReviewRequests.every((request) => request.reasoningEffort === 'low')).toBe(
      true
    );

    requestedReasoningEffort = 'xhigh';
    const explicitUnsupportedRequestCount = reviewRequests.length;
    const explicitUnsupportedSession = await agent.createSession({
      workspace,
      title: 'Subagent explicit unsupported effort'
    });
    const explicitUnsupportedHandle = explicitUnsupportedSession.run({
      prompt: 'delegate',
      reasoningEffort: 'high'
    });
    for await (const event of explicitUnsupportedHandle) void event;
    expect(await explicitUnsupportedHandle.result()).toMatchObject({
      status: 'completed',
      finalAnswer: 'parent done'
    });
    expect(reviewRequests).toHaveLength(explicitUnsupportedRequestCount);
    const explicitUnsupportedTaskResult = JSON.parse(
      defaultRequests.at(-1)?.messages.findLast((message) => message.role === 'tool')?.content ??
        '{}'
    );
    expect(explicitUnsupportedTaskResult).toMatchObject({
      status: 'failed',
      errorCode: 'MAR_AGENT_SUBAGENT_REASONING_EFFORT_UNAVAILABLE'
    });
    await agent.dispose();
  });
});
