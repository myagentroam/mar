import type { UserNodeAuthorization } from './node-request-channel.js';
import type {
  SessionRunNodeControl,
  ProcessSecretResolver,
  PersonalInstructionReader,
  MarAgentModelService,
  MarAgentRuntimeModelService
} from './session-run-contracts.js';
import type { MarctlUserCredentials } from './marctl-user-credentials.js';
import { prepareSessionExecutionContext } from './session-execution-context.js';
import { runtimeModelPayload } from './run-model-payload.js';
import {
  recordSharedConversationAudit,
  sharedConversationFailureResult,
  type ConversationAuditObserver
} from './conversation-audit.js';
import { requireMarAgentAutoSupport } from './mar-agent-auto-support.js';
import { safeErrorCode } from './http-errors.js';

export interface SessionExecutionContext {
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly user: Pick<UserNodeAuthorization, 'userId' | 'sessionHash' | 'usageGrant'> & {
    readonly username?: string;
    readonly channel?: boolean;
    readonly scheduled?: boolean;
  };
}

export interface SessionInputContext extends SessionExecutionContext {
  readonly sessionId: string;
}

type SessionControlContext = Omit<SessionInputContext, 'workspaceId'> & {
  readonly workspaceId?: string;
};

/** Server-validated caller metadata, never merged from a browser body. */
export interface SessionExecutionOrigin {
  readonly marctlOrigin?: { readonly sessionId?: string; readonly name?: string };
  readonly suppressNotifications?: boolean;
}

export interface SessionStartInput {
  readonly runner: string;
  readonly cwd: string;
  readonly clientMessageId: string;
  readonly content: string;
  readonly model?: string;
  readonly effort?: string;
  readonly access?: string;
  readonly title?: string;
  readonly customTitle?: string;
  readonly parentSessionId?: string;
  readonly attachments?: SessionMessageInput['attachments'];
  readonly attachmentIds?: readonly string[];
  readonly deferredCommands?: readonly { readonly commandId: string; readonly input: string }[];
  readonly computerUse?: boolean;
}

export interface SessionMessageInput {
  readonly clientMessageId: string;
  readonly content: string;
  readonly attachments?: readonly {
    readonly name: string;
    readonly mime: string;
    readonly dataBase64: string;
  }[];
  readonly attachmentIds?: readonly string[];
  readonly deliveryIntent?: 'SEND' | 'QUEUE' | 'REPLACE_CURRENT';
  readonly model?: string;
  readonly computerUse?: boolean;
}

interface Options {
  readonly nodeControl: Pick<SessionRunNodeControl, 'requestNode'>;
  readonly secrets: ProcessSecretResolver;
  readonly userCredentials?: MarctlUserCredentials;
  readonly personalInstructions?: PersonalInstructionReader;
  readonly marAgentModels?: MarAgentModelService;
  readonly marAgentRuntimeModels?: MarAgentRuntimeModelService;
  readonly audits?: ConversationAuditObserver;
  /** Legacy Browser commands use Workspace only for preparation and authorization. */
  readonly commandWorkspaceInPayload?: boolean;
  readonly publicOrigin: string | undefined;
}

/** Shared execution entry for authenticated callers; the Node broker authorizes each operation. */
export class SessionInputService {
  constructor(private readonly options: Options) {}

  async startSession(
    context: SessionExecutionContext,
    input: SessionStartInput,
    origin: SessionExecutionOrigin = {}
  ): Promise<unknown> {
    const { nodeId, workspaceId } = context;
    let result: unknown;
    try {
      await requireMarAgentAutoSupport({
        access: input.access,
        runner: input.runner,
        request: (operation, data) =>
          this.options.nodeControl.requestNode(
            nodeId,
            operation,
            data,
            this.authorization(context),
            undefined
          )
      });
      result = await this.options.nodeControl.requestNode(
        nodeId,
        'session.start',
        {
          ...input,
          workspaceId,
          ...this.originPayload(origin),
          ...(await this.prepareExecution(
            context,
            input.runner === 'mar-agent' ? input.model : undefined
          ))
        },
        this.authorization(context),
        undefined
      );
    } catch (error) {
      await this.auditRejection(
        context,
        input.clientMessageId,
        { inputMode: 'NEW_SESSION' },
        error
      );
      throw error;
    }
    await this.auditAccepted(context, input, result);
    return result;
  }

  async submitMessage(
    context: SessionInputContext,
    message: SessionMessageInput,
    origin: SessionExecutionOrigin = {}
  ): Promise<unknown> {
    const { nodeId, workspaceId, sessionId, user } = context;
    const { nodeControl } = this.options;
    let result: unknown;
    try {
      const { model, ...messageInput } = message;
      result = await nodeControl.requestNode(
        nodeId,
        'session.message',
        {
          ...messageInput,
          sessionId,
          workspaceId,
          ...this.originPayload(origin),
          ...(await this.prepareExecution(context, model))
        },
        this.authorization(context),
        undefined
      );
    } catch (error) {
      await this.auditRejection(
        context,
        message.clientMessageId,
        {
          sessionId,
          inputMode: message.deliveryIntent ?? 'SEND'
        },
        error
      );
      throw error;
    }
    await this.auditAccepted(context, message, result);
    return result;
  }

  interrupt(context: SessionControlContext): Promise<unknown> {
    return this.options.nodeControl.requestNode(
      context.nodeId,
      'session.interrupt',
      { sessionId: context.sessionId, ...this.workspaceScope(context.workspaceId) },
      this.authorization(context),
      undefined
    );
  }

  async executeCommand(
    context: SessionControlContext,
    input: { commandId: string; input: string; model?: string },
    origin: SessionExecutionOrigin = {}
  ): Promise<unknown> {
    return this.options.nodeControl.requestNode(
      context.nodeId,
      'session.command.execute',
      {
        sessionId: context.sessionId,
        ...(this.options.commandWorkspaceInPayload === false
          ? {}
          : this.workspaceScope(context.workspaceId)),
        commandId: input.commandId,
        input: input.input,
        ...this.originPayload(origin),
        ...(await this.prepareExecution(context, input.model))
      },
      this.authorization(context),
      undefined
    );
  }

  private workspaceScope(workspaceId: string | undefined) {
    return workspaceId === undefined ? {} : { workspaceId };
  }

  private authorization(context: Pick<SessionControlContext, 'user' | 'workspaceId'>) {
    return {
      userId: context.user.userId,
      sessionHash: context.user.sessionHash,
      ...(context.user.usageGrant === undefined ? {} : { usageGrant: context.user.usageGrant }),
      ...this.workspaceScope(context.workspaceId)
    };
  }

  private originPayload(origin: SessionExecutionOrigin) {
    return {
      ...(origin.marctlOrigin === undefined ? {} : { __marctlOrigin: origin.marctlOrigin }),
      ...(origin.suppressNotifications === undefined
        ? {}
        : { __suppressNotifications: origin.suppressNotifications })
    };
  }

  private async prepareExecution(
    context: Omit<SessionControlContext, 'sessionId'> & { readonly sessionId?: string },
    model: string | undefined
  ): Promise<object> {
    return {
      ...(await prepareSessionExecutionContext({
        user: context.user,
        nodeId: context.nodeId,
        workspaceId: context.workspaceId,
        secrets: this.options.secrets,
        credentials: this.options.userCredentials,
        instructions: this.options.personalInstructions,
        serverUrl: this.options.publicOrigin
      })),
      ...(model === undefined
        ? {}
        : await runtimeModelPayload({
            userId: context.user.userId,
            nodeId: context.nodeId,
            // Legacy command calls without runtime credentials allow an absent Workspace.
            workspaceId: context.workspaceId as string,
            ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
            selectedModelId: model,
            ...(this.options.marAgentModels === undefined
              ? {}
              : { marAgentModels: this.options.marAgentModels }),
            ...(this.options.marAgentRuntimeModels === undefined
              ? {}
              : { marAgentRuntimeModels: this.options.marAgentRuntimeModels })
          }))
    };
  }

  private auditRejection(
    context: SessionExecutionContext,
    clientMessageId: string,
    receipt: {
      sessionId?: string;
      inputMode: 'NEW_SESSION' | 'SEND' | 'QUEUE' | 'REPLACE_CURRENT';
    },
    error: unknown
  ) {
    const errorCode = safeErrorCode(error);
    return recordSharedConversationAudit({
      audits: this.options.audits,
      eventType: 'shared_conversation_input_rejected',
      actorUserId: context.user.userId,
      nodeId: context.nodeId,
      workspaceId: context.workspaceId,
      clientMessageId,
      errorCode,
      result: sharedConversationFailureResult(errorCode),
      fallbackReceipt: receipt
    });
  }

  private auditAccepted(
    context: SessionExecutionContext,
    input: { clientMessageId: string; content: string },
    result: unknown
  ) {
    return recordSharedConversationAudit({
      audits: this.options.audits,
      eventType: 'shared_conversation_input_accepted',
      actorUserId: context.user.userId,
      nodeId: context.nodeId,
      workspaceId: context.workspaceId,
      clientMessageId: input.clientMessageId,
      userMessage: input.content,
      nodeResult: result
    });
  }
}
