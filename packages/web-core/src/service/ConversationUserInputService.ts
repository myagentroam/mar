import type { MessageFeedback } from '../model/message-feedback.js';
import type { WorkspaceTarget } from '../model/workbench.js';
import { ref, type Ref } from 'vue';
import type { ConversationTurn } from '../model/workbench.js';
import { conversationPayload, conversationTurnHasRunId } from '../util/conversation-history.js';
import { userInputQuestions } from '../util/conversation-user-input.js';
import { translate } from './LocalePreferenceService.js';

export type ConversationUserInputAnswer = string | readonly string[];

export function userInputOtherAnswerId(questionId: string): string {
  return `${questionId}:other`;
}

export function createConversationUserInputService(options?: {
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly notice: MessageFeedback;
  readonly request: <T = unknown>(path: string, init?: RequestInit) => Promise<T>;
  readonly errorMessage: (error: unknown) => string;
  readonly missingRunError: (error: unknown) => boolean;
  readonly beginSubmission: (context?: string) => (() => boolean) | undefined;
}) {
  const answers = ref<Record<string, Record<string, ConversationUserInputAnswer>>>({});
  const submittedItemIds = ref<readonly string[]>([]);

  function answer(itemId: string, questionId: string): ConversationUserInputAnswer {
    return answers.value[itemId]?.[questionId] ?? '';
  }

  function submitted(itemId: string): boolean {
    return submittedItemIds.value.includes(itemId);
  }

  function setAnswer(itemId: string, questionId: string, value: ConversationUserInputAnswer): void {
    answers.value = {
      ...answers.value,
      [itemId]: { ...answers.value[itemId], [questionId]: value }
    };
  }

  function markSubmitted(itemId: string): void {
    if (!submitted(itemId)) submittedItemIds.value = [...submittedItemIds.value, itemId];
  }

  function clearSubmitted(itemId: string): void {
    submittedItemIds.value = submittedItemIds.value.filter((id) => id !== itemId);
  }

  function reset(): void {
    answers.value = {};
    submittedItemIds.value = [];
  }

  async function submit(
    turn: ConversationTurn,
    item: ConversationTurn['items'][number]
  ): Promise<void> {
    if (options === undefined) return;
    const payload = conversationPayload(item.payload);
    const requestId = typeof payload?.requestId === 'string' ? payload.requestId : '';
    const questions = userInputQuestions(item.payload);
    if (
      options.workspaceTarget.value?.nodeId === undefined ||
      !conversationTurnHasRunId(turn) ||
      requestId.length === 0 ||
      item.status !== 'PENDING' ||
      submitted(item.id)
    )
      return;
    const collected: Record<string, string[]> = {};
    for (const question of questions) {
      const rawAnswer = answer(item.id, question.id);
      const otherAnswer =
        question.input === 'MULTI_SELECT'
          ? answer(item.id, userInputOtherAnswerId(question.id))
          : '';
      const values = [
        ...(Array.isArray(rawAnswer) ? [...rawAnswer] : [rawAnswer]),
        ...(typeof otherAnswer === 'string' && otherAnswer.trim().length > 0 ? [otherAnswer] : [])
      ]
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      if (values.length === 0) {
        options.notice(
          translate('generated.conversationUserInputService.answerEveryQuestionBeforeSubmitting'),
          'warning'
        );
        return;
      }
      collected[question.id] = values;
    }
    const finishSubmission = options.beginSubmission(`session:${turn.sessionId}`);
    if (finishSubmission === undefined) return;
    try {
      await options.request(
        `/api/agent-runs/${encodeURIComponent(turn.runId)}/user-input/${encodeURIComponent(requestId)}`,
        {
          method: 'POST',
          body: JSON.stringify({
            nodeId: options.workspaceTarget.value?.nodeId,
            answers: collected
          })
        }
      );
      if (finishSubmission()) markSubmitted(item.id);
    } catch (error) {
      if (options.missingRunError(error)) return;
      if (finishSubmission())
        options.notice(
          translate('generated.conversationUserInputService.answersWereNotSubmitted', {
            value0: options.errorMessage(error)
          }),
          'error',
          error
        );
    } finally {
      finishSubmission();
    }
  }

  return {
    answers,
    submittedItemIds,
    answer,
    submitted,
    setAnswer,
    markSubmitted,
    clearSubmitted,
    reset,
    submit
  };
}
