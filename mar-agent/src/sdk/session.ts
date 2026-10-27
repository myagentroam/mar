import type { InternalAgentSession, SessionServices } from './session-composition.js';
import type { SessionModelMessage as ModelMessage } from '../session/model-request.js';
import type { SessionStore } from '../session/store/contracts.js';
import type { ClientToolDefinition } from '../tools/contracts.js';
import { createExtensionSessionLaunch, extensionInputSource } from './extension-session-launch.js';
import type { ResolvedModelConfiguration } from './model-runtime.js';
import { createSessionExecutionFactory } from './session-execution-factory.js';
import { createSessionExtensionMessages } from './session-extension-messages.js';
import { createSessionExtensionPrompt } from './session-extension-prompt.js';
import { createSubagentBackend } from './subagent-backend.js';

import { AgentError } from '../error.js';
import type { ExtensionManager } from '../extensions/manager.js';
import type { ExtensionOperationContext } from '../extensions/operation.js';
import {
  SessionInputCoordinator,
  recordSessionInputCommit,
  type ExtensionAppendInput,
  type ExtensionSessionActionResult,
  type ExtensionSessionRequest,
  type SessionInputEntry
} from '../extensions/session-input.js';
import type { HostDescription, AgentHost } from '../host/contracts.js';
import type { AgentReasoningEffort } from '../model/configuration.js';
import type { ModelAdapter } from '../model/contracts.js';
import type { EnvironmentContextState } from '../prompts/core.js';
import { buildSystemPromptSections } from '../prompts/index.js';
import { childSubagentInstruction } from '../prompts/subagent.js';
import { DEFAULT_COMPACTION_FOCUS } from '../runtime/compaction/history.js';
import { restoreEnvironmentState } from '../runtime/context/environment.js';
import {
  SubagentSessionController,
  type SubagentMailboxMessage,
  type SubagentMessageDelivery,
  type SubagentTurnHandle
} from '../subagent/session-controller.js';
import { allowsDirectTool } from '../tools/callers.js';
import { createExtensionAgentsBackend } from './extension-agents.js';
import { createExtensionSessionBackend } from './extension-session.js';
import { createSessionOpen } from './session-open.js';
import type { SessionRegistry } from './session-registry.js';
import { SessionRuntime } from './session-runtime.js';
import type { CreateAgentOptions, ExecutionMode, AgentSession } from './types.js';

function restoreSubagentOrigin(
  origin: import('../subagent/session-controller.js').SubagentOrigin
): ExtensionOperationContext {
  return { ...(origin.correlation as ExtensionOperationContext), signal: origin.signal };
}

/** SDK Session orchestration owns warm resources; Runtime owns only the model/tool loop. */
export function createSessionOpener(services: SessionServices) {
  const { host, description, settings, store, createAdapter, activeAdaptersExcept } = services;
  const { activeExecutionAdapters, sessionRuntimes, sessionWriterOwner } = services.agentResources;
  const openSession = createSessionOpen<InternalAgentSession>({
    registry: sessionRuntimes,
    getSession: (id) => store.getSession(id),
    generation: () => services.modelState().generation,
    createAdapter,
    hasCustomAdapters: services.hasCustomAdapters,
    openSubagents: (id, workspace) =>
      SubagentSessionController.open({
        parentSessionId: id,
        rootSessionId: id,
        backend: createSubagentBackend(store, workspace)
      }),
    assertAdmission: services.assertSessionAdmission,
    epoch: services.openEpoch,
    canPublish: services.canPublishSession,
    createHandle: (id, runtime, stored, workspace) =>
      createSessionHandle(id, runtime, stored, workspace)
  });
  const createSessionHandle = (
    sessionId: string,
    sessionRuntime: SessionRuntime,
    storedSession: Awaited<ReturnType<SessionStore['getSession']>>,
    workspace?: string
  ): InternalAgentSession => {
    const storedWorkspace = storedSession.workspace;
    const sessionSource = storedSession.source;
    const logicalWorkspace =
      settings.workspaceMapping?.logicalPath ?? workspace ?? storedWorkspace ?? '';
    const instructionWorkspace =
      settings.workspaceMapping?.physicalPath ?? workspace ?? storedWorkspace ?? '';
    const currentEnvironment: EnvironmentContextState = {
      platform: description.platform,
      ...(description.architecture ? { architecture: description.architecture } : {}),
      ...(description.shell ? { shell: description.shell } : {}),
      ...(description.guaranteedCommands
        ? { guaranteedCommands: description.guaranteedCommands }
        : {}),
      workspace: logicalWorkspace
    };
    if (!restoreEnvironmentState({ version: 1, state: currentEnvironment }))
      throw new AgentError(
        'MAR_AGENT_HOST_INCOMPATIBLE',
        'Host environment facts are invalid or exceed the context limit.'
      );
    const buildSessionPromptSections = (
      availableTools: readonly ClientToolDefinition[],
      promptMode: ExecutionMode,
      selectedModel: ResolvedModelConfiguration,
      executionSystemInstruction: string | undefined,
      skillCatalog: string | undefined
    ) =>
      buildSystemPromptSections({
        mode: promptMode,
        platform: description.platform,
        ...(description.architecture ? { architecture: description.architecture } : {}),
        ...(description.shell ? { shell: description.shell } : {}),
        ...(description.guaranteedCommands
          ? { guaranteedCommands: description.guaranteedCommands }
          : {}),
        workspace: logicalWorkspace,
        tools: availableTools
          .filter((tool) => !tool.name.startsWith('mcp__'))
          .map((tool) => tool.name),
        directTools: availableTools
          .filter(
            (tool) =>
              !tool.name.startsWith('mcp__') &&
              allowsDirectTool(
                tool,
                availableTools.some((candidate) => candidate.name === 'code_exec')
              )
          )
          .map((tool) => tool.name),
        extension: executionSystemInstruction
      }).concat([
        { id: 'core:skill-catalog', text: skillCatalog || null },
        {
          id: 'core:child-instructions',
          text: sessionSource.type === 'subagent' ? childSubagentInstruction || null : null
        }
      ]);
    const sessionAdapter = (
      modelId: string,
      configuredModels: ReadonlyMap<string, ResolvedModelConfiguration>
    ): ModelAdapter => {
      return sessionRuntime.adapter(modelId, configuredModels);
    };
    const refreshSessionAdapters = async (generation: number): Promise<void> => {
      const retainedByActiveSessions = activeAdaptersExcept(sessionId);
      await sessionRuntime.refreshAdapters(generation, retainedByActiveSessions);
    };
    const sessionInputs = () =>
      sessionRuntime.getOrCreateInputs(
        () =>
          new SessionInputCoordinator((receipt) =>
            services.extensions.session(sessionId)?.diagnose({
              code: receipt.errorCode ?? 'MAR_AGENT_SESSION_INPUT_FAILED',
              operationId: receipt.operationId,
              sessionId
            })
          )
      );
    // Only physical record commits and projection replacement enter this lane, never Hooks.
    const withRecordProjection = <T>(action: () => Promise<T>): Promise<T> =>
      sessionRuntime.withRecordProjection(action);
    const appendExtensionMessage = async (
      entry: SessionInputEntry,
      request: Extract<ExtensionSessionRequest, { kind: 'append' }>,
      call: ExtensionOperationContext
    ): Promise<ExtensionSessionActionResult> => {
      call.signal.throwIfAborted();
      const release = await store.acquireSessionWriteLease(sessionId, sessionWriterOwner);
      try {
        return await withRecordProjection(async () => {
          call.signal.throwIfAborted();
          const message = projectAppendedModelMessage(request.input);
          const record = await store.append(
            sessionId,
            {
              type: message ? 'model.context' : 'session.notice',
              payload: {
                ...(message ?? {
                  content: request.input.content,
                  textBlocks: request.input.textBlocks
                }),
                source: extensionInputSource(call, request.input.attribution)
              },
              ...(call.executionId ? { executionId: call.executionId } : {}),
              ...(call.turnId ? { turnId: call.turnId } : {})
            },
            { signal: call.signal }
          );
          const result = {
            changed: true,
            modelChanged: !!message,
            recordId: record.recordId,
            ...(call.executionId ? { executionId: call.executionId } : {})
          };
          recordSessionInputCommit(entry, result);
          if (message) sessionRuntime.execution?.appendedMessages?.append(record.recordId, message);
          return result;
        });
      } finally {
        await release();
      }
    };
    const execution = createSessionExecutionFactory({
      assertCanStart: services.assertCanStart,
      extensions: services.extensions,
      baseTools: services.extensions.options.baseTools,
      hasCustomAdapters: services.hasCustomAdapters,
      modelState: services.modelState,
      host,
      store,
      description,
      settings,
      sessionWriterOwner,
      activeExecutionAdapters,
      sessionId,
      sessionRuntime,
      sessionSource,
      logicalWorkspace,
      instructionWorkspace,
      currentEnvironment,
      buildSessionPromptSections,
      sessionAdapter,
      refreshSessionAdapters,
      sessionInputs,
      withRecordProjection,
      appendExtensionMessage,
      startSubagentTurn: async (id, input) => (await openSession(id)).startSubagentTurn(input)
    });
    sessionRuntime.ensureSessionBackend(() =>
      createExtensionSessionBackend({
        describe: async (call) => {
          call.signal.throwIfAborted();
          const defaults = sessionRuntime.execution;
          const state = defaults ?? services.modelState();
          const modelId = defaults?.modelId ?? services.modelState().defaultModelId;
          const current = await store.getSession(sessionId);
          const userTurns = await store.userTurnCount(sessionId);
          call.signal.throwIfAborted();
          const model = state.models.get(modelId);
          if (!model)
            throw new AgentError('MAR_AGENT_MODEL_DISABLED', 'Selected model is unavailable.');
          return {
            sessionId,
            ...(logicalWorkspace ? { cwd: logicalWorkspace, root: logicalWorkspace } : {}),
            modelId,
            modelName: model.name,
            startedAt: Date.parse(current.createdAt),
            source: structuredClone(sessionSource),
            userTurns
          };
        },
        composePrompt: createSessionExtensionPrompt({
          sessionId,
          source: sessionSource.type,
          home: description.homeDirectory,
          workspace: instructionWorkspace,
          displayWorkspace: logicalWorkspace,
          codeExecute: description.capabilities.includes('code.execute'),
          host,
          execution: () => sessionRuntime.execution,
          models: () => services.modelState(),
          instruction: () => settings.systemInstruction,
          workspaceMapped: () => settings.workspaceMapping !== undefined,
          capture: (call) => services.extensions.session(sessionId)?.capture(call),
          sections: buildSessionPromptSections
        }),
        captureRequest: async (call, input) => {
          call.signal.throwIfAborted();
          return sessionRuntime.captureRequest(input);
        },
        sessionId,
        coordinator: sessionInputs,
        activeExecutionId: () => sessionRuntime.activeExecutionId,
        append: appendExtensionMessage,
        messages: createSessionExtensionMessages({
          sessionId,
          store,
          agents: () => sessionRuntime.agentsBackend,
          runtime: (id) => sessionRuntimes.get(id),
          models: () => services.modelState()
        }),
        launch: createExtensionSessionLaunch(sessionSource.type, execution),
        diagnose: (code, operationId) =>
          services.extensions.session(sessionId)?.diagnose({ code, operationId, sessionId })
      })
    );
    if (sessionSource.type === 'user')
      sessionRuntime.ensureAgentsBackend(() =>
        createExtensionAgentsBackend({
          existingController: () => sessionRuntime.subagents,
          controller: async () => {
            // Access to managed children is not a new Execution admission for their parent.
            services.assertCanStart();
            if (sessionRuntime.subagents === undefined) await openSession(sessionId);
            if (!sessionRuntime.subagents)
              throw new AgentError(
                'MAR_AGENT_SUBAGENT_FAILED',
                'Session task controller is unavailable.'
              );
            return sessionRuntime.subagents;
          },
          parent: (controller, call) => {
            const current =
              call.executionId === undefined
                ? undefined
                : controller.parentExecution(call.executionId);
            if (call.executionId !== undefined && !current)
              throw new AgentError(
                'MAR_AGENT_SUBAGENT_FAILED',
                'Parent Execution source is unavailable.'
              );
            const state = services.modelState();
            const selected = state.models.get(state.defaultModelId)!;
            return {
              ...(current ?? {
                modelId: selected.id,
                reasoningEffort: selected.defaultReasoningEffort,
                models: state.models,
                emitTerminal: async () => {},
                startTurn: async (turn) => {
                  const child = await openSession(turn.sessionId);
                  return child.startSubagentTurn({
                    prompt: turn.prompt,
                    modelId: turn.modelId,
                    reasoningEffort: turn.reasoningEffort,
                    role: turn.role,
                    initialMailbox: turn.initialMailbox,
                    turnId: turn.turnId,
                    ...(turn.origin === undefined
                      ? {}
                      : { origin: restoreSubagentOrigin(turn.origin) }),
                    ...(turn.delivery === undefined ? {} : { delivery: turn.delivery })
                  });
                }
              }),
              operationId: call.operationId,
              origin: { signal: call.signal, correlation: call },
              signal: call.signal,
              ...(call.ownerInstanceId === undefined
                ? {}
                : { ownerInstanceId: call.ownerInstanceId }),
              ...(call.extensionId === undefined ? {} : { extensionId: call.extensionId })
            };
          }
        })
      );
    return {
      id: sessionId,
      run: (input) => execution('run', input),
      plan: (input) => execution('plan', input),
      steer: (input) =>
        sessionRuntime.execution?.steer?.(input) ?? Promise.resolve({ status: 'notAccepted' }),
      compact: (input = {}) => {
        const requests = sessionRuntime.execution?.compactRequests;
        if (requests) {
          services.assertSessionAdmission(sessionId);
          return requests.request(input);
        }
        return execution('compact', {
          prompt: input.prompt ?? DEFAULT_COMPACTION_FOCUS,
          ...input
        });
      },
      cancel: async (executionId) => sessionRuntime.cancelExecution(executionId),
      startSubagentTurn: (turn) =>
        execution(
          turn.role === 'explore' ? 'plan' : 'run',
          {
            prompt: turn.prompt,
            modelId: turn.modelId,
            reasoningEffort: turn.reasoningEffort,
            ...(turn.permissionMode === undefined ? {} : { permissionMode: turn.permissionMode })
          },
          {
            publishHostEvents: false,
            ...(turn.origin === undefined ? {} : { signal: turn.origin.signal }),
            inputSource: turn.origin === undefined ? 'parent_agent' : 'extension',
            ...(turn.origin === undefined
              ? {}
              : { extensionSource: extensionInputSource(turn.origin) }),
            initialMailbox: turn.initialMailbox,
            turnId: turn.turnId,
            ...(turn.mcpExecutionScopeId === undefined
              ? {}
              : { mcpExecutionScopeId: turn.mcpExecutionScopeId }),
            ...(turn.delivery ? { delivery: turn.delivery } : {})
          }
        )
    };
  };
  return openSession;
}

function projectAppendedModelMessage(input: ExtensionAppendInput): ModelMessage | undefined {
  if (input.visibility === 'transcript') return undefined;
  return {
    role: 'user',
    contextKind: 'contextual',
    content: input.content,
    ...(input.textBlocks === undefined
      ? {}
      : { textBlocks: input.textBlocks.map((block) => ({ text: block.text })) })
  };
}
