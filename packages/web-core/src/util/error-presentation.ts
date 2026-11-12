import { ApiError, errorCode } from './api-error.js';
import { isComposerAttachmentResourcePath } from '@myagentroam/protocol';
import { translate } from '../service/locale-preference-service.js';

export function filePreviewErrorMessage(error: unknown, path: string): string {
  return errorMessage(
    error,
    errorCode(error) === 'FILE_NOT_FOUND' &&
      (isComposerAttachmentResourcePath(path) || path.startsWith('.mar/temp-files/'))
      ? translate('errors.attachmentExpired')
      : undefined
  );
}

export function filePreviewErrorSummary(error: unknown, path: string): string {
  const code = errorCode(error);
  if (
    code === 'FILE_NOT_FOUND' &&
    (isComposerAttachmentResourcePath(path) || path.startsWith('.mar/temp-files/'))
  )
    return translate('errors.attachmentExpired');
  if (code === 'HOSTED_CONVERSATION_FILE_NOT_FOUND')
    return translate('hostedConversations.fileNotFound');
  return localizedErrorSummary(error) ?? translate('filePreview.loadFailed');
}

function localizedErrorSummary(error: unknown): string | undefined {
  const code = errorCode(error);
  if (code === undefined) return undefined;
  const key = `errors.${code}`;
  const translated = translate(key, error instanceof ApiError ? error.parameters : undefined);
  return translated === key ? undefined : translated;
}

/** Human summary for inline states; the original error retains all diagnostics. */
export function errorSummary(error: unknown, fallback = translate('common.unknownError')): string {
  return (
    localizedErrorSummary(error) ??
    (error instanceof Error && error.message.trim().length > 0 ? error.message : fallback)
  );
}

export function errorMessage(error: unknown, summaryOverride?: string): string {
  const summary = summaryOverride ?? errorSummary(error);
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
