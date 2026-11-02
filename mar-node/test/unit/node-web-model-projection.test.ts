import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalAgentHost } from '../../../mar-agent/src/host.js';
import {
  SecretValue,
  countModelTokens,
  type AgentModelConfiguration
} from '../../../mar-agent/src/index.js';
import { createAgentWithAdapter } from '../../../mar-agent/src/sdk/agent.js';
import type { ModelEvent, ModelRequest } from '../../../mar-agent/src/model/contracts.js';
import { createWebToolsExtensions } from '../../src/runner/mar-agent/web-tools-extensions.js';
import { webSessionScope } from '../../src/service/web-fetch-contracts.js';
import { WebToolService } from '../../src/service/web-tool-service.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Node web tools model projection', () => {
  it.each([false, true])(
    'projects bounded page refs and continuation in codeMode=%s',
    async (codeMode) => {
      const root = await mkdtemp(join(tmpdir(), 'mar-web-model-projection-'));
      roots.push(root);
      const home = join(root, 'home');
      const workspace = join(root, 'workspace');
      await Promise.all([mkdir(home), mkdir(workspace)]);
      const server = createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(`<p>${'PAGE_START '.repeat(1500)}EXCLUSIVE_TAIL_MARKER</p>`);
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('FIXTURE_ADDRESS_INVALID');
      const url = `http://127.0.0.1:${address.port}/`;
      const service = new WebToolService(() => undefined);
      const host = new LocalAgentHost({ homeDirectory: home, workspace });
      const model: AgentModelConfiguration = {
        id: 'model',
        name: 'Model',
        protocol: 'ANTHROPIC_MESSAGES',
        baseUrl: 'https://example.test',
        apiKey: new SecretValue('unused'),
        modelId: 'model',
        contextWindowTokens: 200_000,
        maxOutputTokens: 4096,
        inputCapabilities: ['TEXT'],
        outputCapabilities: ['TEXT'],
        reasoningEfforts: [],
        conversationModel: true,
        titleGeneration: false,
        codeMode,
        hostedWebSearch: false,
        responsesPreviousResponseId: false,
        enabled: true
      };
      const observed: string[] = [];
      let round = 0;
      const agent = await createAgentWithAdapter(
        { mode: 'normal', host, models: [model] },
        (configuration) => ({
          configuration,
          async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
            round++;
            if (round === 1) {
              const input = { action: 'open', url, maxTokens: 512 };
              yield codeMode
                ? {
                    type: 'client_tool.call',
                    callId: 'cell',
                    name: 'code_exec',
                    inputMode: 'freeform',
                    arguments: `observe.result(await tools.web_fetch(${JSON.stringify(input)}));`
                  }
                : {
                    type: 'client_tool.call',
                    callId: 'direct',
                    name: 'web_fetch',
                    arguments: input
                  };
              yield { type: 'completed', reason: 'tool_use' };
            } else {
              observed.push(
                ...request.messages
                  .filter((message) => message.role === 'tool')
                  .map((message) => message.content)
              );
              yield { type: 'text.completed', itemId: 'answer', text: 'Done' };
              yield { type: 'completed', reason: 'completed' };
            }
          }
        })
      );
      try {
        const session = await agent.createSession({ workspace, title: 'Projection fixture' });
        const extension = createWebToolsExtensions({
          enabled: true,
          hostedWebSearch: false,
          webFetch: (input, signal, sessionId) =>
            service.webFetch(input, signal, webSessionScope('workspace', home, sessionId))
        });
        const binding = host.bindExecutionExtensions(extension);
        try {
          expect(
            await session
              .run({ prompt: 'Read the fixture.', permissionMode: 'full-access' })
              .result()
          ).toMatchObject({ status: 'completed' });
        } finally {
          host.unbindExecutionMcp(binding);
        }
        const projection = observed.join('\n');
        expect(projection).toContain('Ref:');
        expect(projection).toContain('nextCursor:');
        expect(projection).not.toContain('EXCLUSIVE_TAIL_MARKER');
        expect(countModelTokens(projection)).toBeLessThan(1200);
      } finally {
        await agent.dispose();
        await service.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      }
    },
    20_000
  );
});
