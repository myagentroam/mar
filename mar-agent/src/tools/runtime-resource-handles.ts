import { randomBytes } from 'node:crypto';
import { AgentError } from '../error.js';

const types = {
  cell: { prefix: 'c_', field: 'cellId', tool: 'code_exec_wait' },
  process: { prefix: 'p_', field: 'processId', tool: 'exec_wait' }
} as const;

/** Typed runtime handles; resource owners retain registration and lifecycle authority. */
export class RuntimeResourceHandles {
  constructor(
    private readonly kind: keyof typeof types,
    private readonly isReserved: (id: string) => boolean
  ) {}

  create(): string {
    let id: string;
    do {
      id = `${types[this.kind].prefix}${randomBytes(6).toString('hex')}`;
    } while (this.isReserved(id));
    return id;
  }

  assertType(id: string): void {
    const expected = types[this.kind];
    const actual = Object.values(types).find((type) => id.startsWith(type.prefix));
    if (actual && actual !== expected)
      throw new AgentError(
        'MAR_AGENT_RESOURCE_HANDLE_TYPE_MISMATCH',
        `Expected ${expected.field} (${expected.prefix}...). This looks like ${actual.field}; use ${actual.tool} for that resource.`,
        { details: { expected: expected.field, received: actual.field, tool: actual.tool } }
      );
  }
}
