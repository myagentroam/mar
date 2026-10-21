import { localizedRunnerCommandState } from './runner-presentation.js';
export { localizedRunnerCommandState } from './runner-presentation.js';
import type { ConversationTurn, RunnerCommandState } from '../model/workbench.js';
import { conversationItemText } from './conversation-presentation.js';
import { translate } from '../service/LocalePreferenceService.js';
import { composerMessagePresentation } from './composer-message.js';
import { toolPresentation } from './tool-presentation.js';

type ConversationItem = ConversationTurn['items'][number];

export function displayConversationItem(item: ConversationItem, runId?: string | null): boolean {
  if (item.kind === 'tool_call' && toolPresentation(item.payload)) return true;
  if (item.kind === 'user_input_request' && item.status === 'PENDING' && !runId) return false;
  if (item.kind === 'user_message') {
    const input = composerMessagePresentation(item.payload);
    if (
      input.files.length > 0 ||
      input.goal !== undefined ||
      input.scheduled ||
      input.restarted ||
      input.sessionOrigin !== undefined ||
      input.channel !== undefined
    )
      return true;
  }
  return (
    item.kind !== 'turn_summary' &&
    (item.kind === 'user_input_request' ||
      item.kind === 'approval_request' ||
      conversationItemText(item.kind, item.payload, item.status).trim().length > 0)
  );
}

export function activePlanContinuation(input: {
  readonly item: ConversationItem;
  readonly turns: readonly ConversationTurn[];
  readonly commandStates: readonly RunnerCommandState[] | undefined;
  readonly steering: boolean;
  readonly canStartTurn: boolean;
}): RunnerCommandState | undefined {
  if (input.item.kind !== 'plan' || input.steering || !input.canStartTurn) return undefined;
  const latest = input.turns
    .flatMap((turn) => turn.items.filter((item) => item.kind === 'plan'))
    .at(-1);
  if (latest?.id !== input.item.id) return undefined;
  return (
    input.commandStates
      ?.filter((state) => state.active && state.continuation != null)
      .map(localizedRunnerCommandState)[0] ?? {
      commandId: 'historical-plan',
      active: false,
      label: translate('runnerProfiles.planModeLabel'),
      detail: translate('generated.conversationDomain.thisHistoricalPlanCanBeImplementedDirectly'),
      closable: false,
      closeInput: null,
      continuation: {
        label: translate('generated.conversationDomain.implement'),
        prompt: translate('generated.conversationDomain.implementThePlanAbove')
      }
    }
  );
}
