import type { SessionRecord } from './record-contract.js';
import { compactSummaryFromCheckpoint } from './record-projection.js';

export interface McpDiscoveryReceipt {
  id: string;
  names: readonly string[];
}

export const MCP_DISCOVERY_DELIVERED = 'mcp.discovery.delivered';

export function parseMcpDiscoveryReceipt(value: unknown): McpDiscoveryReceipt | undefined {
  if (!isRecord(value)) return undefined;
  const { id, names } = value;
  if (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= 128 &&
    Array.isArray(names) &&
    names.length <= 20 &&
    names.every((name) => typeof name === 'string' && name.length <= 512)
  )
    return { id, names };
  return undefined;
}

/** Replay only delivery state. Current catalog policy still controls exposure. */
export function restorePendingMcpDiscovery(records: readonly SessionRecord[]): Map<string, string> {
  const pending = new Map<string, string>();
  for (const record of records) {
    const { type, payload } = record;
    if (!isRecord(payload)) continue;
    if (type === 'model.context' && payload.role === 'user') {
      const receipt = parseMcpDiscoveryReceipt(payload.mcpDiscovery);
      if (receipt) for (const name of receipt.names) pending.set(name, receipt.id);
    } else if (type === MCP_DISCOVERY_DELIVERED && Array.isArray(payload.receipts)) {
      for (const value of payload.receipts) {
        const receipt = parseMcpDiscoveryReceipt(value);
        if (!receipt) continue;
        for (const name of receipt.names)
          if (pending.get(name) === receipt.id) pending.delete(name);
      }
    } else if (type === 'compact.completed' && compactSummaryFromCheckpoint(record)) {
      pending.clear();
      if (!Array.isArray(payload.retainedModelContext)) continue;
      for (const message of payload.retainedModelContext) {
        if (!isRecord(message) || message.role !== 'user') continue;
        const receipt = parseMcpDiscoveryReceipt(message.mcpDiscovery);
        if (!receipt) continue;
        const saved = Array.isArray(message.mcpDiscoveryPendingNames)
          ? message.mcpDiscoveryPendingNames
          : receipt.names;
        for (const name of receipt.names) {
          if (saved.includes(name)) pending.set(name, receipt.id);
          else pending.delete(name);
        }
      }
    }
  }
  return pending;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
