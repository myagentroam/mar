import { z } from 'zod';
import type { ToolExecutionResult } from '@myagentroam/agent';

export const WEB_FETCH_MAX_BYTES = 1_000_000;
export const WEB_FETCH_MAX_URL_LENGTH = 8_192;

export function webSessionScope(
  domain: 'workspace' | 'hosted',
  storage: string,
  sessionId: string
): string {
  return JSON.stringify([domain, storage, sessionId]);
}

export const webUrlSchema = z
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

export const browserFetchRequestSchema = z
  .object({
    url: webUrlSchema,
    mode: z.literal('browser')
  })
  .strict();
export type BrowserFetchRequest = z.infer<typeof browserFetchRequestSchema>;

const maxTokens = z.number().int().min(512).max(4000).default(2000);
export const webFetchRequestSchema = z.union([
  z.object({ action: z.literal('open'), url: webUrlSchema, maxTokens }).strict(),
  z
    .object({
      action: z.literal('open'),
      ref: z.string().min(1).max(100),
      line: z.number().int().min(0).optional(),
      cursor: z.string().max(100).optional(),
      maxTokens
    })
    .strict()
    .refine((value) => value.line === undefined || value.cursor === undefined),
  z
    .object({
      action: z.literal('find'),
      ref: z.string().min(1).max(100),
      pattern: z.string().min(1).max(1000),
      maxTokens
    })
    .strict()
]);
export type WebFetchRequest = z.infer<typeof webFetchRequestSchema>;
export type WebFetchHandler = (
  input: WebFetchRequest,
  signal: AbortSignal,
  sessionId: string
) => Promise<ToolExecutionResult>;

export const webSearchRequestSchema = z
  .object({
    query: z.string().trim().min(1).max(500),
    maxResults: z.number().int().min(1).max(10).default(8),
    maxTokens
  })
  .strict();

export const browserFetchResultSchema = z
  .object({
    content: z
      .string()
      .max(WEB_FETCH_MAX_BYTES)
      .refine((value) => new TextEncoder().encode(value).byteLength <= WEB_FETCH_MAX_BYTES),
    data: z
      .object({
        url: webUrlSchema,
        mode: z.literal('browser'),
        status: z.number().int().min(200).max(299),
        contentType: z.string().max(256),
        title: z.string().max(1_000).optional()
      })
      .strict(),
    truncated: z.boolean()
  })
  .strict();
export type BrowserFetchResult = z.infer<typeof browserFetchResultSchema>;
