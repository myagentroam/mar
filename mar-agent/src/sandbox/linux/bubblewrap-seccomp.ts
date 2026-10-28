import { policyInvalid } from './sandbox-error.js';

export function seccompFilter(architecture: string): Buffer {
  const policy = syscallPolicy(architecture);
  const filters: Array<readonly [number, number, number, number]> = [
    [0x20, 0, 0, 4],
    [0x15, 1, 0, policy.auditArchitecture],
    [0x06, 0, 0, 0x80000000],
    [0x20, 0, 0, 0]
  ];
  if (architecture === 'x64')
    filters.push(
      [0x54, 0, 0, 0x40000000],
      [0x15, 1, 0, 0],
      [0x06, 0, 0, 0x80000000],
      [0x20, 0, 0, 0]
    );
  for (const syscall of policy.blockedSyscalls)
    filters.push([0x15, 0, 1, syscall], [0x06, 0, 0, 0x00050001]);
  filters.push([0x06, 0, 0, 0x7fff0000]);
  const buffer = Buffer.alloc(filters.length * 8);
  for (const [index, [code, jumpTrue, jumpFalse, value]] of filters.entries()) {
    const offset = index * 8;
    buffer.writeUInt16LE(code, offset);
    buffer.writeUInt8(jumpTrue, offset + 2);
    buffer.writeUInt8(jumpFalse, offset + 3);
    buffer.writeUInt32LE(value >>> 0, offset + 4);
  }
  return buffer;
}

function syscallPolicy(architecture: string): {
  readonly auditArchitecture: number;
  readonly blockedSyscalls: readonly number[];
} {
  if (architecture === 'x64')
    return {
      auditArchitecture: 0xc000003e,
      blockedSyscalls: [
        101, 155, 165, 166, 175, 176, 246, 248, 249, 250, 272, 298, 304, 308, 313, 321, 323, 428,
        429, 430, 431, 432, 442
      ]
    };
  if (architecture === 'arm64')
    return {
      auditArchitecture: 0xc00000b7,
      blockedSyscalls: [
        39, 40, 41, 97, 104, 105, 106, 117, 217, 218, 219, 241, 265, 268, 273, 280, 282, 428, 429,
        430, 431, 432, 442
      ]
    };
  throw policyInvalid();
}
