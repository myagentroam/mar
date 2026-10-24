import type { Session, RunnerCommandState } from '../model/workbench.js';
import { translate } from '../service/locale-preference-service.js';

export function runnerLabel(runner: Session['runner']): string {
  if (runner === 'mar-agent') return translate('common.marAgent');
  if (runner === 'claude-code') return translate('common.claudeCode');
  return runner === 'opencode' ? translate('common.openCode') : translate('common.codex');
}

export function localizedRunnerCommandState(state: RunnerCommandState): RunnerCommandState {
  if (state.commandId === 'goal') return { ...state, label: translate('goal.title') };
  if (state.commandId !== 'plan') return state;
  return {
    ...state,
    label: translate('runnerProfiles.planModeLabel'),
    detail: translate('nodeMessages.planDetail'),
    ...(state.continuation === undefined
      ? {}
      : {
          continuation:
            state.continuation === null
              ? null
              : {
                  label: translate('nodeMessages.implement'),
                  prompt: translate('nodeMessages.implementPrompt')
                }
        })
  };
}
