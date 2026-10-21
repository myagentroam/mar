import { z } from 'zod';

export const skillScopeSchema = z.enum(['ENTERPRISE', 'ORGANIZATION', 'PERSONAL']);
export const configurableSkillScopeSchema = z.enum(['ORGANIZATION', 'PERSONAL']);
export const skillSourceKindSchema = z.enum(['SKILLS_SH', 'REPOSITORY']);
const httpsLocatorSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.username === '' && url.password === '';
    } catch {
      return false;
    }
  }, 'locator must be an HTTPS URL without userinfo');
const sshGitLocatorSchema = z
  .string()
  .min(1)
  .max(2048)
  .regex(
    /^git@[A-Za-z0-9.-]+:[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+(?:\.git)?$/u,
    'locator must be an HTTPS URL or git@ SSH repository'
  );

export const skillSourceInputSchema = z
  .object({
    kind: skillSourceKindSchema,
    scope: configurableSkillScopeSchema,
    organizationId: z.number().int().positive().optional(),
    name: z.string().trim().min(1).max(128),
    locator: z.union([z.literal('skills.sh'), httpsLocatorSchema, sshGitLocatorSchema]),
    enabled: z.boolean().optional()
  })
  .strict()
  .superRefine((source, context) => {
    if ((source.scope === 'ORGANIZATION') !== (source.organizationId !== undefined))
      context.addIssue({ code: 'custom', message: 'organizationId must match scope' });
    if (source.kind === 'SKILLS_SH' && source.locator !== 'skills.sh')
      context.addIssue({ code: 'custom', message: 'skills.sh source locator is fixed' });
    if (source.kind === 'REPOSITORY' && source.locator === 'skills.sh')
      context.addIssue({
        code: 'custom',
        message: 'repository source requires repository locator'
      });
  });
export type SkillSourceInput = z.infer<typeof skillSourceInputSchema>;

export const skillSourceSchema = z
  .object({
    id: z.string().min(1).max(128),
    kind: skillSourceKindSchema,
    scope: skillScopeSchema,
    organizationId: z.number().int().positive().optional(),
    ownerUserId: z.number().int().positive().optional(),
    name: z.string().trim().min(1).max(128),
    locator: z.union([z.literal('skills.sh'), httpsLocatorSchema, sshGitLocatorSchema]),
    enabled: z.boolean().optional(),
    builtIn: z.boolean(),
    status: z.enum(['READY', 'DEGRADED', 'DISABLED']),
    lastErrorCode: z.string().min(1).max(80).nullable(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative()
  })
  .strict();

export const skillVersionSummarySchema = z
  .object({
    id: z.string().min(1).max(128),
    commitSha: z.string().regex(/^[0-9a-f]{40}$/),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    createdAt: z.number().int().nonnegative()
  })
  .strict();

const normalizedSkillNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const skillTagSchema = z.string().trim().min(1).max(32);
const skillPathSchema = z.union([
  z.literal('.'),
  z
    .string()
    .min(1)
    .max(1024)
    .regex(/^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\\\0]+$/)
]);

export const skillFavoriteSchema = z
  .object({
    id: z.string().min(1).max(128),
    sourceId: z.string().min(1).max(128),
    scope: configurableSkillScopeSchema,
    ownerOrganizationId: z.number().int().positive().optional(),
    ownerUserId: z.number().int().positive().optional(),
    repositoryIdentity: z.string().min(1).max(512),
    skillPath: skillPathSchema,
    normalizedName: normalizedSkillNameSchema,
    featured: z.boolean(),
    tags: z.array(skillTagSchema).max(10),
    currentVersion: skillVersionSummarySchema,
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative()
  })
  .strict()
  .superRefine((favorite, context) => {
    if ((favorite.scope === 'ORGANIZATION') !== (favorite.ownerOrganizationId !== undefined))
      context.addIssue({ code: 'custom', message: 'organization owner must match scope' });
    if ((favorite.scope === 'PERSONAL') !== (favorite.ownerUserId !== undefined))
      context.addIssue({ code: 'custom', message: 'user owner must match scope' });
  });
export type SkillFavorite = z.infer<typeof skillFavoriteSchema>;

export const skillFavoriteCreateInputSchema = z
  .object({
    sourceId: z.string().min(1).max(128),
    candidateId: z.string().min(1).max(1024),
    skillPath: skillPathSchema.optional(),
    scope: skillScopeSchema,
    organizationId: z.number().int().positive().optional(),
    featured: z.boolean().optional(),
    tags: z.array(skillTagSchema).max(10).optional()
  })
  .strict()
  .superRefine((favorite, context) => {
    if ((favorite.scope === 'ORGANIZATION') !== (favorite.organizationId !== undefined))
      context.addIssue({ code: 'custom', message: 'organizationId must match scope' });
    const tags = favorite.tags ?? [];
    if (new Set(tags.map((tag) => tag.toLocaleLowerCase())).size !== tags.length)
      context.addIssue({ code: 'custom', message: 'tags must be unique' });
  });
export type SkillFavoriteCreateInput = z.infer<typeof skillFavoriteCreateInputSchema>;

export const skillFavoritePresentationInputSchema = z
  .object({
    featured: z.boolean(),
    tags: z.array(skillTagSchema).max(10)
  })
  .strict()
  .superRefine((favorite, context) => {
    if (new Set(favorite.tags.map((tag) => tag.toLocaleLowerCase())).size !== favorite.tags.length)
      context.addIssue({ code: 'custom', message: 'tags must be unique' });
  });
export type SkillFavoritePresentationInput = z.infer<typeof skillFavoritePresentationInputSchema>;

export const skillInstallMetadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    favoriteId: z.string().min(1).max(128),
    versionId: z.string().min(1).max(128),
    commitSha: z.string().regex(/^[0-9a-f]{40}$/),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    installedAt: z.number().int().nonnegative()
  })
  .strict();
export type SkillInstallMetadata = z.infer<typeof skillInstallMetadataSchema>;

export const skillInstallStatusSchema = z.enum([
  'CURRENT',
  'UPDATE_AVAILABLE',
  'UNKNOWN_VERSION',
  'PARTIAL',
  'INVALID',
  'GIT_EXCLUDE_BROKEN',
  'INVALID_LINK'
]);
export const skillCompatibilityModeSchema = z.enum([
  'SYMLINK',
  'JUNCTION',
  'MANAGED_COPY',
  'UNAVAILABLE'
]);
export const installedSkillSchema = z
  .object({
    name: normalizedSkillNameSchema,
    description: z.string().max(4096),
    status: skillInstallStatusSchema,
    installedCommitSha: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .nullable()
      .optional(),
    favoriteCurrentCommitSha: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .nullable()
      .optional()
  })
  .strict();
export const skillTargetInspectionSchema = z
  .object({
    targetKind: z.enum(['NODE', 'WORKSPACE']),
    compatibilityMode: skillCompatibilityModeSchema,
    skills: z.array(installedSkillSchema).max(1000)
  })
  .strict();
export type SkillTargetInspection = z.infer<typeof skillTargetInspectionSchema>;
