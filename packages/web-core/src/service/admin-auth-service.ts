import { absoluteSessionTime as formatSessionTime } from '../util/workbench-presentation.js';
import type { MessageFeedback } from '../model/message-feedback.js';
import type { UserSessionSummary } from '../model/workbench.js';
import { computed, proxyRefs, ref, type Ref } from 'vue';
import type { AppLocale } from '../i18n/locale-config.js';
import { ApiError } from '../util/api-error.js';

export interface AuthenticationPresentation {
  readonly translate: (key: string, parameters?: Record<string, string | number>) => string;
  readonly currentLocale: () => AppLocale;
  readonly setLocale: (locale: AppLocale) => void;
}

export interface AdminState {
  readonly authenticated: boolean;
  readonly mustChangePassword: boolean;
  readonly username?: string;
  readonly isAdmin?: boolean;
  readonly edition?: 'COMMUNITY' | 'ENTERPRISE';
  readonly licenseState?: 'COMMUNITY' | 'ENTERPRISE_VALID' | 'ENTERPRISE_FROZEN';
  readonly role?: 'ADMIN' | 'ORG_ADMIN' | 'MEMBER' | null;
  readonly organizationId?: number | null;
  readonly managementWritable?: boolean;
  readonly locale?: AppLocale;
}

export interface AdminAuthStateOptions {
  readonly presentation: AuthenticationPresentation;
  readonly admin: Ref<AdminState>;
  readonly loaded: Ref<boolean>;
  readonly sessions: Ref<readonly UserSessionSummary[]>;
  readonly password: Ref<string>;
  readonly passwordError: Ref<string>;
  readonly csrfToken: Ref<string>;
  readonly loading: Ref<boolean>;
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly renewCsrfToken: () => Promise<string>;
  readonly invalidateRequests: () => void;
  readonly onAuthenticated: () => Promise<void>;
  readonly onSignedOut: () => void;
  readonly notice: MessageFeedback;
  readonly errorMessage: (error: unknown) => string;
}

const CSRF_STORAGE_KEY = 'mar.user.csrf-token';
const MIN_PASSWORD_LENGTH = 8;

export function createAdminAuthService(options: AdminAuthStateOptions) {
  const { translate, currentLocale } = options.presentation;
  let identityGeneration = 0;
  let refreshGeneration = 0;
  let sessionRefreshGeneration = 0;
  const authenticationUnknown = ref(false);
  const restoring = ref(false);

  async function syncBrowserLocale(
    serverLocale: AppLocale | undefined,
    isCurrent: () => boolean
  ): Promise<void> {
    while (serverLocale !== undefined && isCurrent()) {
      const locale = currentLocale();
      if (serverLocale === locale) return;
      try {
        await options.request('/api/auth/preferences/locale', {
          method: 'PUT',
          body: JSON.stringify({ locale })
        });
      } catch {
        if (isCurrent()) options.notice(translate('common.localeUpdateFailed'), 'error');
        return;
      }
      serverLocale = locale;
    }
  }

  function replaceIdentity(): number {
    identityGeneration += 1;
    refreshGeneration += 1;
    options.invalidateRequests();
    return identityGeneration;
  }

  async function restoreAuthenticatedWorkbench(generation: number): Promise<void> {
    try {
      await options.onAuthenticated();
    } catch (error) {
      if (generation !== identityGeneration) return;
      options.notice(
        translate('generated.adminAuthService.workbenchRecoveryFailed', {
          value0: options.errorMessage(error)
        }),
        'error',
        error
      );
    }
  }

  function returnToLogin(): void {
    replaceIdentity();
    options.admin.value = { authenticated: false, mustChangePassword: false };
    options.loaded.value = true;
    authenticationUnknown.value = false;
    restoring.value = false;
    options.loading.value = false;
    options.sessions.value = [];
    options.csrfToken.value = '';
    window.sessionStorage.removeItem(CSRF_STORAGE_KEY);
    options.onSignedOut();
  }

  async function refresh(): Promise<void> {
    const generation = ++refreshGeneration;
    const identity = identityGeneration;
    const isCurrent = () => generation === refreshGeneration && identity === identityGeneration;
    restoring.value = true;
    try {
      const nextAdmin = await options.request<AdminState>('/api/auth/me');
      if (!isCurrent()) return;
      if (!nextAdmin.authenticated) {
        returnToLogin();
        return;
      }
      const storedCsrfToken = window.sessionStorage.getItem(CSRF_STORAGE_KEY) ?? '';
      if (storedCsrfToken.length === 0) await options.renewCsrfToken();
      if (!isCurrent()) return;
      if (storedCsrfToken.length > 0) options.csrfToken.value = storedCsrfToken;
      options.admin.value = nextAdmin;
      authenticationUnknown.value = false;
      // Authentication is a Server-local fact. Reveal the shell before Node-backed
      // restoration so a busy or offline Node cannot leave the refresh gate blank.
      options.loaded.value = true;
      if (nextAdmin.authenticated) await syncBrowserLocale(nextAdmin.locale, isCurrent);
      if (!isCurrent()) return;
      if (nextAdmin.authenticated && !nextAdmin.mustChangePassword)
        await restoreAuthenticatedWorkbench(identity);
    } catch (error) {
      if (!isCurrent()) return;
      if (error instanceof ApiError && error.code === 'UNAUTHENTICATED') returnToLogin();
      else {
        if (!options.admin.value.authenticated) {
          authenticationUnknown.value = true;
          options.loaded.value = true;
        }
        options.notice(
          translate('generated.adminAuthService.authenticationRecoveryFailed', {
            value0: options.errorMessage(error)
          }),
          'error',
          error
        );
      }
    } finally {
      if (isCurrent()) restoring.value = false;
    }
  }

  async function refreshSessions(): Promise<void> {
    const identity = identityGeneration;
    const generation = ++sessionRefreshGeneration;
    const isCurrent = () =>
      identity === identityGeneration && generation === sessionRefreshGeneration;
    if (!options.admin.value.authenticated || options.admin.value.mustChangePassword) {
      options.sessions.value = [];
      return;
    }
    try {
      const result = await options.request<{ sessions: readonly UserSessionSummary[] }>(
        '/api/auth/sessions'
      );
      if (isCurrent()) options.sessions.value = result.sessions;
    } catch (error) {
      if (!isCurrent()) return;
      options.sessions.value = [];
      options.notice(
        translate('generated.adminAuthService.unableToLoadSignInSessions', {
          value0: options.errorMessage(error)
        }),
        'error',
        error
      );
    }
  }

  async function logoutSession(session: UserSessionSummary): Promise<void> {
    const generation = identityGeneration;
    options.loading.value = true;
    try {
      await options.request(`/api/auth/sessions/${encodeURIComponent(session.id)}`, {
        method: 'DELETE'
      });
      if (generation !== identityGeneration) return;
      if (session.current) returnToLogin();
      else await refreshSessions();
    } catch (error) {
      if (generation !== identityGeneration) return;
      options.notice(
        translate('generated.adminAuthService.unableToRevokeTheSignInSession', {
          value0: options.errorMessage(error)
        }),
        'error',
        error
      );
    } finally {
      if (generation === identityGeneration) options.loading.value = false;
    }
  }

  async function login(credentials: {
    readonly username: string;
    readonly password: string;
  }): Promise<void> {
    const generation = replaceIdentity();
    options.loading.value = true;

    try {
      const result = await options.request<AdminState & { csrfToken: string }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ ...credentials, locale: currentLocale() })
      });
      if (generation !== identityGeneration) return;
      options.invalidateRequests();
      refreshGeneration += 1;
      options.csrfToken.value = result.csrfToken;
      window.sessionStorage.setItem(CSRF_STORAGE_KEY, result.csrfToken);
      options.admin.value = result;
      authenticationUnknown.value = false;
      await syncBrowserLocale(result.locale, () => generation === identityGeneration);
      if (generation !== identityGeneration) return;
      if (!result.mustChangePassword) await restoreAuthenticatedWorkbench(generation);
    } catch (error) {
      if (generation !== identityGeneration) return;
      options.notice(
        translate('generated.adminAuthService.signInFailed', {
          value0: options.errorMessage(error)
        }),
        'error',
        error
      );
    } finally {
      if (generation === identityGeneration) options.loading.value = false;
    }
  }

  async function recoverPasswordChange(generation: number): Promise<void> {
    try {
      await restoreAuthenticatedWorkbench(generation);
      if (generation !== identityGeneration) return;
      await refreshSessions();
    } catch (error) {
      if (generation !== identityGeneration) return;
      options.notice(
        translate('generated.adminAuthService.unableToUpdateThePassword', {
          value0: options.errorMessage(error)
        }),
        'error',
        error
      );
    } finally {
      if (generation === identityGeneration) options.loading.value = false;
    }
  }

  async function changePassword(input: {
    readonly currentPassword: string;
    readonly password: string;
    readonly confirmation: string;
  }): Promise<boolean> {
    if (input.password.length < MIN_PASSWORD_LENGTH) {
      options.passwordError.value = translate(
        'generated.adminAuthService.theNewPasswordMustContainAtLeast',
        { value0: MIN_PASSWORD_LENGTH }
      );
      return false;
    }
    if (input.password !== input.confirmation) {
      options.passwordError.value = translate(
        'generated.adminAuthService.theNewPasswordsDoNotMatch'
      );
      return false;
    }
    const generation = replaceIdentity();
    let recoveryStarted = false;
    options.passwordError.value = '';
    options.loading.value = true;

    try {
      const result = await options.request<AdminState & { csrfToken: string }>(
        '/api/auth/change-password',
        {
          method: 'POST',
          body: JSON.stringify({ currentPassword: input.currentPassword, password: input.password })
        }
      );
      if (generation !== identityGeneration) return false;
      options.invalidateRequests();
      refreshGeneration += 1;
      options.csrfToken.value = result.csrfToken;
      window.sessionStorage.setItem(CSRF_STORAGE_KEY, result.csrfToken);
      options.admin.value = result;
      options.password.value = '';
      options.notice(
        translate('generated.adminAuthService.passwordUpdatedPreviousSignInSessionsWere'),
        'success'
      );
      recoveryStarted = true;
      void recoverPasswordChange(generation);
      return true;
    } catch (error) {
      if (generation !== identityGeneration) return false;
      options.notice(
        translate('generated.adminAuthService.unableToUpdateThePassword', {
          value0: options.errorMessage(error)
        }),
        'error',
        error
      );
      return false;
    } finally {
      if (!recoveryStarted && generation === identityGeneration) options.loading.value = false;
    }
  }

  async function logout(): Promise<void> {
    const generation = identityGeneration;
    options.loading.value = true;
    try {
      await options.request('/api/auth/logout', { method: 'POST' });
      if (generation !== identityGeneration) return;
      returnToLogin();
    } catch (error) {
      if (generation !== identityGeneration) return;
      options.notice(
        translate('generated.adminAuthService.unableToSignOut', {
          value0: options.errorMessage(error)
        }),
        'error',
        error
      );
    } finally {
      if (generation === identityGeneration) options.loading.value = false;
    }
  }

  return {
    view: proxyRefs({
      admin: options.admin,
      adminLoaded: options.loaded,
      authenticationUnknown,
      authenticationRestoring: restoring,
      adminSessions: options.sessions,
      changePassword,
      csrfToken: options.csrfToken,
      formatSessionTime,
      loading: options.loading,
      locked: computed(
        () => options.admin.value.authenticated && options.admin.value.mustChangePassword
      ),
      login,
      logout,
      logoutAdminSession: logoutSession,
      newPassword: options.password,
      passwordValidationError: options.passwordError,
      refreshAdmin: refresh,
      refreshAdminSessions: refreshSessions,
      renewCsrfToken: options.renewCsrfToken,
      request: options.request
    }),
    authenticationUnknown,
    restoring,
    returnToLogin,
    refresh,
    refreshSessions,
    logoutSession,
    login,
    changePassword,
    logout
  };
}

export interface WorkbenchIdentityView {
  admin: {
    readonly authenticated: boolean;
    readonly mustChangePassword: boolean;
    readonly username?: string;
    readonly isAdmin?: boolean;
    readonly edition?: 'COMMUNITY' | 'ENTERPRISE';
    readonly licenseState?: 'COMMUNITY' | 'ENTERPRISE_VALID' | 'ENTERPRISE_FROZEN';
    readonly role?: 'ADMIN' | 'ORG_ADMIN' | 'MEMBER' | null;
    readonly organizationId?: number | null;
    readonly managementWritable?: boolean;
    readonly locale?: AppLocale;
  };
  adminLoaded: boolean;
  authenticationUnknown: boolean;
  authenticationRestoring: boolean;
  adminSessions: readonly {
    readonly id: string;
    readonly createdAt: number;
    readonly expiresAt: number;
    readonly ipAddress: string;
    readonly userAgent: string;
    readonly current: boolean;
  }[];
  changePassword: (input: {
    readonly currentPassword: string;
    readonly password: string;
    readonly confirmation: string;
  }) => Promise<boolean>;
  csrfToken: string;
  formatSessionTime: (value: number, timeZone?: string) => string;
  loading: boolean;
  locked: boolean;
  login: (credentials: { readonly username: string; readonly password: string }) => Promise<void>;
  logout: () => Promise<void>;
  logoutAdminSession: (session: UserSessionSummary) => Promise<void>;
  newPassword: string;
  passwordValidationError: string;
  refreshAdmin: () => Promise<void>;
  refreshAdminSessions: () => Promise<void>;
  renewCsrfToken: () => Promise<string>;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
}
