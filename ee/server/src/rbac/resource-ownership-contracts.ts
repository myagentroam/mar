import type { ResourceOwnership } from '@myagentroam/protocol';

/** Ownership with the display name captured for resource audit. */
export type ResourceOwnershipSnapshot = ResourceOwnership & { readonly displayName?: string };

/** Template grants also capture their hosting context for audit. */
export type TemplateHostingNodeSnapshot = ResourceOwnershipSnapshot & {
  readonly nodeId?: string;
  readonly workspaceId?: string;
  readonly nodeName?: string;
};
