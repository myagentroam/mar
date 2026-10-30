import type { ToolPresentation } from '@myagentroam/protocol';
import { translate } from '../service/locale-preference-service.js';
import { conversationUiEnUS } from '../i18n/conversation-ui.en-US.js';
import { formatDateTime } from './time-presentation.js';

export function toolPresentation(
  payload: unknown
): Exclude<ToolPresentation, { kind: 'EXECUTION' }> | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const value = (payload as { toolPresentation?: ToolPresentation }).toolPresentation;
  return value &&
    value.kind !== 'EXECUTION' &&
    ['READ', 'WEB_SEARCH', 'WEB_FETCH', 'SKILL', 'SLEEP'].includes(value.kind)
    ? value
    : undefined;
}

export function toolPresentationTitle(payload: unknown): string {
  const value = toolPresentation(payload);
  return value ? translate(`toolPresentation.title.${value.kind}`) : '';
}

export function toolPresentationReadPaths(payload: unknown): readonly string[] {
  const value = toolPresentation(payload);
  return value?.kind === 'READ'
    ? [...new Set((value.paths ?? []).filter((path) => path.length > 0))]
    : [];
}

export function toolPresentationStatus(status: string): string {
  const key =
    status === 'COMPLETED'
      ? 'completed'
      : status === 'FAILED' || status === 'DECLINED'
        ? 'failed'
        : status === 'CANCELLED' || status === 'INTERRUPTED'
          ? 'cancelled'
          : 'running';
  return translate(`toolPresentation.status.${key}`);
}

function durationLabel(ms: number): string {
  if (ms > 0 && ms < 1000) return translate('toolPresentation.milliseconds', { value: ms });
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return [
    hours ? translate('toolPresentation.hours', { value: hours }) : '',
    minutes ? translate('toolPresentation.minutes', { value: minutes }) : '',
    seconds % 60 || seconds === 0
      ? translate('toolPresentation.seconds', { value: seconds % 60 })
      : ''
  ]
    .filter(Boolean)
    .join(' ');
}

function host(url: string | undefined): string {
  try {
    return new URL(url ?? '').host;
  } catch {
    return '';
  }
}

export function toolPresentationText(payload: unknown, status: string): string {
  const value = toolPresentation(payload);
  if (!value) return '';
  const exceptional = ['FAILED', 'DECLINED', 'CANCELLED', 'INTERRUPTED'].includes(status);
  if (value.kind === 'READ') {
    const paths = toolPresentationReadPaths(payload);
    const first = paths[0];
    if (!first) return '';
    const name = first.split(/[\\/]/u).at(-1) || first;
    return paths.length > 1
      ? `${name} · ${translate('toolPresentation.moreFiles', { count: paths.length - 1 })}`
      : name;
  }
  if (value.kind === 'SKILL') return value.name ?? '';
  if (value.kind === 'WEB_SEARCH') {
    const sources =
      status !== 'COMPLETED' || value.sourceCount === undefined
        ? ''
        : value.sourceCount === 0
          ? translate('toolPresentation.noResults')
          : translate('toolPresentation.sources', { count: value.sourceCount });
    return [value.query, sources].filter(Boolean).join(' · ');
  }
  if (value.kind === 'WEB_FETCH')
    return status === 'COMPLETED' && value.title
      ? value.title
      : host(value.url ?? value.requestUrl);
  if (exceptional) return '';
  if (status === 'COMPLETED')
    return value.elapsedMs === undefined
      ? ''
      : translate('toolPresentation.waited', { elapsed: durationLabel(value.elapsedMs) });
  if (value.durationMs === undefined) return '';
  const duration = durationLabel(value.durationMs);
  if ((status === 'IN_PROGRESS' || status === 'PENDING') && value.startedAt) {
    const start = formatDateTime(Date.parse(value.startedAt));
    const end = formatDateTime(Date.parse(value.startedAt) + value.durationMs);
    const time = start.slice(0, 10) === end.slice(0, 10) ? end.slice(11, 16) : end.slice(0, 16);
    return translate('toolPresentation.waitingUntil', { duration, time });
  }
  return status === 'IN_PROGRESS' || status === 'PENDING'
    ? translate('toolPresentation.waiting', { duration })
    : '';
}

export function toolPresentationSources(payload: unknown) {
  const value = toolPresentation(payload);
  if (value?.kind !== 'WEB_SEARCH') return [];
  return (value.sources ?? []).map((source) => {
    let href: string | undefined;
    try {
      const url = new URL(source.url);
      if (url.protocol === 'http:' || url.protocol === 'https:') href = url.href;
    } catch {
      /* Keep unsupported URLs as plain text. */
    }
    return { ...source, href, host: host(source.url) };
  });
}

export function readToolOutput(payload: Record<string, unknown>) {
  const raw = payload.output;
  if (raw && typeof raw === 'object') {
    const output = raw as Record<string, unknown>;
    if (Array.isArray(output.blocks))
      return {
        blocks: output.blocks as Array<{
          channel: 'TEXT' | 'STDOUT' | 'STDERR' | 'COMBINED';
          text: string;
        }>,
        truncation: output.truncation as 'HEAD' | 'SOURCE' | undefined
      };
    if (typeof output.text === 'string')
      return {
        blocks: [{ channel: 'TEXT' as const, text: output.text }],
        truncation: output.truncated === true ? ('SOURCE' as const) : undefined
      };
  }
  if (typeof payload.outputSummary === 'string')
    return {
      blocks: [{ channel: 'TEXT' as const, text: payload.outputSummary }],
      truncation: payload.outputSummaryTruncated === true ? ('SOURCE' as const) : undefined
    };
  return undefined;
}

export function toolOutputDetail(
  payload: Record<string, unknown>,
  label: string = conversationUiEnUS.presentation.output
): string {
  const output = readToolOutput(payload);
  const text =
    output?.blocks
      .map((block) => block.text)
      .filter(Boolean)
      .join('\n') ?? '';
  return [
    output?.truncation === 'HEAD' ? translate('toolPresentation.detail.truncated') : '',
    text ? `${label}:\n${text}` : '',
    output?.truncation === 'SOURCE' ? translate('toolPresentation.detail.truncated') : ''
  ]
    .filter(Boolean)
    .join('\n');
}

export function toolPresentationDetails(payload: unknown): string {
  const value = toolPresentation(payload);
  if (!value) return '';
  const raw = payload as Record<string, unknown>;
  const line = (label: string, text: unknown): string =>
    typeof text === 'string' && text.length ? `${label}: ${text}` : '';
  const labels = conversationUiEnUS.toolPresentation;
  const details = [line(labels.tool, raw.toolName)];
  if (value.kind === 'WEB_FETCH')
    details.push(
      line(labels.requestUrl, value.requestUrl),
      line(labels.finalUrl, value.url),
      line(labels.mode, value.mode),
      line(labels.httpStatus, value.status?.toString()),
      line(labels.contentType, value.contentType)
    );
  if (value.kind === 'SKILL')
    details.push(line(labels.description, value.description), line(labels.source, value.source));
  if (value.kind === 'SLEEP')
    details.push(
      line(
        labels.requestedDuration,
        value.durationMs === undefined ? undefined : durationLabel(value.durationMs)
      ),
      line(
        labels.elapsedDuration,
        value.elapsedMs === undefined ? undefined : durationLabel(value.elapsedMs)
      ),
      line(
        labels.wakeReason,
        value.wakeReason ? translate(`toolPresentation.wake.${value.wakeReason}`) : undefined
      )
    );
  details.push(line(conversationUiEnUS.presentation.input, raw.inputSummary));
  if (raw.inputTruncated === true) details.push(translate('toolPresentation.detail.truncated'));
  details.push(toolOutputDetail(raw));
  details.push(line(conversationUiEnUS.presentation.error, raw.errorCode));
  if (typeof raw.errorMessage === 'string' && raw.errorMessage) details.push(raw.errorMessage);
  return details.filter(Boolean).join(String.fromCharCode(10));
}
