export const authenticationEnUS = {
  common: { productName: 'MyAgentRoam' },
  auth: {
    title: 'Continue working with your Agent.',
    summary: 'Sign in to access verified nodes, workspaces, and sessions.',
    username: 'Account',
    password: 'Password',
    login: 'Open console'
  },
  passwordGate: {
    firstUse: 'First use',
    title: 'Set your console password.',
    summary:
      'This account still uses its initial password. Nodes and sessions remain unavailable until you change it.',
    requirement: 'Your new password must contain at least 8 characters.',
    current: 'Current password',
    next: 'New password',
    confirmation: 'Enter new password again',
    submit: 'Save and continue'
  },
  generated: {
    adminAuthService: {
      authenticationRecoveryFailed: 'Unable to verify sign-in status. Refresh to retry: {value0}',
      workbenchRecoveryFailed: 'Workbench recovery failed: {value0}',
      unableToLoadSignInSessions: 'Unable to load sign-in sessions: {value0}',
      unableToRevokeTheSignInSession: 'Unable to revoke the sign-in session: {value0}',
      signInFailed: 'Sign-in failed: {value0}',
      theNewPasswordMustContainAtLeast:
        'The new password must contain at least {value0} characters.',
      theNewPasswordsDoNotMatch: 'The new passwords do not match.',
      passwordUpdatedPreviousSignInSessionsWere:
        'Password updated. Previous sign-in sessions were revoked.',
      unableToUpdateThePassword: 'Unable to update the password: {value0}',
      unableToSignOut: 'Unable to sign out: {value0}'
    }
  }
} as const;
