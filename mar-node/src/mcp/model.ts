import type { McpInstallationConfiguration, McpRuntimeDescriptor } from '@myagentroam/protocol';

/** Runtime-ready MCP installation resolved from Node persistence at execution start. */
export interface NodeMcpInstallation {
  readonly targetKind: 'NODE' | 'WORKSPACE';
  readonly targetId: string;
  readonly catalogEntryId: string;
  readonly serverName: string;
  readonly displayName: string;
  readonly version: string;
  readonly enabled: boolean;
  readonly runtime: McpRuntimeDescriptor;
  readonly configuration: McpInstallationConfiguration;
  readonly installedAt: number;
}

export interface ResolvedMcpServer {
  readonly name: string;
  readonly origin?: 'BUILTIN' | 'USER';
  /** Trusted publication policy, keyed by raw tool name; remote annotations never grant callers. */
  readonly allowedToolCallers?: Readonly<Record<string, readonly ('direct' | 'programmatic')[]>>;
  readonly sourceIdentity?: string;
  /** Trusted non-secret Host principal; never inferred from a token value. */
  readonly authorizationIdentity?: string;
  readonly lifecycle?: 'SHARED' | 'EXECUTION';
  readonly transport: 'STDIO' | 'HTTP';
  readonly command?: string;
  readonly args?: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
}
