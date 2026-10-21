import { z } from 'zod';

const identifierSchema = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);
const resourceIdentifierSchema = z.string().trim().min(1).max(512);
const relativePathSchema = z.string().min(1).max(4096);
const safeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const timestampSchema = z.number().int().positive();
const fingerprintSchema = z.string().regex(/^sha-256(?: [A-F0-9]{2}(?::[A-F0-9]{2}){31})$/u);
const sdpSchema = z
  .string()
  .min(1)
  .max(64 * 1024);
const candidateSchema = z.string().min(1).max(4096);

export const workspaceDirectTransferCapabilitySchema = z
  .object({
    apiVersion: z.union([z.literal(2), z.literal(3)]),
    transport: z.boolean(),
    upload: z.boolean(),
    download: z.boolean(),
    range: z.boolean(),
    gitCommitBlob: z.boolean(),
    maxChunkBytes: z
      .number()
      .int()
      .min(16 * 1024)
      .max(1024 * 1024)
  })
  .strict();
export type WorkspaceDirectTransferCapability = z.infer<
  typeof workspaceDirectTransferCapabilitySchema
>;

export const directTransferPurposeSchema = z.enum(['TRANSPORT', 'TRANSFER']);
export const directTransferDirectionSchema = z.enum(['UPLOAD', 'DOWNLOAD']);
const workspaceFileResourceSchema = z
  .object({
    kind: z.literal('WORKSPACE_FILE'),
    workspaceId: resourceIdentifierSchema,
    path: relativePathSchema,
    worktreePath: relativePathSchema.optional()
  })
  .strict();
const gitCommitBlobResourceSchema = z
  .object({
    kind: z.literal('GIT_COMMIT_BLOB'),
    workspaceId: resourceIdentifierSchema,
    commit: z.string().min(1).max(256),
    path: relativePathSchema,
    repositoryPath: z.string().max(4096).optional(),
    worktreePath: z.string().max(4096).optional()
  })
  .strict();
export const directTransferResourceSchema = z.discriminatedUnion('kind', [
  workspaceFileResourceSchema,
  gitCommitBlobResourceSchema
]);
export type DirectTransferResource = z.infer<typeof directTransferResourceSchema>;

const directTransferDescriptorBaseSchema = z
  .object({
    resource: directTransferResourceSchema,
    fileName: z.string().trim().min(1).max(512),
    size: safeIntegerSchema
  })
  .strict();
const directUploadDescriptorSchema = directTransferDescriptorBaseSchema
  .extend({
    direction: z.literal('UPLOAD'),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    overwrite: z.boolean().optional(),
    resumeOffset: safeIntegerSchema.optional(),
    composerAttachment: z
      .object({
        id: identifierSchema,
        mime: z.string().trim().min(1).max(256)
      })
      .strict()
      .optional()
  })
  .strict()
  .superRefine((descriptor, context) => {
    if (descriptor.resumeOffset !== undefined && descriptor.resumeOffset > descriptor.size)
      context.addIssue({
        code: 'custom',
        path: ['resumeOffset'],
        message: 'resume offset cannot exceed the file size'
      });
    if (
      descriptor.composerAttachment !== undefined &&
      descriptor.resource.kind !== 'WORKSPACE_FILE'
    )
      context.addIssue({
        code: 'custom',
        path: ['composerAttachment'],
        message: 'composer attachments are supported only for Workspace uploads'
      });
  });
const directDownloadDescriptorSchema = directTransferDescriptorBaseSchema
  .extend({
    direction: z.literal('DOWNLOAD'),
    revision: z.string().trim().min(1).max(512),
    range: z
      .object({
        offset: safeIntegerSchema,
        length: safeIntegerSchema
      })
      .strict()
      .optional()
  })
  .strict()
  .superRefine((descriptor, context) => {
    if (
      descriptor.range !== undefined &&
      (descriptor.range.length === 0 ||
        descriptor.range.offset + descriptor.range.length > descriptor.size)
    )
      context.addIssue({
        code: 'custom',
        path: ['range'],
        message: 'download range must be non-empty and fit within the file size'
      });
  });
export const directTransferDescriptorSchema = z.union([
  directUploadDescriptorSchema,
  directDownloadDescriptorSchema
]);
export type DirectTransferDescriptor = z.infer<typeof directTransferDescriptorSchema>;

const directPrepareBaseSchema = z
  .object({
    type: z.literal('direct.prepare'),
    requestId: identifierSchema,
    nodeId: resourceIdentifierSchema,
    nodeGeneration: identifierSchema
  })
  .strict();
export const directPrepareRequestSchema = z.discriminatedUnion('purpose', [
  directPrepareBaseSchema.extend({ purpose: z.literal('TRANSPORT') }).strict(),
  directPrepareBaseSchema
    .extend({
      purpose: z.literal('TRANSFER'),
      transportSessionId: identifierSchema,
      transfer: directTransferDescriptorSchema
    })
    .strict()
]);
export type DirectPrepareRequest = z.infer<typeof directPrepareRequestSchema>;

export const directIceCandidateSchema = z
  .object({
    candidate: candidateSchema,
    sdpMid: z.string().max(256).nullable(),
    sdpMLineIndex: z.number().int().min(0).max(1024).nullable()
  })
  .strict();
export type DirectIceCandidate = z.infer<typeof directIceCandidateSchema>;

export const directSignalSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('OFFER'),
      sdp: sdpSchema,
      fingerprint: fingerprintSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal('ANSWER'),
      sdp: sdpSchema,
      fingerprint: fingerprintSchema
    })
    .strict(),
  z.object({ kind: z.literal('CANDIDATE'), candidate: directIceCandidateSchema }).strict(),
  z.object({ kind: z.literal('END_OF_CANDIDATES') }).strict()
]);
export type DirectSignal = z.infer<typeof directSignalSchema>;

const directSessionIdentitySchema = z
  .object({
    directSessionId: identifierSchema
  })
  .strict();

export const directBrowserMessageSchema = z.union([
  directPrepareRequestSchema,
  directSessionIdentitySchema
    .extend({ type: z.literal('direct.signal'), signal: directSignalSchema })
    .strict(),
  directSessionIdentitySchema.extend({ type: z.literal('direct.connected') }).strict(),
  directSessionIdentitySchema.extend({ type: z.literal('direct.heartbeat') }).strict(),
  directSessionIdentitySchema
    .extend({
      type: z.literal('direct.complete'),
      size: safeIntegerSchema
    })
    .strict(),
  directSessionIdentitySchema
    .extend({
      type: z.literal('direct.cancel'),
      reason: z.string().trim().min(1).max(128).optional()
    })
    .strict()
]);
export type DirectBrowserMessage = z.infer<typeof directBrowserMessageSchema>;

export const directServerMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('direct.prepared'),
      requestId: identifierSchema,
      directSessionId: identifierSchema,
      nodeId: resourceIdentifierSchema,
      nodeGeneration: identifierSchema,
      purpose: directTransferPurposeSchema,
      expiresAt: timestampSchema,
      transportSessionId: identifierSchema.optional(),
      resumeOffset: safeIntegerSchema.optional()
    })
    .strict(),
  directSessionIdentitySchema
    .extend({ type: z.literal('direct.signal'), signal: directSignalSchema })
    .strict(),
  directSessionIdentitySchema
    .extend({
      type: z.literal('direct.grant'),
      grant: z.string().min(32).max(4096),
      openExpiresAt: timestampSchema,
      expiresAt: timestampSchema
    })
    .strict(),
  directSessionIdentitySchema
    .extend({
      type: z.literal('direct.heartbeat'),
      alive: z.literal(true),
      expiresAt: timestampSchema
    })
    .strict(),
  directSessionIdentitySchema
    .extend({
      type: z.literal('direct.opened'),
      offset: safeIntegerSchema
    })
    .strict(),
  directSessionIdentitySchema
    .extend({
      type: z.literal('direct.complete'),
      size: safeIntegerSchema
    })
    .strict(),
  directSessionIdentitySchema
    .extend({
      type: z.literal('direct.closed'),
      code: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u)
    })
    .strict(),
  z
    .object({
      type: z.literal('direct.error'),
      requestId: identifierSchema.optional(),
      directSessionId: identifierSchema.optional(),
      code: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u),
      message: z.string().trim().min(1).max(1000)
    })
    .strict()
]);
export type DirectServerMessage = z.infer<typeof directServerMessageSchema>;

export const directNodeCommandSchema = z.union([
  z
    .object({
      type: z.literal('direct.prepare'),
      directSessionId: identifierSchema,
      workbenchConnectionId: identifierSchema,
      nodeGeneration: identifierSchema,
      purpose: z.literal('TRANSPORT'),
      expiresAt: timestampSchema,
      userAuthorization: z.unknown()
    })
    .strict(),
  z
    .object({
      type: z.literal('direct.prepare'),
      directSessionId: identifierSchema,
      transportSessionId: identifierSchema,
      workbenchConnectionId: identifierSchema,
      nodeGeneration: identifierSchema,
      purpose: z.literal('TRANSFER'),
      expiresAt: timestampSchema,
      transfer: directTransferDescriptorSchema,
      userAuthorization: z.unknown()
    })
    .strict(),
  directSessionIdentitySchema
    .extend({ type: z.literal('direct.signal'), signal: directSignalSchema })
    .strict(),
  directSessionIdentitySchema
    .extend({
      type: z.literal('direct.grant'),
      transportSessionId: identifierSchema,
      grant: z.string().min(32).max(4096),
      browserFingerprint: fingerprintSchema,
      nodeFingerprint: fingerprintSchema,
      openExpiresAt: timestampSchema,
      expiresAt: timestampSchema
    })
    .strict(),
  directSessionIdentitySchema
    .extend({ type: z.literal('direct.heartbeat'), expiresAt: timestampSchema })
    .strict(),
  directSessionIdentitySchema
    .extend({
      type: z.literal('direct.cancel'),
      code: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u)
    })
    .strict()
]);
export type DirectNodeCommand = z.infer<typeof directNodeCommandSchema>;

export const directNodeEventSchema = z.discriminatedUnion('type', [
  directSessionIdentitySchema
    .extend({ type: z.literal('direct.signal'), signal: directSignalSchema })
    .strict(),
  directSessionIdentitySchema.extend({ type: z.literal('direct.connected') }).strict(),
  directSessionIdentitySchema
    .extend({
      type: z.literal('direct.opened'),
      offset: safeIntegerSchema
    })
    .strict(),
  directSessionIdentitySchema
    .extend({
      type: z.literal('direct.complete'),
      size: safeIntegerSchema
    })
    .strict(),
  directSessionIdentitySchema
    .extend({
      type: z.literal('direct.error'),
      code: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u),
      message: z.string().trim().min(1).max(1000)
    })
    .strict()
]);
export type DirectNodeEvent = z.infer<typeof directNodeEventSchema>;

export const directDataOpenFrameSchema = z
  .object({
    type: z.literal('OPEN'),
    directSessionId: identifierSchema,
    grant: z.string().min(32).max(4096)
  })
  .strict();
export const directDataAckFrameSchema = z
  .object({
    type: z.literal('ACK'),
    offset: safeIntegerSchema
  })
  .strict();
export const directDataCompleteFrameSchema = z
  .object({
    type: z.literal('COMPLETE'),
    size: safeIntegerSchema
  })
  .strict();
export const directDataErrorFrameSchema = z
  .object({
    type: z.literal('ERROR'),
    code: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u)
  })
  .strict();
export const directDataControlFrameSchema = z.discriminatedUnion('type', [
  directDataOpenFrameSchema,
  directDataAckFrameSchema,
  directDataCompleteFrameSchema,
  directDataErrorFrameSchema
]);
export type DirectDataControlFrame = z.infer<typeof directDataControlFrameSchema>;
