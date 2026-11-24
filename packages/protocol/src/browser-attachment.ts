import { z } from 'zod';
import { browserPageInputSchema } from './browser-input.js';
import { browserFileChooserSchema } from './browser-files.js';

const positiveUint32 = z.number().int().positive().max(0xffffffff);
const tabId = z.string().uuid();
const id = z.string().uuid();
const opaque = z.string().min(1).max(512);
const coordinate = z.number().min(0).max(0xffff);
const browserContextOptionsSchema = z.strictObject({
  copy: z.boolean(),
  paste: z.boolean(),
  link: z
    .string()
    .url()
    .regex(/^https?:\/\//u)
    .max(8192)
    .optional()
});
export type BrowserContextOptions = z.infer<typeof browserContextOptionsSchema>;
export const BROWSER_CONTROL_MAX_BYTES = 32 * 1024;
export const BROWSER_TAB_LIMIT = 8;
export const BROWSER_TAB_ICON_BASE64_MAX = 4096;
export const BROWSER_VIEWPORT_MIN = 16;
export const BROWSER_VIEWPORT_MAX = 2560;
const viewportEdge = z.number().int().min(BROWSER_VIEWPORT_MIN).max(BROWSER_VIEWPORT_MAX);

/** The synthetic Workspace preview origin is never a device-browser destination. */
export const BROWSER_WORKSPACE_PREVIEW_SUFFIX = '.mar-workspace-preview.invalid';
export function isBrowserWorkspacePreview(url: string): boolean {
  return URL.parse(url)?.hostname.endsWith(BROWSER_WORKSPACE_PREVIEW_SUFFIX) ?? false;
}

export const browserCapabilitySchema = z.strictObject({
  apiVersion: z.literal(1),
  nodeGeneration: opaque,
  ice: z.boolean()
});
export type BrowserCapability = z.infer<typeof browserCapabilitySchema>;
export const BROWSER_RELAY_READY = 'BROWSER_RELAY_READY';

export const browserAttachmentRouteSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('relay') }),
  z.strictObject({ type: z.literal('ice'), transportId: opaque, fingerprint: opaque })
]);

export const browserAttachmentPrepareSchema = z.strictObject({
  attachmentId: id,
  browserId: id,
  workspaceId: opaque,
  userId: z.number().int().positive().safe(),
  sessionId: opaque,
  connectionId: opaque,
  route: browserAttachmentRouteSchema,
  ticket: z.string().min(32).max(128),
  expiresAt: z.number().int().positive().safe(),
  replaces: id.optional()
});

export const browserAttachmentOpenSchema = z.strictObject({
  type: z.literal('OPEN'),
  attachmentId: id,
  ticket: z.string().min(32).max(128),
  hd: z.literal(true).optional()
});

export type BrowserAttachmentPrepare = z.infer<typeof browserAttachmentPrepareSchema>;
export type BrowserAttachmentOpen = z.infer<typeof browserAttachmentOpenSchema>;
export type BrowserAttachmentRoute = z.infer<typeof browserAttachmentRouteSchema>;

// Internal Node operations, not part of the generic Workbench operation allowlist.
export const browserNodeAttachmentCommandSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('prepare'), grant: browserAttachmentPrepareSchema }),
  z.strictObject({
    action: z.literal('renew'),
    attachmentId: id,
    expiresAt: z.number().int().positive().safe()
  }),
  z.strictObject({
    action: z.literal('revoke'),
    attachmentId: id,
    workspaceId: opaque,
    browserId: id,
    code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u)
  })
]);

export type BrowserNodeAttachmentCommand = z.infer<typeof browserNodeAttachmentCommandSchema>;

export const browserResourceCommandSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('open'), preserveLogin: z.boolean() }),
  z.strictObject({ action: z.literal('lookup') }),
  z.strictObject({ action: z.literal('close'), browserId: id })
]);

export type BrowserResourceCommand = z.infer<typeof browserResourceCommandSchema>;

export const browserFindOperationSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('start'), query: z.string().min(1).max(256) }),
  z.strictObject({ action: z.enum(['next', 'previous', 'clear']) })
]);
export type BrowserFindOperation = z.infer<typeof browserFindOperationSchema>;

const browserFindResultSchema = z.strictObject({
  index: z.number().int().min(0).max(500),
  total: z.number().int().min(0).max(500),
  limited: z.boolean()
});
export type BrowserFindResult = z.infer<typeof browserFindResultSchema>;

export const browserAttachmentMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('ack'), sequence: positiveUint32 }),
  z.strictObject({ type: z.literal('tab.icons') }),
  z.strictObject({ type: z.literal('downloads.observe') }),
  z.strictObject({
    type: z.literal('agent.control'),
    action: z.enum(['observe', 'take', 'resume'])
  }),
  z.strictObject({ type: z.literal('viewport.resize'), width: viewportEdge, height: viewportEdge }),
  z.strictObject({ type: z.literal('input'), action: browserPageInputSchema }),
  z.strictObject({ type: z.literal('selection.copy'), id, viewVersion: positiveUint32 }),
  z.strictObject({
    type: z.literal('find.update'),
    id,
    viewVersion: positiveUint32,
    operation: browserFindOperationSchema
  }),
  z.strictObject({
    type: z.literal('context.open'),
    id,
    viewVersion: positiveUint32,
    point: z.strictObject({ x: coordinate, y: coordinate }).optional()
  }),
  z.strictObject({
    type: z.literal('context.paste'),
    id,
    viewVersion: positiveUint32,
    text: z.string().min(1).max(4096)
  }),
  z.strictObject({
    type: z.literal('navigate'),
    viewVersion: positiveUint32,
    address: z.string().min(1).max(8192)
  }),
  z.strictObject({
    type: z.literal('navigation'),
    viewVersion: positiveUint32,
    action: z.enum(['back', 'forward', 'reload', 'stop'])
  }),
  z.strictObject({ type: z.literal('tab.open'), address: z.string().min(1).max(8192).optional() }),
  z.strictObject({ type: z.literal('tab.openHtml'), path: z.string().min(1).max(4096) }),
  z.strictObject({ type: z.literal('tab.select'), tabId }),
  z.strictObject({ type: z.literal('tab.close'), tabId }),
  z.strictObject({
    type: z.literal('dialog.respond'),
    id: z.string().uuid(),
    accept: z.boolean(),
    text: z.string().max(4096).optional()
  })
]);

export type BrowserAttachmentMessage = z.infer<typeof browserAttachmentMessageSchema>;

export const browserTabSnapshotSchema = z.strictObject({
  agentControl: z.enum(['idle', 'agent', 'taking', 'user']).optional(),
  activeId: tabId.optional(),
  viewVersion: positiveUint32,
  tabs: z
    .array(
      z.strictObject({
        id: tabId,
        url: z.string().max(8192),
        title: z.string().max(256),
        loading: z.boolean(),
        canGoBack: z.boolean(),
        canGoForward: z.boolean()
      })
    )
    .max(BROWSER_TAB_LIMIT),
  dialog: z
    .strictObject({
      id,
      type: z.enum(['alert', 'confirm', 'prompt', 'beforeunload']),
      message: z.string().max(1024),
      defaultValue: z.string().max(1024)
    })
    .optional(),
  fileChooser: browserFileChooserSchema.optional(),
  downloadVersion: z.number().int().nonnegative().safe().optional(),
  activeDownloadCount: z.number().int().nonnegative().safe().optional()
});

export const browserAttachmentEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('ATTACHED'), hd: z.literal(true).optional() }),
  z.strictObject({ type: z.literal('snapshot'), snapshot: browserTabSnapshotSchema }),
  z.strictObject({
    type: z.literal('tab.icon'),
    tabId,
    url: z.string().max(8192),
    png: z
      .string()
      .min(1)
      .max(BROWSER_TAB_ICON_BASE64_MAX)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/u)
  }),
  z.strictObject({ type: z.literal('selection'), id, text: z.string().max(4096) }),
  z.strictObject({
    type: z.literal('find.result'),
    id,
    result: browserFindResultSchema.optional()
  }),
  z.strictObject({
    type: z.literal('context.result'),
    id,
    options: browserContextOptionsSchema.optional()
  }),
  z.strictObject({
    type: z.literal('command.failed'),
    code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u)
  })
]);

export type BrowserTabSnapshot = z.infer<typeof browserTabSnapshotSchema>;
export type BrowserAttachmentEvent = z.infer<typeof browserAttachmentEventSchema>;
