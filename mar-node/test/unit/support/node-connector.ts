import type { NodeConnector } from '../../../src/connector.js';

export function executeNodeOperation(
  connector: NodeConnector,
  operation: string,
  data: unknown
): Promise<unknown> {
  return (
    connector as unknown as {
      executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
    }
  ).executeNodeOperation(operation, data);
}
