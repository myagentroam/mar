import { AgentError } from '../error.js';
import { LocalFileAccess } from './local-file-access.js';
import {
  directLocalProcessExecutor,
  signalProcessTree,
  type LocalProcessExecutor
} from './local-process-executor.js';
import {
  ApplyPatchTool,
  applyPatchToolInput,
  applyPatchToolDefinition
} from '../tools/local/apply-patch.js';
import {
  CodeModeTool,
  codeModeToolDefinition,
  codeExecWaitToolDefinition
} from '../tools/code-mode/index.js';
import { normalizeToolInput } from '../tools/input.js';
import type { CodeModeEngineFactory } from '../tools/code-mode/engine.js';
import type { ToolCall, ToolExecutionContext, ToolExecutionResult } from '../tools/contracts.js';
import {
  execToolInput,
  execToolDefinition,
  execWaitToolDefinition,
  formatExecResult
} from '../tools/local/exec.js';
import { ExecTool } from './local-exec-tool.js';
import {
  ReadTool,
  formatBatchReadOutput,
  formatReadEventOutput,
  readToolDefinition
} from '../tools/local/read.js';
import { WorkspacePathResolver, type WorkspacePathMount } from '../tools/shared/path-resolver.js';
import { ViewImageTool, viewImageToolDefinition } from '../tools/local/view-image.js';
import type { ExtensionOperationContext } from '../extensions/operation.js';

type LocalToolContext = Omit<ToolExecutionContext, 'executionId'> & {
  readonly executionId?: string;
  readonly operation?: ExtensionOperationContext;
};

const definitions = [
  readToolDefinition,
  viewImageToolDefinition,
  applyPatchToolDefinition,
  execToolDefinition,
  execWaitToolDefinition,
  codeModeToolDefinition,
  codeExecWaitToolDefinition
];

function executionContext(context: LocalToolContext): ToolExecutionContext {
  if (!context.executionId)
    throw new AgentError('MAR_AGENT_TOOL_NOT_AVAILABLE', 'Tool requires a real Execution.');
  return { ...context, executionId: context.executionId };
}

export class LocalToolRegistry {
  readonly processes: import('../extensions/processes.js').ExtensionProcessesBackend;
  readonly files: LocalFileAccess;
  readonly #exec: ExecTool;
  readonly #code: CodeModeTool;
  readonly #handlers: ReadonlyMap<
    string,
    (arguments_: unknown, context: LocalToolContext) => Promise<ToolExecutionResult>
  >;

  constructor(
    workspace: string,
    environment: NodeJS.ProcessEnv = process.env,
    shell?: string,
    options: {
      processExecutor?: LocalProcessExecutor;
      codeModeEngineFactory?: CodeModeEngineFactory;
      restrictPaths?: boolean;
      workspaceWritable?: boolean;
      pathMounts?: readonly WorkspacePathMount[];
    } = {}
  ) {
    const paths = new WorkspacePathResolver(workspace, {
      ...(options.restrictPaths === undefined ? {} : { restrictPaths: options.restrictPaths }),
      ...(options.workspaceWritable === undefined
        ? {}
        : { rootWritable: options.workspaceWritable }),
      ...(options.pathMounts === undefined ? {} : { mounts: options.pathMounts })
    });
    this.files = new LocalFileAccess(paths);
    const read = new ReadTool(paths);
    const viewImage = new ViewImageTool(paths);
    const patch = new ApplyPatchTool(paths);
    this.#exec = new ExecTool(
      paths,
      undefined,
      undefined,
      environment,
      shell,
      options.processExecutor
    );
    this.processes = { spawn: (input, call) => this.#exec.spawn(input, call) };
    this.#code = new CodeModeTool(
      paths,
      environment,
      options.processExecutor ?? directLocalProcessExecutor,
      signalProcessTree,
      options.codeModeEngineFactory
    );
    this.#handlers = new Map<
      string,
      (arguments_: unknown, context: LocalToolContext) => Promise<ToolExecutionResult>
    >([
      [
        'code_exec',
        (arguments_, context) => this.#code.start(arguments_, executionContext(context))
      ],
      [
        'code_exec_wait',
        (arguments_, context) => this.#code.wait(arguments_, executionContext(context))
      ],
      [
        'read',
        async (arguments_: unknown, context: LocalToolContext) => {
          const result = await read.execute(
            arguments_ as Parameters<ReadTool['execute']>[0],
            context.signal
          );
          const formatted = formatBatchReadOutput(result.results);
          const publicResult = formatReadEventOutput(result.results);
          return {
            content: formatted.content,
            data: result,
            eventSummary: publicResult.source,
            eventData: {
              ...publicResult.data,
              truncated: result.truncated || publicResult.truncated
            },
            truncated: result.truncated || formatted.truncated
          };
        }
      ],
      [
        'view_image',
        async (arguments_: unknown, context: LocalToolContext) =>
          viewImage.execute(arguments_, context.signal)
      ],
      [
        'apply_patch',
        async (arguments_: unknown, context: LocalToolContext) => {
          const result = await patch.execute(applyPatchToolInput(arguments_), context.signal);
          return { content: JSON.stringify(result), data: result };
        }
      ],
      ...(['exec', 'exec_wait'] as const).map(
        (name) =>
          [
            name,
            async (arguments_: unknown, context: LocalToolContext) => {
              const result = await this.#exec.execute(
                execToolInput(name, arguments_),
                context.signal,
                {
                  sessionId: context.sessionId,
                  ...(context.executionId === undefined
                    ? {}
                    : { executionId: context.executionId }),
                  ...(context.operation === undefined
                    ? {}
                    : {
                        operationId: context.operation.operationId,
                        ...(context.operation.ownerInstanceId === undefined
                          ? {}
                          : { ownerInstanceId: context.operation.ownerInstanceId })
                      })
                },
                context.waitInterrupt,
                context.onOutput
              );
              return formatExecResult(result);
            }
          ] as const
      )
    ]);
  }

  execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const handler = this.#handlers.get(call.name);
    if (!handler) throw new AgentError('MAR_AGENT_TOOL_NOT_AVAILABLE', 'Tool is unavailable.');
    return handler(
      normalizeToolInput(
        call.arguments,
        definitions.find((tool) => tool.name === call.name)!.inputSchema
      ),
      context
    );
  }

  names(): readonly string[] {
    return [...this.#handlers.keys()];
  }

  executeOperation(
    call: ToolCall,
    operation: ExtensionOperationContext
  ): Promise<ToolExecutionResult> {
    const handler = this.#handlers.get(call.name);
    if (!handler) throw new AgentError('MAR_AGENT_TOOL_NOT_AVAILABLE', 'Tool is unavailable.');
    return handler(
      normalizeToolInput(
        call.arguments,
        definitions.find((tool) => tool.name === call.name)!.inputSchema
      ),
      {
        mode: 'run',
        signal: operation.signal,
        sessionId: operation.sessionId,
        ...(operation.executionId === undefined ? {} : { executionId: operation.executionId }),
        operation
      }
    );
  }

  listSessionResources(sessionId: string) {
    return this.#exec.listSessionResources(sessionId);
  }

  listCodeCells(sessionId: string) {
    return this.#code.listSessionResources(sessionId);
  }

  async disposeSessionResources(sessionId: string) {
    await Promise.all([this.#exec.disposeSession(sessionId), this.#code.dispose(sessionId)]);
  }

  async dispose() {
    await Promise.all([this.#exec.dispose(), this.#code.dispose()]);
  }
}
