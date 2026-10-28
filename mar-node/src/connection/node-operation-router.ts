import type { NodeOperationHandler } from '../application/node-operation-contracts.js';

/** Exact allow-list dispatcher for protocol-defined Node operations. */
export class NodeOperationRouter {
  private readonly handlers = new Map<string, NodeOperationHandler>();

  register(operation: string, handler: NodeOperationHandler): void {
    if (this.handlers.has(operation))
      throw new Error(`NODE_OPERATION_ALREADY_REGISTERED:${operation}`);
    this.handlers.set(operation, handler);
  }

  registerAll(handlers: Readonly<Record<string, NodeOperationHandler>>): void {
    for (const [operation, handler] of Object.entries(handlers)) this.register(operation, handler);
  }

  has(operation: string): boolean {
    return this.handlers.has(operation);
  }

  execute(operation: string, data: unknown): Promise<unknown> {
    const handler = this.handlers.get(operation);
    if (handler === undefined) return Promise.reject(new Error('OPERATION_UNSUPPORTED'));
    return Promise.resolve(handler(data));
  }
}
