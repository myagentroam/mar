export const cliMessagesEnUS = {
  splitBaselineUsage: 'Usage: prepare-server-split-baseline.mts --check | --sql',
  splitBaselineValid:
    'The source database passed the offline split preflight. Keep all writers stopped; SQL output does not apply any changes.',
  licenseUsage: 'Usage: license <keygen|fingerprint|issue|inspect|verify> [--option value]',
  licenseKeyWritten:
    'Private key written to {destination}. Add the public key shown above to the Server release configuration.',
  resetPasswordRequired: 'Provide the new administrator password through MAR_RESET_PASSWORD.',
  resetPasswordCompleted:
    'The administrator password was reset and must be changed after the next sign-in.'
} as const;
