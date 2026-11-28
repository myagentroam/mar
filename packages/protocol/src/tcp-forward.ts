import { z } from 'zod';
import { readStreamRecords, writeStreamRecord } from './stream-record.js';

export const tcpForwardControlKind = 'tcp-forward-control';
export const tcpForwardDataKind = 'tcp-forward-data';
export const tcpForwardMaxConnections = 8;
export const tcpForwardSetupMs = 10_000;
export const tcpForwardPort = z.number().int().min(1).max(65535);
export const tcpForwardHost = z.union([
  z.string().ip(),
  z
    .string()
    .min(1)
    .max(254)
    .regex(/^[a-zA-Z0-9_.-]+$/u)
]);
export const tcpForwardRequest = z
  .object({
    direction: z.enum(['local', 'reverse']),
    port: tcpForwardPort,
    host: tcpForwardHost
  })
  .strict();
export const tcpForwardConnectionId = z.number().int().min(0).max(0xffffffff);
export const tcpForwardAdmission = tcpForwardRequest.extend({ id: z.string().uuid() });
export const tcpForwardDataAdmission = z
  .object({ id: z.string().uuid(), connection: tcpForwardConnectionId })
  .strict();

export function decodeTcpForward<T>(schema: z.ZodType<T>, value: string): T | undefined {
  try {
    const decoded = schema.safeParse(JSON.parse(value));
    return decoded.success ? decoded.data : undefined;
  } catch {
    return undefined;
  }
}

// The Node announces bind readiness (0) and accepted reverse sockets (nonzero IDs).
export function writeTcpForwardNotice(id: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, tcpForwardConnectionId.parse(id));
  return writeStreamRecord(bytes, 4, 'TCP_FORWARD_NOTICE_INVALID');
}

export async function* readTcpForwardNotices(source: AsyncIterable<Uint8Array>) {
  for await (const bytes of readStreamRecords(
    source,
    4,
    'TCP_FORWARD_NOTICE_INVALID',
    'TCP_FORWARD_NOTICE_INVALID'
  )) {
    if (bytes.byteLength !== 4) throw new Error('TCP_FORWARD_NOTICE_INVALID');
    yield new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);
  }
}
