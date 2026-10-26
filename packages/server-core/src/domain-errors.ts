import type { FastifyReply } from 'fastify';
import { safePublicError, sendError, errorResponseOptions } from './http-errors.js';

export function domainErrorStatus(code: string): number {
  if (code === 'NODE_RESPONSE_INVALID') return 502;
  if (code === 'SESSION_SHARE_NOT_FOUND') return 404;
  if (code === 'SESSION_SHARE_EXPIRED') return 410;
  if (code === 'SESSION_SHARE_CREDENTIAL_INVALID') return 401;
  if (code === 'SESSION_SHARE_RATE_LIMITED') return 429;
  if (code === 'SESSION_SHARE_ACCESS_INVALID' || code === 'NODE_NOT_AUTHORIZED') return 403;
  if (code === 'TERMINAL_GIT_OWNER_REQUIRED' || code === 'TERMINAL_OWNER_REQUIRED') return 403;
  return code === 'SESSION_NOT_FOUND' ||
    code === 'WORKSPACE_NOT_FOUND' ||
    code === 'RUN_NOT_FOUND' ||
    code === 'APPROVAL_NOT_FOUND' ||
    code === 'HOSTED_CONVERSATION_NOT_FOUND' ||
    code === 'HOSTED_CONVERSATION_FILE_NOT_FOUND' ||
    code === 'HOSTED_CONVERSATION_UPLOAD_NOT_FOUND' ||
    code === 'USER_NOT_FOUND' ||
    code === 'ORGANIZATION_NOT_FOUND' ||
    code === 'SECRET_NOT_FOUND' ||
    code === 'SKILL_SOURCE_NOT_FOUND' ||
    code === 'SKILL_FAVORITE_NOT_FOUND' ||
    code === 'MCP_SOURCE_NOT_FOUND' ||
    code === 'MCP_CATALOG_NOT_FOUND' ||
    code === 'MAIL_TEMPLATE_NOT_FOUND'
    ? 404
    : code === 'NODE_OFFLINE' ||
        code === 'CAPABILITY_UNAVAILABLE' ||
        code === 'CAPABILITY_VERSION_UNSUPPORTED' ||
        code === 'MAR_AGENT_AUTO_UNSUPPORTED' ||
        code === 'CAPABILITY_STALE' ||
        code === 'EVENT_CURSOR_GAP' ||
        code === 'GIT_CHANGE_RESTORE_UNAVAILABLE' ||
        code === 'RUNNER_UNAVAILABLE' ||
        code === 'RUNNER_RESUME_FAILED' ||
        code === 'EXTERNAL_SESSION_ACTIVE' ||
        code === 'SESSION_ACTIVATION_REQUIRED' ||
        code === 'WORKSPACE_BUSY' ||
        code === 'FILE_WRITE_CONFLICT' ||
        code === 'RUN_VERSION_CONFLICT' ||
        code === 'RUN_STATE_INVALID' ||
        code === 'RUN_LOST' ||
        code === 'APPROVAL_EXPIRED' ||
        code === 'APPROVAL_ALREADY_DECIDED' ||
        code === 'UPLOAD_TARGET_EXISTS' ||
        code === 'UPLOAD_TARGET_BUSY' ||
        code === 'UPLOAD_INCOMPLETE' ||
        code === 'SECRET_ALREADY_EXISTS' ||
        code === 'SECRET_SCOPE_LIMIT_EXCEEDED' ||
        code === 'SKILL_SOURCE_IN_USE' ||
        code === 'NODE_IN_USE' ||
        code === 'USER_IN_USE' ||
        code === 'MCP_SOURCE_IN_USE' ||
        code === 'MCP_CATALOG_ALREADY_EXISTS' ||
        code === 'MAR_AGENT_MODEL_DISABLED' ||
        code === 'MCP_SOURCE_BUILT_IN' ||
        code === 'MCP_SOURCE_DISABLED' ||
        code === 'MCP_INSTALL_TIMEOUT' ||
        code === 'MCP_SECRET_MISSING' ||
        code === 'MCP_AUTH_FAILED' ||
        code === 'MCP_COMMAND_UNAVAILABLE' ||
        code === 'MCP_CONNECTION_FAILED' ||
        code === 'MCP_PROTOCOL_VALIDATION_FAILED' ||
        code === 'MCP_TOOLS_UNAVAILABLE' ||
        code === 'SKILL_TARGET_OFFLINE' ||
        code === 'SKILL_NAME_CONFLICT' ||
        code === 'NODE_OWNERSHIP_WORKSPACE_INCOMPATIBLE' ||
        code === 'WORKSPACE_CONVERSATION_TEMPLATE_REFERENCE_EXISTS' ||
        code === 'WORKSPACE_SKILL_TRACKED_CONFIRM_REQUIRED' ||
        code === 'CONVERSATION_HOSTING_UNAVAILABLE' ||
        code === 'CONVERSATION_HOSTING_DISABLE_ACTIVE_RUNS' ||
        code === 'CONVERSATION_TEMPLATE_HOST_NODE_INVALID' ||
        code === 'CONVERSATION_TEMPLATE_GRANT_SCOPE_INVALID' ||
        code === 'CONVERSATION_TEMPLATE_SOURCE_IMMUTABLE' ||
        code === 'CONVERSATION_TEMPLATE_REVISION_CONFLICT' ||
        code === 'CONVERSATION_TEMPLATE_NAME_CONFLICT' ||
        code === 'CONVERSATION_TEMPLATE_NOT_PUBLISHED' ||
        code === 'CONVERSATION_TEMPLATE_PUBLISH_FAILED' ||
        code === 'HOSTED_CONVERSATION_UPGRADE_FAILED' ||
        code === 'HOSTED_CONVERSATION_QUOTA_EXCEEDED' ||
        code === 'HOSTED_CONVERSATION_STATE_INVALID' ||
        code === 'HOSTED_CONVERSATION_TEMPLATE_CONFLICT' ||
        code === 'HOSTED_CONVERSATION_RUN_ACTIVE' ||
        code === 'HOSTED_CONVERSATION_ROLLBACK_TARGET_INVALID' ||
        code === 'HOSTED_CONVERSATION_FILE_CONFLICT' ||
        code === 'HOSTED_CONVERSATION_UPLOAD_STATE_INVALID' ||
        code === 'HOSTED_CONVERSATION_UPLOAD_OFFSET_INVALID' ||
        code === 'HOSTED_CONVERSATION_UPLOAD_SIZE_INVALID' ||
        code === 'HOSTED_CONVERSATION_UPLOAD_INCOMPLETE' ||
        code === 'CODEX_CREDENTIAL_SCOPE_CONFLICT' ||
        code === 'MAIL_TEMPLATE_REVISION_CONFLICT' ||
        code === 'MAIL_TEMPLATE_DEFAULT' ||
        code === 'MAIL_DELIVERY_UNCERTAIN' ||
        code === 'MAIL_CALL_CONFLICT' ||
        code === 'WEB_PUSH_BINDING_STALE' ||
        code === 'WEB_PUSH_CLIENT_CONFLICT' ||
        code === 'WEB_PUSH_UNAVAILABLE'
      ? 409
      : code === 'UNAUTHENTICATED' || code === 'WEB_PUSH_SESSION_INVALID'
        ? 401
        : code === 'NODE_ACCESS_DENIED' ||
            code === 'NODE_FORBIDDEN' ||
            code === 'WORKSPACE_FORBIDDEN' ||
            code === 'RBAC_DENIED' ||
            code === 'ADMIN_REQUIRED' ||
            code === 'MODEL_RESOURCE_ADMIN_REQUIRED' ||
            code === 'MAR_AGENT_MODEL_FORBIDDEN' ||
            code === 'PERSONAL_RESOURCE_FORBIDDEN' ||
            code === 'SKILL_SOURCE_FORBIDDEN' ||
            code === 'SKILL_FAVORITE_FORBIDDEN' ||
            code === 'MCP_SOURCE_FORBIDDEN' ||
            code === 'TEMPLATE_RESOURCE_ADMIN_REQUIRED' ||
            code === 'CONVERSATION_TEMPLATE_NOT_AUTHORIZED' ||
            code === 'HOSTED_CONVERSATION_NOT_AUTHORIZED' ||
            code === 'CODEX_CREDENTIAL_SCOPE_FORBIDDEN' ||
            code === 'MAIL_ACCESS_DENIED'
          ? 403
          : code === 'MAIL_RATE_LIMITED' ||
              code === 'WEB_PUSH_CLIENT_LIMIT' ||
              code === 'WEB_PUSH_RATE_LIMITED'
            ? 429
            : code === 'CONVERSATION_TEMPLATE_MODEL_INVALID'
              ? 400
              : code === 'INTERNAL_ERROR'
                ? 500
                : 400;
}

export function databaseError(reply: FastifyReply, error: unknown): FastifyReply {
  const failure = safePublicError(error);
  return sendError(
    reply,
    domainErrorStatus(failure.code),
    failure.code,
    errorResponseOptions(failure)
  );
}
