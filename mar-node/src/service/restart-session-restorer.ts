import {
  parseComposerTags,
  serializeComposerTag,
  type RestartRunAuthorizeRequest
} from '@myagentroam/protocol';
import type { NodeAgentSession } from '../session/contracts.js';
import type { NodeRuntimeState } from '../runtime-state.js';
import type { CommandStateStore } from '../runner-command-engine.js';
import { parseMessageAttachments } from '../session/attachments.js';
import type { ContinuousRunCoordinator } from './continuous-run-coordinator.js';
import type { GoalRuntime, GoalState } from './goal-runtime.js';
import type { SessionMessageService } from '../session/session-message-service.js';
import { RUNNER_EXECUTION_CONTEXT } from '../runner/execution-context.js';
import type { ScheduledRunContext } from './scheduled-session-coordinator.js';
import {
  RESTART_NOTICE,
  type RestartSession,
  type RestartMessage
} from './planned-restart-handoff.js';

interface Options {
  readonly runtime: NodeRuntimeState;
  readonly goals: GoalRuntime;
  readonly commands: CommandStateStore;
  readonly coordinator: ContinuousRunCoordinator<unknown>;
  readonly messages: SessionMessageService;
  readonly resolve: (id: string) => Promise<NodeAgentSession>;
  readonly authorize: (request: RestartRunAuthorizeRequest) => Promise<ScheduledRunContext>;
  readonly inputState: (
    entry: RestartSession,
    message: RestartMessage
  ) => Promise<'missing' | 'completed' | 'interrupted' | 'paused'>;
  readonly withGrant: (
    context: ScheduledRunContext,
    work: () => Promise<unknown>
  ) => Promise<unknown>;
  readonly goalReference: (sessionId: string) => {
    readonly id: string;
    readonly revision: number;
    readonly epoch: number;
  };
  readonly publishGoal: (session: NodeAgentSession, goal: GoalState) => void;
  readonly publishQueue: (session: NodeAgentSession) => void;
}

/** Rebuild inputs through the existing preparation and FIFO boundary. */
export class RestartSessionRestorer {
  constructor(private readonly options: Options) {}

  async restore(entry: RestartSession, handoffId: string): Promise<void> {
    const contexts = new Map<number, ScheduledRunContext>();
    const authorize = async (ownerUserId: number) => {
      if (!contexts.has(ownerUserId))
        contexts.set(
          ownerUserId,
          await this.options.authorize({
            handoffId,
            sessionId: entry.session.id,
            workspaceId: entry.session.workspaceId,
            ownerUserId,
            runner: 'mar-agent',
            modelId: entry.session.modelId
          })
        );
      return contexts.get(ownerUserId)!;
    };
    await authorize(entry.ownerUserId);
    for (const input of [...entry.queue, ...(entry.current ? [entry.current] : [])]) {
      parseMessageAttachments(input.attachments);
      await authorize(input.initiatedByUserId);
    }
    let session = await this.options.resolve(entry.session.id);
    if (
      session.runner !== 'mar-agent' ||
      session.workspaceId !== entry.session.workspaceId ||
      session.cwd !== entry.session.cwd ||
      session.externalSessionId !== entry.session.id
    )
      throw new Error('RESTART_SESSION_MISMATCH');
    session = this.options.runtime.updateAgentSessionConfiguration({
      sessionId: session.id,
      modelId: entry.session.modelId ?? session.modelId!,
      effort: entry.session.effort ?? session.effort!,
      access: entry.session.access ?? session.access!
    });
    const { runtime, coordinator, goals, commands } = this.options;
    runtime.pauseSessionQueue(session.id);
    if (entry.plan)
      commands.set(session.id, {
        commandId: 'plan',
        active: true,
        label: 'Plan',
        detail: null,
        closable: true,
        closeInput: '/plan'
      });
    if (entry.goal) {
      if (entry.goal.goal.sessionId !== session.id)
        throw new Error('RESTART_GOAL_SESSION_MISMATCH');
      goals.restoreRestartState(entry.goal);
      this.options.publishGoal(session, entry.goal.goal);
    } else if (entry.awaitingGoal)
      commands.set(session.id, {
        commandId: 'goal',
        active: true,
        label: 'Goal',
        detail: null,
        closable: true,
        closeInput: '/goal --clear'
      });
    const submit = async (input: RestartMessage, content = input.content) => {
      const context = contexts.get(input.initiatedByUserId)!;
      await this.options.withGrant(context, () =>
        this.options.messages.restoreQueued({
          sessionId: session.id,
          content,
          clientMessageId: input.clientMessageId,
          ...(parseComposerTags(content)[0]?.kind === 'mar_restart'
            ? { __runnerContent: `${content}${RESTART_NOTICE}` }
            : {}),
          attachments: input.attachments,
          __queueItemId: input.id,
          __requestUserId: input.initiatedByUserId,
          __suppressNotifications: input.suppressNotifications === true,
          secretEnvironment: context.secretEnvironment,
          personalInstructions: context.personalInstructions,
          [RUNNER_EXECUTION_CONTEXT]: context.executionContext,
          __usageGrant: context.usageGrant
        })
      );
      if (input.immediate) coordinator.restoreImmediate(input.id);
    };
    try {
      if (
        entry.current &&
        entry.goal?.goal.status !== 'active' &&
        !entry.queue.some((item) => item.immediate)
      ) {
        const state = await this.options.inputState(entry, entry.current);
        if (state === 'paused') entry.paused = true;
        if (state === 'missing') await submit(entry.current);
        else if (state !== 'completed')
          await submit(
            {
              ...entry.current,
              id: `restart:${handoffId}:${session.id}`,
              clientMessageId: `restart:${handoffId}:${session.id}`,
              attachments: []
            },
            serializeComposerTag('mar_restart', {})
          );
      }
      for (const input of entry.queue) await submit(input);
      if (entry.goal?.goal.status === 'active') {
        const context = contexts.get(entry.ownerUserId)!;
        await this.options.withGrant(context, () =>
          this.options.messages.submitGoal({
            sessionId: session.id,
            kind: 'continue',
            deliveryIntent: 'QUEUE',
            content: `${goals.prompt(session.id, 'continue')}
${RESTART_NOTICE}`,
            goal: this.options.goalReference(session.id),
            initiatedByUserId: entry.ownerUserId,
            suppressNotifications: entry.suppressNotifications === true,
            secretEnvironment: context.secretEnvironment,
            restoreQueued: true,
            ...(context.usageGrant === undefined ? {} : { usageGrant: context.usageGrant }),
            ...(typeof context.personalInstructions === 'string'
              ? { personalInstructions: context.personalInstructions }
              : {}),
            executionContext: context.executionContext
          })
        );
      }
      if (!entry.paused) await coordinator.resume(session.id);
      this.options.publishQueue(session);
    } catch (error) {
      runtime.pauseSessionQueue(session.id);
      this.options.publishQueue(session);
      throw error;
    }
  }
}
