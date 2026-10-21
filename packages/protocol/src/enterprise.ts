import { z } from 'zod';

export const editionSchema = z.enum(['PERSONAL', 'ENTERPRISE']);
export const licenseStateSchema = z.enum(['PERSONAL', 'ENTERPRISE_VALID', 'ENTERPRISE_FROZEN']);
export const userRoleSchema = z.enum(['ADMIN', 'ORG_ADMIN', 'MEMBER']);
export const permissionScopeSchema = z.enum([
  'SYSTEM',
  'ORG_SUBTREE',
  'PERSONAL',
  'GRANTED_RESOURCE'
]);
export type UserRole = z.infer<typeof userRoleSchema>;

export const enterpriseCapabilitySchema = z
  .object({
    edition: editionSchema,
    licenseState: licenseStateSchema,
    role: userRoleSchema.nullable(),
    organizationId: z.number().int().positive().nullable(),
    managementWritable: z.boolean()
  })
  .strict();
export type EnterpriseCapability = z.infer<typeof enterpriseCapabilitySchema>;

export const organizationSchema = z
  .object({
    id: z.number().int().positive(),
    name: z.string().trim().min(1).max(128),
    parentOrganizationId: z.number().int().positive().nullable(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative()
  })
  .strict();

export const resourceOwnershipSchema = z.discriminatedUnion('ownerType', [
  z.object({ ownerType: z.literal('PERSONAL'), ownerUserId: z.number().int().positive() }).strict(),
  z
    .object({
      ownerType: z.literal('ORGANIZATION'),
      ownerOrganizationId: z.number().int().positive()
    })
    .strict()
]);
export type ResourceOwnership = z.infer<typeof resourceOwnershipSchema>;

export const resourceGrantSchema = z
  .object({
    id: z.string().min(1).max(128),
    resourceType: z.enum(['NODE', 'WORKSPACE', 'MODEL', 'IMAGE_MODEL', 'TEMPLATE']),
    nodeId: z.string().min(1).max(128).optional(),
    workspaceId: z.string().min(1).max(128).optional(),
    modelId: z.string().min(1).max(128).optional(),
    imageModelId: z.string().min(1).max(128).optional(),
    templateId: z.string().min(1).max(128).optional(),
    targetType: z.enum(['USER', 'ORGANIZATION']),
    targetUserId: z.number().int().positive().optional(),
    targetOrganizationId: z.number().int().positive().optional(),
    grantScopeOrganizationId: z.number().int().positive(),
    createdByUserId: z.number().int().positive(),
    createdAt: z.number().int().nonnegative()
  })
  .strict()
  .superRefine((grant, context) => {
    const validResource =
      (grant.resourceType === 'NODE' &&
        grant.nodeId !== undefined &&
        grant.workspaceId === undefined &&
        grant.modelId === undefined &&
        grant.imageModelId === undefined &&
        grant.templateId === undefined) ||
      (grant.resourceType === 'WORKSPACE' &&
        grant.nodeId !== undefined &&
        grant.workspaceId !== undefined &&
        grant.modelId === undefined &&
        grant.imageModelId === undefined &&
        grant.templateId === undefined) ||
      (grant.resourceType === 'MODEL' &&
        grant.nodeId === undefined &&
        grant.workspaceId === undefined &&
        grant.modelId !== undefined &&
        grant.imageModelId === undefined &&
        grant.templateId === undefined) ||
      (grant.resourceType === 'IMAGE_MODEL' &&
        grant.nodeId === undefined &&
        grant.workspaceId === undefined &&
        grant.modelId === undefined &&
        grant.imageModelId !== undefined &&
        grant.templateId === undefined) ||
      (grant.resourceType === 'TEMPLATE' &&
        grant.nodeId === undefined &&
        grant.workspaceId === undefined &&
        grant.modelId === undefined &&
        grant.imageModelId === undefined &&
        grant.templateId !== undefined);
    if (!validResource) {
      context.addIssue({ code: 'custom', message: 'resource identifiers must match resourceType' });
    }
    if ((grant.targetType === 'USER') !== (grant.targetUserId !== undefined)) {
      context.addIssue({ code: 'custom', message: 'targetUserId must match targetType' });
    }
    if ((grant.targetType === 'ORGANIZATION') !== (grant.targetOrganizationId !== undefined)) {
      context.addIssue({ code: 'custom', message: 'targetOrganizationId must match targetType' });
    }
  });

const jsonPointerSchema = z.string().regex(/^(?:|(?:\/(?:[^~/]|~[01])*)+)$/);
const requiredJsonPointerSchema = jsonPointerSchema.min(1);
export const oauthProviderInputSchema = z
  .object({
    providerKey: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/),
    name: z.string().trim().min(1).max(128),
    clientId: z.string().min(1).max(512),
    clientSecret: z.string().min(1).max(4096).optional(),
    authorizationEndpoint: z.string().url(),
    tokenEndpoint: z.string().url(),
    userinfoEndpoint: z.string().url(),
    scopes: z.array(z.string().min(1).max(128)).max(32),
    pkceMode: z.enum(['REQUIRED', 'SUPPORTED', 'DISABLED']),
    tokenAuthMethod: z.enum(['client_secret_basic', 'client_secret_post', 'client_secret_json']),
    autoProvisioningEnabled: z.boolean().default(false),
    mappings: z
      .object({
        externalUserId: requiredJsonPointerSchema,
        email: jsonPointerSchema.optional(),
        displayName: jsonPointerSchema.optional()
      })
      .strict()
  })
  .strict();

export const auditConversationInputModeSchema = z.enum([
  'NEW_SESSION',
  'SEND',
  'CONTINUE',
  'STEER',
  'QUEUE',
  'REPLACE_CURRENT',
  'RUN_NOW',
  'USER_INPUT_RESPONSE',
  'EDIT_QUEUE',
  'DELETE_QUEUE',
  'REORDER_QUEUE',
  'EXECUTE_QUEUE',
  'PAUSE_QUEUE',
  'RESUME_QUEUE'
]);
export type AuditConversationInputMode = z.infer<typeof auditConversationInputModeSchema>;

export const auditEventSchema = z
  .object({
    id: z.string().min(1).max(128),
    eventType: z.string().regex(/^[a-z0-9_.-]{1,80}$/),
    occurredAt: z.number().int().nonnegative(),
    result: z.enum(['SUCCESS', 'DENIED', 'FAILED']),
    errorCode: z.string().max(80).nullable().optional(),
    actorUserId: z.number().int().positive().nullable().optional(),
    actorUsername: z.string().max(128).nullable().optional(),
    authenticationMethod: z.enum(['PASSWORD', 'OAUTH2', 'SYSTEM']),
    providerId: z.string().max(128).nullable().optional(),
    requestId: z.string().max(128).nullable().optional(),
    operationId: z.string().max(128).nullable().optional(),
    sessionPublicId: z.string().max(128).nullable().optional(),
    targetType: z.string().max(80).nullable().optional(),
    targetId: z.string().max(128).nullable().optional(),
    targetName: z.string().max(256).nullable().optional(),
    organizationId: z.number().int().positive().nullable().optional(),
    nodeId: z.string().max(128).nullable().optional(),
    workspaceId: z.string().max(128).nullable().optional(),
    agentSessionId: z.string().max(128).nullable().optional(),
    runId: z.string().max(128).nullable().optional(),
    clientMessageId: z.string().max(128).nullable().optional(),
    queueItemId: z.string().max(128).nullable().optional(),
    inputMode: auditConversationInputModeSchema.nullable().optional(),
    hasConversationPayload: z.boolean().optional(),
    metadata: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .optional()
  })
  .strict();

export const auditConversationReceiptSchema = z
  .object({
    sessionId: z.string().min(1).max(128),
    conversationTitle: z.string().min(1).max(256).optional(),
    runId: z.string().min(1).max(128).optional(),
    queueItemId: z.string().min(1).max(128).optional(),
    inputMode: auditConversationInputModeSchema
  })
  .strict();
export type AuditConversationReceipt = z.infer<typeof auditConversationReceiptSchema>;

export const auditConversationPayloadSchema = z
  .object({
    conversationId: z.string().min(1).max(128).optional(),
    conversationTitle: z.string().min(1).max(256),
    userMessage: z.string().min(1).max(20_000),
    queueItemId: z.string().min(1).max(128).optional()
  })
  .strict();
export type AuditConversationPayload = z.infer<typeof auditConversationPayloadSchema>;

export const auditEventDetailSchema = auditEventSchema
  .extend({
    conversationPayload: auditConversationPayloadSchema.optional()
  })
  .strict();
export type AuditEventDetail = z.infer<typeof auditEventDetailSchema>;
