import { z } from 'zod';

const id = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);
const nodeId = z.string().min(1).max(512);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const code = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u);
const grant = z.string().min(32).max(4096);
const fingerprint = z.string().regex(/^sha-256(?: [A-F0-9]{2}(?::[A-F0-9]{2}){31})$/u);
export const remoteDesktopModeSchema = z.enum(['VIEW', 'CONTROL']);

export const remoteDesktopDescribeInputSchema = z
  .object({ displayId: id.optional(), desktopGeneration: id.optional() })
  .strict()
  .refine((value) => value.displayId === undefined || value.desktopGeneration === undefined);

const nativeCoordinate = z.number().finite().min(-0x80000000).max(0x7fffffff);
const dimension = z.number().int().positive().max(65535);
const nativeRectangle = z
  .object({
    x: nativeCoordinate,
    y: nativeCoordinate,
    width: z.number().finite().positive().max(65535),
    height: z.number().finite().positive().max(65535)
  })
  .strict();
const framebufferRectangle = z
  .object({
    x: z.number().int().nonnegative().max(65535),
    y: z.number().int().nonnegative().max(65535),
    width: dimension,
    height: dimension
  })
  .strict();
const coefficient = z.number().finite().min(-1_000_000).max(1_000_000);

/**
 * The adapter supplies [a,b,c,d,tx,ty], mapping x'=a*x+c*y+tx and
 * y'=b*x+d*y+ty; the browser must not infer it from devicePixelRatio.
 */
export const remoteDesktopDescriptionSchema = z
  .object({
    desktopGeneration: id,
    topologyRevision: revision,
    selectableDisplays: z
      .array(
        z.object({ displayId: id, name: z.string().min(1).max(256), primary: z.boolean() }).strict()
      )
      .min(1)
      .max(64)
      .optional(),
    framebuffer: z.object({ width: dimension, height: dimension }).strict(),
    displays: z
      .array(
        z
          .object({
            displayId: id,
            name: z.string().min(1).max(256),
            primary: z.boolean(),
            nativeBounds: nativeRectangle,
            framebufferBounds: framebufferRectangle,
            nativeToFramebuffer: z.tuple([
              coefficient,
              coefficient,
              coefficient,
              coefficient,
              coefficient,
              coefficient
            ])
          })
          .strict()
      )
      .min(1)
      .max(64)
  })
  .strict()
  .superRefine((description, context) => {
    const seen = new Set<string>();
    let primaryCount = 0;
    description.displays.forEach((display, index) => {
      const bounds = display.framebufferBounds;
      if (seen.has(display.displayId))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['displays', index, 'displayId'],
          message: 'Duplicate display ID'
        });
      seen.add(display.displayId);
      if (display.primary) primaryCount++;
      if (
        bounds.x < 0 ||
        bounds.y < 0 ||
        bounds.x + bounds.width > description.framebuffer.width ||
        bounds.y + bounds.height > description.framebuffer.height
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['displays', index, 'framebufferBounds'],
          message: 'Display is outside the framebuffer'
        });
      const [a, b, c, d, tx, ty] = display.nativeToFramebuffer;
      const native = display.nativeBounds;
      const corners = [
        [native.x, native.y],
        [native.x + native.width, native.y],
        [native.x, native.y + native.height],
        [native.x + native.width, native.y + native.height]
      ].map(([x, y]) => [a * x! + c * y! + tx, b * x! + d * y! + ty]);
      const xs = corners.map((corner) => corner[0]!);
      const ys = corners.map((corner) => corner[1]!);
      if (
        Math.abs(a * d - b * c) < 1e-12 ||
        Math.abs(Math.min(...xs) - bounds.x) > 1 ||
        Math.abs(Math.min(...ys) - bounds.y) > 1 ||
        Math.abs(Math.max(...xs) - bounds.x - bounds.width) > 1 ||
        Math.abs(Math.max(...ys) - bounds.y - bounds.height) > 1
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['displays', index, 'nativeToFramebuffer'],
          message: 'Display mapping does not match its bounds'
        });
    });
    if (primaryCount !== 1)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['displays'],
        message: 'Exactly one primary display is required'
      });
    if (description.selectableDisplays) {
      const catalog = description.selectableDisplays;
      if (
        description.displays.length !== 1 ||
        !catalog.some((display) => display.displayId === description.displays[0]?.displayId) ||
        new Set(catalog.map((display) => display.displayId)).size !== catalog.length ||
        catalog.filter((display) => display.primary).length !== 1
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['selectableDisplays'],
          message: 'Invalid capture display catalog'
        });
    }
  });
export type RemoteDesktopDescription = z.infer<typeof remoteDesktopDescriptionSchema>;

export const remoteDesktopCapabilitySchema = z.discriminatedUnion('available', [
  z
    .object({
      apiVersion: z.literal(1),
      available: z.literal(false),
      nodeGeneration: id,
      reasonCode: code
    })
    .strict(),
  z
    .object({
      apiVersion: z.literal(1),
      available: z.literal(true),
      nodeGeneration: id,
      backend: z.enum(['TIGERVNC_X0', 'ULTRAVNC', 'MACVNC']),
      supportsView: z.literal(true),
      supportsControl: z.boolean(),
      supportsMultiDisplay: z.boolean(),
      supportsUnicodePaste: z.boolean(),
      transports: z
        .array(z.enum(['DIRECT', 'RELAY']))
        .min(1)
        .max(2)
        .refine((items) => new Set(items).size === items.length)
    })
    .strict()
]);
export type RemoteDesktopCapability = z.infer<typeof remoteDesktopCapabilitySchema>;

/** Authenticated page control messages, never an RFB data or input protocol. */
export const remoteDesktopDirectBrowserMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('desktop.direct.prepare'),
      requestId: id,
      nodeId,
      nodeGeneration: id,
      transportSessionId: id,
      desktopGeneration: id,
      topologyRevision: revision,
      mode: remoteDesktopModeSchema
    })
    .strict(),
  z.object({ type: z.literal('desktop.direct.heartbeat'), attachmentId: id }).strict(),
  z.object({ type: z.literal('desktop.direct.cancel'), attachmentId: id }).strict(),
  z.object({ type: z.literal('desktop.ready'), attachmentId: id }).strict()
]);
export type RemoteDesktopDirectBrowserMessage = z.infer<
  typeof remoteDesktopDirectBrowserMessageSchema
>;

export const remoteDesktopDirectServerMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('desktop.direct.prepared'),
      requestId: id,
      attachmentId: id,
      grant,
      openExpiresAt: timestamp,
      expiresAt: timestamp
    })
    .strict(),
  z
    .object({ type: z.literal('desktop.direct.heartbeat'), attachmentId: id, expiresAt: timestamp })
    .strict(),
  z.object({ type: z.literal('desktop.direct.closed'), attachmentId: id, code }).strict(),
  z.object({ type: z.literal('desktop.direct.settled'), attachmentId: id, code }).strict(),
  z
    .object({
      type: z.literal('desktop.direct.error'),
      requestId: id.optional(),
      attachmentId: id.optional(),
      settled: z.literal(true).optional(),
      code,
      message: z.string().min(1).max(1000)
    })
    .strict()
]);
export type RemoteDesktopDirectServerMessage = z.infer<
  typeof remoteDesktopDirectServerMessageSchema
>;

export const remoteDesktopDirectNodeCommandSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('desktop.direct.prepare'),
      attachmentId: id,
      transportSessionId: id,
      workbenchConnectionId: id,
      nodeGeneration: id,
      desktopGeneration: id,
      topologyRevision: revision,
      mode: remoteDesktopModeSchema,
      grant,
      browserFingerprint: fingerprint,
      nodeFingerprint: fingerprint,
      openExpiresAt: timestamp,
      expiresAt: timestamp
    })
    .strict(),
  z
    .object({ type: z.literal('desktop.direct.heartbeat'), attachmentId: id, expiresAt: timestamp })
    .strict(),
  z.object({ type: z.literal('desktop.direct.cancel'), attachmentId: id, code }).strict(),
  z.object({ type: z.literal('desktop.ready'), attachmentId: id }).strict()
]);
export type RemoteDesktopDirectNodeCommand = z.infer<typeof remoteDesktopDirectNodeCommandSchema>;

export const remoteDesktopDirectNodeEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('desktop.direct.ready'),
      attachmentId: id,
      nodeGeneration: id,
      phase: z.enum(['PREPARED', 'OPEN', 'ATTACHED', 'ACTIVE'])
    })
    .strict(),
  z
    .object({
      type: z.literal('desktop.direct.closed'),
      attachmentId: id,
      nodeGeneration: id,
      code
    })
    .strict()
]);
export type RemoteDesktopDirectNodeEvent = z.infer<typeof remoteDesktopDirectNodeEventSchema>;

/** Relay uses the same admission phases and RFB OPEN; its one-time data sockets are distinct. */
export const remoteDesktopRelayBrowserMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('desktop.relay.prepare'),
      requestId: id,
      nodeId,
      nodeGeneration: id,
      desktopGeneration: id,
      topologyRevision: revision,
      mode: remoteDesktopModeSchema
    })
    .strict(),
  z.object({ type: z.literal('desktop.relay.heartbeat'), attachmentId: id }).strict(),
  z.object({ type: z.literal('desktop.relay.cancel'), attachmentId: id }).strict(),
  z.object({ type: z.literal('desktop.ready'), attachmentId: id }).strict()
]);
export type RemoteDesktopRelayBrowserMessage = z.infer<
  typeof remoteDesktopRelayBrowserMessageSchema
>;

export const remoteDesktopRelayServerMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('desktop.relay.prepared'),
      requestId: id,
      attachmentId: id,
      grant,
      ticket: grant,
      openExpiresAt: timestamp,
      expiresAt: timestamp
    })
    .strict(),
  z
    .object({ type: z.literal('desktop.relay.heartbeat'), attachmentId: id, expiresAt: timestamp })
    .strict(),
  z.object({ type: z.literal('desktop.relay.closed'), attachmentId: id, code }).strict(),
  z.object({ type: z.literal('desktop.relay.settled'), attachmentId: id, code }).strict(),
  z
    .object({
      type: z.literal('desktop.relay.error'),
      requestId: id.optional(),
      attachmentId: id.optional(),
      settled: z.literal(true).optional(),
      code,
      message: z.string().min(1).max(1000)
    })
    .strict()
]);
export type RemoteDesktopRelayServerMessage = z.infer<typeof remoteDesktopRelayServerMessageSchema>;

export const remoteDesktopRelayNodeCommandSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('desktop.relay.prepare'),
      attachmentId: id,
      workbenchConnectionId: id,
      nodeGeneration: id,
      desktopGeneration: id,
      topologyRevision: revision,
      mode: remoteDesktopModeSchema,
      grant,
      ticket: grant,
      openExpiresAt: timestamp,
      expiresAt: timestamp
    })
    .strict(),
  z
    .object({ type: z.literal('desktop.relay.heartbeat'), attachmentId: id, expiresAt: timestamp })
    .strict(),
  z.object({ type: z.literal('desktop.relay.cancel'), attachmentId: id, code }).strict(),
  z.object({ type: z.literal('desktop.ready'), attachmentId: id }).strict()
]);
export type RemoteDesktopRelayNodeCommand = z.infer<typeof remoteDesktopRelayNodeCommandSchema>;

export const remoteDesktopRelayNodeEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('desktop.relay.ready'),
      attachmentId: id,
      nodeGeneration: id,
      phase: z.enum(['PREPARED', 'OPEN', 'ATTACHED', 'ACTIVE'])
    })
    .strict(),
  z
    .object({ type: z.literal('desktop.relay.closed'), attachmentId: id, nodeGeneration: id, code })
    .strict()
]);
export type RemoteDesktopRelayNodeEvent = z.infer<typeof remoteDesktopRelayNodeEventSchema>;

/** Sent only as the first WebSocket message, never in a URL. */
export const remoteDesktopRelayBrowserAttachSchema = z
  .object({
    type: z.literal('desktop.relay.browser'),
    attachmentId: id,
    workbenchConnectionId: id,
    ticket: grant
  })
  .strict();
export const remoteDesktopRelayNodeAttachSchema = z
  .object({
    type: z.literal('desktop.relay.node'),
    nodeId,
    nodeGeneration: id,
    attachmentId: id,
    ticket: grant,
    credential: z.string().min(1).max(4096)
  })
  .strict();

/** Only this one-time authorization envelope precedes standard RFB bytes. */
export const remoteDesktopDirectOpenFrameSchema = z
  .object({
    type: z.literal('OPEN'),
    attachmentId: id,
    grant
  })
  .strict();
export const remoteDesktopAttachedFrameSchema = z
  .object({
    type: z.literal('ATTACHED'),
    attachmentId: id
  })
  .strict();
