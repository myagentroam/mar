import { ref } from 'vue';
import type { AdminState } from './admin-auth-service.js';
import type { UserSessionSummary } from '../model/workbench.js';

export function createAdminSessionStateService() {
  return {
    admin: ref<AdminState>({ authenticated: false, mustChangePassword: false, isAdmin: false }),
    loaded: ref(false),
    loading: ref(false),
    sessions: ref<readonly UserSessionSummary[]>([]),
    newPassword: ref(''),
    passwordValidationError: ref(''),
    csrfToken: ref('')
  };
}
