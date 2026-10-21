export {
  elapsedDurationLabel,
  activeRecentRunStatus,
  recentRunTimeReference
} from './notification-presentation.js';
export {
  absoluteSessionTime,
  preciseElapsedDurationLabel,
  workingElapsedLabel
} from './time-presentation.js';
export { hostedConversationTitle } from './hosted-conversation-presentation.js';
export { absoluteMessageTime } from './conversation-presentation.js';
export { currentChangesBranch, fileSizeLabel } from './file-presentation.js';
export { errorMessage } from './error-presentation.js';
import { runnerLabel } from './runner-presentation.js';
export { runnerLabel } from './runner-presentation.js';
import { codexUsageLargeTokenFormat } from '../i18n/model-management.js';
import type { NodeSummary, Session, Workspace } from '../model/workbench.js';
import { currentLocale, translate } from '../service/LocalePreferenceService.js';
import { isKnownSessionActivityAt } from './session-list.js';

/** Native Session IDs keep `:` as their safe Server-routable separator. */
export function agentSessionPathId(sessionId: string): string {
  return encodeURIComponent(sessionId).replace(/%3A/gi, ':');
}

export function workspaceTabId(nodeId: string, workspaceId: string): string {
  return `${nodeId}:${workspaceId}`;
}

export function workspaceTabLabel(workspace: Workspace): string {
  if (workspace.displayName?.trim()) return workspace.displayName.trim();
  const components = workspace.path.split(/[\\/]/).filter(Boolean);
  return components.at(-1) || workspace.path;
}

export function workspaceKindLabel(workspace: Workspace): string {
  return workspace.kind === 'GIT_WORKSPACE' ? 'Git' : translate('workspace.directory');
}

export function workspaceBranchLabel(workspace: Workspace): string | undefined {
  if (workspace.kind !== 'GIT_WORKSPACE') return undefined;
  return workspace.gitSummary?.branch ?? 'HEAD';
}

export function tokenCountLabel(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

export function codexUsageTokenCountLabel(value: number | null): string {
  if (value === null) return '—';
  if (value < 100_000_000) return tokenCountLabel(value);
  const locale = currentLocale();
  const format = codexUsageLargeTokenFormat[locale];
  return translate('marAgentModels.codexUsageLargeTokens', {
    value: new Intl.NumberFormat(locale, {
      useGrouping: false,
      minimumFractionDigits: format.minimumFractionDigits,
      maximumFractionDigits: 1
    }).format(value / format.divisor)
  });
}

export function contextPercentageLabel(value: number): string {
  return `${Math.max(0, Math.round(value * 10) / 10)}%`;
}

export function noticePresentation(value: string): 'success' | 'warning' | 'error' | 'info' {
  if (new RegExp(translate('presentation.noticeErrorPattern'), 'iu').test(value)) return 'error';
  if (new RegExp(translate('presentation.noticeWarningPattern'), 'iu').test(value))
    return 'warning';
  if (new RegExp(translate('presentation.noticeCopyPattern'), 'iu').test(value)) return 'info';
  if (new RegExp(translate('presentation.noticeSuccessPattern'), 'iu').test(value))
    return 'success';
  return 'info';
}

export function runnerStatusLabel(node: NodeSummary): string {
  const codex = node.capabilities.codex;
  const claude = node.capabilities.claudeCode;
  const openCode = node.capabilities.openCode;
  const status = (available: boolean | undefined, version: string | undefined) =>
    available ? (version ?? translate('common.ready')) : translate('common.unavailable');
  return [
    `${runnerLabel('codex')} ${status(codex?.available, codex?.version)}`,
    `${runnerLabel('claude-code')} ${status(claude?.available, claude?.version)}`,
    `${runnerLabel('opencode')} ${status(openCode?.available, openCode?.version)}`
  ].join(' · ');
}

export function effortPresentation(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase()}${value.slice(1)}`;
}

export function nodePresentation(node: NodeSummary): string {
  return node.displayName?.trim() || node.registeredAddress || node.id;
}

export function sessionActivityTitle(
  session: Session,
  format: (value: number) => string
): string | undefined {
  return session.externalDiscovered === false || !isKnownSessionActivityAt(session.lastActivityAt)
    ? undefined
    : translate('presentation.lastActivity', { value: format(session.lastActivityAt) });
}

export function sessionActivityDateTime(session: Session): string | undefined {
  return session.externalDiscovered === false || !isKnownSessionActivityAt(session.lastActivityAt)
    ? undefined
    : new Date(session.lastActivityAt).toISOString();
}
