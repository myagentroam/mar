import { ref } from 'vue';
import type { AdminState } from './AdminAuthService.js';
import type { UserSessionSummary } from './AdminAuthService.js';

export function createAdminSessionStateService() {
  return {
    admin: ref<AdminState>({ authenticated: false, mustChangePassword: false, isAdmin: false }),
    loaded: ref(false),
    sessions: ref<readonly UserSessionSummary[]>([]),
    newPassword: ref(''),
    passwordValidationError: ref(''),
    csrfToken: ref('')
  };
}
