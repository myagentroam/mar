import { ApiError, errorCode } from './api-error.js';
import { isComposerAttachmentResourcePath } from '@myagentroam/protocol';
import { translate } from '../service/LocalePreferenceService.js';

export function filePreviewErrorMessage(error: unknown, path: string): string {
  return errorMessage(
    error,
    errorCode(error) === 'FILE_NOT_FOUND' &&
      (isComposerAttachmentResourcePath(path) || path.startsWith('.mar/temp-files/'))
      ? translate('errors.attachmentExpired')
      : undefined
  );
}

export function errorMessage(error: unknown, summaryOverride?: string): string {
  const code = errorCode(error);
  let summary = summaryOverride;
  if (summary === undefined && code !== undefined) {
    const key = `errors.${code}`;
    const translated = translate(key, error instanceof ApiError ? error.parameters : undefined);
    if (translated !== key) summary = translated;
  }
  if (summary === undefined && error instanceof Error && error.message.trim().length > 0)
    summary = error.message;
  summary ??= translate('common.unknownError');
  if (!(error instanceof ApiError)) return summary;
  const diagnostics = [
    translate('errors.diagnosticCode', { value: error.code }),
    ...(error.details === undefined
      ? []
      : [translate('errors.diagnosticDetails', { value: error.details })]),
    ...(error.requestId === undefined
      ? []
      : [translate('errors.diagnosticRequestId', { value: error.requestId })]),
    ...(error.upstreamRequestId === undefined
      ? []
      : [translate('errors.diagnosticUpstreamRequestId', { value: error.upstreamRequestId })])
  ];
  return translate('errors.withDiagnostics', {
    summary,
    diagnostics: diagnostics.join('\n')
  });
}
