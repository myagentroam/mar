import { z } from 'zod';

// Bound the structured descriptor passed to the built-in worker, including on Windows.
const nonNullString = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !value.includes('\0'));
const path = nonNullString(4096);

export const terminalCopySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('read'), path }).strict(),
  z
    .object({
      mode: z.literal('write'),
      path,
      size: z.number().int().safe().nonnegative(),
      sourceMode: z.number().int().min(0).max(0o777),
      atimeMs: z.number().finite(),
      mtimeMs: z.number().finite(),
      preserve: z.boolean(),
      sourceBasename: nonNullString(255)
    })
    .strict()
]);

export type TerminalCopy = z.infer<typeof terminalCopySchema>;
