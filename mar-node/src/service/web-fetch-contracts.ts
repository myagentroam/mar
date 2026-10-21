import { z } from 'zod';
import type { ToolExecutionResult } from '@myagentroam/agent';

export const WEB_FETCH_MAX_BYTES = 1_000_000;
export const WEB_FETCH_MAX_URL_LENGTH = 8_192;

const webUrlSchema = z
  .string()
  .max(WEB_FETCH_MAX_URL_LENGTH)
  .refine((value) => {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    } catch {
      return false;
    }
  });

export const webFetchModeSchema = z.enum(['http', 'browser']);
export const webFetchRequestSchema = z
  .object({
    url: webUrlSchema,
    mode: webFetchModeSchema
  })
  .strict();
export type WebFetchRequest = z.infer<typeof webFetchRequestSchema>;
export type WebFetchHandler = (
  input: WebFetchRequest,
  signal: AbortSignal
) => Promise<ToolExecutionResult>;

export const webSearchRequestSchema = z
  .object({
    query: z.string().trim().min(1).max(500),
    maxResults: z.number().int().min(1).max(10).default(8)
  })
  .strict();

export const webFetchResultSchema = z
  .object({
    content: z
      .string()
      .max(WEB_FETCH_MAX_BYTES)
      .refine((value) => new TextEncoder().encode(value).byteLength <= WEB_FETCH_MAX_BYTES),
    data: z
      .object({
        url: webUrlSchema,
        mode: webFetchModeSchema,
        status: z.number().int().min(200).max(299),
        contentType: z.string().max(256),
        title: z.string().max(1_000).optional()
      })
      .strict(),
    truncated: z.boolean()
  })
  .strict();
export type WebFetchResult = z.infer<typeof webFetchResultSchema>;
