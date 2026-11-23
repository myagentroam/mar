import { z } from 'zod';

const viewVersion = z.number().int().positive().max(0xffffffff);
const coordinate = z.number().min(0).max(0xffff);
const delta = z.number().min(-0xffff).max(0xffff);
const edge = z.enum(['down', 'up']);

export const browserPageInputSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('move'), viewVersion, x: coordinate, y: coordinate }),
  z.strictObject({
    type: z.literal('button'),
    viewVersion,
    edge,
    button: z.enum(['left', 'middle', 'right']),
    x: coordinate,
    y: coordinate
  }),
  z.strictObject({ type: z.literal('wheel'), viewVersion, x: delta, y: delta }),
  z.strictObject({ type: z.literal('key'), viewVersion, edge, key: z.string().min(1).max(64) }),
  z.strictObject({ type: z.literal('text'), viewVersion, text: z.string().min(1).max(4096) })
]);

export type BrowserPageInput = z.infer<typeof browserPageInputSchema>;
