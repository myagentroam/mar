import { z } from 'zod';
import { contextualBlock } from './contextual-blocks.js';
import type { ModelMessage } from '../../model/contracts.js';
import { buildEnvironmentContext } from '../../prompts/core.js';
import type { EnvironmentContextState } from './contracts.js';

const environmentStateSchema = z
  .object({
    platform: z.string().min(1).max(64),
    architecture: z.string().min(1).max(64).optional(),
    workspace: z.string().max(32768),
    currentDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/u)
      .optional(),
    timezone: z.string().min(1).max(128).optional(),
    shell: z
      .object({
        name: z.string().min(1).max(128),
        path: z.string().min(1).max(32768)
      })
      .strict()
      .optional(),
    guaranteedCommands: z.record(z.string().min(1).max(128), z.string().max(256)).optional()
  })
  .strict();
const environmentRecordSchema = z
  .object({
    version: z.literal(1),
    state: environmentStateSchema
  })
  .strict();

export function restoreEnvironmentState(payload: unknown): EnvironmentContextState | undefined {
  if (Buffer.byteLength(JSON.stringify(payload) ?? '') > 128 * 1024) return undefined;
  const parsed = environmentRecordSchema.safeParse(payload);
  if (!parsed.success) return undefined;
  const { architecture, shell, guaranteedCommands, currentDate, timezone, ...required } =
    parsed.data.state;
  return {
    ...required,
    ...(architecture === undefined ? {} : { architecture }),
    ...(shell === undefined ? {} : { shell }),
    ...(guaranteedCommands === undefined ? {} : { guaranteedCommands }),
    ...(currentDate === undefined ? {} : { currentDate }),
    ...(timezone === undefined ? {} : { timezone })
  };
}

export function environmentContextUpdate(
  current: EnvironmentContextState,
  previous?: EnvironmentContextState,
  contextualEntries: readonly string[] = []
): ModelMessage | undefined {
  const content = buildEnvironmentContext(current, previous, contextualEntries);
  return content
    ? {
        role: 'user',
        contextKind: 'environment',
        content,
        contextualBlock: contextualBlock(
          { id: 'runtime:environment', content, source: 'runtime', authority: 'context' },
          'environment'
        )
      }
    : undefined;
}

export function currentLocalTimeContext(
  instant: Date = new Date(),
  timezone?: string
): Pick<EnvironmentContextState, 'currentDate' | 'timezone'> {
  try {
    const zone = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!zone) throw new Error('Local timezone is unavailable.');
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(instant);
    const value = (kind: string) => parts.find((part) => part.type === kind)?.value;
    return {
      currentDate: `${value('year')}-${value('month')}-${value('day')}`,
      timezone: zone
    };
  } catch {
    return { currentDate: instant.toISOString().slice(0, 10), timezone: 'Etc/UTC' };
  }
}
