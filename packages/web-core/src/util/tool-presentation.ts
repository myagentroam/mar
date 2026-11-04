import type { ToolPresentation } from '@myagentroam/protocol';
import { translate } from '../service/locale-preference-service.js';
import { conversationUiEnUS } from '../i18n/conversation-ui.en-US.js';
import { formatDateTime } from './time-presentation.js';

export function toolPresentation(
  payload: unknown
):
  | Extract<ToolPresentation, { kind: 'READ' | 'WEB_SEARCH' | 'WEB_FETCH' | 'SKILL' | 'SLEEP' }>
  | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const value = (payload as { toolPresentation?: ToolPresentation }).toolPresentation;
  return value &&
    !('detailOnly' in value && value.detailOnly === true) &&
    (value.kind === 'READ' ||
      value.kind === 'WEB_SEARCH' ||
      value.kind === 'WEB_FETCH' ||
      value.kind === 'SKILL' ||
      value.kind === 'SLEEP')
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

export function durationLabel(ms: number): string {
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

export function toolPresentationLink(value: string) {
  let href: string | undefined;
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') href = url.href;
  } catch {
    /* Keep unsupported URLs as plain text. */
  }
  return { url: value, href, host: host(value) };
}

/** Detail-only facts do not opt a tool into independent timeline rows. */
export function webToolPresentation(payload: unknown) {
  if (!payload || typeof payload !== 'object') return undefined;
  const value = (payload as { toolPresentation?: ToolPresentation }).toolPresentation;
  return value?.kind === 'WEB_SEARCH' || value?.kind === 'WEB_FETCH' ? value : undefined;
}

export function toolPresentationSources(value: Extract<ToolPresentation, { kind: 'WEB_SEARCH' }>) {
  return (value.sources ?? []).map((source) => ({
    ...source,
    ...toolPresentationLink(source.url)
  }));
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

function readLineRange(
  startLine: number | undefined,
  endLine: number | undefined
): string | undefined {
  if (startLine === undefined) return undefined;
  return endLine === undefined || endLine === startLine
    ? String(startLine)
    : `${startLine}–${endLine}`;
}

export function toolPresentationReadRange(payload: unknown, path: string): string {
  const value = toolPresentation(payload);
  if (value?.kind !== 'READ') return '';
  const results = (value.results ?? []).filter((item) => item.path === path);
  if (
    results.length > 1 &&
    results.some((item) => readLineRange(item.startLine, item.endLine) === undefined)
  )
    return '';
  return results
    .map((item) => readLineRange(item.startLine, item.endLine))
    .filter((range): range is string => range !== undefined)
    .join(', ');
}

/** Read only the public output intervals owned by the selected file. */
export function readFileDetail(payload: Record<string, unknown>, path: string): string | undefined {
  const presentation = toolPresentation(payload);
  if (presentation?.kind !== 'READ') return undefined;
  const results = presentation.results?.filter((item) => item.path === path);
  if (!results?.length) return undefined;
  if (
    results.length > 1 &&
    results.some((item) => readLineRange(item.startLine, item.endLine) === undefined)
  )
    return undefined;
  const output = readToolOutput(payload);
  if (
    results.some((item) => !item.contentRange && !item.error && !item.empty) &&
    !output?.truncation
  )
    return undefined;
  const sections = results
    .map((item) => {
      let text: string;
      if (item.error) text = `${item.error.code}: ${item.error.message}`;
      else if (item.empty) text = translate('toolPresentation.detail.empty');
      else {
        const block = output?.blocks.find((entry) => entry.channel === item.contentRange?.channel);
        if (!item.contentRange || !block)
          text = output?.truncation ? '' : translate('toolPresentation.detail.truncated');
        else {
          const content = block.text.slice(item.contentRange.start, item.contentRange.end);
          text = content || translate('toolPresentation.detail.empty');
        }
      }
      const range = results.length > 1 ? readLineRange(item.startLine, item.endLine) : undefined;
      return range && text.length > 0
        ? `${translate('toolPresentation.detail.lineRange', { range })}\n${text}`
        : text;
    })
    .filter((section) => section.length > 0);
  if (output?.truncation === 'HEAD')
    sections.unshift(translate('toolPresentation.detail.truncated'));
  else if (output?.truncation === 'SOURCE')
    sections.push(translate('toolPresentation.detail.truncated'));
  return sections.join('\n\n');
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
  if (value.kind === 'WEB_SEARCH') details.push(line(labels.detail.query, value.query));
  if (value.kind === 'WEB_FETCH')
    details.push(
      line(labels.detail.title, value.title),
      line(labels.requestUrl, value.requestUrl),
      line(labels.finalUrl, value.url),
      line(labels.mode, value.mode),
      line(labels.httpStatus, value.status?.toString()),
      line(labels.contentType, value.contentType)
    );
  if (value.kind === 'SKILL')
    details.push(
      line(labels.detail.name, value.name),
      line(labels.description, value.description),
      line(labels.source, value.source)
    );
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
  if (value.kind === 'WEB_SEARCH' && value.sourcesOnly && value.sources?.length === 0)
    details.push(translate('toolPresentation.noResults'));
  if (value.kind === 'WEB_SEARCH') {
    if (readToolOutput(raw)?.truncation)
      details.push(translate('toolPresentation.detail.truncated'));
  } else if (!(value.kind === 'SLEEP' && value.elapsedMs !== undefined))
    details.push(toolOutputDetail(raw));
  details.push(line(conversationUiEnUS.presentation.error, raw.errorCode));
  if (typeof raw.errorMessage === 'string' && raw.errorMessage) details.push(raw.errorMessage);
  return details.filter(Boolean).join(String.fromCharCode(10));
}

/** Detail-only kinds deliberately do not affect the legacy grouping projection. */
export function detailOnlyToolText(payload: Record<string, unknown>): string | undefined {
  const value = payload.toolPresentation as ToolPresentation | undefined;
  if (
    !value ||
    (value.kind !== 'IMAGE_VIEW' &&
      value.kind !== 'TOOL_SEARCH' &&
      value.kind !== 'COMPACT_REQUEST' &&
      !((value.kind === 'WEB_SEARCH' || value.kind === 'WEB_FETCH') && value.detailOnly === true))
  )
    return undefined;
  const lines: string[] = [];
  const labels = conversationUiEnUS.toolPresentation;
  const field = (label: string, text: unknown) => {
    if (typeof text === 'string' && text) lines.push(`${label}: ${text}`);
  };
  field(labels.detail.tool, payload.toolName);
  field(conversationUiEnUS.presentation.input, payload.inputSummary);
  if (payload.inputTruncated === true) lines.push(translate('toolPresentation.detail.truncated'));
  if (value.kind === 'WEB_FETCH') {
    field(labels.requestUrl, value.requestUrl);
    field(labels.finalUrl, value.url);
    field(labels.detail.title, value.title);
    lines.push(toolOutputDetail(payload));
  } else if (value.kind === 'WEB_SEARCH') {
    field(labels.detail.query, value.query);
    lines.push(toolOutputDetail(payload));
  } else if (value.kind === 'IMAGE_VIEW') {
    field(labels.detail.path, value.path);
    field(labels.detail.resource, value.resourceId);
    field(labels.detail.format, value.mimeType);
    if (typeof value.width === 'number' && typeof value.height === 'number')
      lines.push(`${labels.detail.size}: ${value.width} × ${value.height}`);
    if (typeof value.sourceWidth === 'number' && typeof value.sourceHeight === 'number')
      lines.push(`${labels.detail.sourceSize}: ${value.sourceWidth} × ${value.sourceHeight}`);
    if (value.region) {
      const region = value.region;
      lines.push(
        `${labels.detail.region}: ${region.x}, ${region.y} · ${region.width} × ${region.height}`
      );
    }
    if (value.resize) {
      const resize = value.resize;
      lines.push(
        `${labels.detail.resize}: ${[resize.maxWidth, resize.maxHeight].filter((n) => n !== undefined).join(' × ')}`
      );
    }
    lines.push(translate('toolPresentation.detail.imageUnavailable'));
  } else if (value.kind === 'TOOL_SEARCH') {
    field(labels.detail.query, value.query);
    if (value.tools !== undefined)
      lines.push(
        value.tools.length ? value.tools.join('\n') : translate('toolPresentation.noResults')
      );
    else lines.push(toolOutputDetail(payload));
  } else if (value.kind === 'COMPACT_REQUEST' && value.accepted === true)
    lines.push(translate('toolPresentation.detail.compactAccepted'));
  else lines.push(toolOutputDetail(payload));
  field(labels.detail.error, payload.errorCode);
  if (typeof payload.errorMessage === 'string') lines.push(payload.errorMessage);
  return lines.filter(Boolean).join('\n');
}
