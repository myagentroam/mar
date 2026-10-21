import { z } from 'zod';
import { PERMISSION_MATRIX_CONFIG } from './permission-matrix.config.js';

const roleSchema = z.enum(['ADMIN', 'ORG_ADMIN', 'MEMBER']);
const scopeSchema = z.enum(['SYSTEM', 'ORG_SUBTREE', 'PERSONAL', 'GRANTED_RESOURCE']);
const permissionSchema = z.string().regex(/^[A-Z][A-Z0-9_]{1,79}$/u);
const matrixSchema = z
  .object({
    matrixVersion: z.literal(2),
    roles: z.array(roleSchema).length(3),
    permissions: z.array(permissionSchema).min(1),
    grants: z.array(
      z.object({
        role: roleSchema,
        permissions: z
          .array(
            z.object({
              permissionId: permissionSchema,
              scopes: z.array(scopeSchema).min(1)
            })
          )
          .min(1)
      })
    )
  })
  .strict();

export type PermissionRole = z.infer<typeof roleSchema>;
export type PermissionScope = z.infer<typeof scopeSchema>;

export interface PermissionMatrix {
  readonly version: 2;
  readonly permissions: ReadonlySet<string>;
  readonly grants: ReadonlyMap<PermissionRole, ReadonlyMap<string, ReadonlySet<PermissionScope>>>;
}

export function loadPermissionMatrix(input: unknown = PERMISSION_MATRIX_CONFIG): PermissionMatrix {
  const config = matrixSchema.parse(input);
  assertUnique(config.roles, 'RBAC_ROLE_DUPLICATE');
  assertUnique(config.permissions, 'RBAC_PERMISSION_DUPLICATE');
  assertUnique(
    config.grants.map((grant) => grant.role),
    'RBAC_ROLE_GRANT_DUPLICATE'
  );
  if (config.grants.length !== config.roles.length) throw new Error('RBAC_ROLE_GRANT_MISSING');
  if (!['ADMIN', 'ORG_ADMIN', 'MEMBER'].every((role) => config.roles.includes(role as never)))
    throw new Error('RBAC_ROLE_SET_INVALID');
  const declared = new Set(config.permissions);
  for (const grant of config.grants) {
    assertUnique(
      grant.permissions.map((permission) => permission.permissionId),
      'RBAC_PERMISSION_GRANT_DUPLICATE'
    );
    if (grant.permissions.some((permission) => !declared.has(permission.permissionId)))
      throw new Error('RBAC_PERMISSION_UNKNOWN');
  }
  return {
    version: config.matrixVersion,
    permissions: declared,
    grants: new Map(
      config.grants.map((grant) => [
        grant.role,
        new Map(
          grant.permissions.map((permission) => [
            permission.permissionId,
            new Set(permission.scopes)
          ])
        )
      ])
    )
  };
}

function assertUnique(values: readonly string[], code: string): void {
  if (new Set(values).size !== values.length) throw new Error(code);
}
