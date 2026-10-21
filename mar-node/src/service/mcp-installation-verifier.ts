import { NODE_MCP_CLIENT_INFO } from '../mcp/naming.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpCatalogEntry, McpInstallationConfiguration } from '@myagentroam/protocol';

const INSTALL_TIMEOUT_MS = 90_000;

export class McpInstallationVerifier {
  async verify(input: {
    readonly entry: McpCatalogEntry;
    readonly configuration: McpInstallationConfiguration;
    readonly secrets: Readonly<Record<string, string>>;
    readonly cwd: string;
  }): Promise<void> {
    const client = new Client(NODE_MCP_CLIENT_INFO);
    try {
      await withTimeout(
        (async () => {
          if (input.entry.runtime.transport === 'STDIO') {
            await client.connect(
              new StdioClientTransport({
                command: input.entry.runtime.command,
                args: [...input.entry.runtime.args, ...(input.configuration.arguments ?? [])],
                env: {
                  ...getDefaultEnvironment(),
                  ...resolveReferences(input.entry.runtime.environment, input.secrets),
                  ...resolveReferences(input.configuration.environment, input.secrets)
                },
                cwd: input.cwd,
                stderr: 'pipe'
              })
            );
          } else {
            await client.connect(
              new StreamableHTTPClientTransport(new URL(input.entry.runtime.url), {
                requestInit: {
                  headers: {
                    ...resolveReferences(input.entry.runtime.headers, input.secrets),
                    ...resolveReferences(input.configuration.headers, input.secrets)
                  }
                }
              }) as unknown as Transport
            );
          }
          const tools = await client.listTools();
          if (tools.tools.length === 0) throw new Error('MCP_TOOLS_UNAVAILABLE');
        })()
      );
    } catch (error) {
      throw installError(error);
    } finally {
      await Promise.race([client.close().catch(() => undefined), delay(2_000)]);
    }
  }
}

function resolveReferences(
  references: Readonly<Record<string, { readonly secretName: string }>> | undefined,
  secrets: Readonly<Record<string, string>>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, reference] of Object.entries(references ?? {})) {
    const value = secrets[reference.secretName];
    if (value === undefined) throw new Error('MCP_SECRET_MISSING');
    result[name] = value;
  }
  return result;
}

async function withTimeout(operation: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('MCP_INSTALL_TIMEOUT')), INSTALL_TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function installError(error: unknown): Error {
  const message = error instanceof Error ? error.message : '';
  if (
    message === 'MCP_INSTALL_TIMEOUT' ||
    message === 'MCP_SECRET_MISSING' ||
    message === 'MCP_TOOLS_UNAVAILABLE'
  )
    return new Error(message);
  if (/401|403|unauthorized|forbidden/iu.test(message)) return new Error('MCP_AUTH_FAILED');
  if (/ENOENT|spawn/iu.test(message)) return new Error('MCP_COMMAND_UNAVAILABLE');
  if (/fetch|connect|network|ECONN|ENOTFOUND/iu.test(message))
    return new Error('MCP_CONNECTION_FAILED');
  return new Error('MCP_PROTOCOL_VALIDATION_FAILED');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
