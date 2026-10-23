import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hasMarctlContext } from '../marctl-guidance.js';
import type { ResolvedMcpServer } from './model.js';
import { assertMcpServerNames, NODE_MCP } from './naming.js';

/** Add read-only guidance after credential-bearing MCP configuration has been resolved. */
export function withMarctlGuide(
  servers: readonly ResolvedMcpServer[],
  environment: Readonly<Record<string, string>>
): readonly ResolvedMcpServer[] {
  if (!hasMarctlContext({ ...environment, MAR_CTL_CONTEXT_REQUIRED: '1' })) return servers;
  const javascript = fileURLToPath(new URL('./marctl-guide-stdio.js', import.meta.url));
  const args = existsSync(javascript)
    ? [javascript]
    : [
        '--import',
        import.meta.resolve('tsx'),
        fileURLToPath(new URL('./marctl-guide-stdio.ts', import.meta.url))
      ];
  const result: readonly ResolvedMcpServer[] = [
    ...servers,
    {
      name: NODE_MCP.cli.name,
      origin: 'BUILTIN',
      lifecycle: 'EXECUTION',
      transport: 'STDIO',
      command: process.execPath,
      args
    }
  ];
  assertMcpServerNames(result);
  return result;
}
