import type { Session } from '../model/workbench.js';
import claudeRunnerIcon from '../assets/runner-claude-code.png';
import codexRunnerIcon from '../assets/runner-codex.png';
import marAgentRunnerIcon from '../assets/logo-icon.png';
import openCodeRunnerIcon from '../assets/runner-opencode.svg';

export function runnerBrandIcon(value: Session['runner']): string {
  if (value === 'mar-agent') return marAgentRunnerIcon;
  if (value === 'codex') return codexRunnerIcon;
  return value === 'claude-code' ? claudeRunnerIcon : openCodeRunnerIcon;
}
