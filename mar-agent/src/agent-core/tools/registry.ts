import type { ClientToolDefinition } from '../model/contracts.js';
import { agentCancelToolDefinition, executeAgentCancel } from './agent/agent-cancel.js';
import { agentMessageToolDefinition, executeAgentMessage } from './agent/agent-message.js';
import { agentStartToolDefinition, executeAgentStart } from './agent/agent-start.js';
import { agentWaitToolDefinition, executeAgentWait } from './agent/agent-wait.js';
import { applyPatchToolDefinition } from './local/apply-patch.js';
import { codeExecWaitToolDefinition, codeModeToolDefinition } from './code-mode/index.js';
import type { ToolExecutionResult } from './contracts.js';
import { execToolDefinition, execWaitToolDefinition } from './local/exec.js';
import { executeQuestion, questionToolDefinition } from './agent/question.js';
import { readToolDefinition } from './local/read.js';
import type { ToolRuntimeContext } from './runtime-context.js';
import { executeSkill, skillToolDefinition } from './agent/skill.js';
import { executeTodoRead, todoReadToolDefinition } from './agent/todo-read.js';
import { executeTodoWrite, todoWriteToolDefinition } from './agent/todo-write.js';
import { executeToolSearch, toolSearchToolDefinition } from './mcp/tool-search.js';
import { viewImageToolDefinition } from './local/view-image.js';
import { smartCompactToolDefinition, executeSmartCompact } from './agent/smart-compact.js';
import { executeSleep, sleepToolDefinition } from './agent/sleep.js';

export const BUILTIN_TOOL_DEFINITIONS: readonly ClientToolDefinition[] = [
  skillToolDefinition,
  toolSearchToolDefinition,
  readToolDefinition,
  viewImageToolDefinition,
  execToolDefinition,
  execWaitToolDefinition,
  codeModeToolDefinition,
  codeExecWaitToolDefinition,
  applyPatchToolDefinition,
  questionToolDefinition,
  todoReadToolDefinition,
  todoWriteToolDefinition,
  agentStartToolDefinition,
  agentWaitToolDefinition,
  agentMessageToolDefinition,
  agentCancelToolDefinition,
  smartCompactToolDefinition,
  sleepToolDefinition
];

type RuntimeHandler = (
  arguments_: unknown,
  context: ToolRuntimeContext,
  callId: string
) => Promise<ToolExecutionResult>;

export const AGENT_TOOL_HANDLERS: ReadonlyMap<string, RuntimeHandler> = new Map<
  string,
  RuntimeHandler
>([
  ['skill', executeSkill],
  ['sleep', executeSleep],
  ['smart_compact', executeSmartCompact],
  ['tool_search', executeToolSearch],
  ['question', executeQuestion],
  ['todo_read', (_arguments, context) => executeTodoRead(context)],
  ['todo_write', executeTodoWrite],
  ['agent_start', executeAgentStart],
  ['agent_wait', executeAgentWait],
  ['agent_message', executeAgentMessage],
  ['agent_cancel', executeAgentCancel]
]);
