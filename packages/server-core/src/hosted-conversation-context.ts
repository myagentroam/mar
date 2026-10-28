import {
  hostedConversationIdInputSchema,
  hostedConversationSnapshotSchema,
  type ConversationTemplateSummary,
  type HostedConversationSnapshot,
  type MarAgentRuntimeModelConfiguration
} from '@myagentroam/protocol';
import type { CurrentUserSession } from './session.js';
import type { HostedNodeControl } from './hosted-contracts.js';
import type { ConversationTemplateService } from './conversation-template-service.js';
import type { MarAgentModelService } from './mar-agent-model-service.js';
import type { MarAgentRuntimeModelService } from './mar-agent-runtime-model-service.js';
import { requestHostedConversationNode } from './hosted-http-support.js';

interface HostedConversationContextDependencies {
  readonly templates: Pick<ConversationTemplateService, 'assertCanUse' | 'runtimeContext'>;
  readonly models: Pick<MarAgentModelService, 'runtimeConfigurationsForUser' | 'runtimeForUser'>;
  readonly marAgentRuntimeModels?: Pick<MarAgentRuntimeModelService, 'prepare'>;
  readonly nodeControl: HostedNodeControl;
}

interface ExistingConversationAuthorization {
  readonly snapshot: HostedConversationSnapshot;
  readonly modelCatalog: readonly MarAgentRuntimeModelConfiguration[];
  readonly runtime: Awaited<ReturnType<typeof hostedRuntimeModels>>;
  readonly workspaceId?: string;
}

export async function authorizeExistingConversation(
  input: HostedConversationContextDependencies,
  actor: CurrentUserSession,
  identifiers: { readonly nodeId: string; readonly conversationId: string }
): Promise<ExistingConversationAuthorization> {
  const conversation = hostedConversationIdInputSchema.parse({
    conversationId: identifiers.conversationId
  });
  let template: ConversationTemplateSummary;
  let workspaceId: string | undefined;
  let runtime: Awaited<ReturnType<typeof hostedRuntimeModels>>;
  const probe = hostedConversationSnapshotSchema.parse(
    await requestHostedConversationNode(
      input.nodeControl,
      actor,
      identifiers.nodeId,
      'conversation.hosted.get',
      {
        ...conversation,
        __marAgentModels: []
      }
    )
  );
  assertHostedSnapshotIdentity(probe, identifiers);

  if (input.marAgentRuntimeModels === undefined) {
    template = await input.templates.assertCanUse(actor.userId, probe.conversation.templateId);
    runtime = await hostedRuntimeModels({
      userId: actor.userId,
      nodeId: identifiers.nodeId,
      models: input.models
    });
  } else {
    const context = await input.templates.runtimeContext(
      actor.userId,
      probe.conversation.templateId
    );
    if (
      context.template.id !== probe.conversation.templateId ||
      context.nodeId !== identifiers.nodeId
    )
      throw new Error('CONVERSATION_TEMPLATE_NOT_AUTHORIZED');
    template = context.template;
    workspaceId = context.workspaceId;
    runtime = await hostedRuntimeModels({
      userId: actor.userId,
      nodeId: identifiers.nodeId,
      workspaceId,
      models: input.models,
      marAgentRuntimeModels: input.marAgentRuntimeModels
    });
  }
  const modelCatalog = runtime.modelCatalog;
  let snapshot = hostedConversationSnapshotSchema.parse(
    await requestHostedConversationNode(
      input.nodeControl,
      actor,
      identifiers.nodeId,
      'conversation.hosted.get',
      {
        ...conversation,
        ...hostedRuntimePayload(runtime, template.id),
        ...(template.status === 'DELETED' ? { __templateDeleted: true } : {})
      }
    )
  );
  assertHostedSnapshotIdentity(snapshot, identifiers);
  if (snapshot.conversation.sessionId !== probe.conversation.sessionId)
    throw new Error('HOSTED_CONVERSATION_NOT_AUTHORIZED');
  if (template.id !== snapshot.conversation.templateId || template.nodeId !== identifiers.nodeId)
    throw new Error('CONVERSATION_TEMPLATE_NOT_AUTHORIZED');
  if (template.status === 'DELETED' && snapshot.template.status !== 'DELETED') {
    const sessionId = snapshot.conversation.sessionId;
    snapshot = hostedConversationSnapshotSchema.parse(
      await requestHostedConversationNode(
        input.nodeControl,
        actor,
        identifiers.nodeId,
        'conversation.hosted.get',
        {
          ...conversation,
          ...hostedRuntimePayload(runtime, template.id),
          __templateDeleted: true
        }
      )
    );
    if (
      snapshot.conversation.id !== identifiers.conversationId ||
      snapshot.conversation.nodeId !== identifiers.nodeId ||
      snapshot.template.id !== snapshot.conversation.templateId ||
      snapshot.template.id !== template.id ||
      snapshot.template.nodeId !== identifiers.nodeId ||
      snapshot.conversation.sessionId !== sessionId ||
      snapshot.template.status !== 'DELETED'
    )
      throw new Error('HOSTED_CONVERSATION_NOT_AUTHORIZED');
  }
  return {
    snapshot,
    modelCatalog,
    runtime,
    ...(workspaceId === undefined ? {} : { workspaceId })
  };
}

export function assertHostedSnapshotIdentity(
  snapshot: HostedConversationSnapshot,
  identifiers: { readonly nodeId: string; readonly conversationId: string }
): void {
  if (
    snapshot.conversation.id !== identifiers.conversationId ||
    snapshot.conversation.nodeId !== identifiers.nodeId ||
    snapshot.template.id !== snapshot.conversation.templateId ||
    snapshot.template.nodeId !== identifiers.nodeId
  )
    throw new Error('HOSTED_CONVERSATION_NOT_AUTHORIZED');
}

export async function hostedRuntimeModels(input: {
  readonly userId: number;
  readonly nodeId: string;
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly selectedModelId?: string;
  readonly models: Pick<MarAgentModelService, 'runtimeConfigurationsForUser' | 'runtimeForUser'>;
  readonly marAgentRuntimeModels?: Pick<MarAgentRuntimeModelService, 'prepare'>;
}): Promise<{
  readonly compact?: import('@myagentroam/protocol').MarAgentRuntimeCompactConfiguration;
  readonly runtimeScopeId?: string;
  readonly model?: MarAgentRuntimeModelConfiguration;
  readonly modelCatalog: readonly MarAgentRuntimeModelConfiguration[];
}> {
  if (input.marAgentRuntimeModels !== undefined) {
    if (input.workspaceId === undefined) throw new Error('MAR_AGENT_RUNTIME_WORKSPACE_REQUIRED');
    const prepared = await input.marAgentRuntimeModels.prepare({
      userId: input.userId,
      nodeId: input.nodeId,
      workspaceId: input.workspaceId,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.selectedModelId === undefined ? {} : { selectedModelId: input.selectedModelId })
    });
    return {
      runtimeScopeId: prepared.runtimeScopeId,
      ...(prepared.compact === undefined ? {} : { compact: prepared.compact }),
      ...(prepared.model === undefined ? {} : { model: prepared.model }),
      modelCatalog: prepared.models
    };
  }
  const modelCatalog = await input.models.runtimeConfigurationsForUser(input.userId);
  return {
    ...(input.selectedModelId === undefined
      ? {}
      : {
          model: await input.models.runtimeForUser(input.userId, input.selectedModelId)
        }),
    modelCatalog
  };
}

export function hostedRuntimePayload(
  runtime: {
    readonly compact?: import('@myagentroam/protocol').MarAgentRuntimeCompactConfiguration;
    readonly runtimeScopeId?: string;
    readonly model?: MarAgentRuntimeModelConfiguration;
    readonly modelCatalog: readonly MarAgentRuntimeModelConfiguration[];
  },
  sourceTemplateId?: string
): object {
  return {
    ...(sourceTemplateId === undefined ? {} : { __sourceTemplateId: sourceTemplateId }),
    ...(runtime.runtimeScopeId === undefined
      ? {}
      : { __marAgentRuntimeScopeId: runtime.runtimeScopeId }),
    ...(runtime.model === undefined ? {} : { __marAgentModel: runtime.model }),
    __marAgentModels: runtime.modelCatalog,
    ...(runtime.compact === undefined ? {} : { __marAgentCompact: runtime.compact })
  };
}
