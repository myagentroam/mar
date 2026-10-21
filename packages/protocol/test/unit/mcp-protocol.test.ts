import { describe, expect, it } from 'vitest';
import {
  mailNotificationRequestSchema,
  mcpCatalogEntrySchema,
  mcpInstallationInputSchema,
  mcpRuntimeDescriptorSchema,
  mcpSourceInputSchema,
  mcpTargetInspectionSchema,
  workbenchNodeOperationSchema
} from '../../src/index.js';

describe('MCP protocol', () => {
  it('accepts only official-compatible Registry HTTPS sources and matching scope owners', () => {
    expect(
      mcpSourceInputSchema.parse({
        scope: 'ORGANIZATION',
        organizationId: 3,
        name: 'Team MCP',
        locator: 'https://registry.example.com'
      })
    ).toMatchObject({ scope: 'ORGANIZATION', organizationId: 3 });
    expect(
      mcpSourceInputSchema.safeParse({
        scope: 'PERSONAL',
        organizationId: 3,
        name: 'bad',
        locator: 'http://registry.example.com'
      }).success
    ).toBe(false);
  });

  it('keeps local and remote runtime descriptors mutually exclusive and rejects latest versions', () => {
    expect(
      mcpRuntimeDescriptorSchema.parse({
        transport: 'STDIO',
        command: 'npx',
        args: ['-y', '@playwright/mcp@0.0.78'],
        environment: { API_KEY: { secretName: 'PLAYWRIGHT_API_KEY' } }
      }).transport
    ).toBe('STDIO');
    expect(
      mcpRuntimeDescriptorSchema.safeParse({
        transport: 'HTTP',
        url: 'https://mcp.example.com/mcp',
        command: 'npx'
      }).success
    ).toBe(false);
    expect(
      mcpCatalogEntrySchema.safeParse({
        id: 'mcp-1',
        sourceId: 'source-1',
        scope: 'ENTERPRISE',
        serverName: 'io.github.microsoft/playwright-mcp',
        displayName: 'Playwright',
        description: 'Browser automation',
        version: 'latest',
        featured: true,
        tags: [],
        runtime: { transport: 'STDIO', command: 'npx', args: [] },
        createdAt: 1,
        updatedAt: 1
      }).success
    ).toBe(false);
  });

  it('allows only public configuration and secret-name references in installation settings', () => {
    expect(
      mcpInstallationInputSchema.parse({
        catalogEntryId: 'mcp-1',
        enabled: true,
        configuration: {
          arguments: ['--browser=chromium'],
          environment: { TOKEN: { secretName: 'MCP_TOKEN' } }
        }
      }).enabled
    ).toBe(true);
    expect(
      mcpInstallationInputSchema.safeParse({
        catalogEntryId: 'mcp-1',
        configuration: { environment: { TOKEN: { value: 'plaintext' } } }
      }).success
    ).toBe(false);
  });

  it('uses closed target inspection states and allowlisted fixed operations', () => {
    expect(
      mcpTargetInspectionSchema.parse({
        targetKind: 'WORKSPACE',
        installations: [
          {
            catalogEntryId: 'mcp-1',
            serverName: 'playwright',
            displayName: 'Playwright',
            version: '0.0.78',
            origin: 'WORKSPACE',
            enabled: true,
            status: 'CURRENT',
            installedAt: 1
          }
        ]
      }).installations[0]?.status
    ).toBe('CURRENT');
    expect(
      mcpTargetInspectionSchema.parse({
        targetKind: 'WORKSPACE',
        installations: [],
        executionBuiltIns: ['mar_schedule', 'mar_notification']
      }).executionBuiltIns
    ).toEqual(['mar_schedule', 'mar_notification']);
    expect(
      mcpTargetInspectionSchema.parse({ targetKind: 'WORKSPACE', installations: [] })
        .executionBuiltIns
    ).toBeUndefined();
    expect(
      mcpTargetInspectionSchema.safeParse({
        targetKind: 'WORKSPACE',
        installations: [],
        executionBuiltIns: ['arbitrary-tool']
      }).success
    ).toBe(false);
    for (const operation of [
      'node.mcps.inspect',
      'node.mcps.install',
      'node.mcps.remove',
      'workspace.mcps.inspect',
      'workspace.mcps.install',
      'workspace.mcps.remove'
    ])
      expect(workbenchNodeOperationSchema.safeParse(operation).success).toBe(true);
  });

  it('allows an omitted recipient for the initiating account and bounds explicit recipient addresses', () => {
    const request = {
      executionId: 'run-1',
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      userId: 7,
      source: 'MANUAL',
      callId: '8e1668db-88e7-4a28-9ccd-cda8814a4e73',
      templateId: 'notification-en-US',
      title: 'Build completed',
      recipientEmail: 'external@example.test',
      message: 'Done'
    };
    expect(mailNotificationRequestSchema.parse(request).recipientEmail).toBe(
      'external@example.test'
    );
    expect(mailNotificationRequestSchema.parse({ ...request, templateId: '' }).templateId).toBe('');
    expect(mailNotificationRequestSchema.parse(request).title).toBe('Build completed');
    expect(
      mailNotificationRequestSchema.safeParse({ ...request, title: 'bad\r\ntitle' }).success
    ).toBe(false);
    expect(
      mailNotificationRequestSchema.safeParse({ ...request, title: 'x'.repeat(161) }).success
    ).toBe(false);
    expect(
      mailNotificationRequestSchema.safeParse({ ...request, templateId: undefined }).success
    ).toBe(false);
    expect(
      mailNotificationRequestSchema.safeParse({ ...request, recipientEmail: undefined }).success
    ).toBe(true);
    expect(
      mailNotificationRequestSchema.safeParse({ ...request, recipientEmail: '' }).success
    ).toBe(false);
    expect(
      mailNotificationRequestSchema.safeParse({ ...request, recipientEmail: 'x'.repeat(321) })
        .success
    ).toBe(false);
  });
});
