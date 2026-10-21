import { z } from 'zod';
import { configurableSkillScopeSchema, skillScopeSchema } from './skill.js';

const httpsUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.username === '' && url.password === '';
    } catch {
      return false;
    }
  }, 'URL must use HTTPS without userinfo');

const mcpNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9._/-]+$/u);
const environmentNameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]*$/u);
const secretReferenceSchema = z.object({ secretName: environmentNameSchema }).strict();
const referenceMapSchema = z.record(environmentNameSchema, secretReferenceSchema).default({});
const headerReferenceMapSchema = z
  .record(
    z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u),
    secretReferenceSchema
  )
  .default({});

export const mcpSourceInputSchema = z
  .object({
    scope: configurableSkillScopeSchema,
    organizationId: z.number().int().positive().optional(),
    name: z.string().trim().min(1).max(128),
    locator: httpsUrlSchema,
    enabled: z.boolean().optional()
  })
  .strict()
  .superRefine((source, context) => {
    if ((source.scope === 'ORGANIZATION') !== (source.organizationId !== undefined))
      context.addIssue({ code: 'custom', message: 'organizationId must match scope' });
  });
export type McpSourceInput = z.infer<typeof mcpSourceInputSchema>;

export const mcpRuntimeDescriptorSchema = z.discriminatedUnion('transport', [
  z
    .object({
      transport: z.literal('STDIO'),
      command: z
        .string()
        .trim()
        .min(1)
        .max(512)
        .regex(/^[^\r\n\0]+$/u),
      args: z
        .array(
          z
            .string()
            .max(2048)
            .regex(/^[^\0]*$/u)
        )
        .max(64)
        .default([]),
      environment: referenceMapSchema.optional()
    })
    .strict(),
  z
    .object({
      transport: z.literal('HTTP'),
      url: httpsUrlSchema,
      headers: headerReferenceMapSchema.optional()
    })
    .strict()
]);
export type McpRuntimeDescriptor = z.infer<typeof mcpRuntimeDescriptorSchema>;

export const mcpCatalogEntrySchema = z
  .object({
    id: z.string().min(1).max(128),
    sourceId: z.string().min(1).max(128),
    scope: skillScopeSchema,
    ownerOrganizationId: z.number().int().positive().optional(),
    ownerUserId: z.number().int().positive().optional(),
    serverName: mcpNameSchema,
    displayName: z.string().trim().min(1).max(128),
    description: z.string().max(4096),
    version: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine((value) => value !== 'latest'),
    featured: z.boolean(),
    tags: z.array(z.string().trim().min(1).max(32)).max(10),
    runtime: mcpRuntimeDescriptorSchema,
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative()
  })
  .strict()
  .superRefine((entry, context) => {
    if ((entry.scope === 'ORGANIZATION') !== (entry.ownerOrganizationId !== undefined))
      context.addIssue({ code: 'custom', message: 'organization owner must match scope' });
    if ((entry.scope === 'PERSONAL') !== (entry.ownerUserId !== undefined))
      context.addIssue({ code: 'custom', message: 'user owner must match scope' });
  });
export type McpCatalogEntry = z.infer<typeof mcpCatalogEntrySchema>;

export const mcpInstallationConfigurationSchema = z
  .object({
    arguments: z
      .array(
        z
          .string()
          .max(2048)
          .regex(/^[^\0]*$/u)
      )
      .max(32)
      .optional(),
    environment: referenceMapSchema.optional(),
    headers: headerReferenceMapSchema.optional()
  })
  .strict();
export type McpInstallationConfiguration = z.infer<typeof mcpInstallationConfigurationSchema>;

export const mcpInstallationInputSchema = z
  .object({
    catalogEntryId: z.string().min(1).max(128),
    enabled: z.boolean().default(true),
    configuration: mcpInstallationConfigurationSchema.default({})
  })
  .strict();
export type McpInstallationInput = z.infer<typeof mcpInstallationInputSchema>;

export const installedMcpSchema = z
  .object({
    catalogEntryId: z.string().min(1).max(128),
    serverName: mcpNameSchema,
    displayName: z.string().trim().min(1).max(128),
    version: z.string().trim().min(1).max(255),
    origin: z.enum(['NODE', 'WORKSPACE']),
    enabled: z.boolean(),
    status: z.enum(['CURRENT', 'UPDATE_AVAILABLE', 'INVALID', 'UNAVAILABLE']),
    installedAt: z.number().int().nonnegative()
  })
  .strict();

export const mcpTargetInspectionSchema = z
  .object({
    targetKind: z.enum(['NODE', 'WORKSPACE']),
    installations: z.array(installedMcpSchema).max(500),
    executionBuiltIns: z
      .array(z.enum(['mar_schedule', 'mar_notification']))
      .max(2)
      .optional()
  })
  .strict();
export type McpTargetInspection = z.infer<typeof mcpTargetInspectionSchema>;
