import { randomUUID } from 'node:crypto';
import { nodeUpgradeStatusSchema } from '@myagentroam/protocol';
import { z } from 'zod';

const envelope = z.object({
  version: z.literal(2),
  id: z.string().min(1).max(128),
  type: z.enum(['authenticate', 'heartbeat', 'capabilities', 'node.response']),
  replyTo: z.string().min(1).max(128).optional(),
  payload: z.unknown()
});
const authentication = z.object({
  nodeId: z.string().min(1).max(128),
  credential: z.string().min(1).max(2048)
});
const capabilities = z.object({
  platform: z.string().min(1).max(128),
  architecture: z.string().min(1).max(128),
  nodeAppVersion: z.string().min(1).max(128).optional(),
  nodeVersion: z.string().min(1).max(128),
  metadata: z
    .object({
      supervisedUpgrade: z.boolean().optional(),
      upgrade: nodeUpgradeStatusSchema.optional()
    })
    .optional()
});
const response = z.object({}).passthrough();

/** The v2 decoder deliberately contains only the established upgrade control plane. */
export function parseLegacyNodeUpgradeEnvelope(value: unknown) {
  const parsed = envelope.parse(value);
  switch (parsed.type) {
    case 'authenticate':
      return {
        ...parsed,
        type: 'authenticate' as const,
        payload: authentication.parse(parsed.payload)
      };
    case 'capabilities':
      return {
        ...parsed,
        type: 'capabilities' as const,
        payload: capabilities.parse(parsed.payload)
      };
    case 'heartbeat':
      return { ...parsed, type: 'heartbeat' as const };
    case 'node.response':
      if (parsed.replyTo === undefined) throw new Error('MESSAGE_INVALID');
      return {
        ...parsed,
        type: 'node.response' as const,
        replyTo: parsed.replyTo,
        payload: response.parse(parsed.payload)
      };
  }
}

export function legacyNodeUpgradeEnvelope(
  type: string,
  payload: unknown,
  options: { readonly id?: string; readonly replyTo?: string } = {}
) {
  return {
    version: 2 as const,
    id: options.id ?? randomUUID(),
    type,
    ...(options.replyTo === undefined ? {} : { replyTo: options.replyTo }),
    payload
  };
}
