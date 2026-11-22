import https from 'node:https';

const MAX_RESPONSE_BYTES = 110 * 1024 * 1024;

/** Anonymous catalog HTTPS transport. Skips certificate verification without following redirects. */
export const publicHttpsFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.protocol !== 'https:') throw new Error('SKILL_SOURCE_TLS_FAILED');
  return new Promise<Response>((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
        headers: {
          ...Object.fromEntries(
            new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
          ),
          host: url.host
        },
        rejectUnauthorized: false,
        signal: init?.signal ?? undefined
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.once('error', reject);
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            response.destroy(new Error('SKILL_SOURCE_LIMIT_EXCEEDED'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () =>
          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode ?? 500,
              headers: response.headers as HeadersInit
            })
          )
        );
      }
    );
    request.once('error', reject);
    request.end();
  });
};
