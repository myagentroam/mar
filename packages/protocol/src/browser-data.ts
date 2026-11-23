import { z } from 'zod';

export const browserDataClearSchema = z.strictObject({
  range: z.enum(['hour', 'day', 'week', 'four-weeks', 'all']),
  categories: z
    .array(z.enum(['history', 'site-data', 'cache']))
    .min(1)
    .max(3)
});

export const browserHistoryQuerySchema = z
  .strictObject({
    text: z.string().max(512),
    startTime: z.number().int().nonnegative().safe(),
    endTime: z.number().int().positive().safe().optional()
  })
  .refine(({ startTime, endTime }) => endTime === undefined || endTime > startTime);

export const browserHistoryDeleteSchema = z
  .array(
    z
      .string()
      .max(8192)
      .url()
      .refine((url) => {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
      })
  )
  .min(1)
  .max(30);

export type BrowserDataClear = z.infer<typeof browserDataClearSchema>;
export type BrowserHistoryQuery = z.infer<typeof browserHistoryQuerySchema>;
export type BrowserHistoryItem = { url: string; title: string; visitedAt: number };
export type BrowserHistoryResult = { items: BrowserHistoryItem[]; capped: boolean };

export const browserProfileTargetSchema = z.strictObject({
  id: z.string().uuid(),
  kind: z.enum(['live', 'stored']),
  persistent: z.boolean()
});
export const browserProfileCommandSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('describe') }),
  z.strictObject({
    action: z.literal('clear'),
    target: browserProfileTargetSchema,
    input: browserDataClearSchema
  }),
  z.strictObject({
    action: z.literal('history'),
    target: browserProfileTargetSchema,
    input: browserHistoryQuerySchema
  }),
  z.strictObject({
    action: z.literal('delete'),
    target: browserProfileTargetSchema,
    input: browserHistoryDeleteSchema
  })
]);
export type BrowserProfileTarget = z.infer<typeof browserProfileTargetSchema>;
export type BrowserProfileCommand = z.infer<typeof browserProfileCommandSchema>;
