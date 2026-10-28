import { describe, expect, it } from 'vitest';
import { seccompFilter } from '../../src/sandbox/linux/bubblewrap-seccomp.js';

function runFilter(filter: Buffer, architecture: number, syscall: number): number {
  let accumulator = 0;
  for (let pc = 0; pc < filter.length / 8; pc++) {
    const offset = pc * 8;
    const opcode = filter.readUInt16LE(offset);
    const yes = filter.readUInt8(offset + 2);
    const no = filter.readUInt8(offset + 3);
    const value = filter.readUInt32LE(offset + 4);
    if (opcode === 0x20) accumulator = value === 4 ? architecture : syscall;
    else if (opcode === 0x54) accumulator &= value;
    else if (opcode === 0x15) pc += accumulator === value ? yes : no;
    else if (opcode === 0x06) return value;
    else throw new Error(`Unexpected BPF instruction ${opcode}`);
  }
  throw new Error('Filter did not return');
}

describe('Bubblewrap seccomp policy', () => {
  it.each([
    ['x64', 0xc000003e, 101, 0],
    ['arm64', 0xc00000b7, 117, 63]
  ] as const)(
    'enforces the %s architecture guard and syscall decisions',
    (arch, audit, blocked, allowed) => {
      const filter = seccompFilter(arch);
      expect(runFilter(filter, audit, blocked)).toBe(0x00050001);
      expect(runFilter(filter, audit, allowed)).toBe(0x7fff0000);
      expect(runFilter(filter, audit ^ 1, allowed)).toBe(0x80000000);
      if (arch === 'x64') expect(runFilter(filter, audit, 0x40000000)).toBe(0x80000000);
    }
  );
  it('rejects unsupported architectures', () => {
    expect(() => seccompFilter('unsupported')).toThrowError(
      expect.objectContaining({ code: 'SANDBOX_POLICY_INVALID' })
    );
  });
});
