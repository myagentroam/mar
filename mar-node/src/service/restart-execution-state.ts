import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { PreparedExecutionInput } from './continuous-run-coordinator.js';

export const restartExecutionSchema = z
  .object({
    configuration: z
      .object({
        modelId: z.string().nullable(),
        effort: z.string().nullable(),
        access: z.string().nullable()
      })
      .strict()
      .optional(),
    initiatedByUserId: z.number().int().positive().optional()
  })
  .strict();

export type RestartExecution = z.infer<typeof restartExecutionSchema>;

export function captureRestartExecution(
  input:
    | (Pick<
        PreparedExecutionInput,
        'executionContext' | 'secretEnvironment' | 'personalInstructions' | 'usageGrant'
      > &
        Partial<Pick<PreparedExecutionInput, 'modelId' | 'effort' | 'access'>>)
    | undefined,
  initiatedByUserId?: number
): RestartExecution | undefined {
  if (input === undefined) return;
  return restartExecutionSchema.parse({
    ...(input.modelId === undefined || input.effort === undefined || input.access === undefined
      ? {}
      : { configuration: { modelId: input.modelId, effort: input.effort, access: input.access } }),
    ...(initiatedByUserId === undefined ? {} : { initiatedByUserId })
  });
}

const sealedSchema = z
  .object({
    format: z.literal('mar-node-restart'),
    version: z.literal(1),
    nonce: z.string().length(16),
    tag: z.string().length(24),
    ciphertext: z.string().min(1)
  })
  .strict();

function encryptionKey(credential: string): Buffer {
  if (!credential) throw new Error('RESTART_HANDOFF_KEY_UNAVAILABLE');
  return createHash('sha256').update('mar-node:orderly-restart:v1\0').update(credential).digest();
}

/** The existing local Node credential protects this one-shot execution checkpoint. */
export function sealRestartState(value: unknown, credential: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(credential), nonce);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return JSON.stringify({
    format: 'mar-node-restart',
    version: 1,
    nonce: nonce.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64')
  });
}

export function openRestartState(text: string, credential: string): unknown {
  const sealed = sealedSchema.parse(JSON.parse(text));
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(credential),
    Buffer.from(sealed.nonce, 'base64')
  );
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
    decipher.final()
  ]);
  return JSON.parse(plaintext.toString('utf8'));
}
