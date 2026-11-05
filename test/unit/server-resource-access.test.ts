import Fastify from '../../ee/server/node_modules/fastify/fastify.js';
import type { PoolConnection } from 'mysql2/promise';
import { describe, expect, it, vi } from 'vitest';
import {
  resourceGrantSchema,
  type ServerWorkbenchCapabilities
} from '../../packages/protocol/src/index.js';
import type { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';
import { createTestMysqlEnvironmentSecretService } from '../support/mysql-environment-secret-service.js';
import type { NodeControl } from '../../ee/server/src/node-control.js';
import type { AuthorizationService } from '../../ee/server/src/rbac/authorization-service.js';
import { ResourceAccessService } from '../../ee/server/src/rbac/resource-access-service.js';
import { ResourceMutationService } from '../../ee/server/src/rbac/resource-mutation-service.js';
import { ResourceManagementDirectory } from '../../ee/server/src/rbac/resource-management-directory.js';
import { ResourceGrantService } from '../../ee/server/src/rbac/resource-grant-service.js';
import { registerNodeRoutes } from '../../ee/server/src/route/node-routes.js';
import type { EnvironmentSecretService } from '../../ee/server/src/service/environment-secret-service.js';
import type { NodeUpgradeService } from '../../packages/server-core/src/node-upgrade-service.js';
import { domainErrorStatus } from '../../packages/server-core/src/domain-errors.js';

const unrestrictedCredentialScope = { assertModelGrantWithinScope: async () => undefined };

describe('Server Node/Workspace ownership and grants', () => {
  it('delivers upgrade progress to a manager without granting Node use or ordinary events', async () => {
    const fixture = resourceFixture();
    fixture.node = { owner_type: 'PERSONAL', owner_user_id: 1, owner_organization_id: null };
    fixture.authorization.authorize = vi.fn(async (_userId, permission, context) => ({
      allowed: permission === 'NODE_MANAGE' && context?.ownerType === 'SYSTEM'
    }));
    const service = new ResourceAccessService(fixture.database, fixture.authorization);
    expect(await service.canRelay(8, 'node-1', 'workbench.node.receive', {})).toBe(false);
    expect(await service.canRelay(8, 'node-1', 'workbench.node.upgrade.receive', {})).toBe(true);
    fixture.authorization.authorize = vi.fn(async () => ({ allowed: false }));
    expect(await service.canRelay(8, 'node-1', 'workbench.node.upgrade.receive', {})).toBe(false);
  });
  it.each(['NODE', 'WORKSPACE'] as const)(
    'freezes %s secret CRUD ownership without auditing values',
    async (scope) => {
      const owner = { owner_type: 'ORGANIZATION', owner_user_id: null, owner_organization_id: 7 };
      let displayName = 'Historical resource';
      let secret: Record<string, unknown> | undefined;
      const audit = vi.fn(async (_event: unknown) => undefined);
      const execute = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        if (sql.includes('FROM nodes'))
          return [[{ id: 'node-1', nodeName: displayName, ...owner }], []];
        if (sql.includes('FROM workspaces'))
          return [
            [
              {
                workspace_id: 'workspace-1',
                node_id: 'node-1',
                workspaceName: displayName,
                ...owner
              }
            ],
            []
          ];
        if (sql.includes('COUNT(*)')) return [[{ count: 0 }], []];
        if (sql.startsWith('INSERT INTO environment_secrets')) {
          secret = {
            id: values[0],
            name: values[1],
            secret_value: values[2],
            scope: values[3],
            owner_user_id: values[4],
            organization_id: values[5],
            visibility: values[6],
            node_id: values[7],
            workspace_id: values[8],
            owner_key: values[9],
            created_at: values[10],
            updated_at: values[11]
          };
        }
        if (sql.startsWith('SELECT * FROM environment_secrets WHERE id=?'))
          return [[{ ...secret }], []];
        return [{ affectedRows: 1 }, []];
      });
      const connection = {
        execute,
        beginTransaction: vi.fn(async () => undefined),
        commit: vi.fn(async () => {
          owner.owner_organization_id = 8;
          displayName = 'Later resource';
        }),
        rollback: vi.fn(async () => undefined),
        release: vi.fn()
      };
      const service = createTestMysqlEnvironmentSecretService(
        {
          raw: { execute, getConnection: async () => connection },
          audit
        } as unknown as MysqlServerDatabase,
        async () => true,
        async () => true,
        async () => [],
        async () => true,
        async () => true
      );
      const created = await service.create(
        { userId: 1, isAdmin: true },
        {
          scope,
          nodeId: 'node-1',
          ...(scope === 'WORKSPACE' ? { workspaceId: 'workspace-1' } : {}),
          name: 'TEAM_KEY',
          value: 'private-original'
        }
      );
      owner.owner_organization_id = 7;
      displayName = 'Historical resource';
      await service.replace({ userId: 1, isAdmin: true }, created.id, 'private-replaced');
      owner.owner_organization_id = 7;
      displayName = 'Historical resource';
      await service.remove({ userId: 1, isAdmin: true }, created.id);
      expect(audit).toHaveBeenCalledTimes(3);
      for (const [event] of audit.mock.calls) {
        expect(event).toMatchObject({ organizationId: 7, targetName: 'TEAM_KEY' });
        expect(JSON.parse((event as { metadata: string }).metadata)).toMatchObject({
          scope,
          ownerType: 'ORGANIZATION',
          [scope === 'NODE' ? 'nodeName' : 'workspaceName']: 'Historical resource'
        });
      }
      expect(audit.mock.invocationCallOrder[0]!).toBeGreaterThan(
        connection.commit.mock.invocationCallOrder[0]!
      );
      expect(JSON.stringify(audit.mock.calls)).not.toContain('private-original');
      expect(JSON.stringify(audit.mock.calls)).not.toContain('private-replaced');
      expect(JSON.stringify(audit.mock.calls)).not.toContain('Later resource');
      expect(connection.rollback).not.toHaveBeenCalled();
    }
  );

  it.each(['MODEL', 'IMAGE_MODEL', 'TEMPLATE'] as const)(
    'retains the %s business name in grant and revoke snapshots',
    async (type) => {
      const fixture = resourceFixture();
      fixture.node = { owner_type: 'ORGANIZATION', owner_organization_id: 4, owner_user_id: null };
      fixture.model.name = 'Team model';
      fixture.imageModel.name = 'Team image model';
      const grants = new ResourceGrantService(
        fixture.database,
        fixture.authorization,
        unrestrictedCredentialScope
      );
      const resourceId =
        type === 'MODEL' ? 'model-1' : type === 'IMAGE_MODEL' ? 'image-model-1' : 'template-1';
      const name =
        type === 'MODEL'
          ? 'Team model'
          : type === 'IMAGE_MODEL'
            ? 'Team image model'
            : 'Team template';
      await grants.createGrant(
        1,
        type,
        resourceId,
        null,
        type === 'TEMPLATE'
          ? { targetType: 'ORGANIZATION', targetOrganizationId: 4 }
          : { targetType: 'USER', targetUserId: 8 }
      );
      expect(fixture.audit).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'resource.grant.created',
          targetName: name,
          organizationId: 4
        })
      );
      fixture.grant = {
        resource_type: type,
        model_id: type === 'MODEL' ? resourceId : null,
        image_model_id: type === 'IMAGE_MODEL' ? resourceId : null,
        template_id: type === 'TEMPLATE' ? resourceId : null,
        node_id: null,
        workspace_id: null,
        target_type: type === 'TEMPLATE' ? 'ORGANIZATION' : 'USER',
        target_user_id: type === 'TEMPLATE' ? null : 8,
        target_organization_id: type === 'TEMPLATE' ? 4 : null
      };
      await grants.removeGrant(1, 'grant-1');
      expect(fixture.audit).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'resource.grant.revoked',
          targetName: name,
          organizationId: 4
        })
      );
      if (type === 'TEMPLATE') {
        const events = fixture.audit.mock.calls.map(
          ([event]) =>
            event as {
              eventType: string;
              metadata: string;
            }
        );
        for (const eventType of ['resource.grant.created', 'resource.grant.revoked']) {
          const event = events.find((candidate) => candidate.eventType === eventType);
          expect(event).toBeDefined();
          expect(JSON.parse(event!.metadata)).toMatchObject({
            nodeId: 'source-node',
            workspaceId: 'source-workspace',
            nodeName: 'Source Node'
          });
        }
      }
    }
  );

  it('allows ADMIN to operate their personal Nodes and every organization Node only', async () => {
    const fixture = resourceFixture();
    const service = new ResourceAccessService(fixture.database, fixture.authorization);

    fixture.node = { owner_type: 'PERSONAL', owner_user_id: 1, owner_organization_id: null };
    await expect(service.canUseNode(1, 'personal-admin')).resolves.toBe(true);
    await expect(service.canUseNode(8, 'personal-other')).resolves.toBe(false);
    expect(fixture.authorization.authorize).not.toHaveBeenCalled();

    fixture.node = {
      owner_type: 'ORGANIZATION',
      owner_user_id: null,
      owner_organization_id: 99
    };
    await expect(service.canUseNode(1, 'organization-any')).resolves.toBe(true);
    expect(fixture.authorization.authorize).toHaveBeenCalledWith(1, 'RESOURCE_USE', {
      ownerType: 'ORGANIZATION',
      organizationId: 99,
      granted: false
    });
  });

  it('supports personal hosting only through explicit product admission for the owner', async () => {
    const fixture = resourceFixture();
    fixture.node = { owner_type: 'PERSONAL', owner_user_id: 1, owner_organization_id: null };
    let personal = true;
    const service = new ResourceAccessService(
      fixture.database,
      fixture.authorization,
      Date.now,
      undefined,
      async (userId) => personal && userId === 1
    );
    await expect(service.assertCanHostConversationTemplate('node-1')).resolves.toBeUndefined();
    await expect(service.canUseTemplate(1, 'template-1')).resolves.toBe(true);
    await expect(service.canUseTemplate(8, 'template-1')).resolves.toBe(false);
    personal = false;
    await expect(service.assertCanHostConversationTemplate('node-1')).rejects.toThrow(
      'CONVERSATION_TEMPLATE_HOST_NODE_INVALID'
    );
    await expect(service.canUseTemplate(1, 'template-1')).resolves.toBe(false);
  });
  it('limits template access grants to organizations inside the hosting Node subtree', async () => {
    const fixture = resourceFixture();
    const service = new ResourceAccessService(fixture.database, fixture.authorization, () => 2_000);
    const grants = new ResourceGrantService(
      fixture.database,
      fixture.authorization,
      unrestrictedCredentialScope,
      () => 2_000
    );
    fixture.node = {
      owner_type: 'ORGANIZATION',
      owner_user_id: null,
      owner_organization_id: 2
    };
    fixture.authorization.actorContext = vi.fn(async () => ({
      role: 'MEMBER' as const,
      organizationId: 4
    }));
    fixture.templateGranted = true;
    await expect(service.canUseTemplate(8, 'template-1')).resolves.toBe(true);
    const templateGrantQuery = fixture.raw.execute.mock.calls.find(([sql]) =>
      String(sql).includes("resource_type='TEMPLATE'")
    )?.[0];
    expect(String(templateGrantQuery)).toContain("target_type='ORGANIZATION'");
    expect(String(templateGrantQuery)).not.toContain("target_type='USER'");
    expect(String(templateGrantQuery)).not.toContain("target_type='ENTERPRISE'");
    fixture.templateGranted = false;
    await expect(service.canUseTemplate(8, 'template-1')).resolves.toBe(false);

    fixture.authorization.actorContext = vi.fn(async () => ({
      role: 'ADMIN' as const,
      organizationId: 1
    }));
    await expect(
      grants.createGrant(1, 'TEMPLATE', 'template-1', null, {
        targetType: 'ORGANIZATION',
        targetOrganizationId: 4
      })
    ).resolves.toBeTypeOf('string');
    expect(fixture.connection.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO resource_grants'),
      expect.arrayContaining(['TEMPLATE', null, null, null, 'template-1', 'ORGANIZATION', null, 4])
    );
    await expect(
      grants.createGrant(1, 'TEMPLATE', 'template-1', null, {
        targetType: 'USER',
        targetUserId: 8
      })
    ).rejects.toThrow('CONVERSATION_TEMPLATE_GRANT_SCOPE_INVALID');
    await expect(
      grants.createGrant(1, 'TEMPLATE', 'template-1', null, { targetType: 'ENTERPRISE' } as never)
    ).rejects.toThrow('CONVERSATION_TEMPLATE_GRANT_SCOPE_INVALID');

    fixture.placementAllowed = false;
    await expect(
      grants.createGrant(1, 'TEMPLATE', 'template-1', null, {
        targetType: 'ORGANIZATION',
        targetOrganizationId: 1
      })
    ).rejects.toThrow('CONVERSATION_TEMPLATE_GRANT_SCOPE_INVALID');

    fixture.placementAllowed = true;
    fixture.node = {
      owner_type: 'ORGANIZATION',
      owner_user_id: null,
      owner_organization_id: 1
    };
    await expect(
      grants.createGrant(1, 'TEMPLATE', 'template-1', null, {
        targetType: 'ORGANIZATION',
        targetOrganizationId: 1
      })
    ).resolves.toBeTypeOf('string');

    fixture.authorization.actorContext = vi.fn(async () => ({
      role: 'ORG_ADMIN' as const,
      organizationId: 2
    }));
    await expect(grants.listGrants(2, 'TEMPLATE', 'template-1', null)).rejects.toThrow(
      'TEMPLATE_RESOURCE_ADMIN_REQUIRED'
    );
  });

  it('rejects template hosting and use on personal Nodes', async () => {
    const fixture = resourceFixture();
    fixture.node = { owner_type: 'PERSONAL', owner_user_id: 1, owner_organization_id: null };
    fixture.templateGranted = true;
    const service = new ResourceAccessService(fixture.database, fixture.authorization);
    const grants = new ResourceGrantService(
      fixture.database,
      fixture.authorization,
      unrestrictedCredentialScope
    );

    await expect(service.assertCanHostConversationTemplate('node-1')).rejects.toThrow(
      'CONVERSATION_TEMPLATE_HOST_NODE_INVALID'
    );
    await expect(service.canUseTemplate(8, 'template-1')).resolves.toBe(false);
    await expect(
      grants.createGrant(1, 'TEMPLATE', 'template-1', null, {
        targetType: 'ORGANIZATION',
        targetOrganizationId: 1
      })
    ).rejects.toThrow('CONVERSATION_TEMPLATE_HOST_NODE_INVALID');
  });

  it('returns protocol-complete grant DTOs for templates and scoped workspaces', async () => {
    const fixture = resourceFixture();
    const grants = new ResourceGrantService(
      fixture.database,
      fixture.authorization,
      unrestrictedCredentialScope
    );
    fixture.listedGrants = [
      {
        id: 'grant-template',
        target_type: 'ORGANIZATION',
        target_user_id: null,
        target_organization_id: 4,
        grant_scope_organization_id: 1,
        created_by_user_id: 1,
        created_at: 2_000
      }
    ];

    expect(
      (await grants.listGrants(1, 'TEMPLATE', 'template-1', null)).map((grant) =>
        resourceGrantSchema.parse(grant)
      )
    ).toEqual([
      {
        id: 'grant-template',
        resourceType: 'TEMPLATE',
        templateId: 'template-1',
        targetType: 'ORGANIZATION',
        targetOrganizationId: 4,
        grantScopeOrganizationId: 1,
        createdByUserId: 1,
        createdAt: 2_000
      }
    ]);

    fixture.workspace = {
      owner_type: 'ORGANIZATION',
      owner_user_id: null,
      owner_organization_id: 2
    };
    fixture.listedGrants = [
      {
        id: 'grant-workspace',
        target_type: 'USER',
        target_user_id: 8,
        target_organization_id: null,
        grant_scope_organization_id: 2,
        created_by_user_id: 3,
        created_at: 2_100
      }
    ];

    expect(
      (await grants.listGrants(1, 'WORKSPACE', 'node-1', 'workspace-1')).map((grant) =>
        resourceGrantSchema.parse(grant)
      )
    ).toEqual([
      {
        id: 'grant-workspace',
        resourceType: 'WORKSPACE',
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        targetType: 'USER',
        targetUserId: 8,
        grantScopeOrganizationId: 2,
        createdByUserId: 3,
        createdAt: 2_100
      }
    ]);
  });

  it('separates model management from organization and root use grants', async () => {
    const fixture = resourceFixture();
    const service = new ResourceAccessService(fixture.database, fixture.authorization, () => 2_000);
    const grants = new ResourceGrantService(
      fixture.database,
      fixture.authorization,
      unrestrictedCredentialScope,
      () => 2_000
    );
    fixture.authorization.actorContext = vi.fn(async () => ({
      role: 'MEMBER' as const,
      organizationId: 4
    }));
    fixture.modelGranted = true;
    await expect(service.canUseModel(8, 'model-1')).resolves.toBe(true);
    fixture.modelGranted = false;
    await expect(service.canUseModel(8, 'model-1')).resolves.toBe(false);

    fixture.authorization.actorContext = vi.fn(async () => ({
      role: 'ADMIN' as const,
      organizationId: 1
    }));
    await expect(service.canUseModel(1, 'model-1')).resolves.toBe(false);
    fixture.modelGranted = true;
    await expect(service.canUseModel(1, 'model-1')).resolves.toBe(true);
    await expect(
      grants.createGrant(1, 'MODEL', 'model-1', null, {
        targetType: 'ORGANIZATION',
        targetOrganizationId: 1
      })
    ).resolves.toBeTypeOf('string');
    expect(fixture.connection.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO resource_grants'),
      expect.arrayContaining(['MODEL', null, null, 'model-1', 'ORGANIZATION'])
    );

    fixture.authorization.actorContext = vi.fn(async () => ({
      role: 'ORG_ADMIN' as const,
      organizationId: 2
    }));
    fixture.modelManageAllowed = false;
    await expect(
      grants.createGrant(2, 'MODEL', 'model-1', null, {
        targetType: 'ORGANIZATION',
        targetOrganizationId: 4
      })
    ).rejects.toThrow('RBAC_DENIED');
  });

  it('applies the same ownership and grant rules to image models', async () => {
    const fixture = resourceFixture();
    const service = new ResourceAccessService(fixture.database, fixture.authorization);
    const grants = new ResourceGrantService(
      fixture.database,
      fixture.authorization,
      unrestrictedCredentialScope
    );
    fixture.authorization.actorContext = vi.fn(async () => ({
      role: 'MEMBER' as const,
      organizationId: 4
    }));

    await expect(service.canUseImageModel(8, 'image-model-1')).resolves.toBe(false);
    fixture.imageModelGranted = true;
    await expect(service.canUseImageModel(8, 'image-model-1')).resolves.toBe(true);

    fixture.authorization.actorContext = vi.fn(async () => ({
      role: 'ADMIN' as const,
      organizationId: 1
    }));
    await expect(
      grants.createGrant(1, 'IMAGE_MODEL', 'image-model-1', null, {
        targetType: 'ORGANIZATION',
        targetOrganizationId: 4
      })
    ).resolves.toBeTypeOf('string');
    expect(fixture.connection.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO resource_grants'),
      expect.arrayContaining(['IMAGE_MODEL', null, null, null, 'image-model-1'])
    );

    fixture.listedGrants = [
      {
        id: 'grant-image-model',
        target_type: 'ORGANIZATION',
        target_user_id: null,
        target_organization_id: 4,
        grant_scope_organization_id: 1,
        created_by_user_id: 1,
        created_at: 2_000
      }
    ];
    await expect(grants.listGrants(1, 'IMAGE_MODEL', 'image-model-1', null)).resolves.toEqual([
      expect.objectContaining({
        resourceType: 'IMAGE_MODEL',
        imageModelId: 'image-model-1',
        targetOrganizationId: 4
      })
    ]);

    fixture.imageModel = {
      owner_type: 'PERSONAL',
      owner_user_id: 8,
      owner_organization_id: null
    };
    await expect(
      grants.createGrant(1, 'IMAGE_MODEL', 'image-model-1', null, {
        targetType: 'ORGANIZATION',
        targetOrganizationId: 1
      })
    ).rejects.toThrow('PERSONAL_RESOURCE_NOT_SHAREABLE');
  });

  it('keeps personal text and image models private even from system administrators', async () => {
    const fixture = resourceFixture();
    const service = new ResourceAccessService(fixture.database, fixture.authorization);
    fixture.model = {
      owner_type: 'PERSONAL',
      owner_user_id: 8,
      owner_organization_id: null
    };
    fixture.imageModel = { ...fixture.model };

    await expect(service.canManageModel(1, 'model-1')).resolves.toBe(false);
    await expect(service.canManageImageModel(1, 'image-model-1')).resolves.toBe(false);
    await expect(service.canManageModel(8, 'model-1')).resolves.toBe(true);
    await expect(service.canManageImageModel(8, 'image-model-1')).resolves.toBe(true);
    await expect(service.canUseModel(1, 'model-1')).resolves.toBe(false);
    await expect(service.canUseImageModel(1, 'image-model-1')).resolves.toBe(false);
    expect(fixture.authorization.authorize).not.toHaveBeenCalledWith(
      1,
      'RESOURCE_MANAGE',
      expect.anything()
    );
  });

  it('rejects a model grant targeting an organization that does not exist', async () => {
    const fixture = resourceFixture();
    fixture.organizationExists = false;
    const grants = new ResourceGrantService(
      fixture.database,
      fixture.authorization,
      unrestrictedCredentialScope
    );

    await expect(
      grants.createGrant(1, 'MODEL', 'model-1', null, {
        targetType: 'ORGANIZATION',
        targetOrganizationId: 404
      })
    ).rejects.toThrow('ORGANIZATION_NOT_FOUND');
    expect(fixture.database.raw.execute).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO resource_grants'),
      expect.any(Array)
    );
  });

  it('rejects model grants outside the bound credential scope', async () => {
    const fixture = resourceFixture();
    const credentialScopes = {
      assertModelGrantWithinScope: vi.fn(async () => {
        throw new Error('CODEX_CREDENTIAL_SCOPE_FORBIDDEN');
      }),
      canUserUseModelCredential: vi.fn(async () => true)
    };
    const grants = new ResourceGrantService(
      fixture.database,
      fixture.authorization,
      credentialScopes,
      () => 2_000
    );

    await expect(
      grants.createGrant(1, 'MODEL', 'model-1', null, {
        targetType: 'ORGANIZATION',
        targetOrganizationId: 1
      })
    ).rejects.toThrow('CODEX_CREDENTIAL_SCOPE_FORBIDDEN');
    expect(credentialScopes.assertModelGrantWithinScope).toHaveBeenCalledWith('model-1', {
      targetType: 'ORGANIZATION',
      targetOrganizationId: 1
    });
    expect(fixture.database.raw.execute).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO resource_grants'),
      expect.any(Array)
    );
  });

  it('filters model use when a grant exists but the user has left the credential scope', async () => {
    const fixture = resourceFixture();
    fixture.modelGranted = true;
    const credentialScopes = {
      assertModelGrantWithinScope: vi.fn(async () => undefined),
      canUserUseModelCredential: vi.fn(async () => false)
    };
    const service = new ResourceAccessService(
      fixture.database,
      fixture.authorization,
      () => 2_000,
      credentialScopes
    );

    await expect(service.canUseModel(8, 'model-1')).resolves.toBe(false);
    expect(credentialScopes.canUserUseModelCredential).toHaveBeenCalledWith(8, 'model-1');
  });

  it('rejects model use for a disabled user even when a direct grant still exists', async () => {
    const fixture = resourceFixture();
    fixture.modelGranted = true;
    fixture.authorization.actorContext = vi.fn(async () => undefined);
    const credentialScopes = {
      assertModelGrantWithinScope: vi.fn(async () => undefined),
      canUserUseModelCredential: vi.fn(async () => true)
    };
    const service = new ResourceAccessService(
      fixture.database,
      fixture.authorization,
      () => 2_000,
      credentialScopes
    );

    await expect(service.canUseModel(8, 'model-1')).resolves.toBe(false);
    expect(credentialScopes.canUserUseModelCredential).not.toHaveBeenCalled();
  });

  it('rejects model grant management when the model no longer exists', async () => {
    const fixture = resourceFixture();
    fixture.modelExists = false;
    fixture.authorization.actorContext = vi.fn(async () => ({
      role: 'ORG_ADMIN' as const,
      organizationId: 2
    }));
    const grants = new ResourceGrantService(
      fixture.database,
      fixture.authorization,
      unrestrictedCredentialScope
    );

    await expect(
      grants.createGrant(2, 'MODEL', 'missing-model', null, {
        targetType: 'ORGANIZATION',
        targetOrganizationId: 1
      })
    ).rejects.toThrow('RESOURCE_NOT_FOUND');
    await expect(grants.listGrants(2, 'MODEL', 'missing-model', null)).rejects.toThrow(
      'RESOURCE_NOT_FOUND'
    );
    expect(fixture.database.raw.execute).not.toHaveBeenCalledWith(
      'SELECT id FROM mar_agent_models WHERE id=?',
      ['missing-model']
    );
  });

  it('rejects model grant removal when the model no longer exists', async () => {
    const fixture = resourceFixture();
    fixture.modelExists = false;
    fixture.grant = {
      resource_type: 'MODEL',
      node_id: null,
      workspace_id: null,
      model_id: 'missing-model',
      image_model_id: null,
      grant_authority: 'ENTERPRISE'
    };
    fixture.authorization.actorContext = vi.fn(async () => ({
      role: 'ORG_ADMIN' as const,
      organizationId: 2
    }));
    const grants = new ResourceGrantService(
      fixture.database,
      fixture.authorization,
      unrestrictedCredentialScope
    );

    await expect(grants.removeGrant(2, 'grant-model')).rejects.toThrow('RESOURCE_NOT_FOUND');
    expect(fixture.database.raw.execute).toHaveBeenCalledWith(
      expect.stringContaining('FROM mar_agent_models WHERE id=?'),
      ['missing-model']
    );
  });

  it('enforces personal co-ownership, organization descendant placement and tombstones', async () => {
    const fixture = resourceFixture();
    const service = new ResourceAccessService(fixture.database, fixture.authorization, () => 2_000);
    fixture.node = { owner_type: 'PERSONAL', owner_user_id: 1, owner_organization_id: null };
    await expect(
      mutationFor(fixture, service).registerWorkspace(1, 'node-1', 'workspace-1', {
        ownerType: 'PERSONAL',
        ownerUserId: 1
      })
    ).resolves.toBeUndefined();
    await expect(
      mutationFor(fixture, service).registerWorkspace(2, 'node-1', 'workspace-2', {
        ownerType: 'PERSONAL',
        ownerUserId: 2
      })
    ).rejects.toThrow('WORKSPACE_NODE_OWNERSHIP_INCOMPATIBLE');

    fixture.node = { owner_type: 'ORGANIZATION', owner_user_id: null, owner_organization_id: 2 };
    fixture.placementAllowed = true;
    await expect(
      mutationFor(fixture, service).registerWorkspace(1, 'node-1', 'workspace-3', {
        ownerType: 'ORGANIZATION',
        ownerOrganizationId: 4
      })
    ).resolves.toBeUndefined();
    fixture.placementAllowed = false;
    await expect(
      mutationFor(fixture, service).registerWorkspace(1, 'node-1', 'workspace-4', {
        ownerType: 'ORGANIZATION',
        ownerOrganizationId: 5
      })
    ).rejects.toThrow('WORKSPACE_NODE_OWNERSHIP_INCOMPATIBLE');

    fixture.placementAllowed = true;
    fixture.tombstoned = true;
    await expect(
      mutationFor(fixture, service).registerWorkspace(1, 'node-1', 'workspace-deleted', {
        ownerType: 'ORGANIZATION',
        ownerOrganizationId: 4
      })
    ).rejects.toThrow('WORKSPACE_ID_REUSED');
  });

  it('lets a directly granted user register organization Workspaces and manage only that Node secrets', async () => {
    const fixture = resourceFixture();
    fixture.node = {
      owner_type: 'ORGANIZATION',
      owner_user_id: null,
      owner_organization_id: 2
    };
    fixture.directNodeGranted = true;
    fixture.authorization.authorize = vi.fn(async (_userId, permission, context) => ({
      allowed: permission === 'RESOURCE_USE' && context?.granted === true
    }));
    const service = new ResourceAccessService(fixture.database, fixture.authorization);

    const ownership = await service.resolveWorkspaceOwnership(8, 'node-1', {
      ownerType: 'ORGANIZATION',
      ownerOrganizationId: 999
    });
    expect(ownership).toEqual({ ownerType: 'ORGANIZATION', ownerOrganizationId: 2 });
    await expect(service.canUseNode(8, 'node-1')).resolves.toBe(true);
    await expect(service.canRegisterWorkspace(8, 'node-1')).resolves.toBe(true);
    await expect(service.canManageNode(8, 'node-1')).resolves.toBe(false);
    await expect(service.canManageNodeSecrets(8, 'node-1')).resolves.toBe(true);
    await expect(
      mutationFor(fixture, service).registerWorkspace(
        8,
        'node-1',
        'workspace-direct-grant',
        ownership
      )
    ).resolves.toBeUndefined();
    expect(fixture.connection.execute).toHaveBeenCalledWith(
      expect.stringContaining('LIMIT 1 FOR SHARE'),
      [8, 'NODE:node-1:', 8]
    );

    fixture.directNodeGranted = false;
    await expect(service.resolveWorkspaceOwnership(8, 'node-1', undefined)).rejects.toThrow(
      'WORKSPACE_NODE_OWNERSHIP_INCOMPATIBLE'
    );
    await expect(service.canRegisterWorkspace(8, 'node-1')).resolves.toBe(false);
    await expect(service.canManageNodeSecrets(8, 'node-1')).resolves.toBe(false);
  });

  it('rechecks the direct Node grant before registering a Workspace', async () => {
    const fixture = resourceFixture();
    fixture.node = {
      owner_type: 'ORGANIZATION',
      owner_user_id: null,
      owner_organization_id: 2
    };
    fixture.directNodeGranted = true;
    fixture.authorization.authorize = vi.fn(async (_userId, permission, context) => ({
      allowed: permission === 'RESOURCE_USE' && context?.granted === true
    }));
    const service = new ResourceAccessService(fixture.database, fixture.authorization);
    const ownership = await service.resolveWorkspaceOwnership(8, 'node-1');

    fixture.directNodeGranted = false;
    await expect(
      mutationFor(fixture, service).registerWorkspace(
        8,
        'node-1',
        'workspace-after-revoke',
        ownership
      )
    ).rejects.toThrow('RBAC_DENIED');
    expect(fixture.connection.execute).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO workspaces'),
      expect.any(Array)
    );
  });

  it('rejects registration when Node management is revoked after preflight and before the transaction', async () => {
    const fixture = resourceFixture();
    fixture.node = { owner_type: 'ORGANIZATION', owner_user_id: null, owner_organization_id: 2 };
    const service = new ResourceAccessService(fixture.database, fixture.authorization);
    vi.mocked(fixture.authorization.authorize).mockImplementation(async () => ({
      allowed: fixture.modelManageAllowed
    }));
    fixture.connection.beginTransaction.mockImplementation(async () => {
      fixture.modelManageAllowed = false;
    });
    await expect(
      mutationFor(fixture, service).registerWorkspace(8, 'node-1', 'late-workspace', {
        ownerType: 'ORGANIZATION',
        ownerOrganizationId: 2
      })
    ).rejects.toThrow('WORKSPACE_NODE_OWNERSHIP_INCOMPATIBLE');
    expect(fixture.connection.execute).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO workspaces'),
      expect.anything()
    );
    expect(fixture.connection.rollback).toHaveBeenCalledOnce();
  });

  it('does not treat a non-user Node grant as a secret-management grant', async () => {
    const fixture = resourceFixture();
    fixture.node = {
      owner_type: 'ORGANIZATION',
      owner_user_id: null,
      owner_organization_id: 2
    };
    fixture.nodeGranted = true;
    fixture.authorization.authorize = vi.fn(async (_userId, permission, context) => ({
      allowed: permission === 'RESOURCE_USE' && context?.granted === true
    }));
    const service = new ResourceAccessService(fixture.database, fixture.authorization);

    await expect(service.canUseNode(8, 'node-1')).resolves.toBe(true);
    await expect(service.canRegisterWorkspace(8, 'node-1')).resolves.toBe(false);
    await expect(service.canManageNodeSecrets(8, 'node-1')).resolves.toBe(false);
  });

  it('uses Node access rather than Node ownership when resolving Node secrets', async () => {
    let directlyGranted = true;
    const service = createTestMysqlEnvironmentSecretService(
      {
        listNodes: vi.fn(async () => [
          { id: 'node-1', metadata: JSON.stringify({ nodeAppVersion: '0.1.4' }) }
        ]),
        raw: {
          execute: vi.fn(async () => [[{ name: 'NODE_SECRET', secret_value: 'granted-value' }], []])
        }
      } as unknown as MysqlServerDatabase,
      async () => false,
      async () => directlyGranted
    );

    await expect(service.resolve(8, 'node-1')).resolves.toEqual({ NODE_SECRET: 'granted-value' });
    directlyGranted = false;
    await expect(service.resolve(8, 'node-1')).rejects.toThrow('NODE_FORBIDDEN');
  });

  it('projects only the separate Workspace and secret capabilities for directly granted Nodes', async () => {
    const app = Fastify();
    const database = {
      findCurrentUserSession: vi.fn(() => ({
        userId: 8,
        username: 'member',
        isAdmin: false,
        sessionHash: 'session-hash',
        mustChangePassword: false,
        csrfTokenHash: 'csrf-token-hash'
      }))
    } as unknown as MysqlServerDatabase;
    const nodeControl = {
      isNodeUpgradeOnly: vi.fn(() => false),
      listNodes: vi.fn(async () => [
        {
          id: 'node-1',
          metadata: JSON.stringify({ nodeAppVersion: '0.9.63' }),
          connected: true,
          disabled: false,
          lastHeartbeatAt: null
        }
      ])
    } as unknown as NodeControl;
    const resources = {
      canAccessNodeContainer: vi.fn(async () => true),
      nodeOwnership: vi.fn(async () => ({
        ownerType: 'ORGANIZATION' as const,
        ownerOrganizationId: 2
      })),
      canManageNode: vi.fn(async () => false),
      canRegisterWorkspace: vi.fn(async () => true),
      canManageNodeSecrets: vi.fn(async () => true)
    } as unknown as ResourceAccessService;
    registerNodeRoutes({
      app,
      database,
      nodeControl,
      nodeUpgrades: {
        availability: vi.fn(async () => ({ state: 'CURRENT', targetVersion: '0.9.63' }))
      } as unknown as NodeUpgradeService,
      publicOrigin: undefined,
      capabilities: {} as ServerWorkbenchCapabilities,
      secrets: {} as EnvironmentSecretService,
      resources,
      mutations: {
        changeNodeOwnership: vi.fn(async () => {
          throw new Error('UNEXPECTED_MUTATION');
        })
      }
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/nodes',
      headers: { cookie: 'mar_user_session=session-id' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().nodes).toEqual([
      expect.objectContaining({
        id: 'node-1',
        manageable: false,
        workspaceCreatable: true,
        secretManageable: true
      })
    ]);
    await app.close();
  });

  it('updates a Workspace group with node registration permission rather than Workspace management', async () => {
    const fixture = resourceFixture();
    fixture.workspace = {
      owner_type: 'ORGANIZATION',
      owner_user_id: null,
      owner_organization_id: 2
    };
    const service = new ResourceAccessService(fixture.database, fixture.authorization);
    const canRegisterWorkspace = vi.spyOn(service, 'canRegisterWorkspace').mockResolvedValue(true);
    const canManageWorkspace = vi.spyOn(service, 'canManageWorkspace').mockResolvedValue(false);

    await expect(
      mutationFor(fixture, service).updateWorkspaceGroupName(
        8,
        'node-1',
        'workspace-1',
        ' Engineering '
      )
    ).resolves.toBeUndefined();

    expect(canRegisterWorkspace).toHaveBeenCalledWith(8, 'node-1', fixture.connection);
    expect(canManageWorkspace).not.toHaveBeenCalled();
    expect(fixture.connection.execute).toHaveBeenCalledWith(
      'UPDATE workspaces SET group_name=? WHERE workspace_id=? AND node_id=?',
      ['Engineering', 'workspace-1', 'node-1']
    );
  });

  it('rejects a Workspace group update when node registration is not allowed', async () => {
    const fixture = resourceFixture();
    const service = new ResourceAccessService(fixture.database, fixture.authorization);
    vi.spyOn(service, 'canRegisterWorkspace').mockResolvedValue(false);

    await expect(
      mutationFor(fixture, service).updateWorkspaceGroupName(
        8,
        'node-1',
        'workspace-1',
        'Engineering'
      )
    ).rejects.toThrow('WORKSPACE_FORBIDDEN');
    expect(fixture.connection.execute).not.toHaveBeenCalledWith(
      'UPDATE workspaces SET group_name=? WHERE workspace_id=? AND node_id=?',
      expect.anything()
    );
  });

  it('authorizes Workspace removal and relay only through ownership management', async () => {
    const fixture = resourceFixture();
    fixture.workspace = {
      owner_type: 'ORGANIZATION',
      owner_user_id: null,
      owner_organization_id: 2
    };
    const service = new ResourceAccessService(fixture.database, fixture.authorization);
    const canRegisterWorkspace = vi.spyOn(service, 'canRegisterWorkspace').mockResolvedValue(false);
    await expect(
      service.assertCanUnregisterWorkspace(8, 'node-1', 'workspace-1')
    ).resolves.toBeUndefined();
    await expect(
      service.canRelay(8, 'node-1', 'workspace.remove', {}, 'workspace-1')
    ).resolves.toBe(true);
    expect(canRegisterWorkspace).not.toHaveBeenCalled();
    expect(fixture.authorization.authorize).toHaveBeenCalledWith(
      8,
      'RESOURCE_MANAGE',
      {
        ownerType: 'ORGANIZATION',
        organizationId: 2
      },
      undefined
    );
  });

  it('does not turn a direct Node grant into Workspace deletion authority', async () => {
    const fixture = resourceFixture();
    fixture.node = fixture.workspace = {
      owner_type: 'ORGANIZATION',
      owner_user_id: null,
      owner_organization_id: 2
    };
    fixture.directNodeGranted = true;
    fixture.modelManageAllowed = false;
    const service = new ResourceAccessService(fixture.database, fixture.authorization);
    await expect(service.canRegisterWorkspace(8, 'node-1')).resolves.toBe(true);
    await expect(service.assertCanUnregisterWorkspace(8, 'node-1', 'workspace-1')).rejects.toThrow(
      'WORKSPACE_FORBIDDEN'
    );
    await expect(
      service.canRelay(8, 'node-1', 'workspace.remove', {}, 'workspace-1')
    ).resolves.toBe(false);
    await expect(
      mutationFor(fixture, service).unregisterWorkspace(8, 'node-1', 'workspace-1')
    ).rejects.toThrow('WORKSPACE_FORBIDDEN');
    expect(fixture.connection.beginTransaction).not.toHaveBeenCalled();
  });

  it('does not let an administrator remove another user personal Workspace', async () => {
    const fixture = resourceFixture();
    const service = new ResourceAccessService(fixture.database, fixture.authorization);
    await expect(service.assertCanUnregisterWorkspace(8, 'node-1', 'workspace-1')).rejects.toThrow(
      'WORKSPACE_FORBIDDEN'
    );
  });

  it('rejects Workspace removal when a conversation template still references it', async () => {
    const fixture = resourceFixture();
    fixture.workspace = {
      owner_type: 'ORGANIZATION',
      owner_user_id: null,
      owner_organization_id: 2
    };
    fixture.workspaceReferencedByTemplate = true;
    const service = new ResourceAccessService(fixture.database, fixture.authorization);
    vi.spyOn(service, 'canRegisterWorkspace').mockResolvedValue(true);

    await expect(service.assertCanUnregisterWorkspace(8, 'node-1', 'workspace-1')).rejects.toThrow(
      'WORKSPACE_CONVERSATION_TEMPLATE_REFERENCE_EXISTS'
    );
    await expect(
      service.canRelay(8, 'node-1', 'workspace.remove', {}, 'workspace-1')
    ).resolves.toBe(false);
    expect(fixture.connection.execute).not.toHaveBeenCalledWith(
      'DELETE FROM workspaces WHERE workspace_id=? AND node_id=?',
      ['workspace-1', 'node-1']
    );
  });

  it('rechecks a template reference under locks before deleting a Workspace', async () => {
    const fixture = resourceFixture();
    fixture.node = fixture.workspace = {
      owner_type: 'ORGANIZATION',
      owner_user_id: null,
      owner_organization_id: 2
    };
    const service = new ResourceAccessService(fixture.database, fixture.authorization);
    vi.spyOn(service, 'assertCanUnregisterWorkspace').mockResolvedValueOnce(undefined);
    fixture.workspaceReferencedByTemplate = true;

    await expect(
      mutationFor(fixture, service).unregisterWorkspace(8, 'node-1', 'workspace-1')
    ).rejects.toThrow('WORKSPACE_CONVERSATION_TEMPLATE_REFERENCE_EXISTS');

    expect(fixture.connection.execute).toHaveBeenCalledWith(
      expect.stringContaining('WHERE workspace_id=? AND node_id=? FOR UPDATE'),
      ['workspace-1', 'node-1']
    );
    expect(fixture.connection.execute).toHaveBeenCalledWith(
      expect.stringContaining('source_workspace_id=? LIMIT 1 FOR SHARE'),
      ['workspace-1']
    );
    expect(fixture.connection.execute).not.toHaveBeenCalledWith(
      'DELETE FROM workspaces WHERE workspace_id=? AND node_id=?',
      ['workspace-1', 'node-1']
    );
  });

  it('cleans Workspace secrets and grants in the deletion transaction', async () => {
    const fixture = resourceFixture();
    fixture.node = fixture.workspace = {
      owner_type: 'ORGANIZATION',
      owner_user_id: null,
      owner_organization_id: 2
    };
    const service = new ResourceAccessService(fixture.database, fixture.authorization);
    vi.spyOn(service, 'assertCanUnregisterWorkspace').mockResolvedValueOnce(undefined);

    await expect(
      mutationFor(fixture, service).unregisterWorkspace(8, 'node-1', 'workspace-1')
    ).resolves.toBeUndefined();

    expect(fixture.connection.execute).toHaveBeenCalledWith(
      "DELETE FROM environment_secrets WHERE scope='WORKSPACE' AND node_id=? AND workspace_id=?",
      ['node-1', 'workspace-1']
    );
    expect(fixture.connection.execute).toHaveBeenCalledWith(
      "DELETE FROM resource_grants WHERE resource_type='WORKSPACE' AND node_id=? AND workspace_id=?",
      ['node-1', 'workspace-1']
    );
    expect(fixture.connection.commit).toHaveBeenCalledOnce();
  });

  it('does not delete a Workspace when management is revoked after preflight', async () => {
    const fixture = resourceFixture();
    fixture.node = fixture.workspace = {
      owner_type: 'ORGANIZATION',
      owner_user_id: null,
      owner_organization_id: 2
    };
    const service = new ResourceAccessService(fixture.database, fixture.authorization);
    fixture.connection.beginTransaction.mockImplementation(async () => {
      fixture.modelManageAllowed = false;
    });
    await expect(
      mutationFor(fixture, service).unregisterWorkspace(8, 'node-1', 'workspace-1')
    ).rejects.toThrow('WORKSPACE_FORBIDDEN');
    expect(fixture.authorization.authorize).toHaveBeenLastCalledWith(
      8,
      'RESOURCE_MANAGE',
      {
        ownerType: 'ORGANIZATION',
        organizationId: 2
      },
      fixture.connection
    );
    expect(
      fixture.connection.execute.mock.calls.some(([sql]) => /^(DELETE|INSERT|UPDATE) /u.test(sql))
    ).toBe(false);
    expect(fixture.connection.rollback).toHaveBeenCalledOnce();
    expect(fixture.connection.commit).not.toHaveBeenCalled();
  });

  it.each([undefined, 'MEMBER', 'ORG_ADMIN'] as const)(
    'rejects template writes for a disabled or non-admin actor (%s) in the transaction',
    async (role) => {
      const fixture = resourceFixture();
      vi.spyOn(fixture.authorization, 'actorContext').mockResolvedValue(
        role === undefined ? undefined : { role, organizationId: 2 }
      );
      const service = new ResourceAccessService(fixture.database, fixture.authorization);
      await expect(
        service.assertCanManageConversationTemplate(
          8,
          'node-1',
          'workspace-1',
          fixture.connection as unknown as PoolConnection
        )
      ).rejects.toThrow('ADMIN_REQUIRED');
      expect(fixture.authorization.actorContext).toHaveBeenCalledWith(8, fixture.connection);
      expect(fixture.connection.execute).not.toHaveBeenCalled();
    }
  );

  it('locks and rechecks the current template source under the same transaction', async () => {
    const fixture = resourceFixture();
    fixture.node = fixture.workspace = {
      owner_type: 'ORGANIZATION',
      owner_user_id: null,
      owner_organization_id: 2
    };
    const service = new ResourceAccessService(fixture.database, fixture.authorization);
    await service.assertCanManageConversationTemplate(
      8,
      'node-1',
      'workspace-1',
      fixture.connection as unknown as PoolConnection
    );
    expect(fixture.authorization.actorContext).toHaveBeenCalledWith(8, fixture.connection);
    expect(fixture.authorization.authorize).toHaveBeenCalledWith(
      8,
      'RESOURCE_USE',
      { ownerType: 'ORGANIZATION', organizationId: 2 },
      fixture.connection
    );
    expect(fixture.connection.execute).toHaveBeenCalledWith(
      expect.stringContaining('WHERE id=? FOR SHARE'),
      ['node-1']
    );
    expect(fixture.connection.execute).toHaveBeenCalledWith(
      expect.stringContaining('WHERE workspace_id=? AND node_id=? FOR UPDATE'),
      ['workspace-1', 'node-1']
    );
  });

  it('exposes ownership and resource cleanup hooks for Core composition', async () => {
    const fixture = resourceFixture();
    const service = new ResourceAccessService(fixture.database, fixture.authorization);

    await service.lockOwnership(fixture.connection as unknown as PoolConnection, {
      ownerType: 'ORGANIZATION',
      ownerOrganizationId: 2
    });
    await service.cleanupModelResources(fixture.connection as unknown as PoolConnection, 'model-1');
    await service.cleanupImageModelResources(
      fixture.connection as unknown as PoolConnection,
      'image-model-1'
    );

    expect(fixture.connection.execute).toHaveBeenCalledWith(
      'SELECT id FROM organizations WHERE id=? FOR SHARE',
      [2]
    );
    expect(
      fixture.connection.execute.mock.calls.findIndex(
        ([sql, params]) =>
          sql === 'SELECT id FROM organizations WHERE id=? FOR SHARE' &&
          JSON.stringify(params) === JSON.stringify([1])
      )
    ).toBeLessThan(
      fixture.connection.execute.mock.calls.findIndex(
        ([sql, params]) =>
          sql === 'SELECT id FROM organizations WHERE id=? FOR SHARE' &&
          JSON.stringify(params) === JSON.stringify([2])
      )
    );
    expect(fixture.connection.execute).toHaveBeenCalledWith(
      "DELETE FROM resource_grants WHERE resource_type='MODEL' AND model_id=?",
      ['model-1']
    );
    expect(fixture.connection.execute).toHaveBeenCalledWith(
      "DELETE FROM resource_grants WHERE resource_type='IMAGE_MODEL' AND image_model_id=?",
      ['image-model-1']
    );
  });

  it('removes grants for hosted templates outside the new Node organization subtree', async () => {
    const fixture = resourceFixture();
    fixture.node = {
      owner_type: 'ORGANIZATION',
      owner_user_id: null,
      owner_organization_id: 2
    };
    fixture.workspace = {
      owner_type: 'ORGANIZATION',
      owner_user_id: null,
      owner_organization_id: 4
    };
    const service = new ResourceAccessService(fixture.database, fixture.authorization, () => 2_000);

    await mutationFor(fixture, service).changeNodeOwnership(1, 'node-1', {
      ownerType: 'ORGANIZATION',
      ownerOrganizationId: 4
    });

    const cleanup = fixture.connection.execute.mock.calls.find(
      ([sql]) =>
        String(sql).includes("grant_record.resource_type='TEMPLATE'") &&
        String(sql).includes('conversation_templates')
    );
    expect(cleanup?.[1]).toBeUndefined();
    expect(String(cleanup?.[0])).toContain(
      'LEFT JOIN nodes hosting_node ON hosting_node.id=template.source_node_id'
    );
    expect(String(cleanup?.[0])).toContain(
      'ancestors.ancestor_id=grant_record.grant_scope_organization_id'
    );
    expect(String(cleanup?.[0])).toContain(
      'ancestors.ancestor_id=hosting_node.owner_organization_id'
    );
    expect(String(cleanup?.[0])).not.toContain("grant_record.grant_authority='ORG_SUBTREE'");
  });

  it('explains why a Node cannot move below one of its Workspace organizations', async () => {
    const fixture = resourceFixture();
    fixture.node = {
      owner_type: 'ORGANIZATION',
      owner_user_id: null,
      owner_organization_id: 2
    };
    fixture.workspace = {
      owner_type: 'ORGANIZATION',
      owner_user_id: null,
      owner_organization_id: 2
    };
    fixture.placementAllowed = false;
    const service = new ResourceAccessService(fixture.database, fixture.authorization);

    await expect(
      mutationFor(fixture, service).changeNodeOwnership(1, 'node-1', {
        ownerType: 'ORGANIZATION',
        ownerOrganizationId: 4
      })
    ).rejects.toMatchObject({
      message: 'NODE_OWNERSHIP_WORKSPACE_INCOMPATIBLE',
      publicMessage:
        "The Node can't be moved to the selected organization because one or more Workspaces would fall outside its organization subtree.",
      publicDetails:
        'Move each affected Workspace to the selected organization or one of its descendant organizations, then retry.'
    });
    expect(domainErrorStatus('NODE_OWNERSHIP_WORKSPACE_INCOMPATIBLE')).toBe(409);
  });

  it('inherits Node use into Workspace while keeping personal resources unshareable', async () => {
    const fixture = resourceFixture();
    fixture.node = { owner_type: 'ORGANIZATION', owner_user_id: null, owner_organization_id: 2 };
    fixture.workspace = {
      owner_type: 'ORGANIZATION',
      owner_user_id: null,
      owner_organization_id: 4
    };
    fixture.authorization.authorize = vi.fn(async (_userId, _permission, context) => ({
      allowed: context?.organizationId === 2
    }));
    const service = new ResourceAccessService(fixture.database, fixture.authorization);
    const grants = new ResourceGrantService(
      fixture.database,
      fixture.authorization,
      unrestrictedCredentialScope
    );
    await expect(service.canUseWorkspace(8, 'node-1', 'workspace-1')).resolves.toBe(true);

    fixture.node = { owner_type: 'PERSONAL', owner_user_id: 8, owner_organization_id: null };
    await expect(service.canUseNode(8, 'node-1')).resolves.toBe(true);
    await expect(
      grants.createGrant(8, 'NODE', 'node-1', null, {
        targetType: 'ORGANIZATION',
        targetOrganizationId: 1
      })
    ).rejects.toThrow('PERSONAL_RESOURCE_NOT_SHAREABLE');
  });

  it('allows only Workspace-scoped relay operations for a direct Workspace grant', async () => {
    const fixture = resourceFixture();
    fixture.node = { owner_type: 'ORGANIZATION', owner_user_id: null, owner_organization_id: 2 };
    fixture.workspace = {
      owner_type: 'ORGANIZATION',
      owner_user_id: null,
      owner_organization_id: 4
    };
    fixture.workspaceGranted = true;
    fixture.authorization.authorize = vi.fn(async (_userId, _permission, context) => ({
      allowed: context?.granted === true
    }));
    const service = new ResourceAccessService(fixture.database, fixture.authorization);

    await expect(
      service.canRelay(8, 'node-1', 'workspace.file.read', {}, 'workspace-1')
    ).resolves.toBe(true);
    await expect(service.canRelay(8, 'node-1', 'workspace.list', {})).resolves.toBe(true);
    await expect(
      service.canRelay(8, 'node-1', 'workspace.git.settings.get', {}, 'workspace-1')
    ).resolves.toBe(true);
    await expect(
      service.canRelay(8, 'node-1', 'workspace.git.settings.update', {}, 'workspace-1')
    ).resolves.toBe(false);
    await expect(service.canRelay(8, 'node-1', 'node.metrics', {})).resolves.toBe(false);
  });

  it('ORG_ADMIN sees only owned personal resources and the managed organization subtree', async () => {
    const fixture = resourceFixture();
    fixture.authorization.actorContext = vi.fn(async () => ({
      role: 'ORG_ADMIN' as const,
      organizationId: 2
    }));
    const directory = new ResourceManagementDirectory(fixture.database, fixture.authorization);
    await expect(directory.listManagedResources(8)).resolves.toEqual({
      nodes: [
        {
          id: 'node-1',
          displayName: '研发节点',
          disabled: false,
          ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 2 }
        }
      ],
      workspaces: [
        {
          nodeId: 'node-1',
          nodeDisplayName: '研发节点',
          workspaceId: 'workspace-1',
          displayName: 'workspace-1',
          ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 4 }
        }
      ]
    });
    expect(fixture.authorization.managedOrganizationIds).toHaveBeenCalledWith(8);
  });

  it('ADMIN visibility of all Nodes does not extend to Workspace lists', async () => {
    const fixture = resourceFixture();
    await new ResourceManagementDirectory(
      fixture.database,
      fixture.authorization
    ).listManagedResources(8, true);

    expect(fixture.database.raw.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('WHERE TRUE'),
      []
    );
    expect(fixture.database.raw.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("owner_type='PERSONAL'"),
      [8, [1, 2, 4]]
    );
  });

  it('Management resource projections include personal Node and Workspace owner accounts', async () => {
    const fixture = resourceFixture();
    fixture.listedNodes = [
      {
        id: 'node-1',
        display_name: '个人节点',
        connected: 1,
        disabled: 0,
        owner_type: 'PERSONAL',
        owner_user_id: 8,
        owner_organization_id: null,
        owner_username: 'member-a'
      }
    ];
    fixture.listedWorkspaces = [
      {
        node_id: 'node-1',
        node_display_name: '个人节点',
        workspace_id: 'workspace-1',
        display_name: '个人工作区',
        owner_type: 'PERSONAL',
        owner_user_id: 8,
        owner_organization_id: null,
        owner_username: 'member-a'
      }
    ];
    const directory = new ResourceManagementDirectory(fixture.database, fixture.authorization);

    await expect(directory.listManagedResources(8, true)).resolves.toMatchObject({
      nodes: [{ ownerUsername: 'member-a' }],
      workspaces: [{ ownerUsername: 'member-a' }]
    });
    expect(fixture.database.raw.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('LEFT JOIN users owner ON owner.id=node.owner_user_id'),
      []
    );
    expect(fixture.database.raw.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('LEFT JOIN users owner ON owner.id=w.owner_user_id'),
      [8, [1, 2, 4]]
    );
  });

  it('ADMIN can govern other users personal Nodes without Workspace management or usage grants', async () => {
    const fixture = resourceFixture();
    fixture.node = { owner_type: 'PERSONAL', owner_user_id: 7, owner_organization_id: null };
    fixture.workspace = {
      owner_type: 'PERSONAL',
      owner_user_id: 7,
      owner_organization_id: null
    };
    const service = new ResourceAccessService(fixture.database, fixture.authorization);
    await expect(service.assertCanManageNode(8, 'node-1')).resolves.toBeUndefined();
    await expect(service.assertCanManageWorkspace(8, 'node-1', 'workspace-1')).rejects.toThrow(
      'RBAC_SCOPE_DENIED'
    );
    await expect(service.canUseNode(8, 'node-1')).resolves.toBe(false);
    await expect(service.canUseWorkspace(8, 'node-1', 'workspace-1')).resolves.toBe(false);
    await expect(
      service.canRelay(8, 'node-1', 'workspace.git.settings.get', {}, 'workspace-1')
    ).resolves.toBe(false);
    await expect(
      service.canRelay(8, 'node-1', 'workspace.git.settings.update', {}, 'workspace-1')
    ).resolves.toBe(false);
    await expect(service.canRelay(8, 'node-1', 'node.skills.install', {})).resolves.toBe(true);
    await expect(
      service.canRelay(8, 'node-1', 'workspace.remove', {}, 'workspace-1')
    ).resolves.toBe(false);
    await expect(
      service.canRelay(8, 'node-1', 'workspace.mcps.install', {}, 'workspace-1')
    ).resolves.toBe(false);
    await expect(
      service.canRelay(8, 'node-1', 'workspace.file.read', {}, 'workspace-1')
    ).resolves.toBe(false);
    expect(fixture.database.raw.execute).toHaveBeenCalledWith(
      expect.not.stringContaining('disabled=FALSE'),
      ['node-1']
    );
  });

  it('allows only fixed management relay operations for ADMIN personal Node governance', async () => {
    const fixture = resourceFixture();
    fixture.node = { owner_type: 'PERSONAL', owner_user_id: 7, owner_organization_id: null };
    const service = new ResourceAccessService(fixture.database, fixture.authorization);
    await expect(service.canRelay(8, 'node-1', 'node.skills.inspect', {})).resolves.toBe(true);
    await expect(service.canRelay(8, 'node-1', 'node.metrics', {})).resolves.toBe(false);
    await expect(service.canUseNode(8, 'node-1')).resolves.toBe(false);
  });

  it('renames a managed organization Workspace without changing its ID', async () => {
    const fixture = resourceFixture();
    fixture.workspace = {
      owner_type: 'ORGANIZATION',
      owner_user_id: null,
      owner_organization_id: 2
    };
    const service = new ResourceAccessService(fixture.database, fixture.authorization);
    await expect(
      mutationFor(fixture, service).updateWorkspace(8, 'node-1', 'workspace-1', {
        displayName: '平台工作区'
      })
    ).resolves.toBeUndefined();
    expect(fixture.connection.execute).toHaveBeenCalledWith(
      'UPDATE workspaces SET display_name=? WHERE workspace_id=? AND node_id=?',
      ['平台工作区', 'workspace-1', 'node-1']
    );
  });

  it('rejects Workspace rename when management authorization is revoked before the transaction check', async () => {
    const fixture = resourceFixture();
    fixture.workspace = {
      owner_type: 'ORGANIZATION',
      owner_user_id: null,
      owner_organization_id: 2
    };
    fixture.modelManageAllowed = false;
    const service = new ResourceAccessService(fixture.database, fixture.authorization);
    await expect(
      mutationFor(fixture, service).updateWorkspace(8, 'node-1', 'workspace-1', {
        displayName: 'New'
      })
    ).rejects.toThrow('RBAC_DENIED');
    expect(fixture.authorization.authorize).toHaveBeenCalledWith(
      8,
      'RESOURCE_MANAGE',
      { ownerType: 'ORGANIZATION', organizationId: 2 },
      fixture.connection
    );
    expect(fixture.connection.execute).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE workspaces'),
      expect.anything()
    );
    expect(fixture.connection.rollback).toHaveBeenCalledOnce();
  });

  it('checks target ownership on the active Workspace update transaction before mutation', async () => {
    const fixture = resourceFixture();
    fixture.workspace = {
      owner_type: 'ORGANIZATION',
      owner_user_id: null,
      owner_organization_id: 2
    };
    const service = new ResourceAccessService(fixture.database, fixture.authorization);
    const selection = vi
      .spyOn(service, 'assertOwnershipSelection')
      .mockRejectedValue(new Error('RBAC_DENIED'));
    const ownership = { ownerType: 'ORGANIZATION', ownerOrganizationId: 4 } as const;

    await expect(
      mutationFor(fixture, service).updateWorkspace(8, 'node-1', 'workspace-1', { ownership })
    ).rejects.toThrow('RBAC_DENIED');
    expect(selection).toHaveBeenCalledWith(8, ownership, fixture.connection);
    const statements = fixture.connection.execute.mock.calls.map(([sql]) => String(sql));
    const nodeLock = statements.findIndex(
      (sql) => sql.includes('FROM nodes') && sql.includes('FOR UPDATE')
    );
    const workspaceLock = statements.findIndex(
      (sql) => sql.includes('FROM workspaces') && sql.includes('FOR UPDATE')
    );
    const rootLock = statements.findIndex(
      (sql) => sql.includes('FROM organizations') && sql.includes('FOR UPDATE')
    );
    expect(rootLock).toBeGreaterThanOrEqual(0);
    expect(nodeLock).toBeGreaterThan(rootLock);
    expect(workspaceLock).toBeGreaterThan(nodeLock);
    expect(fixture.connection.rollback).toHaveBeenCalledOnce();
    expect(fixture.connection.commit).not.toHaveBeenCalled();
    expect(fixture.connection.execute).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE workspaces SET owner_organization_id'),
      expect.anything()
    );
  });

  it('rolls back a node-authorized group write when it fails', async () => {
    const fixture = resourceFixture();
    fixture.workspace = {
      owner_type: 'ORGANIZATION',
      owner_user_id: null,
      owner_organization_id: 2
    };
    fixture.failWorkspaceGroupUpdate = true;
    const service = new ResourceAccessService(fixture.database, fixture.authorization);

    vi.spyOn(service, 'canRegisterWorkspace').mockResolvedValue(true);

    await expect(
      mutationFor(fixture, service).updateWorkspaceGroupName(
        8,
        'node-1',
        'workspace-1',
        'Engineering'
      )
    ).rejects.toThrow('WORKSPACE_GROUP_WRITE_FAILED');

    expect(fixture.connection.beginTransaction).toHaveBeenCalledOnce();
    expect(fixture.connection.commit).not.toHaveBeenCalled();
    expect(fixture.connection.rollback).toHaveBeenCalledOnce();
  });

  it('writes a display name when backfilling a legacy Node Workspace', async () => {
    const fixture = resourceFixture();
    const service = new ResourceAccessService(fixture.database, fixture.authorization, () => 2_000);
    await mutationFor(fixture, service).backfillNodeWorkspaces('node-1', [
      { id: 'workspace-1', path: '/srv/projects/demo' }
    ]);
    expect(fixture.connection.execute).toHaveBeenCalledWith(
      expect.stringContaining('(workspace_id,display_name,node_id'),
      ['workspace-1', 'demo', 'node-1', 'PERSONAL', 1, null, 2_000]
    );
  });

  it('rejects a Node deleted after the preflight snapshot', async () => {
    const fixture = resourceFixture();
    fixture.nodeMissingOnLock = true;
    const service = new ResourceAccessService(fixture.database, fixture.authorization);

    await expect(
      mutationFor(fixture, service).backfillNodeWorkspaces('node-1', [{ id: 'workspace-1' }])
    ).rejects.toThrow('NODE_NOT_FOUND');
    expect(fixture.connection.execute).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO workspaces'),
      expect.anything()
    );
  });

  it('uses the Node ownership locked inside the Workspace backfill transaction', async () => {
    const fixture = resourceFixture();
    fixture.lockedNode = {
      owner_type: 'ORGANIZATION',
      owner_user_id: null,
      owner_organization_id: 2
    };
    const service = new ResourceAccessService(fixture.database, fixture.authorization);

    await mutationFor(fixture, service).backfillNodeWorkspaces('node-1', [
      { id: 'workspace-locked' }
    ]);
    expect(fixture.connection.execute).toHaveBeenCalledWith(
      expect.stringContaining('(workspace_id,display_name,node_id'),
      [
        'workspace-locked',
        'workspace-locked',
        'node-1',
        'ORGANIZATION',
        null,
        2,
        expect.any(Number)
      ]
    );
  });
});

function mutationFor(fixture: ReturnType<typeof resourceFixture>, policy: ResourceAccessService) {
  return new ResourceMutationService(fixture.database, fixture.authorization, policy, () => 2_000);
}

function resourceFixture() {
  const fixture: {
    node: Record<string, unknown>;
    workspace: Record<string, unknown>;
    placementAllowed: boolean;
    tombstoned: boolean;
    workspaceGranted: boolean;
    directNodeGranted: boolean;
    nodeGranted: boolean;
    modelGranted: boolean;
    imageModelGranted: boolean;
    templateGranted: boolean;
    modelExists: boolean;
    model: Record<string, unknown>;
    imageModel: Record<string, unknown>;
    modelManageAllowed: boolean;
    templateExists: boolean;
    organizationExists: boolean;
    grant?: Record<string, unknown>;
    listedGrants?: readonly Record<string, unknown>[];
    listedNodes?: readonly Record<string, unknown>[];
    listedWorkspaces?: readonly Record<string, unknown>[];
    failWorkspaceGroupUpdate?: boolean;
    workspaceReferencedByTemplate?: boolean;
    nodeMissingOnLock?: boolean;
    lockedNode?: Record<string, unknown>;
  } = {
    node: { owner_type: 'PERSONAL', owner_user_id: 1, owner_organization_id: null },
    workspace: { owner_type: 'PERSONAL', owner_user_id: 1, owner_organization_id: null },
    placementAllowed: true,
    tombstoned: false,
    workspaceGranted: false,
    directNodeGranted: false,
    nodeGranted: false,
    modelGranted: false,
    imageModelGranted: false,
    templateGranted: false,
    modelExists: true,
    model: {
      owner_type: 'ORGANIZATION',
      owner_user_id: null,
      owner_organization_id: 4
    },
    imageModel: {
      owner_type: 'ORGANIZATION',
      owner_user_id: null,
      owner_organization_id: 4
    },
    modelManageAllowed: true,
    templateExists: true,
    organizationExists: true
  };
  const connection = {
    beginTransaction: vi.fn(async () => undefined),
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    release: vi.fn(),
    execute: vi.fn(async (sql: string, params?: readonly unknown[]) => {
      if (fixture.failWorkspaceGroupUpdate && sql.startsWith('UPDATE workspaces SET group_name'))
        throw new Error('WORKSPACE_GROUP_WRITE_FAILED');
      if (
        sql.includes("grant_record.resource_type='NODE'") &&
        sql.includes("grant_record.target_type='USER'") &&
        sql.includes('grant_record.target_user_id=?')
      )
        return [fixture.directNodeGranted ? [{ granted: 1 }] : [], []];
      if (sql.startsWith('SELECT id FROM organizations WHERE id=?'))
        return [fixture.organizationExists ? [{ id: 1 }] : [], []];
      if (sql.startsWith('SELECT id FROM users WHERE id IN')) return [[{ id: params?.[0] }], []];
      if (sql.includes('legacy_ownership_backfill_pending'))
        return [fixture.nodeMissingOnLock ? [] : [fixture.lockedNode ?? fixture.node], []];
      if (sql.startsWith('SELECT id FROM conversation_templates WHERE source_workspace_id=?'))
        return [fixture.workspaceReferencedByTemplate ? [{ id: 'template-1' }] : [], []];
      if (sql.includes('workspace_tombstones')) return [fixture.tombstoned ? [{ id: 1 }] : [], []];
      if (sql.includes('SELECT node_id FROM workspaces')) return [[], []];
      if (sql.includes('FROM nodes')) return [[fixture.node], []];
      if (sql.startsWith('DELETE FROM workspaces')) return [{ affectedRows: 1 }, []];
      if (sql.includes('FROM workspaces')) return [[fixture.workspace], []];
      if (sql.startsWith('SELECT') || sql.startsWith('WITH')) return raw.execute(sql, params);
      return [{ affectedRows: 1 }, []];
    })
  };
  const raw = {
    getConnection: vi.fn(async () => connection),
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM nodes'))
        return [
          fixture.listedNodes ?? [
            {
              id: 'node-1',
              display_name: '研发节点',
              connected: 1,
              disabled: 0,
              owner_type: 'ORGANIZATION',
              owner_user_id: null,
              owner_organization_id: 2
            }
          ],
          []
        ];
      return [
        fixture.listedWorkspaces ?? [
          {
            node_id: 'node-1',
            node_display_name: '研发节点',
            workspace_id: 'workspace-1',
            owner_type: 'ORGANIZATION',
            owner_user_id: null,
            owner_organization_id: 4
          }
        ],
        []
      ];
    }),
    execute: vi.fn(async (sql: string, params?: readonly unknown[]) => {
      if (fixture.failWorkspaceGroupUpdate && sql.startsWith('UPDATE workspaces SET group_name'))
        throw new Error('WORKSPACE_GROUP_WRITE_FAILED');
      if (sql.startsWith('SELECT id FROM conversation_templates WHERE source_workspace_id=?'))
        return [fixture.workspaceReferencedByTemplate ? [{ id: 'template-1' }] : [], []];
      if (sql.includes('FROM nodes')) return [[fixture.node], []];
      if (
        sql.includes("grant_record.resource_type='NODE'") &&
        sql.includes("grant_record.target_type='USER'") &&
        sql.includes('grant_record.target_user_id=?')
      )
        return [fixture.directNodeGranted ? [{ granted: 1 }] : [], []];
      if (sql.startsWith('SELECT organization_id FROM users'))
        return [[{ organization_id: 4 }], []];
      if (sql.includes('FROM resource_grants WHERE id=?'))
        return [fixture.grant === undefined ? [] : [fixture.grant], []];
      if (sql.includes('FROM resource_grants WHERE resource_key=?'))
        return [fixture.listedGrants ?? [], []];
      if (sql.includes('FROM mar_agent_models'))
        return [
          fixture.modelExists
            ? [
                {
                  id: 'model-1',
                  ...fixture.model,
                  ...(sql.includes('name AS display_name')
                    ? { display_name: fixture.model.name }
                    : {})
                }
              ]
            : [],
          []
        ];
      if (sql.includes('FROM mar_agent_image_models'))
        return [
          [
            {
              id: 'image-model-1',
              ...fixture.imageModel,
              ...(sql.includes('name AS display_name')
                ? { display_name: fixture.imageModel.name }
                : {})
            }
          ],
          []
        ];
      if (sql.includes('FROM conversation_templates')) {
        if (sql.includes('JOIN nodes'))
          return [
            fixture.templateExists
              ? [
                  {
                    ...fixture.node,
                    ...(sql.includes('template.name AS display_name')
                      ? {
                          display_name: 'Team template',
                          nodeId: 'source-node',
                          workspaceId: 'source-workspace',
                          nodeName: 'Source Node'
                        }
                      : {})
                  }
                ]
              : [],
            []
          ];
        return [fixture.templateExists ? [{ id: 'template-1' }] : [], []];
      }
      if (sql === 'SELECT id FROM organizations WHERE id=?')
        return [fixture.organizationExists ? [{ id: 1 }] : [], []];
      if (sql.includes('SELECT workspace_id FROM workspaces WHERE node_id'))
        return [[{ workspace_id: 'workspace-1' }], []];
      if (sql.includes('FROM workspaces')) return [[fixture.workspace], []];
      if (sql.includes('WITH RECURSIVE ancestors'))
        return [fixture.placementAllowed ? [{ allowed: 1 }] : [], []];
      if (sql.includes('WITH RECURSIVE actor_organizations'))
        return [
          (fixture.workspaceGranted && params?.[1] === 'WORKSPACE') ||
          ((fixture.directNodeGranted || fixture.nodeGranted) && params?.[1] === 'NODE') ||
          (fixture.modelGranted && params?.[1] === 'MODEL') ||
          (fixture.imageModelGranted && params?.[1] === 'IMAGE_MODEL') ||
          (fixture.templateGranted &&
            (params?.[1] === 'TEMPLATE' || sql.includes("resource_type='TEMPLATE'")))
            ? [{ granted: 1 }]
            : [],
          []
        ];
      if (sql.startsWith('UPDATE workspaces')) return [{ affectedRows: 1 }, []];
      return [[], []];
    })
  };
  const audit = vi.fn(async (_event: unknown) => undefined);
  const database = { raw, audit } as unknown as MysqlServerDatabase;
  const authorization = {
    authorize: vi.fn(async (_userId: number, permission: string) => ({
      allowed:
        permission === 'RESOURCE_MANAGE' || permission === 'RESOURCE_GRANT_MANAGE'
          ? fixture.modelManageAllowed
          : true
    })),
    actorContext: vi.fn(async () => ({ role: 'ADMIN', organizationId: 1 })),
    managedOrganizationIds: vi.fn(async () => [1, 2, 4]),
    grantScope: vi.fn(async () => {
      const actor = await authorization.actorContext(1);
      return actor?.role === 'ADMIN' || actor?.role === 'ORG_ADMIN'
        ? { role: actor.role, organizationId: actor.organizationId }
        : undefined;
    }),
    isPersonalAdmin: vi.fn(async () => false)
  } as unknown as AuthorizationService;
  return Object.assign(fixture, { database, authorization, connection, raw, audit });
}
