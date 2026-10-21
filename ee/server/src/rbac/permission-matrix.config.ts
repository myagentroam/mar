const system = ['SYSTEM'] as const;
const personal = ['PERSONAL'] as const;
const subtree = ['ORG_SUBTREE'] as const;

export const PERMISSION_MATRIX_CONFIG = {
  matrixVersion: 2,
  roles: ['ADMIN', 'ORG_ADMIN', 'MEMBER'],
  permissions: [
    'LICENSE_READ',
    'LICENSE_IMPORT',
    'USER_MANAGE',
    'SELF_MANAGE',
    'ORG_MANAGE',
    'ROLE_ASSIGN',
    'RESOURCE_MANAGE',
    'NODE_MANAGE',
    'RESOURCE_OWNERSHIP_MANAGE',
    'RESOURCE_GRANT_MANAGE',
    'RESOURCE_USE',
    'SSO_MANAGE',
    'AUDIT_READ',
    'AUDIT_EXPORT',
    'SYSTEM_SETTINGS_MANAGE',
    'SECRET_MANAGE',
    'SKILL_SOURCE_MANAGE',
    'SKILL_FAVORITE_MANAGE'
  ],
  grants: [
    {
      role: 'ADMIN',
      permissions: [
        { permissionId: 'LICENSE_READ', scopes: system },
        { permissionId: 'LICENSE_IMPORT', scopes: system },
        { permissionId: 'USER_MANAGE', scopes: subtree },
        { permissionId: 'SELF_MANAGE', scopes: personal },
        { permissionId: 'ORG_MANAGE', scopes: subtree },
        { permissionId: 'ROLE_ASSIGN', scopes: subtree },
        { permissionId: 'RESOURCE_MANAGE', scopes: ['ORG_SUBTREE', 'PERSONAL'] },
        { permissionId: 'NODE_MANAGE', scopes: system },
        { permissionId: 'RESOURCE_OWNERSHIP_MANAGE', scopes: subtree },
        { permissionId: 'RESOURCE_GRANT_MANAGE', scopes: subtree },
        {
          permissionId: 'RESOURCE_USE',
          scopes: ['ORG_SUBTREE', 'PERSONAL', 'GRANTED_RESOURCE']
        },
        { permissionId: 'SSO_MANAGE', scopes: system },
        { permissionId: 'AUDIT_READ', scopes: ['SYSTEM', 'ORG_SUBTREE'] },
        { permissionId: 'AUDIT_EXPORT', scopes: ['SYSTEM', 'ORG_SUBTREE'] },
        { permissionId: 'SYSTEM_SETTINGS_MANAGE', scopes: system },
        { permissionId: 'SECRET_MANAGE', scopes: subtree },
        {
          permissionId: 'SKILL_SOURCE_MANAGE',
          scopes: ['SYSTEM', 'ORG_SUBTREE', 'PERSONAL']
        },
        {
          permissionId: 'SKILL_FAVORITE_MANAGE',
          scopes: ['SYSTEM', 'ORG_SUBTREE', 'PERSONAL']
        }
      ]
    },
    {
      role: 'ORG_ADMIN',
      permissions: [
        { permissionId: 'USER_MANAGE', scopes: subtree },
        { permissionId: 'SELF_MANAGE', scopes: personal },
        { permissionId: 'ORG_MANAGE', scopes: subtree },
        { permissionId: 'ROLE_ASSIGN', scopes: subtree },
        { permissionId: 'RESOURCE_MANAGE', scopes: ['ORG_SUBTREE', 'PERSONAL'] },
        { permissionId: 'RESOURCE_OWNERSHIP_MANAGE', scopes: subtree },
        { permissionId: 'RESOURCE_GRANT_MANAGE', scopes: subtree },
        {
          permissionId: 'RESOURCE_USE',
          scopes: ['ORG_SUBTREE', 'PERSONAL', 'GRANTED_RESOURCE']
        },
        { permissionId: 'AUDIT_READ', scopes: subtree },
        { permissionId: 'AUDIT_EXPORT', scopes: subtree },
        { permissionId: 'SECRET_MANAGE', scopes: subtree },
        { permissionId: 'SKILL_SOURCE_MANAGE', scopes: ['ORG_SUBTREE', 'PERSONAL'] },
        { permissionId: 'SKILL_FAVORITE_MANAGE', scopes: ['ORG_SUBTREE', 'PERSONAL'] }
      ]
    },
    {
      role: 'MEMBER',
      permissions: [
        { permissionId: 'SELF_MANAGE', scopes: personal },
        { permissionId: 'RESOURCE_MANAGE', scopes: personal },
        { permissionId: 'RESOURCE_USE', scopes: ['PERSONAL', 'GRANTED_RESOURCE'] },
        { permissionId: 'SKILL_SOURCE_MANAGE', scopes: personal },
        { permissionId: 'SKILL_FAVORITE_MANAGE', scopes: personal }
      ]
    }
  ]
} as const;
