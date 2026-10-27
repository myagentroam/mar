import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AgentError } from '../error.js';
import { ExtensionRequestBridge } from '../extensions/model-request.js';
import type { ExtensionSession } from '../extensions/session.js';
import type { ExtensionOperationContext } from '../extensions/operation.js';
import type { SessionModelRequest } from '../session/model-request.js';
import type { ModelTurnSession } from '../model/contracts.js';
import type { AgentHost } from '../host/contracts.js';
import type { ModelRequestUsage } from '../model/usage-observer.js';
import { projectPermissionTool } from '../tools/permissions.js';

/** Captures Extension rewrites against immutable tool bindings and attributes model usage. */
export function createExecutionModelRequest(ports: {
  readonly sessionId: string;
  readonly executionId: string;
  readonly modelId: string;
  readonly source: 'user' | 'subagent';
  readonly compact: boolean;
  readonly autoPermission: boolean;
  readonly turn: ModelTurnSession;
  readonly hooks: Pick<ExtensionSession['hooks'], 'hasInterceptors' | 'invoke'>;
  readonly host: Pick<AgentHost, 'modelUsage'>;
  capture(): ReturnType<ExtensionSession['capture']>;
  operation<T>(run: (call: ExtensionOperationContext) => T): T;
  usageFailed(): void;
}) {
  return async (
    candidate: SessionModelRequest,
    bindings = ports.capture(),
    modelId = ports.modelId,
    purpose: 'conversation' | 'compact' = ports.compact ? 'compact' : 'conversation'
  ) => {
    let lowered = candidate;
    if (ports.hooks.hasInterceptors('model.request')) {
      const bridge = new ExtensionRequestBridge(
        modelId,
        candidate,
        undefined,
        ports.turn.continuationInputCount?.() ?? 0
      );
      const request = await ports.operation((call) =>
        ports.hooks.invoke('model.request', bridge.view, call, async (view) => view)
      );
      lowered = bridge.lower(request);
      if (bridge.rewroteCommittedInput) ports.turn.resetContinuation?.();
    }
    for (const definition of lowered.tools) {
      const binding = bindings.get(definition.name);
      const { description: _description, ...contract } = definition;
      const { description: _capturedDescription, ...capturedContract } = binding
        ? ports.autoPermission
          ? projectPermissionTool(binding.definition)
          : binding.definition
        : {};
      if (!binding || !isDeepStrictEqual(contract, capturedContract))
        throw new AgentError(
          'MAR_AGENT_EXTENSION_MODEL_REQUEST_INVALID',
          'Request tools do not match captured sources.'
        );
    }
    return {
      ...lowered,
      usageRequestId: randomUUID(),
      ...(ports.host.modelUsage === undefined
        ? {}
        : {
            onModelUsage: (usage: ModelRequestUsage) =>
              ports.host.modelUsage!({
                ...usage,
                sessionId: ports.sessionId,
                executionId: ports.executionId,
                purpose,
                agentRole: ports.source === 'subagent' ? 'subagent' : 'root'
              }),
            onModelUsageFailure: ports.usageFailed
          })
    };
  };
}
