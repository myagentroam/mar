export const errorPresentationEnUS = {
  errors: {
    COMPOSER_TAG_INVALID:
      'The selected references are invalid or exceed the limit. Remove some references and try again.',
    COMPOSER_MESSAGE_TOO_LARGE:
      'The message and its context exceed the size limit. Shorten the message or remove some references or skills.',
    COMPOSER_IMAGE_CONVERSION_FAILED:
      'Could not convert this BMP image to PNG. Save it as PNG and try again.',
    COMPOSER_IMAGE_LIMIT_EXCEEDED:
      'BMP conversion exceeds the attachment size limit or 16 megapixels. Save a smaller PNG and try again.',
    HOSTED_CONVERSATION_TEMPLATE_CONFLICT:
      'The conversation template changed. Wait for the refresh, then select again.',
    SESSION_PAGINATION_NO_PROGRESS:
      'Could not load more sessions because the page did not advance. Retry to continue.',
    SESSION_SHARE_CREDENTIAL_INVALID:
      'The password or saved share credential is invalid. Enter the password again.',
    SESSION_SHARE_RATE_LIMITED: 'Too many password attempts. Try again later.',
    SESSION_SHARE_NOT_FOUND: 'This share was deleted or does not exist.',
    SESSION_SHARE_EXPIRED: 'This share has expired.',
    SESSION_SHARE_ACCESS_INVALID: 'Access to this share is no longer available.',
    SESSION_PROMPT_INVALID:
      'Session Prompt must be text of at most 20,000 characters. Leave it blank to clear.',
    MAR_AGENT_AUTO_UNSUPPORTED:
      'This Node does not support MAR Agent Auto. Upgrade the Node or explicitly choose Full access.',
    attachmentExpired: 'File has expired',
    FILE_NOT_FOUND: 'File not found.',
    PERMISSION_DENIED: 'You do not have permission to access this resource.',
    CAPABILITY_UNAVAILABLE: 'This feature is unavailable on the current Node.',
    IMAGE_PREVIEW_FAILED: 'Unable to preview this image. Try again or download the file.',
    DESKTOP_UNAVAILABLE: 'Remote desktop is unavailable on this Node.',
    DESKTOP_DESCRIPTION_INVALID: 'The Node returned an invalid desktop description.',
    DESKTOP_NOT_AUTHORIZED: 'You do not have permission to use this desktop.',
    DESKTOP_CONTROL_UNAVAILABLE: 'The remote desktop control connection is unavailable.',
    DESKTOP_CONNECTION_REPLACED:
      'This desktop connection was replaced by a new remote desktop connection.',
    DESKTOP_TRANSPORT_ERROR: 'The remote desktop data transport failed.',
    DESKTOP_BACKEND_START_FAILED: 'The desktop backend could not start.',
    DESKTOP_BACKEND_AUTH_UNAVAILABLE:
      'The desktop backend does not offer the required authentication method.',
    DESKTOP_BACKEND_AUTH_FAILED: 'The desktop backend rejected authentication.',
    DESKTOP_BACKEND_CONFIG_INVALID: 'The desktop backend configuration is invalid.',
    DESKTOP_BACKEND_SOCKET_INVALID: 'The desktop backend socket did not pass a safety check.',
    DESKTOP_BACKEND_CLOSED: 'The desktop backend is closed.',
    DESKTOP_BACKEND_STOP_FAILED: 'The desktop backend could not be stopped.',
    DESKTOP_BACKEND_STOP_TIMEOUT: 'The desktop backend did not stop before the timeout.',
    DESKTOP_SETUP_TIMEOUT: 'Remote desktop setup timed out.',
    DESKTOP_SETUP_CANCELLED: 'Remote desktop setup was cancelled.',
    DESKTOP_TOPOLOGY_UNAVAILABLE: 'The desktop display layout is unavailable.',
    DESKTOP_RFB_INVALID: 'The remote desktop protocol data is invalid.',
    DESKTOP_RFB_CLOSED: 'The remote desktop input stream is closed.',
    DESKTOP_INPUT_DENIED: 'This remote desktop connection cannot send input.',
    DESKTOP_CONTROL_LOST: 'Remote desktop control was lost.',
    DESKTOP_BACKPRESSURE: 'The remote desktop transport could not keep up with input.',
    DESKTOP_NATIVE_CHANNEL_CLOSED: 'The native desktop control channel is closed.',
    DESKTOP_NATIVE_ID_UNAVAILABLE: 'A unique native desktop attachment ID could not be created.',
    DESKTOP_NATIVE_WAIT_IN_PROGRESS: 'Native desktop cleanup is already in progress.',
    DESKTOP_NATIVE_CLEANUP_TIMEOUT: 'Desktop connection cleanup timed out.',
    DESKTOP_NATIVE_CLEANUP_FAILED: 'Desktop connection cleanup failed.',
    DESKTOP_NATIVE_ATTACHMENTS_ACTIVE: 'Desktop attachments are still active.',
    withDiagnostics: '{summary}\n{diagnostics}',
    diagnosticCode: 'Code: {value}',
    diagnosticDetails: 'Details: {value}',
    diagnosticRequestId: 'Request ID: {value}',
    diagnosticUpstreamRequestId: 'Node request ID: {value}',
    subscription_sharing_usage_limit_exceeded:
      'Your ChatGPT plan or this app has reached a usage limit. Open https://chatgpt.com/settings/usage to review usage and adjust available limits.',
    UNAUTHENTICATED: 'Your session has expired. Sign in again.',
    INVALID_CREDENTIALS: 'The account or password is incorrect.',
    PASSWORD_CHANGE_REQUIRED: 'Change the initial password before continuing.',
    CSRF_INVALID: 'The security token has expired. Try again.',
    ADMIN_REQUIRED: 'This operation requires system administrator access.',
    FORBIDDEN: 'You do not have permission to perform this operation.',
    GIT_SUBMODULE_MAPPING_MISSING:
      'The parent repository tracks this directory as a submodule, but .gitmodules has no complete path and URL mapping.',
    GIT_SUBMODULE_MAPPING_INVALID: 'The .gitmodules configuration cannot be read or parsed.',
    GIT_REPOSITORY_UNREADABLE:
      'This repository cannot be read. Check its directory, Git metadata, and permissions.',
    GIT_SUBMODULE_DISCOVERY_FAILED:
      'Some submodules could not be listed. Other available repository changes are still shown.',
    GIT_WORKTREE_DISCOVERY_FAILED:
      'Linked worktrees could not be listed. Other available repository changes are still shown.',
    GIT_SUBMODULE_LIMIT_EXCEEDED:
      'The submodule discovery limit was reached. Some repositories are not shown.',
    GIT_NOT_FOUND:
      'Git was not found in the Node runtime environment. Check its installation and PATH.',
    NODE_OFFLINE: 'The Node is offline. Confirm that the Node service is running.',
    NODE_DISABLED: 'The Node is disabled. Contact an administrator.',
    WORKSPACE_BUSY: 'The Workspace is busy. Try again shortly.',
    WORKSPACE_NOT_FOUND: 'The Workspace does not exist or is no longer accessible.',
    WORKSPACE_CONVERSATION_TEMPLATE_REFERENCE_EXISTS:
      'This Workspace is still used as the source Workspace of a conversation template and cannot be removed.',
    SESSION_NOT_FOUND: 'The session does not exist or has been removed.',
    RUN_NOT_FOUND: 'The run does not exist or has already ended.',
    WATCH_REQUEST_TIMEOUT: 'The subscription request timed out. Reload to try again.',
    SESSION_WATCH_SNAPSHOT_TIMEOUT:
      'Timed out waiting for the initial session snapshot. Reload to try again.',
    SESSION_HISTORY_INITIAL_FAILED: 'Unable to load conversation history. Reload it to try again.',
    UPLOAD_CANCELLED: 'The upload was cancelled.',
    UPLOAD_CLEANUP_UNCONFIRMED:
      'Temporary upload cleanup could not be confirmed. The task has been kept. Retry or ask an administrator to check the Node.'
  },
  common: { unknownError: 'Unknown error' }
} as const;
