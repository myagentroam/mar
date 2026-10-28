export function isValidUtf8(source: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(source);
    return true;
  } catch {
    return false;
  }
}

export function isUtf8ContinuationByte(value: number): boolean {
  return (value & 0b1100_0000) === 0b1000_0000;
}
