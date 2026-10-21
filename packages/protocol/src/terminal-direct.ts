import { z } from 'zod';

const id = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);
const resourceId = z.string().min(1).max(512);
const expiresAt = z.number().int().positive();
const code = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u);
const fingerprint = z.string().regex(/^sha-256(?: [A-F0-9]{2}(?::[A-F0-9]{2}){31})$/u);

export const terminalDirectCapabilitySchema = z
  .object({ apiVersion: z.literal(1), transport: z.literal(true) })
  .strict();

export const terminalDirectBrowserMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('terminal.direct.prepare'),
      requestId: id,
      nodeId: resourceId,
      nodeGeneration: id,
      transportSessionId: id,
      terminalId: resourceId,
      workspaceId: resourceId.optional(),
      afterSequence: z.number().int().nonnegative(),
      readonly: z.boolean(),
      takeover: z.literal(false).optional()
    })
    .strict(),
  z.object({ type: z.literal('terminal.direct.heartbeat'), directSessionId: id }).strict(),
  z.object({ type: z.literal('terminal.direct.cancel'), directSessionId: id }).strict()
]);
export type TerminalDirectBrowserMessage = z.infer<typeof terminalDirectBrowserMessageSchema>;

export const terminalDirectServerMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('terminal.direct.prepared'),
      requestId: id,
      directSessionId: id,
      grant: z.string().min(32).max(4096),
      openExpiresAt: expiresAt,
      expiresAt
    })
    .strict(),
  z
    .object({
      type: z.literal('terminal.direct.heartbeat'),
      directSessionId: id,
      expiresAt
    })
    .strict(),
  z.object({ type: z.literal('terminal.direct.closed'), directSessionId: id, code }).strict(),
  z
    .object({
      type: z.literal('terminal.direct.error'),
      requestId: id.optional(),
      directSessionId: id.optional(),
      code,
      message: z.string().min(1).max(1000)
    })
    .strict()
]);
export type TerminalDirectServerMessage = z.infer<typeof terminalDirectServerMessageSchema>;

export const terminalDirectNodeCommandSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('terminal.direct.prepare'),
      directSessionId: id,
      transportSessionId: id,
      workbenchConnectionId: id,
      nodeGeneration: id,
      terminalId: resourceId,
      workspaceId: resourceId.optional(),
      afterSequence: z.number().int().nonnegative(),
      readonly: z.boolean(),
      takeover: z.literal(false).optional(),
      grant: z.string().min(32).max(4096),
      browserFingerprint: fingerprint,
      nodeFingerprint: fingerprint,
      openExpiresAt: expiresAt,
      expiresAt
    })
    .strict(),
  z
    .object({ type: z.literal('terminal.direct.heartbeat'), directSessionId: id, expiresAt })
    .strict(),
  z.object({ type: z.literal('terminal.direct.cancel'), directSessionId: id, code }).strict()
]);
export type TerminalDirectNodeCommand = z.infer<typeof terminalDirectNodeCommandSchema>;

export const terminalDirectNodeEventSchema = z
  .object({
    type: z.literal('terminal.direct.ready'),
    directSessionId: id,
    phase: z.enum(['PREPARED', 'ATTACHED']).optional()
  })
  .strict();

export const terminalDirectOpenFrameSchema = z
  .object({
    type: z.literal('OPEN'),
    directSessionId: id,
    grant: z.string().min(32).max(4096)
  })
  .strict();
export const terminalDirectAttachedFrameSchema = z
  .object({
    type: z.literal('ATTACHED'),
    terminalId: resourceId,
    afterSequence: z.number().int().nonnegative()
  })
  .strict();
