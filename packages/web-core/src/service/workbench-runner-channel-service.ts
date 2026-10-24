import type { MessageFeedback } from '../model/message-feedback.js';
import type { WorkspaceTarget } from '../model/workbench.js';
import type { ComputedRef, Ref } from 'vue';
import type { Session } from '../model/workbench.js';
import { translate } from './locale-preference-service.js';

/** Owns Claude shared-control token refresh and message delivery. */
export function createWorkbenchRunnerChannelService(options: {
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly selectedSession: ComputedRef<Session | undefined>;
  readonly token: Ref<string | undefined>;
  readonly input: Ref<string>;
  readonly loading: Ref<boolean>;
  readonly notice: MessageFeedback;
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly sessionPathId: (sessionId: string) => string;
  readonly errorMessage: (error: unknown) => string;
}) {
  async function refreshToken(): Promise<void> {
    const session = options.selectedSession.value;
    const nodeId = options.workspaceTarget.value?.nodeId;
    if (nodeId === undefined || session?.runner !== 'claude-code') return;
    try {
      options.token.value = (
        await options.request<{ token: string }>(
          `/api/agent-sessions/${options.sessionPathId(session.id)}/channel-token?nodeId=${encodeURIComponent(nodeId)}`
        )
      ).token;
    } catch {
      options.token.value = undefined;
    }
  }

  async function sendMessage(): Promise<void> {
    const nodeId = options.workspaceTarget.value?.nodeId;
    const session = options.selectedSession.value;
    const token = options.token.value;
    const content = options.input.value.trim();
    if (
      nodeId === undefined ||
      session === undefined ||
      token === undefined ||
      content.length === 0
    )
      return;
    options.loading.value = true;
    try {
      const result = await options.request<{ delivery: string }>(
        `/api/agent-sessions/${options.sessionPathId(session.id)}/channel-messages`,
        {
          method: 'POST',
          body: JSON.stringify({
            nodeId,
            token,
            clientMessageId: crypto.randomUUID(),
            content
          })
        }
      );
      options.input.value = '';
      options.notice(
        result.delivery === 'STEERED'
          ? translate('generated.workbenchRunnerChannelService.theMessageWasAddedToTheCurrent')
          : translate('generated.workbenchRunnerChannelService.theMessageWasNotDeliveredToThe'),
        result.delivery === 'STEERED' ? 'info' : 'error'
      );
    } catch (error) {
      options.notice(
        translate('generated.workbenchRunnerChannelService.unableToSendThroughTheClaudeChannel', {
          value0: options.errorMessage(error)
        }),
        'error',
        error
      );
    } finally {
      options.loading.value = false;
    }
  }

  return { refreshClaudeChannelToken: refreshToken, sendClaudeChannelMessage: sendMessage };
}
