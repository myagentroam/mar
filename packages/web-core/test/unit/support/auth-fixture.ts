import { ref } from 'vue';
import { createI18n } from 'vue-i18n';
import { vi } from 'vitest';
import {
  createAdminAuthService,
  type AdminAuthStateOptions
} from '../../../src/service/admin-auth-service.js';
import { createAdminSessionStateService } from '../../../src/service/admin-session-state-service.js';
import { authenticationEnUS, authenticationZhCN } from '../../../src/i18n/authentication.js';
import type { AppLocale } from '../../../src/i18n/locale-config.js';

export function authFixture(locale: AppLocale = 'zh-CN') {
  const storage = new Map<string, string>();
  vi.stubGlobal('window', {
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key)
    }
  });
  const i18n = createI18n({
    legacy: false,
    locale,
    messages: { 'en-US': authenticationEnUS, 'zh-CN': authenticationZhCN }
  });
  const state = createAdminSessionStateService();
  const request = vi.fn();
  const restore = vi.fn(async () => undefined);
  const signedOut = vi.fn();
  const notice = vi.fn();
  const loading = ref(false);
  const renew = vi.fn(async () => 'renewed');
  const service = createAdminAuthService({
    admin: state.admin,
    loaded: state.loaded,
    sessions: state.sessions,
    password: state.newPassword,
    passwordError: state.passwordValidationError,
    csrfToken: state.csrfToken,
    loading,
    request: request as AdminAuthStateOptions['request'],
    renewCsrfToken: renew,
    invalidateRequests: vi.fn(),
    onAuthenticated: restore,
    onSignedOut: signedOut,
    notice,
    errorMessage: (error) => (error instanceof Error ? error.message : 'UNKNOWN'),
    presentation: {
      translate: (key, params) => i18n.global.t(key, params ?? {}),
      currentLocale: () => i18n.global.locale.value,
      setLocale: (next) => {
        i18n.global.locale.value = next;
      }
    }
  });
  return { service, state, storage, request, restore, signedOut, notice, loading, renew, i18n };
}
