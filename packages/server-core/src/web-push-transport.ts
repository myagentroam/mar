import https from 'node:https';
import { urlToHttpOptions } from 'node:url';
import webPush from 'web-push';
import { validWebPushEndpoint } from './web-push-clients.js';
import type { WebPushTransport } from './web-push-dispatcher.js';

/** Standard encryption/VAPID with cancellable HTTPS delivery to the subscribed endpoint. */
export function createWebPushTransport(
  network: { readonly request?: typeof https.request } = {}
): WebPushTransport {
  return async (input) => {
    try {
      input.signal.throwIfAborted();
      if (!validWebPushEndpoint(input.subscription.endpoint))
        throw new Error('WEB_PUSH_TRANSPORT_FAILED');
      const signal = AbortSignal.any([input.signal, AbortSignal.timeout(5_000)]);
      const url = new URL(input.subscription.endpoint);
      const details = webPush.generateRequestDetails(input.subscription, input.payload, {
        TTL: input.ttl,
        contentEncoding: 'aes128gcm',
        vapidDetails: {
          subject: input.subject,
          publicKey: input.publicKey,
          privateKey: input.privateKey
        }
      });
      signal.throwIfAborted();
      return await new Promise<{ statusCode: number }>((resolve, reject) => {
        const request = (network.request ?? https.request)(
          {
            ...urlToHttpOptions(url),
            method: details.method,
            headers: { ...details.headers, host: url.host },
            rejectUnauthorized: true,
            signal
          },
          (response) => {
            // Only acceptance status is needed; do not buffer or log provider bodies/headers.
            const statusCode = response.statusCode;
            response.once('error', reject);
            response.destroy();
            if (statusCode === undefined) reject(new Error('WEB_PUSH_TRANSPORT_FAILED'));
            else resolve({ statusCode });
          }
        );
        request.once('error', reject);
        request.end(details.body);
      });
    } catch {
      // Library and network exceptions may contain subscriptions or authorization material.
      throw new Error('WEB_PUSH_TRANSPORT_FAILED');
    }
  };
}
