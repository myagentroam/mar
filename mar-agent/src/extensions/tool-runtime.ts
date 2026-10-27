import type {
  ClientToolDefinition,
  McpToolCatalog,
  ToolCall,
  ToolExecutionResult
} from '../tools/contracts.js';
import type { ExtensionOperationContext } from './operation.js';

/** Tool operations needed by the Extension ingress; SDK supplies the Tool implementation. */
export interface ExtensionToolRuntime {
  currentPermissions(call: ExtensionOperationContext):
    | {
        readonly mode: string;
        assertDispatch(): void;
        prepare(
          input: ToolCall,
          call: ExtensionOperationContext,
          definition: ClientToolDefinition
        ): ToolCall;
        authorize(input: ToolCall, call: ExtensionOperationContext): Promise<ToolCall>;
      }
    | undefined;
  normalizeInput(input: unknown, schema: unknown): unknown;
  validateResult(result: ToolExecutionResult): ToolExecutionResult;
  independent<T>(run: () => T): T;
  validateCallers(definition: ClientToolDefinition): void;
  validateMcpCatalog(catalog: McpToolCatalog): void;
}
