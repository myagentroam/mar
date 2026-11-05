export const errorPresentationEnUS = {
  errors: {
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
    IMAGE_PREVIEW_FAILED: 'Unable to preview this image. Try again or download the file.',
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
