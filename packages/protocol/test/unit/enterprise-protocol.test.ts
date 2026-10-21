import { describe, expect, it } from 'vitest';
import {
  auditConversationReceiptSchema,
  auditEventDetailSchema,
  auditEventSchema,
  enterpriseCapabilitySchema,
  oauthProviderInputSchema,
  resourceGrantSchema,
  resourceOwnershipSchema,
  userRoleSchema
} from '../../src/index.js';

describe('enterprise protocol', () => {
  it('accepts the fixed edition, license and role vocabulary', () => {
    expect(
      enterpriseCapabilitySchema.parse({
        edition: 'ENTERPRISE',
        licenseState: 'ENTERPRISE_VALID',
        role: 'ORG_ADMIN',
        organizationId: 12,
        managementWritable: true
      })
    ).toMatchObject({ role: 'ORG_ADMIN' });
    expect(userRoleSchema.safeParse('VIEWER').success).toBe(false);
  });

  it('requires exactly one personal or organization owner', () => {
    expect(resourceOwnershipSchema.parse({ ownerType: 'PERSONAL', ownerUserId: 7 })).toEqual({
      ownerType: 'PERSONAL',
      ownerUserId: 7
    });
    expect(
      resourceOwnershipSchema.safeParse({
        ownerType: 'ORGANIZATION',
        ownerUserId: 7,
        ownerOrganizationId: 2
      }).success
    ).toBe(false);
  });

  it('uses a fixed organization scope independently from the grant target', () => {
    expect(
      resourceGrantSchema.parse({
        id: 'grant-1',
        resourceType: 'WORKSPACE',
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        targetType: 'USER',
        targetUserId: 8,
        grantScopeOrganizationId: 2,
        createdByUserId: 4,
        createdAt: 1
      })
    ).toMatchObject({ targetType: 'USER', grantScopeOrganizationId: 2 });
    expect(
      resourceGrantSchema.parse({
        id: 'grant-model',
        resourceType: 'MODEL',
        modelId: 'model-1',
        targetType: 'ORGANIZATION',
        targetOrganizationId: 1,
        grantScopeOrganizationId: 1,
        createdByUserId: 1,
        createdAt: 2
      })
    ).toMatchObject({ resourceType: 'MODEL', modelId: 'model-1' });
    expect(
      resourceGrantSchema.safeParse({
        id: 'grant-invalid',
        resourceType: 'MODEL',
        nodeId: 'node-1',
        modelId: 'model-1',
        targetType: 'ORGANIZATION',
        targetOrganizationId: 1,
        grantScopeOrganizationId: 1,
        createdByUserId: 1,
        createdAt: 2
      }).success
    ).toBe(false);
  });

  it('models manual OAuth2 without OIDC discovery fields', () => {
    const provider = oauthProviderInputSchema.parse({
      providerKey: 'feishu',
      name: 'company-sso',
      clientId: 'client',
      clientSecret: 'secret',
      authorizationEndpoint: 'https://id.example/authorize',
      tokenEndpoint: 'https://id.example/token',
      userinfoEndpoint: 'https://id.example/userinfo',
      scopes: ['profile'],
      pkceMode: 'REQUIRED',
      tokenAuthMethod: 'client_secret_basic',
      mappings: {
        externalUserId: '/user_id',
        email: '/email',
        displayName: '/name'
      }
    });
    expect(provider).not.toHaveProperty('issuer');
    expect(provider.providerKey).toBe('feishu');
    expect(provider.autoProvisioningEnabled).toBe(false);
    expect(provider.userinfoEndpoint).toBe('https://id.example/userinfo');
    expect(provider.mappings.displayName).toBe('/name');
    expect(provider).not.toHaveProperty('emailTrustMode');
    expect(oauthProviderInputSchema.safeParse({ ...provider, providerKey: 'Feishu' }).success).toBe(
      false
    );
    expect(
      oauthProviderInputSchema.safeParse({
        ...provider,
        mappings: { ...provider.mappings, externalUserId: '' }
      }).success
    ).toBe(false);
  });

  it('does not admit conversation text into audit events', () => {
    expect(
      auditEventSchema.safeParse({
        id: 'audit-1',
        eventType: 'conversation_input',
        occurredAt: 1,
        result: 'SUCCESS',
        authenticationMethod: 'PASSWORD',
        content: 'secret prompt'
      }).success
    ).toBe(false);
  });

  it('keeps shared conversation text in an authorized detail payload only', () => {
    expect(
      auditEventSchema.parse({
        id: 'audit-1',
        eventType: 'shared_conversation_input_accepted',
        occurredAt: 1,
        result: 'SUCCESS',
        authenticationMethod: 'PASSWORD',
        targetName: 'Architecture review',
        hasConversationPayload: true
      })
    ).not.toHaveProperty('userMessage');
    expect(
      auditEventDetailSchema.parse({
        id: 'audit-1',
        eventType: 'shared_conversation_input_accepted',
        occurredAt: 1,
        result: 'SUCCESS',
        authenticationMethod: 'PASSWORD',
        targetName: 'Architecture review',
        hasConversationPayload: true,
        conversationPayload: {
          conversationTitle: 'Architecture review',
          userMessage: 'Review the current architecture.',
          queueItemId: 'queue-1'
        }
      }).conversationPayload?.userMessage
    ).toBe('Review the current architecture.');
    expect(
      auditConversationReceiptSchema.safeParse({
        sessionId: 'session-1',
        conversationTitle: 'Architecture review',
        runId: 'run-1',
        queueItemId: 'queue-1',
        inputMode: 'QUEUE'
      }).success
    ).toBe(true);
  });
});
