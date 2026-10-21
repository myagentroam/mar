import { assertMcpServerNames, NODE_MCP } from '../mcp/naming.js';
import {
  mcpCatalogEntrySchema,
  mcpInstallationInputSchema,
  mcpTargetInspectionSchema
} from '@myagentroam/protocol';
import { homedir } from 'node:os';
import type { NodeDatabase } from '../database.js';
import { McpInstallationVerifier } from './mcp-installation-verifier.js';

export class McpNodeOperationService {
  constructor(
    private readonly requireDatabase: () => NodeDatabase,
    private readonly verifier = new McpInstallationVerifier()
  ) {}

  operations(): Readonly<Record<string, (data: unknown) => unknown>> {
    return {
      'node.mcps.inspect': () => this.inspect('NODE', ''),
      'node.mcps.install': (data) => this.install('NODE', '', data),
      'node.mcps.remove': (data) => this.remove('NODE', '', data),
      'workspace.mcps.inspect': (data) => this.inspect('WORKSPACE', workspaceId(data)),
      'workspace.mcps.install': (data) => this.install('WORKSPACE', workspaceId(data), data),
      'workspace.mcps.remove': (data) => this.remove('WORKSPACE', workspaceId(data), data)
    };
  }

  private inspect(targetKind: 'NODE' | 'WORKSPACE', targetId: string) {
    const database = this.requireDatabase();
    const own = database.listMcpInstallations(targetKind, targetId);
    const ownNames = new Set(own.map((installation) => installation.serverName));
    const installations = [
      ...(targetKind === 'WORKSPACE'
        ? database
            .listMcpInstallations('NODE')
            .filter((installation) => !ownNames.has(installation.serverName))
        : []),
      ...own
    ].map((installation) => ({
      catalogEntryId: installation.catalogEntryId,
      serverName: installation.serverName,
      displayName: installation.displayName,
      version: installation.version,
      origin: installation.targetKind,
      enabled: installation.enabled,
      status: 'CURRENT' as const,
      installedAt: installation.installedAt
    }));
    return mcpTargetInspectionSchema.parse({
      targetKind,
      installations,
      ...(targetKind === 'WORKSPACE'
        ? { executionBuiltIns: [NODE_MCP.schedule.name, NODE_MCP.notification.name] }
        : {})
    });
  }

  private async install(targetKind: 'NODE' | 'WORKSPACE', targetId: string, raw: unknown) {
    if (!isRecord(raw)) throw new Error('MCP_INSTALL_INPUT_INVALID');
    const entry = mcpCatalogEntrySchema.parse(raw['entry']);
    assertMcpServerNames([{ name: entry.serverName }]);
    const input = mcpInstallationInputSchema.parse({
      catalogEntryId: entry.id,
      enabled: raw['enabled'] ?? true,
      configuration: raw['configuration'] ?? {}
    });
    const database = this.requireDatabase();
    const secretEnvironment = isRecord(raw['secretEnvironment'])
      ? Object.fromEntries(
          Object.entries(raw['secretEnvironment']).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string'
          )
        )
      : {};
    const cwd = targetKind === 'WORKSPACE' ? database.getWorkspace(targetId)?.path : homedir();
    if (cwd === undefined) throw new Error('WORKSPACE_NOT_FOUND');
    if (input.enabled)
      await this.verifier.verify({
        entry,
        configuration: input.configuration,
        secrets: secretEnvironment,
        cwd
      });
    database.saveMcpInstallation({
      targetKind,
      ...(targetKind === 'WORKSPACE' ? { targetId } : {}),
      entry,
      enabled: input.enabled,
      configuration: input.configuration
    });
    return this.inspect(targetKind, targetId);
  }

  private remove(targetKind: 'NODE' | 'WORKSPACE', targetId: string, raw: unknown) {
    if (!isRecord(raw) || typeof raw['serverName'] !== 'string')
      throw new Error('MCP_INSTALL_INPUT_INVALID');
    this.requireDatabase().removeMcpInstallation(targetKind, targetId, raw['serverName']);
    return this.inspect(targetKind, targetId);
  }
}

function workspaceId(raw: unknown): string {
  if (!isRecord(raw) || typeof raw['workspaceId'] !== 'string' || raw['workspaceId'] === '')
    throw new Error('WORKSPACE_INVALID');
  return raw['workspaceId'];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
