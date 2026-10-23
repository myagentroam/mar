import type { ToolPresentation } from '@myagentroam/protocol';
import { translate } from '../service/LocalePreferenceService.js';
import { formatDateTime } from './time-presentation.js';

export function toolPresentation(payload: unknown): ToolPresentation | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const value = (payload as { toolPresentation?: ToolPresentation }).toolPresentation;
  return value && ['READ', 'WEB_SEARCH', 'WEB_FETCH', 'SKILL', 'SLEEP'].includes(value.kind)
    ? value
    : undefined;
}

export function toolPresentationTitle(payload: unknown): string {
  const value = toolPresentation(payload);
  return value ? translate(`toolPresentation.title.${value.kind}`) : '';
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
  if (value.kind === 'READ')
    return [toolPresentationStatus(status), ...(value.paths ?? [])].filter(Boolean).join(' · ');
  if (value.kind === 'SKILL')
    return [exceptional ? toolPresentationStatus(status) : '', value.name]
      .filter(Boolean)
      .join(' · ');
  if (value.kind === 'WEB_SEARCH') {
    const sources =
      status !== 'COMPLETED' || value.sourceCount === undefined
        ? ''
        : value.sourceCount === 0
          ? translate('toolPresentation.noResults')
          : translate('toolPresentation.sources', { count: value.sourceCount });
    return [toolPresentationStatus(status), value.query, sources].filter(Boolean).join(' · ');
  }
  if (value.kind === 'WEB_FETCH')
    return [
      toolPresentationStatus(status),
      status === 'COMPLETED' && value.title ? value.title : host(value.url ?? value.requestUrl)
    ]
      .filter(Boolean)
      .join(' · ');
  if (exceptional) return toolPresentationStatus(status);
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

export function toolPresentationDetails(payload: unknown): string {
  const value = toolPresentation(payload);
  if (!value) return '';
  const raw = payload as Record<string, unknown>;
  const line = (key: string, text: unknown): string =>
    typeof text === 'string' && text.length ? `${translate(key)}: ${text}` : '';
  const details = [line('toolPresentation.tool', raw.toolName)];
  if (value.kind === 'WEB_FETCH')
    details.push(
      line('toolPresentation.requestUrl', value.requestUrl),
      line('toolPresentation.finalUrl', value.url),
      line('toolPresentation.mode', value.mode),
      line('toolPresentation.httpStatus', value.status?.toString()),
      line('toolPresentation.contentType', value.contentType)
    );
  if (value.kind === 'SKILL')
    details.push(
      line('toolPresentation.description', value.description),
      line('toolPresentation.source', value.source)
    );
  if (value.kind === 'SLEEP')
    details.push(
      line(
        'toolPresentation.requestedDuration',
        value.durationMs === undefined ? undefined : durationLabel(value.durationMs)
      ),
      line(
        'toolPresentation.elapsedDuration',
        value.elapsedMs === undefined ? undefined : durationLabel(value.elapsedMs)
      ),
      line(
        'toolPresentation.wakeReason',
        value.wakeReason ? translate(`toolPresentation.wake.${value.wakeReason}`) : undefined
      )
    );
  details.push(line('presentation.input', raw.inputSummary));
  if (
    value.kind === 'READ' ||
    value.kind === 'SKILL' ||
    value.kind === 'WEB_FETCH' ||
    raw.errorCode
  )
    details.push(line('presentation.output', raw.outputSummary));
  details.push(line('presentation.error', raw.errorCode));
  if (raw.truncated === true) details.push(translate('toolPresentation.truncated'));
  return details.filter(Boolean).join(String.fromCharCode(10));
}
