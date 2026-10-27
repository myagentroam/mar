import type { ExtensionToolRuntime } from '../extensions/tool-runtime.js';
import { currentToolPermissions } from '../tools/permissions.js';
import { normalizeToolInput } from '../tools/input.js';
import { validateToolResult } from '../tools/output-projection.js';
import { withIndependentSessionTools } from '../tools/scheduler.js';
import { toolCallers } from '../tools/callers.js';
import { assertMcpToolCatalog } from '../tools/mcp/catalog.js';

export const extensionToolRuntime: ExtensionToolRuntime = {
  currentPermissions: currentToolPermissions,
  normalizeInput: normalizeToolInput,
  validateResult: validateToolResult,
  independent: withIndependentSessionTools,
  validateCallers: toolCallers,
  validateMcpCatalog: (catalog) => assertMcpToolCatalog(catalog, { nativeToolNames: true })
};
