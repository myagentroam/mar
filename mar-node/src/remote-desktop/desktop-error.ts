const messages = {
  DESKTOP_UNAVAILABLE: 'Remote desktop is unavailable on this Node.',
  DESKTOP_RFB_INVALID: 'The remote desktop protocol message is invalid.',
  DESKTOP_RFB_CLOSED: 'The remote desktop input stream is closed.',
  DESKTOP_INPUT_DENIED: 'This remote desktop attachment cannot send input.',
  DESKTOP_CONTROL_LOST: 'Remote desktop control is no longer held.',
  DESKTOP_BACKPRESSURE: 'The remote desktop input buffer exceeded its limit.',
  DESKTOP_TRANSPORT_ERROR: 'The remote desktop transport failed.',
  DESKTOP_BACKEND_AUTH_UNAVAILABLE: 'The desktop backend does not offer required authentication.',
  DESKTOP_BACKEND_AUTH_FAILED: 'The desktop backend rejected authentication.',
  DESKTOP_BACKEND_CONFIG_INVALID: 'The desktop backend configuration is invalid.',
  DESKTOP_BACKEND_START_FAILED: 'The desktop backend could not start.',
  DESKTOP_BACKEND_SOCKET_INVALID: 'The desktop backend socket is not private.',
  DESKTOP_BACKEND_CLOSED: 'The desktop backend is closed.',
  DESKTOP_BACKEND_STOP_FAILED: 'The desktop backend could not be stopped.',
  DESKTOP_BACKEND_STOP_TIMEOUT: 'The desktop backend did not stop in time.',
  DESKTOP_SETUP_TIMEOUT: 'The remote desktop setup timed out.',
  DESKTOP_SETUP_CANCELLED: 'The remote desktop setup was cancelled.',
  DESKTOP_TOPOLOGY_UNAVAILABLE: 'The native desktop topology is unavailable.',
  DESKTOP_NATIVE_CHANNEL_CLOSED: 'The native desktop control channel is closed.',
  DESKTOP_NATIVE_ID_UNAVAILABLE: 'A unique native desktop attachment ID could not be created.',
  DESKTOP_NATIVE_WAIT_IN_PROGRESS: 'Native desktop cleanup is already being awaited.',
  DESKTOP_NATIVE_CLEANUP_TIMEOUT: 'Native desktop input cleanup timed out.',
  DESKTOP_NATIVE_CLEANUP_FAILED: 'The native desktop backend could not confirm input cleanup.',
  DESKTOP_NATIVE_ATTACHMENTS_ACTIVE: 'Desktop attachments are still active.'
} as const;

export type DesktopErrorCode = keyof typeof messages;

/** Stable, credential-free errors crossing the Node remote-desktop boundary. */
export class RemoteDesktopError extends Error {
  constructor(readonly code: DesktopErrorCode) {
    super(messages[code]);
    this.name = 'RemoteDesktopError';
  }
}
