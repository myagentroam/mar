import { z } from 'zod';

export const webPushSubscriptionSchema = z
  .object({
    endpoint: z.string().url().max(2048),
    expirationTime: z.number().int().nonnegative().safe().nullable().optional(),
    keys: z
      .object({
        p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}$/u),
        auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/u)
      })
      .strict()
  })
  .strict();

export const webPushRegistrationSchema = z
  .object({
    clientToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    subscription: webPushSubscriptionSchema,
    bindingVersion: z.number().int().positive().safe().optional(),
    enabled: z.boolean().default(true)
  })
  .strict();

export type WebPushRegistration = z.input<typeof webPushRegistrationSchema>;
// This is an identity consistency check, never a caller-selected authorization identity.
export const webPushClientRequestSchema = webPushRegistrationSchema.extend({
  expectedAccount: z.string().min(1).max(128)
});
export const webPushClientResolveSchema = webPushClientRequestSchema.pick({
  clientToken: true,
  expectedAccount: true
});
export type WebPushSubscription = z.infer<typeof webPushSubscriptionSchema>;

export interface WebPushBinding {
  readonly subscriptionId: string;
  readonly bindingVersion: number;
  readonly enabled: boolean;
}
