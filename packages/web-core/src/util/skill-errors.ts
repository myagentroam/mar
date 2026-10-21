import { translate } from '../service/LocalePreferenceService.js';
import { errorCode } from './api-error.js';

const SKILL_ERROR_CODES = new Set([
  'SKILL_SOURCE_IN_USE',
  'SKILL_SOURCE_LIMIT_EXCEEDED',
  'SKILL_SOURCE_QUERY_INVALID',
  'SKILL_SOURCE_PROVIDER_UNSUPPORTED',
  'SKILL_SOURCE_UNAVAILABLE',
  'SKILL_SOURCE_ADDRESS_FORBIDDEN',
  'SKILL_SOURCE_RATE_LIMITED',
  'SKILL_SOURCE_RESPONSE_INVALID',
  'SKILL_SOURCE_DISABLED',
  'SKILL_SOURCE_NOT_FOUND',
  'SKILL_SOURCE_FORBIDDEN',
  'SKILL_FAVORITE_NOT_FOUND',
  'SKILL_FAVORITE_FORBIDDEN',
  'SKILL_INSTALL_FAILED',
  'SKILL_INSTALL_STATUS_TIMEOUT',
  'SKILL_CONTENT_INVALID',
  'SKILL_INSTALL_INVALID_LINK',
  'SKILL_INSTALL_RECOVERY_REQUIRED',
  'SKILL_NAME_CONFLICT',
  'SKILL_TARGET_LIMIT_EXCEEDED',
  'WORKSPACE_BUSY',
  'WORKSPACE_SKILL_GIT_EXCLUDE_FAILED',
  'NODE_REQUEST_TIMEOUT',
  'NODE_OFFLINE'
]);

export function skillErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const code = errorCode(error);
  if (code !== undefined && SKILL_ERROR_CODES.has(code))
    return translate(`generated.skillErrors.${code}`);
  return code !== undefined && error.message === code ? fallback : error.message;
}
