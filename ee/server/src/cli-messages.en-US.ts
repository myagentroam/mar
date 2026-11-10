export const cliMessagesEnUS = {
  quickUsage:
    'Usage: mar-server setup [--config PATH] [--no-node] [--no-searxng]\n       mar-server run [--config PATH]',
  quickInvalidArguments: 'Invalid arguments. Use mar-server --help.',
  quickExternalDatabaseUnsupported:
    'Quick Start uses its own MySQL and does not accept MAR_DATABASE_URL.',
  quickSetupRequired: 'Quick Start is not initialized. Run mar-server setup first.',
  quickSetupComplete: 'Setup complete. Data: {path}. Start with mar-server run.',
  quickStarted:
    'Server listening at {url}. Data: {path}. Configure a model before starting an Agent.',
  quickNodeNotPrepared:
    'The Server Node dependency is unavailable. Check the npm installation or disable the local Node with --no-node.',
  quickNodeInstallFailed:
    'The local Node operation failed ({code}). Check the Node logs and configuration.',
  quickNodeOnline: 'Local Node is online.',
  quickNodeBootstrapRecoveryRequired:
    'Local Node registration cannot be safely recovered (QUICK_START_NODE_BOOTSTRAP_RECOVERY_REQUIRED). The token was consumed or its state is unknown. No new Node was registered. Keep node-data/node.json and restore its existing identity from a backup or resolve the previous registration before registering again.',
  quickNodeUnavailable:
    'Local Node is not online. Check the Node logs and configuration; registration is not retried automatically.',
  quickNodeSupervisorExited:
    'Local Node Supervisor exited unexpectedly. The management page remains available; check the Node logs.',
  quickSearchDisabled:
    'Local search is unavailable on this platform and has been disabled; an external search endpoint can be configured later.',
  quickSearchUnavailable:
    'The external search endpoint did not pass its JSON search check. Client search is disabled for this run.',
  quickManagedSearchReady: 'Local search is available.',
  quickManagedSearchUnavailable:
    'Local search is unavailable. Other components remain usable; rerun setup or configure an external search endpoint.',
  quickManagedSearchFailure:
    'Local search setup failed ({code}). Other components remain usable; retry setup or configure an external search endpoint.',
  quickFailed: 'Quick Start failed: {code}.',
  quickReclaimFailed:
    'A managed process could not be confirmed stopped ({code}). The deployment lock has been retained. Verify that this deployment’s processes have stopped before recovering; do not remove the lock while ownership is uncertain.',
  quickPortInUse:
    'Server port is already in use. Change serverPort in the Quick Start config and run again.',
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
