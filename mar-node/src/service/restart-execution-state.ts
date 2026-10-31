import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { modelUsageGrantSchema, type ModelUsageGrant } from '@myagentroam/protocol';
import { z } from 'zod';
import type { PreparedExecutionInput } from './continuous-run-coordinator.js';

export const restartExecutionSchema = z
  .object({
    executionContext: z
      .object({ runner: z.literal('mar-agent'), runnerInput: z.unknown().optional() })
      .strict(),
    secretEnvironment: z.record(z.string(), z.string()),
    personalInstructions: z.string().optional(),
    usageGrant: z
      .custom<ModelUsageGrant>((value) => modelUsageGrantSchema.safeParse(value).success)
      .optional(),
    initiatedByUserId: z.number().int().positive().optional()
  })
  .strict();

export type RestartExecution = z.infer<typeof restartExecutionSchema>;

export function captureRestartExecution(
  input:
    | Pick<
        PreparedExecutionInput,
        'executionContext' | 'secretEnvironment' | 'personalInstructions' | 'usageGrant'
      >
    | undefined,
  initiatedByUserId?: number
): RestartExecution | undefined {
  if (input === undefined) return;
  return restartExecutionSchema.parse({
    executionContext: structuredClone(input.executionContext),
    secretEnvironment: { ...input.secretEnvironment },
    ...(input.personalInstructions === undefined
      ? {}
      : { personalInstructions: input.personalInstructions }),
    ...(input.usageGrant === undefined ? {} : { usageGrant: { ...input.usageGrant } }),
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
  const saved: unknown = JSON.parse(text);
  if (
    saved !== null &&
    typeof saved === 'object' &&
    'schemaVersion' in saved &&
    (saved.schemaVersion === 1 || saved.schemaVersion === 2)
  )
    return saved;
  const sealed = sealedSchema.parse(saved);
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
