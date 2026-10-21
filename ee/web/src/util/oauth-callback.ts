import { translate } from '../service/LocalePreferenceService.js';
import { errorCode } from './api-error.js';

export function oauthErrorMessage(error: unknown, fallback: string): string {
  const code = errorCode(error) ?? error;
  if (typeof code !== 'string' || !/^[A-Z][A-Z0-9_]+$/u.test(code)) return fallback;
  const translated = translate(`oauthErrors.${code}`);
  return translated === `oauthErrors.${code}` ? fallback : translated;
}
