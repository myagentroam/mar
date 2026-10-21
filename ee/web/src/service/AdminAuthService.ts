import {
  createAdminAuthService as createSharedAdminAuthService,
  type AdminAuthStateOptions
} from '@myagentroam/web-core/auth';
import { translate, currentLocale, localePreferenceService } from './LocalePreferenceService.js';
export type { AdminState } from '@myagentroam/web-core/auth';

export function createAdminAuthService(options: Omit<AdminAuthStateOptions, 'presentation'>) {
  return createSharedAdminAuthService({
    ...options,
    presentation: {
      translate,
      currentLocale,
      setLocale: (locale) => localePreferenceService().setLocale(locale)
    }
  });
}
