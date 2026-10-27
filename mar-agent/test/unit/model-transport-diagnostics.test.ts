import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SecretValue,
  generateModelText,
  testAgentModelTransport,
  type AgentModelConfiguration
} from '../../src/index.js';
import { parseSse } from '../../src/model/sse.js';
import { modelCredentialSensitiveValues } from '../../src/model/runtime-credential.js';

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        })
    )
  );
});

async function fixture(
  protocol: AgentModelConfiguration['protocol'],
  body: string,
  status = 426,
  onRequest = () => {}
) {
  const server = createServer((_request, response) => {
    onRequest();
    response.writeHead(status, {
      'content-type': status === 200 ? 'text/event-stream' : 'application/json',
      'x-request-id': 'upstream-426',
      'retry-after': '60',
      'set-cookie': 'secret-cookie=not-public'
    });
    response.end(body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  return {
    id: 'diagnostic',
    name: 'Diagnostic',
    protocol,
    baseUrl: `http://127.0.0.1:${address.port}`,
    apiKey: new SecretValue('diagnostic-private-key'),
    modelId: 'fixture',
    contextWindowTokens: 4096,
    maxOutputTokens: 32,
    inputCapabilities: ['TEXT'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: [],
    hostedWebSearch: false,
    responsesPreviousResponseId: false,
    enabled: true
  } satisfies AgentModelConfiguration;
}

describe('Model transport HTTP diagnostics', () => {
  it.each([
    ['OPENAI_RESPONSES', 503],
    ['ANTHROPIC_MESSAGES', 503],
    ['OPENAI_RESPONSES', 200],
    ['ANTHROPIC_MESSAGES', 200]
  ] as const)(
    'preserves busy errors without retrying standalone %s generation over HTTP %s',
    async (protocol, status) => {
      let requests = 0;
      const error = {
        code: 'service_unavailable_error',
        type: 'service_unavailable_error',
        message: 'Service is too busy. Provider request ID: provider-request-1'
      };
      const body =
        status === 200
          ? `data: ${JSON.stringify({ type: 'error', error })}\n\n`
          : JSON.stringify({ error });
      const model = await fixture(protocol, body, status, () => requests++);
      await expect(
        generateModelText({
          model,
          system: 'Predict the user message.',
          messages: [{ role: 'user', content: 'Continue.' }],
          signal: AbortSignal.timeout(5_000)
        })
      ).rejects.toMatchObject({
        code: error.code,
        publicMessage: error.message
      });
      expect(requests).toBe(1);
    }
  );

  it('redacts dynamic bearer and secret headers in the Responses adapter', async () => {
    const { apiKey, ...configuration } = await fixture(
      'OPENAI_RESPONSES',
      JSON.stringify({
        error: 'Rejected dynamic-private-bearer and private-extra-header'
      })
    );
    expect(apiKey).toBeInstanceOf(SecretValue);
    const credentialProvider = {
      acquire: async () => ({
        revision: 1,
        expiresAt: Date.now() + 60000,
        bearer: new SecretValue('dynamic-private-bearer'),
        headers: { 'x-private': new SecretValue('private-extra-header') }
      }),
      invalidate: () => undefined,
      close: async () => undefined
    };
    await expect(
      testAgentModelTransport({ ...configuration, credentialProvider }, AbortSignal.timeout(5000))
    ).rejects.toMatchObject({
      message: 'MAR_AGENT_MODEL_PROTOCOL_ERROR: Rejected [REDACTED] and [REDACTED]',
      details: { body: '{"error":"Rejected [REDACTED] and [REDACTED]"}' }
    });
  });

  it('redacts proxy authentication and encoded secret values before exposing diagnostics', async () => {
    const values = modelCredentialSensitiveValues({
      revision: 1,
      expiresAt: 1,
      bearer: new SecretValue('private?key'),
      headers: {},
      socks5Url: new SecretValue('socks5://proxy-user:proxy%20password@localhost:1080')
    });
    const response = Response.json(
      { error: 'private%3Fkey proxy-user proxy password' },
      { status: 426 }
    );
    await expect(
      (async () => {
        for await (const event of parseSse(
          response,
          new AbortController().signal,
          undefined,
          undefined,
          values
        ))
          void event;
      })()
    ).rejects.toMatchObject({
      message: 'MAR_AGENT_MODEL_PROTOCOL_ERROR: [REDACTED] [REDACTED] [REDACTED]'
    });
  });

  it.each(['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'] as const)(
    'preserves string errors and bounded response metadata for %s',
    async (protocol) => {
      const body = JSON.stringify({ error: 'Your Grok CLI version is outdated.' });
      const configuration = await fixture(protocol, body);
      await expect(
        testAgentModelTransport(configuration, AbortSignal.timeout(5000))
      ).rejects.toMatchObject({
        message: 'MAR_AGENT_MODEL_PROTOCOL_ERROR: Your Grok CLI version is outdated.',
        details: {
          status: 426,
          body,
          bodyTruncated: false,
          contentType: 'application/json',
          requestId: 'upstream-426',
          retryAfter: '60'
        }
      });
    }
  );
  it.each(['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'] as const)(
    'redacts known keys before truncating response diagnostics for %s',
    async (protocol) => {
      const configuration = await fixture(
        protocol,
        JSON.stringify({
          error: `Rejected diagnostic-private-key ${'x'.repeat(5000)}`
        })
      );
      try {
        await testAgentModelTransport(configuration, AbortSignal.timeout(5000));
        expect.fail('Expected transport failure');
      } catch (error) {
        const failure = error as { message: string; details: Record<string, unknown> };
        expect(failure.details.body).toHaveLength(4096);
        expect(failure.details.bodyTruncated).toBe(true);
        expect(failure.message).toContain('[REDACTED]');
        expect(JSON.stringify(failure)).not.toContain('diagnostic-private-key');
        expect(JSON.stringify(failure)).not.toContain('secret-cookie');
      }
    }
  );
});
