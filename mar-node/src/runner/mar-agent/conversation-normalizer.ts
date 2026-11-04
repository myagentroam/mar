import type { ExecutionResult, AgentEvent } from '@myagentroam/agent';
import { parseToolResultExtensions } from '@myagentroam/agent';
import type { ModelUsageObservation } from '@myagentroam/agent';

/** SDK usage is already normalized; never parse provider payloads in Node. */
export function normalizeMarAgentUsage(usage: ModelUsageObservation) {
  const { executionId: _executionId, ...record } = usage;
  return { ...record, schemaVersion: 1 as const, coverage: 'request' as const };
}
import {
  boundedConversationItemId,
  compactRunnerText,
  compactRunnerValue
} from '../normalization.js';
import { runnerErrorProjection } from '../runner-error.js';
import {
  toolPresentationSchema,
  agentOperationPresentationSchema,
  type ToolPresentation,
  type ExecutionPresentation
} from '@myagentroam/protocol';
import { publicOutputSnapshot, publicToolOutput } from '../normalization.js';
import { boundToolOutput } from '@myagentroam/protocol';
import {
  agentOperationAction,
  agentOperationPresentation
} from './agent-operation-presentation.js';

export interface MarAgentNormalizedItem {
  readonly itemId: string;
  readonly kind:
    | 'user_message'
    | 'assistant_message'
    | 'command_execution'
    | 'file_change'
    | 'tool_call'
    | 'plan'
    | 'todo_list'
    | 'context_compaction'
    | 'reasoning'
    | 'error';
  readonly status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'INTERRUPTED';
  readonly payload: Record<string, unknown>;
  readonly permissionStop?: NonNullable<ExecutionResult['permissionStop']>;
  readonly generatedImages?: readonly MarAgentGeneratedImageArtifact[];
  readonly merge?: boolean;
  readonly append?: 'output';
}

export interface MarAgentGeneratedImageArtifact {
  readonly name: string;
  readonly mime: 'image/png';
  readonly byteSize: number;
  readonly fileName: string;
}

type ToolState = {
  readonly presentationData?: unknown;
  readonly sleepStartedAt?: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly itemId: string;
  readonly structured: boolean;
  readonly inputTruncated?: boolean;
  readonly executionId: string;
  readonly turnId?: string;
  active: boolean;
  readonly commandOrigin?: string;
  readonly subagentTitle?: string;
  readonly subagentDetails?: SubagentDetails;
};

type CodeModeOutputCall = {
  readonly parentCallId: string;
  readonly executionId: string;
  readonly turnId?: string;
  readonly toolName: 'exec' | 'exec_wait';
  readonly input: unknown;
};

type CodeModeOutputSnapshot = {
  readonly outputPreview: string;
  readonly truncated: boolean;
  readonly displayOutput: NonNullable<CommandState['displayOutput']>;
  readonly processId: string;
  readonly outputTruncation?: 'HEAD' | 'SOURCE';
};

function boundCodeOutputSnapshots(sources: Map<string, CodeModeOutputSnapshot>): void {
  for (const channel of ['outputPreview', 'stdout', 'stderr'] as const) {
    const text = (entry: CodeModeOutputSnapshot) =>
      channel === 'outputPreview' ? entry.outputPreview : entry.displayOutput[channel];
    let excess =
      [...sources.values()].reduce((length, entry) => length + text(entry).length, 0) - 10_000;
    for (const [id, entry] of sources) {
      if (excess <= 0) break;
      const before = text(entry);
      if (!before) continue;
      let removed = Math.min(excess, before.length);
      if (/^[\uDC00-\uDFFF]/u.test(before.slice(removed))) removed++;
      const tail = before.slice(removed);
      if (channel === 'outputPreview') {
        sources.set(id, { ...entry, outputPreview: tail, truncated: true });
      } else {
        const dropped = channel === 'stdout' ? 'stdoutDroppedBytes' : 'stderrDroppedBytes';
        sources.set(id, {
          ...entry,
          truncated: true,
          displayOutput: {
            ...entry.displayOutput,
            [channel]: tail,
            [dropped]: entry.displayOutput[dropped] + Buffer.byteLength(before.slice(0, removed))
          }
        });
      }
      excess -= removed;
    }
  }
}

type RunningCodeModeCell = {
  readonly cellId: string;
  readonly executionId: string;
};

type SubagentDetails = {
  readonly modelId?: string;
  readonly modelName?: string;
  readonly reasoningEffort?: string;
  readonly latestMessage?: Record<string, unknown>;
};

type CommandState = {
  readonly itemId: string;
  readonly command: string;
  readonly cwd: string | null;
  status: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  outputPreview: string;
  outputTruncation?: 'HEAD' | 'SOURCE';
  exitCode: number | null;
  truncated: boolean;
  inputTruncated?: boolean;
  displayOutput?: {
    stdout: string;
    stderr: string;
    stdoutDroppedBytes: number;
    stderrDroppedBytes: number;
  };
  error?: { code: string; message: string };
};

type CodeModeToolResult = {
  readonly resultExtensions?: unknown;
  readonly id?: string;
  readonly source: {
    readonly callId: string;
    readonly toolName: string;
    readonly input: unknown;
  };
  readonly outcome: 'completed' | 'failed';
  readonly result: {
    readonly content: string;
    readonly data?: unknown;
    readonly truncated?: boolean;
  };
};

type ApplyPatchObservationData = {
  files: {
    path: string;
    targetPath?: string;
    operation: 'added' | 'modified' | 'deleted' | 'moved';
    addedLines: number;
    deletedLines: number;
  }[];
  totals: { files: number; addedLines: number; deletedLines: number };
};

type SubagentObservationData = Record<string, unknown> & {
  agentId: string;
  description: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
};

type EventMetadata = {
  eventId: string;
  sequence: number;
  timestamp: string;
  sessionId: string;
  executionId: string;
  turnId?: string;
};

export class MarAgentConversationNormalizer {
  input(entry: Extract<import('@myagentroam/agent').AgentSessionHistoryEntry, { kind: 'user' }>) {
    return {
      itemId: boundedConversationItemId(
        'mar-agent-input',
        entry.recordId ?? String(entry.sequence)
      ),
      kind: 'user_message' as const,
      status: 'COMPLETED' as const,
      merge: true,
      payload: {
        text: entry.text,
        clientMessageId: entry.clientMessageId ?? null,
        contexts: [],
        delivery: 'ACCEPTED',
        recordId: entry.recordId
      }
    };
  }
  readonly #tools = new Map<string, ToolState>();
  readonly #commands = new Map<string, CommandState>();
  readonly #subagentTitles = new Map<string, string>();
  readonly #subagentDetails = new Map<string, SubagentDetails>();
  readonly #codeModeObservationIds = new Set<string>();
  readonly #codeModeSourceCallIds = new Set<string>();
  readonly #codeModeOutputCalls = new Map<string, CodeModeOutputCall>();
  readonly #codeModeOutputSnapshots = new Map<string, Map<string, CodeModeOutputSnapshot>>();
  readonly #codeModeOutputArchive = new Map<string, Map<string, CodeModeOutputSnapshot>>();
  readonly #runningCodeModeCells = new Map<string, RunningCodeModeCell>();
  readonly #codeModeCellWaiters = new Map<string, Set<string>>();

  messageItemId(nativeItemId: string): string {
    return itemId('message', nativeItemId);
  }

  normalize(
    event: AgentEvent,
    options: { readonly publicItemIdPrefix?: string } = {}
  ): readonly MarAgentNormalizedItem[] {
    if (event.type === 'tool.output') return this.#toolOutput(event);
    if (event.type === 'execution.started') {
      this.#startExecution(event.executionId);
      return [];
    }
    if (event.type === 'input.received') return [this.input(event.entry)];
    if (event.type === 'execution.failed') {
      const projected = runnerErrorProjection(
        { code: event.code, message: event.message },
        'MAR_AGENT_RUN_FAILED'
      );
      return [
        {
          itemId: itemId('error', event.executionId),
          kind: 'error',
          status: 'FAILED',
          payload: {
            ...projected,
            recoverable: true,
            retryAfterMs: null
          },
          merge: true
        }
      ];
    }
    if (event.type === 'message.started' || event.type === 'message.completed') {
      const modelName = record(event)?.modelName;
      const itemId = this.messageItemId(event.itemId);
      const payload = {
        text: event.type === 'message.completed' ? event.text : '',
        format: 'markdown' as const,
        model: typeof modelName === 'string' ? modelName : null,
        phase: event.phase
      };
      return [
        {
          itemId,
          kind: 'assistant_message',
          status: event.type === 'message.completed' ? 'COMPLETED' : 'IN_PROGRESS',
          payload
        }
      ];
    }
    if (event.type === 'plan.completed')
      return [
        {
          itemId: itemId('message', event.itemId),
          kind: 'plan',
          status: 'COMPLETED',
          payload: { explanation: event.text, steps: [] }
        }
      ];
    if (event.type === 'reasoning.completed')
      return [
        {
          itemId: itemId('reasoning', event.itemId),
          kind: 'reasoning',
          status: 'COMPLETED',
          payload: {
            representation: event.representation,
            sections: [{ index: 0, text: compactRunnerText(event.text, 10_000) }]
          }
        }
      ];
    if (
      event.type === 'tool.started' ||
      event.type === 'tool.completed' ||
      event.type === 'tool.failed'
    ) {
      if (
        event.parentCallId !== undefined &&
        (event.toolName === 'exec' || event.toolName === 'exec_wait')
      ) {
        if (event.type === 'tool.started') this.#trackCodeModeOutputCall(event);
        else this.#finishCodeModeOutputCall(event.callId, event.parentCallId);
        return [];
      }
      // Public Agent calls, read/web calls and artifacts do not depend on model observations.
      if (
        event.parentCallId !== undefined &&
        event.toolName !== 'read' &&
        event.toolName !== 'web_search' &&
        event.toolName !== 'web_fetch' &&
        agentOperationAction(event.toolName) === undefined &&
        !isImageGenerationTool(event.toolName)
      ) {
        this.#finishCodeModeOutputCall(event.callId, event.parentCallId);
        return [];
      }
      if (event.parentCallId !== undefined && agentOperationAction(event.toolName) !== undefined)
        this.#codeModeSourceCallIds.add(event.callId);
      if (event.type === 'tool.started') return this.#toolStarted(event);
      this.#finishToolCall(event);
      const permissionStop = permissionStopForToolEvent(event);
      const outerItems =
        event.type === 'tool.completed' ? this.#toolCompleted(event) : this.#toolFailed(event);
      return [
        ...withPermissionStop(outerItems, permissionStop),
        ...this.#codeModeToolResults(event)
      ];
    }
    if (event.type === 'tool.updated') {
      const state = this.#tools.get(event.callId);
      if (
        !state?.active ||
        state.toolName !== event.toolName ||
        !agentOperationAction(event.toolName)
      )
        return [];
      const operation = agentOperationPresentationSchema.safeParse(
        record(event.data)?.agentOperation
      );
      if (!operation.success || operation.data.action !== agentOperationAction(event.toolName))
        return [];
      this.#tools.set(event.callId, { ...state, presentationData: event.data });
      return [
        genericToolItem(
          state.itemId,
          state.toolName,
          'IN_PROGRESS',
          state.input,
          null,
          null,
          false,
          event.data,
          state.subagentTitle,
          state.subagentDetails,
          undefined,
          undefined,
          state.inputTruncated
        )
      ];
    }
    if (event.type === 'sleep.started') {
      const state = this.#tools.get(event.callId);
      if (state?.toolName !== 'sleep') return [];
      this.#tools.set(event.callId, { ...state, sleepStartedAt: event.startedAt });
      return [
        genericToolItem(
          state.itemId,
          'sleep',
          'IN_PROGRESS',
          state.input,
          null,
          null,
          false,
          undefined,
          undefined,
          undefined,
          event.startedAt
        )
      ];
    }
    if (event.type === 'todo.updated')
      return [
        {
          itemId: itemId('todo-list', event.eventId),
          kind: 'todo_list',
          status: 'COMPLETED',
          payload: {
            items: event.items.map((entry) => ({
              id: compactRunnerText(entry.id, 128) || 'unknown',
              text: entry.step,
              status: entry.status.toUpperCase()
            }))
          }
        }
      ];
    if (
      event.type === 'context.compacting' ||
      event.type === 'context.compacted' ||
      event.type === 'context.compact_failed'
    ) {
      const anchorItemId = this.#compactAnchorItemId(event, options.publicItemIdPrefix);
      return [normalizeContextCompaction(event, anchorItemId)];
    }
    if (event.type === 'subagent.started' || event.type === 'subagent.completed')
      return this.#subagentLifecycle(event);
    return [];
  }

  #toolStarted(event: Extract<AgentEvent, { type: 'tool.started' }>) {
    const ownItemId = itemId('tool', event.callId);
    this.#clearRetainedCodeModeCellsForOtherExecutions(event.executionId);
    this.#codeModeOutputCalls.delete(event.callId);
    this.#clearCodeModeOutputSnapshots(event.callId);
    if (event.toolName === 'exec' || event.toolName === 'exec_wait') {
      const input = record(event.input) ?? {};
      const action =
        input.action ??
        (event.toolName === 'exec_wait'
          ? 'poll'
          : typeof input.command === 'string'
            ? 'start'
            : undefined);
      if (action === 'start' && typeof input.command === 'string') {
        const command: CommandState = {
          itemId: ownItemId,
          command: compactRunnerText(input.command, 10_000),
          cwd: typeof input.cwd === 'string' ? compactRunnerText(input.cwd, 4_096) : null,
          status: 'IN_PROGRESS',
          outputPreview: '',
          exitCode: null,
          truncated:
            event.truncated === true ||
            input.command.length > 10_000 ||
            (typeof input.cwd === 'string' && input.cwd.length > 4096),
          inputTruncated:
            event.truncated === true ||
            input.command.length > 10_000 ||
            (typeof input.cwd === 'string' && input.cwd.length > 4096)
        };
        this.#commands.set(event.callId, command);
        this.#tools.set(event.callId, {
          toolName: event.toolName,
          input: event.input,
          itemId: ownItemId,
          structured: true,
          executionId: event.executionId,
          ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
          active: true,
          commandOrigin: event.callId
        });
        return [commandItem(command, 'IN_PROGRESS')];
      }
    }
    const agentId = isMarAgentControlTool(event.toolName)
      ? marAgentAgentId(event.input)
      : undefined;
    const subagentTitle = agentId === undefined ? undefined : this.#subagentTitles.get(agentId);
    const subagentDetails = agentId === undefined ? undefined : this.#subagentDetails.get(agentId);
    this.#tools.set(event.callId, {
      toolName: event.toolName,
      input: event.input,
      itemId: ownItemId,
      structured: 'input' in event,
      inputTruncated: event.truncated === true,
      executionId: event.executionId,
      ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
      active: true,
      ...(event.data === undefined ? {} : { presentationData: event.data }),
      ...(subagentTitle === undefined ? {} : { subagentTitle }),
      ...(subagentDetails === undefined ? {} : { subagentDetails })
    });
    if (event.toolName === 'code_exec_wait') this.#trackCodeModeWait(event);
    if (event.toolName === 'apply_patch' && 'input' in event)
      return [fileChangeItem(ownItemId, 'IN_PROGRESS', [])];
    return [
      genericToolItem(
        ownItemId,
        event.toolName,
        'IN_PROGRESS',
        event.input,
        null,
        null,
        event.truncated === true,
        event.data,
        subagentTitle,
        subagentDetails,
        undefined,
        undefined,
        event.truncated === true
      )
    ];
  }

  #toolOutput(
    event: Extract<AgentEvent, { type: 'tool.output' }>
  ): readonly MarAgentNormalizedItem[] {
    const { callId, toolName, executionId, turnId, parentCallId, output } = event;
    if (output.mode === 'delta') return this.#toolOutputDelta(event);
    const inputOutput = [output.stdout, output.stderr].filter(Boolean).join('\n');
    const displayOutput = execDisplayOutput(output.displayOutput) ?? {
      stdout: output.stdout,
      stderr: output.stderr,
      stdoutDroppedBytes: 0,
      stderrDroppedBytes: 0
    };
    const displayed = [displayOutput.stdout, displayOutput.stderr].filter(Boolean).join('\n');
    const bounded = publicOutputSnapshot(displayed, event.outputTruncation !== undefined);
    const snapshot = {
      outputPreview: bounded.text,
      truncated: bounded.truncated || inputOutput.length > 10_000,
      displayOutput,
      processId: output.processId,
      ...(event.outputTruncation ? { outputTruncation: event.outputTruncation } : {})
    };

    if (parentCallId !== undefined && (toolName === 'exec' || toolName === 'exec_wait'))
      return this.#codeModeToolOutput(
        callId,
        parentCallId,
        toolName,
        executionId,
        turnId,
        output.processId,
        snapshot
      );

    const state = this.#tools.get(callId);
    if (
      state === undefined ||
      !state.active ||
      state.toolName !== toolName ||
      state.executionId !== executionId ||
      (state.turnId !== undefined && turnId !== undefined && state.turnId !== turnId)
    )
      return [];
    const input = record(state.input);
    if (typeof input?.processId === 'string' && input.processId !== output.processId) return [];

    if (state.commandOrigin === undefined) {
      if (toolName !== 'exec_wait' && toolName !== 'code_exec_wait') return [];
      return [
        genericToolItem(
          state.itemId,
          toolName,
          'IN_PROGRESS',
          state.input,
          snapshot.outputPreview,
          null,
          snapshot.truncated,
          {
            processId: output.processId,
            displayOutput: snapshot.displayOutput,
            outputHeadTruncated:
              snapshot.displayOutput.stdoutDroppedBytes > 0 ||
              snapshot.displayOutput.stderrDroppedBytes > 0
          },
          undefined,
          undefined,
          undefined,
          event.outputTruncation,
          state.inputTruncated
        )
      ];
    }

    const command = this.#commands.get(state.commandOrigin);
    if (command === undefined || command.status !== 'IN_PROGRESS') return [];
    const display = snapshot.displayOutput;
    if (display !== undefined) command.displayOutput = display;
    command.outputPreview = snapshot.outputPreview;
    command.truncated = snapshot.truncated;
    if (event.outputTruncation) command.outputTruncation = event.outputTruncation;
    else delete command.outputTruncation;
    return [commandItem(command, 'IN_PROGRESS')];
  }

  #toolOutputDelta(
    event: Extract<AgentEvent, { type: 'tool.output' }>
  ): readonly MarAgentNormalizedItem[] {
    const { callId, toolName, executionId, turnId, parentCallId, output } = event;
    let target = this.#tools.get(callId);
    if (parentCallId !== undefined) {
      const child = this.#codeModeOutputCalls.get(callId);
      const parent = this.#tools.get(parentCallId);
      if (
        !child ||
        child.parentCallId !== parentCallId ||
        child.toolName !== toolName ||
        child.executionId !== executionId ||
        (child.turnId && turnId && child.turnId !== turnId) ||
        !parent ||
        parent.executionId !== executionId ||
        (parent.turnId && turnId && parent.turnId !== turnId)
      )
        return [];
      const input = record(child.input);
      if (typeof input?.processId === 'string' && input.processId !== output.processId) return [];
      const display = execDisplayOutput(output.displayOutput);
      if (display) {
        const snapshots = this.#codeModeOutputSnapshots.get(parentCallId) ?? new Map();
        const text = [display.stdout, display.stderr].filter(Boolean).join('\n');
        const bounded = publicOutputSnapshot(
          text,
          display.stdoutDroppedBytes > 0 || display.stderrDroppedBytes > 0
        );
        snapshots.set(callId, {
          outputPreview: bounded.text,
          truncated: bounded.truncated,
          displayOutput: display,
          processId: output.processId
        });
        this.#codeModeOutputSnapshots.set(parentCallId, snapshots);
      }
      target = parent.active
        ? parent
        : this.#runningCodeModeCells.get(parentCallId)?.executionId === executionId
          ? this.#activeCodeModeWaiter(this.#runningCodeModeCells.get(parentCallId)!)
          : undefined;
    } else {
      if (
        !target ||
        !target.active ||
        target.toolName !== toolName ||
        target.executionId !== executionId ||
        (target.turnId && turnId && target.turnId !== turnId)
      )
        return [];
      const input = record(target.input);
      if (typeof input?.processId === 'string' && input.processId !== output.processId) return [];
    }
    if (!target) return [];
    const command =
      target.commandOrigin === undefined ? undefined : this.#commands.get(target.commandOrigin);
    const item = command
      ? commandItem(command, 'IN_PROGRESS')
      : genericToolItem(
          target.itemId,
          target.toolName,
          'IN_PROGRESS',
          target.input,
          null,
          null,
          false,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          target.inputTruncated
        );
    const blocks = [
      ...(output.stdout ? [{ channel: 'STDOUT' as const, text: output.stdout }] : []),
      ...(output.stderr ? [{ channel: 'STDERR' as const, text: output.stderr }] : [])
    ];
    return [
      {
        ...item,
        append: 'output',
        merge: true,
        payload: {
          ...item.payload,
          output: boundToolOutput(blocks, event.outputTruncation)
        }
      }
    ];
  }

  #codeModeToolOutput(
    callId: string,
    parentCallId: string,
    toolName: 'exec' | 'exec_wait',
    executionId: string,
    turnId: string | undefined,
    processId: string,
    snapshot: CodeModeOutputSnapshot
  ): readonly MarAgentNormalizedItem[] {
    const parent = this.#tools.get(parentCallId);
    const child = this.#codeModeOutputCalls.get(callId);
    if (
      parent === undefined ||
      (parent.toolName !== 'code_exec' && parent.toolName !== 'code_exec_wait') ||
      parent.executionId !== executionId ||
      (parent.turnId !== undefined && turnId !== undefined && parent.turnId !== turnId) ||
      child === undefined ||
      child.parentCallId !== parentCallId ||
      child.toolName !== toolName ||
      child.executionId !== executionId ||
      (child.turnId !== undefined && turnId !== undefined && child.turnId !== turnId)
    )
      return [];

    const target = parent.active
      ? parent
      : this.#runningCodeModeCells.get(parentCallId)?.executionId === executionId
        ? this.#activeCodeModeWaiter(this.#runningCodeModeCells.get(parentCallId)!)
        : undefined;
    if (target === undefined) return [];
    const input = record(child.input);
    if (typeof input?.processId === 'string' && input.processId !== processId) return [];

    const snapshots = this.#codeModeOutputSnapshots.get(parentCallId) ?? new Map();
    snapshots.set(callId, snapshot);
    this.#codeModeOutputSnapshots.set(parentCallId, snapshots);
    const sources = new Map(this.#codeModeOutputArchive.get(parentCallId));
    for (const active of snapshots.values()) sources.set(active.processId, active);
    const entries = [...sources.values()];
    const combined = entries
      .map((entry) => entry.outputPreview)
      .filter(Boolean)
      .join('');
    const bounded = publicOutputSnapshot(
      combined,
      entries.some((entry) => entry.truncated)
    );
    return [
      genericToolItem(
        target.itemId,
        target.toolName,
        'IN_PROGRESS',
        target.input,
        bounded.text,
        null,
        bounded.truncated,
        {
          outputHeadTruncated: entries.some(
            (entry) =>
              entry.displayOutput.stdoutDroppedBytes > 0 ||
              entry.displayOutput.stderrDroppedBytes > 0
          ),
          displayOutput: {
            stdout: entries
              .map((entry) => entry.displayOutput.stdout)
              .filter(Boolean)
              .join(''),
            stderr: entries
              .map((entry) => entry.displayOutput.stderr)
              .filter(Boolean)
              .join('')
          }
        },
        undefined,
        undefined,
        undefined,
        entries.some((entry) => entry.outputTruncation === 'SOURCE')
          ? 'SOURCE'
          : entries.some(
                (entry) =>
                  entry.outputTruncation === 'HEAD' ||
                  entry.displayOutput.stdoutDroppedBytes > 0 ||
                  entry.displayOutput.stderrDroppedBytes > 0
              )
            ? 'HEAD'
            : undefined,
        target.inputTruncated
      )
    ];
  }

  #trackCodeModeOutputCall(event: Extract<AgentEvent, { type: 'tool.started' }>): void {
    const parentCallId = event.parentCallId;
    if (parentCallId === undefined || (event.toolName !== 'exec' && event.toolName !== 'exec_wait'))
      return;
    const parent = this.#tools.get(parentCallId);
    const retainedCell = this.#runningCodeModeCells.get(parentCallId);
    const canResumeRetainedCell =
      parent !== undefined && !parent.active && retainedCell?.executionId === event.executionId;
    if (
      parent === undefined ||
      (parent.toolName !== 'code_exec' && parent.toolName !== 'code_exec_wait') ||
      parent.executionId !== event.executionId ||
      (parent.turnId !== undefined && event.turnId !== undefined && parent.turnId !== event.turnId)
    )
      return;
    if (!parent.active && !canResumeRetainedCell) return;
    this.#codeModeOutputCalls.delete(event.callId);
    const snapshots = this.#codeModeOutputSnapshots.get(parentCallId);
    snapshots?.delete(event.callId);
    this.#codeModeOutputCalls.set(event.callId, {
      parentCallId,
      executionId: event.executionId,
      ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
      toolName: event.toolName,
      input: event.input
    });
  }

  #finishCodeModeOutputCall(callId: string, parentCallId: string): void {
    const call = this.#codeModeOutputCalls.get(callId);
    if (call?.parentCallId === parentCallId) {
      this.#codeModeOutputCalls.delete(callId);
      const snapshots = this.#codeModeOutputSnapshots.get(parentCallId);
      const completed = snapshots?.get(callId);
      snapshots?.delete(callId);
      if (completed) {
        const archive =
          this.#codeModeOutputArchive.get(parentCallId) ??
          new Map<string, CodeModeOutputSnapshot>();
        archive.set(completed.processId, completed);
        boundCodeOutputSnapshots(archive);
        this.#codeModeOutputArchive.set(parentCallId, archive);
      }
    }
  }

  #trackCodeModeWait(event: Extract<AgentEvent, { type: 'tool.started' }>): void {
    const cellId = record(event.input)?.cellId;
    if (typeof cellId !== 'string' || cellId.length === 0) return;
    const cell = [...this.#runningCodeModeCells.values()].find(
      (candidate) => candidate.cellId === cellId && candidate.executionId === event.executionId
    );
    if (cell === undefined) return;
    const waiters = this.#codeModeCellWaiters.get(cellId) ?? new Set<string>();
    waiters.add(event.callId);
    this.#codeModeCellWaiters.set(cellId, waiters);
  }

  #activeCodeModeWaiter(cell: RunningCodeModeCell): ToolState | undefined {
    const waiters = this.#codeModeCellWaiters.get(cell.cellId);
    if (waiters === undefined) return undefined;
    for (const callId of [...waiters].reverse()) {
      const state = this.#tools.get(callId);
      const input = record(state?.input);
      if (
        state?.active === true &&
        state.toolName === 'code_exec_wait' &&
        state.executionId === cell.executionId &&
        input?.cellId === cell.cellId
      )
        return state;
      waiters.delete(callId);
    }
    if (waiters.size === 0) this.#codeModeCellWaiters.delete(cell.cellId);
    return undefined;
  }

  #finishToolCall(event: Extract<AgentEvent, { type: 'tool.completed' | 'tool.failed' }>): void {
    const state = this.#tools.get(event.callId);
    if (state !== undefined) state.active = false;
    const data = record(event.data);
    const cellId = typeof data?.cellId === 'string' ? data.cellId : undefined;
    const status = data?.status;

    if (state?.toolName === 'code_exec') {
      if (
        event.type === 'tool.completed' &&
        event.toolName === 'code_exec' &&
        status === 'running' &&
        cellId !== undefined &&
        cellId.length > 0
      ) {
        this.#runningCodeModeCells.set(event.callId, {
          cellId,
          executionId: event.executionId
        });
        return;
      }
      this.#clearRunningCodeModeCell(event.callId);
      return;
    }

    if (state?.toolName === 'code_exec_wait') {
      const inputCellId = record(state.input)?.cellId;
      if (typeof inputCellId === 'string') this.#removeCodeModeWaiter(inputCellId, event.callId);
      if (
        (status === 'completed' || status === 'failed' || status === 'cancelled') &&
        typeof (cellId ?? inputCellId) === 'string'
      ) {
        const finishedCellId = (cellId ?? inputCellId) as string;
        for (const [sourceCallId, cell] of this.#runningCodeModeCells)
          if (cell.cellId === finishedCellId && cell.executionId === event.executionId)
            this.#clearRunningCodeModeCell(sourceCallId);
      }
      this.#clearCodeModeOutputSnapshots(event.callId);
      return;
    }

    this.#clearCodeModeOutputSnapshots(event.callId);
  }

  #clearCodeModeOutputSnapshots(parentCallId: string): void {
    this.#codeModeOutputSnapshots.delete(parentCallId);
    this.#codeModeOutputArchive.delete(parentCallId);
    for (const [callId, state] of this.#codeModeOutputCalls)
      if (state.parentCallId === parentCallId) this.#codeModeOutputCalls.delete(callId);
  }

  #removeCodeModeWaiter(cellId: string, callId: string): void {
    const waiters = this.#codeModeCellWaiters.get(cellId);
    waiters?.delete(callId);
    if (waiters?.size === 0) this.#codeModeCellWaiters.delete(cellId);
  }

  #clearRunningCodeModeCell(sourceCallId: string): void {
    const cell = this.#runningCodeModeCells.get(sourceCallId);
    if (cell !== undefined) {
      this.#runningCodeModeCells.delete(sourceCallId);
      this.#codeModeCellWaiters.delete(cell.cellId);
    }
    this.#clearCodeModeOutputSnapshots(sourceCallId);
  }

  #startExecution(executionId: string): void {
    for (const [callId, state] of this.#tools)
      if (state.executionId !== executionId) {
        state.active = false;
      }
    for (const [callId, state] of this.#codeModeOutputCalls)
      if (state.executionId !== executionId) this.#codeModeOutputCalls.delete(callId);
    for (const [sourceCallId, cell] of this.#runningCodeModeCells)
      if (cell.executionId !== executionId) this.#clearRunningCodeModeCell(sourceCallId);
    for (const parentCallId of this.#codeModeOutputSnapshots.keys())
      if (this.#tools.get(parentCallId)?.executionId !== executionId)
        this.#codeModeOutputSnapshots.delete(parentCallId);
  }

  #clearRetainedCodeModeCellsForOtherExecutions(executionId: string): void {
    for (const [sourceCallId, cell] of this.#runningCodeModeCells)
      if (cell.executionId !== executionId) this.#clearRunningCodeModeCell(sourceCallId);
  }

  #compactAnchorItemId(
    event: MarAgentCompactLifecycleEvent,
    publicItemIdPrefix: string | undefined
  ): string | undefined {
    const anchor = event.anchor;
    if (anchor === undefined || !validCompactAnchor(anchor.id)) return undefined;
    const itemId =
      anchor.kind === 'message'
        ? this.messageItemId(anchor.id)
        : this.#tools.get(anchor.id)?.itemId;
    if (itemId === undefined) return undefined;
    const publicItemId =
      publicItemIdPrefix === undefined ? itemId : `${publicItemIdPrefix}:${itemId}`;
    return publicItemId.length <= 128 ? publicItemId : undefined;
  }

  #toolCompleted(event: Extract<AgentEvent, { type: 'tool.completed' }>) {
    const state = this.#tools.get(event.callId);
    if (event.toolName === 'exec' && state?.commandOrigin !== undefined) {
      const command = this.#commands.get(state.commandOrigin);
      const result = execResult(event.data, event.summary, event.outputTruncation !== undefined);
      if (command !== undefined && result !== undefined) {
        applyCommandResult(command, result);
        if (event.outputTruncation) command.outputTruncation = event.outputTruncation;
        else delete command.outputTruncation;
        const data = record(event.data);
        const display = execDisplayOutput(data?.displayOutput);
        if (display !== undefined) command.displayOutput = display;
        else delete command.displayOutput;
        command.status = 'COMPLETED';
        return [commandItem(command, 'COMPLETED')];
      }
    }
    if (
      event.toolName === 'apply_patch' &&
      (state?.structured === true ||
        Array.isArray(record(event.data)?.files) ||
        parseToolResultExtensions(event.resultExtensions) !== undefined)
    )
      return [
        fileChangeItem(
          state?.itemId ?? itemId('tool', event.callId),
          'COMPLETED',
          patchChanges(event.data, event.resultExtensions)
        )
      ];
    const generatedImages = imageArtifacts(event);
    const controlTool = isMarAgentControlTool(event.toolName);
    const controlOutput = controlTool
      ? matchingSubagentControlOutput(event.toolName, state?.input, event.data)
      : undefined;
    const agentId = controlTool
      ? (marAgentAgentId(state?.input) ?? marAgentAgentId(controlOutput))
      : undefined;
    const cachedDetails =
      agentId === undefined
        ? undefined
        : mergeSubagentDetails(this.#subagentDetails.get(agentId), state?.subagentDetails ?? {});
    const details = controlTool
      ? mergeSubagentDetails(cachedDetails, subagentDetails(controlOutput))
      : {};
    if (agentId !== undefined) {
      const output = structuredRecord(controlOutput);
      if (typeof output?.description === 'string') {
        const title = compactRunnerText(output.description, 500);
        if (title.length > 0) this.#subagentTitles.set(agentId, title);
      }
      if (Object.keys(details).length > 0)
        this.#subagentDetails.set(agentId, withoutSubagentLatestMessage(details) ?? {});
    }
    const item = genericToolItem(
      state?.itemId ?? itemId('tool', event.callId),
      event.toolName,
      'COMPLETED',
      state?.input,
      generatedImages.length === 0
        ? event.summary
        : generatedImages.map((image) => image.name).join(', '),
      null,
      event.outputTruncation !== undefined,
      mergeAgentOperationData(event.toolName, state?.presentationData, event.data),
      agentId === undefined ? state?.subagentTitle : this.#subagentTitles.get(agentId),
      details,
      state?.sleepStartedAt,
      event.outputTruncation,
      state?.inputTruncated,
      event.summaryTruncated === true
    );
    return [
      {
        ...item,
        ...(generatedImages.length === 0 ? {} : { generatedImages })
      }
    ];
  }

  #toolFailed(event: Extract<AgentEvent, { type: 'tool.failed' }>) {
    const state = this.#tools.get(event.callId);
    if (event.toolName === 'exec' && state?.commandOrigin !== undefined) {
      const command = this.#commands.get(state.commandOrigin);
      if (command !== undefined) {
        const error = {
          code: compactRunnerText(event.code, 80) || 'UNKNOWN',
          message: compactRunnerText(event.message ?? event.code, 1000)
        };
        command.status = 'FAILED';
        command.error = error;
        delete command.displayOutput;
        command.outputPreview = '';
        return [commandItem(command, 'FAILED')];
      }
    }
    if (event.toolName === 'apply_patch' && state?.structured === true)
      return [
        fileChangeItem(
          state?.itemId ?? itemId('tool', event.callId),
          'FAILED',
          patchChanges(event.data, event.resultExtensions)
        )
      ];
    return [
      genericToolItem(
        state?.itemId ?? itemId('tool', event.callId),
        event.toolName,
        event.code === 'MAR_AGENT_CANCELLED' || event.code === 'MAR_AGENT_EXECUTION_CANCELLED'
          ? 'CANCELLED'
          : 'FAILED',
        state?.input,
        event.message ?? event.code,
        event.code,
        event.truncated === true,
        agentOperationAction(event.toolName)
          ? mergeAgentOperationData(event.toolName, state?.presentationData, event.data)
          : event.data === undefined
            ? state?.presentationData
            : event.data,
        state?.subagentTitle,
        state?.subagentDetails,
        state?.sleepStartedAt,
        event.outputTruncation,
        state?.inputTruncated
      )
    ];
  }

  #codeModeToolResults(event: AgentEvent): readonly MarAgentNormalizedItem[] {
    const items: MarAgentNormalizedItem[] = [];
    for (const observation of codeModeToolResults(event)) {
      if (
        (observation.id !== undefined && this.#codeModeObservationIds.has(observation.id)) ||
        this.#codeModeSourceCallIds.has(observation.source.callId)
      )
        continue;

      const { toolName, input } = observation.source;
      let projected: readonly MarAgentNormalizedItem[] = [];
      if (toolName === 'apply_patch') {
        if (
          (typeof input !== 'string' && record(input) === undefined) ||
          !isApplyPatchObservationData(observation.result.data)
        )
          continue;
        projected = this.#normalizeObservedToolResult(event, observation, observation.result.data);
        if (observation.outcome === 'failed')
          projected = projected.map((item) =>
            item.kind === 'file_change' ? { ...item, status: 'FAILED' } : item
          );
      } else if (marAgentSubagentOperation(toolName) !== undefined) {
        if (
          !isSubagentToolInput(toolName, input) ||
          !isSubagentObservationData(observation.result.data, input)
        )
          continue;
        projected = this.#normalizeObservedToolResult(event, observation, observation.result.data);
      }

      if (projected.length === 0) continue;
      if (observation.id !== undefined) this.#codeModeObservationIds.add(observation.id);
      this.#codeModeSourceCallIds.add(observation.source.callId);
      // An execution/observation container does not own these public tool records.
      items.push(...projected);
    }
    return items;
  }

  #normalizeObservedToolResult(
    event: AgentEvent,
    observation: CodeModeToolResult,
    data: ApplyPatchObservationData | SubagentObservationData
  ): readonly MarAgentNormalizedItem[] {
    const { callId, toolName, input } = observation.source;
    const resultId = observation.id ?? 'call-' + callId;
    this.normalize({
      ...eventMetadata(event, resultId + ':started'),
      type: 'tool.started',
      toolName,
      callId,
      input
    });
    return this.normalize({
      ...eventMetadata(event, resultId + ':completed'),
      type: 'tool.completed',
      toolName,
      callId,
      summary: observation.result.content,
      ...(parseToolResultExtensions(observation.resultExtensions)
        ? { resultExtensions: parseToolResultExtensions(observation.resultExtensions)! }
        : {}),
      ...(observation.result.truncated === undefined
        ? {}
        : { truncated: observation.result.truncated }),
      data
    });
  }

  #subagentLifecycle(
    event: Extract<AgentEvent, { type: 'subagent.started' | 'subagent.completed' }>
  ): readonly MarAgentNormalizedItem[] {
    const eventDescription = record(event)?.description;
    const eventTitle = compactRunnerText(
      typeof eventDescription === 'string' ? eventDescription : '',
      500
    );
    if (eventTitle.length > 0) this.#subagentTitles.set(event.agentId, eventTitle);
    const details = mergeSubagentDetails(
      this.#subagentDetails.get(event.agentId),
      withoutSubagentLatestMessage(subagentDetails(event)) ?? {}
    );
    if (Object.keys(details).length > 0) this.#subagentDetails.set(event.agentId, details);
    return [];
  }
}

function permissionStopForToolEvent(
  event: Extract<AgentEvent, { type: 'tool.completed' | 'tool.failed' }>
): NonNullable<ExecutionResult['permissionStop']> | undefined {
  const direct = record(event)?.permissionStop;
  const cell = record(record(event)?.data)?.permissionStop;
  return (direct ?? cell) as NonNullable<ExecutionResult['permissionStop']> | undefined;
}

function withPermissionStop(
  items: readonly MarAgentNormalizedItem[],
  permissionStop: MarAgentNormalizedItem['permissionStop']
): readonly MarAgentNormalizedItem[] {
  return permissionStop === undefined ? items : items.map((item) => ({ ...item, permissionStop }));
}

function codeModeToolResults(event: AgentEvent): CodeModeToolResult[] {
  if (
    (event.type !== 'tool.completed' && event.type !== 'tool.failed') ||
    (event.toolName !== 'code_exec' && event.toolName !== 'code_exec_wait')
  )
    return [];
  const data = record(record(event)?.data);
  if (
    data === undefined ||
    typeof data.cellId !== 'string' ||
    data.cellId.trim().length === 0 ||
    (data.status !== 'running' &&
      data.status !== 'completed' &&
      data.status !== 'failed' &&
      data.status !== 'cancelled') ||
    ('cached' in data && typeof data.cached !== 'boolean')
  )
    return [];
  if (Object.hasOwn(data, 'calls')) return codeModeCallResults(data.calls);
  if (!Array.isArray(data.observations)) return [];
  return codeModeObservationResults(data.observations);
}

function codeModeCallResults(value: unknown): CodeModeToolResult[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const call = record(entry);
    const result = record(call?.result);
    if (
      call === undefined ||
      typeof call.callId !== 'string' ||
      call.callId.trim().length === 0 ||
      typeof call.toolName !== 'string' ||
      !isPersonalizedToolName(call.toolName) ||
      !('input' in call) ||
      (call.status !== 'completed' && call.status !== 'failed') ||
      result === undefined ||
      typeof result.content !== 'string' ||
      ('truncated' in result && typeof result.truncated !== 'boolean')
    )
      return [];
    return [
      {
        source: { callId: call.callId, toolName: call.toolName, input: call.input },
        outcome: call.status,
        resultExtensions: call.resultExtensions,
        result: {
          content: result.content,
          ...('data' in result ? { data: result.data } : {}),
          ...(typeof result.truncated === 'boolean' ? { truncated: result.truncated } : {})
        }
      }
    ];
  });
}

function codeModeObservationResults(value: unknown): CodeModeToolResult[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((value) => {
    const observation = record(value);
    const source = record(observation?.source);
    const result = record(observation?.result);
    if (
      observation?.type !== 'tool_result' ||
      typeof observation.id !== 'string' ||
      observation.id.trim().length === 0 ||
      source === undefined ||
      typeof source.callId !== 'string' ||
      source.callId.trim().length === 0 ||
      typeof source.toolName !== 'string' ||
      !isPersonalizedToolName(source.toolName) ||
      !('input' in source) ||
      (observation.outcome !== 'completed' && observation.outcome !== 'failed') ||
      result === undefined ||
      typeof result.content !== 'string' ||
      ('truncated' in result && typeof result.truncated !== 'boolean')
    )
      return [];
    return [
      {
        id: observation.id,
        source: { callId: source.callId, toolName: source.toolName, input: source.input },
        outcome: observation.outcome,
        result: {
          content: result.content,
          ...('data' in result ? { data: result.data } : {}),
          ...(typeof result.truncated === 'boolean' ? { truncated: result.truncated } : {})
        }
      }
    ];
  });
}

function isPersonalizedToolName(toolName: string): boolean {
  // Todo cards come only from native todo.updated events, never tool result snapshots.
  return toolName === 'apply_patch' || marAgentSubagentOperation(toolName) !== undefined;
}

function isApplyPatchObservationData(value: unknown): value is ApplyPatchObservationData {
  const data = record(value);
  const totals = record(data?.totals);
  return (
    data !== undefined &&
    Array.isArray(data.files) &&
    data.files.every((entry) => {
      const file = record(entry);
      return (
        file !== undefined &&
        typeof file.path === 'string' &&
        file.path.trim().length > 0 &&
        (file.targetPath === undefined ||
          (typeof file.targetPath === 'string' && file.targetPath.trim().length > 0)) &&
        (file.operation === 'added' ||
          file.operation === 'modified' ||
          file.operation === 'deleted' ||
          file.operation === 'moved') &&
        (file.operation !== 'moved' ||
          (typeof file.targetPath === 'string' && file.targetPath.trim().length > 0)) &&
        Number.isSafeInteger(file.addedLines) &&
        (file.addedLines as number) >= 0 &&
        Number.isSafeInteger(file.deletedLines) &&
        (file.deletedLines as number) >= 0
      );
    }) &&
    totals !== undefined &&
    Number.isSafeInteger(totals.files) &&
    (totals.files as number) >= 0 &&
    Number.isSafeInteger(totals.addedLines) &&
    (totals.addedLines as number) >= 0 &&
    Number.isSafeInteger(totals.deletedLines) &&
    (totals.deletedLines as number) >= 0
  );
}

function isSubagentToolInput(toolName: string, value: unknown): boolean {
  const input = record(value);
  if (input === undefined) return false;
  if (toolName === 'agent_start')
    return typeof input.description === 'string' && input.description.trim().length > 0;
  if (toolName === 'agent_wait')
    return (
      input.agentId === undefined || input.agentId === null || marAgentAgentId(input) !== undefined
    );
  if (toolName === 'agent_message')
    return (
      marAgentAgentId(input) !== undefined &&
      typeof input.message === 'string' &&
      input.message.trim().length > 0
    );
  return toolName === 'agent_cancel' && marAgentAgentId(input) !== undefined;
}

function isSubagentObservationData(
  value: unknown,
  input: unknown
): value is SubagentObservationData {
  const data = record(value);
  const inputAgentId = marAgentAgentId(input);
  return (
    data !== undefined &&
    typeof data.agentId === 'string' &&
    data.agentId.trim().length > 0 &&
    typeof data.description === 'string' &&
    data.description.trim().length > 0 &&
    (data.status === 'queued' ||
      data.status === 'running' ||
      data.status === 'completed' ||
      data.status === 'failed' ||
      data.status === 'cancelled' ||
      data.status === 'interrupted') &&
    (inputAgentId === undefined || data.agentId === inputAgentId)
  );
}

function eventMetadata(event: AgentEvent, eventId: string): EventMetadata {
  return {
    eventId,
    sequence: event.sequence,
    timestamp: event.timestamp,
    sessionId: event.sessionId,
    executionId: event.executionId,
    ...(event.turnId === undefined ? {} : { turnId: event.turnId })
  };
}

function itemId(kind: string, value: string) {
  return boundedConversationItemId(`mar-agent-${kind}`, value);
}

type MarAgentCompactLifecycleEvent = Extract<
  AgentEvent,
  { type: 'context.compacting' | 'context.compacted' | 'context.compact_failed' }
>;

function normalizeContextCompaction(
  event: MarAgentCompactLifecycleEvent,
  anchorItemId: string | undefined
): MarAgentNormalizedItem {
  const completed = event.type === 'context.compacted';
  const failed = event.type === 'context.compact_failed';
  const cancelled = failed && event.cancelled === true;
  const code =
    failed && event.code.trim().length > 0
      ? compactRunnerText(event.code, 80)
      : failed
        ? 'MAR_AGENT_COMPACT_FAILED'
        : undefined;
  return {
    itemId: itemId('compact', event.compactionId),
    kind: 'context_compaction',
    status: failed ? (cancelled ? 'CANCELLED' : 'FAILED') : completed ? 'COMPLETED' : 'IN_PROGRESS',
    payload: {
      phase: completed ? 'COMPLETED' : 'STARTED',
      summary: null,
      ...(event.async === undefined ? {} : { mode: event.async ? 'BACKGROUND' : 'BLOCKING' }),
      ...(event.type === 'context.compacting' && event.stage !== undefined
        ? { stage: event.stage }
        : {}),
      ...(anchorItemId === undefined ? {} : { anchorItemId }),
      ...(event.type === 'context.compacted' && event.retainedContext !== undefined
        ? { retainedContext: event.retainedContext }
        : {}),
      ...(code === undefined ? {} : { code })
    },
    merge: true
  };
}

function validCompactAnchor(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 && value.length <= 128 ? value : undefined;
}

function codeObservationOutput(
  data: Record<string, unknown> | undefined,
  summary: string | null
): ExecutionPresentation['execution']['output'] {
  const blocks: NonNullable<ExecutionPresentation['execution']['output']>[number][] = [];
  const add = (channel: 'TEXT' | 'STDOUT' | 'STDERR', text: unknown) => {
    if (typeof text !== 'string' || text.length === 0) return;
    const existing = blocks.find((block) => block.channel === channel);
    if (existing) existing.text += `\n${text}`;
    else blocks.push({ channel, text });
  };
  const streams = (value: Record<string, unknown> | undefined) => {
    const display = record(value?.displayOutput) ?? value;
    if (typeof display?.stdout !== 'string' && typeof display?.stderr !== 'string') return false;
    add('STDOUT', display?.stdout);
    add('STDERR', display?.stderr);
    return true;
  };
  if (streams(data)) return blocks;
  if (Array.isArray(data?.observations)) {
    for (const entry of data.observations) {
      const observation = record(entry);
      if (observation?.type === 'value') add('TEXT', observation.value);
      const result = record(observation?.result);
      const source = record(observation?.source);
      if (observation?.type !== 'tool_result') continue;
      if (
        (source?.toolName === 'exec' || source?.toolName === 'exec_wait') &&
        streams(record(result?.data))
      )
        continue;
      add('TEXT', result?.content);
    }
    return blocks.length ? blocks : [{ channel: 'TEXT', text: '' }];
  }
  return summary === null ? undefined : [{ channel: 'TEXT', text: summary }];
}

function codeExecutionError(
  data: Record<string, unknown> | undefined
): ExecutionPresentation['execution']['error'] {
  const error = record(data?.error);
  if (typeof error?.code !== 'string' || !error.code || typeof error.message !== 'string')
    return undefined;
  return {
    code: compactRunnerText(error.code, 80),
    message: compactRunnerText(error.message, 1000)
  };
}

function mergeAgentOperationData(toolName: string, previous: unknown, current: unknown): unknown {
  if (!agentOperationAction(toolName)) return current;
  const before = agentOperationPresentationSchema.safeParse(record(previous)?.agentOperation);
  if (!before.success || before.data.action !== agentOperationAction(toolName)) return current;
  const after = agentOperationPresentationSchema.safeParse(record(current)?.agentOperation);
  if (!after.success || after.data.action !== before.data.action) {
    return { ...record(current), agentOperation: before.data };
  }
  return {
    ...record(current),
    agentOperation: {
      ...after.data,
      ...(after.data.detail === undefined && before.data.detail !== undefined
        ? { detail: before.data.detail }
        : {}),
      targets: (after.data.action === 'WAIT'
        ? [
            ...after.data.targets,
            ...before.data.targets.filter(
              (target) =>
                !after.data.targets.some((candidate) => candidate.agentId === target.agentId)
            )
          ]
        : after.data.targets
      ).map((target) => {
        const resolved = before.data.targets.find(
          (candidate) => candidate.agentId === target.agentId
        );
        const current = after.data.targets.find(
          (candidate) => candidate.agentId === target.agentId
        );
        return {
          agentId: target.agentId,
          ...(resolved?.sessionId ? { sessionId: resolved.sessionId } : {}),
          ...(resolved?.title ? { title: resolved.title } : {}),
          ...current
        };
      })
    }
  };
}

function genericToolItem(
  id: string,
  toolName: string,
  status: MarAgentNormalizedItem['status'],
  input: unknown,
  outputSummary: string | null = null,
  errorCode: string | null = null,
  truncated = false,
  output?: unknown,
  subagentTitle?: string,
  knownSubagentDetails?: SubagentDetails,
  sleepStartedAt?: string,
  outputTruncation?: 'HEAD' | 'SOURCE',
  inputTruncated = false,
  summaryTruncated = false
): MarAgentNormalizedItem {
  if (toolName === 'code_exec') {
    const code = typeof input === 'string' ? input : record(input)?.code;
    const source =
      typeof code === 'string' ? code : compactRunnerValue(input, 10_000).text || toolName;
    const resultData = record(output);
    const codeOutput = codeObservationOutput(resultData, null);
    const resultError = codeExecutionError(resultData);
    const preview =
      errorCode === null
        ? (outputSummary ?? '')
        : [errorCode, outputSummary].filter(Boolean).join(': ');
    const item = commandItem(
      {
        itemId: id,
        command: compactRunnerText(source, 10_000),
        cwd: null,
        outputPreview: '',
        exitCode: null,
        truncated: truncated || source.length > 10_000 || preview.length > 10_000
      },
      status,
      'Code execution',
      {
        kind: 'CODE',
        ...(source.length > 10_000 || inputTruncated || outputTruncation !== undefined
          ? {
              truncation: {
                ...(source.length > 10_000 || inputTruncated ? { input: true } : {}),
                ...(outputTruncation === undefined ? {} : { output: outputTruncation })
              }
            }
          : {}),
        ...(errorCode === null
          ? resultError === undefined
            ? {}
            : { error: resultError }
          : {
              error: {
                code: compactRunnerText(errorCode, 80),
                message: compactRunnerText(outputSummary ?? '', 1000)
              }
            }),
        ...(codeOutput === undefined ? {} : { output: codeOutput })
      },
      toolName
    );
    if (codeOutput === undefined && errorCode === null && outputSummary !== null) {
      item.payload.outputSummary = compactRunnerText(outputSummary, 10_000);
      if (summaryTruncated || outputSummary.length > 10_000)
        item.payload.outputSummaryTruncated = true;
    }
    return item;
  }
  if (toolName === 'code_exec_wait' || toolName === 'exec_wait') {
    const inputRecord = record(input);
    const resultData = record(output);
    const display = execDisplayOutput(resultData?.displayOutput);
    const legacyBlocks = [
      ...(typeof resultData?.stdout === 'string'
        ? [{ channel: 'STDOUT' as const, text: resultData.stdout }]
        : []),
      ...(typeof resultData?.stderr === 'string'
        ? [{ channel: 'STDERR' as const, text: resultData.stderr }]
        : [])
    ];
    const codeOutput =
      toolName === 'code_exec_wait' ? codeObservationOutput(resultData, null) : undefined;
    const resultError = toolName === 'code_exec_wait' ? codeExecutionError(resultData) : undefined;
    const action = typeof inputRecord?.action === 'string' ? inputRecord.action : 'poll';
    const inputSummary = compactRunnerValue(input, 10_000);
    const item = commandItem(
      {
        itemId: id,
        command: '',
        cwd: null,
        outputPreview: '',
        exitCode: typeof resultData?.exitCode === 'number' ? resultData.exitCode : null,
        truncated: truncated || inputSummary.truncated
      },
      status,
      toolName === 'code_exec_wait' ? 'Code execution wait' : 'Command wait',
      {
        kind: 'CONTROL',
        toolName,
        action: compactRunnerText(action, 128),
        ...(typeof inputRecord?.processId === 'string' || typeof inputRecord?.cellId === 'string'
          ? {
              targetId: compactRunnerText(String(inputRecord.processId ?? inputRecord.cellId), 256)
            }
          : {}),
        ...executionSource(resultData?.executionSource),
        ...(display === undefined
          ? {}
          : {
              output: [
                { channel: 'STDOUT' as const, text: display.stdout },
                { channel: 'STDERR' as const, text: display.stderr }
              ]
            }),
        ...(display === undefined && legacyBlocks.length > 0 ? { output: legacyBlocks } : {}),
        ...(codeOutput === undefined ? {} : { output: codeOutput }),
        ...(inputTruncated ||
        (typeof inputRecord?.data === 'string' && inputRecord.data.length > 10_000) ||
        outputTruncation !== undefined ||
        (display !== undefined && (display.stdoutDroppedBytes || display.stderrDroppedBytes))
          ? {
              truncation: {
                ...(inputTruncated ||
                (typeof inputRecord?.data === 'string' && inputRecord.data.length > 10_000)
                  ? { input: true }
                  : {}),
                ...(outputTruncation !== undefined
                  ? { output: outputTruncation }
                  : display !== undefined &&
                      (display.stdoutDroppedBytes || display.stderrDroppedBytes)
                    ? { output: 'HEAD' as const }
                    : {})
              }
            }
          : {}),
        ...(errorCode === null
          ? resultError === undefined
            ? {}
            : { error: resultError }
          : {
              error: {
                code: compactRunnerText(errorCode, 80),
                message: compactRunnerText(outputSummary ?? '', 1000)
              }
            })
      }
    );
    if (
      display === undefined &&
      legacyBlocks.length === 0 &&
      codeOutput === undefined &&
      errorCode === null &&
      outputSummary !== null
    ) {
      item.payload.outputSummary = compactRunnerText(outputSummary, 10_000);
      if (summaryTruncated || outputSummary.length > 10_000)
        item.payload.outputSummaryTruncated = true;
    }
    return item;
  }
  const subagent = marAgentSubagentProjection(
    toolName,
    input,
    output,
    subagentTitle,
    knownSubagentDetails
  );
  const agentOperation = agentOperationPresentation(toolName, input, output);
  if (
    agentOperation &&
    record(output)?.agentOperation === undefined &&
    typeof subagent?.subagentId === 'string'
  ) {
    agentOperation.targets = [
      {
        agentId: subagent.subagentId,
        ...(typeof subagent.subagentSessionId === 'string'
          ? { sessionId: subagent.subagentSessionId }
          : {}),
        ...(typeof subagent.title === 'string' ? { title: subagent.title } : {})
      }
    ];
  }
  const toolCategory = isImageGenerationTool(toolName) ? 'IMAGE_GENERATION' : undefined;
  const readOutput =
    toolName === 'read' && status === 'COMPLETED' && outputSummary !== null
      ? publicToolOutput(outputSummary, summaryTruncated ? 'SOURCE' : outputTruncation)
      : undefined;
  const presentation = projectToolPresentation(
    toolName,
    input,
    output,
    sleepStartedAt,
    outputSummary,
    readOutput
  );
  const inputSummary = compactRunnerValue(input, 10_000);
  return {
    itemId: id,
    kind: 'tool_call',
    status,
    payload: {
      namespace: 'mar-agent',
      toolName: compactRunnerText(toolName, 128) || 'unknown',
      title: compactRunnerText(toolName, 500) || 'unknown',
      inputSummary: inputSummary.text || null,
      outputSummary:
        typeof output === 'string' || errorCode !== null || readOutput ? null : outputSummary,
      ...(readOutput
        ? { output: readOutput }
        : typeof output === 'string'
          ? { output: publicToolOutput(output, outputTruncation) }
          : {}),
      ...(typeof output !== 'string' && outputSummary !== null && summaryTruncated
        ? { outputSummaryTruncated: true }
        : {}),
      progressLabel: status === 'IN_PROGRESS' ? 'Running' : null,
      errorCode: errorCode === null ? null : compactRunnerText(errorCode, 80),
      ...(errorCode !== null && outputSummary
        ? { errorMessage: compactRunnerText(outputSummary, 1000) }
        : {}),
      ...(inputTruncated || inputSummary.truncated ? { inputTruncated: true } : {}),
      ...(toolCategory === undefined ? {} : { toolCategory }),
      ...(presentation === undefined ? {} : { toolPresentation: presentation }),
      ...(agentOperation === undefined ? {} : { agentOperation }),
      ...subagent
    },
    merge: true
  };
}

function projectToolPresentation(
  toolName: string,
  input: unknown,
  output: unknown,
  startedAt?: string,
  readSummary?: string | null,
  readOutput?: ReturnType<typeof publicToolOutput>
): ToolPresentation | undefined {
  if (toolName === 'read') {
    const reads = record(input)?.reads;
    const paths = (Array.isArray(reads) ? reads : [])
      .flatMap((entry) => {
        const path = record(entry)?.path;
        return typeof path === 'string' && path.length > 0 ? [compactRunnerText(path, 4096)] : [];
      })
      .slice(0, 16);
    const data = record(output);
    if (
      data?.mode !== 'batch' ||
      !Array.isArray(data.results) ||
      readSummary == null ||
      !readOutput
    )
      return { kind: 'READ', paths };
    const text = readOutput.blocks.find((block) => block.channel === 'TEXT')?.text ?? '';
    const removed = readSummary.length - text.length;
    const results = data.results.slice(0, 16).flatMap((value) => {
      const item = record(value);
      if (typeof item?.path !== 'string' || !item.path) return [];
      const range = record(item.contentRange);
      const start = range?.start;
      const end = range?.end;
      const validRange =
        typeof start === 'number' &&
        Number.isSafeInteger(start) &&
        start >= 0 &&
        typeof end === 'number' &&
        Number.isSafeInteger(end) &&
        start <= end &&
        end <= readSummary.length &&
        (end > removed || (start === end && start >= removed));
      const error = record(item.error);
      return [
        {
          path: compactRunnerText(item.path, 4096),
          ...(item.startLine === undefined ? {} : { startLine: item.startLine }),
          ...(item.endLine === undefined ? {} : { endLine: item.endLine }),
          ...(item.empty === true ? { empty: true as const } : {}),
          ...(typeof error?.code === 'string' && typeof error.message === 'string'
            ? {
                error: {
                  code: compactRunnerText(error.code, 80),
                  message: compactRunnerText(error.message, 1000)
                }
              }
            : {}),
          ...(validRange
            ? {
                contentRange: {
                  channel: 'TEXT',
                  start: Math.max(start, removed) - removed,
                  end: end - removed
                }
              }
            : {})
        }
      ];
    });
    const parsed = toolPresentationSchema.safeParse({ kind: 'READ', paths, results });
    return parsed.success ? parsed.data : { kind: 'READ', paths };
  }
  const args = record(input) ?? {};
  const data = record(output) ?? {};
  if (toolName === 'view_image') {
    const parsed = toolPresentationSchema.safeParse({
      kind: 'IMAGE_VIEW',
      path: typeof args.path === 'string' ? compactRunnerText(args.path, 4096) : undefined,
      resourceId:
        typeof args.resourceId === 'string' ? compactRunnerText(args.resourceId, 512) : undefined,
      resize: args.resize,
      mimeType: data.mimeType,
      width: data.width,
      height: data.height,
      sourceWidth: data.sourceWidth,
      sourceHeight: data.sourceHeight,
      region: data.region
    });
    return parsed.success
      ? (Object.fromEntries(
          Object.entries(parsed.data).filter(([, value]) => value !== undefined)
        ) as ToolPresentation)
      : { kind: 'IMAGE_VIEW' };
  }
  if (toolName === 'tool_search') {
    const parsed = toolPresentationSchema.safeParse({
      kind: 'TOOL_SEARCH',
      ...(typeof args.query === 'string' ? { query: compactRunnerText(args.query, 500) } : {}),
      ...(data.tools === undefined ? {} : { tools: data.tools })
    });
    return parsed.success ? parsed.data : { kind: 'TOOL_SEARCH' };
  }
  if (toolName === 'smart_compact')
    return { kind: 'COMPACT_REQUEST', ...(data.status === 'accepted' ? { accepted: true } : {}) };
  const category =
    toolName === 'web_search'
      ? 'WEB_SEARCH'
      : toolName === 'web_fetch'
        ? 'WEB_FETCH'
        : toolName === 'skill'
          ? 'SKILL'
          : toolName === 'sleep'
            ? 'SLEEP'
            : undefined;
  if (category === undefined) return undefined;
  // A provider-hosted search tool can report a page-read action under its native name.
  const kind =
    category === 'WEB_SEARCH' && data.hostedToolKind === 'WEB_FETCH' ? 'WEB_FETCH' : category;
  const text = (value: unknown, limit: number) =>
    typeof value === 'string' ? compactRunnerText(value, limit) : undefined;
  const candidate =
    kind === 'WEB_SEARCH'
      ? { ...data, kind, query: text(data.query ?? args.query, 500) }
      : kind === 'WEB_FETCH'
        ? {
            ...data,
            kind,
            requestUrl: text(args.url, 8192),
            url: text(data.url, 8192),
            mode: data.mode ?? args.mode
          }
        : kind === 'SKILL'
          ? { ...data, kind, name: text(data.name ?? args.name, 128) }
          : { ...data, kind, durationMs: data.durationMs ?? args.durationMs, startedAt };
  const parsed = toolPresentationSchema.safeParse(candidate);
  return parsed.success ? parsed.data : { kind };
}

function execDisplayOutput(value: unknown): CommandState['displayOutput'] {
  const data = record(value);
  if (
    typeof data?.stdout !== 'string' ||
    typeof data.stderr !== 'string' ||
    typeof data.stdoutDroppedBytes !== 'number' ||
    !Number.isSafeInteger(data.stdoutDroppedBytes) ||
    data.stdoutDroppedBytes < 0 ||
    typeof data.stderrDroppedBytes !== 'number' ||
    !Number.isSafeInteger(data.stderrDroppedBytes) ||
    data.stderrDroppedBytes < 0
  )
    return undefined;
  return {
    stdout: data.stdout,
    stderr: data.stderr,
    stdoutDroppedBytes: data.stdoutDroppedBytes,
    stderrDroppedBytes: data.stderrDroppedBytes
  };
}

function executionSource(value: unknown): Pick<ExecutionPresentation['execution'], 'source'> {
  const source = record(value);
  if (
    !source ||
    (source.kind !== 'SHELL' && source.kind !== 'CODE') ||
    typeof source.text !== 'string'
  )
    return {};
  return {
    source: {
      kind: source.kind,
      text: compactRunnerText(source.text, 10_000),
      ...(typeof source.cwd === 'string' ? { cwd: compactRunnerText(source.cwd, 10_000) } : {}),
      truncated:
        source.truncated === true ||
        source.text.length > 10_000 ||
        (typeof source.cwd === 'string' && source.cwd.length > 10_000)
    }
  };
}

function commandItem(
  command: Pick<
    CommandState,
    'itemId' | 'command' | 'cwd' | 'outputPreview' | 'exitCode' | 'truncated'
  > &
    Partial<Pick<CommandState, 'displayOutput' | 'error' | 'inputTruncated' | 'outputTruncation'>>,
  status: MarAgentNormalizedItem['status'],
  title?: string,
  execution?: ExecutionPresentation['execution'],
  toolName = 'exec'
): MarAgentNormalizedItem {
  const display = command.displayOutput;
  const detail = execution ?? {
    kind: 'SHELL' as const,
    ...(command.error === undefined ? {} : { error: command.error }),
    ...(!command.inputTruncated &&
    !(display && (display.stdoutDroppedBytes > 0 || display.stderrDroppedBytes > 0))
      ? {}
      : {
          truncation: {
            ...(command.inputTruncated ? { input: true } : {}),
            ...(display && (display.stdoutDroppedBytes > 0 || display.stderrDroppedBytes > 0)
              ? { output: 'HEAD' as const }
              : {})
          }
        }),
    ...(display === undefined
      ? {}
      : {
          output: [
            { channel: 'STDOUT' as const, text: display.stdout },
            { channel: 'STDERR' as const, text: display.stderr }
          ]
        })
  };
  const { output: detailOutput, truncation, ...executionMetadata } = detail;
  const blocks =
    detailOutput ??
    (!detail.error && command.outputPreview
      ? [{ channel: 'COMBINED' as const, text: command.outputPreview }]
      : undefined);
  const output =
    blocks === undefined
      ? undefined
      : boundToolOutput(blocks, command.outputTruncation ?? truncation?.output);
  return {
    itemId: command.itemId,
    kind: 'command_execution',
    status,
    payload: {
      ...(title === undefined ? {} : { title }),
      command: command.command,
      cwd: command.cwd,
      ...(output === undefined ? {} : { output }),
      exitCode: command.exitCode,
      durationMs: null,
      toolPresentation: {
        kind: 'EXECUTION',
        execution: {
          toolName,
          ...executionMetadata,
          ...(truncation?.input ? { truncation: { input: true } } : {})
        }
      }
    },
    merge: true
  };
}

function applyCommandResult(
  command: CommandState,
  result: NonNullable<ReturnType<typeof execResult>>
) {
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
  command.outputPreview = compactRunnerText(output, 10_000);
  command.truncated = result.truncated || output.length > 10_000;
  command.exitCode = result.exitCode ?? null;
}

function fileChangeItem(
  id: string,
  status: MarAgentNormalizedItem['status'],
  changes: readonly Record<string, unknown>[]
): MarAgentNormalizedItem {
  return { itemId: id, kind: 'file_change', status, payload: { changes }, merge: true };
}

function patchChanges(value: unknown, extensions?: unknown): Record<string, unknown>[] {
  const evidence = (parseToolResultExtensions(extensions) ?? []).flatMap(
    (extension) => extension.entries
  );
  if (evidence.length)
    return evidence.map((entry) => ({
      path: entry.path,
      change: entry.change.toUpperCase(),
      additions: entry.additions,
      deletions: entry.deletions,
      changeId: entry.changeId,
      diff:
        entry.diff.status === 'available'
          ? { ...entry.diff, source: 'TOOL_CHANGE' }
          : {
              ...entry.diff,
              reason: entry.diff.reason === 'unsupported-content' ? 'binary' : entry.diff.reason
            }
    }));
  const files = record(value)?.files;
  if (!Array.isArray(files)) return [];
  return files.flatMap((entry) => {
    const file = record(entry);
    if (typeof file?.path !== 'string') return [];
    const path = compactRunnerText(file.path, 4_096);
    if (path.length === 0) return [];
    const additions = nonnegativeInteger(file.addedLines);
    const deletions = nonnegativeInteger(file.deletedLines);
    if (file.operation === 'moved' && typeof file.targetPath === 'string') {
      const targetPath = compactRunnerText(file.targetPath, 4_096);
      if (targetPath.length === 0) return [change(path, 'MODIFIED', additions, deletions)];
      return [
        change(path, 'DELETED', additions, deletions),
        change(targetPath, 'ADDED', additions, deletions)
      ];
    }
    const operation =
      file.operation === 'added' ? 'ADDED' : file.operation === 'deleted' ? 'DELETED' : 'MODIFIED';
    return [change(path, operation, additions, deletions)];
  });
}

function change(
  path: string,
  operation: string,
  additions: number | null,
  deletions: number | null
) {
  return { path, change: operation, additions, deletions };
}

function execResult(
  value: unknown,
  summary?: string,
  eventTruncated = false
):
  | {
      status: 'running' | 'completed' | 'cancelled';
      processId?: string;
      stdout: string;
      stderr: string;
      exitCode?: number | null;
      truncated: boolean;
      cached?: boolean;
    }
  | undefined {
  const data = record(value);
  const summaryData = structuredRecord(summary);
  const persistedOutputOmitted =
    typeof data?.stdout !== 'string' && typeof data?.stderr !== 'string';
  const structuredSummaryIncomplete =
    persistedOutputOmitted &&
    typeof summary === 'string' &&
    summary.trim().startsWith('{') &&
    summaryData === undefined;
  const status =
    data?.status === 'running' || data?.status === 'completed' || data?.status === 'cancelled'
      ? data.status
      : summaryData?.status === 'running' ||
          summaryData?.status === 'completed' ||
          summaryData?.status === 'cancelled'
        ? summaryData.status
        : undefined;
  if (status === undefined) return undefined;
  const processId =
    typeof data?.processId === 'string'
      ? data.processId
      : typeof summaryData?.processId === 'string'
        ? summaryData.processId
        : undefined;
  const stdout =
    typeof data?.stdout === 'string'
      ? data.stdout
      : typeof summaryData?.stdout === 'string'
        ? summaryData.stdout
        : '';
  const stderr =
    typeof data?.stderr === 'string'
      ? data.stderr
      : typeof summaryData?.stderr === 'string'
        ? summaryData.stderr
        : '';
  const exitCode =
    typeof data?.exitCode === 'number' || data?.exitCode === null
      ? data.exitCode
      : typeof summaryData?.exitCode === 'number' || summaryData?.exitCode === null
        ? summaryData.exitCode
        : undefined;
  return {
    status,
    ...(processId === undefined ? {} : { processId }),
    stdout,
    stderr,
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(data?.cached === true || summaryData?.cached === true ? { cached: true } : {}),
    truncated:
      eventTruncated ||
      (execDisplayOutput(data?.displayOutput) === undefined && data?.truncated === true) ||
      (data === undefined && summaryData?.truncated === true) ||
      structuredSummaryIncomplete
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function marAgentSubagentProjection(
  toolName: string,
  input: unknown,
  output: unknown,
  knownTitle?: string,
  knownDetails?: SubagentDetails
): Record<string, unknown> | undefined {
  const operation = marAgentSubagentOperation(toolName);
  if (operation === undefined) return undefined;
  const inputData = structuredRecord(input);
  const controlOutput = matchingSubagentControlOutput(toolName, input, output);
  const outputData = structuredRecord(controlOutput);
  const details = mergeSubagentDetails(knownDetails, subagentDetails(controlOutput));
  const title = compactRunnerText(
    knownTitle ??
      (typeof outputData?.description === 'string'
        ? outputData.description
        : operation === 'START' && typeof inputData?.description === 'string'
          ? inputData.description
          : operation === 'START' && typeof inputData?.title === 'string'
            ? inputData.title
            : ''),
    500
  );
  return {
    subagentOperation: operation,
    ...(operation === 'STATUS' ? { subagentWait: inputData?.waitMs !== 0 } : {}),
    subagentId: marAgentAgentId(input) ?? marAgentAgentId(controlOutput) ?? null,
    ...(typeof outputData?.productSessionId === 'string' &&
    outputData.productSessionId === marAgentAgentId(controlOutput)
      ? { subagentSessionId: outputData.productSessionId }
      : {}),
    ...(title.length === 0 ? {} : { title }),
    ...subagentPayload(details),
    ...(typeof details.latestMessage?.text === 'string'
      ? { outputSummary: null, output: undefined }
      : typeof outputData?.errorMessage === 'string'
        ? {
            outputSummary: null,
            output: publicToolOutput(outputData.errorMessage)
          }
        : {}),
    ...(typeof outputData?.errorCode === 'string'
      ? { errorCode: compactRunnerText(outputData.errorCode, 80) }
      : {})
  };
}

function matchingSubagentControlOutput(toolName: string, input: unknown, output: unknown): unknown {
  const operation = marAgentSubagentOperation(toolName);
  if (operation === undefined) return undefined;
  if (toolName === 'agent_wait') {
    const targets = structuredRecord(input)?.agentIds;
    if (Array.isArray(targets) && targets.length !== 1) return undefined;
    const agents = structuredRecord(output)?.agents;
    if (Array.isArray(agents)) output = agents.length === 1 ? agents[0] : undefined;
  }
  const outputAgentId = marAgentAgentId(output);
  if (operation === 'START') return outputAgentId === undefined ? undefined : output;
  const inputAgentId = marAgentAgentId(input);
  if (inputAgentId === undefined) return outputAgentId === undefined ? undefined : output;
  return outputAgentId === inputAgentId ? output : undefined;
}

function isMarAgentControlTool(toolName: string): boolean {
  return marAgentSubagentOperation(toolName) !== undefined;
}

function marAgentSubagentOperation(
  toolName: string
): 'START' | 'STATUS' | 'MESSAGE' | 'CANCEL' | undefined {
  if (toolName === 'agent_start') return 'START';
  if (toolName === 'agent_wait') return 'STATUS';
  if (toolName === 'agent_send' || toolName === 'agent_message') return 'MESSAGE';
  if (toolName === 'agent_stop' || toolName === 'agent_cancel') return 'CANCEL';
  return undefined;
}

function subagentDetails(value: unknown): SubagentDetails {
  const data = structuredRecord(value);
  if (data === undefined) return {};
  const modelId = boundedText(data.modelId, 128);
  const modelName = boundedText(data.modelName, 128);
  const reasoningEffort = isReasoningEffort(data.reasoningEffort)
    ? data.reasoningEffort
    : undefined;
  const latestMessage = normalizedSubagentLatestMessage(data.latestMessage);
  return {
    ...(modelId === undefined ? {} : { modelId }),
    ...(modelName === undefined ? {} : { modelName }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(latestMessage === undefined ? {} : { latestMessage })
  };
}

function mergeSubagentDetails(
  current: SubagentDetails | undefined,
  update: SubagentDetails
): SubagentDetails {
  return {
    ...(current ?? {}),
    ...update
  };
}

function withoutSubagentLatestMessage(
  details: SubagentDetails | undefined
): SubagentDetails | undefined {
  if (details?.latestMessage === undefined) return details;
  const { latestMessage: _latestMessage, ...withoutLatestMessage } = details;
  return withoutLatestMessage;
}

function subagentPayload(details: SubagentDetails): Record<string, unknown> {
  return {
    ...(details.modelId === undefined ? {} : { subagentModelId: details.modelId }),
    ...(details.modelName === undefined ? {} : { subagentModelName: details.modelName }),
    ...(details.reasoningEffort === undefined
      ? {}
      : { subagentReasoningEffort: details.reasoningEffort }),
    ...(details.latestMessage === undefined ? {} : { subagentLatestMessage: details.latestMessage })
  };
}

function normalizedSubagentLatestMessage(value: unknown): Record<string, unknown> | undefined {
  const data = record(value);
  if (
    data === undefined ||
    typeof data.itemId !== 'string' ||
    typeof data.turnId !== 'string' ||
    (data.phase !== 'commentary' && data.phase !== 'final_answer') ||
    typeof data.text !== 'string' ||
    typeof data.timestamp !== 'string'
  )
    return undefined;
  const text = truncateCharacters(data.text, 10_000);
  return {
    itemId: compactRunnerText(data.itemId, 128),
    turnId: compactRunnerText(data.turnId, 128),
    phase: data.phase,
    text,
    timestamp: data.timestamp,
    truncated: data.truncated === true || text !== data.text
  };
}

function boundedText(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = compactRunnerText(value.trim(), maximumLength);
  return text.length === 0 ? undefined : text;
}

function isReasoningEffort(value: unknown): value is string {
  return (
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max' ||
    value === 'ultra'
  );
}

function truncateCharacters(value: string, maximumCharacters: number): string {
  const characters = [...value];
  return characters.length <= maximumCharacters
    ? value
    : characters.slice(0, maximumCharacters).join('');
}

function boundedToolSummary(value: string): string {
  const maximumCodeUnits = 10_000;
  if (value.length <= maximumCodeUnits) return value;
  let end = maximumCodeUnits - 1;
  const lastIncluded = value.charCodeAt(end - 1);
  const firstExcluded = value.charCodeAt(end);
  if (
    lastIncluded >= 0xd800 &&
    lastIncluded <= 0xdbff &&
    firstExcluded >= 0xdc00 &&
    firstExcluded <= 0xdfff
  )
    end--;
  return `${value.slice(0, end)}…`;
}

function marAgentAgentId(value: unknown): string | undefined {
  const data = structuredRecord(value);
  if (data === undefined) return undefined;
  const direct = boundedId(data.agentId);
  if (direct !== undefined) return direct;
  if (Array.isArray(data.agentIds))
    return data.agentIds.length === 1 ? boundedId(data.agentIds[0]) : undefined;
  for (const key of ['data', 'result', 'output']) {
    const nested = marAgentAgentId(data[key]);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function structuredRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return record(value);
  const text = value.trim();
  if (!text.startsWith('{')) return undefined;
  try {
    return record(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function boundedId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 128 ? normalized : undefined;
}

function nonnegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function isImageGenerationTool(toolName: string): boolean {
  return toolName === 'codex_image_gen' || toolName === 'byted_ark_image_gen';
}

function imageArtifacts(
  event: Extract<AgentEvent, { type: 'tool.completed' }>
): MarAgentGeneratedImageArtifact[] {
  if (!isImageGenerationTool(event.toolName) || !Array.isArray(event.artifacts)) return [];
  return event.artifacts.flatMap((value) => {
    const artifact = record(value);
    const fileName = typeof artifact?.fileName === 'string' ? artifact.fileName.trim() : '';
    const name = typeof artifact?.name === 'string' ? compactRunnerText(artifact.name, 255) : '';
    const byteSize = nonnegativeInteger(artifact?.byteSize);
    if (
      artifact?.kind !== 'image' ||
      artifact.mimeType !== 'image/png' ||
      typeof artifact.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/iu.test(artifact.sha256) ||
      name.length === 0 ||
      byteSize === null ||
      byteSize === 0 ||
      fileName.length === 0 ||
      fileName.length > 255 ||
      fileName === '.' ||
      fileName === '..' ||
      fileName.includes('/') ||
      fileName.includes('\\') ||
      !fileName.toLocaleLowerCase().endsWith('.png')
    )
      return [];
    return [{ name, mime: 'image/png' as const, byteSize, fileName }];
  });
}
