import { translate } from '../service/locale-preference-service.js';
import { errorCode } from '@myagentroam/web-core/api-error';

export function oauthErrorMessage(error: unknown, fallback: string): string {
  const code = errorCode(error) ?? error;
  if (typeof code !== 'string' || !/^[A-Z][A-Z0-9_]+$/u.test(code)) return fallback;
  const translated = translate(`oauthErrors.${code}`);
  return translated === `oauthErrors.${code}` ? fallback : translated;
}
